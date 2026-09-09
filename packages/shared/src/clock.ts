import type { IsoTimestamp } from '@kids/types';

/**
 * Time is injected, never read from the ambient environment.
 *
 * Quotas, token expiry, retention sweeps, and session limits are all time
 * dependent, and a test that has to wait for real time to pass is a test nobody
 * runs. ESLint bans bare `new Date()` in application code to keep this honest.
 *
 * See docs/CODING_STANDARDS.md#42-dependency-injection-over-module-singletons.
 */
export interface Clock {
  /** Milliseconds since the Unix epoch. */
  now(): number;
  /** The same instant as an RFC 3339 UTC string. */
  nowIso(): IsoTimestamp;
}

/*
 * This module is the one legitimate place in the codebase that reads wall time.
 * The `no-restricted-syntax` rule below exists to push every *other* module
 * through this interface, so the disable is the rule working as intended rather
 * than an exception to it.
 */
/* eslint-disable no-restricted-syntax */
export const systemClock: Clock = {
  now: () => Date.now(),
  nowIso: () => new Date().toISOString() as IsoTimestamp,
};
/* eslint-enable no-restricted-syntax */

/** A clock frozen at a fixed instant, for deterministic tests. */
export const fixedClock = (epochMs: number): Clock => ({
  now: () => epochMs,
  nowIso: () => new Date(epochMs).toISOString() as IsoTimestamp,
});
