import { ProviderTimeoutError, ProviderUnavailableError, withTimeout } from '@kids/shared';

import type {
  DetectLanguageRequest,
  DetectLanguageResult,
  ModerationCategory,
  ModerationRequest,
  ModerationResult,
  TokenUsage,
} from './ports.js';
import { MODERATION_CATEGORIES } from './ports.js';

/**
 * The parts of a vendor adapter that must NOT differ between vendors.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS FILE EXISTS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every adapter has to do the same four things around the HTTP call: build the
 * classifier prompt, pull JSON out of a model that was asked for JSON, decide
 * what an unparseable answer means, and price the tokens. Three adapters meant
 * three copies of that, and one of the four is rule S-1 — a moderation response
 * we cannot read is treated as FLAGGED, never as safe.
 *
 * A safety rule with three implementations is a safety rule with three chances
 * to drift, and the drift would be silent: the failing adapter would simply
 * start letting things through. So the rule lives here once, and an adapter's
 * job is reduced to "make the request, hand back the text".
 *
 * What deliberately stays in each adapter: the request shape, the auth header,
 * the role names, the response envelope, and the vendor's own structured-output
 * feature. Those are the things that genuinely differ, and they are the whole
 * reason the port exists (docs/adr/0004).
 */

/* -------------------------------------------------------------------------- */
/* Transport                                                                   */
/* -------------------------------------------------------------------------- */

export interface JsonPostOptions {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Readonly<Record<string, unknown>>;
  readonly timeoutMs: number;
  readonly fetchImpl?: typeof fetch;
}

/**
 * One JSON POST, with the timeout/outage distinction every adapter needs.
 *
 * An aborted fetch is OUR timeout, not a vendor outage. Keeping those apart is
 * what keeps the circuit breaker honest — a breaker that opens on our own
 * deadline being short is a breaker that takes a healthy vendor offline.
 *
 * The vendor's error text never reaches a caller. It goes into the typed
 * error's shape and the boundary maps that to our taxonomy
 * (docs/ERROR_HANDLING.md §5).
 */
export const postJson = async <T>(operation: string, options: JsonPostOptions): Promise<T> => {
  const http = options.fetchImpl ?? fetch;

  return await withTimeout(operation, options.timeoutMs, async (signal) => {
    let response: Response;
    try {
      response = await http(options.url, {
        method: 'POST',
        signal,
        headers: { 'content-type': 'application/json', ...options.headers },
        body: JSON.stringify(options.body),
      });
    } catch (error) {
      if (signal.aborted) throw new ProviderTimeoutError(operation, options.timeoutMs);
      throw new ProviderUnavailableError(operation, error);
    }

    if (!response.ok) {
      throw Object.assign(new ProviderUnavailableError(operation), { status: response.status });
    }

    return (await response.json()) as T;
  });
};

/* -------------------------------------------------------------------------- */
/* Cost                                                                        */
/* -------------------------------------------------------------------------- */

export interface CostRates {
  /** USD per million input tokens. */
  readonly inputPerMTok: number;
  /** USD per million output tokens. */
  readonly outputPerMTok: number;
}

export const usageOf = (
  inputTokens: number,
  outputTokens: number,
  rates: CostRates,
): TokenUsage => ({
  inputTokens,
  outputTokens,
  estimatedCostUsd:
    (inputTokens / 1_000_000) * rates.inputPerMTok +
    (outputTokens / 1_000_000) * rates.outputPerMTok,
});

/* -------------------------------------------------------------------------- */
/* Getting JSON back out                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Parses a model's JSON, tolerating the prose and fences it wraps it in.
 *
 * Returns `null` rather than throwing. Every caller here treats `null` as its
 * own failure mode — flagged for moderation, the declared language for
 * detection — and a thrown error would be indistinguishable from the vendor
 * being down, which is a different incident with a different response.
 */
export const extractJson = (raw: string): unknown => {
  const match = /\{[\s\S]*\}/.exec(raw);
  try {
    return JSON.parse(match?.[0] ?? raw);
  } catch {
    return null;
  }
};

