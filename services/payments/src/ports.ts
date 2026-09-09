import type { IsoTimestamp, ParentId, SubscriptionId } from '@kids/types';

/**
 * Payment ports.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * NOTHING A CLIENT SENDS CAN CHANGE A SUBSCRIPTION.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This is the single most important property in this file, and the shape of the
 * types is what enforces it. `SubscriptionProvider.createCheckout` returns a
 * `CheckoutSession` — a place to send the parent — and never a status. There is
 * no method anywhere here that a request handler could call to mark something
 * paid, because the only thing that marks something paid is a
 * `VerifiedWebhookEvent`, and the only way to get one of those is
 * `verifyAndParseWebhook`, which takes raw bytes and a signature.
 *
 * A frontend saying "the payment succeeded" is a fact about a browser, not
 * about money.
 *
 * Three concerns stay separate, because they are commonly conflated — see
 * docs/adr/0007-payments-and-app-store-billing.md:
 *
 *   1. Payment collection — vendor-specific, per rail. This file.
 *   2. Subscription state — our record, reconciled from verified events.
 *      A pure state machine in `lifecycle.ts`.
 *   3. Entitlement       — "may this child take another turn right now?",
 *                          answered from our own tables, in one place, without
 *                          calling a vendor. A webhook outage must not stop a
 *                          paying child from talking.
 */

export const PAYMENT_RAILS = [
  // Cards, through whichever processor is configured. `stripe` is kept as a
  // distinct value because rows already reference it.
  'card',
  'stripe',
  // Pakistan.
  'jazzcash',
  'easypaisa',
  'carrier_billing',
  // App stores, required for in-app purchase — see Q-02.
  'apple_iap',
  'google_play',
  // Local and CI only; configuration refuses it in a deployed environment.
  'mock',
] as const;
export type PaymentRail = (typeof PAYMENT_RAILS)[number];

export const isPaymentRail = (value: string): value is PaymentRail =>
  (PAYMENT_RAILS as readonly string[]).includes(value);

/** Minor units plus a currency code. Never a float — 0.1 + 0.2 is not a billing strategy. */
export interface Money {
  readonly amountMinor: number;
  readonly currency: string;
}

/* -------------------------------------------------------------------------- */
/* Plans                                                                       */
/* -------------------------------------------------------------------------- */

export const BILLING_INTERVALS = ['week', 'month', 'year', 'once', 'none'] as const;
export type BillingInterval = (typeof BILLING_INTERVALS)[number];

/**
 * A plan, as the application sees it.
 *
 * Every field is read from `subscription_plans`. There is no default price, no
 * fallback interval, and no hard-coded trial length anywhere in the codebase —
 * a plan that is not in the database does not exist, and a price that is not in
 * the database cannot be charged.
 */
export interface PlanPolicy {
  readonly code: string;
  readonly displayName: string;
  readonly tier: 'free' | 'paid';
  readonly price: Money;
  readonly billingInterval: BillingInterval;
  readonly trialDays: number;
  readonly graceDays: number;
}

/* -------------------------------------------------------------------------- */
/* Checkout                                                                    */
/* -------------------------------------------------------------------------- */

export interface CheckoutRequest {
  readonly parentId: ParentId;
  readonly plan: PlanPolicy;
  /** Our checkout row's id, passed to the rail so its webhook can be tied back. */
  readonly reference: string;
  /** Required — retries on a flaky mobile connection are routine, not an edge case. */
  readonly idempotencyKey: string;
  /** Whether this account has already had its free trial. */
  readonly trialAvailable: boolean;
}

export interface CheckoutSession {
  readonly rail: PaymentRail;
  readonly externalId: string;
  /** Where to send the parent. Absent for rails that complete in-app. */
  readonly redirectUrl?: string | undefined;
  readonly expiresAt: IsoTimestamp;
}

/* -------------------------------------------------------------------------- */
/* Webhook events                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The canonical event vocabulary.
 *
 * Every rail's own event names are mapped onto these by its adapter, so the
 * reconciler and the state machine never learn a vendor's spelling. Adding a
 * rail is a mapping exercise; it is not a change to the lifecycle.
 */
