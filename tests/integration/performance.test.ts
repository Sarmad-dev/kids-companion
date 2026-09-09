import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  authHeader,
  createApiHarness,
  registerAndLogin,
  type ApiHarness,
  type RegisteredParent,
} from '../helpers/api.js';

/**
 * Performance.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * QUERY COUNTS, NOT STOPWATCHES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A wall-clock assertion in CI is a flaky test waiting to happen: the machine
 * is shared, the JIT is cold, and the number that fails at 3 a.m. is the CI
 * runner's, not the code's. So the load-bearing assertions here count DATABASE
 * STATEMENTS, which are deterministic, hardware-independent, and the thing that
 * actually degrades — an N+1 is invisible with three rows and fatal with three
 * hundred.
 *
 * Timing assertions exist too, but with ceilings so generous that only a real
 * pathology trips them. They are a smoke alarm, not a stopwatch.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THIS CANNOT TELL YOU
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * PGlite is Postgres compiled to WebAssembly on a single connection. It has no
 * connection pool, no concurrent backends, no network, and different planner
 * costs from a real server. Nothing here is a load test, and nothing here
 * predicts production latency. What it catches is the class of regression where
 * a loop grows a query — which is the one that reaches production unnoticed.
 */

const budget = <T>(label: string, ms: number, fn: () => Promise<T>): Promise<T> =>
  (async () => {
    const started = process.hrtime.bigint();
    const value = await fn();
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;

    expect(elapsedMs, `${label} took ${elapsedMs.toFixed(0)}ms`).toBeLessThan(ms);
    return value;
  })();

