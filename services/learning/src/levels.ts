import type { DailyProgress, WeeklyProgress } from './aggregation.js';

/**
 * Skill levels and milestones.
 *
 * THREE BANDS, AND THEY ARE WORDS RATHER THAN NUMBERS. `getting_started`,
 * `growing`, `confident`. Not 1–5, not a percentage, not a grade.
 *
 * A number invites a comparison. "Level 3 of 5" makes a parent ask what level
 * other children are at, and this system has no answer to that question and must
 * not appear to. It has never seen another child's data, has no normative
 * sample, and could not produce a percentile if it wanted to. A word describes
 * where this child is with no scale implied behind it.
 *
 * WHAT DRIVES A LEVEL IS ACTIVITY, NOT ABILITY. Vocabulary rises with words
 * used, conversation with turns taken and sessions held. Pronunciation is the
 * one that touches a score, and it is bounded hard — see `pronunciationLevel`.
 */

export const SKILL_LEVELS = ['getting_started', 'growing', 'confident'] as const;
export type SkillLevel = (typeof SKILL_LEVELS)[number];

export interface SkillLevels {
  readonly vocabularyLevel: SkillLevel;
  readonly pronunciationLevel: SkillLevel;
  readonly conversationSkillLevel: SkillLevel;
  /** What each level was computed from, for "why does it say this?". */
  readonly basis: Readonly<Record<string, number>>;
}

export interface SkillLevelInput {
  /** Distinct curated words this child has used, ever. */
  readonly distinctVocabulary: number;
  /** Conversation turns, ever. */
  readonly totalConversationTurns: number;
  /** Conversations finished, ever. */
  readonly totalConversations: number;
  /** Pronunciation attempts, ever. */
  readonly pronunciationAttempts: number;
  /** Mean pronunciation score, or null when nothing has been scored. */
  readonly pronunciationAverage: number | null;
  /** Days with any activity in the last four weeks. Gates the top band. */
  readonly recentActiveDays: number;
}

const band = (value: number, growing: number, confident: number): SkillLevel =>
  value >= confident ? 'confident' : value >= growing ? 'growing' : 'getting_started';

/**
 * Levels never fall.
 *
 * A child who was `confident` last month and has been on holiday is still
 * confident. A level that drops when a family goes away tells a parent their
 * child got worse, which is both untrue and unkind — the drop in ACTIVITY is
 * already visible in the weekly numbers, where it belongs and where it reads as
 * what it is.
 */
export const highestOf = (a: SkillLevel, b: SkillLevel): SkillLevel =>
  SKILL_LEVELS.indexOf(a) >= SKILL_LEVELS.indexOf(b) ? a : b;

/**
 * The pronunciation level.
 *
 * THE MOST CAREFULLY BOUNDED FUNCTION IN THIS FILE, because it is the one that
 * touches a score and so the one that could most easily be read as an
 * assessment.
 *
 * Two guards. Volume comes first: no level above `getting_started` without a
 * meaningful number of attempts, because an average over three tries is noise.
 * And the average is only ever allowed to LIFT a level, never to lower one — a
 * child who has practised a hundred times has earned `growing` whatever the
 * recogniser made of their accent.
 *
 * Speech recognition is materially less accurate with children than with adults
 * (R-01). A level driven mostly by that accuracy would be measuring our
 * recogniser and labelling it a child.
 */
export const pronunciationLevel = (input: SkillLevelInput): SkillLevel => {
  const attempts = input.pronunciationAttempts;
  if (attempts < 10) return 'getting_started';

  // Effort alone earns the middle band.
  const byEffort: SkillLevel = attempts >= 60 ? 'growing' : 'growing';
  const average = input.pronunciationAverage;
  if (average === null) return byEffort;

  const byScore: SkillLevel =
    attempts >= 40 && average >= 0.75
      ? 'confident'
      : average >= 0.5
        ? 'growing'
        : 'getting_started';

  // The score lifts, never lowers.
  return highestOf(byEffort, byScore);
};

