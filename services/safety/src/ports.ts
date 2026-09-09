import type { AgeGroup, SupportedLanguage } from '@kids/types';

import type { SafetyCategory } from './categories.js';

/**
 * The safety subsystem's own classifier port.
 *
 * This package deliberately does NOT import `@kids/ai`. The dependency runs the
 * other way: the conversation engine depends on safety, and safety depends on
 * nothing but a narrow classifier interface that someone else implements.
 *
 * That matters for three reasons:
 *
 * 1. The safety layer is independent of the conversation logic it guards. It can
 *    be tested, versioned, and reasoned about without a conversation existing.
 * 2. The classifier can be a different vendor from the conversation model — or
 *    two vendors in parallel — without the safety layer changing.
 * 3. Nothing in this package can accidentally reach for conversation state it has
 *    no business seeing.
 *
 * The classifier receives ONE UTTERANCE and the minimum needed to judge it. No
 * child identifier, no name, no history, no conversation id (PRIVACY.md §4).
 */

export interface ClassificationRequest {
  readonly text: string;
  readonly ageGroup: AgeGroup;
  readonly language: SupportedLanguage;
  readonly scope: 'child_input' | 'model_output';
  readonly timeoutMs: number;
}

export interface ClassificationResult {
  readonly flagged: boolean;
  readonly categories: readonly SafetyCategory[];
  /** 0–1. Compared against the policy's `minConfidence` for each category. */
  readonly confidence: number;
  /** The classifier's own view; the policy can still escalate without it. */
  readonly requiresEscalation?: boolean;
}

export interface SafetyClassifier {
  readonly name: string;
  readonly model: string;
  classify(request: ClassificationRequest): Promise<ClassificationResult>;
}

/**
 * How many recent turns were stopped for this child.
 *
 * A count, never a history. The repeated-attempt rule needs to know that a child
 * has tried five times; it does not need, and must not have, the five
 * utterances. Backed in production by `app.recent_safety_blocks()`.
 */
export interface AttemptCounter {
  recentBlocks(childRef: string, withinMinutes: number): Promise<number>;
}

/** A counter that always reports zero. The default when no store is wired. */
export const NULL_ATTEMPT_COUNTER: AttemptCounter = {
  recentBlocks: async () => await Promise.resolve(0),
};
