/**
 * @kids/config — the single place `process.env` is read.
 *
 * Contract (docs/ENVIRONMENT.md §1):
 *
 *   1. Every variable is declared in the schema here. A variable this package
 *      does not know about is not read by the application, anywhere.
 *   2. Validation runs once, at boot, and fails hard.
 *   3. No secret has a default.
 *   4. Cross-field rules are enforced — including that a production deploy
 *      cannot start with the safety classifiers disabled.
 */

export { APP_ENVS, NODE_ENVS, isDeployed, isProduction, usesMockProviders } from './app-env.js';
export type { AppEnv, NodeEnv } from './app-env.js';
export { envSchema } from './env.js';
export type { RawEnv, ValidatedEnv } from './env.js';
export { ConfigurationError, loadConfig, parseConfig, resetConfigForTesting } from './load.js';
export type { Config } from './load.js';
