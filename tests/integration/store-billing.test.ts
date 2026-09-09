import { createMockStoreProvider, signStoreNotification } from '@kids/payments';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  authHeader,
  createApiHarness,
  registerAndLogin,
  TEST_PASSWORD,
  type ApiHarness,
  type RegisteredParent,
} from '../helpers/api.js';

/**
 * Mobile store billing, end to end.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * EVERY TEST HERE IS ABOUT THE SERVER REFUSING TO BELIEVE THE CLIENT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The device sends one opaque token. If that were enough to grant a
 * subscription, a modified app would be a free family plan — and in a
 * price-sensitive launch market on Android, a rooted phone is not an exotic
 * threat model.
 *
 * The mock store used here is a real verification service that can say no. A
 * stub that confirmed everything would make this entire file pass while proving
 * the opposite of what it claims.
 */

const NOW = new Date('2026-10-01T12:00:00.000Z');
const STORE_SECRET = 'local-store-notification-key';

describe('mobile store billing', () => {
  /* ======================================================================== */
  /* No store configured                                                      */
  /* ======================================================================== */

  describe('with no store enabled', () => {
    let harness: ApiHarness;
    let parent: RegisteredParent;

    beforeAll(async () => {
      harness = await createApiHarness();
      harness.setNow(NOW);
      parent = await registerAndLogin(harness, 'store-none');
    });

    afterAll(async () => {
      await harness.close();
    });

    it('reports no store subscription without erroring', async () => {
      const response = await harness.app.inject({
        method: 'GET',
        url: '/api/store/status',
        headers: authHeader(parent.accessToken),
      });

      expect(response.statusCode).toBe(200);
      const body = response.json<{ entitled: boolean; state: string; explanation: string }>();
      expect(body.entitled).toBe(false);
      expect(body.state).toBe('none');
      expect(body.explanation).toContain('No app store subscription');
    });

    it('refuses a purchase rather than pretending to verify it', async () => {
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/store/verify',
        headers: authHeader(parent.accessToken),
        payload: { store: 'apple_iap', token: 'tok_whatever.active' },
      });

      expect(response.statusCode).toBe(402);
      expect(response.json<{ reason: string }>().reason).toBe('not_configured');
    });
  });

  /* ======================================================================== */
  /* A store configured                                                       */
  /* ======================================================================== */

  describe('with a store enabled', () => {
    let harness: ApiHarness;
    let alice: RegisteredParent;
    let bob: RegisteredParent;

    /* Moves with each step, the way real time does. The mock store stamps its
     * answers from this clock, so a refresh is genuinely newer than the purchase
     * it refreshes — which is what the ordering guard requires. */
    let clock = NOW;
    const tick = (minutes = 5): void => {
      clock = new Date(clock.getTime() + minutes * 60_000);
      harness.setNow(clock);
    };

    const as = async (parent: RegisteredParent): Promise<Record<string, string>> => {
      const login = await harness.app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { email: parent.email, password: TEST_PASSWORD },
      });
      return authHeader(login.json<{ accessToken: string }>().accessToken);
    };

    const verify = async (parent: RegisteredParent, token: string) =>
      await harness.app.inject({
        method: 'POST',
        url: '/api/store/verify',
        headers: await as(parent),
        payload: { store: 'apple_iap', token },
      });

    const status = async (parent: RegisteredParent) =>
      (
        await harness.app.inject({
          method: 'GET',
          url: '/api/store/status',
          headers: await as(parent),
        })
      ).json<{
        entitled: boolean;
        state: string;
        planCode: string | null;
        explanation: string;
      }>();

    const notify = async (body: Record<string, unknown>, secret = STORE_SECRET) => {
      const raw = JSON.stringify(body);
      return await harness.app.inject({
        method: 'POST',
        url: '/api/store/notifications/apple_iap',
        headers: {
          'content-type': 'application/json',
          // Signed at the current clock, so it is inside the tolerance window.
          'x-kc-store-signature': signStoreNotification(
            raw,
            secret,
            Math.floor(clock.getTime() / 1000),
          ),
        },
        payload: raw,
      });
    };

    beforeAll(async () => {
      const provider = createMockStoreProvider({
        store: 'apple_iap',
        notificationSecret: STORE_SECRET,
        environment: 'sandbox',
        productId: 'apple_iap.monthly',
        now: () => clock,
      });

      harness = await createApiHarness({ storeProviders: [['apple_iap', provider]] });
      harness.setNow(NOW);

      // The store's product has to map to one of our plans, or a verified
      // purchase grants nothing. An unmapped product is a visible gap by
      // design, not a silent fallback to the free tier.
      await harness.db.query(
        `insert into store_product_map (store, product_id, plan_id)
         select 'apple_iap', 'apple_iap.monthly', id
           from subscription_plans where code = 'monthly'`,
      );

      alice = await registerAndLogin(harness, 'store-alice');
      bob = await registerAndLogin(harness, 'store-bob');
    });

    afterAll(async () => {
      await harness.close();
    });

    /* ---------------------------------------------------------------------- */
    /* Purchase verification                                                  */
    /* ---------------------------------------------------------------------- */

    it('grants entitlement only after the store confirms it', async () => {
      const before = await status(alice);
      expect(before.entitled).toBe(false);

      const response = await verify(alice, 'tok_alice.active');
      expect(response.statusCode).toBe(200);

      const body = response.json<{ entitled: boolean; planCode: string | null }>();
      expect(body.entitled).toBe(true);
      expect(body.planCode).toBe('monthly');

      const after = await status(alice);
      expect(after.entitled).toBe(true);
      expect(after.state).toBe('active');
    });

    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THERE IS NOWHERE TO PUT A STATUS.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * The schema is `.strict()`, so a client claiming to be subscribed gets a
     * validation error rather than a silently ignored field that some future
     * refactor starts reading.
     */
    it('refuses a request that tries to declare its own subscription', async () => {
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/store/verify',
        headers: await as(bob),
        payload: {
          store: 'apple_iap',
          token: 'tok_bob.active',
          entitled: true,
          state: 'active',
          expiresAt: '2030-01-01T00:00:00.000Z',
        },
      });

      expect(response.statusCode).toBe(400);
      expect((await status(bob)).entitled).toBe(false);
    });

    it('refuses a token the store does not recognise', async () => {
      const response = await verify(bob, 'tok_bob.invalid');

      expect(response.statusCode).toBe(402);
      expect(response.json<{ reason: string }>().reason).toBe('invalid_token');
      expect((await status(bob)).entitled).toBe(false);
    });

    it('refuses a purchase that belongs to a different app', async () => {
      const response = await verify(bob, 'tok_bob.otherapp');

      expect(response.statusCode).toBe(402);
      expect(response.json<{ reason: string }>().reason).toBe('wrong_application');
    });

    it('records the store and the reason, and never the token', async () => {
      // A purchase token is a bearer credential for somebody's subscription. It
      // has no business in an audit log.
      const { rows } = await harness.db.query<{ metadata: Record<string, unknown> }>(
        `select metadata from audit_logs
          where action = 'store.purchase.rejected' order by created_at desc limit 1`,
      );

      const serialised = JSON.stringify(rows[0]?.metadata ?? {});
      expect(serialised).toContain('apple_iap');
      expect(serialised).not.toContain('tok_bob');
    });

    /* ---------------------------------------------------------------------- */
    /* One purchase, one parent                                               */
    /* ---------------------------------------------------------------------- */

    /**
     * ═══════════════════════════════════════════════════════════════════════
     * ONE SUBSCRIPTION MUST NOT BECOME MANY.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * A store account is not our account. Tokens can be shared, published, or
     * lifted from a modified app. Without the unique constraint, the same token
     * verifies successfully for every parent who presents it.
     */
    it('refuses a purchase already claimed by another account', async () => {
      const response = await verify(bob, 'tok_alice.active');

      expect(response.statusCode).toBe(402);
      expect(response.json<{ reason: string }>().reason).toBe('owned_by_another_account');

      // Bob gets nothing, and Alice keeps what she paid for.
      expect((await status(bob)).entitled).toBe(false);
      expect((await status(alice)).entitled).toBe(true);
    });

    it('records the collision with both accounts, because a pattern matters', async () => {
      // One purchase attempted by a dozen accounts is a very different thing
      // from a family reinstalling on a second device.
      const { rows } = await harness.db.query<{
        actor_id: string;
        metadata: Record<string, unknown>;
      }>(
        `select actor_id, metadata from audit_logs
          where action = 'store.purchase.conflict' order by created_at desc limit 1`,
      );

      expect(rows[0]?.actor_id).toBe(bob.parentId);
      expect(JSON.stringify(rows[0]?.metadata)).toContain(alice.parentId);
    });

    /* ---------------------------------------------------------------------- */
    /* Restore                                                                */
    /* ---------------------------------------------------------------------- */

    it('restores a purchase the same account already owns', async () => {
      // A reinstall or a new device. The same verification runs — restore is
      // not a lenient path, because a lenient restore is an unverified purchase
      // endpoint by another name.
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/store/restore',
        headers: await as(alice),
        payload: { receipts: [{ store: 'apple_iap', token: 'tok_alice.active' }] },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json<{ restored: number; entitled: boolean }>();
      expect(body.restored).toBe(1);
      expect(body.entitled).toBe(true);
    });

    it('restores nothing for an account with no purchases, and says so kindly', async () => {
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/store/restore',
        headers: await as(bob),
        payload: { receipts: [{ store: 'apple_iap', token: 'tok_bob.expired' }] },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json<{ restored: number; entitled: boolean; explanation: string }>();
      expect(body.restored).toBe(0);
      expect(body.entitled).toBe(false);
      expect(body.explanation).toContain('could not find an active subscription');
    });

    it('will not let restore launder another account’s purchase', async () => {
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/store/restore',
        headers: await as(bob),
        payload: { receipts: [{ store: 'apple_iap', token: 'tok_alice.active' }] },
      });

      expect(response.json<{ restored: number }>().restored).toBe(0);
      expect((await status(bob)).entitled).toBe(false);
    });

    /* ---------------------------------------------------------------------- */
    /* The subscription mirror                                                */
    /* ---------------------------------------------------------------------- */

    it('mirrors the store purchase into a subscription the rest of the app reads', async () => {
      const { rows } = await harness.db.query<{
        rail: string;
        status: string;
        external_id: string;
      }>('select rail, status, external_id from subscriptions where parent_id = $1', [
        alice.parentId,
      ]);

      expect(rows[0]?.rail).toBe('apple_iap');
      expect(rows[0]?.status).toBe('active');
    });

    it('raises the entitlement a child actually gets', async () => {
      const { rows } = await harness.db.query<{ plan_code: string; daily_minute_limit: number }>(
        'select plan_code, daily_minute_limit from app.parent_entitlements($1, $2)',
        [alice.parentId, clock.toISOString()],
      );

      expect(rows[0]?.plan_code).toBe('monthly');
      expect(rows[0]?.daily_minute_limit).toBe(60);
    });

    /* ---------------------------------------------------------------------- */
    /* Notifications                                                          */
    /* ---------------------------------------------------------------------- */

    it('refuses an unsigned or forged notification', async () => {
      const unsigned = await harness.app.inject({
        method: 'POST',
        url: '/api/store/notifications/apple_iap',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ notification_id: 'x', kind: 'y', original_transaction_id: 'z' }),
      });
      expect(unsigned.statusCode).toBe(400);
      expect(unsigned.json<{ reason: string }>().reason).toBe('missing_signature');

      const forged = await notify(
        {
          notification_id: 'ntf_forged',
          kind: 'DID_RENEW',
          original_transaction_id: 'apple_iap_tok_alice',
        },
        'an-attackers-guess',
      );
      expect(forged.statusCode).toBe(400);
      expect(forged.json<{ reason: string }>().reason).toBe('bad_signature');
    });

    it('does not let a forged notification poison a real id', async () => {
      const { rows } = await harness.db.query<{ n: number }>(
        `select count(*)::int as n from store_notifications where notification_id = 'ntf_forged'`,
      );

      expect(rows[0]?.n).toBe(0);
    });

    /**
     * ═══════════════════════════════════════════════════════════════════════
     * A NOTIFICATION IS A HINT TO GO AND ASK.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * The payload says the subscription entered a grace period. The handler
     * does not act on that — it re-verifies with the store and writes down
     * whatever the store says. Which is also why a forged notification is
     * harmless: at worst it makes us ask a question we already knew.
     */
    it('re-verifies with the store rather than acting on the payload', async () => {
      tick();
      const response = await notify({
        notification_id: 'ntf_grace',
        kind: 'DID_FAIL_TO_RENEW',
        original_transaction_id: 'apple_iap_tok_alice',
        state: 'grace',
        occurred_at: NOW.toISOString(),
      });

      expect(response.statusCode).toBe(200);
      expect(response.json<{ outcome: string }>().outcome).toBe('applied');

      const current = await status(alice);
      expect(current.state).toBe('grace_period');
      // Still entitled. The store is retrying; the child keeps talking.
      expect(current.entitled).toBe(true);
      expect(current.explanation).toContain('Nothing has been switched off');
    });

    it('treats a redelivered notification as a no-op', async () => {
      const again = await notify({
        notification_id: 'ntf_grace',
        kind: 'DID_FAIL_TO_RENEW',
        original_transaction_id: 'apple_iap_tok_alice',
        occurred_at: NOW.toISOString(),
      });

      expect(again.statusCode).toBe(200);
      expect(again.json<{ outcome: string }>().outcome).toBe('duplicate');
    });

    it('ignores a notification about a purchase nobody has presented', async () => {
      // Common and benign: a subscriber can buy in the store before ever
      // signing in to the app.
      const response = await notify({
        notification_id: 'ntf_unknown',
        kind: 'DID_RENEW',
        original_transaction_id: 'apple_iap_never_seen',
        occurred_at: NOW.toISOString(),
      });

      expect(response.statusCode).toBe(200);
      expect(response.json<{ outcome: string }>().outcome).toBe('unknown_purchase');
    });

    /* ---------------------------------------------------------------------- */
    /* Cancellation and expiry                                                */
    /* ---------------------------------------------------------------------- */

    it('keeps a cancelled subscription running to the end of the paid period', async () => {
      tick();
      await notify({
        notification_id: 'ntf_cancel',
        kind: 'DID_CHANGE_RENEWAL_STATUS',
        original_transaction_id: 'apple_iap_tok_alice',
        state: 'cancelled',
        occurred_at: NOW.toISOString(),
      });

      const current = await status(alice);
      expect(current.state).toBe('cancelled');
      // Paid for the month, keeps the month.
      expect(current.entitled).toBe(true);
      expect(current.explanation).toContain('until the end of the period');
    });

    it('ends entitlement when the store says it expired', async () => {
      tick();
      await notify({
        notification_id: 'ntf_expire',
        kind: 'EXPIRED',
        original_transaction_id: 'apple_iap_tok_alice',
        state: 'expired',
        occurred_at: NOW.toISOString(),
      });

      const current = await status(alice);
      expect(current.state).toBe('expired');
      expect(current.entitled).toBe(false);
      // And nothing threatening about their data.
      expect(current.explanation).toContain('nothing has been deleted');
    });

    it('drops the child back to free-tier limits', async () => {
      const { rows } = await harness.db.query<{ plan_code: string; daily_minute_limit: number }>(
        'select plan_code, daily_minute_limit from app.parent_entitlements($1, $2)',
        [alice.parentId, clock.toISOString()],
      );

      expect(rows[0]?.plan_code).toBe('free');
      expect(rows[0]?.daily_minute_limit).toBe(10);
    });

    /* ---------------------------------------------------------------------- */
    /* No store secrets on the device                                          */
    /* ---------------------------------------------------------------------- */

    it('never returns anything a device could verify a purchase with', async () => {
      const response = await harness.app.inject({
        method: 'GET',
        url: '/api/store/status',
        headers: await as(alice),
      });

      for (const forbidden of [
        'issuerId',
        'privateKey',
        'sharedSecret',
        'serviceAccount',
        'APPLE_IAP',
        'GOOGLE_PLAY',
      ]) {
        expect(response.body, forbidden).not.toContain(forbidden);
      }
    });
  });
});
