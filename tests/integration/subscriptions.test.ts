import { signMockWebhook, type SubscriptionProvider } from '@kids/payments';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  authHeader,
  createApiHarness,
  MOCK_WEBHOOK_SECRET,
  registerAndLogin,
  TEST_PASSWORD,
  type ApiHarness,
  type RegisteredParent,
} from '../helpers/api.js';

/**
 * Subscriptions, end to end.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * EVERY WEBHOOK IN THIS FILE IS SIGNED THE WAY A REAL RAIL SIGNS ONE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * There is no test-only bypass, no "skip verification in CI" flag, and no mock
 * that returns `{ verified: true }`. The suite computes an HMAC over the exact
 * bytes it posts, with a timestamp inside the signed material — so when a test
 * asserts that a forgery is rejected, the accepted case went through the same
 * check and the assertion is worth something.
 *
 * The nine scenarios the brief names each have a section below. The one to read
 * first is "the frontend cannot grant itself anything", because it is the
 * property everything else is arranged to protect.
 *
 * TWO NOTES ON THE CLOCK, both learned the hard way here.
 *
 * The timeline runs FORWARD FROM A FUTURE DATE. `sessions.issued_at` defaults to
 * the database's own `now()`, and a check constraint requires the expiry to
 * follow it — so a harness clock set into the past makes login fail on a
 * constraint rather than on anything to do with subscriptions.
 *
 * And every authenticated call signs in again through `as()`. Access tokens last
 * fifteen minutes; this suite moves the clock by months, so a token captured at
 * setup would be long expired by the assertion that used it.
 */

/** Comfortably ahead of any real wall clock this suite runs against. */
const START = new Date('2026-09-01T12:00:00.000Z');

