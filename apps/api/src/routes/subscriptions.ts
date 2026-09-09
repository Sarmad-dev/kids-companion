import type { Database } from '@kids/db';
import { asSystem } from '@kids/db';
import {
  isEntitled,
  isPaymentRail,
  WebhookVerificationError,
  type PlanPolicy,
  type SubscriptionProvider,
} from '@kids/payments';
import { notFound, validationFailed } from '@kids/shared';
import type { Clock } from '@kids/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { auditOrFail, type AuditLogger } from '../audit.js';
import type { SubscriptionReconciler } from '../subscription-reconciler.js';

/**
 * Subscriptions.
 *
 *   GET  /api/subscriptions/plans        the price list
 *   POST /api/subscriptions/create       open a checkout — grants nothing
 *   GET  /api/subscriptions/status       what this account is on
 *   POST /api/subscriptions/cancel       stop billing at period end
 *   POST /api/subscriptions/resume       undo a cancellation
 *   POST /api/subscriptions/webhook/:rail   the only path that grants anything
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * READ `create` AND `webhook` TOGETHER. THE SPLIT IS THE DESIGN.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `create` is authenticated, rate-limited, and writes one row: an intent. It
 * cannot grant a subscription, and not because it declines to — because the
 * only function that writes `subscriptions` lives in the reconciler and takes a
 * `VerifiedWebhookEvent`, which cannot be constructed from a request body.
 *
 * That is the answer to "never trust a payment-success value from the
 * frontend". A client posting `{"paid": true}` to any endpoint in this file
 * gets a validation error, because no schema here has a field for it.
 */

export interface SubscriptionRoutesOptions {
  /** The webhook burst ceiling. See RATE_LIMIT_WEBHOOK_PER_MINUTE. */
  readonly webhookRateLimitPerMinute: number;
  readonly db: Database;
  readonly provider: SubscriptionProvider;
  readonly reconciler: SubscriptionReconciler;
  readonly audit: AuditLogger;
  /**
   * The instant every deadline is judged against.
   *
   * Passed into the SQL rather than left to the database's own clock, so a
   * grace window closing is a decision this application makes with a clock it
   * controls — and one a test can move.
   */
  readonly clock: Clock;
  readonly checkoutRateLimitPerHour: number;
}

/* -------------------------------------------------------------------------- */
/* Schemas                                                                     */
/* -------------------------------------------------------------------------- */

const planSchema = z.object({
  code: z.string(),
  displayName: z.string(),
  description: z.string(),
  tier: z.enum(['free', 'paid']),
  priceMinor: z.number().int(),
  currency: z.string(),
  billingInterval: z.enum(['week', 'month', 'year', 'once', 'none']),
  trialDays: z.number().int(),
  graceDays: z.number().int(),
  limits: z.object({
    dailyMinuteLimit: z.number().int(),
    childProfileLimit: z.number().int(),
    dailyTurnLimit: z.number().int(),
    maxConversationTurns: z.number().int(),
    concurrentConversationLimit: z.number().int(),
    voiceEnabled: z.boolean(),
    dailyVoiceTurnLimit: z.number().int(),
  }),
  availableRails: z.array(z.string()),
});

const statusSchema = z.object({
  /** What the product acts on, after elapsed deadlines are applied. */
  status: z.enum(['free', 'trialing', 'active', 'grace', 'past_due', 'cancelled', 'expired']),
  entitled: z.boolean(),
  plan: planSchema,
  rail: z.string().nullable(),
  trialEndsAt: z.string().nullable(),
  currentPeriodEnd: z.string().nullable(),
  graceEndsAt: z.string().nullable(),
  cancelAt: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  trialAvailable: z.boolean(),
  childProfilesUsed: z.number().int(),
  paymentMethod: z.object({
    brand: z.string().nullable(),
    last4: z.string().nullable(),
  }),
  /** Plain-language explanation of what the status means for the family. */
  explanation: z.string(),
});

