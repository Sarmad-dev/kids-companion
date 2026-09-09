import type { IsoTimestamp } from '@kids/types';

import type { Money, PaymentRail } from '../ports.js';

/**
 * Payment rails.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * A PAYMENT IS NOT A SUBSCRIPTION. THIS FILE IS ABOUT PAYMENTS.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `SubscriptionProvider` (in ../ports.ts) answers "what is this family entitled
 * to?". A `PaymentRailAdapter` answers "did money move?". They are deliberately
 * different interfaces over different state, because in the launch market they
 * genuinely come apart:
 *
 *   * A wallet payment can succeed while the subscription is untouched — a
 *     top-up, a retry of a charge we already credited, a duplicate the customer
 *     made by tapping twice.
 *   * A subscription can sit in grace for a week while three payments fail.
 *   * Carrier billing may not support recurring at all, so one subscription
 *     period is one fresh payment, authorised again each time.
 *
 * Collapsing the two is how "the payment succeeded but the child still cannot
 * talk" becomes unreproducible: there is one status field, and it is wrong.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * NOTHING HERE ENCODES A REAL VENDOR'S WIRE FORMAT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * No endpoint URL, no field name, no signature recipe for JazzCash, Easypaisa,
 * a carrier aggregator, or a card acquirer appears anywhere in this package.
 * Those come from each provider's official documentation and sandbox, and none
 * of them has been verified. Guessing them would produce code that looks
 * finished, passes review, and fails on the first real transaction — with money
 * involved.
 *
 * What ships is the SHAPE: an adapter interface, a capability declaration, a
 * failure taxonomy, and a working sandbox for each rail. Filling in a live
 * implementation is a bounded task with a checklist (`VerificationChecklist`),
 * and `PAYMENTS_VERIFIED_RAILS` refuses to let an unverified rail run in a
 * deployed environment.
 */

/* -------------------------------------------------------------------------- */
/* What a rail can actually do                                                 */
/* -------------------------------------------------------------------------- */

/**
 * How a rail supports repeat billing.
 *
 *   native     — the rail bills on a schedule and tells us. Cards via a
 *                processor, and app-store billing, work this way.
 *   tokenised  — the rail gives us a reusable token and we initiate each
 *                charge. Common for wallets.
 *   none       — every period needs the customer to authorise again. Typical of
 *                carrier billing, and it changes the product: a subscription on
 *                such a rail is a series of renewal prompts, not a standing
 *                arrangement.
 *
 * This is not a detail. A rail with `none` cannot silently renew, so the
 * subscription layer must ask — and a product that assumed otherwise would
 * quietly stop billing.
 */
export const RECURRING_SUPPORT = ['native', 'tokenised', 'none'] as const;
export type RecurringSupport = (typeof RECURRING_SUPPORT)[number];

export const REFUND_SUPPORT = ['full_and_partial', 'full_only', 'none'] as const;
export type RefundSupport = (typeof REFUND_SUPPORT)[number];

export interface RailCapabilities {
  readonly recurring: RecurringSupport;
  readonly refunds: RefundSupport;
  /** Whether an authorised-but-uncaptured payment can be voided before capture. */
  readonly cancellation: boolean;
  /** Whether the rail can be asked for the authoritative status of one payment. */
  readonly statusQuery: boolean;
  /** Whether the rail delivers asynchronous callbacks at all. */
  readonly webhooks: boolean;
  /** Currencies the rail settles in. Pakistani rails are PKR-only. */
  readonly currencies: readonly string[];
  /**
   * The smallest and largest single payment, in minor units.
   *
   * Wallets and carrier billing both impose these, and they are low — a yearly
   * plan may simply not be payable on some rails. `undefined` means the limit
   * is not known yet, which is different from "no limit".
   */
  readonly minAmountMinor?: number | undefined;
  readonly maxAmountMinor?: number | undefined;
}

/* -------------------------------------------------------------------------- */
/* Verification                                                                */
/* -------------------------------------------------------------------------- */

/**
 * What has to be confirmed against a provider's own documentation and sandbox
 * before its adapter may be called production-ready.
 *
 * Every item here is something that CANNOT be inferred, guessed, or copied from
 * another rail. Each one, wrong, is a class of silent failure:
 *
 *   * a wrong signature recipe → every webhook rejected, or worse, every
 *     webhook accepted,
 *   * a wrong amount unit → a bill 100× too large,
 *   * a missing status mapping → a paid customer treated as unpaid.
 */
