import type { AgeGroup, SafetyLayer, SupportedLanguage } from '@kids/types';

import {
  mostRestrictive,
  stopsTheTurn,
  type SafetyAction,
  type SafetyCategory,
} from './categories.js';
import {
  detectBlockedTopics,
  detectInChildInput,
  detectInModelOutput,
  type Detection,
  type Severity,
} from './detectors.js';
import { decideEscalation } from './escalation.js';
import { assertNoContent, decisionFor, type EscalationReason, type SafetyEvent } from './events.js';
import {
  DEFAULT_POLICY,
  resolveRule,
  type ParentalSafetySettings,
  type PolicyScope,
  type SafetyPolicy,
} from './policy.js';
import { NULL_ATTEMPT_COUNTER, type AttemptCounter, type SafetyClassifier } from './ports.js';
import { safeResponseFor, SESSION_END_RESPONSES } from './responses.js';

/**
 * The safety pipeline.
 *
 * Three named stages, in this order and no other:
 *
 *   INPUT_SAFETY_CHECK   every child message, before anything is sent to a model
 *   AI_GENERATION        the caller's generation function, run only if input passed
 *   OUTPUT_SAFETY_CHECK  every model response, before it can reach the child
 *
 * The subsystem is independent of the conversation logic it guards: it holds no
 * conversation state, imports nothing from `@kids/ai`, and receives generation as
 * a callback. `guardedTurn` can wrap any generator — the conversation engine
 * today, a story generator or a speech-practice prompt tomorrow — and they all
 * get the same three stages.
 *
 * FAIL CLOSED, EVERYWHERE. A classifier that errors, times out, or returns
 * something unparseable stops the turn. There is no configuration that changes
 * this (docs/CHILD_SAFETY.md rule S-1), which is why every classifier call sits
 * inside a try/catch that treats failure as "stopped" rather than "continue".
 */

export const SAFETY_STAGES = [
  'INPUT_SAFETY_CHECK',
  'AI_GENERATION',
  'OUTPUT_SAFETY_CHECK',
] as const;

export type SafetyStage = (typeof SAFETY_STAGES)[number];
export type CheckStage = 'INPUT_SAFETY_CHECK' | 'OUTPUT_SAFETY_CHECK';

const STAGE_LAYER: Readonly<Record<CheckStage, SafetyLayer>> = Object.freeze({
  INPUT_SAFETY_CHECK: 'L1',
  OUTPUT_SAFETY_CHECK: 'L3',
});

/**
 * Everything the pipeline needs about who is talking.
 *
 * `childRef` is used for ONE thing: counting recent stopped turns. It is never
 * passed to a classifier and never written into an event. Everything else here
 * is what the policy needs in order to resolve a rule.
 */
export interface SafetySubject {
  readonly childRef: string;
  readonly ageGroup: AgeGroup;
  readonly language: SupportedLanguage;
  readonly parental?: ParentalSafetySettings;
}

export interface SafetyVerdict {
  readonly stage: CheckStage;
  readonly allowed: boolean;
  readonly action: SafetyAction;
  readonly categories: readonly SafetyCategory[];
  readonly detectors: readonly string[];
  readonly severity: Severity;
  readonly confidence: number;
  readonly escalate: boolean;
  readonly escalationReason?: EscalationReason;
  readonly evasion: boolean;
  /** True when the decision came from a safety component failing, not content. */
  readonly failedClosed: boolean;
  readonly policyVersion: string;
  /**
   * Which individual layers cleared inside this stage.
   *
   * A stage is one gate but two layers, and which one caught something is the
   * most interesting fact about a stopped turn: L4 catching what L3 passed is
   * the entire reason L4 exists. Reporting only "the output stage said no"
   * would discard the evidence that the classifier missed.
   */
  readonly layersCleared: readonly SafetyLayer[];
  /** What the child should hear. Present whenever the turn was stopped. */
  readonly safeResponse?: string;
  readonly event: SafetyEvent;
}

