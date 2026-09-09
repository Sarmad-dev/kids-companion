import { describe, expect, it } from 'vitest';

import {
  calculateDailyProgress,
  calculateWeeklyProgress,
  groupIntoDays,
  weekStartFor,
} from './aggregation.js';
import {
  assertPayloadIsMetadata,
  dayOf,
  InvalidLearningEventError,
  weekStartOf,
  type LearningEvent,
} from './events.js';
import { recordLearningEvent, recordLearningEvents, type LearningStore } from './record.js';

/**
 * Aggregation.
 *
 * The property under test throughout is that the rollups agree with the log and
 * with each other. A weekly total that disagrees with the sum of its days is the
 * bug that destroys a parent's trust in a dashboard, and it is the kind of bug
 * that survives review because both numbers look plausible.
 */

const event = (
  eventType: string,
  occurredAt: string,
  payload?: Record<string, number>,
): LearningEvent => ({
  childId: 'child-1',
  eventType,
  occurredAt: new Date(occurredAt),
  ...(payload ? { payload } : {}),
});

describe('day and week boundaries', () => {
  it('uses UTC days', () => {
    expect(dayOf(new Date('2026-08-18T23:59:59.999Z'))).toBe('2026-08-18');
    expect(dayOf(new Date('2026-08-19T00:00:00.000Z'))).toBe('2026-08-19');
  });

  it('starts weeks on Monday', () => {
    // 2026-08-17 is a Monday.
    expect(weekStartOf(new Date('2026-08-17T00:00:00.000Z'))).toBe('2026-08-17');
    expect(weekStartOf(new Date('2026-08-21T12:00:00.000Z'))).toBe('2026-08-17');
    // Sunday belongs to the week that began the previous Monday, which is the
    // off-by-one this pins.
    expect(weekStartOf(new Date('2026-08-23T23:00:00.000Z'))).toBe('2026-08-17');
    expect(weekStartOf(new Date('2026-08-24T00:00:00.000Z'))).toBe('2026-08-24');
  });

  it('agrees with itself across the helpers', () => {
    expect(weekStartFor('2026-08-23')).toBe(weekStartOf(new Date('2026-08-23T00:00:00.000Z')));
  });
});

describe('calculateDailyProgress', () => {
  const day = '2026-08-18';
  const at = (time: string) => `${day}T${time}Z`;

  it('counts every tracked metric', () => {
    const progress = calculateDailyProgress(
      [
        event('conversation_turn', at('09:00:00')),
        event('conversation_turn', at('09:01:00')),
        event('conversation_time', at('09:02:00'), { seconds: 180 }),
        event('conversation_ended', at('09:03:00')),
        event('word_encountered', at('09:01:00'), { count: 12 }),
        event('vocabulary_new', at('09:01:30')),
        event('story_completed', at('10:00:00')),
        event('session_completed', at('11:00:00')),
        event('pronunciation_scored', at('11:01:00'), { score: 0.8 }),
        event('pronunciation_scored', at('11:02:00'), { score: 0.6 }),
      ],
      day,
    );

    expect(progress).toMatchObject({
      day,
      conversationSeconds: 180,
      conversationMinutes: 3,
      conversationTurns: 2,
      conversationCount: 1,
      wordsUsed: 12,
      newVocabulary: 1,
      storiesCompleted: 1,
      exercisesCompleted: 1,
      pronunciationScoreCount: 2,
      active: true,
    });
    expect(progress.pronunciationAverage).toBeCloseTo(0.7, 5);
  });

  it('ignores events from other days', () => {
    const progress = calculateDailyProgress(
      [
        event('conversation_turn', at('09:00:00')),
        event('conversation_turn', '2026-08-19T09:00:00Z'),
      ],
      day,
    );
    expect(progress.conversationTurns).toBe(1);
  });

  it('reports a null average when nothing was scored', () => {
    // Zero would read as "scored badly", which is a different and untrue thing.
    const progress = calculateDailyProgress([event('conversation_turn', at('09:00:00'))], day);
    expect(progress.pronunciationAverage).toBeNull();
  });

  it('never reports more new vocabulary than words used', () => {
    // A new word is also a word used. Counting them separately would produce a
    // number the schema rejects and a parent would find baffling.
    const progress = calculateDailyProgress(
      [event('vocabulary_new', at('09:00:00')), event('vocabulary_new', at('09:01:00'))],
      day,
    );
    expect(progress.newVocabulary).toBe(2);
    expect(progress.wordsUsed).toBeGreaterThanOrEqual(progress.newVocabulary);
  });

  it('treats an empty day as inactive', () => {
    const progress = calculateDailyProgress([], day);
    expect(progress.active).toBe(false);
    expect(progress.conversationTurns).toBe(0);
  });

  it('does not count a day of pure conversation time as active', () => {
    // A session left open on a table is seconds without activity. Counting it
    // would inflate a streak with something the child did not do.
    const progress = calculateDailyProgress(
      [event('conversation_time', at('09:00:00'), { seconds: 600 })],
      day,
    );
    expect(progress.active).toBe(false);
  });

  it('ignores an event type this build does not aggregate', () => {
    // A new activity may exist in the taxonomy before its metric is designed.
    // Refusing it here would make deployment order matter.
    const progress = calculateDailyProgress(
      [event('drawing_described', at('09:00:00')), event('conversation_turn', at('09:01:00'))],
      day,
    );
    expect(progress.conversationTurns).toBe(1);
  });

  it('survives hostile payload values', () => {
    const progress = calculateDailyProgress(
      [
        event('conversation_time', at('09:00:00'), { seconds: -500 }),
        event('conversation_time', at('09:01:00'), { seconds: Number.NaN }),
        event('word_encountered', at('09:02:00'), { count: -3 }),
        event('pronunciation_scored', at('09:03:00'), { score: 42 }),
        event('pronunciation_scored', at('09:04:00'), { score: -1 }),
      ],
      day,
    );

    expect(progress.conversationSeconds).toBe(0);
    // A missing or nonsensical word count falls back to one, not to a negative.
    expect(progress.wordsUsed).toBe(1);
    expect(progress.pronunciationAverage).toBeGreaterThanOrEqual(0);
    expect(progress.pronunciationAverage).toBeLessThanOrEqual(1);
  });

  it('defaults a missing word count to one', () => {
    const progress = calculateDailyProgress([event('word_encountered', at('09:00:00'))], day);
    expect(progress.wordsUsed).toBe(1);
  });
});