export interface VerificationChecklist {
  /** Sandbox and production base URLs, from the provider's documentation. */
  readonly endpoints: boolean;
  /** Request and response field names, types, and required/optional-ness. */
  readonly requestSchema: boolean;
  /** The exact signature or hash construction, including field order. */
  readonly signatureScheme: boolean;
  /** Amount unit — minor units or major, and the rounding rule. */
  readonly amountUnits: boolean;
  /** Every status code the rail can return, mapped to our payment states. */
  readonly statusCodes: boolean;
  /** Callback delivery: retries, ordering, duplicate behaviour, timeouts. */
  readonly callbackSemantics: boolean;
  /** Whether refunds exist, their window, and whether partial is allowed. */
  readonly refundSemantics: boolean;
  /** Observed sandbox behaviour, not just documented behaviour. */
  readonly sandboxTested: boolean;
}

export const NOTHING_VERIFIED: VerificationChecklist = Object.freeze({
  endpoints: false,
  requestSchema: false,
  signatureScheme: false,
  amountUnits: false,
  statusCodes: false,
  callbackSemantics: false,
  refundSemantics: false,
  sandboxTested: false,
});

export interface RailVerification {
  readonly checklist: VerificationChecklist;
  /** Where the answers come from. A name, not a URL we have not opened. */
  readonly source: string;
  /** Anything known about the rail that shapes the integration. */
  readonly notes: readonly string[];
}

/** Every box ticked. Nothing else counts as verified. */
export const isFullyVerified = (verification: RailVerification): boolean =>
  Object.values(verification.checklist).every((value) => value === true);

/** The unticked boxes, for an error message a person can act on. */
export const outstandingChecks = (verification: RailVerification): readonly string[] =>
  Object.entries(verification.checklist)
    .filter(([, done]) => !done)
    .map(([name]) => name);

/**
 * Thrown when a live adapter is asked to do something it cannot honestly do.
 *
 * NOT a placeholder that returns success. A stub that pretends to work is worse
 * than one that refuses: it produces a subscription nobody paid for, and the
 * discovery happens during reconciliation weeks later.
 */
export class RailNotVerifiedError extends Error {
  override readonly name = 'RailNotVerifiedError';
  readonly rail: PaymentRail;
  readonly outstanding: readonly string[];

  constructor(rail: PaymentRail, outstanding: readonly string[], source: string) {
    super(
      `The ${rail} live adapter is not implemented. Its wire format has not been ` +
        `verified against ${source}; outstanding: ${outstanding.join(', ')}. ` +
        `Run this rail in sandbox mode, or complete the integration — do not guess.`,
    );
    this.rail = rail;
    this.outstanding = outstanding;
  }
}

/** Thrown when a rail is asked for something its capabilities exclude. */
export class RailCapabilityError extends Error {
  override readonly name = 'RailCapabilityError';
  readonly rail: PaymentRail;
  readonly capability: string;

  constructor(rail: PaymentRail, capability: string) {
    super(`The ${rail} rail does not support ${capability}.`);
    this.rail = rail;
    this.capability = capability;
  }
}

/* -------------------------------------------------------------------------- */
/* Payment state — separate from subscription state                            */
/* -------------------------------------------------------------------------- */

/**
 * Where one attempt to collect money has got to.
 *
 * Note what is absent: nothing here says "active", "cancelled", or "expired".
 * Those are subscription words. A payment is initiated, it is pending, and then
 * it either captured or it did not.
 */
