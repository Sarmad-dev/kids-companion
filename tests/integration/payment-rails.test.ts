import { createRailRegistry, signRailCallback } from '@kids/payments';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { paymentSummary } from '../../apps/api/src/payment-store.js';
import {
  authHeader,
  createApiHarness,
  registerAndLogin,
  TEST_PASSWORD,
  type ApiHarness,
  type RegisteredParent,
} from '../helpers/api.js';

/**
 * Payment rails, end to end.
 *
 * Two questions this file answers, and the first matters more:
 *
 *   1. Does the application work with NO payment rail at all? That is the
 *      default state of this product and the state it has been in for its
 *      entire life so far. A children's app must not fall over because a
 *      payment integration is unfinished.
 *
 *   2. When a rail IS enabled, does the payment layer stay honest — idempotent
 *      on retry, unmoved by a duplicate callback, unfooled by a forged one, and
 *      able to find a customer who paid without us noticing?
 */

const NOW = new Date('2026-09-15T10:00:00.000Z');
const SANDBOX_SECRET = 'local-sandbox-rail-signing-key';

describe('payment rails', () => {
  /* ======================================================================== */
  /* No rails at all                                                          */
  /* ======================================================================== */

  describe('with no rails enabled', () => {
    let harness: ApiHarness;
    let parent: RegisteredParent;

    beforeAll(async () => {
      // The default configuration. Nothing switched on.
      harness = await createApiHarness();
      harness.setNow(NOW);
      parent = await registerAndLogin(harness, 'rails-none');
    });

    afterAll(async () => {
      await harness.close();
    });

    it('boots, and says plainly that no payment method is available', async () => {
      const response = await harness.app.inject({
        method: 'GET',
        url: '/api/payments/rails',
        headers: authHeader(parent.accessToken),
      });

      expect(response.statusCode).toBe(200);
      const body = response.json<{ available: boolean; items: unknown[]; note: string }>();

      expect(body.available).toBe(false);
      expect(body.items).toEqual([]);
      // The wording matters: a parent reading this must not think the product
      // is broken or that their child has lost anything.
      expect(body.note).toContain('works as usual');
    });

    it('refuses a callback for a rail that is not enabled, without erroring', async () => {
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/payments/webhook/jazzcash',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ reference: 'x', rail_reference: 'y', status: 'captured' }),
      });

      expect(response.statusCode).toBe(400);
      expect(response.json<{ reason: string }>().reason).toBe('rail_unavailable');
    });

    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE POINT OF THE WHOLE SECTION.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * A child can talk. Payments being off changes nothing about the product a
     * family actually uses — it changes what they can buy, and nothing else.
     */
    it('leaves the rest of the application completely unaffected', async () => {
      const health = await harness.app.inject({ method: 'GET', url: '/ready' });
      expect(health.statusCode).toBe(200);

      const plans = await harness.app.inject({ method: 'GET', url: '/api/subscriptions/plans' });
      expect(plans.statusCode).toBe(200);

      const status = await harness.app.inject({
        method: 'GET',
        url: '/api/subscriptions/status',
        headers: authHeader(parent.accessToken),
      });
      expect(status.statusCode).toBe(200);
      expect(status.json<{ status: string }>().status).toBe('free');

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
      expect(child.statusCode).toBe(201);
    });
  });

  /* ======================================================================== */
  /* A sandbox rail enabled                                                   */
  /* ======================================================================== */

  describe('with a sandbox rail enabled', () => {
    let harness: ApiHarness;
    let parent: RegisteredParent;

    const railClock = (): Date => NOW;

    beforeAll(async () => {
      const registry = createRailRegistry({
        enabled: ['jazzcash', 'carrier_billing'],
        jazzcash: {
          merchantId: 'test-merchant',
          password: 'test-password',
          integritySalt: 'test-salt',
          mode: 'sandbox',
          sandboxCallbackSecret: SANDBOX_SECRET,
          now: railClock,
        },
        carrierBilling: {
          aggregator: 'test-aggregator',
          merchantId: 'test-merchant',
          apiKey: 'test-key',
          callbackSecret: 'test-callback',
          mode: 'sandbox',
          sandboxCallbackSecret: SANDBOX_SECRET,
          now: railClock,
        },
      });

      harness = await createApiHarness({ railRegistry: registry });
      harness.setNow(NOW);
      parent = await registerAndLogin(harness, 'rails-sandbox');
    });

    afterAll(async () => {
      await harness.close();
    });

    const deliver = async (body: Record<string, unknown>, secret = SANDBOX_SECRET) => {
      const raw = JSON.stringify(body);
      return await harness.app.inject({
        method: 'POST',
        url: '/api/payments/webhook/jazzcash',
        headers: {
          'content-type': 'application/json',
          'x-kc-rail-signature': signRailCallback(raw, secret, Math.floor(NOW.getTime() / 1000)),
        },
        payload: raw,
      });
    };

    it('reports what each rail can and cannot do', async () => {
      const response = await harness.app.inject({
        method: 'GET',
        url: '/api/payments/rails',
        headers: authHeader(parent.accessToken),
      });

      const body = response.json<{
        available: boolean;
        items: { rail: string; verified: boolean; supportsRefunds: boolean }[];
      }>();

      expect(body.available).toBe(true);

      // Every rail reports itself unverified, because none has been checked
      // against its provider's own documentation.
      for (const item of body.items) {
        expect(item.verified, item.rail).toBe(false);
      }

      const carrier = body.items.find((item) => item.rail === 'carrier_billing');
      expect(carrier?.supportsRefunds).toBe(false);
    });

    /* ---------------------------------------------------------------------- */
    /* Idempotency                                                            */
    /* ---------------------------------------------------------------------- */

    it('turns a retried request into one payment, not two', async () => {
      // The record is claimed BEFORE the rail is called, so a client retrying
      // after a timeout cannot produce a second charge.
      const { rows: before } = await harness.db.query<{ n: number }>(
        'select count(*)::int as n from payments where parent_id = $1',
        [parent.parentId],
      );

      const store = harness.paymentStore;
      const first = await store.initiate({
        parentId: parent.parentId,
        rail: 'jazzcash',
        amount: { amountMinor: 49_900, currency: 'PKR' },
        idempotencyKey: 'retry-key-000001',
        description: 'Monthly plan',
      });
      const second = await store.initiate({
        parentId: parent.parentId,
        rail: 'jazzcash',
        amount: { amountMinor: 49_900, currency: 'PKR' },
        idempotencyKey: 'retry-key-000001',
        description: 'Monthly plan',
      });

      expect(first.kind).toBe('started');
      expect(second.kind).toBe('existing');

      const { rows: after } = await harness.db.query<{ n: number }>(
        'select count(*)::int as n from payments where parent_id = $1',
        [parent.parentId],
      );
      expect(after[0]!.n).toBe(before[0]!.n + 1);
    });

    /* ---------------------------------------------------------------------- */
    /* Callbacks                                                              */
    /* ---------------------------------------------------------------------- */

    it('captures a payment from a verified callback, and only from one', async () => {
      const started = await harness.paymentStore.initiate({
        parentId: parent.parentId,
        rail: 'jazzcash',
        amount: { amountMinor: 49_900, currency: 'PKR' },
        idempotencyKey: 'callback-key-0001',
        description: 'Monthly plan',
      });

      expect(started.kind).toBe('started');
      if (started.kind !== 'started') return;

      // Still pending. A payment is not successful because we asked for it.
      const { rows: pending } = await harness.db.query<{ status: string }>(
        'select status from payments where id = $1',
        [started.paymentId],
      );
      expect(pending[0]?.status).toBe('pending');

      const response = await deliver({
        event_id: 'evt_capture_001',
        reference: started.paymentId,
        rail_reference: started.result.railReference,
        status: 'captured',
        occurred_at: NOW.toISOString(),
      });

      expect(response.statusCode).toBe(200);
      expect(response.json<{ outcome: string }>().outcome).toBe('applied');

      const { rows: captured } = await harness.db.query<{
        status: string;
        completed_at: string | null;
      }>('select status, completed_at from payments where id = $1', [started.paymentId]);
      expect(captured[0]?.status).toBe('captured');
      expect(captured[0]?.completed_at).not.toBeNull();

      // And the money is in the ledger, written in the same transaction.
      const { rows: ledger } = await harness.db.query<{ n: number }>(
        'select count(*)::int as n from transactions where payment_id = $1',
        [started.paymentId],
      );
      expect(ledger[0]?.n).toBe(1);
    });

    it('treats a redelivered callback as a no-op', async () => {
      const again = await deliver({
        event_id: 'evt_capture_001',
        reference: 'whatever',
        rail_reference: 'whatever',
        status: 'captured',
        occurred_at: NOW.toISOString(),
      });

      expect(again.statusCode).toBe(200);
      expect(again.json<{ outcome: string }>().outcome).toBe('duplicate');
    });

    it('refuses a forged callback', async () => {
      const response = await deliver(
        {
          event_id: 'evt_forged_001',
          reference: 'x',
          rail_reference: 'y',
          status: 'captured',
          occurred_at: NOW.toISOString(),
        },
        'an-attackers-guess',
      );

      expect(response.statusCode).toBe(400);
      expect(response.json<{ reason: string }>().reason).toBe('bad_signature');
    });

    it('does not let a forgery poison a real event id', async () => {
      // `payment_events` is keyed on (rail, external_event_id). An unverified
      // callback is never written there, so a forgery cannot make the genuine
      // delivery look like a duplicate.
      const { rows } = await harness.db.query<{ n: number }>(
        `select count(*)::int as n from payment_events where external_event_id = 'evt_forged_001'`,
      );

      expect(rows[0]?.n).toBe(0);
    });

    /* ---------------------------------------------------------------------- */
    /* Failure handling                                                       */
    /* ---------------------------------------------------------------------- */

    it('records a decline as terminal and a rail outage as retryable', async () => {
      const declined = await harness.paymentStore.initiate({
        parentId: parent.parentId,
        rail: 'jazzcash',
        amount: { amountMinor: 49_900, currency: 'PKR' },
        idempotencyKey: 'declined-key-0001',
        description: 'Monthly plan',
        payerHandle: '03000000001',
      });

      expect(declined.kind).toBe('failed');
      if (declined.kind !== 'failed') return;
      expect(declined.failureCode).toBe('declined');
      expect(declined.retryable).toBe(false);

      const outage = await harness.paymentStore.initiate({
        parentId: parent.parentId,
        rail: 'jazzcash',
        amount: { amountMinor: 49_900, currency: 'PKR' },
        idempotencyKey: 'outage-key-0001',
        description: 'Monthly plan',
        payerHandle: '03000000007',
      });

      expect(outage.kind).toBe('failed');
      if (outage.kind !== 'failed') return;
      expect(outage.failureCode).toBe('rail_unavailable');
      expect(outage.retryable).toBe(true);
    });

    it('keeps the rail’s own failure code out of anything a parent sees', async () => {
      const { rows } = await harness.db.query<{ failure_code: string }>(
        `select failure_code from payments where idempotency_key = 'declined-key-0001'`,
      );

      // Our vocabulary, not the rail's. A dunning policy written against vendor
      // codes breaks the first time a vendor renames one.
      expect(rows[0]?.failure_code).toBe('declined');
    });

    /* ---------------------------------------------------------------------- */
    /* Reconciliation                                                         */
    /* ---------------------------------------------------------------------- */

    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE CUSTOMER WHO PAID AND WAS NEVER CREDITED.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * The rail took the money and its callback never arrived. Nothing on the
     * request path can detect this — only asking the rail does. Without
     * reconciliation the family is charged, sees no subscription, and contacts
     * support.
     */
    it('finds a payment the rail took but never told us about', async () => {
      const started = await harness.paymentStore.initiate({
        parentId: parent.parentId,
        rail: 'jazzcash',
        amount: { amountMinor: 49_900, currency: 'PKR' },
        idempotencyKey: 'silent-key-000001',
        description: 'Monthly plan',
        payerHandle: '03000000005',
      });

      expect(started.kind).toBe('started');
      if (started.kind !== 'started') return;

      const { rows: stuck } = await harness.db.query<{ status: string }>(
        'select status from payments where id = $1',
        [started.paymentId],
      );
      expect(stuck[0]?.status).toBe('pending');

      // Backdate it past the reconciliation threshold, the way real time would.
      //
      // BOTH columns. `last_checked_at` is set the moment the rail first answers,
      // and the sweep deliberately will not re-ask about something it heard
      // about a minute ago — otherwise a rail having a bad minute gets hammered
      // by the sweep that noticed it was struggling.
      await harness.db.query(
        `update payments
            set initiated_at = initiated_at - interval '1 hour',
                last_checked_at = last_checked_at - interval '1 hour'
          where id = $1`,
        [started.paymentId],
      );

      const outcome = await harness.paymentStore.reconcile();
      expect(outcome.resolved).toBeGreaterThanOrEqual(1);

      const { rows: resolved } = await harness.db.query<{
        status: string;
        reconciled_at: string | null;
      }>('select status, reconciled_at from payments where id = $1', [started.paymentId]);

      expect(resolved[0]?.status).toBe('captured');
      expect(resolved[0]?.reconciled_at).not.toBeNull();
    });

    /* ---------------------------------------------------------------------- */
    /* Refunds                                                                */
    /* ---------------------------------------------------------------------- */

    it('records a refusal when the rail cannot return money', async () => {
      // Carrier billing generally cannot refund. The attempt is written down
      // rather than thrown away — "we tried and the rail cannot" is exactly
      // what someone needs three weeks later.
      const started = await harness.paymentStore.initiate({
        parentId: parent.parentId,
        rail: 'carrier_billing',
        amount: { amountMinor: 14_900, currency: 'PKR' },
        idempotencyKey: 'carrier-key-00001',
        description: 'Weekly plan',
      });
      if (started.kind !== 'started') throw new Error('expected a started payment');

      await harness.db.query(
        `update payments set status = 'captured', completed_at = now() where id = $1`,
        [started.paymentId],
      );

      const refund = await harness.paymentStore.requestRefund({
        paymentId: started.paymentId,
        parentId: parent.parentId,
        reason: 'parent asked',
        idempotencyKey: 'carrier-refund-0001',
      });

      expect(refund.status).toBe('unsupported');

      const { rows } = await harness.db.query<{ status: string; failure_code: string | null }>(
        'select status, failure_code from payment_refunds where payment_id = $1',
        [started.paymentId],
      );
      expect(rows[0]?.status).toBe('unsupported');
    });

    it('is idempotent about refunds too', async () => {
      const { rows: payment } = await harness.db.query<{ id: string }>(
        `select id from payments where idempotency_key = 'carrier-key-00001'`,
      );

      const again = await harness.paymentStore.requestRefund({
        paymentId: payment[0]!.id,
        parentId: parent.parentId,
        reason: 'parent asked again',
        idempotencyKey: 'carrier-refund-0001',
      });

      expect(again.status).toBe('duplicate');

      const { rows } = await harness.db.query<{ n: number }>(
        'select count(*)::int as n from payment_refunds where payment_id = $1',
        [payment[0]!.id],
      );
      expect(rows[0]?.n).toBe(1);
    });

    /* ---------------------------------------------------------------------- */
    /* Separation                                                             */
    /* ---------------------------------------------------------------------- */

    /**
     * ═══════════════════════════════════════════════════════════════════════
     * PAYMENT STATE IS NOT SUBSCRIPTION STATE.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Several payments have now been captured for this parent, and their
     * subscription is still free — because nothing in the payment layer writes
     * `subscriptions`, and nothing should. Collapsing the two gives one status
     * column that is wrong in both directions.
     */
    it('captures money without touching entitlement', async () => {
      const { rows: captured } = await harness.db.query<{ n: number }>(
        `select count(*)::int as n from payments
          where parent_id = $1 and status in ('captured', 'refunded')`,
        [parent.parentId],
      );
      expect(captured[0]!.n).toBeGreaterThan(0);

      const login = await harness.app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { email: parent.email, password: TEST_PASSWORD },
      });

      const status = await harness.app.inject({
        method: 'GET',
        url: '/api/subscriptions/status',
        headers: authHeader(login.json<{ accessToken: string }>().accessToken),
      });

      expect(status.json<{ status: string }>().status).toBe('free');
    });

    it('keeps a payment ledger that can be reconciled against the money ledger', async () => {
      const { rows } = await harness.db.query<{
        captured_minor: string;
        ledger_net_minor: string;
      }>('select * from app.parent_payment_summary($1)', [parent.parentId]);

      expect(Number(rows[0]?.captured_minor)).toBeGreaterThan(0);
      expect(Number(rows[0]?.ledger_net_minor)).toBeGreaterThan(0);
    });

    it('never stores anything card-shaped', async () => {
      const { rows } = await harness.db.query<{ payload: unknown }>(
        'select payload from payment_events',
      );

      for (const row of rows) {
        const serialised = JSON.stringify(row.payload);
        expect(serialised).not.toMatch(/\b\d{13,19}\b/);
      }
    });
  });
  /* ======================================================================== */
  /* Refunds on a rail that can actually return money                         */
  /* ======================================================================== */

  /**
   * The carrier-billing tests above cover the refusal path — a rail that cannot
   * refund saying so, and writing it down. That left the paths that MOVE MONEY
   * BACK untested, which is the wrong half to leave uncovered: a refund that
   * silently does nothing becomes a complaint, and one that over-returns is a
   * loss that nobody notices until reconciliation.
   *
   * Cards are the only rail here whose sandbox can refund at all.
   */
  describe('with a card rail enabled', () => {
    let harness: ApiHarness;
    let parent: RegisteredParent;

    beforeAll(async () => {
      const registry = createRailRegistry({
        enabled: ['card'],
        card: {
          processor: 'test-processor',
          secretKey: 'test-secret',
          webhookSecret: 'test-webhook',
          mode: 'sandbox',
          sandboxCallbackSecret: SANDBOX_SECRET,
          now: (): Date => NOW,
        },
      });

      harness = await createApiHarness({ railRegistry: registry });
      harness.setNow(NOW);
      parent = await registerAndLogin(harness, 'rails-card');
    });

    afterAll(async () => {
      await harness.close();
    });

    /**
     * Takes money the way it actually gets taken: initiate, then a signed
     * callback. Updating the row to 'captured' by hand would leave the RAIL
     * believing nothing was ever captured, and the refund would then fail for
     * a reason that has nothing to do with what is under test.
     */
    const capture = async (idempotencyKey: string, amountMinor: number): Promise<string> => {
      const started = await harness.paymentStore.initiate({
        parentId: parent.parentId,
        rail: 'card',
        amount: { amountMinor, currency: 'PKR' },
        idempotencyKey,
        description: 'Monthly plan',
      });
      if (started.kind !== 'started') throw new Error('expected a started payment');

      const body = {
        event_id: `evt_` + idempotencyKey,
        reference: started.paymentId,
        rail_reference: started.result.railReference,
        status: 'captured',
        occurred_at: NOW.toISOString(),
      };
      const raw = JSON.stringify(body);
      const timestamp = Math.floor(NOW.getTime() / 1000);

      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/payments/webhook/card',
        headers: {
          'content-type': 'application/json',
          'x-kc-rail-signature': signRailCallback(raw, SANDBOX_SECRET, timestamp),
        },
        payload: raw,
      });
      expect(response.statusCode).toBe(200);

      return started.paymentId;
    };

    it('returns the money and records the refund', async () => {
      const paymentId = await capture('card-key-000001', 49_900);

      const refund = await harness.paymentStore.requestRefund({
        paymentId,
        parentId: parent.parentId,
        reason: 'parent changed their mind',
        idempotencyKey: 'card-refund-00001',
      });

      expect(refund.status).toBe('succeeded');

      const { rows } = await harness.db.query<{ status: string }>(
        'select status from payment_refunds where payment_id = $1',
        [paymentId],
      );
      expect(rows[0]?.status).toBe('succeeded');
    });

    it('refuses to return more than was taken', async () => {
      const paymentId = await capture('card-key-000002', 10_000);

      const refund = await harness.paymentStore.requestRefund({
        paymentId,
        parentId: parent.parentId,
        amount: { amountMinor: 25_000, currency: 'PKR' },
        reason: 'fat finger',
        idempotencyKey: 'card-refund-00002',
      });

      /* Over-refunding is a reconciliation failure, not a rounding error, so it
       * must fail loudly rather than be clamped to the captured amount — a
       * clamp hides whatever produced the wrong number. */
      expect(refund.status).toBe('failed');

      const { rows } = await harness.db.query<{ status: string; failure_code: string | null }>(
        'select status, failure_code from payment_refunds where payment_id = $1',
        [paymentId],
      );
      expect(rows[0]?.status).toBe('failed');
      expect(rows[0]?.failure_code).toBe('limit_exceeded');
    });

    it('will not refund a payment belonging to somebody else', async () => {
      const paymentId = await capture('card-key-000003', 20_000);
      const stranger = await registerAndLogin(harness, 'rails-card-stranger');

      const refund = await harness.paymentStore.requestRefund({
        paymentId,
        parentId: stranger.parentId,
        reason: 'not mine to refund',
        idempotencyKey: 'card-refund-00003',
      });

      // The lookup is scoped by parent, so a stranger's refund finds nothing to
      // refund — indistinguishable, from the caller's side, from a payment that
      // cannot be refunded. That is the correct amount to disclose.
      expect(refund.status).toBe('failed');

      const { rows } = await harness.db.query<{ n: number }>(
        'select count(*)::int as n from payment_refunds where payment_id = $1',
        [paymentId],
      );
      expect(rows[0]?.n).toBe(0);
    });

    it('reports what a family has been charged, net of refunds', async () => {
      const summary = await harness.db.transaction(
        async (tx) => await paymentSummary(tx, parent.parentId),
      );

      // 49,900 + 10,000 + 20,000 taken; 49,900 given back.
      expect(summary.capturedMinor).toBe(79_900);
      expect(summary.refundedMinor).toBe(49_900);
    });
  });
});