export interface PipelineOptions {
  readonly classifier: SafetyClassifier;
  /**
   * A fixed policy, or a getter re-read on every check.
   *
   * The getter form is what makes `safety_policies` worth being a table: the
   * API supplies a cached reader, so tightening a threshold takes effect without
   * a restart. It must be synchronous and must never throw — a policy lookup is
   * not allowed to be the thing that fails a safety check.
   */
  readonly policy?: SafetyPolicy | (() => SafetyPolicy);
  readonly attempts?: AttemptCounter;
  readonly classifierTimeoutMs?: number;
  /** Injected for deterministic redirect selection in tests. */
  readonly seed?: () => number;
}

const SEVERITY_RANK: Readonly<Record<Severity, number>> = Object.freeze({
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
});

const worstSeverity = (detections: readonly Detection[]): Severity =>
  detections.reduce<Severity>(
    (worst, d) => (SEVERITY_RANK[d.severity] > SEVERITY_RANK[worst] ? d.severity : worst),
    'low',
  );

export const createSafetyPipeline = (options: PipelineOptions) => {
  const currentPolicy = (): SafetyPolicy => {
    if (options.policy === undefined) return DEFAULT_POLICY;
    if (typeof options.policy !== 'function') return options.policy;
    try {
      return options.policy();
    } catch {
      // Falling back to the compiled-in policy, which is at least as strict as
      // anything the table can hold. A policy store problem must never widen
      // what a child can be shown.
      return DEFAULT_POLICY;
    }
  };
  const attempts = options.attempts ?? NULL_ATTEMPT_COUNTER;
  const classifierTimeoutMs = options.classifierTimeoutMs ?? 4_000;
  const seed = options.seed ?? (() => Math.floor(Date.now() / 1000));

  /**
   * Resolves one set of findings into a decision.
   *
   * The severity gate here is the difference between a filter people trust and
   * one they mute. A lone low/medium detection — a hypothetical framing, a
   * question about the system prompt — is RECORDED but does not stop the turn.
   * It becomes blocking when it arrives with something else, or when it was
   * reached through obfuscation, because both of those change what it means.
   */
  const decide = (
    policy: SafetyPolicy,
    stage: CheckStage,
    subject: SafetySubject,
    detections: readonly Detection[],
    classifierCategories: readonly SafetyCategory[],
    classifierConfidence: number,
    recentBlocks: number,
    failedClosed: boolean,
  ): SafetyVerdict => {
    const scope: PolicyScope = stage === 'INPUT_SAFETY_CHECK' ? 'child_input' : 'model_output';
    const severity = worstSeverity(detections);
    const evasion = detections.some((d) => d.evasion);

    const hasCorroboration =
      detections.length > 1 || classifierCategories.length > 0 || SEVERITY_RANK[severity] >= 2;

    const categories = new Set<SafetyCategory>();
    const actions: SafetyAction[] = [];
    const escalatingCategories: SafetyCategory[] = [];

    for (const detection of detections) {
      categories.add(detection.category);
      const rule = resolveRule(policy, detection.category, subject.ageGroup, scope);

      // Deterministic detectors report certainty, so `minConfidence` never gates
      // them — only the severity rule above does.
      const gated =
        SEVERITY_RANK[detection.severity] <= 1 && !hasCorroboration && !detection.evasion
          ? 'observe'
          : rule.action;

      actions.push(gated);
      if (rule.escalates && stopsTheTurn(gated)) escalatingCategories.push(detection.category);
    }

    for (const category of classifierCategories) {
      categories.add(category);
      const rule = resolveRule(policy, category, subject.ageGroup, scope);
      // Here confidence DOES gate: a classifier that is 20% sure about violence
      // is not a reason to stop a turn, but it is a reason to record one.
      const gated = classifierConfidence >= rule.minConfidence ? rule.action : 'observe';
      actions.push(gated);
      if (rule.escalates && stopsTheTurn(gated)) escalatingCategories.push(category);
    }

    let action = mostRestrictive(actions);

    // A safety component that failed is not a safety component that said yes.
    if (failedClosed) action = mostRestrictive([action, 'block']);

    const escalation = stopsTheTurn(action)
      ? decideEscalation({
          escalatingCategories,
          detections,
          recentBlocks,
          repeatedAttemptThreshold: policy.repeatedAttemptThreshold,
        })
      : { escalate: false, endSession: false, reason: undefined };

    if (escalation.endSession) action = 'end_session';

    const stopped = stopsTheTurn(action);
    const categoryList = [...categories];

    // A layer that did not run has not cleared anything, so a failed classifier
    // clears nothing even though it reported no categories.
    const classifierCleared = classifierCategories.length === 0 && !failedClosed;
    const deterministicCleared = !detections.some((d) => SEVERITY_RANK[d.severity] >= 2);
    const layersCleared: SafetyLayer[] =
      stage === 'INPUT_SAFETY_CHECK'
        ? classifierCleared && deterministicCleared
          ? ['L1']
          : []
        : [
            ...(classifierCleared ? (['L3'] as const) : []),
            ...(deterministicCleared ? (['L4'] as const) : []),
          ];

    const event: SafetyEvent = {
      stage,
      layer: STAGE_LAYER[stage],
      decision: decisionFor(action, escalation.escalate),
      categories: categoryList,
      detectors: detections.map((d) => d.rule),
      severity,
      confidence: detections.length > 0 ? 1 : classifierConfidence,
      actionTaken: action,
      policyVersion: policy.version,
      attemptIndex: recentBlocks + 1,
      evasion,
      ...(escalation.reason ? { escalationReason: escalation.reason } : {}),
    };

    return {
      stage,
      allowed: !stopped,
      action,
      categories: categoryList,
      detectors: event.detectors,
      severity,
      confidence: event.confidence,
      escalate: escalation.escalate,
      ...(escalation.reason ? { escalationReason: escalation.reason } : {}),
      evasion,
      failedClosed,
      policyVersion: policy.version,
      layersCleared,
      ...(stopped
        ? {
            safeResponse:
              action === 'end_session'
                ? SESSION_END_RESPONSES[subject.ageGroup]
                : safeResponseFor(subject.ageGroup, categoryList, seed()),
          }
        : {}),
      event,
    };
  };

  const classify = async (
    subject: SafetySubject,
    text: string,
    scope: PolicyScope,
  ): Promise<{ categories: readonly SafetyCategory[]; confidence: number; failed: boolean }> => {
    try {
      const result = await options.classifier.classify({
        text,
        ageGroup: subject.ageGroup,
        language: subject.language,
        scope,
        timeoutMs: classifierTimeoutMs,
      });
      /* A classifier that says "unsafe" without saying what is a classifier we
       * cannot act on: every rule in the policy is keyed by category, so an
       * unnamed flag resolves to no rule, no action, and a turn that sails
       * through. That is exactly the shape `anthropic-provider.ts` returns when
       * it cannot parse a classifier response — its documented fail-closed
       * marker — and reading it as "nothing to see" turned that marker into its
       * opposite. It is treated as a failure here, which is the only channel
       * that forces a block regardless of category (rule S-1). */
      const flaggedWithoutCategory = result.flagged && result.categories.length === 0;

      return {
        categories: result.flagged ? result.categories : [],
        confidence: result.confidence,
        failed: flaggedWithoutCategory,
      };
    } catch {
      // Fail closed. The error object is deliberately discarded rather than
      // carried into the verdict: provider errors have been known to echo the
      // submitted text back in a message field, and that text is a child's.
      return { categories: [], confidence: 0, failed: true };
    }
  };

  const countRecentBlocks = async (childRef: string, policy: SafetyPolicy): Promise<number> => {
    try {
      return await attempts.recentBlocks(childRef, policy.repeatedAttemptWindowMinutes);
    } catch {
      // The counter only ever escalates a decision. Losing it must not weaken
      // one, and must not fail the turn either.
      return 0;
    }
  };

  return {
    stages: SAFETY_STAGES,

    /**
     * INPUT_SAFETY_CHECK — every child message, before anything reaches a model.
     *
     * Deterministic detectors run FIRST, and a stop here skips the classifier
     * entirely. That is a privacy property as much as a latency one: a message
     * the local layer has already judged unsafe is never transmitted to a third
     * party at all.
     */
    checkInput: async (subject: SafetySubject, utterance: string): Promise<SafetyVerdict> => {
      const policy = currentPolicy();
      const recentBlocks = await countRecentBlocks(subject.childRef, policy);

      const detections = [
        ...detectInChildInput(utterance),
        ...detectBlockedTopics(utterance, subject.parental?.blockedTopics ?? []),
      ];

      if (detections.some((d) => SEVERITY_RANK[d.severity] >= 2)) {
        const local = decide(
          policy,
          'INPUT_SAFETY_CHECK',
          subject,
          detections,
          [],
          0,
          recentBlocks,
          false,
        );
        assertNoContent(local.event, utterance);
        return local;
      }

      const classified = await classify(subject, utterance, 'child_input');
      const verdict = decide(
        policy,
        'INPUT_SAFETY_CHECK',
        subject,
        detections,
        classified.categories,
        classified.confidence,
        recentBlocks,
        classified.failed,
      );
      assertNoContent(verdict.event, utterance);
      return verdict;
    },

    /**
     * OUTPUT_SAFETY_CHECK — every model response, before it can reach the child.
     *
     * Both layers always run here. The classifier is not skipped on a local hit
     * the way it is on input: on output the two layers answer different
     * questions, and a model that has produced one problem has often produced
     * two.
     */
    checkOutput: async (subject: SafetySubject, text: string): Promise<SafetyVerdict> => {
      const policy = currentPolicy();
      const recentBlocks = await countRecentBlocks(subject.childRef, policy);

      const detections = [
        ...detectInModelOutput(text),
        ...detectBlockedTopics(text, subject.parental?.blockedTopics ?? []),
      ];
      const classified = await classify(subject, text, 'model_output');

      const verdict = decide(
        policy,
        'OUTPUT_SAFETY_CHECK',
        subject,
        detections,
        classified.categories,
        classified.confidence,
        recentBlocks,
        classified.failed,
      );
      assertNoContent(verdict.event, text);
      return verdict;
    },
  };
};