export const PAYMENT_STATUSES = [
  /** We have created our record; the customer has not acted. */
  'initiated',
  /** Handed to the rail; waiting for the customer or the rail. */
  'pending',
  /** Funds reserved, not yet taken. Only some rails distinguish this. */
  'authorized',
  /** Money has moved. */
  'captured',
  /** It will not succeed. `failureCode` says why. */
  'failed',
  /** The customer or we abandoned it before capture. */
  'cancelled',
  /** Captured, then given back — in full or in part. */
  'refunded',
  /**
   * The rail's answer is unknown and our own record is stale.
   *
   * A real state, not an error: a wallet callback that never arrived leaves a
   * payment neither succeeded nor failed, and pretending otherwise is how a
   * customer gets charged without being credited.
   */
  'unresolved',
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/** States from which no further transition happens without a refund. */
export const TERMINAL_PAYMENT_STATUSES: readonly PaymentStatus[] = Object.freeze([
  'captured',
  'failed',
  'cancelled',
  'refunded',
]);

export const isTerminalPayment = (status: PaymentStatus): boolean =>
  TERMINAL_PAYMENT_STATUSES.includes(status);

/* -------------------------------------------------------------------------- */
/* Failures                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Why a payment did not succeed, in OUR vocabulary.
 *
 * Every rail has its own codes, and they are neither compatible nor stable.
 * Mapping them here means the retry policy, the dunning schedule, and what a
 * parent is told are decided once rather than per rail.
 *
 * The retryable/terminal split is the part that matters. Retrying an
 * `insufficient_funds` in ten seconds annoys a customer; retrying a
 * `rail_unavailable` in ten seconds is exactly right.
 */
export const PAYMENT_FAILURE_CODES = [
  /* Terminal — retrying will not help. */
  'declined',
  'insufficient_funds',
  'instrument_expired',
  'instrument_invalid',
  'limit_exceeded',
  'not_supported',
  'customer_cancelled',
  'fraud_suspected',
  /* Transient — a retry is reasonable. */
  'rail_unavailable',
  'rail_timeout',
  'network_error',
  'rate_limited',
  /* Ours. */
  'configuration_error',
  /* Unmapped: the rail said something we do not recognise. */
  'unknown',
] as const;
export type PaymentFailureCode = (typeof PAYMENT_FAILURE_CODES)[number];

const RETRYABLE: readonly PaymentFailureCode[] = Object.freeze([
  'rail_unavailable',
  'rail_timeout',
  'network_error',
  'rate_limited',
]);

/**
 * Whether retrying this failure could plausibly succeed.
 *
 * `unknown` is deliberately NOT retryable. An unrecognised code from a rail
 * might mean "try again" or might mean "you have already been charged", and
 * retrying on a guess risks double-charging a family. It goes to
 * reconciliation, which asks the rail rather than guessing.
 */
export const isRetryableFailure = (code: PaymentFailureCode): boolean => RETRYABLE.includes(code);

/**
 * What a parent is told.
 *
 * Never the rail's own message. Vendor strings are written for merchants,
 * change without notice, and occasionally leak internals — and "DECLINE_51" is
 * not something anyone can act on.
 */
export const failureMessage = (code: PaymentFailureCode): string => {
  switch (code) {
    case 'insufficient_funds':
      return 'There were not enough funds available. Please top up or use a different method.';
    case 'instrument_expired':
      return 'That payment method has expired. Please use a different one.';
    case 'instrument_invalid':
      return 'Those payment details were not accepted. Please check them and try again.';
    case 'limit_exceeded':
      return 'This payment is above the limit for this method. Please use a different one.';
    case 'not_supported':
      return 'That payment method cannot be used for this plan.';
    case 'customer_cancelled':
      return 'The payment was cancelled. Nothing has been charged.';
    case 'declined':
    case 'fraud_suspected':
      // Deliberately identical to a plain decline. Telling someone their
      // payment tripped a fraud rule tells a card tester the same thing.
      return 'That payment was declined. Please try a different method or contact your provider.';
    case 'rail_unavailable':
    case 'rail_timeout':
    case 'network_error':
    case 'rate_limited':
      return 'We could not reach the payment service. Nothing has been charged — please try again shortly.';
    case 'configuration_error':
    case 'unknown':
      return 'Something went wrong with the payment. Nothing has been charged — please try again.';
  }
};

export class PaymentFailedError extends Error {
  override readonly name = 'PaymentFailedError';
  readonly code: PaymentFailureCode;
  readonly rail: PaymentRail;
  /** The rail's own code, for the log and reconciliation. Never shown to a parent. */
  readonly railCode: string | undefined;

  constructor(rail: PaymentRail, code: PaymentFailureCode, railCode?: string) {
    super(`${rail} payment failed: ${code}`);
    this.rail = rail;
    this.code = code;
    this.railCode = railCode;
  }
}

/* -------------------------------------------------------------------------- */
/* The adapter                                                                 */
/* -------------------------------------------------------------------------- */

export interface PaymentInitiation {
  /** Our payment id. Travels to the rail so its callback can be tied back. */
  readonly reference: string;
  readonly amount: Money;
  /** Required. A retry must not become a second charge. */
  readonly idempotencyKey: string;
  /**
   * How to reach the payer on this rail — a wallet mobile number, an MSISDN for
   * carrier billing, a processor token for cards.
   *
   * Opaque here on purpose: this package neither validates nor stores it, and
   * a card NUMBER can never appear in it because the card adapter takes a
   * processor token instead (see card.ts).
   */
  readonly payerHandle?: string | undefined;
  /** Where the rail should send the customer back, for redirect-style flows. */
  readonly returnUrl?: string | undefined;
  /** A stored instrument token, for a repeat charge on a tokenised rail. */
  readonly instrumentToken?: string | undefined;
  readonly description: string;
}

export interface PaymentResult {
  readonly rail: PaymentRail;
  readonly status: PaymentStatus;
  /** The rail's identifier for this payment, once it has one. */
  readonly railReference?: string | undefined;
  /** Where to send the customer, for rails that complete out of band. */
  readonly redirectUrl?: string | undefined;
  /** Present when the status is `failed`. */
  readonly failureCode?: PaymentFailureCode | undefined;
  readonly railFailureCode?: string | undefined;
  /** A reusable token, where the rail issued one and the customer consented. */
  readonly instrumentToken?: string | undefined;
  /** Brand and last four. There is no field here for anything longer. */
  readonly instrument?:
    { readonly brand?: string | undefined; readonly last4?: string | undefined } | undefined;
  readonly occurredAt: IsoTimestamp;
}

export interface RefundRequest {
  readonly railReference: string;
  /** Omitted means the whole payment. Only meaningful on a rail that allows partial. */
  readonly amount?: Money | undefined;
  readonly idempotencyKey: string;
  readonly reason: string;
}

export interface RefundResult {
  readonly rail: PaymentRail;
  readonly status: 'succeeded' | 'pending' | 'failed';
  readonly railReference?: string | undefined;
  readonly amount: Money;
  readonly failureCode?: PaymentFailureCode | undefined;
  readonly occurredAt: IsoTimestamp;
}

/**
 * One payment rail.
 *
 * Every method may throw `RailNotVerifiedError` (the live wire format is not
 * confirmed), `RailCapabilityError` (the rail cannot do this at all), or
 * `PaymentFailedError`. None of them ever returns a success it has not
 * observed.
 */
export interface PaymentRailAdapter {
  readonly rail: PaymentRail;
  readonly capabilities: RailCapabilities;
  readonly verification: RailVerification;
  /** `sandbox` is fully functional locally; `live` requires verification. */
  readonly mode: 'sandbox' | 'live';

  /** Starts a payment. Returns where it got to, never an assumed success. */
  initiate(request: PaymentInitiation): Promise<PaymentResult>;

  /**
   * Asks the rail what actually happened.
   *
   * The heart of reconciliation. A callback that never arrived, a timeout
   * mid-request, a process that died between charging and recording — all of
   * them end here, asking the only party that knows.
   */
  queryStatus(railReference: string): Promise<PaymentResult>;

  /** Voids an authorised payment before capture, where the rail allows it. */
  cancel(railReference: string): Promise<PaymentResult>;

  /** Returns money, where the rail allows it. */
  refund(request: RefundRequest): Promise<RefundResult>;

  /**
   * Verifies a callback and returns what it says about ONE payment.
   *
   * Takes raw bytes for the same reason the subscription webhook does: a body
   * that has been parsed and re-serialised no longer matches the signature the
   * rail computed.
   */
  verifyCallback(
    rawBody: Uint8Array,
    headers: Readonly<Record<string, string | undefined>>,
  ): Promise<PaymentCallback>;
}

export interface PaymentCallback {
  readonly rail: PaymentRail;
  /** The rail's event id, if it sends one. Falls back to its payment reference. */
  readonly externalEventId: string;
  /** OUR payment reference, echoed back. */
  readonly reference: string;
  readonly result: PaymentResult;
  readonly payload: Readonly<Record<string, unknown>>;
}
