import { createRequestId } from '@kids/shared';
import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

declare module 'fastify' {
  interface FastifyRequest {
    /** Correlates every log line, every downstream call, and the error response. */
    requestId: string;
  }
}

/**
 * Request identity.
 *
 * A client-supplied `X-Request-Id` is honoured so a mobile app can correlate its
 * own retries, but it is bounded and sanitised first — it lands in log lines, and
 * an unbounded client-controlled string in a log aggregator is a log-injection
 * vector, not just a formatting problem.
 *
 * See docs/API_CONVENTIONS.md §3.
 */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;

const requestContextPlugin: FastifyPluginAsync = async (app) => {
  app.decorateRequest('requestId', '');

  app.addHook('onRequest', async (request, reply) => {
    const supplied = request.headers['x-request-id'];
    const candidate = Array.isArray(supplied) ? supplied[0] : supplied;

    // Decorating the request object is Fastify's supported extension mechanism;
    // `no-param-reassign` cannot distinguish it from an accidental mutation.
    // eslint-disable-next-line no-param-reassign
    request.requestId =
      candidate !== undefined && SAFE_REQUEST_ID.test(candidate) ? candidate : createRequestId();

    reply.header('x-request-id', request.requestId);
  });
};

export default fp(requestContextPlugin, { name: 'request-context' });
