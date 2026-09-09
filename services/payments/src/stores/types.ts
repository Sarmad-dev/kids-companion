import type { IsoTimestamp } from '@kids/types';

import type { RailVerification } from '../rails/types.js';

/**
 * Mobile store billing.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE CLIENT SENDS A TOKEN. IT NEVER SENDS A STATUS.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This is the property the whole file is arranged around, and the type system
 * is what enforces it rather than a code review habit.
 *
 * A device can prove it *attempted* a purchase — it holds a purchase token from
 * Google Play or a transaction identifier from the App Store. It cannot prove
 * that purchase is valid, paid for, unrefunded, or still active. Only the store
 * knows that, and the only way to find out is to ask the store from a server.
 *
 * So `verifyPurchase` takes a `PurchaseReceipt` — an opaque token and nothing
 * else — and returns a `VerifiedPurchase` that the STORE produced. There is no
 * field anywhere in this file through which a client could say "I am
 * subscribed". A modified app, a rooted device, or a replayed HTTP request can
 * present a token; none of them can make the store agree.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * STORE BILLING IS NOT A PAYMENT RAIL, AND THE DIFFERENCE MATTERS.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A payment rail (`../rails/`) takes money once and tells us. A store OWNS the
 * subscription: it charges, it retries a failed card, it runs its own grace
 * period, it honours a cancellation at period end, and it decides when the
 * thing expires. We do not drive any of that — we mirror it.
 *
 * That inverts the usual relationship. Our `subscriptions` row is a cache of
 * the store's state, and when the two disagree the store is right. Code that
 * forgets this ends up "fixing" a subscription locally and having the next
 * notification undo it.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * NO STORE'S WIRE FORMAT IS ENCODED HERE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * No endpoint, no request shape, no JWS claim name, no notification field.
 * None has been read from Apple's or Google's current documentation, and both
 * change their APIs. What ships is the shape, a working mock, and a checklist —
 * the same discipline as the payment rails, for the same reason.
 */

export const MOBILE_STORES = ['apple_iap', 'google_play'] as const;
export type MobileStore = (typeof MOBILE_STORES)[number];

export const isMobileStore = (value: string): value is MobileStore =>
  (MOBILE_STORES as readonly string[]).includes(value);

/* -------------------------------------------------------------------------- */
/* What a client is allowed to send                                            */
/* -------------------------------------------------------------------------- */

/**
 * Everything the device may tell us about a purchase.
 *
 * Deliberately minimal. There is no `isActive`, no `expiresAt`, no `productId`
 * we trust, and no price — every one of those comes back from the store, and
 * accepting a client's version of any of them is the vulnerability this design
 * exists to close.
 *
 * `productId` is present only as a HINT for logging when verification fails;
 * nothing downstream reads it as fact.
 */
export interface PurchaseReceipt {
  readonly store: MobileStore;
  /**
   * The opaque token or transaction identifier the store gave the device.
   *
   * The one thing a client legitimately knows and we cannot obtain otherwise.
   */
  readonly token: string;
  /** A hint for diagnostics. Never trusted, never stored as truth. */
  readonly productIdHint?: string | undefined;
}

/* -------------------------------------------------------------------------- */
/* What the store says                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Subscription states both stores express, normalised.
 *
 * Neither store's vocabulary is used directly. Apple and Google name these
 * differently, disagree about which are distinct, and rename them between API
 * versions — mapping once, here, means the lifecycle code never learns either
 * dialect.
 */
export const STORE_PURCHASE_STATES = [
  /** Paid and current. */
  'active',
  /** In an introductory or free trial period. */
  'trial',
  /**
   * Payment failed and the STORE is retrying while access continues.
   *
   * Both stores run this themselves, on their own schedule, and it is not the
   * same thing as our own grace window — see `../lifecycle.ts`. Ours applies to
   * rails we bill directly; this one is the store's and we only observe it.
   */
  'grace_period',
  /**
   * Payment failed, the retry window has passed, and access should stop while
   * the store keeps trying. Google calls this account hold.
   */
  'on_hold',
  /** The subscriber paused it — Google supports this; Apple does not. */
  'paused',
  /** Cancelled, but paid up to the end of the current period. */
  'cancelled',
  /** Over. */
  'expired',
  /** Money returned. Entitlement ends immediately, not at period end. */
  'refunded',
  /**
   * The store says this purchase is not valid.
   *
   * A forged token, a token from a different app, or a sandbox token presented
   * to production. Never treated as "probably fine".
   */
  'invalid',
] as const;
export type StorePurchaseState = (typeof STORE_PURCHASE_STATES)[number];

/** States in which the family still gets what they paid for. */
export const ENTITLING_STORE_STATES: readonly StorePurchaseState[] = Object.freeze([
  'active',
  'trial',
  'grace_period',
  'cancelled',
]);

export const isEntitlingStoreState = (state: StorePurchaseState): boolean =>
  ENTITLING_STORE_STATES.includes(state);

/**
 * What the store told us about one subscription.
 *
 * Every field here originates from the store. None of it is echoed from the
 * request.
 */