export const WEBHOOK_EVENT_TYPES = [
  /** A checkout completed and the first payment cleared. */
  'subscription.activated',
  /** A trial began without an up-front charge. */
  'subscription.trial_started',
  /** A renewal payment cleared. */
  'subscription.renewed',
  /** A charge failed — first attempt or a dunning retry. */
  'payment.failed',
  /** The parent (or the vendor) cancelled. Access usually runs to period end. */
  'subscription.cancelled',
  /** A cancellation was reversed before it took effect. */
  'subscription.resumed',
  /** The vendor considers it over. */
  'subscription.expired',
  /** Money went back. Treated as an immediate end to entitlement. */
  'payment.refunded',
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export const isWebhookEventType = (value: string): value is WebhookEventType =>
  (WEBHOOK_EVENT_TYPES as readonly string[]).includes(value);

/**
 * An event whose signature verified.
 *
 * The name is doing work. There is no `WebhookEvent` type in this system —
 * only a verified one — so a function that accepts an event is accepting
 * something that has already been authenticated, and the type system says so.
 */
export interface VerifiedWebhookEvent {
  readonly rail: PaymentRail;
  /** The vendor's event id. The idempotency key for the whole pipeline. */
  readonly externalEventId: string;
  readonly type: WebhookEventType;
  /**
   * The VENDOR's timestamp, not ours.
   *
   * Ordering is decided by this. A redelivery that arrives late must not look
   * newer than the event it follows, and our own clock cannot tell the
   * difference.
   */
  readonly occurredAt: IsoTimestamp;
  /** Our checkout reference, when the event relates to one. */
  readonly reference?: string | undefined;
  /** The vendor's subscription id, once one exists. */
  readonly externalSubscriptionId?: string | undefined;
  readonly amount?: Money | undefined;
  /** The vendor's reason for a failure. Recorded, never shown to a parent verbatim. */
  readonly failureCode?: string | undefined;
  /** When the paid period the vendor just billed for ends. */
  readonly periodEnd?: IsoTimestamp | undefined;
  readonly paymentMethod?:
    | {
        readonly brand?: string | undefined;
        /** Four digits. There is no field here for anything longer, by design. */
        readonly last4?: string | undefined;
      }
    | undefined;
  /** The remaining payload, with card-shaped fields already removed. */
  readonly payload: Readonly<Record<string, unknown>>;
}

/**
 * Why a webhook was refused.
 *
 * Distinguished from a generic error because the response differs: a bad
 * signature is a 400 the vendor should never retry, a stale timestamp is a 400,
 * and a processing fault is a 500 the vendor SHOULD retry.
 */
export class WebhookVerificationError extends Error {
  override readonly name = 'WebhookVerificationError';
  readonly reason: 'missing_signature' | 'bad_signature' | 'stale_timestamp' | 'malformed';

  constructor(reason: WebhookVerificationError['reason'], message?: string) {
    super(message ?? reason);
    this.reason = reason;
  }
}

/* -------------------------------------------------------------------------- */
/* The provider                                                                */
/* -------------------------------------------------------------------------- */

export interface SubscriptionProvider {
  readonly rail: PaymentRail;

  /**
   * Opens a checkout with the rail.
   *
   * Returns somewhere to send the parent. Deliberately cannot return a status:
   * whether money moved is decided later, by a webhook.
   */
  createCheckout(request: CheckoutRequest): Promise<CheckoutSession>;

  /**
   * Asks the rail to stop billing.
   *
   * Our record of the cancellation is written immediately so a parent sees the
   * effect of their own click, but the vendor's webhook remains authoritative
   * for anything involving money.
   */
  cancel(externalSubscriptionId: string, options: { atPeriodEnd: boolean }): Promise<void>;

  /** Reverses a pending cancellation, where the rail supports it. */
  resume(externalSubscriptionId: string): Promise<void>;

  /**
   * Verifies the signature and returns the parsed event, or throws.
   *
   * MUST verify before parsing, never after. An unverified webhook endpoint is
   * a free-subscription vulnerability and is the single most common flaw in
   * payment integrations.
   *
   * Takes the RAW bytes. A body that has been through a JSON parser and
   * re-serialised no longer hashes to the signature the vendor computed, and
   * "we verify signatures" quietly becomes "we verify our own re-encoding".
   */
  verifyAndParseWebhook(
    rawBody: Uint8Array,
    headers: Readonly<Record<string, string | undefined>>,
  ): Promise<VerifiedWebhookEvent>;
}

/* -------------------------------------------------------------------------- */
/* Entitlement                                                                 */
/* -------------------------------------------------------------------------- */

export const SUBSCRIPTION_STATUSES = [
  'free',
  'trialing',
  'active',
  'grace',
  'past_due',
  'cancelled',
  'expired',
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

/**
 * The states in which a child may still talk.
 *
 * `cancelled` is in the list, and that is not a mistake: a parent who cancels
 * has bought the rest of the period and keeps it. What removes access is the
 * period ending, which turns the status into `expired` — so this list is only
 * meaningful applied to a status that has already been through
 * `effectiveStatus` (or `app.subscription_state` in SQL).
 */
export const ENTITLED_STATUSES: readonly SubscriptionStatus[] = Object.freeze([
  'trialing',
  'active',
  'grace',
  'past_due',
  'cancelled',
]);

export interface Entitlement {
  readonly subscriptionId?: SubscriptionId;
  readonly status: SubscriptionStatus;
  readonly planCode: string;
  readonly dailyMinuteAllowance: number;
  readonly childProfileLimit: number;
  readonly validUntil?: IsoTimestamp;
}

export interface EntitlementResolver {
  /**
   * Resolved from our own state, never by calling a payment vendor
   * synchronously. A webhook outage must not stop a paying child from talking.
   */
  resolve(parentId: ParentId): Promise<Entitlement>;
}
