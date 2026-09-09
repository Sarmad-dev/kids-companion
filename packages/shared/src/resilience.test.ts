import { describe, expect, it, vi } from 'vitest';

import {
  backoffDelay,
  CircuitOpenError,
  createCircuitBreaker,
  isRetryable,
  ProviderTimeoutError,
  ProviderUnavailableError,
  withRetry,
  withTimeout,
} from './resilience.js';

/** No real waiting — a suite that sleeps is a suite nobody runs. */
const instant = { sleep: async () => Promise.resolve(), random: () => 0.5 };

describe('timeouts', () => {
  it('rejects when the operation outlasts the budget', async () => {
    await expect(
      withTimeout('slow', 20, async () => new Promise((resolve) => setTimeout(resolve, 500))),
    ).rejects.toThrow(ProviderTimeoutError);
  });

  it('resolves when the operation finishes in time', async () => {
    await expect(withTimeout('fast', 500, async () => 'done')).resolves.toBe('done');
  });

  it('signals the abort so the underlying request is actually cancelled', async () => {
    // Without this, a timeout only stops us waiting — the request keeps running
    // and keeps costing money.
    let aborted = false;

    await expect(
      withTimeout('aborting', 20, async (signal) => {
        signal.addEventListener('abort', () => {
          aborted = true;
        });
        return new Promise((resolve) => setTimeout(resolve, 500));
      }),
    ).rejects.toThrow(ProviderTimeoutError);

    expect(aborted).toBe(true);
  });
});

describe('what is worth retrying', () => {
  it.each([
    [new ProviderTimeoutError('op', 100)],
    [new ProviderUnavailableError('op')],
    [Object.assign(new Error('rate limited'), { status: 429 })],
    [Object.assign(new Error('bad gateway'), { status: 502 })],
    [Object.assign(new Error('reset'), { code: 'ECONNRESET' })],
  ])('retries %s', (error) => {
    expect(isRetryable(error)).toBe(true);
  });

  it.each([
    [Object.assign(new Error('bad request'), { status: 400 })],
    [Object.assign(new Error('unauthorised'), { status: 401 })],
    [Object.assign(new Error('not found'), { status: 404 })],
    [new CircuitOpenError('op')],
    [new Error('plain')],
  ])('does not retry %s', (error) => {
    // A 4xx that is not a 429 will not change on a second attempt; retrying it
    // just burns the latency budget.
    expect(isRetryable(error)).toBe(false);
  });
});

describe('retry', () => {
  it('succeeds on a later attempt', async () => {
    let attempts = 0;
    const result = await withRetry(
      'flaky',
      async () => {
        attempts += 1;
        if (attempts < 3) throw new ProviderUnavailableError('flaky');
        return 'ok';
      },
      { maxAttempts: 3, budgetMs: 10_000, baseDelayMs: 1, maxDelayMs: 2, ...instant },
    );

    expect(result).toBe('ok');
    expect(attempts).toBe(3);
  });

  it('gives up after the attempt limit', async () => {
    let attempts = 0;

    await expect(
      withRetry(
        'always-down',
        async () => {
          attempts += 1;
          throw new ProviderUnavailableError('always-down');
        },
        { maxAttempts: 3, budgetMs: 10_000, baseDelayMs: 1, maxDelayMs: 2, ...instant },
      ),
    ).rejects.toThrow(ProviderUnavailableError);

    expect(attempts).toBe(3);
  });

  it('does not retry a non-retryable failure', async () => {
    let attempts = 0;

    await expect(
      withRetry(
        'bad-request',
        async () => {
          attempts += 1;
          throw Object.assign(new Error('bad'), { status: 400 });
        },
        { maxAttempts: 5, budgetMs: 10_000, baseDelayMs: 1, maxDelayMs: 2, ...instant },
      ),
    ).rejects.toThrow();

    expect(attempts).toBe(1);
  });

  it('stops when the next attempt would blow the latency budget', async () => {
    // The budget, not the count, is what matters: three dutiful retries that
    // answer nine seconds later is worse than failing fast, because the child
    // has already walked away.
    let attempts = 0;
    let clock = 0;

    await expect(
      withRetry(
        'slow',
        async () => {
          attempts += 1;
          clock += 900; // each attempt burns most of the budget
          throw new ProviderUnavailableError('slow');
        },
        {
          maxAttempts: 10,
          budgetMs: 1_000,
          baseDelayMs: 100,
          maxDelayMs: 500,
          now: () => clock,
          sleep: async () => Promise.resolve(),
          random: () => 1,
        },
      ),
    ).rejects.toThrow();

    expect(attempts).toBeLessThan(10);
  });
});

