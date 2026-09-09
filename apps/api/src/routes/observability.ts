import { TECHNICAL_METRICS, type MetricsRegistry } from '@kids/analytics';
import { asSystem, type Database } from '@kids/db';
import type { Clock } from '@kids/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

import type { AlertMonitor } from '../alerts.js';
import type { ErrorTracker } from '../error-tracking.js';

/**
 * Observability endpoints.
 *
 *   GET /metrics                     Prometheus scrape. Technical only.
 *   GET /api/admin/metrics/product   product metrics, staff only, aggregate only
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * TWO ENDPOINTS, TWO AUDIENCES, TWO ENTIRELY DIFFERENT AUTHORISATION RULES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `/metrics` is scraped by infrastructure and carries no personal data at all —
 * the label guard in `@kids/analytics` makes that structural rather than
 * conventional. It sits outside `/api` because it is not part of the product's
 * API surface, and it is unauthenticated for the same reason every metrics
 * endpoint is: the scraper has no session, and network policy is what keeps it
 * private.
 *
 * The product endpoint is the opposite. It answers questions about the
 * business, it requires a staff permission, and every number it returns is an
 * aggregate computed inside our own database. There is no parameter through
 * which a caller could ask about one family, and nothing it returns identifies
 * anybody.
 */

export interface ObservabilityRoutesOptions {
  readonly db: Database;
  readonly registry: MetricsRegistry;
  readonly alerts: AlertMonitor;
  /** Aggregated failures, for the console an operator opens after a page. */
  readonly errors?: ErrorTracker;
  readonly clock: Clock;
  /** Whether `/metrics` is exposed at all. */
  readonly metricsEnabled: boolean;
}

/**
 * The scrape endpoint, mounted at the root.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * SPLIT FROM THE STAFF ROUTES ON PURPOSE — SEE docs/SECURITY_AUDIT.md.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * These were one plugin registered twice: once at the root for the scrape, once
 * under `/api` for the staff endpoints. Because only the scrape was behind a
 * flag, the staff endpoints were created by both registrations and existed at
 * two paths — one of them undocumented.
 *
 * Two plugins, each registered once, makes that unrepresentable rather than
 * merely fixed.
 */
export const metricsScrapeRoutes =
  (
    options: Pick<ObservabilityRoutesOptions, 'registry' | 'alerts' | 'metricsEnabled'>,
  ): FastifyPluginAsyncZod =>
  async (app) => {
    const { registry, alerts } = options;

    if (options.metricsEnabled) {
      app.get(
        '/metrics',
        {
          schema: {
            description: 'Prometheus metrics. Technical only — no label may carry an identifier.',
            hide: true,
          },
        },
        async (_request, reply) => {
          // Evaluating here as well as on the timer means a scrape always sees
          // current alert state, and a deployment that scrapes but has no timer
          // still gets alerting.
          alerts.evaluate();

          return await reply
            .header('content-type', 'text/plain; version=0.0.4; charset=utf-8')
            // A metrics snapshot is a point in time and must never be cached by
            // anything between the scraper and us.
            .header('cache-control', 'no-store')
            .status(200)
            .send(registry.render());
        },
      );
    }
  };

/**
 * Staff endpoints, mounted under `/api`.
 *
 * Registered exactly once. Everything here requires `audit:read`, which no
 * parent role holds.
 */
