/**
 * @kids/analytics — metrics, product analytics, and the gate between them.
 *
 * The shape carries the argument:
 *
 *   metrics.ts    technical metrics, in-process, with labels that cannot be
 *                 identifiers,
 *   ports.ts      an event catalogue that says where each event may go,
 *   sanitiser.ts  the gate every event passes through, which refuses rather
 *                 than redacts,
 *   providers.ts  a no-op default, because analytics is off until somebody
 *                 turns it on.
 *
 * See docs/OBSERVABILITY.md.
 */

export {
  assertLabelsAreDimensions,
  createMetricsRegistry,
  createProcessSampler,
  Histogram,
  MetricLabelError,
  percentileOf,
  registerTechnicalMetrics,
  TECHNICAL_METRICS,
} from './metrics.js';
export type {
  MetricKind,
  MetricLabels,
  MetricsRegistry,
  Percentiles,
  ProcessSampler,
} from './metrics.js';

export { ANALYTICS_DESTINATIONS, EVENT_CATALOGUE, findEvent } from './ports.js';
export type {
  AnalyticsDestination,
  AnalyticsEvent,
  AnalyticsProvider,
  EventDefinition,
} from './ports.js';

export { NOT_COLLECTED, sanitiseEvent } from './sanitiser.js';
export type { RejectionReason, SanitiseOutcome } from './sanitiser.js';

export {
  createFanOutAnalytics,
  createInternalAnalytics,
  createMemoryAnalytics,
  createNoopAnalytics,
} from './providers.js';
