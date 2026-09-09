import { describe, expect, it } from 'vitest';

import {
  APPLE_VERIFICATION,
  createAppleStoreProvider,
  createGooglePlayProvider,
  GOOGLE_VERIFICATION,
} from './adapters.js';
import {
  environmentAllowed,
  isFresherThan,
  isStoreEntitled,
  toSubscriptionStatus,
} from './mapping.js';
import { capabilitiesFor, createMockStoreProvider, signStoreNotification } from './mock-store.js';
import { PurchaseVerificationError, type VerifiedPurchase } from './types.js';

/**
 * Mobile store billing.
 *
 * What these tests are actually protecting is a single sentence: the client
 * never decides. Everything below is either an assertion that the server can
 * say NO, or an assertion that a store state maps to the entitlement a family
 * should actually get.
 */

const NOW = new Date('2026-10-01T12:00:00.000Z');
const SECRET = 'store-notification-key-for-tests';

const apple = createMockStoreProvider({
  store: 'apple_iap',
  notificationSecret: SECRET,
  environment: 'sandbox',
  productId: 'apple_iap.monthly',
  now: () => NOW,
});

const production = createMockStoreProvider({
  store: 'google_play',
  notificationSecret: SECRET,
  environment: 'production',
  productId: 'google_play.monthly',
  now: () => NOW,
});

const purchase = (overrides: Partial<VerifiedPurchase> = {}): VerifiedPurchase => ({
  store: 'apple_iap',
  state: 'active',
  originalTransactionId: 'txn_1',
  productId: 'apple_iap.monthly',
  autoRenewing: true,
  environment: 'production',
  verifiedAt: NOW.toISOString() as VerifiedPurchase['verifiedAt'],
  ...overrides,
});

/* ========================================================================== */
/* The store decides                                                          */
/* ========================================================================== */

