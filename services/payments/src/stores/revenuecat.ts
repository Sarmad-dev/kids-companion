import { createHmac, timingSafeEqual } from 'node:crypto';

import { ProviderTimeoutError, withTimeout, type Clock, systemClock } from '@kids/shared';
import type { IsoTimestamp } from '@kids/types';

import type { RailVerification } from '../rails/types.js';
import { redactPayload } from '../redaction.js';

import {
  PurchaseVerificationError,
  StoreNotificationError,
  type MobileStore,
  type PurchaseReceipt,
  type StoreBillingProvider,
  type StoreCapabilities,
  type StoreNotification,
  type StorePurchaseState,
  type VerifiedPurchase,
} from './types.js';

/**
 * RevenueCat, standing in front of Apple and Google.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS ADAPTER EXISTS WHERE THE APPLE AND GOOGLE ONES REFUSE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `adapters.ts` refuses to guess Apple's or Google's wire format because
 * neither has been read from current documentation, and both are known to
 * change. RevenueCat is different: it is ONE stable, versioned, publicly
 * documented REST API that already did the hard, unstable part — it holds
 * Apple's and Google's own server credentials and re-verifies every purchase
 * against them directly. Our server's job shrinks to "ask RevenueCat what
 * this subscriber has," which is the one part of this integration that is
 * actually safe to write from documentation rather than guesswork.
 *
 * ⚠️ NOT YET EXERCISED AGAINST THE LIVE API. Every behaviour below is written
 * from RevenueCat's REST API v1 and Webhooks documentation (Customer Info
 * Model, `GET /subscribers/{app_user_id}`, webhook event types and the HMAC
 * signature scheme — read 2026-09-18). Nothing here has been confirmed
 * against a real response. See `REVENUECAT_VERIFICATION` below for exactly
 * which parts that leaves outstanding, and docs/REVENUECAT.md for the
 * checklist to run before `STORE_BILLING_VERIFIED_STORES` includes a store
 * backed by this provider.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE SAME RULE AS EVERY OTHER PROVIDER: THE CLIENT SENDS A TOKEN, NEVER A
 * STATUS.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The "token" here is the RevenueCat `app_user_id` — which this deployment
 * sets equal to our own `parentId` when the mobile SDK is configured (see
 * `apps/mobile/src/iap/use-store-billing.ts`), so a device can say WHO it is
 * but still cannot say WHAT it has. `verifyPurchase` re-asks RevenueCat's
 * server for that subscriber's entitlements every time; nothing the device
 * reports about its own purchase is read.
 */

export interface RevenueCatConfig {
  /** Which of our two stores this instance answers for. */
  readonly store: MobileStore;
  /** Server-side only. Never shipped to the app — see the file banner. */
  readonly secretApiKey: string;
  /** Verifies `X-RevenueCat-Webhook-Signature`. Set in the RC dashboard's webhook config. */
  readonly webhookSigningSecret: string;
  /**
   * The RevenueCat entitlement identifier this deployment grants a
   * subscription for (configured in the RC dashboard — see docs/REVENUECAT.md
   * §2). Not a product id: one entitlement can be reached by several products
   * (monthly, annual), and RevenueCat resolves that for us.
   */
  readonly entitlementId: string;
  readonly environment: 'sandbox' | 'production';
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  /** Injected so the adapter is testable without a network. */
  readonly fetchImpl?: typeof fetch;
  /** Injected so a test can control both the clock and the timestamps. */
  readonly clock?: Clock;
  readonly toleranceSeconds?: number;
}

const APPLE_CAPABILITIES: StoreCapabilities = Object.freeze({
  pause: false,
  gracePeriod: true,
  serverInitiatedCancellation: false,
  serverInitiatedRefund: false,
  notifications: true,
});

const GOOGLE_CAPABILITIES: StoreCapabilities = Object.freeze({
  pause: true,
  gracePeriod: true,
  serverInitiatedCancellation: false,
  serverInitiatedRefund: false,
  notifications: true,
});

