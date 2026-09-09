import { NOTHING_VERIFIED, type RailVerification } from '../rails/types.js';

import { capabilitiesFor } from './mock-store.js';
import {
  PurchaseVerificationError,
  StoreNotificationError,
  type MobileStore,
  type StoreBillingProvider,
} from './types.js';

/**
 * Apple App Store and Google Play adapters.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * NEITHER IS IMPLEMENTED, AND BOTH REFUSE RATHER THAN GUESS.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * No endpoint, request shape, JWS claim name, or notification field for either
 * store appears here. Nothing has been read from Apple's or Google's current
 * documentation, and both have changed their subscription APIs more than once —
 * Apple moved from receipt verification to the App Store Server API and
 * notifications V2; Google's Play Developer API and Real-time Developer
 * Notifications have their own migrations.
 *
 * Writing either from memory would produce an adapter that looks complete,
 * passes every test written against our own guess, and fails at review time or,
 * worse, in front of a paying family.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT IS DIFFERENT ABOUT STORE BILLING, AND WHY IT IS WORSE TO GUESS HERE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A payment rail that is wrong fails a payment. A store adapter that is wrong
 * fails an app review — and app review is not a retry loop. Both stores reject
 * builds whose billing integration misbehaves, and a rejection costs a release
 * cycle for a product where the child experience is the mobile app.
 *
 * So this is the one integration where "we will find out when we try it" is
 * most expensive, and the checklist below is correspondingly the thing to
 * complete before anyone submits anything.
 */

/* -------------------------------------------------------------------------- */
/* Apple                                                                       */
/* -------------------------------------------------------------------------- */

export interface AppleStoreConfig {
  /**
   * Credentials for the App Store server API.
   *
   * NONE of these is ever shipped in the mobile application. The app receives a
   * transaction identifier from StoreKit and sends it to our server; our server
   * holds the key. A key in the bundle is a key an attacker has.
   */
  readonly issuerId: string;
  readonly keyId: string;
  /** The signing key, from configuration. Never committed, never in the app. */
  readonly privateKey: string;
  readonly bundleId: string;
  /** Legacy receipt verification, where still needed. */
  readonly sharedSecret?: string | undefined;
  readonly environment: 'sandbox' | 'production';
}

export const APPLE_VERIFICATION: RailVerification = Object.freeze({
  checklist: NOTHING_VERIFIED,
  source: "Apple's current App Store Server API and server notifications documentation",
  notes: Object.freeze([
    'Which API generation to use is itself an open decision, and it changes the entire adapter.',
    'Signed transaction payloads must be verified against Apple’s certificate chain — accepting them unverified would be the whole vulnerability.',
    'Sandbox and production are separate environments; a sandbox purchase honoured in production is a free subscription for anyone with a test account.',
    'Notification delivery is retried and can arrive out of order. Treat every notification as a hint to re-verify, never as a fact.',
    'Family Sharing means one purchase can cover several people. Whether that maps to our parent accounts is a product decision, not an adapter one.',
    'Refunds and revocations arrive asynchronously, sometimes long after the fact.',
  ]),
});

/* -------------------------------------------------------------------------- */
/* Google                                                                      */
/* -------------------------------------------------------------------------- */

export interface GooglePlayConfig {
  readonly packageName: string;
  /**
   * Service-account credentials for the Play Developer API.
   *
   * Server-side only, exactly like Apple's key. The Android app receives a
   * purchase token and sends it to us; it never holds a credential that could
   * be used to query or grant anything.
   */
  readonly serviceAccountJson: string;
  /** Where Real-time Developer Notifications are delivered. */
  readonly notificationTopic?: string | undefined;
  readonly environment: 'sandbox' | 'production';
}

export const GOOGLE_VERIFICATION: RailVerification = Object.freeze({
  checklist: NOTHING_VERIFIED,
  source: "Google's current Play Developer API and Real-time Developer Notifications documentation",
  notes: Object.freeze([
    'A purchase must be acknowledged within the window Google specifies, or it is automatically refunded — one of the few places where doing nothing actively loses money.',
    'Account hold, pause, and grace period are distinct states with different entitlement consequences; collapsing them is a common and expensive error.',
    'Notifications arrive through a message queue and are explicitly at-least-once and unordered.',
    'Upgrades and downgrades produce a linked purchase token; missing the link makes one subscription look like two.',
    'Test purchases from licensed accounts must not be honoured in production.',
    'Refunds and chargebacks are notified asynchronously.',
  ]),
});

/* -------------------------------------------------------------------------- */
/* The unimplemented adapter                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A store adapter that refuses.
 *
 * Every method rejects with an error naming what is outstanding. It does not
 * return a plausible success, and it does not fall back to the mock.
 *
 * Returning a fabricated `active` here would be the worst failure available to
 * this codebase: it would grant subscriptions nobody paid for, to real families,
 * while looking exactly like a working integration.
 */
export const createUnverifiedStoreProvider = (
  store: MobileStore,
  verification: RailVerification,
  environment: 'sandbox' | 'production',
): StoreBillingProvider => {
  const outstanding = Object.entries(verification.checklist)
    .filter(([, done]) => !done)
    .map(([name]) => name);

  const message =
    `The ${store} adapter is not implemented. Its wire format has not been verified ` +
    `against ${verification.source}; outstanding: ${outstanding.join(', ')}. ` +
    `Use the mock provider, or complete the integration — do not guess.`;

  return {
    store,
    capabilities: capabilitiesFor(store),
    verification,
    mode: 'live',
    environment,
    verifyPurchase: () => Promise.reject(new PurchaseVerificationError('not_configured', message)),
    refresh: () => Promise.reject(new PurchaseVerificationError('not_configured', message)),
    verifyNotification: () => Promise.reject(new StoreNotificationError('malformed', message)),
  };
};

export const createAppleStoreProvider = (config: AppleStoreConfig): StoreBillingProvider =>
  createUnverifiedStoreProvider('apple_iap', APPLE_VERIFICATION, config.environment);

export const createGooglePlayProvider = (config: GooglePlayConfig): StoreBillingProvider =>
  createUnverifiedStoreProvider('google_play', GOOGLE_VERIFICATION, config.environment);
