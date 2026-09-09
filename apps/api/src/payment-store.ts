import { asSystem, type Database, type Queryable } from '@kids/db';
import {
  isRetryableFailure,
  isTerminalPayment,
  RailCapabilityError,
  RailNotVerifiedError,
  type Money,
  type PaymentFailureCode,
  type PaymentRailAdapter,
  type PaymentResult,
  type PaymentStatus,
  type RailRegistry,
} from '@kids/payments';
import type { Clock } from '@kids/shared';

import { auditOrFail, type AuditLogger } from './audit.js';

/**
 * The payment store.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * PAYMENT STATE. NOT SUBSCRIPTION STATE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Nothing in this file writes `subscriptions`. It records what a rail did with
 * money, and the subscription reconciler decides separately what that means for
 * entitlement. The two are joined by a nullable foreign key and nothing else,
 * which is what lets a payment succeed against no subscription and a
 * subscription survive three failed payments.
 *
 * Four of the brief's requirements land here, and it is worth naming which
 * mechanism serves which:
 *
 *   IDEMPOTENCY     `uq_payments_idempotency` on (parent_id, idempotency_key).
 *                   `initiate` inserts FIRST and returns the existing row on
 *                   conflict, so a retry after a timeout cannot become a second
 *                   charge. The rail is only called for a genuinely new row.
 *
 *   RECONCILIATION  `reconcile` asks the rail what actually happened for every
 *                   payment it has not given a final answer about. This is the
 *                   only path that can resolve a callback that never arrived —
 *                   the case where a customer has been charged and not
 *                   credited.
 *
 *   FAILURE         failures are classified into our own vocabulary, retryable
 *                   or terminal, and a rail that is unreachable is recorded as
 *                   a payment that did not happen rather than one that failed.
 *                   Those are different, and telling a parent their card was
 *                   declined when the network was down is a support call.
 *
 *   AUDIT           every transition is an audit record with the rail, the
 *                   status, and no amount — the amount belongs in the ledger.
 */

export interface PaymentStoreOptions {
  readonly db: Database;
  readonly registry: RailRegistry;
  readonly audit: AuditLogger;
  readonly clock: Clock;
  readonly reconcileAfterMinutes: number;
}

export interface InitiatePaymentInput {
  readonly parentId: string;
  readonly rail: string;
  readonly amount: Money;
  readonly idempotencyKey: string;
  readonly description: string;
  readonly subscriptionId?: string | undefined;
  readonly checkoutId?: string | undefined;
  readonly payerHandle?: string | undefined;
  readonly instrumentToken?: string | undefined;
  readonly returnUrl?: string | undefined;
}

export type InitiateOutcome =
  | { readonly kind: 'started'; readonly paymentId: string; readonly result: PaymentResult }
  | { readonly kind: 'existing'; readonly paymentId: string; readonly status: PaymentStatus }
  | {
      readonly kind: 'rail_unavailable';
      readonly reason: 'no_rails_enabled' | 'rail_not_enabled' | 'rail_not_verified';
    }
  | {
      readonly kind: 'failed';
      readonly paymentId: string;
      readonly failureCode: PaymentFailureCode;
      readonly retryable: boolean;
    };

interface PaymentRow {
  id: string;
  parent_id: string;
  rail: string;
  status: PaymentStatus;
  rail_reference: string | null;
  amount_minor: number;
  currency: string;
  attempt_count: number;
}

const iso = (value: string | Date | null): string | undefined =>
  value === null ? undefined : new Date(value).toISOString();

