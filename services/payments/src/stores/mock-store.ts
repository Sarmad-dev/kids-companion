import { createHmac, timingSafeEqual } from 'node:crypto';

import type { IsoTimestamp } from '@kids/types';

import { NOTHING_VERIFIED, type RailVerification } from '../rails/types.js';
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
 * The mock store.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * A REAL VERIFICATION SERVICE, NOT A STUB THAT SAYS YES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The whole point of server-side verification is that the server can say NO. A
 * mock that confirms every token would make the tests pass while proving the
 * opposite of what they claim — the suite would never once exercise a rejected
 * purchase, which is the case that matters.
 *
 * So this provider keeps its own books, refuses tokens it has not issued,
 * distinguishes sandbox from production, and signs its notifications with an
 * HMAC that the handler genuinely verifies.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * TOKENS DRIVE THE STATE, THE WAY BOTH REAL STORES' SANDBOXES DO.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The interesting states — grace period, account hold, refund, a token from
 * another app — are unreachable in a happy-path fake, and every one of them is
 * a way a family ends up wrongly with or without access.
 */

/** What a mock token asks the store to say. Suffix of the token. */
export const MOCK_PURCHASE_BEHAVIOURS = {
  active: 'a paid, auto-renewing subscription',
  trial: 'an introductory or trial period',
  grace: 'payment failed; the store is retrying and access continues',
  hold: 'the retry window passed; access should stop but may recover',
  paused: 'the subscriber paused it (Google only)',
  cancelled: 'cancelled, paid to the end of the period',
  expired: 'over',
  refunded: 'money returned; entitlement ends now',
  invalid: 'the store does not recognise this token',
  otherapp: 'a valid token, for a different application',
  sandbox: 'a sandbox purchase, whatever this deployment accepts',
} as const;

export type MockBehaviour = keyof typeof MOCK_PURCHASE_BEHAVIOURS;

const behaviourOf = (token: string): MockBehaviour => {
  const parts = token.split('.');
  const suffix = parts[parts.length - 1] ?? '';
  return suffix in MOCK_PURCHASE_BEHAVIOURS ? (suffix as MockBehaviour) : 'active';
};

export interface MockStoreOptions {
  readonly store: MobileStore;
  /** Signs notifications, so the verification path is exercised, not skipped. */
  readonly notificationSecret: string;
  /** Which environment this deployment accepts. */
  readonly environment: 'sandbox' | 'production';
  /** The product the mock reports. Mapped to a plan by configuration. */
  readonly productId: string;
  /** Required — a store provider that reads wall time cannot be tested. */
  readonly now: () => Date;
  readonly toleranceSeconds?: number;
}

const SIGNATURE_HEADER = 'x-kc-store-signature';

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

export const capabilitiesFor = (store: MobileStore): StoreCapabilities =>
  store === 'apple_iap' ? APPLE_CAPABILITIES : GOOGLE_CAPABILITIES;

const MOCK_VERIFICATION: RailVerification = Object.freeze({
  checklist: NOTHING_VERIFIED,
  source: 'the mock store — it verifies nothing about a real store',
  notes: Object.freeze([
    'This provider exists so local development and CI exercise the verification path.',
    'It says nothing about whether the Apple or Google adapters are correct.',
  ]),
});

const signaturePayload = (timestamp: number, body: Uint8Array): Buffer =>
  Buffer.concat([Buffer.from(`${String(timestamp)}.`), Buffer.from(body)]);

/** The signature the mock store sends. Exported so tests can forge and replay. */
export const signStoreNotification = (
  body: Uint8Array | string,
  secret: string,
  timestampSeconds: number,
): string => {
  const bytes = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  const digest = createHmac('sha256', secret)
    .update(signaturePayload(timestampSeconds, bytes))
    .digest('hex');
  return `t=${String(timestampSeconds)},v1=${digest}`;
};

