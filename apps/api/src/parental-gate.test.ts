import { fixedClock } from '@kids/shared';
import { describe, expect, it } from 'vitest';

import { evaluateParentalGate, inQuietHours, type ParentalControls } from './parental-gate.js';

/**
 * The gate, against a fixed clock.
 *
 * The schedule rules are the ones worth testing here rather than in an
 * integration suite: proving that quiet hours work across midnight by waiting
 * until midnight is not a test anybody runs.
 */

/** 2026-08-19 is a Wednesday (ISO day 3). 14:30 UTC. */
const WEDNESDAY_AFTERNOON = fixedClock(Date.parse('2026-08-19T14:30:00.000Z'));

const controls = (overrides: Partial<ParentalControls> = {}): ParentalControls => ({
  isPaused: false,
  dailyMinuteLimit: 20,
  sessionMinuteLimit: 15,
  quietHoursStart: null,
  quietHoursEnd: null,
  allowedDays: [],
  allowedCharacterIds: [],
  blockedTopics: [],
  languageLock: null,
  contentFilterLevel: 'standard',
  secondsUsedToday: 0,
  ...overrides,
});

describe('quiet hours', () => {
  it('handles a window inside one day', () => {
    expect(inQuietHours(13 * 60, '12:00:00', '14:00:00')).toBe(true);
    expect(inQuietHours(11 * 60, '12:00:00', '14:00:00')).toBe(false);
    // The end is exclusive: 14:00 is when quiet hours are over.
    expect(inQuietHours(14 * 60, '12:00:00', '14:00:00')).toBe(false);
  });

  it('handles a window that crosses midnight', () => {
    // The normal case — "quiet from 19:00 to 07:00" is what a parent sets, and a
    // naive start <= now <= end comparison silently permits the entire night.
    expect(inQuietHours(20 * 60, '19:00:00', '07:00:00')).toBe(true);
    expect(inQuietHours(2 * 60, '19:00:00', '07:00:00')).toBe(true);
    expect(inQuietHours(12 * 60, '19:00:00', '07:00:00')).toBe(false);
    expect(inQuietHours(7 * 60, '19:00:00', '07:00:00')).toBe(false);
  });

  it('is inert when only one bound is set', () => {
    expect(inQuietHours(20 * 60, '19:00:00', null)).toBe(false);
    expect(inQuietHours(20 * 60, null, '07:00:00')).toBe(false);
  });

  it('is inert when the bounds are equal', () => {
    // Otherwise "quiet from 09:00 to 09:00" would mean either nothing or the
    // whole day, and neither is obviously what a parent meant.
    expect(inQuietHours(9 * 60, '09:00:00', '09:00:00')).toBe(false);
  });
});

describe('the gate', () => {
  const evaluate = (c: Partial<ParentalControls>, extra = {}) =>
    evaluateParentalGate({ controls: controls(c), clock: WEDNESDAY_AFTERNOON, ...extra });

  it('allows an ordinary afternoon', () => {
    expect(evaluate({}).allowed).toBe(true);
  });

  it('refuses a paused child', () => {
    expect(evaluate({ isPaused: true })).toMatchObject({ allowed: false, denial: 'paused' });
  });

  it('refuses a day the schedule does not allow', () => {
    // Wednesday is ISO 3; this allows only weekends.
    expect(evaluate({ allowedDays: [6, 7] })).toMatchObject({
      allowed: false,
      denial: 'outside_allowed_days',
    });
    expect(evaluate({ allowedDays: [3] }).allowed).toBe(true);
  });

  it('treats an empty schedule as every day', () => {
    expect(evaluate({ allowedDays: [] }).allowed).toBe(true);
  });

  it('refuses during quiet hours', () => {
    expect(evaluate({ quietHoursStart: '14:00:00', quietHoursEnd: '16:00:00' })).toMatchObject({
      allowed: false,
      denial: 'quiet_hours',
    });
  });

  it('refuses once the daily limit is reached', () => {
    expect(evaluate({ dailyMinuteLimit: 20, secondsUsedToday: 1_200 })).toMatchObject({
      allowed: false,
      denial: 'daily_limit_reached',
    });
    expect(evaluate({ dailyMinuteLimit: 20, secondsUsedToday: 1_199 }).allowed).toBe(true);
  });

  it('reports the minutes left', () => {
    expect(evaluate({ dailyMinuteLimit: 20, secondsUsedToday: 600 }).minutesRemaining).toBe(10);
    expect(evaluate({ dailyMinuteLimit: 20, secondsUsedToday: 1_500 }).minutesRemaining).toBe(0);
  });

  it('treats a daily limit of zero as unlimited', () => {
    // Matching the "empty means all" convention the array columns use. A parent
    // who wants to stop access entirely uses the pause, which is reversible in
    // one tap and obvious on the dashboard.
    const result = evaluate({ dailyMinuteLimit: 0, secondsUsedToday: 100_000 });
    expect(result.allowed).toBe(true);
    expect(result.minutesRemaining).toBeNull();
  });

  it('refuses once the session limit is reached', () => {
    expect(evaluate({ sessionMinuteLimit: 15 }, { sessionSeconds: 900 })).toMatchObject({
      allowed: false,
      denial: 'session_limit_reached',
    });
    expect(evaluate({ sessionMinuteLimit: 15 }, { sessionSeconds: 899 }).allowed).toBe(true);
  });

  it('refuses a character that is not on the allowlist', () => {
    expect(evaluate({ allowedCharacterIds: ['aaa'] }, { characterId: 'bbb' })).toMatchObject({
      allowed: false,
      denial: 'character_not_allowed',
    });

    expect(evaluate({ allowedCharacterIds: ['aaa'] }, { characterId: 'aaa' }).allowed).toBe(true);
    // Empty means all, so an unset allowlist permits anything.
    expect(evaluate({ allowedCharacterIds: [] }, { characterId: 'bbb' }).allowed).toBe(true);
  });

  it('refuses a language the lock does not permit', () => {
    expect(evaluate({ languageLock: 'en' }, { language: 'ur' })).toMatchObject({
      allowed: false,
      denial: 'language_not_allowed',
    });
    expect(evaluate({ languageLock: 'en' }, { language: 'en' }).allowed).toBe(true);
  });

  it('reports the pause before anything else', () => {
    // Only the ORDER of reasons, which is what a parent sees first. Every rule
    // still refuses on its own.
    const result = evaluate({
      isPaused: true,
      allowedDays: [6, 7],
      secondsUsedToday: 100_000,
    });
    expect(result.denial).toBe('paused');
  });

  it('never tells a child that a parent blocked them', async () => {
    const { CHILD_FACING_MESSAGE } = await import('./parental-gate.js');

    for (const message of Object.values(CHILD_FACING_MESSAGE)) {
      // A child told "your parent blocked this" learns the rule is a person to
      // argue with, and it puts the companion in the middle of a family.
      expect(message.toLowerCase()).not.toMatch(/parent|mum|mom|dad|blocked|not allowed|limit/);
      expect(message.length).toBeGreaterThan(10);
    }
  });
});
