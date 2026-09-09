import { dayOf, weekStartOf, type LearningEvent } from './events.js';

/**
 * Daily and weekly aggregation.
 *
 * The same arithmetic as `app.rebuild_learning_daily()` in SQL, in TypeScript,
 * for two reasons: the SQL is what runs on the schedule over millions of rows,
 * and this is what a test can drive with twelve events and assert exactly. A
 * test in `aggregation.test.ts` pins the two together on a shared fixture, so a
 * change to one that is not made to the other fails the build.
 *
 * EVERY FIELD HERE IS ACTIVITY. Minutes, counts, and a score average. Nothing
 * is normalised against other children, no field is a rate of progress, and
 * there is no column a parent could read as "how my child compares" — because
 * this system cannot answer that and must not appear to (Q-12).
 */

export interface DailyProgress {
  readonly day: string;
  readonly conversationSeconds: number;
  readonly conversationMinutes: number;
  readonly conversationTurns: number;
  readonly conversationCount: number;
  readonly wordsUsed: number;
  readonly newVocabulary: number;
  readonly storiesCompleted: number;
  readonly exercisesCompleted: number;
  /** Sum and count rather than an average, so weeks aggregate without averaging averages. */
  readonly pronunciationScoreSum: number;
  readonly pronunciationScoreCount: number;
  /** `null` when nothing was scored. Zero would read as "scored badly". */
  readonly pronunciationAverage: number | null;
  /** Whether anything actually happened. A row of zeroes is not a day of practice. */
  readonly active: boolean;
}

export interface WeeklyProgress extends Omit<DailyProgress, 'day' | 'active'> {
  readonly weekStart: string;
  readonly activeDays: number;
  readonly days: readonly DailyProgress[];
}

const clampScore = (value: unknown): number => {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
};

const positiveInt = (value: unknown, fallback = 0): number => {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

const EMPTY = {
  conversationSeconds: 0,
  conversationTurns: 0,
  conversationCount: 0,
  wordsUsed: 0,
  newVocabulary: 0,
  storiesCompleted: 0,
  exercisesCompleted: 0,
  pronunciationScoreSum: 0,
  pronunciationScoreCount: 0,
};

const finishDaily = (day: string, totals: typeof EMPTY): DailyProgress => {
  // A new word is also a word used. An aggregator that counted them separately
  // could report more new vocabulary than words, which the schema rejects and a
  // parent would rightly find confusing.
  const wordsUsed = Math.max(totals.wordsUsed, totals.newVocabulary);

  const active =
    totals.conversationTurns +
      wordsUsed +
      totals.storiesCompleted +
      totals.exercisesCompleted +
      totals.pronunciationScoreCount >
    0;

  return {
    day,
    ...totals,
    wordsUsed,
    conversationMinutes: Math.round((totals.conversationSeconds / 60) * 10) / 10,
    pronunciationAverage:
      totals.pronunciationScoreCount === 0
        ? null
        : totals.pronunciationScoreSum / totals.pronunciationScoreCount,
    active,
  };
};

/**
 * One day of activity from a list of events.
 *
 * Events outside the day are ignored rather than rejected: the caller usually
 * has a window of events for other reasons, and making it pre-filter is an easy
 * thing to get subtly wrong.
 */
export const calculateDailyProgress = (
  events: readonly LearningEvent[],
  day: string,
): DailyProgress => {
  const totals = { ...EMPTY };

  for (const event of events) {
    if (dayOf(event.occurredAt) !== day) continue;
    const payload = event.payload ?? {};

    switch (event.eventType) {
      case 'conversation_time':
        totals.conversationSeconds += positiveInt(payload.seconds);
        break;
      case 'conversation_turn':
        totals.conversationTurns += 1;
        break;
      case 'conversation_ended':
        totals.conversationCount += 1;
        break;
      case 'word_encountered':
        totals.wordsUsed += positiveInt(payload.count, 1);
        break;
      case 'vocabulary_new':
        totals.newVocabulary += 1;
        break;
      case 'story_completed':
        totals.storiesCompleted += 1;
        break;
      case 'session_completed':
        totals.exercisesCompleted += 1;
        break;
      case 'pronunciation_scored':
        totals.pronunciationScoreSum += clampScore(payload.score);
        totals.pronunciationScoreCount += 1;
        break;
      case 'skill_exposed':
      case 'skill_practised':
      case 'skill_succeeded':
        // These drive `learning_progress` — per-skill exposure counters, which are
        // a different question from "what happened today". Listed explicitly
        // rather than falling to the default so that adding a daily metric for
        // them later is a deliberate edit here.
        break;
      default:
        // An event type this build does not aggregate. RECORDED AND IGNORED, not
        // an error: a new activity may exist in the taxonomy before its metric
        // is designed, and refusing it here would make deployment order matter.
        break;
    }
  }

  return finishDaily(day, totals);
};

/**
 * One week, from the days inside it.
 *
 * Built from `DailyProgress` rather than from raw events so the week is
 * guaranteed to agree with the days it is drawn from — a weekly total that
 * disagrees with the sum of its days is the bug that destroys trust in a
 * dashboard, and this shape makes it impossible.
 */
export const calculateWeeklyProgress = (
  days: readonly DailyProgress[],
  weekStart: string,
): WeeklyProgress => {
  const end = new Date(`${weekStart}T00:00:00.000Z`);
  end.setUTCDate(end.getUTCDate() + 7);
  const endDay = end.toISOString().slice(0, 10);

  const inWeek = days
    .filter((d) => d.day >= weekStart && d.day < endDay)
    .sort((a, b) => a.day.localeCompare(b.day));

  const totals = inWeek.reduce(
    (sum, d) => ({
      conversationSeconds: sum.conversationSeconds + d.conversationSeconds,
      conversationTurns: sum.conversationTurns + d.conversationTurns,
      conversationCount: sum.conversationCount + d.conversationCount,
      wordsUsed: sum.wordsUsed + d.wordsUsed,
      newVocabulary: sum.newVocabulary + d.newVocabulary,
      storiesCompleted: sum.storiesCompleted + d.storiesCompleted,
      exercisesCompleted: sum.exercisesCompleted + d.exercisesCompleted,
      pronunciationScoreSum: sum.pronunciationScoreSum + d.pronunciationScoreSum,
      pronunciationScoreCount: sum.pronunciationScoreCount + d.pronunciationScoreCount,
    }),
    { ...EMPTY },
  );

  return {
    weekStart,
    ...totals,
    conversationMinutes: Math.round((totals.conversationSeconds / 60) * 10) / 10,
    pronunciationAverage:
      totals.pronunciationScoreCount === 0
        ? null
        : totals.pronunciationScoreSum / totals.pronunciationScoreCount,
    activeDays: inWeek.filter((d) => d.active).length,
    days: inWeek,
  };
};

/** Groups events into days, then into the week each day belongs to. */
export const groupIntoDays = (events: readonly LearningEvent[]): readonly DailyProgress[] => {
  const days = [...new Set(events.map((e) => dayOf(e.occurredAt)))].sort();
  return days.map((day) => calculateDailyProgress(events, day));
};

export const weekStartFor = (day: string): string => weekStartOf(new Date(`${day}T00:00:00.000Z`));
