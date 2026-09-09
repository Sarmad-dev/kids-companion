import { asSystem, type Database, type Queryable } from '@kids/db';
import {
  applyLifecycleEvent,
  type PlanPolicy,
  type SubscriptionState,
  type SubscriptionStatus,
  type VerifiedWebhookEvent,
} from '@kids/payments';
import type { Clock } from '@kids/shared';

import { auditOrFail, type AuditAction, type AuditLogger } from './audit.js';

/**
 * The webhook reconciler.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE ONLY WRITER OF `subscriptions`.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Nothing else in this codebase updates a subscription's status. Not the create
 * endpoint, not cancel, not resume — those record a request and ask the rail.
 * What a parent is entitled to changes here, from an event whose signature
 * verified, and nowhere else.
 *
 * The brief's four requirements map onto four specific mechanisms, and it is
 * worth being precise about which does what, because they are easy to confuse:
 *
 *   AUTHENTICATED   the caller verified the signature before we were called;
 *                   this function's type signature demands a
 *                   `VerifiedWebhookEvent` and there is no other way to make
 *                   one.
 *
 *   IDEMPOTENT      the unique index on `(rail, external_event_id)`. The insert
 *                   is the first statement in the transaction, so a redelivery
 *                   is detected before anything else happens and returns the
 *                   original outcome rather than repeating it.
 *
 *   REPLAY-SAFE     two independent layers. The signature covers a timestamp,
 *                   so a captured request cannot be posted back a week later
 *                   (the provider enforces that). And `last_event_at` orders
 *                   events by the VENDOR's clock, so a genuine old event
 *                   redelivered with a fresh signature still changes nothing.
 *
 *   TRANSACTION-SAFE  one transaction covers the event row, the subscription,
 *                   the transaction row, and the checkout. Any failure rolls
 *                   back all of it, the vendor gets a 5xx, and the retry finds
 *                   a clean slate. A partial application — subscription updated,
 *                   ledger not — is the one outcome that would be unrecoverable
 *                   by retrying.
 *
 *   LOGGED          `payment_events` keeps what we were told; `audit_logs`
 *                   keeps what we did about it. They answer different questions
 *                   and both are needed when they disagree.
 */

export interface ReconcilerOptions {
  readonly db: Database;
  readonly audit: AuditLogger;
  readonly clock: Clock;
}

export type ReconcileOutcome =
  | { readonly kind: 'applied'; readonly status: string; readonly reason: string }
  | { readonly kind: 'duplicate'; readonly deliveryCount: number }
  | { readonly kind: 'ignored'; readonly reason: string };

interface PlanRow {
  id: string;
  code: string;
  display_name: string;
  tier: 'free' | 'paid';
  price_minor: number;
  currency: string;
  billing_interval: PlanPolicy['billingInterval'];
  trial_days: number;
  grace_days: number;
}

const toPolicy = (row: PlanRow): PlanPolicy => ({
  code: row.code,
  displayName: row.display_name,
  tier: row.tier,
  price: { amountMinor: row.price_minor, currency: row.currency },
  billingInterval: row.billing_interval,
  trialDays: row.trial_days,
  graceDays: row.grace_days,
});

interface SubscriptionRow {
  id: string;
  parent_id: string;
  plan_id: string;
  status: string;
  current_period_start: string | null;
  current_period_end: string | null;
  trial_ends_at: string | null;
  grace_ends_at: string | null;
  cancel_at: string | null;
  cancelled_at: string | null;
  trial_consumed: boolean;
  last_event_at: string | null;
  plan_code: string;
}

const iso = (value: string | Date | null): string | undefined =>
  value === null ? undefined : new Date(value).toISOString();

const toState = (row: SubscriptionRow): SubscriptionState => ({
  status: row.status as SubscriptionState['status'],
  planCode: row.plan_code,
  currentPeriodStart: iso(row.current_period_start),
  currentPeriodEnd: iso(row.current_period_end),
  trialEndsAt: iso(row.trial_ends_at),
  graceEndsAt: iso(row.grace_ends_at),
  cancelAt: iso(row.cancel_at),
  cancelledAt: iso(row.cancelled_at),
  trialConsumed: row.trial_consumed,
  lastEventAt: iso(row.last_event_at),
});

