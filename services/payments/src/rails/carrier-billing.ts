import { createUnverifiedLiveRail } from './jazzcash.js';
import { createSandboxRail } from './sandbox.js';
import {
  NOTHING_VERIFIED,
  type PaymentRailAdapter,
  type RailCapabilities,
  type RailVerification,
} from './types.js';

/**
 * Carrier billing.
 *
 * The charge lands on a mobile phone bill or comes out of prepaid balance. In a
 * market where a great many people have a phone and no card, it reaches
 * customers nothing else reaches.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * IT IS ALSO THE RAIL WITH THE MOST PRODUCT CONSEQUENCES, AND THEY ARE NOT
 * TECHNICAL ONES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Three of them matter enough to state here rather than discover later:
 *
 * **Refunds usually do not exist.** Money that has come off a prepaid balance
 * is generally not returnable through the same channel. A product that offers a
 * refund button on this rail is promising something it cannot deliver, so
 * `refunds: 'none'` is not a placeholder — it is the expected end state, and
 * the subscription layer must not offer what it cannot honour.
 *
 * **Whoever holds the phone can spend money.** That is the entire mechanism. In
 * a product used by children, on a family's phone, this is a child-safety
 * consideration and not merely a billing one: the parental gate in front of any
 * purchase matters more on this rail than on any other, and "my seven-year-old
 * bought a year's subscription" is a foreseeable outcome rather than an edge
 * case.
 *
 * **Revenue share is heavy** — materially worse than card processing, and it
 * may make some plans uneconomic here. That is a pricing decision, and it
 * belongs with Q-02.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE LIVE ADAPTER IS NOT IMPLEMENTED.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Carrier billing is normally reached through an aggregator rather than
 * directly, and which aggregator has not been chosen. No endpoint or protocol
 * appears here, and the configuration below is deliberately aggregator-shaped
 * rather than carrier-shaped.
 */

export interface CarrierBillingConfig {
  /** Which aggregator. Unset until one is chosen — see the notes below. */
  readonly aggregator: string;
  readonly merchantId: string;
  readonly apiKey: string;
  /** Used to verify callbacks. The construction is unverified. */
  readonly callbackSecret: string;
  readonly mode: 'sandbox' | 'live';
  readonly sandboxCallbackSecret: string;
  readonly now: () => Date;
}

/**
 * Assumptions, and one near-certainty.
 *
 * `refunds: 'none'` and `recurring: 'none'` are how this rail generally works,
 * not merely the safe default — but they are still marked unverified, because
 * "generally" is not a specification and aggregators differ.
 */
export const CARRIER_BILLING_ASSUMED_CAPABILITIES: RailCapabilities = Object.freeze({
  recurring: 'none',
  refunds: 'none',
  cancellation: false,
  statusQuery: true,
  webhooks: true,
  currencies: Object.freeze(['PKR']),
  minAmountMinor: undefined,
  maxAmountMinor: undefined,
});

export const CARRIER_BILLING_VERIFICATION: RailVerification = Object.freeze({
  checklist: NOTHING_VERIFIED,
  source: "the chosen aggregator's documentation and sandbox — no aggregator selected yet",
  notes: Object.freeze([
    'No aggregator has been chosen. Everything below depends on which one.',
    'Refunds are expected to be impossible on this rail. Do not surface a refund action for it.',
    'Anyone holding the phone can authorise a charge. The parental gate in front of purchase is doing real work here.',
    'Per-transaction ceilings are typically low and may make longer plans unpayable.',
    'Revenue share is materially worse than card processing and may make some plans uneconomic.',
    'Double-charge risk on retry is higher than other rails; idempotency behaviour must be observed, not assumed.',
  ]),
});

export const createCarrierBillingRail = (config: CarrierBillingConfig): PaymentRailAdapter => {
  if (config.mode === 'sandbox') {
    return createSandboxRail({
      rail: 'carrier_billing',
      capabilities: CARRIER_BILLING_ASSUMED_CAPABILITIES,
      verification: CARRIER_BILLING_VERIFICATION,
      callbackSecret: config.sandboxCallbackSecret,
      now: config.now,
    });
  }

  return createUnverifiedLiveRail(
    'carrier_billing',
    CARRIER_BILLING_ASSUMED_CAPABILITIES,
    CARRIER_BILLING_VERIFICATION,
  );
};