export type SafetyPipeline = ReturnType<typeof createSafetyPipeline>;

export type GuardedOutcome =
  | { readonly kind: 'ok'; readonly text: string; readonly verdicts: readonly SafetyVerdict[] }
  | {
      readonly kind: 'stopped';
      readonly text: string;
      readonly stage: CheckStage;
      readonly verdicts: readonly SafetyVerdict[];
    }
  | {
      readonly kind: 'generation_failed';
      readonly error: unknown;
      readonly verdicts: readonly SafetyVerdict[];
    };

/**
 * Runs all three stages around a caller-supplied generator.
 *
 * The generator is a callback, which is what keeps this subsystem independent of
 * the conversation engine — the pipeline never learns what it is guarding. If
 * INPUT_SAFETY_CHECK stops the turn, AI_GENERATION never runs and nothing is
 * transmitted anywhere.
 */
export const guardedTurn = async (
  pipeline: SafetyPipeline,
  subject: SafetySubject,
  utterance: string,
  generate: () => Promise<string>,
): Promise<GuardedOutcome> => {
  const verdicts: SafetyVerdict[] = [];

  const input = await pipeline.checkInput(subject, utterance);
  verdicts.push(input);
  if (!input.allowed) {
    return {
      kind: 'stopped',
      text: input.safeResponse ?? '',
      stage: 'INPUT_SAFETY_CHECK',
      verdicts,
    };
  }

  let generated: string;
  try {
    generated = await generate();
  } catch (error) {
    return { kind: 'generation_failed', error, verdicts };
  }

  const output = await pipeline.checkOutput(subject, generated);
  verdicts.push(output);
  if (!output.allowed) {
    return {
      kind: 'stopped',
      text: output.safeResponse ?? '',
      stage: 'OUTPUT_SAFETY_CHECK',
      verdicts,
    };
  }

  return { kind: 'ok', text: generated, verdicts };
};
