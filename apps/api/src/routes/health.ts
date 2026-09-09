import type { Config } from '@kids/config';
import type { Database } from '@kids/db';
import { healthResponseSchema, readyResponseSchema } from '@kids/validation';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

import type { AlertMonitor } from '../alerts.js';
import { probeDatabase, probeRedis, type ProbeResult } from '../probes.js';

/**
 * Liveness, readiness, and version. See docs/API_CONVENTIONS.md §10.
 *
 * Every route declares a response schema, so Fastify serialises through it and
 * a field the schema does not name cannot be emitted.
 */
export const healthRoutes =
  (
    config: Config,
    dependencies: {
      readonly db?: Database;
      /**
       * Told whether the database answered.
       *
       * The `database` alert condition had no producer at all — nothing ever
       * called `reportDatabaseFailure`, so it could not fire. This probe is
       * already running on a schedule against the real connection, which makes
       * it the honest source of that signal rather than a second health check
       * invented to feed an alert.
       */
      readonly alerts?: Pick<AlertMonitor, 'reportDatabaseFailure' | 'reportDatabaseSuccess'>;
    } = {},
  ): FastifyPluginAsyncZod =>
  async (app) => {
    /**
     * Liveness. Deliberately touches no dependency.
     *
     * A liveness probe that fails on a slow database query restarts a healthy
     * process during exactly the incident where restarts hurt most.
     */
    app.get(
      '/health',
      {
        schema: {
          description: 'Liveness. Never touches a dependency.',
          response: { 200: healthResponseSchema },
        },
        config: { rateLimit: false },
      },
      async () => ({
        status: 'ok' as const,
        service: config.SERVICE_NAME,
        version: config.SERVICE_VERSION,
      }),
    );

    /** Readiness. Checks dependencies; drives load-balancer routing. */
    app.get(
      '/ready',
      {
        schema: {
          description: 'Readiness. Reports dependency reachability.',
          response: { 200: readyResponseSchema, 503: readyResponseSchema },
        },
        config: { rateLimit: false },
      },
      async (request, reply) => {
        /* Probed in parallel and each on its own deadline.
         *
         * Sequentially, a database timeout would delay the Redis answer and the
         * endpoint's own latency would become the sum of every dependency's
         * worst case — which is how a readiness endpoint ends up being the thing
         * that takes the load balancer down. */
        const [database, redis] = await Promise.all([
          dependencies.db === undefined
            ? Promise.resolve<ProbeResult>('skipped')
            : probeDatabase(dependencies.db, config.READINESS_PROBE_TIMEOUT_MS),
          probeRedis({
            url: config.REDIS_URL,
            tlsEnabled: config.REDIS_TLS_ENABLED,
            timeoutMs: config.READINESS_PROBE_TIMEOUT_MS,
          }),
        ]);

        const checks: Record<string, ProbeResult> = { database, redis };

        /* `skipped` is neither: it means no database is wired into this
         * instance, which is a configuration fact rather than an outage, and
         * reporting it either way would make the alert lie. */
        if (database === 'unavailable') {
          dependencies.alerts?.reportDatabaseFailure('the readiness probe could not reach it');
        } else if (database === 'ok') {
          dependencies.alerts?.reportDatabaseSuccess();
        }

        /* Only `unavailable` withdraws this instance from the pool.
         *
         * `skipped` must not: Redis is not wired into the request path yet, and
         * an unconfigured dependency taking the whole fleet out of rotation
         * would be a self-inflicted outage. What `skipped` buys is that nothing
         * here ever claims a check it did not run. */
        const degraded = Object.values(checks).some((value) => value === 'unavailable');

        if (degraded) {
          request.log.warn({ checks }, 'readiness degraded');
        }

        return await reply
          .status(degraded ? 503 : 200)
          .send({ status: degraded ? ('degraded' as const) : ('ready' as const), checks });
      },
    );

    app.get(
      '/v1/version',
      {
        schema: {
          description: 'Build version and environment.',
          response: {
            200: z.object({
              version: z.string(),
              service: z.string(),
              appEnv: z.string(),
            }),
          },
        },
      },
      async () => ({
        version: config.SERVICE_VERSION,
        service: config.SERVICE_NAME,
        appEnv: config.APP_ENV,
      }),
    );
  };
