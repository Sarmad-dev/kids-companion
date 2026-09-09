import { createUnverifiedLiveRail } from './jazzcash.js';
import { createSandboxRail } from './sandbox.js';
import {
  NOTHING_VERIFIED,
  type PaymentInitiation,
  type PaymentRailAdapter,
  type RailCapabilities,
  type RailVerification,
} from './types.js';

/**
 * Card payments.
 *
 * International customers, and the minority of the launch market that has a
 * card. The processor is configuration, not code: Stripe internationally, a
 * local acquirer for domestic cards if one is chosen.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THIS ADAPTER CANNOT ACCEPT A CARD NUMBER. THERE IS NO PARAMETER FOR ONE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `PaymentInitiation` carries an `instrumentToken` — an opaque reference the
 * processor issued after collecting the card itself, in its own iframe or SDK,
 * on the customer's device. The card details never touch this application, this
 * network, or these logs.
 *
 * That is not a preference. Handling a PAN would put every server this code
 * runs on into PCI DSS scope, and the architecture is built to stay out of it:
 * no column in the schema can hold a card number, `redactPayload` strips
 * anything card-shaped before storage, and `assertNoCardData` below refuses an
 * initiation that looks like it is carrying one.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE LIVE ADAPTER IS NOT IMPLEMENTED.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Even for a well-documented processor, the wire format here is unverified:
 * which product (payment intents, charges, checkout sessions), which API
 * version, and what the webhook payload actually contains are decisions nobody
 * has made or checked. The Stripe adapter is the least uncertain of the four
 * and is still not written from memory.
 */

export interface CardConfig {
  /** Which processor. Their names and semantics differ; this is not cosmetic. */
  readonly processor: string;
  readonly secretKey: string;
  readonly webhookSecret: string;
  readonly mode: 'sandbox' | 'live';
  readonly sandboxCallbackSecret: string;
  readonly now: () => Date;
}

/**
 * Cards are the most capable rail, and the assumptions still are not facts.
 *
 * Unlike the wallets, the optimistic values here are the ones the industry
 * standardised on decades ago — refunds, partial refunds, voids before capture,
 * and network tokenised repeat billing all genuinely exist. They remain
 * unverified for THIS processor, at THIS API version, on THIS account, because
 * that is what determines whether they are enabled for us.
 */
export const CARD_ASSUMED_CAPABILITIES: RailCapabilities = Object.freeze({
  recurring: 'native',
  refunds: 'full_and_partial',
  cancellation: true,
  statusQuery: true,
  webhooks: true,
  // Multi-currency, unlike the domestic rails. The plan catalogue is PKR today;
  // a card customer abroad is a pricing question, not an adapter one.
  currencies: Object.freeze(['PKR', 'USD']),
  minAmountMinor: undefined,
  maxAmountMinor: undefined,
});

export const CARD_VERIFICATION: RailVerification = Object.freeze({
  checklist: NOTHING_VERIFIED,
  source: "the chosen processor's official API documentation and test mode",
  notes: Object.freeze([
    'No processor selected. Stripe internationally is the likely choice; a domestic acquirer for PKR cards is open.',
    'Card details are collected by the processor on the device. This application never receives a PAN and has nowhere to put one.',
    'Which API product is used — intents, charges, or hosted checkout — changes the state machine, not only the request shape.',
    'Strong customer authentication adds a step that can leave a payment pending for minutes; the pending path must be real, not an edge case.',
    'Domestic card acceptance rates in the launch market are worth measuring before relying on this rail.',
  ]),
});

/**
 * Refuses an initiation carrying anything card-shaped.
 *
 * A defence against our own future code, not against an attacker. The day
 * someone wires a form field through to `payerHandle` "just to debug", this is
 * what stops a PAN reaching a log line — and it fails the request loudly rather
 * than redacting quietly, because the caller is the bug.
 */
export const assertNoCardData = (request: PaymentInitiation): void => {
  const candidates = [request.payerHandle, request.instrumentToken, request.description];

  for (const value of candidates) {
    if (value === undefined) continue;
    const digits = value.replace(/[\s-]/g, '');
    if (/^\d{13,19}$/.test(digits)) {
      throw new Error(
        'A card-shaped value reached the payment adapter. Card details must be ' +
          'collected by the processor on the device and passed as a token.',
      );
    }
  }
};

export const createCardRail = (config: CardConfig): PaymentRailAdapter => {
  const base =
    config.mode === 'sandbox'
      ? createSandboxRail({
          rail: 'card',
          capabilities: CARD_ASSUMED_CAPABILITIES,
          verification: CARD_VERIFICATION,
          callbackSecret: config.sandboxCallbackSecret,
          now: config.now,
        })
      : createUnverifiedLiveRail('card', CARD_ASSUMED_CAPABILITIES, CARD_VERIFICATION);

  // The card check wraps both modes. Sandbox is where a developer would first
  // paste a test card number into the wrong field, which is exactly when it
  // should fail.
  return {
    ...base,
    initiate: (request) => {
      // A REJECTION, not a throw. `initiate` returns a Promise, and a
      // synchronous throw escapes it entirely — a caller's `.catch()`
      // never runs, and what should be a 400 becomes an unhandled exception.
      try {
        assertNoCardData(request);
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
      return base.initiate(request);
    },
  };
};
