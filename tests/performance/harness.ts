/**
 * Measurement apparatus for the performance suite.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT A NUMBER FROM THIS FILE MEANS, AND WHAT IT DOES NOT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Everything here is a CLOSED-LOOP measurement: a fixed number of workers each
 * send a request, wait for the response, and immediately send the next. That
 * measures latency under sustained saturation, which is the useful shape for
 * finding a bottleneck.
 *
 * It is NOT an open-loop arrival process, and the difference matters when
 * reading the tail. In a closed loop a slow response delays the next request
 * from that worker, so the queue cannot build the way it does when real users
 * keep arriving regardless of how the server feels. This is *coordinated
 * omission*, and it makes p99 here an UNDER-estimate of what a real p99 would
 * be at the same offered load. Numbers from this harness are therefore a floor,
 * not a forecast.
 *
 * The event-loop lag sampler is included for one reason: this is Node, the
 * request path is single-threaded, and any CPU-bound work — Argon2 above all —
 * shows up as lag long before it shows up as an obvious latency cliff. Lag is
 * the measurement that explains *why* a percentile moved.
 */

import { performance } from 'node:perf_hooks';

/* -------------------------------------------------------------------------- */
/* Statistics                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Nearest-rank percentile over an already-sorted ascending array.
 *
 * Nearest-rank rather than interpolation on purpose: an interpolated p99 is a
 * value that was never actually observed, and for latency the honest answer is
 * "a request really did take this long".
 */
export const percentileOf = (sortedAscending: readonly number[], p: number): number => {
  if (sortedAscending.length === 0) return Number.NaN;
  const rank = Math.ceil((p / 100) * sortedAscending.length);
  const index = Math.min(Math.max(rank - 1, 0), sortedAscending.length - 1);
  return sortedAscending[index]!;
};

/**
 * The smallest sample count at which a percentile is worth printing.
 *
 * A p99 drawn from 50 samples is just the maximum wearing a hat: it has no
 * observations above it, so it cannot describe a tail. The rule used throughout
 * this suite is that a percentile needs at least a handful of samples beyond it
 * before it means anything — 500 samples puts 5 above p99.
 */
export const MINIMUM_SAMPLES_FOR_P99 = 500;

export interface Summary {
  readonly scenario: string;
  readonly concurrency: number;
  /** Successful, measured requests. Failures are excluded from percentiles. */
  readonly samples: number;
  readonly errors: number;
  readonly errorDetail: string | undefined;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  /** True when `samples` is too small for p99 to describe anything. */
  readonly p99Unreliable: boolean;
  readonly min: number;
  readonly max: number;
  readonly mean: number;
  readonly throughputPerSecond: number;
  readonly wallClockMs: number;
  /** Worst event-loop delay observed during the run, milliseconds. */
  readonly eventLoopLagP99Ms: number;
}

const round = (value: number): number => Math.round(value * 100) / 100;

/* -------------------------------------------------------------------------- */
/* Event-loop lag                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Samples how late a 10 ms timer actually fires.
 *
 * When the loop is free the answer is ~0. When something CPU-bound is running —
 * a WASM Argon2 hash, a large JSON serialisation — the timer cannot fire until
 * it finishes, and the lag is that blocking time. This is what distinguishes
 * "the database is slow" from "we are burning the only thread we have".
 */
const startLagSampler = (): { stop: () => number } => {
  const lags: number[] = [];
  const intervalMs = 10;
  let last = performance.now();

  const timer = setInterval(() => {
    const now = performance.now();
    lags.push(Math.max(0, now - last - intervalMs));
    last = now;
  }, intervalMs);
  // Never hold the process open for a measurement.
  timer.unref();

  return {
    stop: () => {
      clearInterval(timer);
      if (lags.length === 0) return 0;
      return percentileOf(
        [...lags].sort((a, b) => a - b),
        99,
      );
    },
  };
};

/* -------------------------------------------------------------------------- */
/* The load driver                                                             */
/* -------------------------------------------------------------------------- */

export interface RequestOutcome {
  readonly ok: boolean;
  /** Shown in the report when a scenario fails, so a bad run is never silent. */
  readonly detail?: string;
}