describe('performance', () => {
  let harness: ApiHarness;
  let parent: RegisteredParent;
  let childId: string;

  beforeAll(async () => {
    harness = await createApiHarness();
    parent = await registerAndLogin(harness, 'perf');

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

    for (const [type, scoped] of [
      ['terms_of_service', undefined],
      ['privacy_policy', undefined],
      ['child_data_processing', childId],
    ] as const) {
      await harness.app.inject({
        method: 'POST',
        url: '/v1/consent',
        headers: authHeader(parent.accessToken),
        payload: {
          consentType: type,
          granted: true,
          policyVersion: '2026-08-01',
          policyText: 'We process speech to reply.',
          ...(scoped === undefined ? {} : { childId: scoped }),
        },
      });
    }
  });

  afterAll(async () => {
    await harness.close();
  });

  /* ======================================================================== */
  /* N+1 detection                                                            */
  /* ======================================================================== */

  describe('query counts do not grow with the data', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE ONE ASSERTION THAT CATCHES THE BUG THAT REACHES PRODUCTION.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * An N+1 is invisible in development, where every account has two rows, and
     * it is a catastrophe in production, where one has two hundred. Comparing
     * the query count at two data sizes catches it before anybody feels it.
     */
    it('lists conversations in a constant number of queries', async () => {
      const headers = authHeader(parent.accessToken);

      const conversationIds: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        const started = await harness.app.inject({
          method: 'POST',
          url: '/api/conversations/start',
          headers,
          payload: { childId },
        });
        if (started.statusCode !== 201) break;
        const id = started.json<{ id: string }>().id;
        conversationIds.push(id);
        await harness.app.inject({
          method: 'POST',
          url: `/api/conversations/${id}/end`,
          headers,
          payload: {},
        });
      }

      harness.database.reset();
      await harness.app.inject({
        method: 'GET',
        url: `/api/conversations?childId=${childId}`,
        headers,
      });
      const withFew = harness.database.count();

      for (let i = 0; i < 6; i += 1) {
        const started = await harness.app.inject({
          method: 'POST',
          url: '/api/conversations/start',
          headers,
          payload: { childId },
        });
        if (started.statusCode !== 201) break;
        await harness.app.inject({
          method: 'POST',
          url: `/api/conversations/${started.json<{ id: string }>().id}/end`,
          headers,
          payload: {},
        });
      }

      harness.database.reset();
      await harness.app.inject({
        method: 'GET',
        url: `/api/conversations?childId=${childId}`,
        headers,
      });
      const withMore = harness.database.count();

      expect(
        withMore,
        `query count grew from ${String(withFew)} to ${String(withMore)} as rows were added — ` +
          `that is an N+1:\n${harness.database.statements().join('\n')}`,
      ).toBeLessThanOrEqual(withFew);
    });

    it('renders the parent dashboard in a bounded number of queries', async () => {
      const headers = authHeader(parent.accessToken);

      harness.database.reset();
      const response = await harness.app.inject({
        method: 'GET',
        url: `/api/parent/dashboard/${childId}`,
        headers,
      });
      const used = harness.database.count();

      expect(response.statusCode).toBe(200);
      // The dashboard genuinely reads several tables — activity, levels,
      // milestones, safety counts, controls. A generous ceiling that still
      // catches a loop.
      expect(
        used,
        `dashboard issued ${String(used)} queries:\n${harness.database.statements().join('\n')}`,
      ).toBeLessThan(25);
    });

    it('lists children in a bounded number of queries regardless of count', async () => {
      const headers = authHeader(parent.accessToken);

      harness.database.reset();
      await harness.app.inject({ method: 'GET', url: '/v1/children', headers });
      const withOne = harness.database.count();

      for (let i = 0; i < 3; i += 1) {
        await harness.app.inject({
          method: 'POST',
          url: '/v1/children',
          headers,
          payload: {
            displayName: `Extra ${String(i)}`,
            birthYear: 2019,
            birthMonth: 3,
            languages: [{ languageCode: 'en', isPrimary: true }],
          },
        });
      }

      harness.database.reset();
      await harness.app.inject({ method: 'GET', url: '/v1/children', headers });
      const withFour = harness.database.count();

      expect(
        withFour,
        `children list grew from ${String(withOne)} to ${String(withFour)} queries`,
      ).toBeLessThanOrEqual(withOne);
    });
  });

  /* ======================================================================== */
  /* Payload bounds                                                           */
  /* ======================================================================== */

  describe('responses stay bounded', () => {
    it('caps a conversation list rather than returning everything', async () => {
      // An unbounded list is a denial of service that a legitimate customer
      // triggers by using the product for a year.
      const response = await harness.app.inject({
        method: 'GET',
        url: `/api/conversations?childId=${childId}&limit=1000`,
        headers: authHeader(parent.accessToken),
      });

      expect(response.statusCode).toBe(400);
    });

    it('keeps a dashboard response small enough for a phone on 3G', async () => {
      const response = await harness.app.inject({
        method: 'GET',
        url: `/api/parent/dashboard/${childId}`,
        headers: authHeader(parent.accessToken),
      });

      // 256 KB is enormous for this payload; anything approaching it means an
      // unbounded array crept in.
      expect(Buffer.byteLength(response.body)).toBeLessThan(256 * 1024);
    });

    it('bounds the metrics scrape', async () => {
      // Cardinality explosions show up here first: one series per child would
      // make this grow without limit.
      const response = await harness.app.inject({ method: 'GET', url: '/metrics' });

      expect(Buffer.byteLength(response.body)).toBeLessThan(512 * 1024);
    });
  });

  /* ======================================================================== */
  /* Latency smoke alarms                                                     */
  /* ======================================================================== */

  describe('latency', () => {
    /* Ceilings chosen to catch a pathology, not to measure performance. A
     * shared CI runner is not a benchmark environment, and a tight assertion
     * here would fail for reasons that have nothing to do with the code. */

    it('answers a health check promptly', async () => {
      await budget('health', 1_000, async () =>
        harness.app.inject({ method: 'GET', url: '/health' }),
      );
    });

    it('serves an authenticated read without pathological delay', async () => {
      await budget('children list', 3_000, async () =>
        harness.app.inject({
          method: 'GET',
          url: '/v1/children',
          headers: authHeader(parent.accessToken),
        }),
      );
    });

    it('renders the dashboard without pathological delay', async () => {
      await budget('dashboard', 5_000, async () =>
        harness.app.inject({
          method: 'GET',
          url: `/api/parent/dashboard/${childId}`,
          headers: authHeader(parent.accessToken),
        }),
      );
    });

    it('handles a burst of reads without degrading disproportionately', async () => {
      const headers = authHeader(parent.accessToken);

      const single = process.hrtime.bigint();
      await harness.app.inject({ method: 'GET', url: '/v1/children', headers });
      const singleMs = Number(process.hrtime.bigint() - single) / 1_000_000;

      const burst = process.hrtime.bigint();
      await Promise.all(
        Array.from({ length: 20 }, async () =>
          harness.app.inject({ method: 'GET', url: '/v1/children', headers }),
        ),
      );
      const burstMs = Number(process.hrtime.bigint() - burst) / 1_000_000;

      /* Twenty requests should not cost more than sixty times one.
       *
       * Deliberately loose. PGlite serialises everything on one connection, so
       * this cannot demonstrate concurrency — what it catches is quadratic
       * behaviour, where each additional request makes every other one slower.
       */
      expect(
        burstMs,
        `one read took ${singleMs.toFixed(0)}ms; twenty took ${burstMs.toFixed(0)}ms`,
      ).toBeLessThan(Math.max(singleMs * 60, 10_000));
    });
  });

  /* ======================================================================== */
  /* Metrics record what happened                                             */
  /* ======================================================================== */

  describe('the metrics agree with reality', () => {
    it('records a duration for every request it served', async () => {
      const response = await harness.app.inject({ method: 'GET', url: '/metrics' });

      expect(response.body).toContain('http_request_duration_ms');
      expect(response.body).toContain('http_requests_total');
      // A count of zero after this file has driven hundreds of requests would
      // mean the plugin is not wired, which no other test would notice.
      expect(response.body).toMatch(/http_requests_total\{[^}]*\} [1-9]/);
    });
  });
});
