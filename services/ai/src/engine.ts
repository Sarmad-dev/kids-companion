import {
  createSafetyPipeline,
  DEGRADED_RESPONSES,
  enforceLength,
  type AttemptCounter,
  type ParentalSafetySettings,
  type SafetyCategory,
  type SafetyPolicy,
  type SafetySubject,
  type SafetyVerdict,
} from '@kids/safety';
import {
  CircuitOpenError,
  ProviderTimeoutError,
  ProviderUnavailableError,
  withRetry,
  type CircuitBreaker,
  type RetryOptions,
} from '@kids/shared';
import type { AgeGroup, SafetyLayer } from '@kids/types';

import { rulesFor } from './age-rules.js';
import {
  buildProviderContext,
  DEFAULT_CONTEXT_LIMITS,
  outputTokensFor,
  type ContextLimits,
  type ConversationContextInput,
} from './context.js';
import type { AIProvider, TokenUsage } from './ports.js';
import { substituteName } from './prompts.js';
import { providerAsClassifier } from './safety-classifier.js';

/**
 * The conversation engine.
 *
 * It orchestrates a turn. It does NOT decide what is safe — that belongs to
 * `@kids/safety`, which is a separate package with no knowledge of conversations
 * (docs/CHILD_SAFETY.md §3). This file calls three named stages in order:
 *
 *   INPUT_SAFETY_CHECK   before anything leaves this system
 *   AI_GENERATION        only if the input stage allowed it
 *   OUTPUT_SAFETY_CHECK  before anything reaches the child
 *
 * The separation is deliberate. When the safety layer and the thing it guards
 * live in the same module, every change to conversation behaviour is a change to
 * the safety surface, and the safety rules end up being reasoned about in terms
 * of the conversation flow rather than on their own terms. Here the engine
 * cannot weaken a safety decision even by accident: it receives a verdict and
 * acts on it.
 *
 * FAIL CLOSED. Everything that can go wrong — a classifier that errors, a
 * provider that times out, a prompt that lost a safety invariant — produces
 * something safe for the child to hear, never an error and never silence.
 */

export type TurnStatus = 'ok' | 'blocked' | 'escalated' | 'degraded' | 'ended';

export interface SafetyRecord {
  readonly layer: SafetyLayer;
  readonly decision: 'allowed' | 'redirected' | 'blocked' | 'escalated';
  readonly categories: readonly SafetyCategory[];
  readonly confidence: number;
  /** Rule names only, never the text that matched them. */
  readonly detectors: readonly string[];
  readonly policyVersion: string;
  readonly attemptIndex: number;
  readonly actionTaken: string;
}

export interface TurnResult {
  readonly status: TurnStatus;
  /** What the child hears, with their name substituted in. */
  readonly reply: string;
  /**
   * What gets PERSISTED — the reply with `{{name}}` left in place.
   *
   * Stored history is replayed into the next turn's context, so a stored reply
   * containing the real name would feed it straight back to the provider and
   * defeat the whole placeholder mechanism. Substitution therefore happens at
   * presentation time, on every read, and the name never enters the transcript.
   */
  readonly replyForStorage: string;
  readonly usage: TokenUsage;
  readonly model: string;
  readonly provider: string;
  /** Layers that ran and passed. Layer names only, never content. */
  readonly layersPassed: readonly SafetyLayer[];
  readonly safetyRecords: readonly SafetyRecord[];
  /** Set when a human must see this turn (docs/CHILD_SAFETY.md §6). */
  readonly escalation: boolean;
  readonly escalationReason?: string;
  readonly contextMessageCount: number;
  readonly degradedReason?: keyof typeof DEGRADED_RESPONSES;
}

export interface EngineOptions {
  readonly provider: AIProvider;
  readonly limits?: ContextLimits;
  readonly retry?: RetryOptions;
  readonly breaker?: CircuitBreaker;
  readonly moderationTimeoutMs?: number;
  readonly generationTimeoutMs?: number;
  readonly temperature?: number;
  /**
   * Loaded from `safety_policies`; falls back to the compiled-in policy.
   *
   * A getter is re-read on every check, so a tightened threshold takes effect
   * without a restart.
   */
  readonly safetyPolicy?: SafetyPolicy | (() => SafetyPolicy);
  /** Backed by `app.recent_safety_blocks()` in production. */
  readonly attempts?: AttemptCounter;
  /** Injected for deterministic redirect selection in tests. */
  readonly seed?: () => number;
}