export interface LoadOptions {
  readonly scenario: string;
  readonly concurrency: number;
  /** Measured requests, excluding warm-up. */
  readonly totalRequests: number;
  /**
   * Discarded iterations run before measurement starts.
   *
   * The first call through any path in Node is unrepresentative — the JIT has
   * not tiered up, connection pools are cold, and lazily-built structures are
   * still being built. Including those in a percentile measures start-up.
   */
  readonly warmup: number;
  /** Performs one request. `index` is unique and monotonic across the run. */
  readonly request: (index: number) => Promise<RequestOutcome>;
}

export const runLoad = async (options: LoadOptions): Promise<Summary> => {
  const { scenario, concurrency, totalRequests, warmup, request } = options;

  /* Warm-up, discarded. Run at the same concurrency so any lazy structure that
   * only appears under parallelism is built before the clock starts. */
  let warmIndex = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, Math.max(warmup, 1)) }, async () => {
      while (warmIndex < warmup) {
        const index = warmIndex;
        warmIndex += 1;
        try {
          await request(-1 - index);
        } catch {
          // A warm-up failure is not a measurement. If the path is genuinely
          // broken the measured phase reports it as an error.
        }
      }
    }),
  );

  const latencies: number[] = [];
  let errors = 0;
  let firstError: string | undefined;
  let issued = 0;

  const lag = startLagSampler();
  const started = performance.now();

  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      for (;;) {
        const index = issued;
        if (index >= totalRequests) return;
        issued += 1;

        const requestStarted = performance.now();
        try {
          const outcome = await request(index);
          const elapsed = performance.now() - requestStarted;

          if (outcome.ok) {
            latencies.push(elapsed);
          } else {
            errors += 1;
            firstError ??= outcome.detail ?? 'request reported not-ok';
          }
        } catch (error) {
          errors += 1;
          firstError ??= error instanceof Error ? error.message : String(error);
        }
      }
    }),
  );

  const wallClockMs = performance.now() - started;
  const eventLoopLagP99Ms = lag.stop();

  const sorted = [...latencies].sort((a, b) => a - b);
  const mean = sorted.length === 0 ? Number.NaN : sorted.reduce((a, b) => a + b, 0) / sorted.length;

  return {
    scenario,
    concurrency,
    samples: sorted.length,
    errors,
    errorDetail: firstError,
    p50: round(percentileOf(sorted, 50)),
    p95: round(percentileOf(sorted, 95)),
    p99: round(percentileOf(sorted, 99)),
    p99Unreliable: sorted.length < MINIMUM_SAMPLES_FOR_P99,
    min: round(sorted[0] ?? Number.NaN),
    max: round(sorted[sorted.length - 1] ?? Number.NaN),
    mean: round(mean),
    throughputPerSecond: round((sorted.length / wallClockMs) * 1000),
    wallClockMs: round(wallClockMs),
    eventLoopLagP99Ms: round(eventLoopLagP99Ms),
  };
};

/* -------------------------------------------------------------------------- */
/* Reporting                                                                   */
/* -------------------------------------------------------------------------- */

export const formatSummary = (summary: Summary): string => {
  const flag =
    summary.errors > 0
      ? ` ERRORS=${String(summary.errors)} [${summary.errorDetail ?? 'no detail'}]`
      : '';
  const shaky = summary.p99Unreliable ? ' (p99 from a small sample)' : '';
  return (
    `  c=${String(summary.concurrency).padStart(2)}  ` +
    `n=${String(summary.samples).padStart(4)}  ` +
    `p50=${summary.p50.toFixed(1).padStart(8)}ms  ` +
    `p95=${summary.p95.toFixed(1).padStart(8)}ms  ` +
    `p99=${summary.p99.toFixed(1).padStart(8)}ms  ` +
    `rps=${summary.throughputPerSecond.toFixed(1).padStart(7)}  ` +
    `loopLag=${summary.eventLoopLagP99Ms.toFixed(1).padStart(7)}ms` +
    flag +
    shaky
  );
};

export const CONCURRENCY_LADDER = [1, 2, 4, 8, 16, 32] as const;