export const calculateSkillLevels = (
  input: SkillLevelInput,
  previous?: SkillLevels,
): SkillLevels => {
  const vocabulary = band(input.distinctVocabulary, 15, 60);

  // Conversation skill is turns AND breadth: a child who has had one very long
  // conversation is in a different place from one who comes back across many
  // sessions, and turns alone cannot tell them apart.
  const conversation = band(input.totalConversationTurns + input.totalConversations * 5, 40, 200);

  const pronunciation = pronunciationLevel(input);

  const computed: SkillLevels = {
    vocabularyLevel: previous ? highestOf(vocabulary, previous.vocabularyLevel) : vocabulary,
    pronunciationLevel: previous
      ? highestOf(pronunciation, previous.pronunciationLevel)
      : pronunciation,
    conversationSkillLevel: previous
      ? highestOf(conversation, previous.conversationSkillLevel)
      : conversation,
    basis: {
      distinctVocabulary: input.distinctVocabulary,
      totalConversationTurns: input.totalConversationTurns,
      totalConversations: input.totalConversations,
      pronunciationAttempts: input.pronunciationAttempts,
      recentActiveDays: input.recentActiveDays,
    },
  };

  return computed;
};

/* -------------------------------------------------------------------------- */
/* Milestones                                                                  */
/* -------------------------------------------------------------------------- */

export interface Milestone {
  readonly key: string;
  readonly title: string;
}

export interface MilestoneInput {
  readonly distinctVocabulary: number;
  readonly totalConversations: number;
  readonly totalStories: number;
  readonly totalExercises: number;
  readonly pronunciationAttempts: number;
  readonly longestActiveDayStreak: number;
  readonly alreadyAchieved: readonly string[];
}

/**
 * Things a child DID.
 *
 * Not stages a child is expected to reach by an age. Every one of these is a
 * count of something that happened, so a child who takes a year to get there
 * arrives at exactly the same milestone as one who takes a month, and nothing
 * anywhere says which of them was on time.
 */
const MILESTONE_RULES: readonly {
  key: string;
  title: string;
  reached: (input: MilestoneInput) => boolean;
}[] = Object.freeze([
  { key: 'first_conversation', title: 'First chat', reached: (i) => i.totalConversations >= 1 },
  { key: 'ten_conversations', title: 'Ten chats', reached: (i) => i.totalConversations >= 10 },
  { key: 'fifty_conversations', title: 'Fifty chats', reached: (i) => i.totalConversations >= 50 },
  { key: 'first_story', title: 'First story', reached: (i) => i.totalStories >= 1 },
  { key: 'five_stories', title: 'Five stories', reached: (i) => i.totalStories >= 5 },
  { key: 'first_exercise', title: 'First practice', reached: (i) => i.totalExercises >= 1 },
  { key: 'ten_exercises', title: 'Ten practices', reached: (i) => i.totalExercises >= 10 },
  { key: 'ten_words', title: 'Ten new words', reached: (i) => i.distinctVocabulary >= 10 },
  { key: 'fifty_words', title: 'Fifty new words', reached: (i) => i.distinctVocabulary >= 50 },
  {
    key: 'hundred_words',
    title: 'A hundred new words',
    reached: (i) => i.distinctVocabulary >= 100,
  },
  {
    key: 'week_streak',
    title: 'A whole week',
    reached: (i) => i.longestActiveDayStreak >= 7,
  },
]);

/** Milestones newly reached. Returns only NEW ones — a repeated celebration is not one. */
export const calculateMilestones = (input: MilestoneInput): readonly Milestone[] => {
  const held = new Set(input.alreadyAchieved);
  return MILESTONE_RULES.filter((rule) => !held.has(rule.key) && rule.reached(input)).map(
    (rule) => ({ key: rule.key, title: rule.title }),
  );
};

/** The longest run of consecutive active days. Used by the streak milestone. */
export const longestActiveStreak = (days: readonly DailyProgress[]): number => {
  const active = days
    .filter((d) => d.active)
    .map((d) => d.day)
    .sort();

  let longest = 0;
  let current = 0;
  let previous: Date | undefined;

  for (const day of active) {
    const date = new Date(`${day}T00:00:00.000Z`);
    const consecutive =
      previous !== undefined && date.getTime() - previous.getTime() === 86_400_000;
    current = consecutive ? current + 1 : 1;
    longest = Math.max(longest, current);
    previous = date;
  }

  return longest;
};

/** Weeks in which anything at all happened. */
export const activeWeeks = (weeks: readonly WeeklyProgress[]): number =>
  weeks.filter((w) => w.activeDays > 0).length;
