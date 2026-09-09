import { describe, expect, it } from 'vitest';

import {
  calculateDailyProgress,
  calculateWeeklyProgress,
  type DailyProgress,
} from './aggregation.js';
import type { LearningEvent } from './events.js';
import {
  calculateConsistencyIndicators,
  FORBIDDEN_VOCABULARY,
  INDICATORS_PREAMBLE,
  type IndicatorInput,
} from './indicators.js';
import {
  calculateMilestones,
  calculateSkillLevels,
  highestOf,
  longestActiveStreak,
  pronunciationLevel,
  type SkillLevelInput,
  type SkillLevels,
} from './levels.js';

/**
 * Progression: levels, milestones, and consistency indicators.
 *
 * The last section is the important one. It asserts, against every string this
 * subsystem can put in front of a parent, that nothing here describes a child
 * rather than their use of an app.
 */

const levelInput = (overrides: Partial<SkillLevelInput> = {}): SkillLevelInput => ({
  distinctVocabulary: 0,
  totalConversationTurns: 0,
  totalConversations: 0,
  pronunciationAttempts: 0,
  pronunciationAverage: null,
  recentActiveDays: 0,
  ...overrides,
});

describe('skill levels', () => {
  it('starts everyone at getting_started', () => {
    const levels = calculateSkillLevels(levelInput());
    expect(levels).toMatchObject({
      vocabularyLevel: 'getting_started',
      pronunciationLevel: 'getting_started',
      conversationSkillLevel: 'getting_started',
    });
  });

  it('raises vocabulary with distinct words used', () => {
    expect(calculateSkillLevels(levelInput({ distinctVocabulary: 14 })).vocabularyLevel).toBe(
      'getting_started',
    );
    expect(calculateSkillLevels(levelInput({ distinctVocabulary: 15 })).vocabularyLevel).toBe(
      'growing',
    );
    expect(calculateSkillLevels(levelInput({ distinctVocabulary: 60 })).vocabularyLevel).toBe(
      'confident',
    );
  });

  it('weighs conversation by both turns and sessions', () => {
    // One very long conversation is a different thing from coming back across
    // many sessions, and turns alone cannot tell them apart. Asserted at the
    // boundary, where the contribution of a session is visible.
    const turnsOnly = calculateSkillLevels(
      levelInput({ totalConversationTurns: 35, totalConversations: 0 }),
    );
    const sameTurnsPlusASession = calculateSkillLevels(
      levelInput({ totalConversationTurns: 35, totalConversations: 1 }),
    );

    expect(turnsOnly.conversationSkillLevel).toBe('getting_started');
    expect(sameTurnsPlusASession.conversationSkillLevel).toBe('growing');
  });

  it('records what a level was computed from', () => {
    // For the "why does it say this?" question, which a parent will ask.
    const levels = calculateSkillLevels(levelInput({ distinctVocabulary: 20 }));
    expect(levels.basis.distinctVocabulary).toBe(20);
  });

  it('never lowers a level', () => {
    // A child who was confident last month and has been on holiday is still
    // confident. A level that drops when a family goes away tells a parent
    // their child got worse, which is untrue and unkind.
    const previous: SkillLevels = {
      vocabularyLevel: 'confident',
      pronunciationLevel: 'confident',
      conversationSkillLevel: 'confident',
      basis: {},
    };

    const levels = calculateSkillLevels(levelInput(), previous);
    expect(levels).toMatchObject({
      vocabularyLevel: 'confident',
      pronunciationLevel: 'confident',
      conversationSkillLevel: 'confident',
    });
  });

  it('picks the higher of two levels', () => {
    expect(highestOf('getting_started', 'growing')).toBe('growing');
    expect(highestOf('confident', 'growing')).toBe('confident');
  });
});

describe('the pronunciation level is bounded hard', () => {
  it('stays at getting_started until there are enough attempts', () => {
    // An average over three tries is noise.
    expect(
      pronunciationLevel(levelInput({ pronunciationAttempts: 9, pronunciationAverage: 1 })),
    ).toBe('getting_started');
  });

  it('lets effort alone earn the middle band', () => {
    // A child who has practised a hundred times has earned this whatever the
    // recogniser made of their accent.
    expect(
      pronunciationLevel(levelInput({ pronunciationAttempts: 100, pronunciationAverage: 0.05 })),
    ).toBe('growing');
  });

  it('lets a score lift a level but never lower one', () => {
    const lowScore = pronunciationLevel(
      levelInput({ pronunciationAttempts: 50, pronunciationAverage: 0.1 }),
    );
    const highScore = pronunciationLevel(
      levelInput({ pronunciationAttempts: 50, pronunciationAverage: 0.9 }),
    );

    expect(lowScore).toBe('growing');
    expect(highScore).toBe('confident');
  });

  it('handles never having been scored', () => {
    expect(
      pronunciationLevel(levelInput({ pronunciationAttempts: 50, pronunciationAverage: null })),
    ).toBe('growing');
  });
});

