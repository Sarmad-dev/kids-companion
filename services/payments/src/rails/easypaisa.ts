import { createUnverifiedLiveRail } from './jazzcash.js';
import { createSandboxRail } from './sandbox.js';
import {
  NOTHING_VERIFIED,
  type PaymentRailAdapter,
  type RailCapabilities,
  type RailVerification,
} from './types.js';

/**
 * Easypaisa.
 *
 * The other wallet the launch market uses. Structurally the same problem as
 * JazzCash and a different vendor, which is exactly why both sit behind one
 * adapter interface rather than being special-cased at the call site.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE LIVE ADAPTER IS NOT IMPLEMENTED.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * No endpoint, field name, or hash construction appears here. None has been
 * read from Easypaisa's own merchant documentation, and the temptation to
 * assume it resembles JazzCash is precisely the mistake worth avoiding: two
 * wallets in one market, built by different companies, share a customer base
 * and nothing else.
 */

export interface EasypaisaConfig {
  readonly storeId: string;
  /** Used to sign requests and verify callbacks. The construction is unverified. */
  readonly hashKey: string;
  readonly mode: 'sandbox' | 'live';
  /** The sandbox's callback signing key. Not an Easypaisa value. */
  readonly sandboxCallbackSecret: string;
  readonly now: () => Date;
}

/**
 * Conservative assumptions, same reasoning as JazzCash.
 *
 * Set independently rather than shared, because "these two wallets behave the
 * same" is an assumption nobody has checked, and a shared constant would make
 * it invisible the moment one of them is verified and the other is not.
 */
export const EASYPAISA_ASSUMED_CAPABILITIES: RailCapabilities = Object.freeze({
  recurring: 'none',
  refunds: 'none',
  cancellation: false,
  statusQuery: true,
  webhooks: true,
  currencies: Object.freeze(['PKR']),
  minAmountMinor: undefined,
  maxAmountMinor: undefined,
});

export const EASYPAISA_VERIFICATION: RailVerification = Object.freeze({
  checklist: NOTHING_VERIFIED,
  source: "Easypaisa's official merchant integration documentation and sandbox",
  notes: Object.freeze([
    'Capabilities above are conservative assumptions, not observed behaviour.',
    'Do not assume parity with JazzCash. Different company, different protocol, possibly different limits.',
    'Whether the customer completes in an app, by SMS confirmation, or on a hosted page changes the product flow, not just the adapter.',
    'Settlement timing affects reconciliation.',
  ]),
});

export const createEasypaisaRail = (config: EasypaisaConfig): PaymentRailAdapter => {
  if (config.mode === 'sandbox') {
    return createSandboxRail({
      rail: 'easypaisa',
      capabilities: EASYPAISA_ASSUMED_CAPABILITIES,
      verification: EASYPAISA_VERIFICATION,
      callbackSecret: config.sandboxCallbackSecret,
      now: config.now,
    });
  }

  return createUnverifiedLiveRail(
    'easypaisa',
    EASYPAISA_ASSUMED_CAPABILITIES,
    EASYPAISA_VERIFICATION,
  );
};
