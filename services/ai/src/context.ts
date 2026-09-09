import type { AgeGroup, SupportedLanguage } from '@kids/types';

import { rulesFor } from './age-rules.js';
import type { CharacterDefinition } from './characters.js';
import type { ProviderContext, ProviderMessage } from './ports.js';
import { assertInvariantsPresent, buildSystemPrompt } from './prompts.js';

/**
 * Context assembly, windowing, and the outbound-data guard.
 *
 * Two jobs. First, decide WHAT the model sees: the last N exchanges, bounded
 * also by a token budget. Second, and more important, decide what it does NOT
 * see — everything about the child that the reply does not require.
 */

/** One stored message, as the application knows it. */
export interface HistoryMessage {
  readonly role: 'child' | 'companion';
  readonly text: string;
  readonly sequence: number;
}

/**
 * The full internal context. Far richer than what leaves the building.
 *
 * `childName` is present here and deliberately absent from `ProviderContext`:
 * the prompt tells the model to write `{{name}}`, and the application
 * substitutes afterwards.
 */
export interface ConversationContextInput {
  readonly childName: string;
  readonly ageGroup: AgeGroup;
  readonly language: SupportedLanguage;
  readonly character: CharacterDefinition;
  readonly history: readonly HistoryMessage[];
  readonly learningObjectives: readonly string[];
  readonly blockedTopics: readonly string[];
  readonly contentRestrictions: readonly string[];
  readonly correctionStyle: 'none' | 'gentle' | 'active';
  /** Whether the child asked to make a story. Changes the prompt, nothing else. */
  readonly storyMode?: boolean;
}

export interface ContextLimits {
  /**
   * How many EXCHANGES of history the model sees. An exchange is one child
   * message plus one companion reply, so the message count is roughly double.
   *
   * The specification calls for about ten. It is configurable rather than
   * hard-coded because the right number is an empirical question that trades
   * conversational memory against cost and latency, and it will be tuned per
   * age group once there is real usage to tune against.
   */
  readonly maxExchanges: number;
  /** Hard ceiling on history tokens, independent of the exchange count. */
  readonly maxHistoryTokens: number;
  readonly maxOutputTokens: number;
}

export const DEFAULT_CONTEXT_LIMITS: ContextLimits = Object.freeze({
  maxExchanges: 10,
  maxHistoryTokens: 2_000,
  maxOutputTokens: 320,
});

/**
 * Token estimate.
 *
 * Roughly four characters per token for English. Deliberately an OVER-estimate
 * (via `Math.ceil` and a conservative divisor) because the failure modes are
 * asymmetric: over-estimating trims one extra exchange, while under-estimating
 * means the provider rejects the request mid-conversation and the child gets
 * nothing. The provider's own count is authoritative and is what gets recorded.
 */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 3.5);

export interface WindowedHistory {
  readonly messages: readonly HistoryMessage[];
  readonly estimatedTokens: number;
  /** How many messages were dropped. Recorded, so truncation is observable. */
  readonly droppedCount: number;
}

/**
 * Takes the most recent messages within both limits.
 *
 * Trims from the OLDEST end and keeps message order, because a conversation
 * missing its middle reads as incoherent to a child ("but you just said...").
 * Losing the beginning is the least confusing thing to lose.
 */
export const windowHistory = (
  history: readonly HistoryMessage[],
  limits: ContextLimits,
): WindowedHistory => {
  const ordered = [...history].sort((a, b) => a.sequence - b.sequence);
  const byCount = ordered.slice(-(limits.maxExchanges * 2));

  const kept: HistoryMessage[] = [];
  let tokens = 0;

  // Walk backwards from the newest so the token budget is spent on recency.
  for (let i = byCount.length - 1; i >= 0; i -= 1) {
    const message = byCount[i];
    if (!message) continue;
    const cost = estimateTokens(message.text);
    if (tokens + cost > limits.maxHistoryTokens && kept.length > 0) break;
    kept.unshift(message);
    tokens += cost;
  }

  return {
    messages: kept,
    estimatedTokens: tokens,
    droppedCount: ordered.length - kept.length,
  };
};

/* -------------------------------------------------------------------------- */
/* The outbound guard                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Field names that must never appear in an outbound payload.
 *
 * A structural check rather than a review convention: `buildProviderContext`
 * narrows the context by construction, and this catches the case where someone
 * later widens `ProviderContext` or interpolates a value into the prompt.
 */