export interface RespondInput {
  readonly context: ConversationContextInput;
  readonly utterance: string;
  /** Opaque handle used ONLY to count recent stopped turns. Never transmitted. */
  readonly childRef: string;
  readonly parental?: ParentalSafetySettings;
  /**
   * Which vendor answers THIS turn, when the family chose one.
   *
   * ═══════════════════════════════════════════════════════════════════════
   * THIS OVERRIDES GENERATION ONLY. THE CLASSIFIER IS NOT NEGOTIABLE.
   * ═══════════════════════════════════════════════════════════════════════
   *
   * `options.provider` still runs every moderation call, on both the child's
   * input and the model's output, whatever is passed here. A family choosing
   * who tells their child a story is a preference; a family choosing who
   * decides whether their child just disclosed abuse is not — it would make
   * the quality of a safety check a per-account setting, and make the
   * adversarial corpus a statement about one vendor rather than about the
   * product.
   *
   * Absent means the deployment default, which is the only behaviour that
   * existed before this parameter and is still the common case.
   */
  readonly provider?: AIProvider;
}

const ZERO_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 };

const recordOf = (verdict: SafetyVerdict): SafetyRecord => ({
  layer: verdict.event.layer,
  decision: verdict.event.decision,
  categories: verdict.categories,
  confidence: verdict.confidence,
  detectors: verdict.detectors,
  policyVersion: verdict.policyVersion,
  attemptIndex: verdict.event.attemptIndex,
  actionTaken: verdict.action,
});