export const observabilityRoutes =
  (options: Omit<ObservabilityRoutesOptions, 'metricsEnabled'>): FastifyPluginAsyncZod =>
  async (app) => {
    const { db, registry, alerts, clock } = options;

    /* ---------------------------------------------------------------------- */
    /* GET /api/admin/health/detailed                                         */
    /* ---------------------------------------------------------------------- */
    /* What is currently on fire, for an operator. Staff-only because the shape
     * of our failures is not something to publish. */

    app.get(
      '/admin/health/detailed',
      {
        onRequest: [app.authenticate],
        preHandler: [app.authorize('audit:read')],
        schema: {
          description: 'Live alert state and headline latency. Staff only.',
          response: {
            200: z.object({
              healthy: z.boolean(),
              alerts: z.array(
                z.object({
                  condition: z.string(),
                  severity: z.string(),
                  summary: z.string(),
                  firstSeenAt: z.string(),
                }),
              ),
              latency: z.object({
                p50: z.number(),
                p95: z.number(),
                p99: z.number(),
                sampleCount: z.number().int(),
              }),
              /* Aggregated, not enumerated. `newSinceBoot` is the figure worth
               * reading after a deploy: a failure nobody has seen before is
               * usually the release, and it deliberately does not page. */
              errors: z.object({
                distinct: z.number().int(),
                newSinceBoot: z.number().int(),
                total: z.number().int(),
                top: z.array(
                  z.object({
                    type: z.string(),
                    message: z.string(),
                    code: z.string(),
                    route: z.string(),
                    count: z.number().int(),
                    firstSeenAt: z.string(),
                    lastSeenAt: z.string(),
                  }),
                ),
              }),
              checkedAt: z.string(),
            }),
          },
        },
      },
      async (_request, reply) => {
        alerts.evaluate();
        const active = alerts.active();

        /* The worst percentiles across every route, and the TOTAL sample count.
         *
         * Counted separately on purpose. Taking the count from whichever route
         * happened to be slowest reported 0 whenever every route was fast — an
         * operator reading "no traffic" on a healthy system. */
        const snapshot = registry.snapshot()[TECHNICAL_METRICS.requestDuration];
        const series = Array.isArray(snapshot) ? snapshot : [];

        const worst = series.reduce<{ p50: number; p95: number; p99: number; count: number }>(
          (accumulator, entry) => {
            const row = entry as { p50?: number; p95?: number; p99?: number; count?: number };
            return {
              p50: Math.max(accumulator.p50, row.p50 ?? 0),
              p95: Math.max(accumulator.p95, row.p95 ?? 0),
              p99: Math.max(accumulator.p99, row.p99 ?? 0),
              count: accumulator.count + (row.count ?? 0),
            };
          },
          { p50: 0, p95: 0, p99: 0, count: 0 },
        );

        return await reply.status(200).send({
          healthy: active.length === 0,
          alerts: active.map((alert) => ({
            condition: alert.condition,
            severity: alert.severity,
            summary: alert.summary,
            firstSeenAt: alert.firstSeenAt,
          })),
          latency: {
            p50: worst.p50,
            p95: worst.p95,
            p99: worst.p99,
            sampleCount: worst.count,
          },
          errors: (() => {
            const summary = options.errors?.summary(5);
            return {
              distinct: summary?.distinct ?? 0,
              newSinceBoot: summary?.newSinceBoot ?? 0,
              total: summary?.total ?? 0,
              top: (summary?.top ?? []).map((entry) => ({
                type: entry.type,
                message: entry.message,
                code: entry.code,
                route: entry.route,
                count: entry.count,
                firstSeenAt: entry.firstSeenAt,
                lastSeenAt: entry.lastSeenAt,
              })),
            };
          })(),
          checkedAt: clock.nowIso(),
        });
      },
    );

    /* ---------------------------------------------------------------------- */
    /* GET /api/admin/metrics/product                                         */
    /* ---------------------------------------------------------------------- */

    app.get(
      '/admin/metrics/product',
      {
        onRequest: [app.authenticate],
        preHandler: [app.authorize('audit:read')],
        schema: {
          description:
            'Product metrics. Aggregates computed in our own database — never per child, never exported.',
          querystring: z.object({
            days: z.coerce.number().int().min(1).max(90).default(30),
          }),
          response: {
            200: z.object({
              windowDays: z.number().int(),
              activation: z.object({
                registered: z.number().int(),
                addedAChild: z.number().int(),
                grantedConsent: z.number().int(),
                firstConversation: z.number().int(),
                returnedInFirstWeek: z.number().int(),
              }),
              conversations: z.object({
                started: z.number().int(),
                completed: z.number().int(),
                abandoned: z.number().int(),
                endedByChild: z.number().int(),
                endedByLimit: z.number().int(),
                endedBySafety: z.number().int(),
                medianTurns: z.number().int(),
                medianSeconds: z.number().int(),
                p95Seconds: z.number().int(),
              }),
              featureAdoption: z.array(
                z.object({ feature: z.string(), accounts: z.number().int() }),
              ),
              retention: z.array(
                z.object({
                  cohortWeek: z.string(),
                  cohortSize: z.number().int(),
                  weekOffset: z.number().int(),
                  retained: z.number().int(),
                }),
              ),
              revenue: z.object({
                activeSubscriptions: z.number().int(),
                trialing: z.number().int(),
                inGrace: z.number().int(),
                mrrMinor: z.number().int(),
                arrMinor: z.number().int(),
                currency: z.string(),
                payingAccounts: z.number().int(),
                totalAccounts: z.number().int(),
              }),
              churn: z.object({
                voluntaryCancellations: z.number().int(),
                involuntaryExpiries: z.number().int(),
                newSubscriptions: z.number().int(),
                activeAtStart: z.number().int(),
              }),
              /** Says out loud what these numbers are not. */
              note: z.string(),
              generatedAt: z.string(),
            }),
          },
        },
      },
      async (request, reply) => {
        const { days } = request.query;
        const now = clock.nowIso();
        const since = new Date(new Date(now).getTime() - days * 86_400_000).toISOString();

        const data = await asSystem(db, async (tx) => {
          const [activation, conversations, adoption, retention, revenue, churn] =
            await Promise.all([
              tx.query<{
                registered: number;
                added_a_child: number;
                granted_consent: number;
                first_conversation: number;
                first_week_return: number;
              }>('select * from app.activation_funnel($1, $2)', [since, now]),
              tx.query<{
                started: number;
                completed: number;
                ended_by_child: number;
                ended_by_limit: number;
                ended_by_safety: number;
                abandoned: number;
                median_turns: number;
                median_seconds: number;
                p95_seconds: number;
              }>('select * from app.conversation_metrics($1, $2)', [since, now]),
              tx.query<{ feature: string; accounts: number }>(
                'select * from app.feature_adoption($1, $2)',
                [since, now],
              ),
              tx.query<{
                cohort_week: string;
                cohort_size: number;
                week_offset: number;
                retained: number;
              }>('select * from app.retention_cohorts($1, $2)', [8, now]),
              tx.query<{
                active_subscriptions: number;
                trialing: number;
                in_grace: number;
                mrr_minor: string | number;
                arr_minor: string | number;
                currency: string;
                paying_accounts: number;
                total_accounts: number;
              }>('select * from app.revenue_metrics($1)', [now]),
              tx.query<{
                voluntary_cancellations: number;
                involuntary_expiries: number;
                new_subscriptions: number;
                active_at_start: number;
              }>('select * from app.churn_metrics($1, $2)', [since, now]),
            ]);

          return {
            activation: activation.rows[0],
            conversations: conversations.rows[0],
            adoption: adoption.rows,
            retention: retention.rows,
            revenue: revenue.rows[0],
            churn: churn.rows[0],
          };
        });

        return await reply.status(200).send({
          windowDays: days,
          activation: {
            registered: data.activation?.registered ?? 0,
            addedAChild: data.activation?.added_a_child ?? 0,
            grantedConsent: data.activation?.granted_consent ?? 0,
            firstConversation: data.activation?.first_conversation ?? 0,
            returnedInFirstWeek: data.activation?.first_week_return ?? 0,
          },
          conversations: {
            started: data.conversations?.started ?? 0,
            completed: data.conversations?.completed ?? 0,
            abandoned: data.conversations?.abandoned ?? 0,
            endedByChild: data.conversations?.ended_by_child ?? 0,
            endedByLimit: data.conversations?.ended_by_limit ?? 0,
            endedBySafety: data.conversations?.ended_by_safety ?? 0,
            medianTurns: data.conversations?.median_turns ?? 0,
            medianSeconds: data.conversations?.median_seconds ?? 0,
            p95Seconds: data.conversations?.p95_seconds ?? 0,
          },
          featureAdoption: data.adoption.map((row) => ({
            feature: row.feature,
            accounts: row.accounts,
          })),
          retention: data.retention.map((row) => ({
            cohortWeek: new Date(row.cohort_week).toISOString().slice(0, 10),
            cohortSize: row.cohort_size,
            weekOffset: row.week_offset,
            retained: row.retained,
          })),
          revenue: {
            activeSubscriptions: data.revenue?.active_subscriptions ?? 0,
            trialing: data.revenue?.trialing ?? 0,
            inGrace: data.revenue?.in_grace ?? 0,
            mrrMinor: Number(data.revenue?.mrr_minor ?? 0),
            arrMinor: Number(data.revenue?.arr_minor ?? 0),
            currency: data.revenue?.currency ?? 'PKR',
            payingAccounts: data.revenue?.paying_accounts ?? 0,
            totalAccounts: data.revenue?.total_accounts ?? 0,
          },
          churn: {
            voluntaryCancellations: data.churn?.voluntary_cancellations ?? 0,
            involuntaryExpiries: data.churn?.involuntary_expiries ?? 0,
            newSubscriptions: data.churn?.new_subscriptions ?? 0,
            activeAtStart: data.churn?.active_at_start ?? 0,
          },
          note:
            'Aggregates computed in our own database. No figure here is derived from what a ' +
            'child said, and none of it is sent to a third-party analytics provider. ' +
            'Conversation length is a count, not a measure of engagement to be optimised.',
          generatedAt: now,
        });
      },
    );
  };
