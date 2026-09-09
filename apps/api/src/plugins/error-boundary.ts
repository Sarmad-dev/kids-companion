import {
  clientFault,
  rateLimited,
  redactObject,
  toAppError,
  validationFailed,
  type ValidationDetail,
} from '@kids/shared';
import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

import type { ErrorTracker } from '../error-tracking.js';

/**
 * The single error boundary. See docs/ERROR_HANDLING.md §11.
 *
 * Handlers never format errors themselves. One place, one shape — which is what
 * makes "never leak internals" auditable rather than aspirational.
 */
/**
 * The plugin types `params.issue` as `unknown`, so narrow it here rather than
 * asserting — a malformed issue must not crash the error handler itself.
 */
interface ZodIssueShape {
  readonly path: readonly (string | number | symbol)[];
  readonly message: string;
}

const isZodIssueShape = (value: unknown): value is ZodIssueShape =>
  typeof value === 'object' &&
  value !== null &&
  Array.isArray((value as { path?: unknown }).path) &&
  typeof (value as { message?: unknown }).message === 'string';

interface FastifyValidationEntry {
  readonly instancePath?: string;
  readonly message?: string;
  readonly params?: { readonly issue?: unknown };
}

/**
 * Extracts field-level detail from a schema rejection.
 *
 * Handles BOTH shapes, because relying on the type provider's own predicate
 * silently mislabelled every schema rejection as an internal error — a malformed
 * request body returned 500 instead of 400, for months, because no test had
 * exercised a schema-level rejection rather than a hand-thrown one.
 *
 * So the detection is now the presence of `error.validation`, which is Fastify's
 * own contract and does not depend on a plugin's helper agreeing with us.
 */
const validationDetailsOf = (error: unknown): ValidationDetail[] => {
  const entries = (error as { validation?: unknown }).validation;
  if (!Array.isArray(entries)) return [];

  return (entries as FastifyValidationEntry[]).map((entry) => {
    const issue: unknown = entry.params?.issue;

    if (isZodIssueShape(issue)) {
      return {
        field: issue.path.map((p) => String(p)).join('.') || '(body)',
        issue: issue.message,
      };
    }

    // Fastify's standard shape: `instancePath` like "/birthYear".
    return {
      field: (entry.instancePath ?? '').replace(/^\//, '').replace(/\//g, '.') || '(body)',
      issue: entry.message ?? 'is invalid',
    };
  });
};

/** Reads back the `retry-after` the limiter already set, so the body agrees with the header. */
const retryAfterSecondsOf = (reply: {
  getHeader: (name: string) => unknown;
}): number | undefined => {
  const header = reply.getHeader('retry-after');
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
};

export interface ErrorBoundaryOptions {
  /**
   * Aggregates errors for the operator console and, if configured, forwards
   * them. Optional so a harness need not supply one.
   */
  readonly tracker?: ErrorTracker;
}

const errorBoundaryPlugin: FastifyPluginAsync<ErrorBoundaryOptions> = async (app, options) => {
  app.setErrorHandler((error, request, reply) => {
    // The presence of `error.validation` is what makes it a schema rejection —
    // not whether the details could be extracted from it. Gating on the details
    // being non-empty is what turned malformed request bodies into 500s: the
    // predicate matched, the per-entry shape did not, and an empty detail list
    // fell through to "internal error".
    const isSchemaRejection = Array.isArray((error as { validation?: unknown }).validation);
    const details: ValidationDetail[] = isSchemaRejection ? validationDetailsOf(error) : [];

    // @fastify/rate-limit throws rather than replying, and an unrecognised throw
    // becomes INTERNAL_ERROR — which turned every limiter rejection into a 500
    // that told the client to retry harder. Recognised explicitly here so the
    // limiter produces the same envelope as everything else.
    const status = (error as { statusCode?: unknown }).statusCode;
    const fastifyCode = (error as { code?: unknown }).code;
    const isRateLimitRejection = status === 429 || fastifyCode === 'FST_ERR_RATE_LIMIT';

    /* The content-type parser family: a body that is not JSON, is the wrong
     * media type, is empty, or is too large.
     *
     * These carry a 4xx status and no `validation` array, so they used to fall
     * through to INTERNAL_ERROR — blaming us for the caller's mistake, logging
     * at `error`, and counting toward the 5xx rate that ALERTING WATCHES. A
     * client posting broken JSON in a loop could page somebody. */
    const isMalformedBody =
      typeof fastifyCode === 'string' && fastifyCode.startsWith('FST_ERR_CTP_');

    const appError = isSchemaRejection
      ? validationFailed(details, error)
      : isRateLimitRejection
        ? rateLimited(retryAfterSecondsOf(reply))
        : isMalformedBody
          ? clientFault(
              typeof status === 'number' ? status : 400,
              // The Fastify code, not its message: the message can quote the
              // offending bytes back, and those came from an untrusted caller.
              String(fastifyCode),
              error,
            )
          : toAppError(error);

    // Context is developer-authored and therefore the most likely place for a
    // sensitive field to be added without thinking. Redact before it reaches a log.
    const logPayload = {
      err: appError,
      requestId: request.requestId,
      errorCode: appError.code,
      errorCategory: appError.category,
      context: redactObject(appError.context),
      method: request.method,
      route: request.routeOptions.url ?? request.url,
    };

    app.log[appError.logLevel](logPayload, 'request failed');

    /* ═══════════════════════════════════════════════════════════════════════
     * THE CAPTURE POINT, AND ONLY 5xx.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * A 400 is a caller mistake, a 429 is a limit doing its job, a 404 is a
     * client asking for something that is not there. None of them is a bug in
     * this application, and a tracker full of them is one nobody reads.
     *
     * Note what is handed over: the error, its classification, the route
     * PATTERN and the method. Not the request, not its body, not its query,
     * not its headers, not the child. See apps/api/src/error-tracking.ts for
     * why that list is written out by hand rather than delegated to an SDK.
     */
    if (appError.httpStatus >= 500) {
      options.tracker?.capture({
        error,
        code: appError.code,
        category: appError.category,
        httpStatus: appError.httpStatus,
        route: request.routeOptions.url ?? 'unmatched',
        method: request.method,
      });
    }

    void reply.status(appError.httpStatus).send(appError.toClientBody(request.requestId));
  });

  app.setNotFoundHandler((request, reply) => {
    void reply.status(404).send({
      error: {
        code: 'RESOURCE_NOT_FOUND',
        message: 'Not found.',
        requestId: request.requestId,
      },
    });
  });
};

export default fp(errorBoundaryPlugin, { name: 'error-boundary' });