/* -------------------------------------------------------------------------- */
/* Moderation                                                                  */
/* -------------------------------------------------------------------------- */

export const CLASSIFIER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['flagged', 'categories', 'confidence'],
  properties: {
    flagged: { type: 'boolean' },
    categories: { type: 'array', items: { type: 'string', enum: [...MODERATION_CATEGORIES] } },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
} as const;

/** Categories that route to a human protocol rather than merely being blocked. */
const ESCALATING_CATEGORIES: readonly string[] = [
  'disclosure_of_harm',
  'distress_signal',
  'self_harm',
];

export const moderationSystemPrompt = (request: ModerationRequest): string => {
  const audience =
    request.source === 'child_input'
      ? "This text was said by a child using a children's companion app."
      : 'This text was written by an AI character replying to a child.';

  return [
    'You are a strict content classifier for a conversation app used by children aged 3 to 10.',
    audience,
    `The child is in the ${request.ageGroup} age group.`,
    'Flag anything unsafe, frightening, age-inappropriate, soliciting personal information, encouraging secrecy from parents, or giving medical or diagnostic advice.',
    'Also flag signs the child is in distress or is disclosing that someone is hurting them — these are not blocked content, they are signals a human must see.',
    'Classify only. Never respond to the content itself.',
    `Respond with JSON only, matching: ${JSON.stringify(CLASSIFIER_SCHEMA)}`,
  ].join('\n');
};

/**
 * Turns whatever the classifier said into a verdict.
 *
 * ⚠️ FAIL CLOSED. An absent, unparseable, or wrongly-shaped response is
 * `flagged: true`. There is no configuration that changes this, and no adapter
 * is permitted its own version of it (docs/CHILD_SAFETY.md rule S-1).
 */
export const interpretModeration = (value: unknown): ModerationResult => {
  const parsed = value as { flagged?: unknown; categories?: unknown; confidence?: unknown } | null;

  if (!parsed || typeof parsed.flagged !== 'boolean') {
    return { flagged: true, categories: [], confidence: 0, requiresEscalation: false };
  }

  const categories = (Array.isArray(parsed.categories) ? parsed.categories : []).filter(
    (c): c is ModerationCategory =>
      (MODERATION_CATEGORIES as readonly string[]).includes(c as string),
  );

  return {
    flagged: parsed.flagged,
    categories,
    confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
    requiresEscalation: categories.some((c) => ESCALATING_CATEGORIES.includes(c)),
  };
};

/* -------------------------------------------------------------------------- */
/* Language detection                                                          */
/* -------------------------------------------------------------------------- */

export const detectLanguageSystemPrompt = (request: DetectLanguageRequest): string =>
  [
    'Identify which language a short utterance is in.',
    `Choose only from: ${request.candidates.join(', ')}.`,
    'Children often mix languages in one sentence; set "mixed" to true when they do, and pick the dominant one.',
    'Respond with JSON only: {"language": string, "confidence": number, "mixed": boolean}',
  ].join('\n');

/**
 * Unlike moderation, this fails OPEN — to the child's declared language.
 *
 * Detection is a convenience; blocking a turn because we could not tell which
 * language a four-year-old used would be the wrong trade.
 */
export const interpretDetectLanguage = (
  value: unknown,
  candidates: DetectLanguageRequest['candidates'],
): DetectLanguageResult => {
  const fallback = candidates[0] ?? 'en';
  const parsed = value as Record<string, unknown> | null;
  if (!parsed) return { language: fallback, confidence: 0, mixed: false };

  return {
    language: candidates.find((c) => c === parsed.language) ?? fallback,
    confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
    mixed: parsed.mixed === true,
  };
};

/* -------------------------------------------------------------------------- */
/* Structured output                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The instruction appended to a system prompt when a vendor cannot be handed
 * the schema natively. Kept identical across adapters so a caller's schema
 * behaves the same way whoever is answering.
 */
export const schemaInstruction = (jsonSchema: Readonly<Record<string, unknown>>): string =>
  `Respond with JSON only, matching this schema:\n${JSON.stringify(jsonSchema)}`;