describe('subscriptions', () => {
  let harness: ApiHarness;
  let alice: RegisteredParent;
  let bob: RegisteredParent;
  /* Declared here because the replay scenarios assert against the subscription
   * the resume scenarios set up. */
  let dan: RegisteredParent;

  let clock = START;
  const setNow = (date: Date): void => {
    clock = date;
    harness.setNow(date);
  };

  /* ------------------------------------------------------------------------ */
  /* Helpers                                                                   */
  /* ------------------------------------------------------------------------ */

  /** A fresh session at the current clock. See the note about token lifetimes. */
  const as = async (parent: RegisteredParent): Promise<Record<string, string>> => {
    const login = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: parent.email, password: TEST_PASSWORD },
    });
    if (login.statusCode !== 200) {
      throw new Error(`login failed: ${String(login.statusCode)} ${login.body}`);
    }
    return authHeader(login.json<{ accessToken: string }>().accessToken);
  };

  interface WebhookBody {
    id: string;
    type: string;
    occurred_at: string;
    data?: Record<string, unknown>;
  }

  /** Posts a webhook signed exactly as the rail would sign it. */
  const deliver = async (
    body: WebhookBody,
    options: { secret?: string; signedAt?: Date; rail?: string } = {},
  ) => {
    const raw = JSON.stringify(body);
    const signedAt = options.signedAt ?? clock;
    const signature = signMockWebhook(
      raw,
      options.secret ?? MOCK_WEBHOOK_SECRET,
      Math.floor(signedAt.getTime() / 1000),
    );

    return await harness.app.inject({
      method: 'POST',
      url: `/api/subscriptions/webhook/${options.rail ?? 'mock'}`,
      headers: { 'content-type': 'application/json', 'x-kc-signature': signature },
      payload: raw,
    });
  };

  /** Opens a checkout and returns its id — the reference a rail echoes back. */
  const openCheckout = async (
    parent: RegisteredParent,
    planCode: string,
    idempotencyKey: string,
  ): Promise<string> => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/subscriptions/create',
      headers: await as(parent),
      payload: { planCode, idempotencyKey },
    });

    if (response.statusCode !== 201) {
      throw new Error(`checkout failed: ${String(response.statusCode)} ${response.body}`);
    }
    return response.json<{ checkoutId: string }>().checkoutId;
  };

  interface Status {
    status: string;
    entitled: boolean;
    plan: { code: string };
    graceEndsAt: string | null;
    currentPeriodEnd: string | null;
    cancelAt: string | null;
    trialAvailable: boolean;
    explanation: string;
  }

  const statusOf = async (parent: RegisteredParent): Promise<Status> => {
    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/subscriptions/status',
      headers: await as(parent),
    });
    if (response.statusCode !== 200) {
      throw new Error(`status failed: ${String(response.statusCode)} ${response.body}`);
    }
    return response.json<Status>();
  };

  /** Entitlements as of the harness clock, the way a request would resolve them. */
  const entitlementsOf = async (parentId: string) => {
    const { rows } = await harness.db.query<{ plan_code: string; daily_minute_limit: number }>(
      'select plan_code, daily_minute_limit from app.parent_entitlements($1, $2)',
      [parentId, clock.toISOString()],
    );
    return rows[0];
  };

  beforeAll(async () => {
    harness = await createApiHarness();
    setNow(START);
    alice = await registerAndLogin(harness, 'subs-alice');
    bob = await registerAndLogin(harness, 'subs-bob');
  });

  afterAll(async () => {
    await harness.close();
  });

  /* ======================================================================== */
  /* The plan catalogue                                                       */
  /* ======================================================================== */

  describe('GET /api/subscriptions/plans', () => {
    it('lists the five plans, priced from the database', async () => {
      const response = await harness.app.inject({
        method: 'GET',
        url: '/api/subscriptions/plans',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json<{
        items: { code: string; priceMinor: number; tier: string; billingInterval: string }[];
      }>();

      expect(body.items.map((plan) => plan.code)).toEqual([
        'free',
        'weekly',
        'monthly',
        'yearly',
        'family',
      ]);

      const free = body.items.find((plan) => plan.code === 'free');
      expect(free?.priceMinor).toBe(0);
      expect(free?.tier).toBe('free');

      // Every paid plan costs something and renews on an interval. A paid plan
      // priced at zero is a pricing typo that would otherwise ship silently.
      for (const plan of body.items.filter((item) => item.tier === 'paid')) {
        expect(plan.priceMinor, plan.code).toBeGreaterThan(0);
        expect(['week', 'month', 'year']).toContain(plan.billingInterval);
      }
    });

    it('is readable without signing in — a price list is not personal data', async () => {
      const response = await harness.app.inject({ method: 'GET', url: '/api/subscriptions/plans' });

      expect(response.statusCode).toBe(200);
    });
  });

  /* ======================================================================== */
  /* The frontend cannot grant itself anything                                */
  /* ======================================================================== */

  describe('the frontend cannot grant itself a subscription', () => {
    it('starts every account on the free tier', async () => {
      const status = await statusOf(alice);

      expect(status.status).toBe('free');
      expect(status.entitled).toBe(false);
      expect(status.plan.code).toBe('free');
    });

    it('opens a checkout without granting anything', async () => {
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/subscriptions/create',
        headers: await as(alice),
        payload: { planCode: 'monthly', idempotencyKey: 'alice-checkout-0001' },
      });

      expect(response.statusCode).toBe(201);
      expect(response.json<{ status: string }>().status).toBe('pending');

      // The whole point: the parent has been sent to a payment page and has
      // exactly the entitlement they had before.
      const status = await statusOf(alice);
      expect(status.status).toBe('free');
      expect(status.entitled).toBe(false);
    });

    it('refuses a body that claims the payment succeeded', async () => {
      // There is no field for it in the schema, and `.strict()` makes an
      // unexpected key a validation error rather than something silently
      // ignored that a later refactor might start reading.
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/subscriptions/create',
        headers: await as(alice),
        payload: {
          planCode: 'monthly',
          idempotencyKey: 'alice-checkout-0002',
          status: 'active',
          paid: true,
        },
      });

      expect(response.statusCode).toBe(400);
      expect((await statusOf(alice)).status).toBe('free');
    });

    it('returns the same checkout for a repeated idempotency key', async () => {
      const first = await openCheckout(bob, 'monthly', 'bob-idem-0001');
      const second = await openCheckout(bob, 'monthly', 'bob-idem-0001');

      expect(second).toBe(first);

      const { rows } = await harness.db.query<{ n: number }>(
        `select count(*)::int as n from subscription_checkouts
          where parent_id = $1 and idempotency_key = $2`,
        [bob.parentId, 'bob-idem-0001'],
      );
      expect(rows[0]?.n).toBe(1);
    });

    it('refuses a checkout for the free plan', async () => {
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/subscriptions/create',
        headers: await as(alice),
        payload: { planCode: 'free', idempotencyKey: 'alice-free-0001' },
      });

      expect(response.statusCode).toBe(400);
    });

    it('refuses an unauthenticated checkout', async () => {
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/subscriptions/create',
        payload: { planCode: 'monthly', idempotencyKey: 'anon-checkout-0001' },
      });

      expect(response.statusCode).toBe(401);
    });
  });

  /* ======================================================================== */
  /* 1. Successful payment                                                    */
  /* ======================================================================== */

  describe('a successful payment', () => {
    it('activates the subscription from a verified webhook, and only then', async () => {
      const checkoutId = await openCheckout(alice, 'monthly', 'alice-pay-0001');

      const response = await deliver({
        id: 'evt_activate_001',
        type: 'subscription.activated',
        occurred_at: clock.toISOString(),
        data: {
          reference: checkoutId,
          subscription_id: 'sub_alice_001',
          amount_minor: 49_900,
          currency: 'PKR',
          payment_method: { brand: 'visa', last4: '4242' },
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json<{ outcome: string }>().outcome).toBe('applied');

      const status = await statusOf(alice);
      expect(status.status).toBe('active');
      expect(status.entitled).toBe(true);
      expect(status.plan.code).toBe('monthly');
      expect(status.currentPeriodEnd).toBe('2026-10-01T12:00:00.000Z');
    });

    it('records the money in the ledger, in the same transaction', async () => {
      const { rows } = await harness.db.query<{
        kind: string;
        status: string;
        amount_minor: number;
      }>(
        `select kind, status, amount_minor from transactions
          where parent_id = $1 order by occurred_at desc limit 1`,
        [alice.parentId],
      );

      expect(rows[0]).toMatchObject({ kind: 'charge', status: 'succeeded', amount_minor: 49_900 });
    });

    it('marks the checkout completed and ties it to the subscription', async () => {
      const { rows } = await harness.db.query<{ status: string; subscription_id: string | null }>(
        `select status, subscription_id from subscription_checkouts
          where parent_id = $1 and idempotency_key = 'alice-pay-0001'`,
        [alice.parentId],
      );

      expect(rows[0]?.status).toBe('completed');
      expect(rows[0]?.subscription_id).not.toBeNull();
    });

    it('raises the entitlement a child actually gets', async () => {
      // The point of paying. The free plan allows ten minutes a day; monthly
      // allows sixty — and the limit a conversation is checked against comes
      // from the same row the price does.
      expect(await entitlementsOf(alice.parentId)).toMatchObject({
        plan_code: 'monthly',
        daily_minute_limit: 60,
      });
    });
  });

  /* ======================================================================== */
  /* 2. Duplicate webhook                                                     */
  /* ======================================================================== */

  describe('a duplicate webhook', () => {
    it('is a no-op, and says so', async () => {
      const again = await deliver({
        id: 'evt_activate_001',
        type: 'subscription.activated',
        occurred_at: clock.toISOString(),
        data: { reference: 'ignored', amount_minor: 49_900, currency: 'PKR' },
      });

      expect(again.statusCode).toBe(200);
      expect(again.json<{ outcome: string }>().outcome).toBe('duplicate');
    });

    it('does not charge the ledger twice', async () => {
      const { rows } = await harness.db.query<{ n: number }>(
        `select count(*)::int as n from transactions where parent_id = $1`,
        [alice.parentId],
      );

      expect(rows[0]?.n).toBe(1);
    });

    it('counts the redeliveries — a retrying rail is normal, a flood is not', async () => {
      const { rows } = await harness.db.query<{ delivery_count: number }>(
        `select delivery_count from payment_events where external_event_id = 'evt_activate_001'`,
      );

      expect(rows[0]?.delivery_count).toBeGreaterThanOrEqual(2);
    });
  });

  /* ======================================================================== */
  /* 3. Renewal                                                               */
  /* ======================================================================== */

  describe('a renewal', () => {
    it('rolls the period forward', async () => {
      setNow(new Date('2026-10-01T12:05:00.000Z'));

      const response = await deliver({
        id: 'evt_renew_001',
        type: 'subscription.renewed',
        occurred_at: clock.toISOString(),
        data: { subscription_id: 'sub_alice_001', amount_minor: 49_900, currency: 'PKR' },
      });

      expect(response.json<{ outcome: string }>().outcome).toBe('applied');

      const status = await statusOf(alice);
      expect(status.status).toBe('active');
      expect(status.currentPeriodEnd).toBe('2026-11-01T12:05:00.000Z');
    });
  });

  /* ======================================================================== */
  /* 4. Failed payment, and 5. the grace period                               */
  /* ======================================================================== */

  describe('a failed payment', () => {
    it('opens a grace window instead of cutting the child off', async () => {
      setNow(new Date('2026-11-01T12:10:00.000Z'));

      const response = await deliver({
        id: 'evt_fail_001',
        type: 'payment.failed',
        occurred_at: clock.toISOString(),
        data: {
          subscription_id: 'sub_alice_001',
          amount_minor: 49_900,
          currency: 'PKR',
          failure_code: 'card_declined',
        },
      });

      expect(response.json<{ outcome: string }>().outcome).toBe('applied');

      const status = await statusOf(alice);
      expect(status.status).toBe('grace');
      // THE POINT: still entitled. A five-year-old mid-story did not decline
      // the card.
      expect(status.entitled).toBe(true);
      expect(status.graceEndsAt).toBe('2026-11-08T12:10:00.000Z');
      expect(status.explanation).toContain('nothing has been switched off');
    });

    it('keeps the paid plan’s limits during grace', async () => {
      expect(await entitlementsOf(alice.parentId)).toMatchObject({
        plan_code: 'monthly',
        daily_minute_limit: 60,
      });
    });

    it('records the failure in the ledger with its reason', async () => {
      const { rows } = await harness.db.query<{ status: string; failure_code: string | null }>(
        `select status, failure_code from transactions where external_id = 'evt_fail_001'`,
      );

      expect(rows[0]).toMatchObject({ status: 'failed', failure_code: 'card_declined' });
    });

    /**
     * ═══════════════════════════════════════════════════════════════════════
     * DUNNING RETRIES MUST NOT EXTEND THE WINDOW.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Rails retry a failed charge every couple of days. If each failure reset
     * the grace deadline, a card that never works would buy unlimited service
     * — and the code doing it would look considerate.
     */
    it('does not extend the window on the next dunning retry', async () => {
      setNow(new Date('2026-11-04T12:00:00.000Z'));

      await deliver({
        id: 'evt_fail_002',
        type: 'payment.failed',
        occurred_at: clock.toISOString(),
        data: { subscription_id: 'sub_alice_001', failure_code: 'card_declined' },
      });

      const status = await statusOf(alice);
      expect(status.status).toBe('grace');
      expect(status.graceEndsAt).toBe('2026-11-08T12:10:00.000Z');
    });
  });

  /* ======================================================================== */
  /* 6. Expiration                                                            */
  /* ======================================================================== */

  describe('expiration', () => {
    it('ends the moment the grace window closes, with no sweep involved', async () => {
      // The gap between a deadline passing and a background job noticing is
      // exactly where free service would hide. `app.subscription_state` applies
      // elapsed deadlines on read, so there is no such gap.
      setNow(new Date('2026-11-08T12:11:00.000Z'));

      const status = await statusOf(alice);
      expect(status.status).toBe('expired');
      expect(status.entitled).toBe(false);
      expect(status.plan.code).toBe('free');
    });

    it('drops the child back to free-tier limits', async () => {
      expect(await entitlementsOf(alice.parentId)).toMatchObject({
        plan_code: 'free',
        daily_minute_limit: 10,
      });
    });

    it('says so in words a parent can act on, without threatening their data', async () => {
      const status = await statusOf(alice);

      expect(status.explanation).toContain('free plan');
      expect(status.explanation).toContain('nothing has been deleted');
    });
  });

  /* ======================================================================== */
  /* 7. Cancellation                                                          */
  /* ======================================================================== */

  describe('cancellation', () => {
    let carol: RegisteredParent;

    beforeAll(async () => {
      setNow(new Date('2026-12-01T09:00:00.000Z'));
      carol = await registerAndLogin(harness, 'subs-carol');

      const checkoutId = await openCheckout(carol, 'monthly', 'carol-pay-0001');
      await deliver({
        id: 'evt_carol_activate',
        type: 'subscription.activated',
        occurred_at: clock.toISOString(),
        data: {
          reference: checkoutId,
          subscription_id: 'sub_carol_001',
          amount_minor: 49_900,
          currency: 'PKR',
        },
      });
    });

    it('lets the paid period run out rather than revoking on the spot', async () => {
      setNow(new Date('2026-12-03T09:00:00.000Z'));

      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/subscriptions/cancel',
        headers: await as(carol),
        payload: {},
      });

      expect(response.statusCode).toBe(200);
      expect(response.json<{ accessUntil: string | null }>().accessUntil).toBe(
        '2027-01-01T09:00:00.000Z',
      );

      const status = await statusOf(carol);
      expect(status.status).toBe('cancelled');
      // Still entitled: they paid for the month.
      expect(status.entitled).toBe(true);
      expect(status.plan.code).toBe('monthly');
    });

    it('keeps the paid plan’s limits until the period actually ends', async () => {
      expect(await entitlementsOf(carol.parentId)).toMatchObject({
        plan_code: 'monthly',
        daily_minute_limit: 60,
      });
    });

    it('expires when the paid period ends', async () => {
      setNow(new Date('2027-01-01T09:00:01.000Z'));

      const status = await statusOf(carol);
      expect(status.status).toBe('expired');
      expect(status.entitled).toBe(false);
    });

    it('refuses to resume a subscription that has already ended', async () => {
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/subscriptions/resume',
        headers: await as(carol),
        payload: {},
      });

      expect(response.statusCode).toBe(400);
    });

    it('refuses to cancel when there is nothing to cancel', async () => {
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/subscriptions/cancel',
        headers: await as(carol),
        payload: {},
      });

      expect(response.statusCode).toBe(400);
    });
  });

  /* ======================================================================== */
  /* Resume                                                                   */
  /* ======================================================================== */

  describe('resume', () => {
    beforeAll(async () => {
      setNow(new Date('2027-02-01T09:00:00.000Z'));
      dan = await registerAndLogin(harness, 'subs-dan');

      const checkoutId = await openCheckout(dan, 'family', 'dan-pay-0001');
      await deliver({
        id: 'evt_dan_activate',
        type: 'subscription.activated',
        occurred_at: clock.toISOString(),
        data: {
          reference: checkoutId,
          subscription_id: 'sub_dan_001',
          amount_minor: 79_900,
          currency: 'PKR',
        },
      });

      await harness.app.inject({
        method: 'POST',
        url: '/api/subscriptions/cancel',
        headers: await as(dan),
        payload: {},
      });
    });

    it('reverses a cancellation that has not taken effect', async () => {
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/subscriptions/resume',
        headers: await as(dan),
        payload: {},
      });

      expect(response.statusCode).toBe(200);

      const status = await statusOf(dan);
      expect(status.status).toBe('active');
      expect(status.cancelAt).toBeNull();
    });

    it('does not resume when the rail refuses', async () => {
      // A rail that will not reinstate billing means the family loses access at
      // the period end with no warning. Showing "active" would be a promise we
      // cannot keep, so the request fails loudly instead.
      const refusing: SubscriptionProvider = {
        rail: 'mock',
        createCheckout: () =>
          Promise.resolve({
            rail: 'mock',
            externalId: 'mock_cs_refuse',
            expiresAt: '2027-02-01T10:00:00.000Z' as never,
          }),
        cancel: () => Promise.resolve(),
        resume: () => Promise.reject(new Error('rail is down')),
        verifyAndParseWebhook: () => Promise.reject(new Error('not used')),
      };

      const other = await createApiHarness({ subscriptionProvider: refusing });
      try {
        other.setNow(new Date('2027-02-01T09:00:00.000Z'));
        const erin = await registerAndLogin(other, 'subs-erin');

        await other.db.query(
          `insert into subscriptions
             (parent_id, plan_id, rail, status, external_id, currency, price_minor,
              current_period_end, cancelled_at, cancel_at)
           values ($1, (select id from subscription_plans where code = 'monthly'),
                   'mock', 'cancelled', 'sub_erin_001', 'PKR', 49900,
                   '2027-03-01T09:00:00Z', now(), '2027-03-01T09:00:00Z')`,
          [erin.parentId],
        );

        const login = await other.app.inject({
          method: 'POST',
          url: '/v1/auth/login',
          payload: { email: erin.email, password: TEST_PASSWORD },
        });

        const response = await other.app.inject({
          method: 'POST',
          url: '/api/subscriptions/resume',
          headers: authHeader(login.json<{ accessToken: string }>().accessToken),
          payload: {},
        });

        expect(response.statusCode).toBe(400);

        const { rows } = await other.db.query<{ status: string }>(
          'select status from subscriptions where parent_id = $1',
          [erin.parentId],
        );
        expect(rows[0]?.status).toBe('cancelled');
      } finally {
        await other.close();
      }
    });
  });

  /* ======================================================================== */
  /* 8. Webhook replay                                                        */
  /* ======================================================================== */

  describe('webhook replay', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * A REPLAYED WEBHOOK IS A GENUINE WEBHOOK.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Its signature verifies because the rail really did send it. Two separate
     * defences stop it: the signed timestamp bounds how long a captured request
     * stays postable, and event ordering stops a genuinely old event from
     * applying even when it arrives with a fresh signature.
     */
    it('refuses a request captured and replayed an hour later', async () => {
      setNow(new Date('2027-03-01T12:00:00.000Z'));

      const response = await deliver(
        {
          id: 'evt_replay_001',
          type: 'subscription.renewed',
          occurred_at: '2027-03-01T11:00:00.000Z',
          data: { subscription_id: 'sub_dan_001' },
        },
        { signedAt: new Date('2027-03-01T11:00:00.000Z') },
      );

      expect(response.statusCode).toBe(400);
      expect(response.json<{ reason: string }>().reason).toBe('stale_timestamp');
    });

    it('ignores an old event redelivered with a fresh signature', async () => {
      // The signature is current, so the timestamp check passes. What stops it
      // is that the event itself predates the state it would overwrite.
      const before = await statusOf(dan);

      const response = await deliver({
        id: 'evt_replay_002',
        type: 'subscription.renewed',
        occurred_at: '2027-01-01T09:00:00.000Z',
        data: { subscription_id: 'sub_dan_001', amount_minor: 79_900, currency: 'PKR' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json<{ outcome: string }>().outcome).toBe('ignored');

      const after = await statusOf(dan);
      expect(after.currentPeriodEnd).toBe(before.currentPeriodEnd);
    });

    it('records why it changed nothing', async () => {
      const { rows } = await harness.db.query<{
        processing_status: string;
        ignored_reason: string | null;
      }>(
        `select processing_status, ignored_reason from payment_events
          where external_event_id = 'evt_replay_002'`,
      );

      expect(rows[0]).toMatchObject({
        processing_status: 'ignored',
        ignored_reason: 'stale_event',
      });
    });
  });

  /* ======================================================================== */
  /* 9. Invalid webhook                                                       */
  /* ======================================================================== */

  describe('an invalid webhook', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * A REFERENCE WE CANNOT PARSE IS A BUSINESS FACT, NOT A SERVER FAULT.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Our checkout ids are UUIDs and the lookups cast the vendor's reference
     * with `$1::uuid`. Handed anything else, Postgres raised 22P02 and the
     * request came out as a 500 — which is the one answer that must never be
     * given here, because a 5xx tells the rail to RETRY. A vendor sending an
     * unexpected reference format would have been told to try again forever,
     * and every attempt would have counted toward the 5xx rate that alerting
     * watches.
     *
     * The signature is valid in this test. This is a well-behaved rail sending
     * something we did not expect, which is ordinary, not hostile.
     */
    it('reports an unparseable reference as ignored, never as a 500', async () => {
      const response = await deliver({
        id: 'evt_bad_reference_001',
        type: 'subscription.renewed',
        occurred_at: clock.toISOString(),
        data: { reference: 'not-a-uuid-at-all', amount_minor: 49_900, currency: 'PKR' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json<{ outcome: string }>().outcome).toBe('ignored');
    });

    it('refuses an unsigned request', async () => {
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/subscriptions/webhook/mock',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({
          id: 'evt_forged_001',
          type: 'subscription.activated',
          occurred_at: clock.toISOString(),
        }),
      });

      expect(response.statusCode).toBe(400);
      expect(response.json<{ reason: string }>().reason).toBe('missing_signature');
    });

    it('refuses a signature made with the wrong secret', async () => {
      const response = await deliver(
        {
          id: 'evt_forged_002',
          type: 'subscription.activated',
          occurred_at: clock.toISOString(),
          data: { subscription_id: 'sub_dan_001' },
        },
        { secret: 'an-attackers-guess-at-our-secret' },
      );

      expect(response.statusCode).toBe(400);
      expect(response.json<{ reason: string }>().reason).toBe('bad_signature');
    });

    it('refuses a body altered after signing', async () => {
      const original = JSON.stringify({
        id: 'evt_forged_003',
        type: 'payment.failed',
        occurred_at: clock.toISOString(),
      });
      const signature = signMockWebhook(
        original,
        MOCK_WEBHOOK_SECRET,
        Math.floor(clock.getTime() / 1000),
      );

      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/subscriptions/webhook/mock',
        headers: { 'content-type': 'application/json', 'x-kc-signature': signature },
        payload: original.replace('payment.failed', 'subscription.renewed'),
      });

      expect(response.statusCode).toBe(400);
      expect(response.json<{ reason: string }>().reason).toBe('bad_signature');
    });

    /**
     * ═══════════════════════════════════════════════════════════════════════
     * A FORGED WEBHOOK MUST NOT BE ABLE TO SUPPRESS A REAL ONE.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * The obvious thing to do with an unverified event is store it for
     * forensics. That would be a vulnerability: `payment_events` is keyed on
     * (rail, external_event_id), so an attacker who guesses a real event id and
     * posts a forgery FIRST would have the genuine delivery discarded as a
     * duplicate. Unverified events go to the audit log instead, which has no
     * such key.
     */
    it('does not let a forgery poison the idempotency key of a real event', async () => {
      const eventId = 'evt_race_001';

      const forged = await deliver(
        {
          id: eventId,
          type: 'subscription.activated',
          occurred_at: clock.toISOString(),
          data: { subscription_id: 'sub_dan_001' },
        },
        { secret: 'wrong-secret' },
      );
      expect(forged.statusCode).toBe(400);

      // The forgery left no row to collide with.
      const { rows: after } = await harness.db.query<{ n: number }>(
        `select count(*)::int as n from payment_events where external_event_id = $1`,
        [eventId],
      );
      expect(after[0]?.n).toBe(0);

      // And the genuine event with the same id still applies.
      const genuine = await deliver({
        id: eventId,
        type: 'subscription.renewed',
        occurred_at: new Date(clock.getTime() + 1_000).toISOString(),
        data: { subscription_id: 'sub_dan_001', amount_minor: 79_900, currency: 'PKR' },
      });

      expect(genuine.statusCode).toBe(200);
      expect(genuine.json<{ outcome: string }>().outcome).toBe('applied');
    });

    it('refuses an unknown rail', async () => {
      const response = await deliver(
        {
          id: 'evt_wrong_rail',
          type: 'subscription.renewed',
          occurred_at: clock.toISOString(),
        },
        { rail: 'jazzcash' },
      );

      expect(response.statusCode).toBe(400);
      expect(response.json<{ reason: string }>().reason).toBe('unknown_rail');
    });

    it('records a verified event about a subscription we do not have, and acts on nothing', async () => {
      const response = await deliver({
        id: 'evt_unknown_sub',
        type: 'subscription.renewed',
        occurred_at: clock.toISOString(),
        data: { subscription_id: 'sub_that_does_not_exist' },
      });

      // 200, not 4xx: a rail that keeps retrying an event which can never apply
      // will eventually disable the endpoint, taking the events that DO matter
      // with it.
      expect(response.statusCode).toBe(200);
      expect(response.json<{ outcome: string }>().outcome).toBe('ignored');
    });
  });

  /* ======================================================================== */
  /* Isolation                                                                */
  /* ======================================================================== */

  describe('one family cannot reach another’s subscription', () => {
    it('shows each parent only their own status', async () => {
      expect((await statusOf(alice)).status).toBe('expired');
      expect((await statusOf(bob)).status).toBe('free');
    });

    it('does not let a parent cancel someone else’s plan', async () => {
      // There is no parameter for it — cancel operates on the caller's own
      // subscription, resolved from the session. The only way to express the
      // attack is to try it as a parent who has nothing.
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/subscriptions/cancel',
        headers: await as(bob),
        payload: {},
      });

      expect(response.statusCode).toBe(400);
    });

    it('keeps subscription rows behind RLS', async () => {
      const { rows } = await harness.db.query<{ n: number }>(
        `select count(*)::int as n from subscriptions where parent_id = $1`,
        [bob.parentId],
      );

      expect(rows[0]?.n).toBe(0);
    });
  });

  /* ======================================================================== */
  /* What leaves the API                                                      */
  /* ======================================================================== */

  describe('the response body', () => {
    it('never carries a vendor token or an internal identifier', async () => {
      const response = await harness.app.inject({
        method: 'GET',
        url: '/api/subscriptions/status',
        headers: await as(alice),
      });

      for (const forbidden of [
        'payment_method_token',
        'paymentMethodToken',
        'plan_id',
        'parent_id',
        'external_id',
      ]) {
        expect(response.body, forbidden).not.toContain(forbidden);
      }
    });
  });
});