export const REVENUECAT_VERIFICATION: RailVerification = Object.freeze({
  checklist: Object.freeze({
    // Read from RevenueCat's own current REST API v1 and Webhooks docs.
    endpoints: true,
    requestSchema: true,
    signatureScheme: true,
    // N/A: this adapter never reads or acts on a price. See `PurchaseReceipt`
    // and the file banner — the one rule that applies to every store here.
    amountUnits: true,
    // NOT confirmed: the exact HTTP status RevenueCat returns for a genuinely
    // unknown app_user_id (coded below as 404; RevenueCat is documented
    // elsewhere as auto-creating subscriber records on first touch, which
    // would make an unknown id a 200 with empty `entitlements` instead — both
    // are handled, but only one is right, and it has not been exercised).
    statusCodes: false,
    // Retry count, backoff, and the idempotency contract (dedupe on `id`) are
    // documented and match how `handleNotification` already treats every
    // notification as a hint to re-verify, never a fact.
    callbackSemantics: true,
    // `CANCELLATION` covers both a cancellation and a refund per RevenueCat's
    // docs; `subscriptions[x].refunded_at` on the subscriber record is the
    // authoritative signal this adapter actually reads.
    refundSemantics: true,
    // Nobody has run a real purchase through a RevenueCat sandbox project and
    // watched this adapter answer correctly. This is the one box that matters
    // most and it is unticked.
    sandboxTested: false,
  }),
  source:
    "RevenueCat's REST API v1 (Customer Info Model) and Webhooks documentation, read 2026-09-18",
  notes: Object.freeze([
    'Whether an unseen app_user_id 404s or auto-creates (200, empty) is unconfirmed — both are handled, but only one path has a real answer behind it.',
    'period_type casing differs between the subscriber API (documented lower-case: normal/trial/intro) and webhook events (upper-case: NORMAL/TRIAL/INTRO) — this adapter compares case-insensitively, which is a defensive guess, not a confirmed contract.',
    'RevenueCat TRANSFER and PRODUCT_CHANGE events are not specially handled — an upgrade/downgrade or a transfer between app_user_ids will not be followed, the same open gap PRODUCT_CHANGE and Google linked-token upgrades already are (STORE_BILLING.md §7).',
    'Family Sharing and multi-entitlement subscribers are unhandled — this adapter reads exactly one entitlement id, configured per deployment.',
    'A sandbox purchase must be run end to end — real device, real RevenueCat sandbox project, real webhook delivery — before this adapter is added to STORE_BILLING_VERIFIED_STORES in a deployed environment.',
  ]),
});

/* -------------------------------------------------------------------------- */
/* RevenueCat's own shapes. Nothing beyond this file reads them.               */
/* -------------------------------------------------------------------------- */

interface RevenueCatSubscription {
  readonly expires_date: string | null;
  readonly purchase_date: string;
  readonly period_type?: string;
  readonly store: string;
  readonly is_sandbox: boolean;
  readonly unsubscribe_detected_at: string | null;
  readonly billing_issues_detected_at: string | null;
  readonly grace_period_expires_date: string | null;
  readonly refunded_at: string | null;
  readonly auto_resume_date: string | null;
  readonly store_transaction_id?: string | number;
}

interface RevenueCatEntitlement {
  readonly expires_date: string | null;
  readonly grace_period_expires_date: string | null;
  readonly product_identifier: string;
  readonly purchase_date: string;
}

interface RevenueCatSubscriber {
  readonly original_app_user_id: string;
  readonly entitlements: Readonly<Record<string, RevenueCatEntitlement>>;
  readonly subscriptions: Readonly<Record<string, RevenueCatSubscription>>;
}

interface RevenueCatSubscriberResponse {
  readonly subscriber: RevenueCatSubscriber;
}

/* -------------------------------------------------------------------------- */
/* Store and state translation                                                 */
/* -------------------------------------------------------------------------- */

/** RevenueCat's `store` values (lower-case on the subscriber API) → ours. */
const storeFrom = (rcStore: string): MobileStore | undefined => {
  const value = rcStore.toLowerCase();
  if (value === 'app_store' || value === 'mac_app_store') return 'apple_iap';
  if (value === 'play_store') return 'google_play';
  return undefined;
};

/**
 * A subscription record → our nine-state enum.
 *
 * RevenueCat abstracts Apple and Google into one shape, and the fields it
 * exposes do not line up one-to-one with our states (see `REVENUECAT_VERIFICATION`
 * notes). This is a considered best-effort mapping, ordered so the more
 * specific and more recent signal wins:
 *
 *   refunded > paused > (within the paid period: cancelled > trial > active)
 *   > grace_period > on_hold > expired
 */
