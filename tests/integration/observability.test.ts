import { createMetricsRegistry } from '@kids/analytics';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  authHeader,
  createApiHarness,
  registerAndLogin,
  type ApiHarness,
  type RegisteredParent,
} from '../helpers/api.js';

/**
 * Observability, end to end.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE TEST THAT MATTERS IS THE ONE ABOUT LABELS.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A metrics endpoint is scraped by infrastructure and forwarded to a
 * time-series database that may not be ours. If a conversation id or a child id
 * reaches a label, it has been published — and the leak looks like ordinary
 * plumbing right up until somebody reads the dashboard.
 *
 * So this file drives real requests against real routes with real identifiers in
 * the URLs, then reads `/metrics` back and asserts that not one of them appears.
 */

/* Deliberately NOT moving the clock.
 *
 * `parents.created_at` and friends default to the DATABASE's `now()`, and the
 * product metrics window is computed from the APPLICATION's clock. Pushing one
 * of them months into the future puts every row outside every window, and the
 * funnel correctly reports that nobody registered. */

describe('observability', () => {
  let harness: ApiHarness;
  let parent: RegisteredParent;
  let childId: string;

  beforeAll(async () => {
    harness = await createApiHarness({ metricsRegistry: createMetricsRegistry() });
    parent = await registerAndLogin(harness, 'observability');

    const child = await harness.app.inject({
      method: 'POST',
      url: '/v1/children',
      headers: authHeader(parent.accessToken),
      payload: {
        displayName: 'Rumi',
        birthYear: 2018,
        birthMonth: 6,
        languages: [{ languageCode: 'en', isPrimary: true }],
      },
    });
    childId = child.json<{ id: string }>().id;
  });

  afterAll(async () => {
    await harness.close();
  });

  const scrape = async (): Promise<string> => {
    const response = await harness.app.inject({ method: 'GET', url: '/metrics' });
    expect(response.statusCode).toBe(200);
    return response.body;
  };

  /* ======================================================================== */
  /* The scrape endpoint                                                      */
  /* ======================================================================== */

  describe('GET /metrics', () => {
    it('serves the Prometheus text format', async () => {
      const response = await harness.app.inject({ method: 'GET', url: '/metrics' });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/plain');
      // A snapshot is a point in time and must never be cached between the
      // scraper and us.
      expect(response.headers['cache-control']).toBe('no-store');
    });

    it('records request duration, volume, and the metrics the brief names', async () => {
      await harness.app.inject({
        method: 'GET',
        url: '/v1/children',
        headers: authHeader(parent.accessToken),
      });

      const body = await scrape();

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
        expect(body, metric).toContain(metric);
      }
    });

    it('reports p50, p95, and p99', async () => {
      const body = await scrape();

      expect(body).toContain('quantile="0.5"');
      expect(body).toContain('quantile="0.95"');
      expect(body).toContain('quantile="0.99"');
    });

    /**
     * ═══════════════════════════════════════════════════════════════════════
     * NOT ONE IDENTIFIER REACHES A LABEL.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * These requests carry a child id in the path and a bearer token in a
     * header. The scrape must contain neither, and it must contain the route
     * PATTERN instead — which is also what stops one time series per child from
     * taking the metrics backend down.
     */
    it('labels routes by pattern, never by URL', async () => {
      await harness.app.inject({
        method: 'GET',
        url: `/api/parent/dashboard/${childId}`,
        headers: authHeader(parent.accessToken),
      });

      const body = await scrape();

      expect(body).toContain('/api/parent/dashboard/:childId');
      expect(body).not.toContain(childId);
      expect(body).not.toContain(parent.parentId);
      expect(body).not.toContain(parent.email);
      expect(body).not.toContain(parent.accessToken);
    });

    it('carries no UUID anywhere in the scrape at all', async () => {
      // Belt and braces over the specific-identifier check above: whatever the
      // request was, nothing UUID-shaped may appear.
      const body = await scrape();

      expect(body).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    });

    it('does not label an unrouted request with what the caller sent', async () => {
      // An unmatched URL is attacker-controlled input. Attaching it to a metric
      // is how somebody writes into our dashboards.
      await harness.app.inject({
        method: 'GET',
        url: '/definitely-not-a-route-9f2c',
      });

      const body = await scrape();

      expect(body).toContain('route="unmatched"');
      expect(body).not.toContain('definitely-not-a-route');
    });

    it('counts 4xx as volume and not as an error', async () => {
      // A client being told no is the system working. Counting it as an error
      // makes the error rate a measure of how many people mistype a password.
      const before = await scrape();
      const errorsBefore = /http_errors_total\{[^}]*\} (\d+)/.exec(before)?.[1] ?? '0';

      await harness.app.inject({ method: 'GET', url: '/v1/children' });

      const after = await scrape();
      const errorsAfter = /http_errors_total\{[^}]*\} (\d+)/.exec(after)?.[1] ?? '0';

      expect(Number(errorsAfter)).toBe(Number(errorsBefore));
      expect(after).toContain('status="4xx"');
    });
  });

  /* ======================================================================== */
  /* Request identifiers and structured logging                               */
  /* ======================================================================== */

  describe('request identifiers', () => {
    it('gives every response a request id', async () => {
      const response = await harness.app.inject({
        method: 'GET',
        url: '/v1/children',
        headers: authHeader(parent.accessToken),
      });

      expect(response.headers['x-request-id']).toBeDefined();
    });

    it('gives a failing request one too, so a parent can quote it', async () => {
      const response = await harness.app.inject({ method: 'GET', url: '/v1/children' });

      expect(response.statusCode).toBe(401);
      expect(response.headers['x-request-id']).toBeDefined();
      // And the body carries it, which is what makes a support conversation
      // possible without asking anyone to reproduce anything.
      expect(response.json<{ error: { requestId?: string } }>().error.requestId).toBeDefined();
    });
  });

  /* ======================================================================== */
  /* Product metrics                                                          */
  /* ======================================================================== */

  describe('product metrics', () => {
    beforeAll(() => {
      /* An hour later, an operator opens the dashboard.
       *
       * The harness clock is frozen at construction, so without this every row
       * created during setup sits in the future relative to the application
       * clock and every metrics window is empty. Real time passes between a
       * signup and somebody looking at a chart. */
      harness.setNow(new Date(Date.now() + 60 * 60 * 1000));
    });

    it('refuses a parent', async () => {
      // Aggregate business metrics are staff-only. A parent has no business
      // reading them, and there is no permission that grants it to one.
      const response = await harness.app.inject({
        method: 'GET',
        url: '/api/admin/metrics/product',
        headers: authHeader(parent.accessToken),
      });

      expect(response.statusCode).toBe(403);
    });

    it('refuses an unauthenticated caller', async () => {
      const response = await harness.app.inject({
        method: 'GET',
        url: '/api/admin/metrics/product',
      });

      expect(response.statusCode).toBe(401);
    });

    it('answers every metric the brief names, for staff', async () => {
      await harness.db.query(`update parents set role = 'admin' where id = $1`, [parent.parentId]);

      const login = await harness.app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { email: parent.email, password: 'correct-horse-battery-staple-01' },
      });

      const response = await harness.app.inject({
        method: 'GET',
        url: '/api/admin/metrics/product?days=30',
        headers: authHeader(login.json<{ accessToken: string }>().accessToken),
      });

      expect(response.statusCode).toBe(200);
      const body = response.json<{
        activation: { registered: number; addedAChild: number; firstConversation: number };
        conversations: { started: number; medianSeconds: number };
        featureAdoption: { feature: string }[];
        retention: unknown[];
        revenue: { mrrMinor: number; arrMinor: number; totalAccounts: number };
        churn: { voluntaryCancellations: number; involuntaryExpiries: number };
        note: string;
      }>();

      // Activation.
      expect(body.activation.registered).toBeGreaterThanOrEqual(1);
      expect(body.activation.addedAChild).toBeGreaterThanOrEqual(1);
      // Conversation completion and session duration.
      expect(body.conversations).toHaveProperty('started');
      expect(body.conversations).toHaveProperty('medianSeconds');
      // Feature adoption.
      expect(body.featureAdoption.map((entry) => entry.feature)).toContain('conversations');
      // Retention, conversion, churn, MRR, ARR.
      expect(Array.isArray(body.retention)).toBe(true);
      expect(body.revenue).toHaveProperty('mrrMinor');
      expect(body.revenue).toHaveProperty('arrMinor');
      expect(body.churn).toHaveProperty('voluntaryCancellations');
      // Voluntary and involuntary churn kept apart: one is a product problem,
      // the other a payments problem.
      expect(body.churn).toHaveProperty('involuntaryExpiries');
    });

    /**
     * ═══════════════════════════════════════════════════════════════════════
     * EVERY NUMBER IS AN AGGREGATE. NOTHING IDENTIFIES ANYBODY.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * There is no parameter through which a caller could ask about one family,
     * and the response body carries no identifier of any kind — which is what
     * makes "answer product questions without tracking children" true rather
     * than merely intended.
     */
    it('returns aggregates and nothing that identifies a person', async () => {
      const login = await harness.app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { email: parent.email, password: 'correct-horse-battery-staple-01' },
      });

      const response = await harness.app.inject({
        method: 'GET',
        url: '/api/admin/metrics/product',
        headers: authHeader(login.json<{ accessToken: string }>().accessToken),
      });

      expect(response.body).not.toContain(parent.parentId);
      expect(response.body).not.toContain(parent.email);
      expect(response.body).not.toContain(childId);
      expect(response.body).not.toContain('Rumi');
      expect(response.body).not.toMatch(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
      );

      // And it says out loud what it is not.
      expect(response.json<{ note: string }>().note).toContain('what a');
    });
  });

  /* ======================================================================== */
  /* Alerts                                                                   */
  /* ======================================================================== */

  describe('operational health', () => {
    it('is staff-only', async () => {
      const response = await harness.app.inject({
        method: 'GET',
        url: '/api/admin/health/detailed',
      });

      expect(response.statusCode).toBe(401);
    });

    it('reports healthy with live latency figures', async () => {
      const login = await harness.app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { email: parent.email, password: 'correct-horse-battery-staple-01' },
      });

      const response = await harness.app.inject({
        method: 'GET',
        url: '/api/admin/health/detailed',
        headers: authHeader(login.json<{ accessToken: string }>().accessToken),
      });

      expect(response.statusCode).toBe(200);
      const body = response.json<{
        healthy: boolean;
        alerts: unknown[];
        latency: { p99: number; sampleCount: number };
      }>();

      expect(body.healthy).toBe(true);
      expect(body.alerts).toEqual([]);
      expect(body.latency.sampleCount).toBeGreaterThan(0);
    });
  });
});
