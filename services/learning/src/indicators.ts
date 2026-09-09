import type { DailyProgress, WeeklyProgress } from './aggregation.js';

/**
 * Educational consistency indicators.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE PRODUCT SPECIFICATION CALLS THESE "RED FLAGS". THEY ARE NOT THAT, AND
 * THE RENAME IS THE POINT RATHER THAN A PREFERENCE ABOUT WORDS.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A "red flag" in a product that listens to children speak reads as a clinical
 * screening result. It is not one, and it could not be:
 *
 *   * Nothing here is a validated screening instrument. There is no normative
 *     sample, no clinical validation, and no evidence any of these thresholds
 *     correlate with anything.
 *   * Every input is confounded by things that have nothing to do with a child:
 *     a broken microphone, a noisy kitchen, a regional accent, a sibling doing
 *     the talking, a family on holiday, a subscription that lapsed.
 *   * Speech recognition is materially less accurate with children than with
 *     adults (R-01), so a "flat pronunciation score" may be measuring our
 *     recogniser.
 *
 * A parent told their child has been "flagged" hears something about their
 * child. What we actually know is something about USAGE OF THIS APP. So each
 * indicator below describes engagement in plain language, states what it cannot
 * mean, and — where a parent might reasonably be worried — points at a
 * professional who can actually help.
 *
 * `FORBIDDEN_VOCABULARY` is asserted by the tests against what an indicator
 * ASSERTS — its `observation` and `suggestion` — so an indicator that starts
 * describing a child rather than their usage cannot ship.
 *
 * It is deliberately NOT applied to `notAClaim` or to the preamble, because
 * those exist to DENY exactly these things and cannot do so without naming them:
 * "this is not a screening tool" has to contain the word "screening". A test
 * that banned the word everywhere would force the disclaimers to become vague,
 * which is the opposite of what they are for. A separate test asserts that the
 * denials are present and specific.
 */

export type IndicatorKey =
  | 'no_recent_activity'
  | 'engagement_declining'
  | 'short_sessions'
  | 'practice_not_repeated'
  | 'recognition_struggling';

export interface ConsistencyIndicator {
  readonly key: IndicatorKey;
  /** What was observed, about app usage. Never about the child. */
  readonly observation: string;
  /** What a parent might do. Always optional, never urgent. */
  readonly suggestion: string;
  /**
   * The disclaimer specific to this indicator.
   *
   * Per-indicator rather than one blanket line, because the thing each one
   * cannot mean is different, and a generic footer gets scrolled past.
   */
  readonly notAClaim: string;
}

/**
 * Words that must never appear in what an indicator ASSERTS.
 *
 * Two families. The first is CLINICAL: language that implies a condition, an
 * assessment, or a professional judgement this system has not made. The second
 * is ALARM: language that turns an observation about app usage into something a
 * parent panics about at eleven at night.
 *
 * Checked against `observation` and `suggestion`. NOT against `notAClaim` — see
 * the header.
 */
export const FORBIDDEN_VOCABULARY: readonly string[] = Object.freeze([
  // Clinical
  'disorder',
  'delay',
  'impairment',
  'deficit',
  'diagnos',
  'symptom',
  'screening',
  'assessment',
  'condition',
  'therapy',
  'clinical',
  'abnormal',
  'atypical',
  'developmental',
  // Comparative — this system has never seen another child's data
  'below average',
  'behind',
  'percentile',
  'peers',
  'typical for',
  'expected for',
  // Alarm
  'red flag',
  'warning',
  'concern',
  'risk',
  'urgent',
  'problem',
  'failing',
]);

export interface IndicatorInput {
  readonly recentDays: readonly DailyProgress[];
  readonly recentWeeks: readonly WeeklyProgress[];
  /** Whole days since anything happened. `null` when nothing ever has. */
  readonly daysSinceLastActivity: number | null;
}

/**
 * The indicators currently true.
 *
 * Returns an empty list when everything looks ordinary, which is the common
 * case. Nothing here fires on a single quiet day: a child is allowed to have a
 * weekend.
 */