describe('calculateWeeklyProgress', () => {
  const week = '2026-08-17';
  const days = groupIntoDays([
    event('conversation_turn', '2026-08-17T09:00:00Z'),
    event('conversation_time', '2026-08-17T09:01:00Z', { seconds: 120 }),
    event('pronunciation_scored', '2026-08-17T09:02:00Z', { score: 1 }),
    event('conversation_turn', '2026-08-19T09:00:00Z'),
    event('pronunciation_scored', '2026-08-19T09:01:00Z', { score: 0 }),
    event('story_completed', '2026-08-23T09:00:00Z'),
    // Outside the week.
    event('conversation_turn', '2026-08-24T09:00:00Z'),
  ]);

  it('sums the days inside the week and excludes the ones outside it', () => {
    const weekly = calculateWeeklyProgress(days, week);

    expect(weekly.weekStart).toBe(week);
    expect(weekly.days).toHaveLength(3);
    expect(weekly.conversationTurns).toBe(2);
    expect(weekly.storiesCompleted).toBe(1);
  });

  it('agrees exactly with the sum of its days', () => {
    // The invariant that matters. A weekly total that disagrees with the days it
    // is drawn from is the bug that destroys trust in a dashboard.
    const weekly = calculateWeeklyProgress(days, week);
    const summed = weekly.days.reduce((sum, d) => sum + d.conversationTurns, 0);
    expect(weekly.conversationTurns).toBe(summed);
  });

  it('averages over the week rather than averaging the daily averages', () => {
    // Monday: one attempt at 1.0. Wednesday: one at 0.0. Both means are 0.5
    // here, but with 3 and 1 attempts they would differ — which is exactly why
    // sum and count are carried rather than an average.
    const weekly = calculateWeeklyProgress(days, week);
    expect(weekly.pronunciationScoreCount).toBe(2);
    expect(weekly.pronunciationAverage).toBeCloseTo(0.5, 5);
  });

  it('counts only days on which something happened', () => {
    const weekly = calculateWeeklyProgress(
      [...days, calculateDailyProgress([], '2026-08-20')],
      week,
    );
    expect(weekly.activeDays).toBe(3);
  });

  it('handles an empty week', () => {
    const weekly = calculateWeeklyProgress([], week);
    expect(weekly.activeDays).toBe(0);
    expect(weekly.pronunciationAverage).toBeNull();
    expect(weekly.days).toEqual([]);
  });
});

