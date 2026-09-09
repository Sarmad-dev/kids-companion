import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit, { type FastifyRateLimitStoreCtor } from '@fastify/rate-limit';
import type { Config } from '@kids/config';
import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

/**
 * Baseline hardening. See SECURITY.md §7.
 *
 * Registered at the root so it applies to every route, including ones added
 * later by someone who did not read this file.
 */
export interface SecurityOptions {
  readonly config: Config;
  /**
   * The shared counter store.
   *
   * Absent means count in this process, which is what local, CI and any
   * deployment without Redis do. See apps/api/src/rate-limit-store.ts for what
   * that costs and why it is still the right fallback.
   */
  readonly rateLimitStore?: FastifyRateLimitStoreCtor | undefined;
}

const securityPlugin: FastifyPluginAsync<SecurityOptions> = async (app, opts) => {
  const { config } = opts;

  await app.register(helmet, {
    // The API serves JSON, never HTML, so the strictest CSP is free here.
    contentSecurityPolicy: {
      directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
    },
    hsts: { maxAge: 63_072_000, includeSubDomains: true, preload: true },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    // helmet defaults to SAMEORIGIN. Nothing here should ever be framed, and
    // SECURITY.md §7 specifies DENY — an integration test asserts this.
    frameguard: { action: 'deny' },
  });

  // An explicit allowlist. No wildcard and no origin reflection — the config
  // schema additionally rejects a wildcard in any deployed environment.
  await app.register(cors, {
    origin: config.CORS_ALLOWED_ORIGINS,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    maxAge: 86_400,
  });

  await app.register(rateLimit, {
    global: true,
    max: config.RATE_LIMIT_GLOBAL_PER_MINUTE,
    timeWindow: '1 minute',
    /* Counted in Redis when one is configured, so N instances enforce ONE
     * limit rather than N of them. Without it every limit — including the auth
     * one that makes password guessing impractical — was multiplied by the
     * instance count. */
    ...(opts.rateLimitStore ? { store: opts.rateLimitStore } : {}),
    keyGenerator: (request) => request.ip,
    addHeaders: {
      'x-ratelimit-limit': true,
      'x-ratelimit-remaining': true,
      'x-ratelimit-reset': true,
      'retry-after': true,
    },
  });
};

export default fp(securityPlugin, { name: 'security' });
