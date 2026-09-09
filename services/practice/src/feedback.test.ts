import type { AgeGroup } from '@kids/types';
import { describe, expect, it } from 'vitest';

import { newlyEarned, progressTowards, type AchievementRule } from './achievements.js';
import { bandFor, buildFeedback, DIAGNOSTIC_VOCABULARY, PRACTICE_DISCLAIMER } from './feedback.js';
import type { PronunciationScore } from './scoring.js';

/**
 * Feedback and achievements.
 *
 * The first half of this file is the guard on the requirement that matters most:
 * this product does not diagnose speech. The tests below assert it against every
 * line the system can say, in every band, at every age — so a well-meant "you
 * might need some help with your r's" cannot ship past review.
 */

const AGE_GROUPS: readonly AgeGroup[] = ['AGE_3_5', 'AGE_6_8', 'AGE_9_10'];

const scoreOf = (overrides: Partial<PronunciationScore> = {}): PronunciationScore => ({
  overall: 0.9,
  confidence: 0.9,
  method: 'transcript_similarity',
  phonemeDataAvailable: false,
  parts: [],
  phonemeScores: {},
  isCorrect: true,
  provider: 'test',
  providerModel: 'test-v1',
  ...overrides,
});

describe('bands', () => {
  it('maps scores to bands', () => {
    expect(bandFor(1)).toBe('excellent');
    expect(bandFor(0.85)).toBe('excellent');
    expect(bandFor(0.84)).toBe('good');
    expect(bandFor(0.65)).toBe('good');
    expect(bandFor(0.64)).toBe('nearly');
    expect(bandFor(0.4)).toBe('nearly');
    expect(bandFor(0.39)).toBe('keep_going');
    expect(bandFor(0)).toBe('keep_going');
  });

  it('has no band that means failure', () => {
    // The lowest band is "keep going", not "wrong". A child practising a sound
    // they cannot yet make is doing exactly what practice is for.
    expect(bandFor(0)).toBe('keep_going');
  });
});

describe('nothing diagnostic ever reaches a child', () => {
  it('never uses diagnostic or judgemental vocabulary, in any band or age', () => {
    for (const ageGroup of AGE_GROUPS) {
      for (const overall of [1, 0.9, 0.75, 0.6, 0.5, 0.3, 0.1, 0]) {
        for (let seed = 0; seed < 6; seed += 1) {
          const feedback = buildFeedback({
            score: scoreOf({ overall }),
            ageGroup,
            targetText: 'banana',
            seed,
          });

          const said = `${feedback.message} ${feedback.focus ?? ''}`.toLowerCase();
          for (const forbidden of DIAGNOSTIC_VOCABULARY) {
            expect(said, `${ageGroup} ${String(overall)}: ${said}`).not.toContain(forbidden);
          }
        }
      }
    }
  });

  it('always says something, whatever the score', () => {
    for (const ageGroup of AGE_GROUPS) {
      for (const overall of [0, 0.5, 1]) {
        const feedback = buildFeedback({ score: scoreOf({ overall }), ageGroup, targetText: 'x' });
        expect(feedback.message.length).toBeGreaterThan(3);
      }
    }
  });

  it('invites another go only when there is a reason to', () => {
    expect(
      buildFeedback({ score: scoreOf({ overall: 1 }), ageGroup: 'AGE_6_8', targetText: 'x' })
        .tryAgain,
    ).toBe(false);
    expect(
      buildFeedback({ score: scoreOf({ overall: 0.2 }), ageGroup: 'AGE_6_8', targetText: 'x' })
        .tryAgain,
    ).toBe(true);
  });

  it('tells a parent what the score is not', () => {
    // A parent looking at numbers about their child's speech will draw
    // conclusions. This is the sentence that says which ones are not available.
    const disclaimer = PRACTICE_DISCLAIMER.toLowerCase();
    expect(disclaimer).toContain('not a speech assessment');
    expect(disclaimer).toContain('less accurate with children');
    // And it points somewhere real rather than leaving a worried parent nowhere.
    expect(disclaimer).toMatch(/gp|health visitor|school/);
  });
});