export const createPaymentStore = (options: PaymentStoreOptions) => {
  const { db, registry, audit, clock } = options;

  /**
   * Writes what a rail told us about one payment.
   *
   * Shared by `initiate`, `reconcile`, and the callback handler, because all
   * three learn the same kind of thing and a second copy of this logic is how
   * two paths start disagreeing about what "captured" means.
   */
  const applyResult = async (
    tx: Queryable,
    paymentId: string,
    result: PaymentResult,
  ): Promise<void> => {
    const terminal = isTerminalPayment(result.status);

    await tx.query(
      `update payments
          set status = $2,
              rail_reference = coalesce($3, rail_reference),
              failure_code = $4,
              rail_failure_code = $5,
              payment_method_brand = coalesce($6, payment_method_brand),
              payment_method_last4 = coalesce($7, payment_method_last4),
              instrument_token = coalesce($8, instrument_token),
              last_checked_at = $9,
              completed_at = case when $10 then coalesce(completed_at, $9) else completed_at end
        where id = $1`,
      [
        paymentId,
        result.status,
        result.railReference ?? null,
        result.failureCode ?? null,
        result.railFailureCode ?? null,
        result.instrument?.brand ?? null,
        result.instrument?.last4 ?? null,
        result.instrumentToken ?? null,
        clock.nowIso(),
        terminal,
      ],
    );

    // The ledger entry, in the SAME transaction. "Entitlement granted but no
    // record of the charge" is the one outcome a retry cannot repair.
    if (result.status === 'captured') {
      await tx.query(
        `insert into transactions
           (payment_id, subscription_id, parent_id, rail, external_id, kind, status,
            amount_minor, currency, payment_method_brand, payment_method_last4, occurred_at)
         select $1, p.subscription_id, p.parent_id, p.rail,
                coalesce(p.rail_reference, p.id::text), 'charge', 'succeeded',
                p.amount_minor, p.currency, p.payment_method_brand, p.payment_method_last4, $2
           from payments p where p.id = $1
         on conflict (rail, external_id) do nothing`,
        [paymentId, result.occurredAt],
      );
    }
  };

  /* ---------------------------------------------------------------------- */
  /* Initiate                                                               */
  /* ---------------------------------------------------------------------- */

  const initiate = async (input: InitiatePaymentInput): Promise<InitiateOutcome> => {
    if (!registry.anyAvailable()) {
      return { kind: 'rail_unavailable', reason: 'no_rails_enabled' };
    }

    const adapter = registry.get(input.rail);
    if (!adapter) return { kind: 'rail_unavailable', reason: 'rail_not_enabled' };

    /* The idempotency record comes FIRST, before the rail is touched. A row
     * that already exists means this exact request has been made before, and
     * the rail must not be asked again — that is how a flaky connection turns
     * one payment into two. */
    const claim = await asSystem(db, async (tx) => {
      const { rows: inserted } = await tx.query<{ id: string }>(
        `insert into payments
           (parent_id, subscription_id, checkout_id, rail, status, amount_minor,
            currency, idempotency_key)
         values ($1, $2::uuid, $3::uuid, $4, 'initiated', $5, $6, $7)
         on conflict (parent_id, idempotency_key) do nothing
         returning id`,
        [
          input.parentId,
          input.subscriptionId ?? null,
          input.checkoutId ?? null,
          input.rail,
          input.amount.amountMinor,
          input.amount.currency,
          input.idempotencyKey,
        ],
      );

      if (inserted[0]) return { fresh: true as const, id: inserted[0].id };

      const { rows: existing } = await tx.query<PaymentRow>(
        `select id, parent_id, rail, status, rail_reference, amount_minor, currency,
                attempt_count
           from payments where parent_id = $1 and idempotency_key = $2`,
        [input.parentId, input.idempotencyKey],
      );
      return { fresh: false as const, row: existing[0] };
    });

    if (!claim.fresh) {
      const row = claim.row;
      if (!row) return { kind: 'rail_unavailable', reason: 'rail_not_enabled' };
      return { kind: 'existing', paymentId: row.id, status: row.status };
    }

    const paymentId = claim.id;

    await auditOrFail(audit, {
      actorType: 'system',
      action: 'payment.initiated',
      resourceType: 'payment',
      resourceId: paymentId,
      outcome: 'success',
      metadata: { rail: input.rail, mode: adapter.mode },
    });

    /* ------------------------------------------------------------------ */
    /* Now the rail                                                        */
    /* ------------------------------------------------------------------ */
    let result: PaymentResult;
    try {
      result = await adapter.initiate({
        reference: paymentId,
        amount: input.amount,
        idempotencyKey: input.idempotencyKey,
        description: input.description,
        ...(input.payerHandle === undefined ? {} : { payerHandle: input.payerHandle }),
        ...(input.instrumentToken === undefined ? {} : { instrumentToken: input.instrumentToken }),
        ...(input.returnUrl === undefined ? {} : { returnUrl: input.returnUrl }),
      });
    } catch (error) {
      /* An unverified live rail, or a rail that threw.
       *
       * Recorded as `unresolved`, NOT `failed`. We do not know whether the rail
       * received the request — and telling a parent their payment failed when
       * it may have gone through is how a double charge starts. Reconciliation
       * asks the rail rather than guessing. */
      const notVerified = error instanceof RailNotVerifiedError;

      await asSystem(db, async (tx) => {
        await tx.query(
          `update payments set status = $2, failure_code = $3, last_checked_at = $4
            where id = $1`,
          [
            paymentId,
            notVerified ? 'failed' : 'unresolved',
            notVerified ? 'configuration_error' : null,
            clock.nowIso(),
          ],
        );
        if (notVerified) {
          await tx.query('update payments set completed_at = $2 where id = $1', [
            paymentId,
            clock.nowIso(),
          ]);
        }
      });

      await auditOrFail(audit, {
        actorType: 'system',
        action: notVerified ? 'payment.failed' : 'payment.unresolved',
        resourceType: 'payment',
        resourceId: paymentId,
        outcome: 'error',
        metadata: {
          rail: input.rail,
          reason: notVerified ? 'rail_not_verified' : 'rail_error',
        },
      });

      if (notVerified) {
        return { kind: 'rail_unavailable', reason: 'rail_not_verified' };
      }
      return {
        kind: 'failed',
        paymentId,
        failureCode: 'rail_unavailable',
        retryable: true,
      };
    }

    await asSystem(db, async (tx) => {
      await applyResult(tx, paymentId, result);
    });

    if (result.status === 'failed') {
      const code = result.failureCode ?? 'unknown';
      await auditOrFail(audit, {
        actorType: 'system',
        action: 'payment.failed',
        resourceType: 'payment',
        resourceId: paymentId,
        outcome: 'error',
        metadata: { rail: input.rail, failureCode: code },
      });
      return { kind: 'failed', paymentId, failureCode: code, retryable: isRetryableFailure(code) };
    }

    return { kind: 'started', paymentId, result };
  };

  /* ---------------------------------------------------------------------- */
  /* Callbacks                                                              */
  /* ---------------------------------------------------------------------- */

  /**
   * Records a verified rail callback.
   *
   * Idempotent on `(rail, external_event_id)` exactly like the subscription
   * webhook, and for the same reason: rails retry, and the second delivery must
   * change nothing.
   */
  const applyCallback = async (
    rail: string,
    externalEventId: string,
    paymentReference: string,
    result: PaymentResult,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<'applied' | 'duplicate' | 'unknown_payment'> =>
    await asSystem(db, async (tx) => {
      const { rows: inserted } = await tx.query<{ id: string }>(
        `insert into payment_events
           (rail, external_event_id, event_type, signature_verified, payload,
            event_occurred_at, processing_status)
         values ($1, $2, $3, true, $4::jsonb, $5, 'pending')
         on conflict (rail, external_event_id) do nothing
         returning id`,
        [
          rail,
          externalEventId,
          `payment.${result.status}`,
          JSON.stringify(payload),
          result.occurredAt,
        ],
      );

      if (!inserted[0]) {
        await tx.query(
          `update payment_events set delivery_count = delivery_count + 1
            where rail = $1 and external_event_id = $2`,
          [rail, externalEventId],
        );
        return 'duplicate' as const;
      }

      const { rows: payments } = await tx.query<PaymentRow>(
        `select id, parent_id, rail, status, rail_reference, amount_minor, currency,
                attempt_count
           from payments where id = $1::uuid for update`,
        [paymentReference],
      );

      const payment = payments[0];
      if (!payment) {
        await tx.query(
          `update payment_events
              set processing_status = 'ignored', processed_at = now(),
                  ignored_reason = 'unknown_payment'
            where id = $1`,
          [inserted[0].id],
        );
        return 'unknown_payment' as const;
      }

      // A terminal payment does not move again on a callback. A late
      // `pending` after a `captured` is the rail catching up, not a reversal.
      if (!isTerminalPayment(payment.status)) {
        await applyResult(tx, payment.id, result);
      }

      await tx.query(
        `update payment_events
            set processing_status = 'processed', processed_at = now(),
                payment_id = $2, parent_id = $3
          where id = $1`,
        [inserted[0].id, payment.id, payment.parent_id],
      );

      return 'applied' as const;
    });

  /* ---------------------------------------------------------------------- */
  /* Reconciliation                                                         */
  /* ---------------------------------------------------------------------- */

  /**
   * Asks each rail what actually happened.
   *
   * ═══════════════════════════════════════════════════════════════════════
   * THIS IS THE ONLY THING THAT CAN FIND A CUSTOMER WHO PAID AND WAS NOT
   * CREDITED.
   * ═══════════════════════════════════════════════════════════════════════
   *
   * Callbacks get lost. Processes die between charging and recording. A wallet
   * confirms to the customer and never reaches us. Every one of those leaves a
   * payment that is neither succeeded nor failed, and no amount of care on the
   * request path detects it — only asking the rail does.
   *
   * A rail that cannot answer (`statusQuery: false`) is skipped rather than
   * guessed at, and its payments stay unresolved, which is the honest state.
   */
  const reconcile = async (
    limit = 100,
  ): Promise<{ checked: number; resolved: number; stillUnresolved: number }> => {
    const due = await asSystem(db, async (tx) => {
      const { rows } = await tx.query<{
        payment_id: string;
        parent_id: string;
        rail: string;
        rail_reference: string | null;
        status: PaymentStatus;
      }>('select * from app.payments_needing_reconciliation($1, $2, $3)', [
        options.reconcileAfterMinutes,
        limit,
        clock.nowIso(),
      ]);
      return rows;
    });

    let resolved = 0;
    let stillUnresolved = 0;

    for (const row of due) {
      const adapter: PaymentRailAdapter | undefined = registry.get(row.rail);

      if (!adapter || !adapter.capabilities.statusQuery || row.rail_reference === null) {
        // Nothing to ask, or nobody to ask. Marked as unresolved so it stops
        // being counted as in-flight and starts being counted as a problem.
        stillUnresolved += 1;
        await asSystem(db, async (tx) => {
          await tx.query(
            `update payments set status = 'unresolved', last_checked_at = $2 where id = $1`,
            [row.payment_id, clock.nowIso()],
          );
        });
        continue;
      }

      let result: PaymentResult;
      try {
        result = await adapter.queryStatus(row.rail_reference);
      } catch {
        // The rail is unreachable. Nothing changes except the timestamp, so the
        // sweep backs off rather than hammering a service that is already down.
        stillUnresolved += 1;
        await asSystem(db, async (tx) => {
          await tx.query('update payments set last_checked_at = $2 where id = $1', [
            row.payment_id,
            clock.nowIso(),
          ]);
        });
        continue;
      }

      await asSystem(db, async (tx) => {
        await applyResult(tx, row.payment_id, result);
        if (isTerminalPayment(result.status)) {
          await tx.query('update payments set reconciled_at = $2 where id = $1', [
            row.payment_id,
            clock.nowIso(),
          ]);
        }
      });

      if (isTerminalPayment(result.status)) {
        resolved += 1;
        await auditOrFail(audit, {
          actorType: 'system',
          action: 'payment.reconciled',
          resourceType: 'payment',
          resourceId: row.payment_id,
          outcome: 'success',
          metadata: { rail: row.rail, status: result.status, via: 'status_query' },
        });
      } else {
        stillUnresolved += 1;
      }
    }

    return { checked: due.length, resolved, stillUnresolved };
  };

  /* ---------------------------------------------------------------------- */
  /* Refunds                                                                */
  /* ---------------------------------------------------------------------- */

  /**
   * Requests a refund, or records that the rail cannot do one.
   *
   * A refusal is written down rather than thrown away. "We tried to refund this
   * family and the rail does not support it" is exactly what someone needs
   * three weeks later, and on most rails in this market it is the expected
   * outcome rather than an error.
   */
  const requestRefund = async (input: {
    paymentId: string;
    parentId: string;
    amount?: Money | undefined;
    reason: string;
    idempotencyKey: string;
    requestedBy?: string | undefined;
  }): Promise<{ status: 'succeeded' | 'failed' | 'unsupported' | 'duplicate' }> => {
    const payment = await asSystem(db, async (tx) => {
      const { rows } = await tx.query<PaymentRow>(
        `select id, parent_id, rail, status, rail_reference, amount_minor, currency,
                attempt_count
           from payments where id = $1::uuid and parent_id = $2`,
        [input.paymentId, input.parentId],
      );
      return rows[0];
    });

    if (payment?.status !== 'captured' || payment.rail_reference === null) {
      return { status: 'failed' };
    }

    const adapter = registry.get(payment.rail);
    const amount: Money = input.amount ?? {
      amountMinor: payment.amount_minor,
      currency: payment.currency,
    };

    const claimed = await asSystem(db, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `insert into payment_refunds
           (payment_id, parent_id, rail, idempotency_key, status, amount_minor,
            currency, reason, requested_by)
         values ($1, $2, $3, $4, 'requested', $5, $6, $7, $8::uuid)
         on conflict (payment_id, idempotency_key) do nothing
         returning id`,
        [
          payment.id,
          payment.parent_id,
          payment.rail,
          input.idempotencyKey,
          amount.amountMinor,
          amount.currency,
          input.reason,
          input.requestedBy ?? null,
        ],
      );
      return rows[0]?.id;
    });

    if (claimed === undefined) return { status: 'duplicate' };

    const settle = async (
      status: 'succeeded' | 'failed' | 'unsupported',
      failureCode?: PaymentFailureCode,
    ): Promise<void> => {
      await asSystem(db, async (tx) => {
        await tx.query(
          `update payment_refunds
              set status = $2, failure_code = $3, completed_at = $4
            where id = $1`,
          [claimed, status, failureCode ?? null, clock.nowIso()],
        );

        if (status === 'succeeded') {
          // A negative ledger entry, in the same transaction as the refund
          // record. The sign is enforced by ck_transactions_amount_sign.
          await tx.query(
            `insert into transactions
               (payment_id, subscription_id, parent_id, rail, external_id, kind, status,
                amount_minor, currency, occurred_at)
             select $1, p.subscription_id, p.parent_id, p.rail, $2, 'refund', 'succeeded',
                    $3, $4, $5
               from payments p where p.id = $1
             on conflict (rail, external_id) do nothing`,
            [
              payment.id,
              `refund_${claimed}`,
              -Math.abs(amount.amountMinor),
              amount.currency,
              clock.nowIso(),
            ],
          );

          await tx.query(`update payments set status = 'refunded' where id = $1`, [payment.id]);
        }
      });

      await auditOrFail(audit, {
        actorType: input.requestedBy === undefined ? 'system' : 'parent',
        ...(input.requestedBy === undefined ? {} : { actorId: input.requestedBy }),
        action: status === 'succeeded' ? 'payment.refund_succeeded' : 'payment.refund_refused',
        resourceType: 'payment',
        resourceId: payment.id,
        outcome: status === 'succeeded' ? 'success' : 'denied',
        metadata: { rail: payment.rail, status, ...(failureCode ? { failureCode } : {}) },
      });
    };

    if (!adapter || adapter.capabilities.refunds === 'none') {
      // Not an error. On carrier billing this is simply the truth, and the
      // product must not have offered the button in the first place.
      await settle('unsupported', 'not_supported');
      return { status: 'unsupported' };
    }

    try {
      const outcome = await adapter.refund({
        railReference: payment.rail_reference,
        amount,
        idempotencyKey: input.idempotencyKey,
        reason: input.reason,
      });

      if (outcome.status === 'succeeded') {
        await settle('succeeded');
        return { status: 'succeeded' };
      }
      await settle('failed', outcome.failureCode ?? 'unknown');
      return { status: 'failed' };
    } catch (error) {
      const unsupported = error instanceof RailCapabilityError;
      await settle(unsupported ? 'unsupported' : 'failed', 'not_supported');
      return { status: unsupported ? 'unsupported' : 'failed' };
    }
  };

  return { initiate, applyCallback, reconcile, requestRefund, applyResult };
};

export type PaymentStore = ReturnType<typeof createPaymentStore>;

/** Exported for the status endpoint, which reports what a family has been charged. */
export const paymentSummary = async (
  tx: Queryable,
  parentId: string,
): Promise<{
  capturedMinor: number;
  refundedMinor: number;
  unresolved: number;
  ledgerNetMinor: number;
}> => {
  const { rows } = await tx.query<{
    payments_captured: number;
    payments_failed: number;
    payments_unresolved: number;
    captured_minor: string | number;
    refunded_minor: string | number;
    ledger_net_minor: string | number;
  }>('select * from app.parent_payment_summary($1)', [parentId]);

  const row = rows[0];
  return {
    capturedMinor: Number(row?.captured_minor ?? 0),
    refundedMinor: Number(row?.refunded_minor ?? 0),
    unresolved: row?.payments_unresolved ?? 0,
    ledgerNetMinor: Number(row?.ledger_net_minor ?? 0),
  };
};

/** Kept for the route layer, which reports a payment's own timestamps. */
export const isoOrNull = iso;