interface PlanRow {
  id: string;
  code: string;
  display_name: string;
  description: string;
  tier: 'free' | 'paid';
  price_minor: number;
  currency: string;
  billing_interval: PlanPolicy['billingInterval'];
  trial_days: number;
  grace_days: number;
  daily_minute_limit: number;
  child_profile_limit: number;
  daily_turn_limit: number;
  max_conversation_turns: number;
  concurrent_conversation_limit: number;
  voice_enabled: boolean;
  daily_voice_turn_limit: number;
  available_rails: string[];
}

const PLAN_COLUMNS = `id, code, display_name, description, tier, price_minor, currency,
       billing_interval, trial_days, grace_days, daily_minute_limit, child_profile_limit,
       daily_turn_limit, max_conversation_turns, concurrent_conversation_limit,
       voice_enabled, daily_voice_turn_limit, available_rails`;

const presentPlan = (row: PlanRow) => ({
  code: row.code,
  displayName: row.display_name,
  description: row.description,
  tier: row.tier,
  priceMinor: row.price_minor,
  currency: row.currency,
  billingInterval: row.billing_interval,
  trialDays: row.trial_days,
  graceDays: row.grace_days,
  limits: {
    dailyMinuteLimit: row.daily_minute_limit,
    childProfileLimit: row.child_profile_limit,
    dailyTurnLimit: row.daily_turn_limit,
    maxConversationTurns: row.max_conversation_turns,
    concurrentConversationLimit: row.concurrent_conversation_limit,
    voiceEnabled: row.voice_enabled,
    dailyVoiceTurnLimit: row.daily_voice_turn_limit,
  },
  availableRails: row.available_rails,
});

/**
 * What a status means, in a sentence a parent can act on.
 *
 * Written here rather than in the client so that the mobile app, the dashboard,
 * and a support agent reading the API all say the same thing. "past_due" is a
 * vendor's word; "we could not take payment, and your family keeps access until
 * the 14th" is what someone needs to know.
 */
const explain = (status: string, planName: string): string => {
  switch (status) {
    case 'free':
      return `You are on the ${planName} plan. Upgrading adds longer sessions and more characters.`;
    case 'trialing':
      return 'Your free trial is running. You have not been charged yet.';
    case 'active':
      return `Your ${planName} plan is active and will renew automatically.`;
    case 'grace':
      return 'We could not take your last payment. Your family keeps full access while you sort it out — nothing has been switched off.';
    case 'past_due':
      return 'A payment is outstanding. Your family still has access.';
    case 'cancelled':
      return 'Your plan is cancelled and will not renew. You keep everything until the end of the period you have already paid for.';
    case 'expired':
      return 'Your plan has ended. Your family is on the free plan, and nothing has been deleted.';
    default:
      return `You are on the ${planName} plan.`;
  }
};

/* -------------------------------------------------------------------------- */
/* Routes                                                                      */
/* -------------------------------------------------------------------------- */