describe('specific feedback requires specific evidence', () => {
  it('says nothing specific without phoneme data', () => {
    const feedback = buildFeedback({
      score: scoreOf({ overall: 0.3, method: 'transcript_similarity' }),
      ageGroup: 'AGE_6_8',
      targetText: 'thumb',
    });

    // The alternative is inventing a detail and telling a seven-year-old about
    // it. Absent is the correct answer here, not a gap.
    expect(feedback.focus).toBeUndefined();
  });

  it('names a sound only when a provider scored sounds', () => {
    const feedback = buildFeedback({
      score: scoreOf({
        overall: 0.5,
        method: 'phoneme_alignment',
        phonemeDataAvailable: true,
        phonemeScores: { θ: 0.2, ʌ: 0.9 },
      }),
      ageGroup: 'AGE_6_8',
      targetText: 'thumb',
    });

    expect(feedback.focus).toContain('θ');
    // Soft wording even with real data: a child is practising, not being marked.
    expect(feedback.focus?.toLowerCase()).not.toContain('mispronounc');
  });

  it('names a word when a provider scored words', () => {
    const feedback = buildFeedback({
      score: scoreOf({
        overall: 0.5,
        method: 'word_alignment',
        parts: [
          { text: 'birth', score: 0.9 },
          { text: 'day', score: 0.3 },
        ],
      }),
      ageGroup: 'AGE_9_10',
      targetText: 'birthday',
    });

    expect(feedback.focus).toContain('day');
  });

  it('stays quiet when every part was fine', () => {
    const feedback = buildFeedback({
      score: scoreOf({
        overall: 0.95,
        method: 'phoneme_alignment',
        phonemeDataAvailable: true,
        phonemeScores: { θ: 0.95, ʌ: 0.92 },
      }),
      ageGroup: 'AGE_6_8',
      targetText: 'thumb',
    });

    expect(feedback.focus).toBeUndefined();
  });

  it('speaks differently to a three-year-old and a nine-year-old', () => {
    // A nine-year-old hears baby talk and disengages.
    const young = buildFeedback({
      score: scoreOf({ overall: 0.5 }),
      ageGroup: 'AGE_3_5',
      targetText: 'x',
      seed: 0,
    });
    const older = buildFeedback({
      score: scoreOf({ overall: 0.5 }),
      ageGroup: 'AGE_9_10',
      targetText: 'x',
      seed: 0,
    });
    expect(young.message).not.toBe(older.message);
  });
});

describe('achievements', () => {
  const rules: readonly AchievementRule[] = [
    { key: 'first_try', ruleKind: 'attempts_total', threshold: 1 },
    { key: 'ten_attempts', ruleKind: 'attempts_total', threshold: 10 },
    { key: 'three_days', ruleKind: 'distinct_days', threshold: 3 },
  ];

  const counters = (overrides: Partial<Record<string, number>> = {}) => ({
    attempts_total: 0,
    sessions_completed: 0,
    distinct_days: 0,
    exercises_tried: 0,
    ...overrides,
  });

  it('awards when the threshold is reached', () => {
    const earned = newlyEarned({
      rules,
      counters: counters({ attempts_total: 10 }),
      alreadyAwarded: [],
    });

    expect(earned.map((r) => r.key)).toEqual(['first_try', 'ten_attempts']);
  });

  it('never awards the same achievement twice', () => {
    // A child seeing the same celebration a second time learns it means nothing.
    const earned = newlyEarned({
      rules,
      counters: counters({ attempts_total: 10 }),
      alreadyAwarded: ['first_try'],
    });

    expect(earned.map((r) => r.key)).toEqual(['ten_attempts']);
  });

  it('rewards effort rather than ability', () => {
    // Every rule counts something a child controls. A child who cannot yet make
    // a sound still earns everything by trying — which is the point.
    const earned = newlyEarned({
      rules,
      counters: counters({ attempts_total: 50, distinct_days: 5 }),
      alreadyAwarded: [],
    });

    expect(earned).toHaveLength(3);
  });

  it('reports progress towards an achievement without exceeding it', () => {
    expect(progressTowards(rules[1]!, counters({ attempts_total: 5 }))).toBe(0.5);
    expect(progressTowards(rules[1]!, counters({ attempts_total: 500 }))).toBe(1);
    expect(progressTowards(rules[1]!, counters())).toBe(0);
  });

  it('survives a missing or nonsensical counter', () => {
    expect(
      newlyEarned({
        rules,
        counters: counters({ attempts_total: Number.NaN }),
        alreadyAwarded: [],
      }),
    ).toHaveLength(0);

    expect(
      progressTowards({ key: 'x', ruleKind: 'attempts_total', threshold: 0 }, counters()),
    ).toBe(1);
  });
});