describe('recordLearningEvent', () => {
  const makeStore = () => {
    const appended: LearningEvent[] = [];
    const rebuiltDays: string[] = [];
    const rebuiltWeeks: string[] = [];
    const seen = new Set<string>();

    const store: LearningStore = {
      append: async (e) => {
        await Promise.resolve();
        if (e.idempotencyKey !== undefined) {
          if (seen.has(e.idempotencyKey)) return false;
          seen.add(e.idempotencyKey);
        }
        appended.push(e);
        return true;
      },
      rebuildDay: async (_childId, day) => {
        await Promise.resolve();
        rebuiltDays.push(day);
      },
      rebuildWeek: async (_childId, week) => {
        await Promise.resolve();
        rebuiltWeeks.push(week);
      },
    };

    return { store, appended, rebuiltDays, rebuiltWeeks };
  };

  it('appends and reports the day and week it touched', async () => {
    const { store, appended } = makeStore();
    const result = await recordLearningEvent(
      store,
      event('conversation_turn', '2026-08-19T09:00:00Z'),
    );

    expect(result).toMatchObject({ recorded: true, day: '2026-08-19', weekStart: '2026-08-17' });
    expect(appended).toHaveLength(1);
  });

  it('does not rebuild by default', async () => {
    // A child mid-conversation must not wait on an aggregation.
    const { store, rebuiltDays } = makeStore();
    await recordLearningEvent(store, event('conversation_turn', '2026-08-19T09:00:00Z'));
    expect(rebuiltDays).toEqual([]);
  });

  it('rebuilds on request', async () => {
    const { store, rebuiltDays, rebuiltWeeks } = makeStore();
    await recordLearningEvent(store, event('conversation_turn', '2026-08-19T09:00:00Z'), {
      rebuildNow: true,
    });
    expect(rebuiltDays).toEqual(['2026-08-19']);
    expect(rebuiltWeeks).toEqual(['2026-08-17']);
  });

  it('does not double-count a retried request', async () => {
    const { store, appended } = makeStore();
    const withKey: LearningEvent = {
      ...event('story_completed', '2026-08-19T09:00:00Z'),
      idempotencyKey: 'message-42',
    };

    expect((await recordLearningEvent(store, withKey)).recorded).toBe(true);
    expect((await recordLearningEvent(store, withKey)).recorded).toBe(false);
    expect(appended).toHaveLength(1);
  });

  it('does not rebuild for a duplicate', async () => {
    const { store, rebuiltDays } = makeStore();
    const withKey: LearningEvent = {
      ...event('story_completed', '2026-08-19T09:00:00Z'),
      idempotencyKey: 'message-43',
    };

    await recordLearningEvent(store, withKey, { rebuildNow: true });
    await recordLearningEvent(store, withKey, { rebuildNow: true });
    expect(rebuiltDays).toEqual(['2026-08-19']);
  });

  it('rebuilds each affected day once for a batch', async () => {
    // A conversation turn produces several events at the same instant.
    const { store, rebuiltDays, rebuiltWeeks } = makeStore();
    await recordLearningEvents(
      store,
      [
        event('conversation_turn', '2026-08-19T09:00:00Z'),
        event('word_encountered', '2026-08-19T09:00:00Z', { count: 8 }),
        event('vocabulary_new', '2026-08-19T09:00:00Z'),
        event('conversation_turn', '2026-08-20T09:00:00Z'),
      ],
      { rebuildNow: true },
    );

    expect(rebuiltDays.sort()).toEqual(['2026-08-19', '2026-08-20']);
    expect(rebuiltWeeks).toEqual(['2026-08-17']);
  });
});

describe('the payload is metadata, never content', () => {
  it.each(['text', 'transcript', 'utterance', 'message', 'content', 'name', 'email'])(
    'refuses a payload key called %j',
    (key) => {
      expect(() =>
        assertPayloadIsMetadata({
          ...event('word_encountered', '2026-08-19T09:00:00Z'),
          payload: { [key]: 'anything' },
        }),
      ).toThrow(InvalidLearningEventError);
    },
  );

  it('refuses a value long enough to be a sentence', () => {
    // A sentence in this subsystem is something a child said.
    expect(() =>
      assertPayloadIsMetadata({
        ...event('word_encountered', '2026-08-19T09:00:00Z'),
        payload: { note: 'x'.repeat(200) },
      }),
    ).toThrow(InvalidLearningEventError);
  });

  it('allows counts, durations, and short curated keys', () => {
    expect(() =>
      assertPayloadIsMetadata({
        ...event('word_encountered', '2026-08-19T09:00:00Z'),
        payload: { count: 12, seconds: 90, topicKey: 'animals', isNew: true },
      }),
    ).not.toThrow();
  });

  it('throws rather than stripping', async () => {
    // Silently removing the field would let the mistake ship. Failing makes it a
    // bug someone fixes today.
    const { store, appended } = makeStoreForThrow();
    await expect(
      recordLearningEvent(store, {
        ...event('word_encountered', '2026-08-19T09:00:00Z'),
        payload: { transcript: 'the child said something' },
      }),
    ).rejects.toThrow(InvalidLearningEventError);
    expect(appended).toHaveLength(0);
  });

  const makeStoreForThrow = () => {
    const appended: LearningEvent[] = [];
    const store: LearningStore = {
      append: async (e) => {
        await Promise.resolve();
        appended.push(e);
        return true;
      },
      rebuildDay: async () => await Promise.resolve(),
      rebuildWeek: async () => await Promise.resolve(),
    };
    return { store, appended };
  };
});