const PROHIBITED_KEYS = [
  'childId',
  'child_id',
  'parentId',
  'parent_id',
  'email',
  'birthYear',
  'birth_year',
  'birthMonth',
  'birth_month',
  'displayName',
  'display_name',
  'childName',
  'child_name',
  'conversationId',
  'conversation_id',
  'messageId',
  'ipAddress',
  'deviceId',
] as const;

export class ProhibitedDataError extends Error {
  override readonly name = 'ProhibitedDataError';
}

/**
 * Refuses to send a payload containing child PII.
 *
 * Throws rather than stripping. Silently removing a field would let the mistake
 * persist and be rediscovered later; failing the request makes it a bug someone
 * fixes today. The turn degrades to a safe fallback rather than reaching the
 * provider.
 */
export const assertNoProhibitedData = (
  payload: ProviderContext,
  forbiddenValues: readonly string[] = [],
  /**
   * Text the payload is EXPECTED to contain, discounted from the value check.
   *
   * Without this the guard fires on any child whose name is an ordinary English
   * word — Grace, Hope, Faith, Sky, Joy — because the reviewed prompt template
   * contains those words for its own reasons and the check could not tell the
   * template's word from the child's name. That is not a hypothetical: a child
   * called Sky talking to Captain Sky degraded on every single turn, and the
   * failure looked like a provider outage rather than a name collision.
   *
   * So the comparison is by COUNT, against a baseline prompt built with no
   * parent-supplied text. An occurrence the baseline does not account for is a
   * real leak — including one arriving through a blocked topic — and an
   * occurrence it does account for is the template being itself.
   */
  expectedText = '',
): void => {
  const serialised = JSON.stringify(payload);

  for (const key of PROHIBITED_KEYS) {
    if (serialised.includes(`"${key}"`)) {
      throw new ProhibitedDataError(`outbound payload contains a prohibited field: ${key}`);
    }
  }

  // Value-level check: catches a name interpolated into the prompt rather than
  // passed as a field, which is how this would most plausibly go wrong.
  const haystack = serialised.toLowerCase();
  const baseline = expectedText.toLowerCase();

  for (const value of forbiddenValues) {
    const needle = value.trim().toLowerCase();
    // Values of one or two characters match far too much to be evidence of
    // anything; the placeholder mechanism is what protects those, not this check.
    if (needle.length < 3) continue;

    if (occurrences(haystack, needle) > occurrences(baseline, needle)) {
      throw new ProhibitedDataError(
        'outbound payload contains a value that must not leave this system',
      );
    }
  }
};

const occurrences = (haystack: string, needle: string): number =>
  needle === '' ? 0 : haystack.split(needle).length - 1;

/**
 * Narrows the internal context to the minimum a provider needs.
 *
 * This function IS the privacy boundary. Everything the model sees passes
 * through it, and it drops: the child's name, their id, their birth date, their
 * parent, the conversation id, message ids, and timestamps.
 */
export const buildProviderContext = (
  input: ConversationContextInput,
  limits: ContextLimits = DEFAULT_CONTEXT_LIMITS,
): { context: ProviderContext; window: WindowedHistory } => {
  const systemPrompt = buildSystemPrompt({
    character: input.character,
    ageGroup: input.ageGroup,
    language: input.language,
    learningObjectives: input.learningObjectives,
    blockedTopics: input.blockedTopics,
    contentRestrictions: input.contentRestrictions,
    correctionStyle: input.correctionStyle,
    storyMode: input.storyMode === true,
  });

  // Fails loudly if a refactor dropped a safety rule.
  assertInvariantsPresent(systemPrompt);

  const window = windowHistory(input.history, limits);

  const context: ProviderContext = {
    ageGroup: input.ageGroup,
    language: input.language,
    systemPrompt,
    history: window.messages.map((m): ProviderMessage => ({ role: m.role, text: m.text })),
  };

  // The baseline: the same prompt with every parent-supplied field removed, so
  // the guard can tell the template's own words from the child's name.
  const baselinePrompt = buildSystemPrompt({
    character: input.character,
    ageGroup: input.ageGroup,
    language: input.language,
    learningObjectives: [],
    blockedTopics: [],
    contentRestrictions: [],
    correctionStyle: input.correctionStyle,
    // Template text, not parent-supplied data. Omitting it here would make the
    // story section look like something a parent injected.
    storyMode: input.storyMode === true,
  });

  assertNoProhibitedData(context, [input.childName], baselinePrompt);

  return { context, window };
};

/** The output ceiling for an age group, never above the configured maximum. */
export const outputTokensFor = (ageGroup: AgeGroup, limits: ContextLimits): number =>
  Math.min(rulesFor(ageGroup).maxOutputTokens, limits.maxOutputTokens);
