import type { AgeGroup } from '@kids/types';

import type { PronunciationScore } from './scoring.js';

/**
 * Practice feedback.
 *
 * THIS IS A GAME TELLING A CHILD THEY HAD A GOOD GO. It is not an assessment, a
 * diagnosis, or a report. Three rules, and the third is the one that will be
 * eroded first if nobody is watching:
 *
 * 1. **Never diagnostic.** No word here suggests a condition, a delay, a
 *    difficulty, or a comparison to other children. `DIAGNOSTIC_VOCABULARY`
 *    below is asserted against every line in the tests, so a well-meant
 *    "you might need some help with your r's" cannot ship.
 *
 * 2. **Never says wrong.** A child practising a sound they cannot yet make is
 *    doing exactly what practice is for. The bands go from delighted to
 *    encouraging; none of them go to failure.
 *
 * 3. **Specific ONLY when the analysis was specific.** Feedback naming a sound
 *    requires phoneme data from a provider. Without it the wording stays general
 *    — because the alternative is inventing a detail and telling a seven-year-old
 *    about it (see scoring.ts).
 */

export type FeedbackBand = 'excellent' | 'good' | 'nearly' | 'keep_going';

export interface Feedback {
  readonly band: FeedbackBand;
  /** What the child hears. Warm, short, and age-appropriate. */
  readonly message: string;
  /**
   * A specific pointer, when there is one to give honestly.
   *
   * Present only with phoneme data. Absent is the normal case, not a gap.
   */
  readonly focus?: string;
  /** Whether to invite another go. Never a demand. */
  readonly tryAgain: boolean;
}

export const bandFor = (score: number): FeedbackBand => {
  if (score >= 0.85) return 'excellent';
  if (score >= 0.65) return 'good';
  if (score >= 0.4) return 'nearly';
  return 'keep_going';
};

/**
 * Per band, per age group.
 *
 * Written for the age. A three-year-old needs delight and six words; a
 * nine-year-old hears baby talk and disengages.
 */
const MESSAGES: Readonly<Record<FeedbackBand, Readonly<Record<AgeGroup, readonly string[]>>>> =
  Object.freeze({
    excellent: Object.freeze({
      AGE_3_5: ['Wow! You said it!', 'Brilliant! That was lovely.', 'Yes! Super saying!'],
      AGE_6_8: ['That was brilliant!', 'Perfect — you nailed it.', 'Lovely and clear!'],
      AGE_9_10: ['Nailed it.', 'That was really clear.', 'Spot on.'],
    }),
    good: Object.freeze({
      AGE_3_5: ['Good job!', 'Nice one!', 'That was good!'],
      AGE_6_8: ['Nice work — that was close.', 'Good one! Almost perfect.', 'That sounded good.'],
      AGE_9_10: ['Good — that was close.', 'Nice. Almost exactly right.', 'That worked well.'],
    }),
    nearly: Object.freeze({
      AGE_3_5: ['Good try! Shall we say it together?', 'Nearly! Try once more?', 'Good going!'],
      AGE_6_8: [
        'Good try! Want to have another go?',
        'Nearly there — try saying it slowly.',
        'Close! One more try?',
      ],
      AGE_9_10: [
        'Close. Try it a bit slower?',
        'Nearly — have another go.',
        'Good attempt. One more?',
      ],
    }),
    keep_going: Object.freeze({
      AGE_3_5: ['Good try! Let’s say it together.', 'Nice going! Try again with me?'],
      AGE_6_8: [
        'Good try! These ones are tricky — shall we do it together?',
        'That’s a tough one. Let’s try it slowly.',
      ],
      AGE_9_10: [
        'That one’s tricky. Want to try it slowly?',
        'Good attempt — this is a hard sound. Another go?',
      ],
    }),
  });

/**
 * Words that must never appear in anything a child is told.
 *
 * Asserted in the tests against every message in this file. The list is about
 * DIAGNOSIS and JUDGEMENT, which are the two ways feedback on a child's speech
 * goes wrong: one claims a condition we cannot assess, the other tells a child
 * practising a hard sound that they failed.
 */
export const DIAGNOSTIC_VOCABULARY: readonly string[] = Object.freeze([
  'disorder',
  'impediment',
  'delay',
  'difficulty',
  'condition',
  'diagnos',
  'therapy',
  'therapist',
  'assessment',
  'below average',
  'behind',
  'normal',
  'abnormal',
  'wrong',
  'incorrect',
  'failed',
  'failure',
  'bad',
  'poor',
]);

export interface FeedbackInput {
  readonly score: PronunciationScore;
  readonly ageGroup: AgeGroup;
  readonly targetText: string;
  /** Deterministic selection in tests; avoids the same line twice running live. */
  readonly seed?: number;
}

export const buildFeedback = (input: FeedbackInput): Feedback => {
  const band = bandFor(input.score.overall);
  const options = MESSAGES[band][input.ageGroup];
  const message = options[Math.abs(input.seed ?? 0) % options.length] ?? options[0]!;

  const focus = focusFor(input.score, input.ageGroup);

  return {
    band,
    message,
    ...(focus === undefined ? {} : { focus }),
    tryAgain: band === 'nearly' || band === 'keep_going',
  };
};

/**
 * A specific pointer, or nothing.
 *
 * Gated on `phonemeDataAvailable`, which is the whole reason that flag travels
 * from the provider through the scorer to here and into a database constraint.
 * Without it, the only honest specific thing to say is nothing.
 *
 * Even WITH phoneme data the wording stays soft: "the 'th' bit" rather than "you
 * mispronounced /θ/". A child is practising, not being marked.
 */
const focusFor = (score: PronunciationScore, ageGroup: AgeGroup): string | undefined => {
  if (!score.phonemeDataAvailable) {
    // Word-level detail is honest when a provider actually scored words, and it
    // names the word rather than a sound.
    const weakest = weakestPart(score);
    if (score.method === 'word_alignment' && weakest && weakest.score < 0.6) {
      return ageGroup === 'AGE_3_5'
        ? `Let’s try the "${weakest.text}" bit!`
        : `Have a go at the "${weakest.text}" part.`;
    }
    return undefined;
  }

  const entries = Object.entries(score.phonemeScores).filter(([, value]) => value < 0.6);
  if (entries.length === 0) return undefined;

  const weakest = entries.reduce((low, entry) => (entry[1] < low[1] ? entry : low));
  return ageGroup === 'AGE_3_5'
    ? `Let’s practise the "${weakest[0]}" sound together!`
    : `The "${weakest[0]}" sound is the tricky bit — try it slowly.`;
};

const weakestPart = (score: PronunciationScore) =>
  score.parts.length === 0
    ? undefined
    : score.parts.reduce((low, part) => (part.score < low.score ? part : low));

/**
 * The line shown wherever a score is displayed to a parent.
 *
 * Not decoration. A parent looking at a list of numbers about their child's
 * speech will draw conclusions from it, and this is the sentence that says which
 * conclusions are not available (docs/adr/0006, Q-06).
 */
export const PRACTICE_DISCLAIMER =
  'These scores are practice feedback from a game, not a speech assessment. ' +
  'Speech recognition is much less accurate with children than with adults, and ' +
  'a low score often reflects the microphone, the room, or an accent rather than ' +
  'your child. If you have any concerns about your child’s speech, please talk to ' +
  'your GP, health visitor, or their school.';