const deriveState = (sub: RevenueCatSubscription, nowMs: number): StorePurchaseState => {
  if (sub.refunded_at !== null) return 'refunded';

  const resumesAt = sub.auto_resume_date === null ? undefined : Date.parse(sub.auto_resume_date);
  if (resumesAt !== undefined && Number.isFinite(resumesAt) && resumesAt > nowMs) return 'paused';

  const expiresAt = sub.expires_date === null ? undefined : Date.parse(sub.expires_date);
  const withinPaidPeriod =
    expiresAt === undefined || !Number.isFinite(expiresAt) || expiresAt > nowMs;

  if (withinPaidPeriod) {
    if (sub.unsubscribe_detected_at !== null) return 'cancelled';
    const periodType = sub.period_type?.toLowerCase();
    if (periodType === 'trial' || periodType === 'intro') return 'trial';
    return 'active';
  }

  const graceEndsAt =
    sub.grace_period_expires_date === null ? undefined : Date.parse(sub.grace_period_expires_date);
  if (graceEndsAt !== undefined && Number.isFinite(graceEndsAt) && graceEndsAt > nowMs) {
    return 'grace_period';
  }

  if (sub.billing_issues_detected_at !== null) return 'on_hold';

  return 'expired';
};

/**
 * The stable id we hand back as `originalTransactionId`.
 *
 * RevenueCat's subscriber record has no single field documented as playing
 * that exact role (see `REVENUECAT_VERIFICATION` notes on `statusCodes`), so
 * this adapter builds its own from what IS stable across renewals: the
 * subscriber's `original_app_user_id` (survives aliasing — see RevenueCat's
 * docs on `$RCAnonymousID` merging into an identified user) plus the product
 * id the entitlement resolved to.
 */
const ORIGINAL_TXN_PREFIX = 'revenuecat';

const encodeOriginalTransactionId = (originalAppUserId: string, productId: string): string =>
  `${ORIGINAL_TXN_PREFIX}:${originalAppUserId}:${productId}`;

const decodeOriginalTransactionId = (
  value: string,
): { readonly appUserId: string; readonly productId: string } | undefined => {
  const parts = value.split(':');
  if (parts.length !== 3) return undefined;
  const [prefix, appUserId, productId] = parts;
  if (prefix !== ORIGINAL_TXN_PREFIX || appUserId === '' || productId === '') return undefined;
  return { appUserId: appUserId!, productId: productId! };
};

const buildVerifiedPurchase = (
  originalAppUserId: string,
  productId: string,
  sub: RevenueCatSubscription,
  fallbackStore: MobileStore,
  nowMs: number,
): VerifiedPurchase => ({
  store: storeFrom(sub.store) ?? fallbackStore,
  state: deriveState(sub, nowMs),
  originalTransactionId: encodeOriginalTransactionId(originalAppUserId, productId),
  ...(sub.store_transaction_id === undefined
    ? {}
    : { latestTransactionId: String(sub.store_transaction_id) }),
  productId,
  ...(sub.expires_date === null ? {} : { expiresAt: sub.expires_date as IsoTimestamp }),
  ...(sub.grace_period_expires_date === null
    ? {}
    : { gracePeriodEndsAt: sub.grace_period_expires_date as IsoTimestamp }),
  // Not renewing when the subscriber cancelled OR the store has it paused
  // (Google) with a scheduled resume — both mean "no further charge coming."
  autoRenewing: sub.unsubscribe_detected_at === null && sub.auto_resume_date === null,
  environment: sub.is_sandbox ? 'sandbox' : 'production',
  verifiedAt: new Date(nowMs).toISOString() as IsoTimestamp,
  ...(sub.refunded_at === null ? {} : { refundedAt: sub.refunded_at as IsoTimestamp }),
});

/** A real subscriber who simply is not entitled — not a rejection. */
const notEntitled = (
  originalAppUserId: string,
  productId: string,
  fallbackStore: MobileStore,
  environment: 'sandbox' | 'production',
  nowMs: number,
): VerifiedPurchase => ({
  store: fallbackStore,
  state: 'expired',
  originalTransactionId: encodeOriginalTransactionId(originalAppUserId, productId),
  productId,
  autoRenewing: false,
  environment,
  verifiedAt: new Date(nowMs).toISOString() as IsoTimestamp,
});

/* -------------------------------------------------------------------------- */
/* Webhook signature                                                           */
/* -------------------------------------------------------------------------- */

