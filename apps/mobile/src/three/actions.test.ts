import { describe, expect, it } from 'vitest';

import {
  ACTION_SECONDS,
  actionPose,
  CHARACTER_ACTIONS,
  REST_POSE,
  talkingMsFor,
  type ActionPose,
} from './actions';

const MAGNITUDE_LIMIT = 6.4; // a full spin is 2π; nothing else comes close

const numbers = (pose: ActionPose): number[] =>
  Object.values({ ...pose } as Record<string, number>);

describe('actionPose', () => {
  it.each(CHARACTER_ACTIONS)('%s starts and ends at rest', (action) => {
    expect(actionPose(action, 0)).toEqual(REST_POSE);
    expect(actionPose(action, 1)).toEqual(REST_POSE);
    expect(actionPose(action, -3)).toEqual(REST_POSE);
    expect(actionPose(action, 7)).toEqual(REST_POSE);
  });

  it.each(CHARACTER_ACTIONS)('%s stays finite and bounded throughout', (action) => {
    for (let i = 1; i < 100; i += 1) {
      for (const value of numbers(actionPose(action, i / 100))) {
        expect(Number.isFinite(value)).toBe(true);
        expect(Math.abs(value)).toBeLessThan(MAGNITUDE_LIMIT);
      }
    }
  });

  it.each(CHARACTER_ACTIONS)('%s never shrinks the character out of existence', (action) => {
    for (let i = 0; i <= 100; i += 1) {
      expect(actionPose(action, i / 100).rootScale).toBeGreaterThan(0.4);
    }
  });

  it('jump only ever lifts the character', () => {
    for (let i = 0; i <= 100; i += 1) {
      expect(actionPose('jump', i / 100).rootY).toBeGreaterThanOrEqual(0);
    }
  });

  it('spin turns exactly once', () => {
    const almostDone = actionPose('spin', 0.999).rootRotY;
    expect(almostDone).toBeGreaterThan(Math.PI * 1.9);
    expect(almostDone).toBeLessThanOrEqual(Math.PI * 2);
  });

  it('gives every action a positive duration', () => {
    for (const action of CHARACTER_ACTIONS) expect(ACTION_SECONDS[action]).toBeGreaterThan(0);
  });
});

describe('talkingMsFor', () => {
  it('floors a very short reply so the mouth still visibly moves', () => {
    expect(talkingMsFor('Hi!')).toBe(1_200);
  });

  it('scales with length', () => {
    expect(talkingMsFor('x'.repeat(50))).toBe(3_000);
  });

  it('caps a long story so the character does not talk on after the caption', () => {
    expect(talkingMsFor('x'.repeat(5_000))).toBe(6_000);
  });
});
