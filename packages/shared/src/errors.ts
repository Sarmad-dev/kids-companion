/**
 * The error taxonomy. See docs/ERROR_HANDLING.md.
 *
 * Every failure carries a stable code, a category, an HTTP status, and a
 * retryability flag. The internal representation and the client-safe projection
 * are kept apart deliberately — most error-handling bugs in production systems
 * are one leaking into the other.
 */

export const ERROR_CATEGORIES = [
  'validation',
  'authentication',
  'authorization',
  'not_found',
  'conflict',
  'quota',
  'safety',
  'provider',
  'internal',
] as const;
export type ErrorCategory = (typeof ERROR_CATEGORIES)[number];

export const APP_ERROR_CODES = [
  'VALIDATION_FAILED',
  'AUTH_INVALID_CREDENTIALS',
  'AUTH_TOKEN_EXPIRED',
  'AUTH_REFRESH_REUSE_DETECTED',
  'AUTHZ_FORBIDDEN',
  'RESOURCE_NOT_FOUND',
  'CONFLICT_EMAIL_IN_USE',
  'QUOTA_DAILY_MINUTES_EXHAUSTED',
  'QUOTA_DAILY_TURNS_EXHAUSTED',
  'QUOTA_CONVERSATION_LENGTH',
  'QUOTA_CONCURRENT_CONVERSATIONS',
  'QUOTA_CHILD_PROFILE_LIMIT',
  'QUOTA_WEEKLY_STORIES_EXHAUSTED',
  'SUBSCRIPTION_REQUIRED',
  'RATE_LIMITED',
  'SAFETY_INPUT_BLOCKED',
  'SAFETY_OUTPUT_BLOCKED',
  'SAFETY_CLASSIFIER_UNAVAILABLE',
  'PROVIDER_TIMEOUT',
  'PROVIDER_RATE_LIMITED',
  'PROVIDER_UNAVAILABLE',
  'INTERNAL_ERROR',
] as const;
export type AppErrorCode = (typeof APP_ERROR_CODES)[number];

/** Log level per category. `authorization` is `warn` because it carries the security signal. */
export const CATEGORY_LOG_LEVEL: Readonly<
  Record<ErrorCategory, 'debug' | 'info' | 'warn' | 'error'>
> = Object.freeze({
  validation: 'debug',
  authentication: 'info',
  authorization: 'warn',
  not_found: 'debug',
  conflict: 'info',
  quota: 'info',
  safety: 'warn',
  provider: 'error',
  internal: 'error',
});

export interface ValidationDetail {
  readonly field: string;
  readonly issue: string;
}

export interface AppErrorOptions {
  readonly code: AppErrorCode;
  readonly category: ErrorCategory;
  readonly httpStatus: number;
  /** A safe, human-readable message. Never contains internal detail or personal data. */
  readonly message: string;
  readonly isRetryable?: boolean;
  /** Structured context for logs. Must never contain transcript text or child identifiers. */
  readonly context?: Readonly<Record<string, unknown>>;
  /**
   * Context that is DELIBERATELY client-visible.
   *
   * Separate from `context` so that exposure is a decision someone made, not a
   * default. `context` is developer-authored and log-only; anything here has
   * been chosen for a client to read — a parent's own quota numbers, a retry
   * delay. Nothing internal belongs in it.
   */
  readonly clientContext?: Readonly<Record<string, unknown>>;
  readonly details?: readonly ValidationDetail[];
  readonly cause?: unknown;
}

/** The client-safe projection. This is the only shape that crosses the boundary. */
export interface ClientErrorBody {
  readonly error: {
    readonly code: AppErrorCode;
    readonly message: string;
    readonly requestId: string;
    readonly details?: readonly ValidationDetail[];
    /** Explicitly client-visible facts — quota numbers, retry delays. */
    readonly meta?: Readonly<Record<string, unknown>>;
  };
}

