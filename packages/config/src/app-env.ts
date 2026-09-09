import { z } from 'zod';

/**
 * `APP_ENV` and `NODE_ENV` are deliberately separate.
 *
 * `NODE_ENV` has three meaningful values and is consumed by frameworks — it
 * decides whether React ships dev warnings, whether Fastify enables dev niceties.
 *
 * `APP_ENV` is ours. It decides which secrets are loaded, which safety thresholds
 * apply, whether analytics is live, and which validation rules are enforced.
 *
 * Conflating them means either staging behaves unlike production (because it runs
 * `NODE_ENV=development`) or staging writes to production analytics (because it
 * runs `NODE_ENV=production` and nothing else distinguishes it).
 *
 * See docs/ENVIRONMENT.md §1.2.
 */
export const APP_ENVS = ['local', 'ci', 'development', 'staging', 'production'] as const;
export type AppEnv = (typeof APP_ENVS)[number];

export const appEnvSchema = z.enum(APP_ENVS);

export const NODE_ENVS = ['development', 'test', 'production'] as const;
export type NodeEnv = (typeof NODE_ENVS)[number];

export const nodeEnvSchema = z.enum(NODE_ENVS);

/**
 * Environments that run against real infrastructure and real (or real-shaped)
 * credentials. The strict cross-field rules in `env.ts` apply to these.
 */
const DEPLOYED: readonly AppEnv[] = ['development', 'staging', 'production'];

export const isDeployed = (env: AppEnv): boolean => DEPLOYED.includes(env);

/**
 * `production` is the only environment holding real child data. Several rules
 * tighten here and nowhere else — see `env.ts`.
 */
export const isProduction = (env: AppEnv): boolean => env === 'production';

/** `local` and `ci` default every external provider to a mock. */
export const usesMockProviders = (env: AppEnv): boolean => env === 'local' || env === 'ci';
