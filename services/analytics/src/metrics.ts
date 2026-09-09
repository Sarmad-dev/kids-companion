/**
 * Technical metrics.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * IN-PROCESS, IN-MEMORY, AND DELIBERATELY SMALL.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * No vendor SDK, no agent, no background exporter. A registry of counters,
 * gauges, and histograms, rendered on demand in the Prometheus text format —
 * which every metrics system on earth can scrape, and which is readable by a
 * person with curl at three in the morning.
 *
 * The reason for building rather than importing is narrow: a metrics client is
 * a long-lived process that batches data to a third party, and this application
 * handles children's conversations. Anything with a network egress path and a
 * "capture everything by default" posture is a liability here, and the feature
 * we would actually use is a histogram.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * NO LABEL IN THIS FILE MAY CARRY AN IDENTIFIER.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Metric labels are the classic accidental data leak: they look like
 * infrastructure, they end up in a third-party time-series database, and
 * `child_id="..."` in a label is a child's activity pattern published to a
 * vendor with no data agreement covering it.
 *
 * `assertLabelsAreDimensions` refuses anything identifier-shaped, and the route
 * label is the ROUTE PATTERN (`/api/conversations/:id`), never the URL —
 * otherwise every conversation id becomes its own time series, which is both a
 * privacy leak and a cardinality explosion that kills the metrics backend.
 */

export type MetricKind = 'counter' | 'gauge' | 'histogram';

export type MetricLabels = Readonly<Record<string, string | number>>;

/* -------------------------------------------------------------------------- */
/* The label guard                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Label names that would make a time series about a person.
 *
 * Matched as substrings, case-insensitively, because the leak arrives as
 * `childId`, `child_id`, `parentEmail`, or `userEmail` depending on who wrote
 * the line.
 */
const FORBIDDEN_LABEL_NAMES = [
  'child',
  'parent',
  'user',
  'email',
  'name',
  'token',
  'session',
  'ip',
  'device',
  'transcript',
  'message',
  'audio',
];

/** A UUID. */
const UUID_SHAPED = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** An email address. */
const EMAIL_SHAPED = /^[^@\s]+@[^@\s]+$/;
/** A long opaque string — a token, a hash, a pseudonym. */
const OPAQUE_SHAPED = /^[A-Za-z0-9+/=_-]{24,}$/;

/**
 * One path segment that is a literal or a `:param` placeholder.
 *
 * Deliberately still rejects a segment that is itself identifier-shaped, so
 * that a REAL url — `/api/children/0192c7de-…` — is not waved through as a
 * route pattern. That distinction is the whole point: `/v1/children/:childId`
 * is one time series, `/v1/children/<uuid>` is one per child.
 */
const isRouteSegment = (segment: string): boolean =>
  /^:?[A-Za-z0-9_.-]{1,40}$/.test(segment) &&
  !UUID_SHAPED.test(segment) &&
  !OPAQUE_SHAPED.test(segment);

/**
 * A route pattern, which is a dimension rather than an identifier.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `OPAQUE_SHAPED` includes `/` in its character class, so ANY route pattern of
 * 24 characters or more containing only letters and slashes matched it and was
 * rejected as an identifier. That was seven real routes — `/api/conversations/start`
 * and every static `/api/subscriptions/*` — and the effect was not a failed
 * request but something quieter and worse: the metrics hook threw, so those
 * routes were recorded in NO metric at all, including `http_errors_total`,
 * which alerting reads. A 5xx storm on subscriptions could not have raised the
 * error-rate alarm.
 *
 * Routes with a `:param` escaped only because `:` is outside the class.
 */
const looksLikeRoutePattern = (value: string): boolean =>
  value.startsWith('/') &&
  value
    .split('/')
    .filter((segment) => segment !== '')
    .every(isRouteSegment);

/** Values shaped like an identifier, whatever the label is called. */
const looksLikeIdentifier = (value: string): boolean =>
  !looksLikeRoutePattern(value) &&
  (UUID_SHAPED.test(value) || EMAIL_SHAPED.test(value) || OPAQUE_SHAPED.test(value));

export class MetricLabelError extends Error {
  override readonly name = 'MetricLabelError';

  constructor(metric: string, label: string, reason: string) {
    super(
      `Metric "${metric}" label "${label}" ${reason}. Metric labels are dimensions ` +
        '(route, method, status, outcome), never identifiers — a label ends up in a ' +
        'third-party time-series database, and one per person is both a privacy leak ' +
        'and a cardinality explosion.',
    );
  }
}

export const assertLabelsAreDimensions = (metric: string, labels: MetricLabels): void => {
  for (const [name, value] of Object.entries(labels)) {
    const lower = name.toLowerCase();

    for (const forbidden of FORBIDDEN_LABEL_NAMES) {
      if (lower.includes(forbidden)) {
        throw new MetricLabelError(metric, name, `is named after a person or a credential`);
      }
    }

    if (typeof value === 'string' && looksLikeIdentifier(value)) {
      throw new MetricLabelError(metric, name, 'has an identifier-shaped value');
    }
  }
};

