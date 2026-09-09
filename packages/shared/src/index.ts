/**
 * @kids/shared — cross-cutting primitives with no domain logic.
 *
 * What lives here is everything that must behave identically everywhere: the
 * error taxonomy, the redacting logger, deterministic time, and ID generation.
 */

export * from './result.js';
export * from './clock.js';
export * from './errors.js';
export * from './ids.js';
export * from './logger.js';
export * from './redaction.js';
export * from './resilience.js';
