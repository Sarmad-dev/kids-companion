import { asSystem, type Database, type Queryable } from '@kids/db';
import {
  environmentAllowed,
  isStoreEntitled,
  PurchaseVerificationError,
  toSubscriptionStatus,
  type MobileStore,
  type PurchaseReceipt,
  type StoreBillingProvider,
  type VerifiedPurchase,
} from '@kids/payments';
import type { Clock } from '@kids/shared';

import { auditOrFail, type AuditLogger } from './audit.js';

/**
 * Store billing.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE CLIENT IS NEVER BELIEVED. NOT ONCE, ANYWHERE IN THIS FILE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Everything a device sends is one opaque token. Everything that gets written —
 * the state, the expiry, the product, the environment — comes back from Apple
 * or Google. There is no branch here that reads a client-supplied status,
 * because `PurchaseReceipt` has no field for one.
 *
 * That is worth stating so plainly because the shortcut is genuinely tempting:
 * the device already knows it just bought something, the store SDK already told
 * it the subscription is active, and forwarding that is one line of code. It is
 * also a free subscription for anyone who can modify an app or replay an HTTP
 * request, and a rooted Android phone is not an exotic threat model for a
 * children's product sold in a price-sensitive market.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE STORE OWNS THE SUBSCRIPTION. WE MIRROR IT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Renewals, retries, grace periods, cancellations, and expiry all happen at the
 * store, on its schedule, whether or not we are listening. Our `subscriptions`
 * row is a cache. When ours and theirs disagree, theirs is right — so this file
 * never "fixes" a subscription locally, it re-asks and writes down the answer.
 */

export interface StoreBillingOptions {
  readonly db: Database;
  readonly providers: ReadonlyMap<MobileStore, StoreBillingProvider>;
  readonly audit: AuditLogger;
  readonly clock: Clock;
}

export type VerifyOutcome =
  | {
      readonly kind: 'entitled';
      readonly purchaseId: string;
      readonly planCode: string | null;
      readonly state: string;
      readonly expiresAt: string | null;
    }
  | {
      readonly kind: 'not_entitled';
      readonly purchaseId: string;
      readonly state: string;
      readonly reason: string;
    }
  | {
      readonly kind: 'rejected';
      readonly reason:
        | 'store_unavailable'
        | 'invalid_token'
        | 'wrong_application'
        | 'wrong_environment'
        | 'owned_by_another_account'
        | 'not_configured';
    };

interface ClaimResult {
  outcome: 'created' | 'updated' | 'stale' | 'owned_by_another';
  purchase_id: string;
  owner_parent_id: string;
}