export interface VerifiedPurchase {
  readonly store: MobileStore;
  readonly state: StorePurchaseState;
  /**
   * The store's stable identifier for the whole subscription, across renewals.
   *
   * Apple's original transaction id and Google's purchase token play this role.
   * The per-renewal identifier changes; this one does not, and it is what makes
   * "is this the same subscription we already know about?" answerable.
   */
  readonly originalTransactionId: string;
  /** The identifier for the current period, which changes on every renewal. */
  readonly latestTransactionId?: string | undefined;
  /** The store's product identifier, mapped to one of our plans by config. */
  readonly productId: string;
  readonly expiresAt?: IsoTimestamp | undefined;
  /** When the store's own grace or retry window closes. */
  readonly gracePeriodEndsAt?: IsoTimestamp | undefined;
  /** Whether the store will charge again. False after a cancellation. */
  readonly autoRenewing: boolean;
  /**
   * Which store environment produced this.
   *
   * A sandbox purchase accepted in production is a free subscription for
   * anyone with a test account, and both stores make it easy to confuse the
   * two. Carried explicitly so the decision to refuse is deliberate.
   */
  readonly environment: 'sandbox' | 'production';
  /** When the store said this. Ordering is by the store's clock, not ours. */
  readonly verifiedAt: IsoTimestamp;
  /** Present when `state` is `refunded`. */
  readonly refundedAt?: IsoTimestamp | undefined;
}

/* -------------------------------------------------------------------------- */
/* Notifications                                                               */
/* -------------------------------------------------------------------------- */

/**
 * An asynchronous message from a store about a subscription.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * A NOTIFICATION IS A HINT TO GO AND ASK, NOT A FACT TO ACT ON.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * That is a deliberate constraint and it costs a round trip. Both stores send
 * notifications that can arrive out of order, be delayed for hours, or be
 * replayed. Acting on the payload directly means a stale "expired" overwriting
 * a fresh renewal.
 *
 * So this type carries only enough to identify WHICH subscription changed. The
 * handler then re-verifies with the store and uses that answer — which is also
 * what makes a forged notification harmless: the worst it achieves is making us
 * ask the store a question we already knew the answer to.
 */
export interface StoreNotification {
  readonly store: MobileStore;
  /** The store's event identifier. The idempotency key for redelivery. */
  readonly notificationId: string;
  /** The store's own event name, recorded but not acted on. */
  readonly kind: string;
  /** Which subscription this is about. */
  readonly originalTransactionId: string;
  readonly environment: 'sandbox' | 'production';
  readonly occurredAt: IsoTimestamp;
  /** The remaining payload, with anything sensitive already removed. */
  readonly payload: Readonly<Record<string, unknown>>;
}

/** Thrown when a notification cannot be authenticated. */
export class StoreNotificationError extends Error {
  override readonly name = 'StoreNotificationError';
  readonly reason: 'missing_signature' | 'bad_signature' | 'malformed' | 'wrong_environment';

  constructor(reason: StoreNotificationError['reason'], message?: string) {
    super(message ?? reason);
    this.reason = reason;
  }
}

/** Thrown when the store refuses to confirm a purchase. */
export class PurchaseVerificationError extends Error {
  override readonly name = 'PurchaseVerificationError';
  readonly reason:
    | 'invalid_token'
    | 'wrong_application'
    | 'wrong_environment'
    | 'store_unavailable'
    | 'not_configured';

  constructor(reason: PurchaseVerificationError['reason'], message?: string) {
    super(message ?? reason);
    this.reason = reason;
  }
}

/* -------------------------------------------------------------------------- */
/* The provider                                                                */
/* -------------------------------------------------------------------------- */

export interface StoreCapabilities {
  /** Whether the store exposes a subscriber-initiated pause. Google does. */
  readonly pause: boolean;
  /** Whether the store runs its own grace period before cutting access. */
  readonly gracePeriod: boolean;
  /** Whether we can cancel on the subscriber's behalf. Neither store allows it. */
  readonly serverInitiatedCancellation: boolean;
  /** Whether we can refund on the subscriber's behalf. */
  readonly serverInitiatedRefund: boolean;
  /** Whether the store sends asynchronous server-to-server notifications. */
  readonly notifications: boolean;
}

export interface StoreBillingProvider {
  readonly store: MobileStore;
  readonly capabilities: StoreCapabilities;
  readonly verification: RailVerification;
  readonly mode: 'mock' | 'live';
  /** Which store environment this provider accepts purchases from. */
  readonly environment: 'sandbox' | 'production';

  /**
   * Asks the store about a purchase.
   *
   * The only function in this system that can decide a store subscription is
   * real. Everything else consumes its answer.
   */
  verifyPurchase(receipt: PurchaseReceipt): Promise<VerifiedPurchase>;

  /**
   * Re-asks about a subscription we already know, by its stable identifier.
   *
   * Used by synchronisation and after a notification. Separate from
   * `verifyPurchase` because by then we no longer have the device's token — we
   * have our own record.
   */
  refresh(originalTransactionId: string): Promise<VerifiedPurchase>;

  /**
   * Authenticates a server-to-server notification.
   *
   * Takes raw bytes, like every other callback in this codebase: a body that
   * has been parsed and re-serialised no longer matches what the sender signed.
   */
  verifyNotification(
    rawBody: Uint8Array,
    headers: Readonly<Record<string, string | undefined>>,
  ): Promise<StoreNotification>;
}