/* -------------------------------------------------------------------------- */
/* Percentiles                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * A latency histogram.
 *
 * Keeps a bounded reservoir of observations rather than every sample: a busy
 * endpoint produces millions an hour, and an unbounded array is a memory leak
 * with a graph attached.
 *
 * The reservoir is a simple ring. That biases toward RECENT observations, which
 * is the right bias for an operational dashboard — "what is p99 now" is the
 * question, not "what was p99 across all of history".
 */
export interface Percentiles {
  readonly count: number;
  readonly sum: number;
  readonly min: number;
  readonly max: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
}

const EMPTY_PERCENTILES: Percentiles = Object.freeze({
  count: 0,
  sum: 0,
  min: 0,
  max: 0,
  p50: 0,
  p95: 0,
  p99: 0,
});

/**
 * The percentile of a sorted sample, by nearest rank.
 *
 * Nearest rank rather than interpolation: an interpolated p99 reports a latency
 * that no request actually experienced, and when somebody is chasing a slow
 * endpoint they want a real number.
 */
export const percentileOf = (sorted: readonly number[], percentile: number): number => {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0]!;

  const rank = Math.ceil((percentile / 100) * sorted.length);
  const index = Math.min(Math.max(rank - 1, 0), sorted.length - 1);
  return sorted[index]!;
};

export class Histogram {
  private readonly capacity: number;
  private readonly reservoir: number[];
  private cursor = 0;
  private filled = 0;
  private total = 0;
  private observations = 0;
  private smallest = Number.POSITIVE_INFINITY;
  private largest = Number.NEGATIVE_INFINITY;

  constructor(capacity = 2_048) {
    this.capacity = capacity;
    this.reservoir = new Array<number>(capacity).fill(0);
  }

  observe(value: number): void {
    if (!Number.isFinite(value) || value < 0) return;

    this.reservoir[this.cursor] = value;
    this.cursor = (this.cursor + 1) % this.capacity;
    if (this.filled < this.capacity) this.filled += 1;

    // Count and sum are exact across all time even though the reservoir is not;
    // an average that quietly covered only the last 2,048 requests would be a
    // different number from the one anybody expects.
    this.observations += 1;
    this.total += value;
    if (value < this.smallest) this.smallest = value;
    if (value > this.largest) this.largest = value;
  }

  snapshot(): Percentiles {
    if (this.filled === 0) return EMPTY_PERCENTILES;

    const sorted = this.reservoir.slice(0, this.filled).sort((a, b) => a - b);

    return {
      count: this.observations,
      sum: this.total,
      min: this.smallest,
      max: this.largest,
      p50: percentileOf(sorted, 50),
      p95: percentileOf(sorted, 95),
      p99: percentileOf(sorted, 99),
    };
  }
}

/* -------------------------------------------------------------------------- */
/* The registry                                                                */
/* -------------------------------------------------------------------------- */

interface Series {
  readonly kind: MetricKind;
  readonly help: string;
  readonly unit?: string | undefined;
  readonly values: Map<string, { labels: MetricLabels; value: number }>;
  readonly histograms: Map<string, { labels: MetricLabels; histogram: Histogram }>;
}

const labelKey = (labels: MetricLabels): string =>
  Object.keys(labels)
    .sort()
    .map((name) => `${name}=${String(labels[name])}`)
    .join(',');

const renderLabels = (labels: MetricLabels): string => {
  const entries = Object.entries(labels);
  if (entries.length === 0) return '';

  const rendered = entries
    .sort(([a], [b]) => a.localeCompare(b))
    // Escape per the Prometheus text format. A stray quote or newline in a
    // label breaks the whole scrape, not just this line.
    .map(([name, value]) => {
      const escaped = String(value)
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n');
      return `${name}="${escaped}"`;
    })
    .join(',');

  return `{${rendered}}`;
};

export interface MetricsRegistry {
  counter(name: string, help: string): void;
  gauge(name: string, help: string): void;
  histogram(name: string, help: string, unit?: string): void;

  increment(name: string, labels?: MetricLabels, by?: number): void;
  set(name: string, value: number, labels?: MetricLabels): void;
  observe(name: string, value: number, labels?: MetricLabels): void;

  /** One histogram's percentiles, for the health endpoint and for alerting. */
  percentiles(name: string, labels?: MetricLabels): Percentiles;
  /** Every metric, in the Prometheus text exposition format. */
  render(): string;
  /** Everything as data, for tests and for the JSON summary endpoint. */
  snapshot(): Readonly<Record<string, unknown>>;
  reset(): void;
}