export const createConversationEngine = (options: EngineOptions) => {
  const limits = options.limits ?? DEFAULT_CONTEXT_LIMITS;
  const generationTimeoutMs = options.generationTimeoutMs ?? 12_000;
  const temperature = options.temperature ?? 0.7;

  const pipeline = createSafetyPipeline({
    classifier: providerAsClassifier(options.provider),
    ...(options.safetyPolicy ? { policy: options.safetyPolicy } : {}),
    ...(options.attempts ? { attempts: options.attempts } : {}),
    ...(options.moderationTimeoutMs ? { classifierTimeoutMs: options.moderationTimeoutMs } : {}),
    ...(options.seed ? { seed: options.seed } : {}),
  });

  const run = async <T>(fn: () => Promise<T>): Promise<T> => {
    const guarded = options.breaker ? () => options.breaker!.execute('ai', fn) : fn;
    return options.retry ? await withRetry('ai', guarded, options.retry) : await guarded();
  };

  const degraded = (
    provider: AIProvider,
    reason: keyof typeof DEGRADED_RESPONSES,
    layersPassed: readonly SafetyLayer[] = [],
    records: readonly SafetyRecord[] = [],
  ): TurnResult => ({
    status: 'degraded',
    reply: DEGRADED_RESPONSES[reason],
    replyForStorage: DEGRADED_RESPONSES[reason],
    usage: ZERO_USAGE,
    model: provider.conversationModel,
    provider: provider.name,
    layersPassed,
    safetyRecords: records,
    escalation: false,
    contextMessageCount: 0,
    degradedReason: reason,
  });

  /**
   * Turns a stopped verdict into a turn.
   *
   * The child is NEVER told a block occurred. "I can't talk about that" teaches
   * them where the boundary is and invites probing; the safety subsystem's
   * response does not (docs/ERROR_HANDLING.md §10). The one exception is a
   * disclosure, where the response deliberately does address what was said —
   * that decision lives in `@kids/safety`, not here.
   */
  const stopped = (
    provider: AIProvider,
    verdict: SafetyVerdict,
    records: readonly SafetyRecord[],
    layersPassed: readonly SafetyLayer[],
  ): TurnResult => {
    const reply = verdict.safeResponse ?? DEGRADED_RESPONSES.internal_error;
    return {
      status:
        verdict.action === 'end_session' ? 'ended' : verdict.escalate ? 'escalated' : 'blocked',
      reply,
      replyForStorage: reply,
      usage: ZERO_USAGE,
      model: provider.conversationModel,
      provider: provider.name,
      layersPassed,
      safetyRecords: records,
      escalation: verdict.escalate,
      ...(verdict.escalationReason ? { escalationReason: verdict.escalationReason } : {}),
      contextMessageCount: 0,
      // A stop caused by a safety component FAILING is still a stop, but it is
      // an operational fault as well as a content decision, and the two are
      // reported separately so the metrics do not conflate them.
      ...(verdict.failedClosed ? { degradedReason: 'safety_unavailable' as const } : {}),
    };
  };

  return {
    /**
     * Produces one turn.
     *
     * Never throws for a content or provider problem — every path returns a
     * `TurnResult` with something the character can say. A child must never see
     * an error message, a stack trace, or a spinner that does not resolve.
     */
    respond: async (input: RespondInput): Promise<TurnResult> => {
      const { context, utterance } = input;
      const ageGroup: AgeGroup = context.ageGroup;
      // Generation only. `pipeline` was built with `options.provider` and keeps
      // it — see RespondInput.provider for why that asymmetry is deliberate.
      const generator = input.provider ?? options.provider;
      const records: SafetyRecord[] = [];
      const passed: SafetyLayer[] = [];

      const subject: SafetySubject = {
        childRef: input.childRef,
        ageGroup,
        language: context.language,
        ...(input.parental ? { parental: input.parental } : {}),
      };

      /* ---------------- Stage 1: INPUT_SAFETY_CHECK ---------------- */
      const inputVerdict = await pipeline.checkInput(subject, utterance);
      records.push(recordOf(inputVerdict));

      if (!inputVerdict.allowed) return stopped(generator, inputVerdict, records, passed);
      passed.push(...inputVerdict.layersCleared);

      /* ---------------- Stage 2: AI_GENERATION ---------------- */
      let providerContext;
      let window;
      try {
        const built = buildProviderContext(context, limits);
        providerContext = built.context;
        window = built.window;
      } catch {
        // Either the assembled payload contained something that must not leave
        // this system, or a prompt lost a safety invariant. Both are our bugs,
        // and refusing to send is the correct outcome in both cases: degrading
        // costs one turn, sending would leak a child's data to a third party.
        return degraded(generator, 'internal_error', passed, records);
      }

      let generation;
      try {
        generation = await run(
          async () =>
            await generator.generateResponse({
              context: providerContext,
              utterance,
              maxOutputTokens: outputTokensFor(ageGroup, limits),
              temperature,
              timeoutMs: generationTimeoutMs,
            }),
        );
      } catch (error) {
        const reason =
          error instanceof ProviderTimeoutError
            ? 'provider_timeout'
            : error instanceof CircuitOpenError || error instanceof ProviderUnavailableError
              ? 'provider_unavailable'
              : 'internal_error';
        return degraded(generator, reason, passed, records);
      }

      passed.push('L2');

      /* ---------------- Stage 3: OUTPUT_SAFETY_CHECK ---------------- */
      const outputVerdict = await pipeline.checkOutput(subject, generation.text);
      records.push(recordOf(outputVerdict));

      // Pushed BEFORE the allowed check: when L4 stops a reply that L3 passed,
      // `layersPassed` ending in L3 is precisely the record we want.
      passed.push(...outputVerdict.layersCleared);
      if (!outputVerdict.allowed) return stopped(generator, outputVerdict, records, passed);

      /* ---------------- Post-processing ---------------- */
      // Length is ENFORCED, not requested. Asking a model for two sentences and
      // receiving four is normal, and four sentences at a three-year-old is a
      // worse experience than a trimmed one.
      const trimmed = enforceLength(generation.text, rulesFor(ageGroup).maxSentences);

      // The name is substituted HERE, locally, after generation — it never
      // reached the provider.
      const reply = substituteName(trimmed, context.childName);

      return {
        status: 'ok',
        reply,
        // Persisted with the placeholder intact — see TurnResult.replyForStorage.
        replyForStorage: trimmed,
        usage: generation.usage,
        model: generation.model,
        provider: generator.name,
        layersPassed: passed,
        safetyRecords: records,
        escalation: false,
        contextMessageCount: window.messages.length,
      };
    },
  };
};

export type ConversationEngine = ReturnType<typeof createConversationEngine>;