export class AppError extends Error {
  override readonly name = 'AppError';
  readonly code: AppErrorCode;
  readonly category: ErrorCategory;
  readonly httpStatus: number;
  readonly isRetryable: boolean;
  readonly context: Readonly<Record<string, unknown>>;
  readonly clientContext?: Readonly<Record<string, unknown>>;
  readonly details?: readonly ValidationDetail[];

  constructor(options: AppErrorOptions) {
    super(options.message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = options.code;
    this.category = options.category;
    this.httpStatus = options.httpStatus;
    this.isRetryable = options.isRetryable ?? false;
    this.context = Object.freeze({ ...options.context });
    if (options.clientContext) this.clientContext = Object.freeze({ ...options.clientContext });
    if (options.details) this.details = options.details;
  }

  get logLevel(): 'debug' | 'info' | 'warn' | 'error' {
    return CATEGORY_LOG_LEVEL[this.category];
  }

  /**
   * The only representation permitted to reach a client.
   *
   * Note what is absent: stack, cause chain, context, category, and the internal
   * message if it ever differed. Building this explicitly — rather than filtering
   * a serialised error — is what makes "never leak internals" auditable.
   */
  toClientBody(requestId: string): ClientErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        requestId,
        ...(this.details ? { details: this.details } : {}),
        ...(this.clientContext ? { meta: this.clientContext } : {}),
      },
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Constructors for the common cases                                           */
/* -------------------------------------------------------------------------- */

export const validationFailed = (details: readonly ValidationDetail[], cause?: unknown): AppError =>
  new AppError({
    code: 'VALIDATION_FAILED',
    category: 'validation',
    httpStatus: 400,
    message: 'The request could not be processed.',
    details,
    cause,
  });

/**
 * Not found, and "not yours".
 *
 * A 403 would confirm the resource exists. The resources here are children, so
 * confirming existence to an unauthorised caller is itself a disclosure — parent
 * A asking for parent B's child gets a 404. See docs/API_CONVENTIONS.md §4.3.
 */
/**
 * The caller is at fault, and the framework already said so.
 *
 * Fastify throws for a malformed body, an unsupported media type, an empty
 * body, and an oversized one — all with a 4xx `statusCode` and none with a
 * `validation` array. Without this they fall through to INTERNAL_ERROR, which
 * blames us for the caller's mistake, logs at `error`, and counts toward the
 * 5xx rate that alerting watches.
 *
 * The status is preserved rather than flattened to 400: 413 and 415 tell a
 * client something 400 does not.
 */
export const clientFault = (httpStatus: number, reason: string, cause?: unknown): AppError =>
  new AppError({
    code: 'VALIDATION_FAILED',
    category: 'validation',
    // Clamped to the 4xx range. A thrown error's own status is only trusted as
    // far as "the caller is at fault"; anything else becomes a plain 400.
    httpStatus: httpStatus >= 400 && httpStatus < 500 ? httpStatus : 400,
    message: 'That request could not be read.',
    context: { reason },
    clientContext: { reason },
    cause,
  });

export const notFound = (): AppError =>
  new AppError({
    code: 'RESOURCE_NOT_FOUND',
    category: 'not_found',
    httpStatus: 404,
    message: 'Not found.',
  });

/**
 * No usable credential.
 *
 * One code for every cause — expired, malformed, wrong signature, revoked
 * session. Distinguishing them for the client tells someone probing exactly
 * which part of their forgery to fix.
 */
export const unauthenticated = (
  code: Extract<
    AppErrorCode,
    'AUTH_INVALID_CREDENTIALS' | 'AUTH_TOKEN_EXPIRED' | 'AUTH_REFRESH_REUSE_DETECTED'
  > = 'AUTH_TOKEN_EXPIRED',
  context?: Readonly<Record<string, unknown>>,
): AppError =>
  new AppError({
    code,
    category: 'authentication',
    httpStatus: 401,
    message: 'Authentication required.',
    ...(context ? { context } : {}),
  });

export const forbidden = (context?: Readonly<Record<string, unknown>>): AppError =>
  new AppError({
    code: 'AUTHZ_FORBIDDEN',
    category: 'authorization',
    httpStatus: 403,
    message: 'Not permitted.',
    ...(context ? { context } : {}),
  });

/**
 * A plan limit was reached.
 *
 * 429, not 403. The caller is permitted; they have used their allowance, and
 * the distinction matters to a client deciding whether to show "upgrade" or
 * "come back tomorrow". `resetsAt` is included so it can say which.
 *
 * The context carries the limit and what was used. That is the parent’s own
 * number and telling them is the point — being cut off with no explanation is
 * the thing that generates support tickets.
 */
export const rateLimited = (retryAfterSeconds?: number): AppError =>
  new AppError({
    code: 'RATE_LIMITED',
    category: 'quota',
    httpStatus: 429,
    message: 'Too many requests.',
    isRetryable: true,
    ...(retryAfterSeconds === undefined ? {} : { clientContext: { retryAfterSeconds } }),
  });

export const quotaExhausted = (
  code: Extract<
    AppErrorCode,
    | 'QUOTA_DAILY_MINUTES_EXHAUSTED'
    | 'QUOTA_DAILY_TURNS_EXHAUSTED'
    | 'QUOTA_CONVERSATION_LENGTH'
    | 'QUOTA_CONCURRENT_CONVERSATIONS'
    | 'QUOTA_CHILD_PROFILE_LIMIT'
    | 'QUOTA_WEEKLY_STORIES_EXHAUSTED'
  >,
  context: Readonly<Record<string, unknown>>,
): AppError =>
  new AppError({
    code,
    category: 'quota',
    httpStatus: 429,
    message: 'This limit has been reached.',
    context,
    // A parent's own allowance is not an internal. Telling them what the limit
    // is and when it resets is the difference between an app that explains
    // itself and one that just says no.
    clientContext: context,
  });

/**
 * The plan does not include this, at any usage level.
 *
 * Separate from `quotaExhausted` because the remedy is different: waiting does
 * not help, and a client should say so rather than showing a countdown.
 */
export const subscriptionRequired = (context: Readonly<Record<string, unknown>>): AppError =>
  new AppError({
    code: 'SUBSCRIPTION_REQUIRED',
    category: 'quota',
    httpStatus: 402,
    message: 'This requires a different plan.',
    context,
    clientContext: context,
  });

export const providerTimeout = (provider: string, operation: string, cause?: unknown): AppError =>
  new AppError({
    code: 'PROVIDER_TIMEOUT',
    category: 'provider',
    httpStatus: 503,
    message: 'A dependency did not respond in time.',
    isRetryable: true,
    context: { provider, operation },
    cause,
  });

/**
 * A safety layer stopped the turn.
 *
 * Status 200: a blocked turn is a successful request with a blocked outcome.
 * A 4xx would make safety blocks indistinguishable from client bugs in every
 * dashboard, and would push clients toward retrying them.
 */
export const safetyBlocked = (
  code: Extract<AppErrorCode, 'SAFETY_INPUT_BLOCKED' | 'SAFETY_OUTPUT_BLOCKED'>,
  layer: string,
): AppError =>
  new AppError({
    code,
    category: 'safety',
    httpStatus: 200,
    message: 'This turn was not delivered.',
    context: { layer },
  });

export const internalError = (cause?: unknown): AppError =>
  new AppError({
    code: 'INTERNAL_ERROR',
    category: 'internal',
    httpStatus: 500,
    message: 'Something went wrong.',
    cause,
  });

/**
 * Normalise anything thrown into an `AppError`.
 *
 * An unrecognised throw becomes `INTERNAL_ERROR` with the original preserved as
 * `cause`, so the error boundary has exactly one type to handle.
 */
export const toAppError = (thrown: unknown): AppError =>
  thrown instanceof AppError ? thrown : internalError(thrown);