export const createMetricsRegistry = (): MetricsRegistry => {
  const series = new Map<string, Series>();

  const define = (name: string, kind: MetricKind, help: string, unit?: string): Series => {
    const existing = series.get(name);
    if (existing) return existing;

    const created: Series = {
      kind,
      help,
      unit,
      values: new Map(),
      histograms: new Map(),
    };
    series.set(name, created);
    return created;
  };

  const require = (name: string, kind: MetricKind): Series => {
    const found = series.get(name);
    if (!found) {
      // A metric written before it is declared is a typo nine times out of ten,
      // and a typo in a metric name is a dashboard that silently shows nothing.
      throw new Error(`Metric "${name}" is not registered. Declare it before recording to it.`);
    }
    if (found.kind !== kind) {
      throw new Error(`Metric "${name}" is a ${found.kind}, not a ${kind}.`);
    }
    return found;
  };

  return {
    counter: (name, help) => void define(name, 'counter', help),
    gauge: (name, help) => void define(name, 'gauge', help),
    histogram: (name, help, unit) => void define(name, 'histogram', help, unit),

    increment: (name, labels = {}, by = 1) => {
      assertLabelsAreDimensions(name, labels);
      const metric = require(name, 'counter');
      const key = labelKey(labels);
      const current = metric.values.get(key);
      metric.values.set(key, { labels, value: (current?.value ?? 0) + by });
    },

    set: (name, value, labels = {}) => {
      assertLabelsAreDimensions(name, labels);
      const metric = require(name, 'gauge');
      metric.values.set(labelKey(labels), { labels, value });
    },

    observe: (name, value, labels = {}) => {
      assertLabelsAreDimensions(name, labels);
      const metric = require(name, 'histogram');
      const key = labelKey(labels);
      const existing = metric.histograms.get(key);
      if (existing) {
        existing.histogram.observe(value);
        return;
      }
      const histogram = new Histogram();
      histogram.observe(value);
      metric.histograms.set(key, { labels, histogram });
    },

    percentiles: (name, labels = {}) => {
      const metric = series.get(name);
      const found = metric?.histograms.get(labelKey(labels));
      return found?.histogram.snapshot() ?? EMPTY_PERCENTILES;
    },

    render: () => {
      const lines: string[] = [];

      for (const [name, metric] of [...series.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        lines.push(`# HELP ${name} ${metric.help}`);
        lines.push(`# TYPE ${name} ${metric.kind === 'histogram' ? 'summary' : metric.kind}`);

        for (const { labels, value } of metric.values.values()) {
          lines.push(`${name}${renderLabels(labels)} ${String(value)}`);
        }

        for (const { labels, histogram } of metric.histograms.values()) {
          const snapshot = histogram.snapshot();
          for (const [quantile, value] of [
            ['0.5', snapshot.p50],
            ['0.95', snapshot.p95],
            ['0.99', snapshot.p99],
          ] as const) {
            lines.push(`${name}${renderLabels({ ...labels, quantile })} ${String(value)}`);
          }
          lines.push(`${name}_sum${renderLabels(labels)} ${String(snapshot.sum)}`);
          lines.push(`${name}_count${renderLabels(labels)} ${String(snapshot.count)}`);
        }
      }

      return `${lines.join('\n')}\n`;
    },

    snapshot: () => {
      const output: Record<string, unknown> = {};

      for (const [name, metric] of series.entries()) {
        if (metric.kind === 'histogram') {
          output[name] = [...metric.histograms.values()].map(({ labels, histogram }) => ({
            labels,
            ...histogram.snapshot(),
          }));
        } else {
          output[name] = [...metric.values.values()].map(({ labels, value }) => ({
            labels,
            value,
          }));
        }
      }

      return output;
    },

    reset: () => series.clear(),
  };
};

/* -------------------------------------------------------------------------- */
/* The metric catalogue                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Every technical metric this system reports.
 *
 * Declared in one place so a dashboard can be built from the list rather than
 * from guesswork, and so adding one is a visible decision.
 */
export const TECHNICAL_METRICS = {
  requestDuration: 'http_request_duration_ms',
  requestsTotal: 'http_requests_total',
  errorsTotal: 'http_errors_total',
  inflight: 'http_requests_inflight',

  processCpuPercent: 'process_cpu_percent',
  processMemoryBytes: 'process_memory_bytes',
  processUptimeSeconds: 'process_uptime_seconds',
  eventLoopLagMs: 'process_event_loop_lag_ms',

  dbConnections: 'database_connections',
  dbQueryDuration: 'database_query_duration_ms',

  aiQuotaRemaining: 'ai_quota_remaining',
  aiRequestDuration: 'ai_request_duration_ms',
  aiRequestsTotal: 'ai_requests_total',

  queueSize: 'queue_size',
  storageBytes: 'storage_bytes',
  storageObjects: 'storage_objects',
} as const;

/** Registers every technical metric with its help text. */
export const registerTechnicalMetrics = (registry: MetricsRegistry): void => {
  registry.histogram(
    TECHNICAL_METRICS.requestDuration,
    'HTTP request duration. Labelled by route PATTERN, never the URL.',
    'ms',
  );
  registry.counter(TECHNICAL_METRICS.requestsTotal, 'HTTP requests, by route and status class.');
  registry.counter(TECHNICAL_METRICS.errorsTotal, 'HTTP responses in the 5xx class.');
  registry.gauge(TECHNICAL_METRICS.inflight, 'Requests currently being handled.');

  registry.gauge(TECHNICAL_METRICS.processCpuPercent, 'Process CPU use, percent of one core.');
  registry.gauge(TECHNICAL_METRICS.processMemoryBytes, 'Resident and heap memory, by kind.');
  registry.gauge(TECHNICAL_METRICS.processUptimeSeconds, 'Seconds since this process started.');
  registry.gauge(
    TECHNICAL_METRICS.eventLoopLagMs,
    'Event loop delay. The first thing to rise when the process is saturated.',
  );

  registry.gauge(TECHNICAL_METRICS.dbConnections, 'Database pool connections, by state.');
  registry.histogram(TECHNICAL_METRICS.dbQueryDuration, 'Database query duration.', 'ms');

  registry.gauge(
    TECHNICAL_METRICS.aiQuotaRemaining,
    'Remaining AI provider quota, where the provider reports it.',
  );
  registry.histogram(TECHNICAL_METRICS.aiRequestDuration, 'AI provider request duration.', 'ms');
  registry.counter(TECHNICAL_METRICS.aiRequestsTotal, 'AI provider requests, by outcome.');

  registry.gauge(TECHNICAL_METRICS.queueSize, 'Pending work, by queue.');
  registry.gauge(TECHNICAL_METRICS.storageBytes, 'Bytes held, by bucket.');
  registry.gauge(TECHNICAL_METRICS.storageObjects, 'Objects held, by bucket.');
};

/* -------------------------------------------------------------------------- */
/* Process sampling                                                            */
/* -------------------------------------------------------------------------- */

export interface ProcessSampler {
  sample(): void;
}

/**
 * Samples CPU, memory, uptime, and event loop lag.
 *
 * Event loop lag is the one worth explaining. It measures how late a timer set
 * for 0 ms actually fires, which is the most direct available signal that the
 * process is saturated — and in a product where a child is waiting for a
 * character to answer, saturation is felt as the app going quiet.
 */
export const createProcessSampler = (
  registry: MetricsRegistry,
  runtime: {
    cpuUsage: (previous?: NodeJS.CpuUsage) => NodeJS.CpuUsage;
    memoryUsage: () => NodeJS.MemoryUsage;
    uptime: () => number;
    hrtimeMs: () => number;
  },
): ProcessSampler => {
  let lastCpu = runtime.cpuUsage();
  let lastSampleMs = runtime.hrtimeMs();
  let lagMs = 0;

  // A timer that measures its own lateness.
  const scheduleLagProbe = (): void => {
    const scheduledAt = runtime.hrtimeMs();
    // Unref'd so a metrics timer never holds the process open at shutdown —
    // that turns a routine deploy into one that hangs.
    setTimeout(() => {
      lagMs = Math.max(0, runtime.hrtimeMs() - scheduledAt);
      scheduleLagProbe();
    }, 1_000).unref();
  };
  scheduleLagProbe();

  return {
    sample: () => {
      const nowMs = runtime.hrtimeMs();
      const elapsedMs = Math.max(1, nowMs - lastSampleMs);

      const cpu = runtime.cpuUsage(lastCpu);
      const cpuMs = (cpu.user + cpu.system) / 1_000;
      registry.set(
        TECHNICAL_METRICS.processCpuPercent,
        Math.round((cpuMs / elapsedMs) * 100 * 100) / 100,
      );

      lastCpu = runtime.cpuUsage();
      lastSampleMs = nowMs;

      const memory = runtime.memoryUsage();
      registry.set(TECHNICAL_METRICS.processMemoryBytes, memory.rss, { kind: 'rss' });
      registry.set(TECHNICAL_METRICS.processMemoryBytes, memory.heapUsed, { kind: 'heap_used' });
      registry.set(TECHNICAL_METRICS.processMemoryBytes, memory.heapTotal, { kind: 'heap_total' });
      registry.set(TECHNICAL_METRICS.processMemoryBytes, memory.external, { kind: 'external' });

      registry.set(TECHNICAL_METRICS.processUptimeSeconds, Math.round(runtime.uptime()));
      registry.set(TECHNICAL_METRICS.eventLoopLagMs, Math.round(lagMs));
    },
  };
};
