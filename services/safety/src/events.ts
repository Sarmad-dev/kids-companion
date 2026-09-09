import type { SafetyLayer } from '@kids/types';

import type { SafetyAction, SafetyCategory } from './categories.js';
import type { Severity } from './detectors.js';

/**
 * The safety event — the ONLY thing a safety decision leaves behind.
 *
 * The governing rule for this file is a single sentence from PRIVACY.md §4:
 * record that something happened, never what was said. An event carries
 * categories, detector NAMES, a severity, and a decision. It does not carry the
 * utterance, an excerpt of it, a hash of it, or a "just the matching phrase"
 * field — every one of which has been proposed on some product at some point and
 * every one of which reconstructs the child's words in a log.
 *
 * `assertNoContent` exists to keep that true under maintenance rather than under
 * good intentions.
 */

export type EscalationReason = 'signal_category' | 'repeated_attempts' | 'evasion_of_safety';

export type SafetyDecision = 'allowed' | 'redirected' | 'blocked' | 'escalated';

export interface SafetyEvent {
  /** Which pipeline stage produced this. */
  readonly stage: 'INPUT_SAFETY_CHECK' | 'OUTPUT_SAFETY_CHECK';
  /** The `content_flags.layer` value, for continuity with the existing store. */
  readonly layer: SafetyLayer;
  readonly decision: SafetyDecision;
  readonly categories: readonly SafetyCategory[];
  /** Rule names only. Never the text that matched them. */
  readonly detectors: readonly string[];
  readonly severity: Severity;
  readonly confidence: number;
  readonly actionTaken: SafetyAction;
  readonly policyVersion: string;
  /** Position in a run of stopped turns. A number, not a history. */
  readonly attemptIndex: number;
  /** Whether the finding required undoing obfuscation to reach. */
  readonly evasion: boolean;
  readonly escalationReason?: EscalationReason;
}

/**
 * Fails if an event carries any recognisable fragment of the text it describes.
 *
 * Called on every event the pipeline emits. It is a cheap, blunt check — it
 * looks for runs of three consecutive source words inside the event's string
 * fields — and it is worth having precisely because the failure it guards
 * against is a silent one: nobody notices a leak in a log until it is in a log
 * aggregator.
 */
export const assertNoContent = (event: SafetyEvent, sourceText: string): void => {
  const haystack = [
    event.stage,
    event.layer,
    event.decision,
    event.severity,
    event.actionTaken,
    event.policyVersion,
    event.escalationReason ?? '',
    ...event.categories,
    ...event.detectors,
  ]
    .join(' ')
    .toLowerCase();

  const words = sourceText
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word.length > 0);

  // Three CONSECUTIVE words from the source, taken in their original order,
  // appearing in the event is not a coincidence. Individual words are
  // unavoidable — a "sexual_content" category name shares words with the
  // content it describes, which is the point of it — so the check is on runs.
  //
  // The length floor keeps short function words from producing a phrase common
  // enough to collide by chance.
  for (let i = 0; i + 2 < words.length; i += 1) {
    const phrase = `${words[i]!} ${words[i + 1]!} ${words[i + 2]!}`;
    if (phrase.replace(/\s/g, '').length < 12) continue;
    if (haystack.includes(phrase)) {
      throw new Error(`Safety event leaked source content via a ${event.stage} record`);
    }
  }
};

/** Maps a policy action onto the `content_flags.decision` vocabulary. */
export const decisionFor = (action: SafetyAction, escalated: boolean): SafetyDecision => {
  if (escalated) return 'escalated';
  switch (action) {
    case 'allow':
    case 'observe':
      return 'allowed';
    case 'redirect':
      return 'redirected';
    case 'block':
    case 'end_session':
      return 'blocked';
  }
};