describe('server-side verification', () => {
  it('confirms a purchase the store recognises', async () => {
    const verified = await apple.verifyPurchase({ store: 'apple_iap', token: 'tok_abc.active' });

    expect(verified.state).toBe('active');
    expect(verified.productId).toBe('apple_iap.monthly');
    // The store's identifier, not the client's token.
    expect(verified.originalTransactionId).toContain('apple_iap_');
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════
   * THE SERVER CAN SAY NO. THAT IS THE ENTIRE POINT.
   * ═══════════════════════════════════════════════════════════════════════
   *
   * A mock that confirmed every token would make this whole suite pass while
   * proving the opposite of what it claims — the rejection paths are the ones
   * that decide whether a modified app gets a free subscription.
   */
  it('refuses a token the store does not recognise', async () => {
    await expect(
      apple.verifyPurchase({ store: 'apple_iap', token: 'tok_abc.invalid' }),
    ).rejects.toMatchObject({ reason: 'invalid_token' });
  });

  it('refuses a valid purchase that belongs to a different app', async () => {
    // A real attack: a subscription bought in any other application, presented
    // here. Both stores report this, and honouring it would be free service.
    await expect(
      apple.verifyPurchase({ store: 'apple_iap', token: 'tok_abc.otherapp' }),
    ).rejects.toMatchObject({ reason: 'wrong_application' });
  });

  it('refuses a token sent to the wrong store', async () => {
    await expect(
      apple.verifyPurchase({ store: 'google_play', token: 'tok_abc.active' }),
    ).rejects.toBeInstanceOf(PurchaseVerificationError);
  });

  it('refuses an implausibly short token without asking anyone', async () => {
    await expect(apple.verifyPurchase({ store: 'apple_iap', token: 'x' })).rejects.toMatchObject({
      reason: 'invalid_token',
    });
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════
   * A SANDBOX PURCHASE IN PRODUCTION IS A FREE SUBSCRIPTION.
   * ═══════════════════════════════════════════════════════════════════════
   *
   * Anyone with a store test account can make one. Both stores make sandbox and
   * production receipts easy to confuse, and the usual "try one, fall back to
   * the other" advice is the vulnerability when pointed the wrong way.
   */
  it('never honours a sandbox purchase in production', () => {
    expect(environmentAllowed('sandbox', 'production')).toBe(false);
    expect(environmentAllowed('production', 'production')).toBe(true);
    // A development deployment takes sandbox, because that is all it can get.
    expect(environmentAllowed('sandbox', 'sandbox')).toBe(true);
    expect(environmentAllowed('production', 'sandbox')).toBe(true);
  });

  it('reports the environment a purchase actually came from', async () => {
    const sandboxPurchase = await production.verifyPurchase({
      store: 'google_play',
      token: 'tok_xyz.sandbox',
    });

    expect(sandboxPurchase.environment).toBe('sandbox');
    expect(environmentAllowed(sandboxPurchase.environment, production.environment)).toBe(false);
  });

  it('gives a fresh answer on refresh rather than replaying the old one', async () => {
    const first = await apple.verifyPurchase({ store: 'apple_iap', token: 'tok_ref.active' });
    const again = await apple.refresh(first.originalTransactionId);

    expect(again.originalTransactionId).toBe(first.originalTransactionId);
    expect(again.state).toBe('active');
  });

  it('refuses to refresh a subscription the store has never seen', async () => {
    await expect(apple.refresh('apple_iap_unknown')).rejects.toMatchObject({
      reason: 'invalid_token',
    });
  });
});

/* ========================================================================== */
/* Store state to entitlement                                                 */
/* ========================================================================== */

describe('store state', () => {
  it('maps every state to a subscription status', () => {
    expect(toSubscriptionStatus('active')).toBe('active');
    expect(toSubscriptionStatus('trial')).toBe('trialing');
    expect(toSubscriptionStatus('grace_period')).toBe('grace');
    expect(toSubscriptionStatus('cancelled')).toBe('cancelled');
    expect(toSubscriptionStatus('expired')).toBe('expired');
    expect(toSubscriptionStatus('refunded')).toBe('expired');
    expect(toSubscriptionStatus('invalid')).toBe('expired');
  });

  /**
   * Account hold and pause both stop entitlement, for different reasons.
   *
   * Hold means the store gave up retrying for now — recoverable, but no access
   * meanwhile. Pause is something the subscriber explicitly asked for; giving
   * them service anyway is giving away what they declined to pay for.
   */
  it('stops entitlement on hold and on pause', () => {
    expect(toSubscriptionStatus('on_hold')).toBe('expired');
    expect(toSubscriptionStatus('paused')).toBe('expired');
    expect(isStoreEntitled(purchase({ state: 'on_hold' }), NOW.toISOString())).toBe(false);
    expect(isStoreEntitled(purchase({ state: 'paused' }), NOW.toISOString())).toBe(false);
  });

  it('keeps a family in the store’s grace period fully entitled', () => {
    // The store is retrying a failed payment. Nothing is switched off, because
    // the person who would lose access is a child whose parent's card expired.
    const inGrace = purchase({
      state: 'grace_period',
      expiresAt: '2026-09-30T12:00:00.000Z' as VerifiedPurchase['expiresAt'],
      gracePeriodEndsAt: '2026-10-07T12:00:00.000Z' as VerifiedPurchase['gracePeriodEndsAt'],
    });

    expect(isStoreEntitled(inGrace, NOW.toISOString())).toBe(true);
    // And not once the store's own window closes.
    expect(isStoreEntitled(inGrace, '2026-10-08T00:00:00.000Z')).toBe(false);
  });

  it('lets a cancelled subscription run to the end of the paid period', () => {
    const cancelled = purchase({
      state: 'cancelled',
      autoRenewing: false,
      expiresAt: '2026-10-20T12:00:00.000Z' as VerifiedPurchase['expiresAt'],
    });

    expect(isStoreEntitled(cancelled, NOW.toISOString())).toBe(true);
    expect(isStoreEntitled(cancelled, '2026-10-21T00:00:00.000Z')).toBe(false);
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════
   * AN EXPIRY PASSES WHETHER OR NOT A NOTIFICATION ARRIVES.
   * ═══════════════════════════════════════════════════════════════════════
   *
   * Both stores eventually tell us. Neither tells us promptly. The gap between
   * the two is where free service would live if entitlement were read from the
   * stored state alone.
   */
  it('applies an elapsed expiry with no notification involved', () => {
    const stale = purchase({
      state: 'active',
      expiresAt: '2026-09-30T12:00:00.000Z' as VerifiedPurchase['expiresAt'],
    });

    expect(stale.state).toBe('active');
    expect(isStoreEntitled(stale, NOW.toISOString())).toBe(false);
  });

  it('ends entitlement the moment money goes back', () => {
    const refunded = purchase({
      state: 'refunded',
      expiresAt: '2026-11-01T12:00:00.000Z' as VerifiedPurchase['expiresAt'],
    });

    // The period has not ended, and it does not matter.
    expect(isStoreEntitled(refunded, NOW.toISOString())).toBe(false);
  });
});

/* ========================================================================== */
/* Ordering                                                                   */
/* ========================================================================== */

describe('out-of-order answers', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════
   * STORE NOTIFICATIONS ARRIVE OUT OF ORDER ROUTINELY, NOT EXCEPTIONALLY.
   * ═══════════════════════════════════════════════════════════════════════
   *
   * A delayed renewal landing after an expiry would resurrect a dead
   * subscription; a delayed expiry landing after a renewal would kill a live
   * one. Ordering is by the STORE's timestamp, because ours cannot tell the
   * difference.
   */
  it('ignores an answer older than the one already held', () => {
    const held = { verifiedAt: '2026-10-01T12:00:00.000Z' };

    expect(isFresherThan(purchase({ verifiedAt: '2026-10-02T12:00:00.000Z' as never }), held)).toBe(
      true,
    );
    expect(isFresherThan(purchase({ verifiedAt: '2026-09-30T12:00:00.000Z' as never }), held)).toBe(
      false,
    );
  });

  it('treats an identical timestamp as the same answer arriving twice', () => {
    expect(
      isFresherThan(purchase({ verifiedAt: '2026-10-01T12:00:00.000Z' as never }), {
        verifiedAt: '2026-10-01T12:00:00.000Z',
      }),
    ).toBe(false);
  });

  it('accepts anything when nothing is held yet', () => {
    expect(isFresherThan(purchase(), undefined)).toBe(true);
  });
});

/* ========================================================================== */
/* Notifications                                                              */
/* ========================================================================== */

describe('store notifications', () => {
  const body = (overrides: Record<string, unknown> = {}): string =>
    JSON.stringify({
      notification_id: 'ntf_1',
      kind: 'DID_RENEW',
      original_transaction_id: 'apple_iap_tok',
      occurred_at: NOW.toISOString(),
      ...overrides,
    });

  const signed = (raw: string, secret = SECRET): Record<string, string> => ({
    'x-kc-store-signature': signStoreNotification(raw, secret, Math.floor(NOW.getTime() / 1000)),
  });

  it('accepts a correctly signed notification', async () => {
    const raw = body();
    const notification = await apple.verifyNotification(Buffer.from(raw), signed(raw));

    expect(notification.notificationId).toBe('ntf_1');
    expect(notification.originalTransactionId).toBe('apple_iap_tok');
  });

  it('refuses an unsigned or forged notification', async () => {
    const raw = body();

    await expect(apple.verifyNotification(Buffer.from(raw), {})).rejects.toMatchObject({
      reason: 'missing_signature',
    });
    await expect(
      apple.verifyNotification(Buffer.from(raw), signed(raw, 'wrong')),
    ).rejects.toMatchObject({ reason: 'bad_signature' });
  });

  it('refuses a body altered after signing', async () => {
    const original = body();
    const headers = signed(original);
    const tampered = body({ kind: 'DID_CHANGE_RENEWAL_STATUS' });

    await expect(apple.verifyNotification(Buffer.from(tampered), headers)).rejects.toMatchObject({
      reason: 'bad_signature',
    });
  });

  it('requires the fields that identify which subscription changed', async () => {
    const raw = JSON.stringify({ kind: 'DID_RENEW' });

    await expect(apple.verifyNotification(Buffer.from(raw), signed(raw))).rejects.toMatchObject({
      reason: 'malformed',
    });
  });
});

/* ========================================================================== */
/* Capabilities and verification                                              */
/* ========================================================================== */

describe('the store adapters', () => {
  it('knows that Google can pause a subscription and Apple cannot', () => {
    expect(capabilitiesFor('google_play').pause).toBe(true);
    expect(capabilitiesFor('apple_iap').pause).toBe(false);
  });

  it('knows we cannot cancel or refund on a subscriber’s behalf', () => {
    // Both stores own that. A product that offered a cancel button here would
    // be promising something it cannot do — the subscriber must go to the store.
    for (const store of ['apple_iap', 'google_play'] as const) {
      expect(capabilitiesFor(store).serverInitiatedCancellation).toBe(false);
      expect(capabilitiesFor(store).serverInitiatedRefund).toBe(false);
    }
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════
   * NEITHER LIVE ADAPTER IS IMPLEMENTED, AND BOTH SAY SO.
   * ═══════════════════════════════════════════════════════════════════════
   *
   * Returning a fabricated `active` here would be the worst failure available
   * to this codebase: subscriptions granted to real families that nobody paid
   * for, from an integration that looks finished.
   */
  it('refuses every live operation rather than guessing', async () => {
    const live = createAppleStoreProvider({
      issuerId: 'issuer',
      keyId: 'key',
      privateKey: 'private',
      bundleId: 'bundle',
      environment: 'production',
    });

    await expect(
      live.verifyPurchase({ store: 'apple_iap', token: 'tok_abcdefgh' }),
    ).rejects.toMatchObject({ reason: 'not_configured' });
    await expect(live.refresh('txn')).rejects.toBeInstanceOf(PurchaseVerificationError);
    await expect(live.verifyNotification(new Uint8Array(), {})).rejects.toThrow(/not implemented/);
  });

  it('does not silently fall back to the mock', async () => {
    const live = createGooglePlayProvider({
      packageName: 'com.example.invalid',
      serviceAccountJson: '{}',
      environment: 'production',
    });

    expect(live.mode).toBe('live');
    await expect(
      live.verifyPurchase({ store: 'google_play', token: 'tok_abcdefgh' }),
    ).rejects.toThrow(/do not guess/);
  });

  it('reports both stores as unverified, with what is outstanding', () => {
    for (const verification of [APPLE_VERIFICATION, GOOGLE_VERIFICATION]) {
      expect(Object.values(verification.checklist).every((done) => done === false)).toBe(true);
      expect(verification.notes.length).toBeGreaterThan(3);
    }
  });
});