const SIGNATURE_HEADER = 'x-revenuecat-webhook-signature';

const parseSignatureHeader = (
  header: string,
): { readonly timestamp: number; readonly signature: string } | undefined => {
  let timestamp: number | undefined;
  let signature: string | undefined;
  for (const part of header.split(',')) {
    const [key, value] = part.trim().split('=', 2);
    if (key === 't' && value !== undefined) timestamp = Number(value);
    if (key === 'v1' && value !== undefined) signature = value;
  }
  if (timestamp === undefined || !Number.isFinite(timestamp) || signature === undefined) {
    return undefined;
  }
  return { timestamp, signature };
};

const constantTimeEquals = (expected: string, received: string): boolean => {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(received, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
};

/* -------------------------------------------------------------------------- */
/* The provider                                                                */
/* -------------------------------------------------------------------------- */

export const createRevenueCatProvider = (config: RevenueCatConfig): StoreBillingProvider => {
  const doFetch = config.fetchImpl ?? fetch;
  const timeoutMs = config.timeoutMs ?? 10_000;
  const baseUrl = config.baseUrl ?? 'https://api.revenuecat.com/v1';
  const clock = config.clock ?? systemClock;
  const tolerance = config.toleranceSeconds ?? 300;

  const fetchSubscriber = async (appUserId: string): Promise<RevenueCatSubscriber> => {
    let response: Response;
    try {
      response = await withTimeout(
        'revenuecat.subscriber',
        timeoutMs,
        async (signal) =>
          await doFetch(`${baseUrl}/subscribers/${encodeURIComponent(appUserId)}`, {
            method: 'GET',
            headers: {
              authorization: `Bearer ${config.secretApiKey}`,
              accept: 'application/json',
            },
            signal,
          }),
      );
    } catch (error) {
      if (error instanceof ProviderTimeoutError) {
        throw new PurchaseVerificationError('store_unavailable', error.message);
      }
      throw new PurchaseVerificationError('store_unavailable', 'revenuecat unreachable');
    }

    // Undocumented-with-certainty (see REVENUECAT_VERIFICATION): treated as
    // "RevenueCat has never seen this subscriber" rather than a hard failure,
    // since that is the ordinary first-launch case, not an error condition.
    if (response.status === 404) {
      throw new PurchaseVerificationError('invalid_token', 'unknown to revenuecat');
    }
    if (!response.ok) {
      throw new PurchaseVerificationError(
        'store_unavailable',
        `revenuecat responded ${String(response.status)}`,
      );
    }

    let body: RevenueCatSubscriberResponse;
    try {
      body = (await response.json()) as RevenueCatSubscriberResponse;
    } catch {
      throw new PurchaseVerificationError('store_unavailable', 'unparseable response');
    }
    return body.subscriber;
  };

  return {
    store: config.store,
    capabilities: config.store === 'apple_iap' ? APPLE_CAPABILITIES : GOOGLE_CAPABILITIES,
    verification: REVENUECAT_VERIFICATION,
    mode: 'live',
    environment: config.environment,

    verifyPurchase: async (receipt: PurchaseReceipt): Promise<VerifiedPurchase> => {
      if (receipt.store !== config.store) {
        throw new PurchaseVerificationError('invalid_token', 'wrong store');
      }
      if (receipt.token.length < 8) {
        throw new PurchaseVerificationError('invalid_token');
      }

      // The "token" is the RevenueCat app_user_id — see the file banner.
      const subscriber = await fetchSubscriber(receipt.token);
      const entitlement = subscriber.entitlements[config.entitlementId];

      if (entitlement === undefined) {
        return notEntitled(
          subscriber.original_app_user_id,
          receipt.productIdHint ?? 'none',
          config.store,
          config.environment,
          clock.now(),
        );
      }

      const sub = subscriber.subscriptions[entitlement.product_identifier];
      if (sub === undefined) {
        // An entitlement RevenueCat resolved to a product it does not also
        // list under `subscriptions` — inconsistent with the documented
        // shape. Refused rather than guessed at.
        throw new PurchaseVerificationError(
          'store_unavailable',
          'entitlement without a matching subscription record',
        );
      }

      return buildVerifiedPurchase(
        subscriber.original_app_user_id,
        entitlement.product_identifier,
        sub,
        config.store,
        clock.now(),
      );
    },

    refresh: async (originalTransactionId: string): Promise<VerifiedPurchase> => {
      const decoded = decodeOriginalTransactionId(originalTransactionId);
      if (decoded === undefined) {
        throw new PurchaseVerificationError('invalid_token', 'not a revenuecat transaction id');
      }

      const subscriber = await fetchSubscriber(decoded.appUserId);
      const sub = subscriber.subscriptions[decoded.productId];
      if (sub === undefined) {
        // RevenueCat no longer has a record of this product for this
        // subscriber. Refused rather than reported as "expired" under a
        // guessed store — see the file banner's rule about never guessing.
        throw new PurchaseVerificationError('invalid_token', 'no longer known to revenuecat');
      }

      return buildVerifiedPurchase(
        subscriber.original_app_user_id,
        decoded.productId,
        sub,
        config.store,
        clock.now(),
      );
    },

    verifyNotification: (
      rawBody: Uint8Array,
      headers: Readonly<Record<string, string | undefined>>,
    ): Promise<StoreNotification> =>
      Promise.resolve().then(() => {
        const header = headers[SIGNATURE_HEADER] ?? headers[SIGNATURE_HEADER.toUpperCase()];
        if (header === undefined || header === '') {
          throw new StoreNotificationError('missing_signature');
        }

        const parsed = parseSignatureHeader(header);
        if (parsed === undefined) throw new StoreNotificationError('malformed', 'signature header');

        const expected = createHmac('sha256', config.webhookSigningSecret)
          .update(
            Buffer.concat([Buffer.from(`${String(parsed.timestamp)}.`), Buffer.from(rawBody)]),
          )
          .digest('hex');

        if (!constantTimeEquals(expected, parsed.signature)) {
          throw new StoreNotificationError('bad_signature');
        }

        const skew = Math.abs(Math.floor(clock.now() / 1000) - parsed.timestamp);
        if (skew > tolerance) throw new StoreNotificationError('bad_signature', 'stale timestamp');

        let parsedBody: unknown;
        try {
          parsedBody = JSON.parse(Buffer.from(rawBody).toString('utf8'));
        } catch {
          throw new StoreNotificationError('malformed', 'body is not JSON');
        }

        if (typeof parsedBody !== 'object' || parsedBody === null) {
          throw new StoreNotificationError('malformed', 'body is not an object');
        }

        const event = (parsedBody as { event?: unknown }).event;
        if (typeof event !== 'object' || event === null) {
          throw new StoreNotificationError('malformed', 'missing event');
        }

        const e = event as Record<string, unknown>;
        const id = typeof e.id === 'string' ? e.id : undefined;
        const type = typeof e.type === 'string' ? e.type : undefined;
        const originalAppUserId =
          typeof e.original_app_user_id === 'string' ? e.original_app_user_id : undefined;
        const productId = typeof e.product_id === 'string' ? e.product_id : undefined;
        const environment =
          typeof e.environment === 'string' ? e.environment.toLowerCase() : undefined;
        const timestampMs =
          typeof e.event_timestamp_ms === 'number' ? e.event_timestamp_ms : undefined;
        const rcStore = typeof e.store === 'string' ? e.store : undefined;

        if (id === undefined || type === undefined || originalAppUserId === undefined) {
          throw new StoreNotificationError(
            'malformed',
            'id, type, and original_app_user_id are required',
          );
        }

        // Event shapes this adapter has NOT verified (transfers, aliasing,
        // non-subscription events) are refused rather than mapped by guess —
        // see REVENUECAT_VERIFICATION notes.
        if (productId === undefined) {
          throw new StoreNotificationError(
            'malformed',
            `event type "${type}" has no product_id — not a verified event shape`,
          );
        }

        const mobileStore = rcStore === undefined ? undefined : storeFrom(rcStore);
        if (mobileStore === undefined || mobileStore !== config.store) {
          throw new StoreNotificationError('malformed', 'unsupported or mismatched store');
        }

        return {
          store: mobileStore,
          notificationId: id,
          kind: type,
          originalTransactionId: encodeOriginalTransactionId(originalAppUserId, productId),
          environment: environment === 'sandbox' ? 'sandbox' : 'production',
          occurredAt: (timestampMs === undefined
            ? clock.nowIso()
            : new Date(timestampMs).toISOString()) as IsoTimestamp,
          payload: redactPayload(e) as Readonly<Record<string, unknown>>,
        };
      }),
  };
};
