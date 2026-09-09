import type { ClassificationRequest, ClassificationResult, SafetyClassifier } from '@kids/safety';
import { withRetry } from '@kids/shared';

import type { AIProvider } from './ports.js';

/**
 * Adapts an `AIProvider` to the safety subsystem's `SafetyClassifier` port.
 *
 * This file is the ONLY place the two packages meet, and the direction matters:
 * `@kids/safety` knows nothing about AI providers, conversations, or this
 * repository's vendor adapters. It asks for a thing that classifies text, and
 * this hands it one.
 *
 * Which means the classifier can be a different vendor from the conversation
 * model — or two vendors voting — by changing this file and nothing else. It
 * also means the safety subsystem is testable with a three-line fake, which is
 * why its adversarial corpus can run in milliseconds with no network.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THE RETRY LIVES HERE, AND WHY IT IS NOT A WEAKENING OF S-1
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This was the one provider call in the system with no resilience at all.
 * Generation goes through `withRetry` and a circuit breaker; the classifier
 * went straight at the vendor, so a SINGLE 429 or dropped socket blocked a
 * child's turn and fired the critical `safety_pipeline` page — on the first
 * occurrence, by design of that alert. And the classifier is the most
 * blip-exposed call there is: it runs TWICE per turn, on every utterance, on a
 * small fast model that rate-limits sooner than the conversation model.
 *
 * Retrying does not fail open. `withRetry` rethrows the last error, the
 * pipeline still catches it and still blocks the turn — rule S-1 is untouched.
 * What changes is that a transient blip is no longer indistinguishable from a
 * classifier that is genuinely down.
 *
 * The retry lives in this adapter rather than in `@kids/safety` because that
 * package depends on nothing but `@kids/types`, and keeping the vendor-shaped
 * concerns (rate limits, sockets, backoff) on this side of the port is the
 * whole point of the port.
 */

/** One retry. See `perAttemptTimeout` for why the number is not higher. */
const DEFAULT_MAX_ATTEMPTS = 2;

/**
 * Retry delays, deliberately far shorter than the generation path's.
 *
 * A child is mid-conversation with a silent character while this runs, and the
 * failure this covers — a rate limit, a dropped connection — is not one that
 * benefits from waiting. It benefits from asking again.
 */
const BASE_DELAY_MS = 100;
const MAX_DELAY_MS = 250;

export interface ClassifierResilienceOptions {
  /** Total attempts per classification, including the first. Minimum 1. */
  readonly maxAttempts?: number;
}

/**
 * Splits the caller's timeout across the attempts rather than multiplying it.
 *
 * `request.timeoutMs` is the safety pipeline's budget for ONE classification,
 * and two classifications sit inside every turn's latency budget
 * (ARCHITECTURE.md §7.1). Letting each attempt have the full timeout would make
 * a retrying classifier the slowest thing in the voice loop, so the budget is
 * divided instead: the wall-clock ceiling for a classification is unchanged.
 *
 * That halves the per-attempt timeout, which is the reason `maxAttempts` is 2
 * and not 3. At the configured 4 s that leaves 2 s per attempt against a
 * classifier that answers a short utterance in well under a second — still
 * several times the expected latency, and a slow first attempt now gets a
 * second chance where before it got none.
 */
const perAttemptTimeout = (totalMs: number, attempts: number): number =>
  Math.max(1, Math.floor(totalMs / attempts));

export const providerAsClassifier = (
  provider: AIProvider,
  options: ClassifierResilienceOptions = {},
): SafetyClassifier => {
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);

  return {
    name: provider.name,
    model: provider.classifierModel,

    classify: async (request: ClassificationRequest): Promise<ClassificationResult> => {
      const timeoutMs = perAttemptTimeout(request.timeoutMs, maxAttempts);

      const result = await withRetry(
        'moderateContent',
        async () =>
          await provider.moderateContent({
            text: request.text,
            ageGroup: request.ageGroup,
            language: request.language,
            source: request.scope,
            timeoutMs,
          }),
        {
          maxAttempts,
          // The whole classification, not one attempt: `withRetry` abandons a
          // retry that would exceed this rather than overrunning it.
          budgetMs: request.timeoutMs,
          baseDelayMs: BASE_DELAY_MS,
          maxDelayMs: MAX_DELAY_MS,
        },
      );

      return {
        flagged: result.flagged,
        categories: result.categories,
        confidence: result.confidence,
        requiresEscalation: result.requiresEscalation,
      };
    },
  };
};