const parseSignature = (header: string): { timestamp: number; signature: string } | undefined => {
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

const matches = (expected: string, received: string): boolean => {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(received, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
};

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined;

const DAY_MS = 86_400_000;

export const createMockStoreProvider = (options: MockStoreOptions): StoreBillingProvider => {
  const { store, now, environment } = options;
  const tolerance = options.toleranceSeconds ?? 300;

  /* The store's own books. In production these live at Apple or Google; here a
   * Map, which is what makes `refresh` a genuine second source of truth rather
   * than an echo of what we were handed. */
  const issued = new Map<string, VerifiedPurchase>();

  const iso = (offsetMs = 0): IsoTimestamp =>
    new Date(now().getTime() + offsetMs).toISOString() as IsoTimestamp;

  const build = (originalTransactionId: string, behaviour: MockBehaviour): VerifiedPurchase => {
    const base = {
      store,
      originalTransactionId,
      latestTransactionId: `${originalTransactionId}.latest`,
      productId: options.productId,
      autoRenewing: true,
      // `sandbox` behaviour reports a sandbox purchase regardless of what this
      // deployment accepts — that is exactly the case worth being able to test.
      environment: behaviour === 'sandbox' ? ('sandbox' as const) : environment,
      verifiedAt: iso(),
    };

    const state = (value: StorePurchaseState, extra: Partial<VerifiedPurchase> = {}) => ({
      ...base,
      state: value,
      ...extra,
    });

    switch (behaviour) {
      case 'trial':
        return state('trial', { expiresAt: iso(7 * DAY_MS) });
      case 'grace':
        return state('grace_period', {
          expiresAt: iso(-DAY_MS),
          gracePeriodEndsAt: iso(6 * DAY_MS),
        });
      case 'hold':
        return state('on_hold', { expiresAt: iso(-DAY_MS), autoRenewing: true });
      case 'paused':
        return state('paused', { expiresAt: iso(-DAY_MS), autoRenewing: false });
      case 'cancelled':
        return state('cancelled', { expiresAt: iso(20 * DAY_MS), autoRenewing: false });
      case 'expired':
        return state('expired', { expiresAt: iso(-DAY_MS), autoRenewing: false });
      case 'refunded':
        return state('refunded', {
          expiresAt: iso(20 * DAY_MS),
          autoRenewing: false,
          refundedAt: iso(),
        });
      case 'invalid':
        return state('invalid');
      case 'sandbox':
      case 'active':
      case 'otherapp':
      default:
        return state('active', { expiresAt: iso(30 * DAY_MS) });
    }
  };

  return {
    store,
    capabilities: capabilitiesFor(store),
    verification: MOCK_VERIFICATION,
    mode: 'mock',
    environment,

    verifyPurchase: (receipt: PurchaseReceipt): Promise<VerifiedPurchase> => {
      try {
        if (receipt.store !== store) {
          return Promise.reject(new PurchaseVerificationError('invalid_token', 'wrong store'));
        }
        if (receipt.token.length < 8) {
          return Promise.reject(new PurchaseVerificationError('invalid_token'));
        }

        const behaviour = behaviourOf(receipt.token);

        // A token that belongs to a different application. Both stores return
        // this and it is a genuine attack: a purchase made in any other app,
        // presented here.
        if (behaviour === 'otherapp') {
          return Promise.reject(new PurchaseVerificationError('wrong_application'));
        }
        if (behaviour === 'invalid') {
          return Promise.reject(new PurchaseVerificationError('invalid_token'));
        }

        // The original transaction id is derived from the token, so the same
        // token always identifies the same subscription — which is what makes
        // "restore purchases" and duplicate detection work.
        const originalTransactionId = `${store}_${receipt.token.split('.')[0] ?? receipt.token}`;
        const purchase = build(originalTransactionId, behaviour);
        issued.set(originalTransactionId, purchase);

        return Promise.resolve(purchase);
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },

    refresh: (originalTransactionId: string): Promise<VerifiedPurchase> => {
      const known = issued.get(originalTransactionId);
      if (!known) {
        return Promise.reject(
          new PurchaseVerificationError('invalid_token', 'unknown to the store'),
        );
      }
      // A fresh answer, with a fresh timestamp — a refresh is a new statement
      // by the store, not a replay of the old one.
      return Promise.resolve({ ...known, verifiedAt: iso() });
    },

    /** Lets a test move a subscription on, the way a real store would. */
    verifyNotification: (
      rawBody: Uint8Array,
      headers: Readonly<Record<string, string | undefined>>,
    ): Promise<StoreNotification> => {
      try {
        const header = headers[SIGNATURE_HEADER] ?? headers[SIGNATURE_HEADER.toLowerCase()];
        if (header === undefined || header === '') {
          throw new StoreNotificationError('missing_signature');
        }

        const parsed = parseSignature(header);
        if (parsed === undefined) throw new StoreNotificationError('malformed', 'signature header');

        const expected = createHmac('sha256', options.notificationSecret)
          .update(signaturePayload(parsed.timestamp, rawBody))
          .digest('hex');

        if (!matches(expected, parsed.signature)) {
          throw new StoreNotificationError('bad_signature');
        }

        const skew = Math.abs(Math.floor(now().getTime() / 1000) - parsed.timestamp);
        if (skew > tolerance) throw new StoreNotificationError('bad_signature', 'stale timestamp');

        let body: Record<string, unknown>;
        try {
          const decoded: unknown = JSON.parse(Buffer.from(rawBody).toString('utf8'));
          if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
            throw new Error('not an object');
          }
          body = decoded as Record<string, unknown>;
        } catch {
          throw new StoreNotificationError('malformed', 'body is not a JSON object');
        }

        const notificationId = asString(body.notification_id);
        const originalTransactionId = asString(body.original_transaction_id);
        const kind = asString(body.kind);

        if (
          notificationId === undefined ||
          originalTransactionId === undefined ||
          kind === undefined
        ) {
          throw new StoreNotificationError(
            'malformed',
            'notification_id, original_transaction_id, and kind are required',
          );
        }

        /* The mock's own books move here, so that a later `refresh` returns the
         * new state — mirroring how a real store's records change and then its
         * API reports the change. The notification payload itself is still not
         * acted on by the handler; it re-asks. */
        const nextState = asString(body.state);
        if (nextState !== undefined && issued.has(originalTransactionId)) {
          const updated = build(originalTransactionId, nextState as MockBehaviour);
          issued.set(originalTransactionId, updated);
        }

        return Promise.resolve({
          store,
          notificationId,
          kind,
          originalTransactionId,
          environment: asString(body.environment) === 'sandbox' ? 'sandbox' : environment,
          occurredAt: (asString(body.occurred_at) ?? iso()) as IsoTimestamp,
          payload: redactPayload(body) as Readonly<Record<string, unknown>>,
        });
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
  };
};
