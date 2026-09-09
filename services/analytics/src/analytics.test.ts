import { describe, expect, it } from 'vitest';

import {
  assertLabelsAreDimensions,
  createMetricsRegistry,
  Histogram,
  MetricLabelError,
  percentileOf,
  registerTechnicalMetrics,
  TECHNICAL_METRICS,
} from './metrics.js';
import { EVENT_CATALOGUE, findEvent, type AnalyticsEvent } from './ports.js';
import { createFanOutAnalytics, createMemoryAnalytics } from './providers.js';
import { NOT_COLLECTED, sanitiseEvent } from './sanitiser.js';

const event = (
  name: string,
  properties: Record<string, string | number | boolean> = {},
): AnalyticsEvent => ({
  name,
  subjectRef: 'p_9f2c4a',
  properties,
  occurredAt: '2026-10-01T12:00:00.000Z' as AnalyticsEvent['occurredAt'],
});

/* ========================================================================== */
/* The privacy gate                                                           */
/* ========================================================================== */

describe('the privacy gate', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════
   * NO CHILD-SCOPED EVENT LEAVES THIS SYSTEM.
   * ═══════════════════════════════════════════════════════════════════════
   *
   * A parent consented to their child talking to a character in our product.
   * They did not consent to a behavioural record of that child — even a
   * pseudonymous one — accumulating at a third-party vendor under that vendor's
   * retention policy.
   */
  it('refuses every child-scoped event at an external destination', () => {
    const childEvents = EVENT_CATALOGUE.filter((definition) => definition.scope === 'child');
    expect(childEvents.length).toBeGreaterThan(0);

    for (const definition of childEvents) {
      const outcome = sanitiseEvent(event(definition.name), 'external');

      expect(outcome.ok, definition.name).toBe(false);
      if (outcome.ok) continue;
      expect(outcome.reason).toBe('child_scope_external');
    }
  });

  it('allows the same events internally, where they are covered by our own policy', () => {
    const outcome = sanitiseEvent(
      event('conversation.completed', { turn_count: 12, duration_seconds: 340 }),
      'internal',
    );

    expect(outcome.ok).toBe(true);
  });

  it('declares no child-scoped event as externally sendable, at the catalogue level', () => {
    // Belt and braces: the gate refuses it, and the catalogue never offers it.
    // A future edit that adds `external` to a child event fails here rather
    // than shipping and being caught only by the runtime check.
    for (const definition of EVENT_CATALOGUE) {
      if (definition.scope !== 'child') continue;
      expect(definition.destinations, definition.name).toEqual(['internal']);
    }
  });

  it('refuses an event that is not in the catalogue', () => {
    const outcome = sanitiseEvent(event('conversation.every_word_said'), 'internal');

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('unknown_event');
  });

  it('refuses a raw identifier as the subject', () => {
    const outcome = sanitiseEvent(
      {
        ...event('account.registered'),
        subjectRef: '9f2c4a1e-0d3b-4c5e-8a7f-1b2c3d4e5f60',
      },
      'internal',
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('subject_looks_raw');
  });

  it('refuses a property the event did not declare', () => {
    const outcome = sanitiseEvent(
      event('conversation.completed', { turn_count: 4, child_name: 'Rumi' }),
      'internal',
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('undeclared_property');
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════
   * `reason` IS A REASONABLE PROPERTY NAME, AND IT IS WHERE A TRANSCRIPT
   * ENDS UP.
   * ═══════════════════════════════════════════════════════════════════════
   *
   * Declaring property NAMES is not enough. The day somebody passes a child's
   * sentence into a declared string field, this is what catches it.
   */
  it('refuses free text in a declared property', () => {
    const outcome = sanitiseEvent(
      event('subscription.cancelled', {
        plan: 'monthly',
        reason: 'my daughter said she did not like the owl and wanted the dog instead',
      }),
      'internal',
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('free_text_in_properties');
  });

  it('allows a short enum in the same property', () => {
    const outcome = sanitiseEvent(
      event('subscription.cancelled', { plan: 'monthly', reason: 'too_expensive' }),
      'internal',
    );

    expect(outcome.ok).toBe(true);
  });

  it('refuses an identifier hiding in a declared property', () => {
    for (const value of ['parent@example.invalid', '+92 300 1234567']) {
      const outcome = sanitiseEvent(
        event('feature.used', { feature: value, surface: 'web' }),
        'internal',
      );

      expect(outcome.ok, value).toBe(false);
    }
  });

  it('gives every event a stated purpose, because one nobody can justify should not exist', () => {
    for (const definition of EVENT_CATALOGUE) {
      expect(definition.purpose.length, definition.name).toBeGreaterThan(20);
      expect(definition.properties.length, definition.name).toBeGreaterThan(0);
    }
  });

  it('names what is never collected', () => {
    expect(NOT_COLLECTED.join(' ')).toMatch(/session replay/i);
    expect(NOT_COLLECTED.join(' ')).toMatch(/advertising/i);
    expect(NOT_COLLECTED.join(' ')).toMatch(/what a child said|anything a child said/i);
  });

  it('carries no event about what a child actually said', () => {
    // The catalogue is the whole surface. If there is no event for message
    // content, no amount of instrumentation can accidentally send it.
    for (const definition of EVENT_CATALOGUE) {
      const combined = `${definition.name} ${definition.properties.join(' ')}`.toLowerCase();
      for (const forbidden of ['transcript', 'message_text', 'utterance', 'content', 'word']) {
        expect(combined, definition.name).not.toContain(forbidden);
      }
    }
  });
});

/* ========================================================================== */
/* Providers                                                                  */
/* ========================================================================== */

describe('providers', () => {
  it('applies the gate independently per destination, from one call', () => {
    const internal = createMemoryAnalytics('internal');
    const external = createMemoryAnalytics('external');
    const both = createFanOutAnalytics([internal, external]);

    both.record(event('conversation.completed', { turn_count: 8 }));
    both.record(event('subscription.started', { plan: 'monthly', rail: 'mock' }));

    // The caller made two calls and did not have to know the rule.
    expect(internal.events.map((recorded) => recorded.name)).toEqual([
      'conversation.completed',
      'subscription.started',
    ]);
    expect(external.events.map((recorded) => recorded.name)).toEqual(['subscription.started']);
    expect(external.rejected[0]?.reason).toBe('child_scope_external');
  });

  it('never lets a failing provider break the caller', () => {
    const exploding = {
      name: 'exploding',
      destination: 'internal' as const,
      record: () => {
        throw new Error('vendor is down');
      },
      flush: () => Promise.resolve(),
    };
    const working = createMemoryAnalytics('internal');

    const both = createFanOutAnalytics([exploding, working]);

    // Analytics is never load bearing. A child cannot lose their conversation
    // because a metrics vendor had an outage.
    expect(() => {
      both.record(event('subscription.started', { plan: 'monthly' }));
    }).not.toThrow();
    expect(working.events).toHaveLength(1);
  });
});

/* ========================================================================== */
/* Metrics                                                                    */
/* ========================================================================== */

describe('metric labels', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════
   * A METRIC LABEL IS THE CLASSIC ACCIDENTAL LEAK.
   * ═══════════════════════════════════════════════════════════════════════
   *
   * It looks like infrastructure, it ends up in a third-party time-series
   * database, and one series per child is both a privacy breach and a
   * cardinality explosion that takes the metrics backend down with it.
   */
  it('refuses a label named after a person', () => {
    for (const label of ['child_id', 'childId', 'parent_email', 'userId', 'device_id']) {
      expect(() => {
        assertLabelsAreDimensions('http_requests_total', { [label]: 'x' });
      }, label).toThrow(MetricLabelError);
    }
  });

  it('refuses an identifier-shaped value under an innocent label name', () => {
    expect(() => {
      assertLabelsAreDimensions('http_requests_total', {
        route: '9f2c4a1e-0d3b-4c5e-8a7f-1b2c3d4e5f60',
      });
    }).toThrow(MetricLabelError);
  });

  it('allows the dimensions a dashboard actually needs', () => {
    expect(() => {
      assertLabelsAreDimensions('http_requests_total', {
        route: '/api/conversations/:conversationId',
        method: 'POST',
        status: '200',
        outcome: 'ok',
      });
    }).not.toThrow();
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════
   * EVERY ROUTE IN THE PRODUCT, NOT ONE CONVENIENT EXAMPLE.
   * ═══════════════════════════════════════════════════════════════════════
   *
   * The positive control above passes a route containing `:conversationId`,
   * and `:` sits outside the opaque-string character class — so it passed
   * while seven real routes threw on every single request. A static route of
   * 24 characters or more made only of letters and slashes matched the
   * "long opaque string" rule and was rejected as an identifier.
   *
   * Nothing was visibly broken: the response had already been sent, so the
   * client saw a correct answer and every integration test passed. What was
   * lost was the METRIC — those routes appeared in no time series at all,
   * `http_errors_total` included, which is the series alerting reads.
   *
   * So the control is now the actual route table, including the long static
   * ones that have no parameter to save them.
   */
  it('accepts every route pattern the API actually serves', () => {
    const routes = [
      '/health',
      '/metrics',
      '/v1/children',
      '/v1/auth/login',
      '/api/voice/turns',
      '/api/conversations/start',
      '/api/subscriptions/plans',
      '/api/subscriptions/status',
      '/api/subscriptions/create',
      '/api/subscriptions/cancel',
      '/api/subscriptions/resume',
      '/api/observability/health',
      '/api/parent/dashboard/:childId',
      '/api/conversations/:conversationId/message',
      '/api/subscriptions/webhook/:rail',
      'unmatched',
    ];

    for (const route of routes) {
      expect(() => {
        assertLabelsAreDimensions('http_requests_total', { route, method: 'GET' });
      }, route).not.toThrow();
    }
  });

  it('still refuses a real url with an identifier in it', () => {
    /* The exemption above must not become a hole. A route PATTERN is one time
     * series; the same path with a real id substituted is one per child, which
     * is the cardinality explosion the whole check exists to prevent. */
    for (const url of [
      '/v1/children/9f2c4a1e-0d3b-4c5e-8a7f-1b2c3d4e5f60',
      '/api/voice/audio/QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo',
    ]) {
      expect(() => {
        assertLabelsAreDimensions('http_requests_total', { route: url });
      }, url).toThrow(MetricLabelError);
    }
  });
});

describe('percentiles', () => {
  it('reports a value that actually occurred, by nearest rank', () => {
    // Not interpolated: an interpolated p99 is a latency no request experienced,
    // and somebody chasing a slow endpoint wants a real number.
    const sorted = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];

    expect(percentileOf(sorted, 50)).toBe(50);
    expect(percentileOf(sorted, 95)).toBe(100);
    expect(percentileOf(sorted, 99)).toBe(100);
    expect(sorted).toContain(percentileOf(sorted, 95));
  });

  it('handles an empty and a single-sample series', () => {
    expect(percentileOf([], 99)).toBe(0);
    expect(percentileOf([42], 50)).toBe(42);
  });

  it('keeps count and sum exact even though the reservoir is bounded', () => {
    // An average that quietly covered only the last N requests would be a
    // different number from the one anybody expects.
    const histogram = new Histogram(16);
    for (let i = 1; i <= 100; i += 1) histogram.observe(i);

    const snapshot = histogram.snapshot();
    expect(snapshot.count).toBe(100);
    expect(snapshot.sum).toBe(5_050);
    expect(snapshot.min).toBe(1);
    expect(snapshot.max).toBe(100);
  });

  it('ignores an impossible observation rather than poisoning the series', () => {
    const histogram = new Histogram(8);
    histogram.observe(10);
    histogram.observe(Number.NaN);
    histogram.observe(-5);

    expect(histogram.snapshot().count).toBe(1);
  });
});

describe('the registry', () => {
  it('refuses a metric that was never declared', () => {
    const registry = createMetricsRegistry();

    // A typo in a metric name is a dashboard that silently shows nothing.
    expect(() => {
      registry.increment('http_reqests_total');
    }).toThrow(/not registered/);
  });

  it('renders the Prometheus text format, with quantiles', () => {
    const registry = createMetricsRegistry();
    registerTechnicalMetrics(registry);

    registry.increment(TECHNICAL_METRICS.requestsTotal, { route: '/v1/children', status: '200' });
    registry.observe(TECHNICAL_METRICS.requestDuration, 12, { route: '/v1/children' });
    registry.set(TECHNICAL_METRICS.dbConnections, 4, { state: 'idle' });

    const rendered = registry.render();

    expect(rendered).toContain('# TYPE http_requests_total counter');
    expect(rendered).toContain('http_requests_total{route="/v1/children",status="200"} 1');
    expect(rendered).toContain('quantile="0.99"');
    expect(rendered).toContain('database_connections{state="idle"} 4');
  });

  it('declares every metric the brief asks for', () => {
    const registry = createMetricsRegistry();
    registerTechnicalMetrics(registry);
    const rendered = registry.render();

    for (const metric of [
      'http_request_duration_ms',
      'http_requests_total',
      'http_errors_total',
      'process_cpu_percent',
      'process_memory_bytes',
      'database_connections',
      'ai_quota_remaining',
      'queue_size',
      'storage_bytes',
    ]) {
      expect(rendered, metric).toContain(metric);
    }
  });

  it('escapes a label value rather than breaking the scrape', () => {
    const registry = createMetricsRegistry();
    registry.counter('test_total', 'test');
    registry.increment('test_total', { route: 'a"b' });

    expect(registry.render()).toContain('route="a\\"b"');
  });
});

describe('the event catalogue', () => {
  it('covers the product metrics the brief names', () => {
    // Activation, conversation completion, feature adoption, conversion, churn.
    for (const name of [
      'account.registered',
      'account.activated',
      'conversation.completed',
      'feature.used',
      'subscription.started',
      'subscription.cancelled',
    ]) {
      expect(findEvent(name), name).toBeDefined();
    }
  });

  it('names events consistently, so the database constraint accepts them', () => {
    // `analytics_events` has a CHECK on the name pattern. An event that fails it
    // would be discovered on the first write in production.
    for (const definition of EVENT_CATALOGUE) {
      expect(definition.name, definition.name).toMatch(/^[a-z0-9_]+\.[a-z0-9_.]+$/);
    }
  });
});