/**
 * Which audit action a transition deserves.
 *
 * Deliberately `Partial`: `free` and `past_due` have no entry, because neither
 * is a transition this reconciler produces. Typing it as a total record would
 * have made the fallback below look dead when it is not.
 */
const AUDIT_FOR_STATUS: Partial<Record<SubscriptionStatus, AuditAction>> = {
  active: 'subscription.activated',
  trialing: 'subscription.activated',
  grace: 'subscription.grace_started',
  cancelled: 'subscription.cancelled',
  expired: 'subscription.expired',
};

/* -------------------------------------------------------------------------- */
/* Lookups                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Our checkout ids are UUIDs. A reference that is not one cannot match.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS IS A GUARD AND NOT A CAST
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The lookups below cast the vendor's reference with `$1::uuid`. Handed
 * anything that is not a UUID, Postgres raises 22P02 — so a signed webhook
 * carrying an unexpected reference format came out of here as a DATABASE
 * ERROR rather than as "no match", and therefore as a 500.
 *
 * That inverts the contract stated on `apply` below: a business fact we cannot
 * act on must be recorded and reported as `ignored`, precisely because a 5xx
 * makes the rail retry something that will never succeed. A malformed
 * reference would have been retried by the vendor forever, and each attempt
 * counted toward the 5xx rate that alerting watches.
 */
const asCheckoutId = (reference: string | undefined): string | undefined =>
  reference !== undefined &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(reference)
    ? reference
    : undefined;

/**
 * Finds the subscription an event is about.
 *
 * Three routes, in order of reliability: the vendor's own subscription id, our
 * checkout reference, and — only for an event that creates a subscription — the
 * parent behind a pending checkout.
 *
 * `for update` on every path. Two deliveries of different events for the same
 * parent can arrive concurrently, and a lost update here is a subscription in
 * the wrong state with no evidence of how it got there.
 */
const findSubscription = async (
  tx: Queryable,
  event: VerifiedWebhookEvent,
): Promise<SubscriptionRow | undefined> => {
  const select = `select s.id, s.parent_id, s.plan_id, s.status, s.current_period_start,
                         s.current_period_end, s.trial_ends_at, s.grace_ends_at, s.cancel_at,
                         s.cancelled_at, s.trial_consumed, s.last_event_at, p.code as plan_code
                    from subscriptions s
                    join subscription_plans p on p.id = s.plan_id`;

  if (event.externalSubscriptionId !== undefined) {
    const { rows } = await tx.query<SubscriptionRow>(
      `${select} where s.rail = $1 and s.external_id = $2 for update of s`,
      [event.rail, event.externalSubscriptionId],
    );
    if (rows[0]) return rows[0];
  }

  const checkoutId = asCheckoutId(event.reference);
  if (checkoutId !== undefined) {
    const { rows } = await tx.query<SubscriptionRow>(
      `${select}
        where s.id = (select c.subscription_id from subscription_checkouts c
                       where c.id = $1::uuid and c.subscription_id is not null)
        for update of s`,
      [checkoutId],
    );
    if (rows[0]) return rows[0];
  }

  return undefined;
};

const findCheckout = async (
  tx: Queryable,
  reference: string | undefined,
): Promise<{ id: string; parent_id: string; plan_id: string; rail: string } | undefined> => {
  const checkoutId = asCheckoutId(reference);
  if (checkoutId === undefined) return undefined;
  const { rows } = await tx.query<{
    id: string;
    parent_id: string;
    plan_id: string;
    rail: string;
  }>(
    `select id, parent_id, plan_id, rail from subscription_checkouts
      where id = $1::uuid for update`,
    [checkoutId],
  );
  return rows[0];
};

/* -------------------------------------------------------------------------- */
/* The reconciler                                                              */
/* -------------------------------------------------------------------------- */

