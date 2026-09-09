import {
  createProcessSampler,
  registerTechnicalMetrics,
  TECHNICAL_METRICS,
  type MetricsRegistry,
} from '@kids/analytics';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';

/**
 * Request metrics.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE ROUTE LABEL IS THE PATTERN, NEVER THE URL.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `/api/conversations/:conversationId`, not
 * `/api/conversations/9f2c4a1e-0d3b-4c5e-8a7f-1b2c3d4e5f60`.
 *
 * Two things go wrong with the URL. It puts a conversation identifier into a
 * time-series database that may not be ours, and it creates one series per
 * conversation — a cardinality explosion that takes the metrics backend down
 * long before anybody notices the privacy problem.
 *
 * Fastify exposes the matched pattern as `request.routeOptions.url`, so the
 * safe value is the one that is easiest to reach. Where no route matched (a
 * 404), the label is the literal string `unmatched` rather than whatever the
 * caller sent — an unrouted URL is attacker-controlled input, and attaching it
 * to a metric is how somebody writes into our dashboards.
 */

declare module 'fastify' {
  interface FastifyInstance {
    metrics: MetricsRegistry;
  }
  interface FastifyRequest {
    metricsStartedAt: number;
  }
}

export interface MetricsPluginOptions {
  readonly registry: MetricsRegistry;
  /** Milliseconds since an arbitrary epoch. Injected so timing is testable. */
  readonly nowMs: () => number;
  readonly sampleIntervalMs?: number;
}

/** The status class, not the status. `2xx` is a dimension; `200` is nearly one. */
const statusClass = (status: number): string => `${String(Math.floor(status / 100))}xx`;

const routeLabel = (request: FastifyRequest): string => {
  const pattern = request.routeOptions.url;
  return typeof pattern === 'string' && pattern !== '' ? pattern : 'unmatched';
};

const metricsPlugin: FastifyPluginAsync<MetricsPluginOptions> = async (app, options) => {
  const { registry, nowMs } = options;

  registerTechnicalMetrics(registry);
  app.decorate('metrics', registry);
  app.decorateRequest('metricsStartedAt', 0);

  let inflight = 0;

  app.addHook('onRequest', (request: FastifyRequest, _reply: FastifyReply, done) => {
    // Assigning to a decorated request property is Fastify's own idiom for
    // per-request state, and is what `decorateRequest` above exists for.
    // eslint-disable-next-line no-param-reassign
    request.metricsStartedAt = nowMs();
    inflight += 1;
    registry.set(TECHNICAL_METRICS.inflight, inflight);
    done();
  });

  app.addHook('onResponse', (request: FastifyRequest, reply: FastifyReply, done) => {
    inflight = Math.max(0, inflight - 1);
    registry.set(TECHNICAL_METRICS.inflight, inflight);

    const route = routeLabel(request);
    const method = request.method;
    const status = statusClass(reply.statusCode);

    registry.observe(TECHNICAL_METRICS.requestDuration, nowMs() - request.metricsStartedAt, {
      route,
      method,
    });
    registry.increment(TECHNICAL_METRICS.requestsTotal, { route, method, status });

    // 5xx only. A 4xx is a client being told no, which is the system working;
    // counting it as an error makes the error rate a measure of how many people
    // typed the wrong password.
    if (reply.statusCode >= 500) {
      registry.increment(TECHNICAL_METRICS.errorsTotal, { route, method, status });
    }

    done();
  });

  /* Process sampling. Unref'd so it never holds the process open at shutdown —
   * a metrics timer keeping a container alive is a deploy that hangs. */
  const sampler = createProcessSampler(registry, {
    cpuUsage: (previous) => process.cpuUsage(previous),
    memoryUsage: () => process.memoryUsage(),
    uptime: () => process.uptime(),
    hrtimeMs: () => Number(process.hrtime.bigint() / 1_000_000n),
  });

  sampler.sample();
  // Unref'd so a metrics timer never holds the process open at shutdown — that
  // turns a routine deploy into one that hangs.
  const timer = setInterval(() => {
    sampler.sample();
  }, options.sampleIntervalMs ?? 15_000);
  timer.unref();

  app.addHook('onClose', (_instance, done) => {
    clearInterval(timer);
    done();
  });
};

export default fp(metricsPlugin, { name: 'metrics' });