describe('milestones', () => {
  const milestoneInput = (overrides = {}) => ({
    distinctVocabulary: 0,
    totalConversations: 0,
    totalStories: 0,
    totalExercises: 0,
    pronunciationAttempts: 0,
    longestActiveDayStreak: 0,
    alreadyAchieved: [] as string[],
    ...overrides,
  });

  it('awards on reaching a count', () => {
    const reached = calculateMilestones(milestoneInput({ totalConversations: 10 }));
    expect(reached.map((m) => m.key)).toEqual(['first_conversation', 'ten_conversations']);
  });

  it('never awards the same milestone twice', () => {
    const reached = calculateMilestones(
      milestoneInput({ totalConversations: 10, alreadyAchieved: ['first_conversation'] }),
    );
    expect(reached.map((m) => m.key)).toEqual(['ten_conversations']);
  });

  it('is about what a child did, not when they did it', () => {
    // The same milestone, whether it took a month or a year. Nothing anywhere
    // says which of those was on time.
    const fast = calculateMilestones(milestoneInput({ distinctVocabulary: 50 }));
    const slow = calculateMilestones(milestoneInput({ distinctVocabulary: 50 }));
    expect(fast).toEqual(slow);
  });

  it('measures a streak of consecutive active days', () => {
    const days: DailyProgress[] = [
      '2026-08-17',
      '2026-08-18',
      '2026-08-19',
      // a gap
      '2026-08-22',
      '2026-08-23',
    ].map((day) => calculateDailyProgress([turnOn(day)], day));

    expect(longestActiveStreak(days)).toBe(3);
  });

  it('does not count inactive days towards a streak', () => {
    const days = [
      calculateDailyProgress([turnOn('2026-08-17')], '2026-08-17'),
      calculateDailyProgress([], '2026-08-18'),
      calculateDailyProgress([turnOn('2026-08-19')], '2026-08-19'),
    ];
    expect(longestActiveStreak(days)).toBe(1);
  });

  it('handles no activity at all', () => {
    expect(longestActiveStreak([])).toBe(0);
  });
});

const turnOn = (day: string): LearningEvent => ({
  childId: 'c1',
  eventType: 'conversation_turn',
  occurredAt: new Date(`${day}T09:00:00Z`),
});

/* ========================================================================== */
/* Consistency indicators                                                     */
/* ========================================================================== */