export const createSubscriptionReconciler = (options: ReconcilerOptions) => {
  const { db, audit, clock } = options;

  /**
   * Processes one verified event.
   *
   * Never throws for a business reason — an event we cannot act on is recorded
   * and reported as `ignored`, because a 5xx would make the rail retry
   * something that will never succeed. It throws only when the DATABASE fails,
   * which is exactly when a retry is the right thing.
   */
  const reconcile = async (event: VerifiedWebhookEvent): Promise<ReconcileOutcome> =>
    await asSystem(db, async (tx) => {
      /* ------------------------------------------------------------------ */
      /* 1. Idempotency, first, inside the transaction                       */
      /* ------------------------------------------------------------------ */
      /* The insert either wins the race or loses it. Losing means another
       * delivery of this event id has been seen; we bump the counter and stop.
       *
       * Doing this first matters: any work before it would run twice on a
       * redelivery, and the second run would be the one nobody tested. */
      const { rows: inserted } = await tx.query<{ id: string }>(
        `insert into payment_events
           (rail, external_event_id, event_type, signature_verified, payload,
            event_occurred_at, processing_status)
         values ($1, $2, $3, true, $4::jsonb, $5, 'pending')
         on conflict (rail, external_event_id) do nothing
         returning id`,
        [
          event.rail,
          event.externalEventId,
          event.type,
          JSON.stringify(event.payload),
          event.occurredAt,
        ],
      );

      const eventRowId = inserted[0]?.id;
      if (eventRowId === undefined) {
        const { rows: existing } = await tx.query<{ delivery_count: number }>(
          `update payment_events set delivery_count = delivery_count + 1
            where rail = $1 and external_event_id = $2
            returning delivery_count`,
          [event.rail, event.externalEventId],
        );
        return {
          kind: 'duplicate' as const,
          deliveryCount: existing[0]?.delivery_count ?? 2,
        };
      }

      const finish = async (
        status: 'processed' | 'ignored',
        reason: string,
        subscriptionId?: string,
        parentId?: string,
      ): Promise<void> => {
        await tx.query(
          `update payment_events
              set processing_status = $2,
                  processed_at = now(),
                  ignored_reason = $3,
                  subscription_id = coalesce($4::uuid, subscription_id),
                  parent_id = coalesce($5::uuid, parent_id)
            where id = $1`,
          [
            eventRowId,
            status,
            status === 'ignored' ? reason : null,
            subscriptionId ?? null,
            parentId ?? null,
          ],
        );
      };

      /* ------------------------------------------------------------------ */
      /* 2. What is this event about?                                        */
      /* ------------------------------------------------------------------ */
      const existing = await findSubscription(tx, event);
      const checkout = existing ? undefined : await findCheckout(tx, event.reference);

      if (!existing && !checkout) {
        // A real event for something we have no record of. Recorded rather than
        // rejected: a 5xx would make the rail retry forever, and the row is the
        // evidence for the reconciliation that eventually explains it.
        await finish('ignored', 'unknown_subscription');
        return { kind: 'ignored' as const, reason: 'unknown_subscription' };
      }

      const planId = existing?.plan_id ?? checkout!.plan_id;
      const parentId = existing?.parent_id ?? checkout!.parent_id;

      const { rows: planRows } = await tx.query<PlanRow>(
        `select id, code, display_name, tier, price_minor, currency, billing_interval,
                trial_days, grace_days
           from subscription_plans where id = $1`,
        [planId],
      );
      const planRow = planRows[0];
      if (!planRow) {
        await finish('ignored', 'unknown_plan', existing?.id, parentId);
        return { kind: 'ignored' as const, reason: 'unknown_plan' };
      }

      /* ------------------------------------------------------------------ */
      /* 3. Decide — in a pure function, with no access to the database       */
      /* ------------------------------------------------------------------ */
      const outcome = applyLifecycleEvent({
        current: existing ? toState(existing) : undefined,
        event,
        plan: toPolicy(planRow),
      });

      if (outcome.kind === 'ignored') {
        await finish('ignored', outcome.reason, existing?.id, parentId);
        return { kind: 'ignored' as const, reason: outcome.reason };
      }

      const next = outcome.next;

      /* ------------------------------------------------------------------ */
      /* 4. Write the new state                                              */
      /* ------------------------------------------------------------------ */
      let subscriptionId: string;

      if (existing) {
        await tx.query(
          `update subscriptions
              set status = $2,
                  current_period_start = $3,
                  current_period_end = $4,
                  trial_ends_at = $5,
                  grace_ends_at = $6,
                  cancel_at = $7,
                  cancelled_at = $8,
                  trial_consumed = $9,
                  last_event_at = $10,
                  last_event_id = $11,
                  external_id = coalesce($12, external_id),
                  payment_method_brand = coalesce($13, payment_method_brand),
                  payment_method_last4 = coalesce($14, payment_method_last4)
            where id = $1`,
          [
            existing.id,
            next.status,
            next.currentPeriodStart ?? null,
            next.currentPeriodEnd ?? null,
            next.trialEndsAt ?? null,
            next.graceEndsAt ?? null,
            next.cancelAt ?? null,
            next.cancelledAt ?? null,
            next.trialConsumed,
            event.occurredAt,
            event.externalEventId,
            event.externalSubscriptionId ?? null,
            event.paymentMethod?.brand ?? null,
            event.paymentMethod?.last4 ?? null,
          ],
        );
        subscriptionId = existing.id;
      } else {
        const { rows: created } = await tx.query<{ id: string }>(
          `insert into subscriptions
             (parent_id, plan_id, rail, status, external_id, currency, price_minor,
              current_period_start, current_period_end, trial_ends_at, grace_ends_at,
              cancel_at, cancelled_at, trial_consumed, last_event_at, last_event_id,
              payment_method_brand, payment_method_last4)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
           returning id`,
          [
            parentId,
            planId,
            checkout!.rail,
            next.status,
            event.externalSubscriptionId ?? null,
            planRow.currency,
            planRow.price_minor,
            next.currentPeriodStart ?? null,
            next.currentPeriodEnd ?? null,
            next.trialEndsAt ?? null,
            next.graceEndsAt ?? null,
            next.cancelAt ?? null,
            next.cancelledAt ?? null,
            next.trialConsumed,
            event.occurredAt,
            event.externalEventId,
            event.paymentMethod?.brand ?? null,
            event.paymentMethod?.last4 ?? null,
          ],
        );
        subscriptionId = created[0]!.id;

        await tx.query(
          `update subscription_checkouts
              set status = 'completed', completed_at = now(), subscription_id = $2
            where id = $1`,
          [checkout!.id, subscriptionId],
        );
      }

      /* ------------------------------------------------------------------ */
      /* 5. The money ledger                                                 */
      /* ------------------------------------------------------------------ */
      /* Separate from the subscription because it answers a different question,
       * and because it must survive account erasure in the minimised form the
       * legal-retention exception allows. Written in the SAME transaction, so
       * "entitlement granted but no record of the charge" cannot happen. */
      const ledgerKind =
        event.type === 'payment.refunded'
          ? 'refund'
          : event.type === 'payment.failed'
            ? 'charge'
            : event.type === 'subscription.activated' || event.type === 'subscription.renewed'
              ? 'charge'
              : undefined;

      if (ledgerKind !== undefined && event.amount !== undefined) {
        const magnitude = Math.abs(event.amount.amountMinor);
        await tx.query(
          `insert into transactions
             (subscription_id, parent_id, rail, external_id, kind, status, amount_minor,
              currency, payment_method_brand, payment_method_last4, failure_code, occurred_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           on conflict (rail, external_id) do nothing`,
          [
            subscriptionId,
            parentId,
            event.rail,
            event.externalEventId,
            ledgerKind,
            event.type === 'payment.failed'
              ? 'failed'
              : event.type === 'payment.refunded'
                ? 'succeeded'
                : 'succeeded',
            ledgerKind === 'refund' ? -magnitude : magnitude,
            event.amount.currency,
            event.paymentMethod?.brand ?? null,
            event.paymentMethod?.last4 ?? null,
            event.failureCode ?? null,
            event.occurredAt,
          ],
        );
      }

      await finish('processed', outcome.reason, subscriptionId, parentId);

      /* ------------------------------------------------------------------ */
      /* 6. Audit                                                            */
      /* ------------------------------------------------------------------ */
      /* `actorType: 'system'` and never the parent. A renewal is not something
       * a parent did; attributing it to them would make the audit log lie about
       * who acts on this account. */
      const action =
        event.type === 'subscription.renewed'
          ? ('subscription.renewed' as const)
          : event.type === 'payment.failed' && next.status === 'grace'
            ? ('subscription.grace_started' as const)
            : event.type === 'payment.failed'
              ? ('subscription.payment_failed' as const)
              : event.type === 'payment.refunded'
                ? ('subscription.refunded' as const)
                : (AUDIT_FOR_STATUS[next.status] ?? 'subscription.activated');

      await auditOrFail(audit, {
        actorType: 'system',
        action,
        resourceType: 'subscription',
        resourceId: subscriptionId,
        outcome: 'success',
        // Plan code and state only. An amount belongs in `transactions`, and a
        // vendor payload has no business in the audit log.
        metadata: {
          rail: event.rail,
          plan: planRow.code,
          status: next.status,
          eventType: event.type,
          reason: outcome.reason,
        },
      });

      return { kind: 'applied' as const, status: next.status, reason: outcome.reason };
    });

  /**
   * Records an event that failed processing.
   *
   * Runs in its OWN transaction, after the main one has rolled back — otherwise
   * the record of the failure would roll back with the failure it records, and
   * the only evidence of a repeatedly failing webhook would be a log line.
   */
  const recordFailure = async (event: VerifiedWebhookEvent, error: unknown): Promise<void> => {
    await asSystem(db, async (tx) => {
      await tx.query(
        `insert into payment_events
           (rail, external_event_id, event_type, signature_verified, payload,
            event_occurred_at, processing_status, processing_error, processed_at)
         values ($1, $2, $3, true, $4::jsonb, $5, 'failed', $6, now())
         on conflict (rail, external_event_id) do update
           set processing_status = 'failed',
               processing_error = excluded.processing_error,
               processed_at = now()`,
        [
          event.rail,
          event.externalEventId,
          event.type,
          JSON.stringify(event.payload),
          event.occurredAt,
          // The message only. A database error can carry a fragment of a query,
          // and this column is read by people who are not on the security team.
          error instanceof Error ? error.message.slice(0, 500) : 'unknown error',
        ],
      );
    });
  };

  /**
   * Closes grace windows and periods that have run out.
   *
   * A convenience, not a correctness requirement: every read path already
   * applies elapsed deadlines through `app.subscription_state`, so a
   * subscription is expired the moment its window closes whether or not this
   * has run. What the sweep buys is a stored status that matches reality, which
   * is what makes an operator's ad-hoc query trustworthy.
   */
  const sweepExpired = async (): Promise<number> =>
    await asSystem(db, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `update subscriptions
            set status = 'expired', grace_ends_at = null
          where (status = 'grace' and grace_ends_at <= $1::timestamptz)
             or (status in ('trialing', 'active', 'cancelled')
                 and current_period_end is not null
                 and current_period_end <= $1::timestamptz)
          returning id`,
        [clock.nowIso()],
      );

      for (const row of rows) {
        await auditOrFail(audit, {
          actorType: 'system',
          action: 'subscription.expired',
          resourceType: 'subscription',
          resourceId: row.id,
          outcome: 'success',
          metadata: { via: 'sweep' },
        });
      }

      return rows.length;
    });

  return { reconcile, recordFailure, sweepExpired };
};

export type SubscriptionReconciler = ReturnType<typeof createSubscriptionReconciler>;
