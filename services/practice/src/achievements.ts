/**
 * Achievement rules.
 *
 * DELIBERATELY ABOUT EFFORT, NOT ABILITY. Every rule counts something a child
 * controls — attempts made, sessions finished, days practised, exercises tried.
 * None counts a score.
 *
 * That is a product decision with a reason: a child practising a sound they
 * cannot yet make is doing precisely what practice is for, and an achievement
 * system keyed on scores would lock exactly that child out of every reward while
 * handing them to the children who did not need the practice.
 */

export const RULE_KINDS = [
  'attempts_total',
  'sessions_completed',
  'distinct_days',
  'exercises_tried',
] as const;

export type RuleKind = (typeof RULE_KINDS)[number];

export interface AchievementRule {
  readonly key: string;
  readonly ruleKind: RuleKind;
  readonly threshold: number;
}

/** The counters, from `app.practice_counters()`. One definition, one source. */
export type PracticeCounters = Readonly<Record<RuleKind, number>>;

export interface AwardInput {
  readonly rules: readonly AchievementRule[];
  readonly counters: PracticeCounters;
  /** Keys the child already holds. Awarding twice is worse than not awarding. */
  readonly alreadyAwarded: readonly string[];
}

/**
 * Which achievements a child has just earned.
 *
 * Returns only NEW ones. A child seeing the same celebration a second time
 * learns that the celebration means nothing.
 */
export const newlyEarned = (input: AwardInput): readonly AchievementRule[] => {
  const held = new Set(input.alreadyAwarded);

  return input.rules.filter((rule) => {
    if (held.has(rule.key)) return false;
    const counter = input.counters[rule.ruleKind];
    return Number.isFinite(counter) && counter >= rule.threshold;
  });
};

/**
 * Progress towards an achievement, 0–1.
 *
 * For a progress ring, not a score. Capped at 1 so an already-earned
 * achievement does not render as 300%.
 */
export const progressTowards = (rule: AchievementRule, counters: PracticeCounters): number => {
  if (rule.threshold <= 0) return 1;
  const counter = counters[rule.ruleKind];
  if (!Number.isFinite(counter) || counter <= 0) return 0;
  return Math.min(1, counter / rule.threshold);
};
