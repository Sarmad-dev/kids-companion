/**
 * Timeouts, retries, and circuit breaking.
 *
 * Lives here rather than beside one adapter because it is not about any one
 * vendor: the AI provider, the STT provider, and the TTS provider all need the
 * same primitives with the same semantics, and three copies of a retry budget
 * is three places for the budget to drift.
 *
 * The original below.
 */
/**
 * Timeouts, retries, and circuit breaking.
 *
 * The governing constraint is the voice-loop latency budget: p50 ≤ 1.8 s to the
 * first audio byte (ARCHITECTURE.md §7.1). Everything here is shaped by it —
 * most importantly, retries operate on a BUDGET rather than a count.
 *
 * Three dutiful retries that deliver an answer nine seconds later is a worse
 * outcome than failing fast into a graceful exit, because the child has already
 * walked away (docs/ERROR_HANDLING.md §7).
 */

// Fields are assigned explicitly rather than via constructor parameter
// properties: `erasableSyntaxOnly` bans those, so that Node's native type
// stripping works without a compile step (docs/CODING_STANDARDS.md §1.1).
export class ProviderTimeoutError extends Error {
  override readonly name = 'ProviderTimeoutError';
  readonly operation: string;
  readonly timeoutMs: number;

  constructor(operation: string, timeoutMs: number) {
    super(`${operation} timed out after ${String(timeoutMs)}ms`);
    this.operation = operation;
    this.timeoutMs = timeoutMs;
  }
}

export class ProviderUnavailableError extends Error {
  override readonly name = 'ProviderUnavailableError';
  readonly operation: string;

  constructor(operation: string, cause?: unknown) {
    super(`${operation} is unavailable`, cause === undefined ? undefined : { cause });
    this.operation = operation;
  }
}

export class CircuitOpenError extends Error {
  override readonly name = 'CircuitOpenError';
  readonly operation: string;

  constructor(operation: string) {
    super(`circuit is open for ${operation}`);
    this.operation = operation;
  }
}

/**
 * Races a promise against a timer.
 *
 * `AbortSignal.timeout` handles the fetch itself; this bounds the whole
 * operation including any parsing or retry bookkeeping, so a slow-but-not-dead
 * provider cannot quietly consume the entire budget.
 */
export const withTimeout = async <T>(
  operation: string,
  timeoutMs: number,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> => {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    return await Promise.race([
      fn(controller.signal),
      new Promise<never>((_, reject) => {
        controller.signal.addEventListener(
          'abort',
          () => {
            reject(new ProviderTimeoutError(operation, timeoutMs));
          },
          { once: true },
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

export interface RetryOptions {
  readonly maxAttempts: number;
  /** Total wall-clock budget. A retry that would exceed it is not attempted. */
  readonly budgetMs: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  /** Injected so tests are deterministic and do not depend on chance. */
  readonly random?: () => number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export const DEFAULT_RETRY: RetryOptions = Object.freeze({
  maxAttempts: 3,
  budgetMs: 12_000,
  baseDelayMs: 200,
  maxDelayMs: 2_000,
});

/** Only these are worth retrying. A 4xx that is not a 429 will not change. */
export const isRetryable = (error: unknown): boolean => {
  if (error instanceof ProviderTimeoutError) return true;
  if (error instanceof ProviderUnavailableError) return true;
  if (error instanceof CircuitOpenError) return false;

  const status = (error as { status?: unknown }).status;
  if (typeof status === 'number') return status === 429 || status >= 500;

  const code = (error as { code?: unknown }).code;
  return code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'ECONNREFUSED';
};

/**
 * Exponential backoff with FULL jitter.
 *
 * Without jitter, every client that failed together retries together and knocks
 * the recovering provider over again — the thundering herd that turns a blip
 * into an outage.
 */
export const backoffDelay = (
  attempt: number,
  options: Pick<RetryOptions, 'baseDelayMs' | 'maxDelayMs'> & { random?: () => number },
): number => {
  const exponential = Math.min(options.baseDelayMs * 2 ** (attempt - 1), options.maxDelayMs);
  // Jitter spreads retries; it is not a secret and does not need to be
  // unpredictable to an attacker. The lint rule guards token and ID generation,
  // which is why this is exempted here and nowhere else.
  // eslint-disable-next-line no-restricted-properties
  const random = options.random ?? Math.random;
  return Math.floor(random() * exponential);
};

export const withRetry = async <T>(
  operation: string,
  fn: () => Promise<T>,
  options: RetryOptions = DEFAULT_RETRY,
): Promise<T> => {
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }));

  const startedAt = now();
  let lastError: unknown;

  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt === options.maxAttempts) break;

      const delay = backoffDelay(attempt, options);
      // The budget check is the point: if the delay plus another attempt would
      // blow the latency budget, stop now and let the caller degrade.
      if (now() - startedAt + delay >= options.budgetMs) break;

      await sleep(delay);
    }
  }

  throw lastError instanceof Error ? lastError : new ProviderUnavailableError(operation, lastError);
};

/* -------------------------------------------------------------------------- */
/* Circuit breaker                                                             */
/* -------------------------------------------------------------------------- */

export type CircuitState = 'closed' | 'open' | 'half_open';

export interface CircuitBreakerOptions {
  readonly failureThreshold: number;
  readonly cooldownMs: number;
  readonly now?: () => number;
}

export interface CircuitBreaker {
  readonly state: () => CircuitState;
  execute<T>(operation: string, fn: () => Promise<T>): Promise<T>;
}

/**
 * A hard-down provider should cost ONE fast failure per cooldown, not a full
 * timeout on every request while children wait. State changes are worth
 * alerting on — an open breaker is the earliest signal of a vendor incident.
 */
export const createCircuitBreaker = (
  options: CircuitBreakerOptions,
  onStateChange?: (from: CircuitState, to: CircuitState) => void,
): CircuitBreaker => {
  const now = options.now ?? Date.now;
  let state: CircuitState = 'closed';
  let failures = 0;
  let openedAt = 0;

  const transition = (next: CircuitState): void => {
    if (state === next) return;
    const previous = state;
    state = next;
    onStateChange?.(previous, next);
  };

  return {
    state: () => state,

    execute: async (operation, fn) => {
      if (state === 'open') {
        if (now() - openedAt < options.cooldownMs) throw new CircuitOpenError(operation);
        transition('half_open');
      }

      try {
        const result = await fn();
        failures = 0;
        transition('closed');
        return result;
      } catch (error) {
        // Only provider health counts toward the breaker. A validation error is
        // our bug, and tripping the breaker on it would take the provider down
        // for everyone because of one malformed request.
        if (isRetryable(error)) {
          failures += 1;
          if (state === 'half_open' || failures >= options.failureThreshold) {
            openedAt = now();
            transition('open');
          }
        }
        throw error;
      }
    },
  };
};