export const createStoreBilling = (options: StoreBillingOptions) => {
  const { db, providers, audit, clock } = options;

  /**
   * Writes the store's answer, and links it to a subscription.
   *
   * The subscription row is derived from the purchase, never the other way
   * round. `store_purchases` is the record of what the store said;
   * `subscriptions` is what the rest of the product reads, kept in step.
   */
  const persist = async (
    parentId: string,
    purchase: VerifiedPurchase,
  ): Promise<
    | { kind: 'claimed'; purchaseId: string; planCode: string | null; entitled: boolean }
    | { kind: 'owned_by_another'; ownerParentId: string }
    | { kind: 'stale'; purchaseId: string }
  > =>
    await asSystem(db, async (tx) => {
      const { rows } = await tx.query<ClaimResult>(
        `select * from app.claim_store_purchase(
           $1::uuid, $2, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz,
           $9::boolean, $10, $11::timestamptz, $12::timestamptz)`,
        [
          parentId,
          purchase.store,
          purchase.originalTransactionId,
          purchase.latestTransactionId ?? null,
          purchase.productId,
          purchase.state,
          purchase.expiresAt ?? null,
          purchase.gracePeriodEndsAt ?? null,
          purchase.autoRenewing,
          purchase.environment,
          purchase.verifiedAt,
          purchase.refundedAt ?? null,
        ],
      );

      const claim = rows[0];
      if (!claim) throw new Error('claim_store_purchase returned nothing');

      if (claim.outcome === 'owned_by_another') {
        return { kind: 'owned_by_another' as const, ownerParentId: claim.owner_parent_id };
      }
      if (claim.outcome === 'stale') {
        return { kind: 'stale' as const, purchaseId: claim.purchase_id };
      }

      /* Which plan the store's product maps to. An UNMAPPED product is left
       * null rather than defaulted to anything: silently falling back to the
       * free plan would take away something a family paid for, and silently
       * granting the best plan would give away something they did not. Null is
       * a visible gap that shows up in the response and in the logs. */
      const { rows: mapped } = await tx.query<{ plan_id: string; code: string }>(
        `select p.id as plan_id, p.code
           from store_product_map m
           join subscription_plans p on p.id = m.plan_id
          where m.store = $1 and m.product_id = $2 and m.is_active`,
        [purchase.store, purchase.productId],
      );

      const plan = mapped[0];
      const entitled = isStoreEntitled(purchase, clock.nowIso());

      if (plan) {
        /* Mirror into `subscriptions`.
         *
         * `rail` is the store, and `external_id` is the store's stable
         * transaction id — so the uniqueness the billing schema already
         * enforces on (rail, external_id) applies here too, and a second
         * subscription for the same store purchase is impossible rather than
         * merely unlikely. */
        const status = toSubscriptionStatus(purchase.state);

        const { rows: subscription } = await tx.query<{ id: string }>(
          `insert into subscriptions
             (parent_id, plan_id, rail, status, external_id, currency, price_minor,
              current_period_end, grace_ends_at, cancelled_at, cancel_at,
              last_event_at, last_event_id)
           select $1, $2, $3, $4, $5, p.currency, p.price_minor,
                  $6::timestamptz, $7::timestamptz,
                  case when $4 = 'cancelled' then $8::timestamptz else null end,
                  case when $4 = 'cancelled' then $6::timestamptz else null end,
                  $8::timestamptz, $9
             from subscription_plans p where p.id = $2
           on conflict (rail, external_id) where external_id is not null
           do update set
             status             = excluded.status,
             plan_id            = excluded.plan_id,
             current_period_end = excluded.current_period_end,
             grace_ends_at      = excluded.grace_ends_at,
             cancelled_at       = excluded.cancelled_at,
             cancel_at          = excluded.cancel_at,
             last_event_at      = excluded.last_event_at,
             last_event_id      = excluded.last_event_id
           returning id`,
          [
            parentId,
            plan.plan_id,
            purchase.store,
            status,
            purchase.originalTransactionId,
            purchase.expiresAt ?? null,
            status === 'grace' ? (purchase.gracePeriodEndsAt ?? null) : null,
            purchase.verifiedAt,
            purchase.latestTransactionId ?? purchase.originalTransactionId,
          ],
        );

        if (subscription[0]) {
          await tx.query('update store_purchases set subscription_id = $2 where id = $1', [
            claim.purchase_id,
            subscription[0].id,
          ]);
        }
      }

      return {
        kind: 'claimed' as const,
        purchaseId: claim.purchase_id,
        planCode: plan?.code ?? null,
        entitled,
      };
    });

  /* ---------------------------------------------------------------------- */
  /* Purchase verification                                                  */
  /* ---------------------------------------------------------------------- */

  const verify = async (parentId: string, receipt: PurchaseReceipt): Promise<VerifyOutcome> => {
    const provider = providers.get(receipt.store);
    if (!provider) return { kind: 'rejected', reason: 'not_configured' };

    let purchase: VerifiedPurchase;
    try {
      purchase = await provider.verifyPurchase(receipt);
    } catch (error) {
      const reason =
        error instanceof PurchaseVerificationError ? error.reason : 'store_unavailable';

      await auditOrFail(audit, {
        actorId: parentId,
        actorType: 'parent',
        action: 'store.purchase.rejected',
        resourceType: 'store_purchase',
        outcome: 'denied',
        // The store and the reason. Never the token: it is a bearer credential
        // for somebody's subscription and has no business in an audit log.
        metadata: { store: receipt.store, reason },
      });

      return {
        kind: 'rejected',
        reason:
          reason === 'wrong_application' ||
          reason === 'wrong_environment' ||
          reason === 'invalid_token' ||
          reason === 'not_configured'
            ? reason
            : 'store_unavailable',
      };
    }

    /* ------------------------------------------------------------------ */
    /* The environment gate                                               */
    /* ------------------------------------------------------------------ */
    /* A sandbox purchase honoured in production is a free subscription for
     * anyone with a test account, and both stores make the two easy to
     * confuse. Checked here, explicitly, rather than trusted to whichever
     * endpoint the adapter happened to call. */
    if (!environmentAllowed(purchase.environment, provider.environment)) {
      await auditOrFail(audit, {
        actorId: parentId,
        actorType: 'parent',
        action: 'store.purchase.rejected',
        resourceType: 'store_purchase',
        outcome: 'denied',
        metadata: {
          store: receipt.store,
          reason: 'wrong_environment',
          purchaseEnvironment: purchase.environment,
        },
      });
      return { kind: 'rejected', reason: 'wrong_environment' };
    }

    const stored = await persist(parentId, purchase);

    if (stored.kind === 'owned_by_another') {
      /* ---------------------------------------------------------------- */
      /* The same purchase under two accounts                             */
      /* ---------------------------------------------------------------- */
      /* Not merely an error. A store account is not our account, purchase
       * tokens can be shared or published, and this is what one subscription
       * being spread across many families looks like from the server.
       *
       * Recorded with both parent ids so the pattern is visible — one purchase
       * attempted by a dozen accounts is a very different thing from a family
       * reinstalling on a second device. */
      await auditOrFail(audit, {
        actorId: parentId,
        actorType: 'parent',
        action: 'store.purchase.conflict',
        resourceType: 'store_purchase',
        outcome: 'denied',
        justification: 'purchase already claimed by a different account',
        metadata: { store: receipt.store, ownerParentId: stored.ownerParentId },
      });

      return { kind: 'rejected', reason: 'owned_by_another_account' };
    }

    if (stored.kind === 'stale') {
      // The store gave an answer older than one we already hold. Nothing to do,
      // and nothing wrong — this is what an out-of-order arrival looks like.
      const current = await entitlement(parentId);
      return current.entitled
        ? {
            kind: 'entitled',
            purchaseId: stored.purchaseId,
            planCode: current.planCode,
            state: current.state,
            expiresAt: current.expiresAt,
          }
        : {
            kind: 'not_entitled',
            purchaseId: stored.purchaseId,
            state: current.state,
            reason: 'stale_answer',
          };
    }

    await auditOrFail(audit, {
      actorId: parentId,
      actorType: 'parent',
      action: stored.entitled ? 'store.purchase.verified' : 'store.purchase.not_entitled',
      resourceType: 'store_purchase',
      resourceId: stored.purchaseId,
      outcome: 'success',
      metadata: {
        store: purchase.store,
        state: purchase.state,
        plan: stored.planCode,
        environment: purchase.environment,
      },
    });

    return stored.entitled
      ? {
          kind: 'entitled',
          purchaseId: stored.purchaseId,
          planCode: stored.planCode,
          state: purchase.state,
          expiresAt: purchase.expiresAt ?? null,
        }
      : {
          kind: 'not_entitled',
          purchaseId: stored.purchaseId,
          state: purchase.state,
          reason: purchase.state,
        };
  };

  /* ---------------------------------------------------------------------- */
  /* Restore purchases                                                      */
  /* ---------------------------------------------------------------------- */

  /**
   * Restores whatever the device's store account already owns.
   *
   * ═══════════════════════════════════════════════════════════════════════
   * RESTORE IS NOT A SPECIAL CASE. IT IS VERIFICATION, AGAIN.
   * ═══════════════════════════════════════════════════════════════════════
   *
   * The temptation is to make restore lenient — the family already paid, they
   * are only reinstalling, be generous. That leniency is exactly the hole: a
   * "restore" endpoint that trusts the client is a purchase endpoint that
   * trusts the client, reached by a different name.
   *
   * So restore runs the same verification, the same environment gate, and the
   * same one-purchase-one-parent rule. What makes it a restore is that the
   * purchase usually already exists, and re-presenting it is expected rather
   * than suspicious.
   */
  const restore = async (
    parentId: string,
    receipts: readonly PurchaseReceipt[],
  ): Promise<{ restored: number; results: readonly VerifyOutcome[] }> => {
    const results: VerifyOutcome[] = [];

    for (const receipt of receipts) {
      results.push(await verify(parentId, receipt));
    }

    const restored = results.filter((result) => result.kind === 'entitled').length;

    await auditOrFail(audit, {
      actorId: parentId,
      actorType: 'parent',
      action: 'store.purchases.restored',
      resourceType: 'store_purchase',
      outcome: 'success',
      metadata: { presented: receipts.length, restored },
    });

    return { restored, results };
  };

  /* ---------------------------------------------------------------------- */
  /* Notifications                                                          */
  /* ---------------------------------------------------------------------- */

  /**
   * Handles a server-to-server notification.
   *
   * The payload is recorded and then IGNORED. What the notification achieves is
   * telling us which subscription to re-ask about; the answer comes from the
   * store, freshly. That is what makes a delayed or replayed notification
   * harmless, and it is why a forged one cannot do anything worse than waste a
   * round trip.
   */
  const handleNotification = async (
    store: MobileStore,
    notificationId: string,
    kind: string,
    originalTransactionId: string,
    occurredAt: string,
    environment: 'sandbox' | 'production',
    payload: Readonly<Record<string, unknown>>,
  ): Promise<'applied' | 'duplicate' | 'unknown_purchase' | 'ignored'> => {
    const claimed = await asSystem(db, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `insert into store_notifications
           (store, notification_id, kind, original_transaction_id, environment,
            signature_verified, payload, occurred_at, processing_status)
         values ($1, $2, $3, $4, $5, true, $6::jsonb, $7::timestamptz, 'pending')
         on conflict (store, notification_id) do nothing
         returning id`,
        [
          store,
          notificationId,
          kind,
          originalTransactionId,
          environment,
          JSON.stringify(payload),
          occurredAt,
        ],
      );

      if (!rows[0]) {
        await tx.query(
          `update store_notifications set delivery_count = delivery_count + 1
            where store = $1 and notification_id = $2`,
          [store, notificationId],
        );
        return undefined;
      }
      return rows[0].id;
    });

    if (claimed === undefined) return 'duplicate';

    const finish = async (
      status: 'processed' | 'ignored' | 'failed',
      reason: string | null,
      purchaseId?: string,
      parentId?: string,
    ): Promise<void> => {
      await asSystem(db, async (tx) => {
        await tx.query(
          `update store_notifications
              set processing_status = $2, processed_at = now(), ignored_reason = $3,
                  store_purchase_id = coalesce($4::uuid, store_purchase_id),
                  parent_id = coalesce($5::uuid, parent_id)
            where id = $1`,
          [claimed, status, reason, purchaseId ?? null, parentId ?? null],
        );
      });
    };

    const owner = await asSystem(db, async (tx) => {
      const { rows } = await tx.query<{ id: string; parent_id: string }>(
        `select id, parent_id from store_purchases
          where store = $1 and original_transaction_id = $2`,
        [store, originalTransactionId],
      );
      return rows[0];
    });

    if (!owner) {
      // A notification about a purchase nobody has presented to us. Common and
      // benign: a subscriber can buy in the store before ever signing in.
      await finish('ignored', 'unknown_purchase');
      return 'unknown_purchase';
    }

    const provider = providers.get(store);
    if (!provider) {
      await finish('ignored', 'store_not_configured', owner.id, owner.parent_id);
      return 'ignored';
    }

    try {
      // The re-ask. This, and not the payload, is what changes anything.
      const fresh = await provider.refresh(originalTransactionId);
      const stored = await persist(owner.parent_id, fresh);

      if (stored.kind === 'stale') {
        await finish('ignored', 'stale_answer', owner.id, owner.parent_id);
        return 'ignored';
      }

      await asSystem(db, async (tx) => {
        await tx.query('update store_purchases set last_notification_at = $2 where id = $1', [
          owner.id,
          clock.nowIso(),
        ]);
      });

      await finish('processed', null, owner.id, owner.parent_id);

      await auditOrFail(audit, {
        actorType: 'system',
        action: 'store.subscription.synchronised',
        resourceType: 'store_purchase',
        resourceId: owner.id,
        outcome: 'success',
        metadata: { store, kind, state: fresh.state, via: 'notification' },
      });

      return 'applied';
    } catch (error) {
      await finish(
        'failed',
        error instanceof Error ? error.message.slice(0, 200) : 'unknown',
        owner.id,
        owner.parent_id,
      );
      throw error;
    }
  };

  /* ---------------------------------------------------------------------- */
  /* Synchronisation                                                        */
  /* ---------------------------------------------------------------------- */

  /**
   * Re-asks the store about subscriptions we have not heard about lately.
   *
   * Notifications are unreliable, not absent — both stores eventually tell us
   * and neither tells us promptly. Without this sweep, a lost notification
   * leaves a family entitled long after they stopped paying, or unentitled
   * after a renewal we never saw.
   */
  const synchronise = async (
    olderThanHours = 24,
    limit = 100,
  ): Promise<{ checked: number; changed: number }> => {
    const due = await asSystem(db, async (tx) => {
      const { rows } = await tx.query<{
        purchase_id: string;
        parent_id: string;
        store: MobileStore;
        original_transaction_id: string;
        state: string;
      }>('select * from app.store_purchases_needing_sync($1, $2, $3)', [
        olderThanHours,
        limit,
        clock.nowIso(),
      ]);
      return rows;
    });

    let changed = 0;

    for (const row of due) {
      const provider = providers.get(row.store);
      if (!provider) continue;

      try {
        const fresh = await provider.refresh(row.original_transaction_id);
        const stored = await persist(row.parent_id, fresh);
        if (stored.kind === 'claimed' && fresh.state !== row.state) changed += 1;
      } catch {
        // The store is unreachable. Left alone: a store outage must not empty
        // out every family's entitlement, and the next sweep will try again.
        continue;
      }
    }

    return { checked: due.length, changed };
  };

  /* ---------------------------------------------------------------------- */
  /* Reading                                                                */
  /* ---------------------------------------------------------------------- */

  const entitlement = async (
    parentId: string,
  ): Promise<{
    entitled: boolean;
    state: string;
    planCode: string | null;
    expiresAt: string | null;
    store: string | null;
    autoRenewing: boolean;
  }> => await asSystem(db, async (tx) => await readEntitlement(tx, parentId, clock.nowIso()));

  return { verify, restore, handleNotification, synchronise, entitlement };
};

export type StoreBilling = ReturnType<typeof createStoreBilling>;

/** Exported so a route can read inside its own parent-scoped transaction. */
export const readEntitlement = async (
  tx: Queryable,
  parentId: string,
  nowIso: string,
): Promise<{
  entitled: boolean;
  state: string;
  planCode: string | null;
  expiresAt: string | null;
  store: string | null;
  autoRenewing: boolean;
}> => {
  const { rows } = await tx.query<{
    store: string;
    effective_state: string;
    entitled: boolean;
    expires_at: string | null;
    auto_renewing: boolean;
    plan_code: string | null;
  }>('select * from app.store_entitlement($1, $2)', [parentId, nowIso]);

  const row = rows[0];
  if (!row) {
    return {
      entitled: false,
      state: 'none',
      planCode: null,
      expiresAt: null,
      store: null,
      autoRenewing: false,
    };
  }

  return {
    entitled: row.entitled,
    state: row.effective_state,
    planCode: row.plan_code,
    expiresAt: row.expires_at === null ? null : new Date(row.expires_at).toISOString(),
    store: row.store,
    autoRenewing: row.auto_renewing,
  };
};
