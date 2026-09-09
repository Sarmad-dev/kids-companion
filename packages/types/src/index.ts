/**
 * @kids/types — the innermost dependency ring.
 *
 * Types only, with zero runtime imports, so React Native, the Fastify API, and
 * the web dashboard can all share one domain vocabulary without dragging
 * platform-specific code across a boundary. Enforced by ESLint, not convention.
 */

export type * from './ids.js';
export type * from './database.generated.js';
export * from './domain.js';