describe('backoff', () => {
  it('grows exponentially', () => {
    const options = { baseDelayMs: 100, maxDelayMs: 10_000, random: () => 1 };

    expect(backoffDelay(1, options)).toBe(100);
    expect(backoffDelay(2, options)).toBe(200);
    expect(backoffDelay(3, options)).toBe(400);
  });

  it('respects the ceiling', () => {
    expect(backoffDelay(20, { baseDelayMs: 100, maxDelayMs: 1_000, random: () => 1 })).toBe(1_000);
  });

  it('applies full jitter', () => {
    // Without jitter every client that failed together retries together, and
    // the recovering provider is knocked over by its own users.
    const options = { baseDelayMs: 1_000, maxDelayMs: 10_000 };

    expect(backoffDelay(3, { ...options, random: () => 0 })).toBe(0);
    expect(backoffDelay(3, { ...options, random: () => 1 })).toBe(4_000);
  });
});

describe('circuit breaker', () => {
  const failing = async () => {
    throw new ProviderUnavailableError('down');
  };

  it('opens after the failure threshold', async () => {
    const breaker = createCircuitBreaker({ failureThreshold: 3, cooldownMs: 1_000 });

    for (let i = 0; i < 3; i += 1) {
      await expect(breaker.execute('op', failing)).rejects.toThrow();
    }

    expect(breaker.state()).toBe('open');
  });

  it('fails fast while open', async () => {
    // A hard-down provider should cost one fast failure per cooldown, not a
    // full timeout on every request while children wait.
    const breaker = createCircuitBreaker({ failureThreshold: 1, cooldownMs: 10_000 });
    await expect(breaker.execute('op', failing)).rejects.toThrow();

    const attempted = vi.fn();
    await expect(
      breaker.execute('op', async () => {
        attempted();
        return 'never';
      }),
    ).rejects.toThrow(CircuitOpenError);

    expect(attempted).not.toHaveBeenCalled();
  });

  it('probes once after the cooldown and closes on success', async () => {
    let clock = 0;
    const breaker = createCircuitBreaker({
      failureThreshold: 1,
      cooldownMs: 1_000,
      now: () => clock,
    });

    await expect(breaker.execute('op', failing)).rejects.toThrow();
    expect(breaker.state()).toBe('open');

    clock += 2_000;
    await expect(breaker.execute('op', async () => 'recovered')).resolves.toBe('recovered');
    expect(breaker.state()).toBe('closed');
  });

  it('re-opens if the probe fails', async () => {
    let clock = 0;
    const breaker = createCircuitBreaker({
      failureThreshold: 1,
      cooldownMs: 1_000,
      now: () => clock,
    });

    await expect(breaker.execute('op', failing)).rejects.toThrow();
    clock += 2_000;
    await expect(breaker.execute('op', failing)).rejects.toThrow();

    expect(breaker.state()).toBe('open');
  });

  it('does not trip on our own bugs', async () => {
    // A validation error is not provider ill-health. Tripping on it would take
    // the provider down for everyone because of one malformed request.
    const breaker = createCircuitBreaker({ failureThreshold: 2, cooldownMs: 1_000 });

    for (let i = 0; i < 5; i += 1) {
      await expect(
        breaker.execute('op', async () => {
          throw Object.assign(new Error('bad request'), { status: 400 });
        }),
      ).rejects.toThrow();
    }

    expect(breaker.state()).toBe('closed');
  });

  it('reports state changes so an incident is visible', async () => {
    const changes: string[] = [];
    const breaker = createCircuitBreaker({ failureThreshold: 1, cooldownMs: 1_000 }, (from, to) => {
      changes.push(`${from}->${to}`);
    });

    await expect(breaker.execute('op', failing)).rejects.toThrow();

    expect(changes).toContain('closed->open');
  });
});
