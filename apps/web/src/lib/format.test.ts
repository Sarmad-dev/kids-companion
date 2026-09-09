import { describe, expect, it } from 'vitest';

import { count, levelLabel, minutes, scoreBand } from './format';

describe('minutes', () => {
  it('says “none yet” rather than “0 minutes”', () => {
    // "0 minutes" reads like a fault. "None yet" reads like a fact.
    expect(minutes(0)).toBe('none yet');
    expect(minutes(-3)).toBe('none yet');
    expect(minutes(Number.NaN)).toBe('none yet');
  });

  it('does not round a short session away to nothing', () => {
    expect(minutes(0.4)).toBe('under a minute');
  });

  it('agrees with itself about plurals', () => {
    expect(minutes(1)).toBe('1 minute');
    expect(minutes(2)).toBe('2 minutes');
    expect(minutes(12.6)).toBe('13 minutes');
  });
});

describe('count', () => {
  it('pluralises', () => {
    expect(count(1, 'chat')).toBe('1 chat');
    expect(count(2, 'chat')).toBe('2 chats');
    expect(count(2, 'try', 'tries')).toBe('2 tries');
  });

  it('never shows a negative or fractional count', () => {
    expect(count(-4, 'word')).toBe('0 words');
    expect(count(2.7, 'word')).toBe('3 words');
    expect(count(Number.NaN, 'word')).toBe('0 words');
  });
});

describe('scoreBand', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * A PRACTICE SCORE IS NEVER SHOWN AS A NUMBER.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * "68%" invites the question "what is a good percentage for a six-year-old?",
   * and this product cannot answer it: there is no normative sample, and speech
   * recognition is materially less accurate with children than with adults. A
   * band says what we actually know, and this test is what stops a well-meaning
   * change from putting a number back.
   */
  it('returns words, never digits or a percent sign', () => {
    for (const value of [0, 0.2, 0.39, 0.4, 0.64, 0.65, 0.84, 0.85, 1]) {
      const band = scoreBand(value);
      expect(band).not.toMatch(/\d/);
      expect(band).not.toContain('%');
    }
  });

  it('says so when there is nothing to say', () => {
    expect(scoreBand(null)).toBe('not enough tries yet');
    expect(scoreBand(Number.NaN)).toBe('not enough tries yet');
  });

  it('moves up through the bands', () => {
    expect(scoreBand(0.2)).toBe('just getting started');
    expect(scoreBand(0.5)).toBe('still practising');
    expect(scoreBand(0.7)).toBe('often clear');
    expect(scoreBand(0.9)).toBe('usually clear');
  });
});

describe('levelLabel', () => {
  it('names the three levels', () => {
    expect(levelLabel('getting_started')).toBe('Getting started');
    expect(levelLabel('growing')).toBe('Growing');
    expect(levelLabel('confident')).toBe('Confident');
  });

  it('falls back to the lowest level for anything unknown', () => {
    // An unrecognised level from the API must not render as "confident". The
    // safe direction for a claim about a child is downwards.
    expect(levelLabel('advanced')).toBe('Getting started');
    expect(levelLabel('')).toBe('Getting started');
  });
});