export const calculateConsistencyIndicators = (
  input: IndicatorInput,
): readonly ConsistencyIndicator[] => {
  const indicators: ConsistencyIndicator[] = [];
  const { recentDays, recentWeeks, daysSinceLastActivity } = input;

  /* ---------------- Nothing recently ---------------- */
  if (daysSinceLastActivity !== null && daysSinceLastActivity >= 14) {
    indicators.push({
      key: 'no_recent_activity',
      observation: `There has been no activity in the app for ${String(daysSinceLastActivity)} days.`,
      suggestion: 'If your child has lost interest, a different character or game might help.',
      notAClaim: 'This is about how the app has been used, and nothing more.',
    });
  }

  /* ---------------- Engagement trending down ---------------- */
  // Needs three weeks: two points is not a trend, and a half-term holiday would
  // otherwise produce a decline every single time.
  const weeks = [...recentWeeks].sort((a, b) => a.weekStart.localeCompare(b.weekStart)).slice(-3);
  if (weeks.length === 3) {
    const [first, second, third] = weeks as [WeeklyProgress, WeeklyProgress, WeeklyProgress];
    const falling =
      first.activeDays > second.activeDays &&
      second.activeDays > third.activeDays &&
      first.activeDays >= 3;

    if (falling) {
      indicators.push({
        key: 'engagement_declining',
        observation: `Your child used the app on ${String(first.activeDays)} days three weeks ago and ${String(third.activeDays)} days last week.`,
        suggestion: 'Children often move between interests. Trying a new game can help.',
        notAClaim: 'App usage goes up and down for all sorts of ordinary reasons.',
      });
    }
  }

  /* ---------------- Sessions ending quickly ---------------- */
  const withConversations = recentDays.filter((d) => d.conversationCount > 0);
  const totalSeconds = withConversations.reduce((sum, d) => sum + d.conversationSeconds, 0);
  const totalConversations = withConversations.reduce((sum, d) => sum + d.conversationCount, 0);

  if (totalConversations >= 8 && totalSeconds / totalConversations < 45) {
    indicators.push({
      key: 'short_sessions',
      observation: 'Chats have been ending quickly — under a minute on average.',
      suggestion:
        'That is completely normal for some children. If it seems unintended, checking the microphone is worth a minute.',
      notAClaim: 'Short chats tell us about the app, not about how your child talks with people.',
    });
  }

  /* ---------------- Practice started but not repeated ---------------- */
  const exercises = recentDays.reduce((sum, d) => sum + d.exercisesCompleted, 0);
  const attempts = recentDays.reduce((sum, d) => sum + d.pronunciationScoreCount, 0);

  if (exercises >= 3 && attempts > 0 && attempts / exercises < 2) {
    indicators.push({
      key: 'practice_not_repeated',
      observation: 'Practice games are being opened but usually only tried once.',
      suggestion: 'Practising a word a few times in a row is where the fun usually starts.',
      notAClaim: 'This describes how the game was played, and nothing else.',
    });
  }

  /* ---------------- The recogniser is struggling ---------------- */
  // Framed as OUR problem, because on the evidence available it usually is.
  const scored = recentDays.filter((d) => d.pronunciationScoreCount > 0);
  const scoreSum = scored.reduce((sum, d) => sum + d.pronunciationScoreSum, 0);
  const scoreCount = scored.reduce((sum, d) => sum + d.pronunciationScoreCount, 0);

  if (scoreCount >= 20 && scoreSum / scoreCount < 0.35) {
    indicators.push({
      key: 'recognition_struggling',
      observation: 'The app has been having trouble hearing clearly during practice games.',
      suggestion:
        'A quieter room, or holding the device a little closer, often makes a big difference.',
      notAClaim:
        'Speech recognition works much less well with children than with adults, so this is far more likely to be about the app than about your child. If you ever have questions about your child’s speech, your GP, health visitor, or their school is the right place to ask.',
    });
  }

  return indicators;
};

/**
 * The line shown above any list of indicators.
 *
 * Load-bearing. Without it, a list of observations under a heading is read as a
 * report about a child.
 */
export const INDICATORS_PREAMBLE =
  'These notes are about how the app has been used. They are not an assessment of ' +
  'your child, they are not a screening tool, and they cannot tell you anything ' +
  'about how your child is developing. If you have questions about your child’s ' +
  'speech or learning, your GP, health visitor, or their school can help.';