describe('consistency indicators are about the app, not the child', () => {
  /** Every indicator this subsystem can produce, across every trigger. */
  const everyIndicator = () => {
    const inputs: IndicatorInput[] = [
      { recentDays: [], recentWeeks: [], daysSinceLastActivity: 30 },
      {
        recentDays: [],
        recentWeeks: [5, 3, 1].map((activeDays, i) =>
          weekWith(`2026-08-${String(3 + i * 7).padStart(2, '0')}`, activeDays),
        ),
        daysSinceLastActivity: 1,
      },
      {
        recentDays: [shortSessionsDay()],
        recentWeeks: [],
        daysSinceLastActivity: 0,
      },
      {
        recentDays: [notRepeatedDay()],
        recentWeeks: [],
        daysSinceLastActivity: 0,
      },
      {
        recentDays: [lowScoreDay()],
        recentWeeks: [],
        daysSinceLastActivity: 0,
      },
    ];

    return inputs.flatMap((input) => calculateConsistencyIndicators(input));
  };

  it('produces every indicator kind across the fixtures', () => {
    const keys = new Set(everyIndicator().map((i) => i.key));
    expect(keys).toEqual(
      new Set([
        'no_recent_activity',
        'engagement_declining',
        'short_sessions',
        'practice_not_repeated',
        'recognition_struggling',
      ]),
    );
  });

  it('never uses clinical, comparative, or alarming language in what it asserts', () => {
    // The assertion that makes the rename real. "Red flag" in a product that
    // listens to children speak reads as a clinical screening result, and none
    // of this is one.
    //
    // Scoped to what an indicator ASSERTS. The disclaimers are checked by the
    // next test instead: they have to name these things in order to deny them,
    // and banning the words there would force them to become vague.
    for (const indicator of everyIndicator()) {
      for (const text of [indicator.observation, indicator.suggestion]) {
        for (const forbidden of FORBIDDEN_VOCABULARY) {
          expect(text.toLowerCase(), `"${text}"`).not.toContain(forbidden);
        }
      }
    }
  });

  it('denies explicitly rather than vaguely', () => {
    // The other half. A disclaimer that avoided the words would say nothing:
    // "this is not a screening tool" has to contain "screening".
    const preamble = INDICATORS_PREAMBLE.toLowerCase();
    expect(preamble).toContain('not an assessment');
    expect(preamble).toContain('not a screening tool');
    expect(preamble).toContain('cannot tell you');
  });

  it('says what each observation cannot mean', () => {
    for (const indicator of everyIndicator()) {
      expect(indicator.notAClaim.length).toBeGreaterThan(20);
    }
  });

  it('points a worried parent at someone who can actually help', () => {
    const all = [INDICATORS_PREAMBLE, ...everyIndicator().map((i) => i.notAClaim)].join(' ');
    expect(all.toLowerCase()).toMatch(/gp|health visitor|school/);
  });

  it('says nothing when everything looks ordinary', () => {
    const indicators = calculateConsistencyIndicators({
      recentDays: [calculateDailyProgress([turnOn('2026-08-18')], '2026-08-18')],
      recentWeeks: [weekWith('2026-08-17', 4)],
      daysSinceLastActivity: 1,
    });
    expect(indicators).toEqual([]);
  });

  it('does not fire on a quiet weekend', () => {
    // A child is allowed to have a weekend.
    const indicators = calculateConsistencyIndicators({
      recentDays: [],
      recentWeeks: [],
      daysSinceLastActivity: 3,
    });
    expect(indicators.map((i) => i.key)).not.toContain('no_recent_activity');
  });

  it('needs three weeks before calling anything a decline', () => {
    // Two points is not a trend, and a half-term holiday would otherwise produce
    // a decline every single time.
    const indicators = calculateConsistencyIndicators({
      recentDays: [],
      recentWeeks: [weekWith('2026-08-10', 5), weekWith('2026-08-17', 1)],
      daysSinceLastActivity: 1,
    });
    expect(indicators.map((i) => i.key)).not.toContain('engagement_declining');
  });

  it('frames a low recognition rate as the app’s difficulty', () => {
    const indicators = calculateConsistencyIndicators({
      recentDays: [lowScoreDay()],
      recentWeeks: [],
      daysSinceLastActivity: 0,
    });

    const indicator = indicators.find((i) => i.key === 'recognition_struggling');
    // "The app has been having trouble hearing" — not "your child is hard to
    // understand". On the available evidence, the first is usually true.
    expect(indicator?.observation.toLowerCase()).toContain('the app');
    expect(indicator?.notAClaim.toLowerCase()).toContain('less well with children');
  });
});

const weekWith = (weekStart: string, activeDays: number) =>
  calculateWeeklyProgress(
    Array.from({ length: activeDays }, (_, i) => {
      const date = new Date(`${weekStart}T00:00:00.000Z`);
      date.setUTCDate(date.getUTCDate() + i);
      const day = date.toISOString().slice(0, 10);
      return calculateDailyProgress([turnOn(day)], day);
    }),
    weekStart,
  );

const shortSessionsDay = (): DailyProgress =>
  calculateDailyProgress(
    [
      ...Array.from({ length: 10 }, () => ({
        childId: 'c1',
        eventType: 'conversation_ended',
        occurredAt: new Date('2026-08-18T09:00:00Z'),
      })),
      {
        childId: 'c1',
        eventType: 'conversation_time',
        occurredAt: new Date('2026-08-18T09:00:00Z'),
        payload: { seconds: 200 },
      },
      turnOn('2026-08-18'),
    ],
    '2026-08-18',
  );

const notRepeatedDay = (): DailyProgress =>
  calculateDailyProgress(
    [
      ...Array.from({ length: 4 }, () => ({
        childId: 'c1',
        eventType: 'session_completed',
        occurredAt: new Date('2026-08-18T09:00:00Z'),
      })),
      {
        childId: 'c1',
        eventType: 'pronunciation_scored',
        occurredAt: new Date('2026-08-18T09:00:00Z'),
        payload: { score: 0.9 },
      },
    ],
    '2026-08-18',
  );

const lowScoreDay = (): DailyProgress =>
  calculateDailyProgress(
    Array.from({ length: 25 }, () => ({
      childId: 'c1',
      eventType: 'pronunciation_scored',
      occurredAt: new Date('2026-08-18T09:00:00Z'),
      payload: { score: 0.2 },
    })),
    '2026-08-18',
  );