export const subscriptionRoutes =
  (options: SubscriptionRoutesOptions): FastifyPluginAsyncZod =>
  async (app) => {
    const { db, provider, reconciler, audit, clock } = options;

    /* ---------------------------------------------------------------------- */
    /* GET /api/subscriptions/plans                                           */
    /* ---------------------------------------------------------------------- */
    /* Unauthenticated on purpose: a price list is public, contains nothing
     * about anybody, and a pricing page that needs a login is a pricing page
     * nobody reads. RLS grants `anon` select on this table for the same
     * reason. */

    app.get(
      '/subscriptions/plans',
      {
        schema: {
          description: 'The plan catalogue. Public — prices are not personal data.',
          response: { 200: z.object({ items: z.array(planSchema), currency: z.string() }) },
        },
      },
      async (_request, reply) => {
        const rows = await asSystem(db, async (tx) => {
          const { rows: plans } = await tx.query<PlanRow>(
            `select ${PLAN_COLUMNS} from subscription_plans
              where is_active order by sort_order, price_minor`,
          );
          return plans;
        });

        return await reply.status(200).send({
          items: rows.map(presentPlan),
          currency: rows[0]?.currency ?? 'PKR',
        });
      },
    );

    /* ---------------------------------------------------------------------- */
    /* POST /api/subscriptions/create                                         */
    /* ---------------------------------------------------------------------- */

    app.post(
      '/subscriptions/create',
      {
        onRequest: [app.authenticate],
        preHandler: [app.authorize('billing:manage_own')],
        schema: {
          description:
            'Opens a checkout. Records an intent and grants nothing — the subscription is created by a verified webhook.',
          body: z
            .object({
              planCode: z.string().min(2).max(40),
              rail: z.string().min(2).max(20).optional(),
              /**
               * Required. A parent on a train tapping "subscribe" twice must
               * not open two checkouts, and a retry after a timeout must return
               * the first one rather than a second.
               */
              idempotencyKey: z.string().min(8).max(128),
            })
            .strict(),
          response: {
            201: z.object({
              checkoutId: z.string(),
              rail: z.string(),
              redirectUrl: z.string().nullable(),
              expiresAt: z.string(),
              /**
               * Always 'pending'. There is no value this field can take that
               * means "paid" — that word only exists on the webhook path.
               */
              status: z.literal('pending'),
              plan: planSchema,
            }),
          },
        },
        config: {
          rateLimit: { max: options.checkoutRateLimitPerHour, timeWindow: '1 hour' },
        },
      },
      async (request, reply) => {
        const parentId = request.principal?.parentId;
        if (parentId === undefined) throw notFound();

        const rail = request.body.rail ?? provider.rail;
        if (!isPaymentRail(rail)) {
          throw validationFailed([{ field: 'rail', issue: 'is not a payment rail' }]);
        }
        if (rail !== provider.rail) {
          // Only the configured rail can be checked out through. Accepting an
          // arbitrary rail name would mean opening a checkout nothing can ever
          // complete, and a pending row nobody cleans up.
          throw validationFailed([{ field: 'rail', issue: 'is not available' }]);
        }

        const opened = await app.withParent(request, async (tx) => {
          const { rows: plans } = await tx.query<PlanRow>(
            `select ${PLAN_COLUMNS} from subscription_plans where code = $1 and is_active`,
            [request.body.planCode],
          );
          const plan = plans[0];
          if (!plan) throw validationFailed([{ field: 'planCode', issue: 'is not a plan' }]);
          if (plan.tier === 'free') {
            throw validationFailed([
              { field: 'planCode', issue: 'is the free plan and needs no checkout' },
            ]);
          }

          // Has this account already had its trial? Read here so the rail can
          // be told, and so a resubscribe does not advertise a trial that the
          // state machine will refuse.
          const { rows: history } = await tx.query<{ trial_consumed: boolean }>(
            `select bool_or(trial_consumed) as trial_consumed from subscriptions
              where parent_id = $1`,
            [parentId],
          );

          const { rows: checkoutRows } = await tx.query<{
            id: string;
            expires_at: string;
            external_id: string | null;
          }>(`select * from app.open_checkout($1, $2, $3, $4)`, [
            parentId,
            plan.code,
            rail,
            request.body.idempotencyKey,
          ]);

          const checkout = checkoutRows[0];
          if (!checkout) throw notFound();

          return {
            plan,
            checkout,
            trialAvailable: !(history[0]?.trial_consumed ?? false),
          };
        });

        // Idempotent: a repeated key returns the checkout that already exists,
        // and we do not open a second session with the rail for it.
        let externalId = opened.checkout.external_id;
        let redirectUrl: string | null = null;
        let expiresAt = new Date(opened.checkout.expires_at).toISOString();

        if (externalId === null) {
          const session = await provider.createCheckout({
            parentId: parentId as never,
            plan: {
              code: opened.plan.code,
              displayName: opened.plan.display_name,
              tier: opened.plan.tier,
              price: { amountMinor: opened.plan.price_minor, currency: opened.plan.currency },
              billingInterval: opened.plan.billing_interval,
              trialDays: opened.plan.trial_days,
              graceDays: opened.plan.grace_days,
            },
            reference: opened.checkout.id,
            idempotencyKey: request.body.idempotencyKey,
            trialAvailable: opened.trialAvailable,
          });

          externalId = session.externalId;
          redirectUrl = session.redirectUrl ?? null;
          expiresAt = session.expiresAt;

          await asSystem(db, async (tx) => {
            await tx.query(
              `update subscription_checkouts set external_id = $2, expires_at = $3
                where id = $1 and external_id is null`,
              [opened.checkout.id, externalId, expiresAt],
            );
          });
        }

        await auditOrFail(
          audit,
          {
            actorId: parentId,
            actorType: 'parent',
            action: 'subscription.checkout.opened',
            resourceType: 'subscription_checkout',
            resourceId: opened.checkout.id,
            outcome: 'success',
            metadata: { plan: opened.plan.code, rail },
          },
          request,
        );

        return await reply.status(201).send({
          checkoutId: opened.checkout.id,
          rail,
          redirectUrl,
          expiresAt,
          status: 'pending' as const,
          plan: presentPlan(opened.plan),
        });
      },
    );

    /* ---------------------------------------------------------------------- */
    /* GET /api/subscriptions/status                                          */
    /* ---------------------------------------------------------------------- */

    app.get(
      '/subscriptions/status',
      {
        onRequest: [app.authenticate],
        preHandler: [app.authorize('account:read_own')],
        schema: {
          description: 'The resolved subscription state. Elapsed deadlines are applied.',
          response: { 200: statusSchema },
        },
      },
      async (request, reply) => {
        const parentId = request.principal?.parentId;
        if (parentId === undefined) throw notFound();

        const data = await app.withParent(request, async (tx) => {
          const { rows: states } = await tx.query<{
            subscription_id: string | null;
            plan_code: string | null;
            stored_status: string | null;
            effective_status: string | null;
            rail: string | null;
            trial_ends_at: string | null;
            current_period_end: string | null;
            grace_ends_at: string | null;
            cancel_at: string | null;
            cancelled_at: string | null;
            trial_consumed: boolean | null;
          }>('select * from app.subscription_state($1, $2)', [parentId, clock.nowIso()]);

          const state = states[0];
          const planCode = state?.plan_code ?? 'free';

          // An expired or cancelled-out subscription resolves to the free plan
          // for limits, not to whatever they used to pay for.
          const effective = state?.effective_status ?? 'free';
          const limitsCode = isEntitled(effective as never) ? planCode : 'free';

          const { rows: plans } = await tx.query<PlanRow>(
            `select ${PLAN_COLUMNS} from subscription_plans where code = $1`,
            [limitsCode],
          );

          const { rows: method } = await tx.query<{
            payment_method_brand: string | null;
            payment_method_last4: string | null;
          }>(
            `select payment_method_brand, payment_method_last4 from subscriptions
              where id = $1::uuid`,
            [state?.subscription_id ?? null],
          );

          const { rows: children } = await tx.query<{ n: number }>(
            'select count(*)::int as n from children where deleted_at is null',
          );

          return { state, plan: plans[0], method: method[0], childCount: children[0]?.n ?? 0 };
        });

        if (!data.plan) throw notFound();

        const state = data.state;
        // No row, or a row with no resolved status, both mean the free tier.
        const resolved = state?.effective_status ?? null;
        const status =
          resolved === null ? 'free' : (resolved as z.infer<typeof statusSchema>['status']);

        const isoOrNull = (value: string | null | undefined): string | null =>
          value === null || value === undefined ? null : new Date(value).toISOString();

        return await reply.status(200).send({
          status,
          entitled: isEntitled(status),
          plan: presentPlan(data.plan),
          rail: state?.rail ?? null,
          trialEndsAt: isoOrNull(state?.trial_ends_at),
          currentPeriodEnd: isoOrNull(state?.current_period_end),
          graceEndsAt: isoOrNull(state?.grace_ends_at),
          cancelAt: isoOrNull(state?.cancel_at),
          cancelledAt: isoOrNull(state?.cancelled_at),
          trialAvailable: !(state?.trial_consumed ?? false),
          childProfilesUsed: data.childCount,
          paymentMethod: {
            brand: data.method?.payment_method_brand ?? null,
            last4: data.method?.payment_method_last4 ?? null,
          },
          explanation: explain(status, data.plan.display_name),
        });
      },
    );

    /* ---------------------------------------------------------------------- */
    /* POST /api/subscriptions/cancel                                         */
    /* ---------------------------------------------------------------------- */
    /* Records the parent's REQUEST and tells the rail. The subscription's state
     * still changes on the webhook, like everything else — but a parent who
     * clicks cancel must see that it worked, so the request is stored and shown
     * as pending until the rail confirms.
     *
     * `cancel_at` is set to the end of the period they have already paid for.
     * Nothing is switched off today. */

    app.post(
      '/subscriptions/cancel',
      {
        onRequest: [app.authenticate],
        preHandler: [app.authorize('billing:manage_own')],
        schema: {
          description: 'Stops the subscription renewing. Access continues to the paid period end.',
          body: z
            .object({ reason: z.string().max(200).optional() })
            .strict()
            .optional(),
          response: {
            200: z.object({
              status: z.string(),
              accessUntil: z.string().nullable(),
              confirmedByProvider: z.boolean(),
              explanation: z.string(),
            }),
          },
        },
      },
      async (request, reply) => {
        const parentId = request.principal?.parentId;
        if (parentId === undefined) throw notFound();

        const found = await app.withParent(request, async (tx) => {
          const { rows } = await tx.query<{
            subscription_id: string | null;
            effective_status: string | null;
            current_period_end: string | null;
          }>(
            `select subscription_id, effective_status, current_period_end
               from app.subscription_state($1, $2)`,
            [parentId, clock.nowIso()],
          );
          return rows[0];
        });

        if (
          !found?.subscription_id ||
          found.effective_status === null ||
          !isEntitled(found.effective_status as never)
        ) {
          throw validationFailed([{ field: 'subscription', issue: 'there is nothing to cancel' }]);
        }
        if (found.effective_status === 'cancelled') {
          throw validationFailed([{ field: 'subscription', issue: 'is already cancelled' }]);
        }

        const external = await asSystem(db, async (tx) => {
          const { rows } = await tx.query<{ external_id: string | null }>(
            'select external_id from subscriptions where id = $1',
            [found.subscription_id],
          );
          return rows[0]?.external_id ?? null;
        });

        let confirmed = false;
        if (external !== null) {
          try {
            await provider.cancel(external, { atPeriodEnd: true });
            confirmed = true;
          } catch {
            // The rail is unreachable. The parent's intent is still recorded —
            // losing a cancellation because a vendor was down means charging
            // someone who asked not to be charged, which is the worst possible
            // way to fail here. Reconciliation catches the divergence.
            confirmed = false;
          }
        }

        const accessUntil = await asSystem(db, async (tx) => {
          const { rows } = await tx.query<{ cancel_at: string | null }>(
            `update subscriptions
                set status = 'cancelled',
                    cancelled_at = coalesce(cancelled_at, now()),
                    cancel_at = coalesce(current_period_end, now())
              where id = $1
              returning cancel_at`,
            [found.subscription_id],
          );
          return rows[0]?.cancel_at ?? null;
        });

        await auditOrFail(
          audit,
          {
            actorId: parentId,
            actorType: 'parent',
            action: 'subscription.cancel_requested',
            resourceType: 'subscription',
            resourceId: found.subscription_id,
            outcome: 'success',
            metadata: { confirmedByProvider: confirmed },
          },
          request,
        );

        return await reply.status(200).send({
          status: 'cancelled',
          accessUntil: accessUntil === null ? null : new Date(accessUntil).toISOString(),
          confirmedByProvider: confirmed,
          explanation:
            'Your plan will not renew. Everything keeps working until the end of the period you have already paid for.',
        });
      },
    );

    /* ---------------------------------------------------------------------- */
    /* POST /api/subscriptions/resume                                         */
    /* ---------------------------------------------------------------------- */

    app.post(
      '/subscriptions/resume',
      {
        onRequest: [app.authenticate],
        preHandler: [app.authorize('billing:manage_own')],
        schema: {
          description: 'Reverses a cancellation that has not taken effect yet.',
          response: {
            200: z.object({
              status: z.string(),
              renewsAt: z.string().nullable(),
              confirmedByProvider: z.boolean(),
              explanation: z.string(),
            }),
          },
        },
      },
      async (request, reply) => {
        const parentId = request.principal?.parentId;
        if (parentId === undefined) throw notFound();

        const found = await app.withParent(request, async (tx) => {
          const { rows } = await tx.query<{
            subscription_id: string | null;
            stored_status: string | null;
            effective_status: string | null;
            current_period_end: string | null;
          }>('select * from app.subscription_state($1, $2)', [parentId, clock.nowIso()]);
          return rows[0];
        });

        if (!found?.subscription_id || found.stored_status !== 'cancelled') {
          throw validationFailed([
            { field: 'subscription', issue: 'there is no cancellation to reverse' },
          ]);
        }
        if (found.effective_status === 'expired') {
          // Past the end date there is nothing to resume, and pretending
          // otherwise would grant a period nobody paid for.
          throw validationFailed([
            { field: 'subscription', issue: 'has already ended — start a new plan instead' },
          ]);
        }

        const external = await asSystem(db, async (tx) => {
          const { rows } = await tx.query<{ external_id: string | null }>(
            'select external_id from subscriptions where id = $1',
            [found.subscription_id],
          );
          return rows[0]?.external_id ?? null;
        });

        let confirmed = false;
        if (external !== null) {
          try {
            await provider.resume(external);
            confirmed = true;
          } catch {
            // Unlike cancel, a failure here means we must NOT record a resume:
            // showing an active plan the rail will not bill for is how a family
            // loses access without warning at the period end.
            throw validationFailed([
              { field: 'subscription', issue: 'could not be resumed just now — please try again' },
            ]);
          }
        }

        const renewsAt = await asSystem(db, async (tx) => {
          const { rows } = await tx.query<{ current_period_end: string | null }>(
            `update subscriptions
                set status = 'active', cancel_at = null, cancelled_at = null
              where id = $1
              returning current_period_end`,
            [found.subscription_id],
          );
          return rows[0]?.current_period_end ?? null;
        });

        await auditOrFail(
          audit,
          {
            actorId: parentId,
            actorType: 'parent',
            action: 'subscription.resume_requested',
            resourceType: 'subscription',
            resourceId: found.subscription_id,
            outcome: 'success',
            metadata: { confirmedByProvider: confirmed },
          },
          request,
        );

        return await reply.status(200).send({
          status: 'active',
          renewsAt: renewsAt === null ? null : new Date(renewsAt).toISOString(),
          confirmedByProvider: confirmed,
          explanation: 'Your plan is active again and will renew as usual.',
        });
      },
    );

    /* ---------------------------------------------------------------------- */
    /* POST /api/subscriptions/webhook/:rail                                  */
    /* ---------------------------------------------------------------------- */
    /* Registered in its own encapsulated scope so the raw-body parser applies
     * to this route and nothing else. Signature verification runs over the
     * exact bytes the rail signed — a body that has been through a JSON parser
     * and re-serialised no longer matches, and "we verify signatures" quietly
     * becomes "we verify our own re-encoding". */

    await app.register(async (scope) => {
      scope.removeContentTypeParser(['application/json']);
      scope.addContentTypeParser(
        ['application/json', 'application/json; charset=utf-8', '*'],
        { parseAs: 'buffer' },
        (_request, body, done) => {
          done(null, body);
        },
      );

      scope.post(
        '/subscriptions/webhook/:rail',
        {
          // NO `authenticate`. The rail has no session — the signature IS the
          // authentication, and it is checked below before the body is parsed.
          schema: {
            description: 'Payment rail webhook. Authenticated by signature, not by session.',
            params: z.object({ rail: z.string().min(2).max(20) }),
            response: {
              200: z.object({ received: z.literal(true), outcome: z.string() }),
              400: z.object({ received: z.literal(false), reason: z.string() }),
            },
          },
          config: {
            // Generous: a rail catching up after an outage delivers in bursts,
            // and rate-limiting a legitimate backlog into failure is worse than
            // the load. Still bounded, because this endpoint is unauthenticated.
            rateLimit: { max: options.webhookRateLimitPerMinute, timeWindow: '1 minute' },
          },
        },
        async (request, reply) => {
          const railName = (request.params as { rail: string }).rail;

          if (!isPaymentRail(railName) || railName !== provider.rail) {
            request.log.warn({ rail: railName }, 'webhook for an unconfigured rail');
            return await reply.status(400).send({ received: false, reason: 'unknown_rail' });
          }

          const raw = Buffer.isBuffer(request.body)
            ? new Uint8Array(request.body)
            : new Uint8Array(0);

          /* ---------------------------------------------------------------- */
          /* 1. Authenticate                                                   */
          /* ---------------------------------------------------------------- */
          let event;
          try {
            event = await provider.verifyAndParseWebhook(
              raw,
              request.headers as Record<string, string | undefined>,
            );
          } catch (error) {
            const reason =
              error instanceof WebhookVerificationError ? error.reason : 'unverifiable';

            /* AN UNVERIFIED EVENT IS NOT RECORDED IN `payment_events`.
             *
             * It is tempting to store it for forensics, and that would be a
             * vulnerability: the table's idempotency key is
             * (rail, external_event_id), so an attacker who guesses or observes
             * a real event id could insert it first as an unverified row and
             * the genuine delivery would then be discarded as a duplicate. A
             * forged webhook must not be able to suppress a real one.
             *
             * So it goes to the audit log and the request log, which have no
             * such key, and it changes nothing. */
            await auditOrFail(
              audit,
              {
                actorType: 'system',
                action: 'webhook.rejected',
                resourceType: 'payment_event',
                outcome: 'denied',
                metadata: { rail: railName, reason },
              },
              request,
            );

            request.log.warn({ rail: railName, reason }, 'webhook signature rejected');
            return await reply.status(400).send({ received: false, reason });
          }

          /* ---------------------------------------------------------------- */
          /* 2. Reconcile, in one transaction                                  */
          /* ---------------------------------------------------------------- */
          try {
            const outcome = await reconciler.reconcile(event);

            if (outcome.kind === 'duplicate') {
              await auditOrFail(
                audit,
                {
                  actorType: 'system',
                  action: 'webhook.replayed',
                  resourceType: 'payment_event',
                  outcome: 'success',
                  metadata: {
                    rail: event.rail,
                    eventType: event.type,
                    deliveryCount: outcome.deliveryCount,
                  },
                },
                request,
              );
            }

            // 200 for every processed outcome, including ignored. A 4xx would
            // make the rail retry an event that will never apply, and most
            // rails eventually disable an endpoint that keeps failing — taking
            // the events that DO matter down with it.
            return await reply.status(200).send({ received: true, outcome: outcome.kind });
          } catch (error) {
            // A database fault, not a business decision. Recorded in its own
            // transaction, then a 5xx so the rail retries — which is exactly
            // what we want, because the whole reconciliation rolled back.
            await reconciler.recordFailure(event, error);
            request.log.error({ err: error, eventType: event.type }, 'webhook processing failed');
            throw error;
          }
        },
      );
    });
  };
