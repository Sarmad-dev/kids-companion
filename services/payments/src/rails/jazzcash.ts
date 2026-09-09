import { createSandboxRail } from './sandbox.js';
import {
  NOTHING_VERIFIED,
  outstandingChecks,
  RailNotVerifiedError,
  type PaymentRailAdapter,
  type RailCapabilities,
  type RailVerification,
} from './types.js';

/**
 * JazzCash.
 *
 * A Pakistani mobile wallet, and one of the two ways the launch market actually
 * pays. Card penetration is low; this matters more here than Stripe does.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE LIVE ADAPTER IS NOT IMPLEMENTED, AND THAT IS THE HONEST STATE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * No endpoint, field name, or hash construction for JazzCash appears in this
 * file, because none of them has been read from JazzCash's own integration
 * documentation. Writing a plausible one is worse than writing none: it would
 * pass review, pass every test we wrote against our own guess, and fail on the
 * first real transaction — with a family's money involved.
 *
 * What exists here is the shape, a working sandbox, and a checklist. Completing
 * the integration is a bounded task for whoever has merchant credentials and
 * the current documentation in front of them.
 */

/**
 * Configuration.
 *
 * The variable NAMES were fixed when the environment contract was written, and
 * they follow the vocabulary JazzCash's merchant onboarding uses. What each one
 * is used FOR — which are hashed, in what order, into which header or field —
 * is part of the signature scheme, and that is unverified.
 *
 * Every value is empty in `.env.example` and read from the environment. No
 * merchant credential is committed, ever, and `verify:no-secrets` fails the
 * build if one is.
 */
export interface JazzCashConfig {
  readonly merchantId: string;
  readonly password: string;
  /** Used to sign requests and verify callbacks. The construction is unverified. */
  readonly integritySalt: string;
  readonly mode: 'sandbox' | 'live';
  /** The sandbox's callback signing key. Not a JazzCash value. */
  readonly sandboxCallbackSecret: string;
  readonly now: () => Date;
}

/**
 * What this rail is assumed to support.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * DELIBERATELY PESSIMISTIC. EVERY FIELD IS AN ASSUMPTION, NOT A FACT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Each one is set to the value that fails safe if wrong:
 *
 *   * `recurring: 'none'` — so the subscription layer prompts for each period
 *     rather than assuming a standing arrangement that may not exist. If the
 *     rail does support tokenised repeat charges, we under-deliver until it is
 *     confirmed, which is the survivable direction.
 *   * `refunds: 'none'` — so no refund button is offered for something that
 *     might not be possible. A promised refund that cannot be made is a support
 *     crisis; an unoffered one that turns out to be possible is a feature.
 *   * amount limits `undefined` — NOT "no limit". Wallets impose per-transaction
 *     ceilings, and a yearly plan may simply be unpayable here. Marking it
 *     unknown keeps the question visible.
 */
export const JAZZCASH_ASSUMED_CAPABILITIES: RailCapabilities = Object.freeze({
  recurring: 'none',
  refunds: 'none',
  cancellation: false,
  statusQuery: true,
  webhooks: true,
  currencies: Object.freeze(['PKR']),
  minAmountMinor: undefined,
  maxAmountMinor: undefined,
});

export const JAZZCASH_VERIFICATION: RailVerification = Object.freeze({
  checklist: NOTHING_VERIFIED,
  source: "JazzCash's official merchant integration documentation and sandbox",
  notes: Object.freeze([
    'Capabilities above are conservative assumptions, not observed behaviour.',
    'Per-transaction and daily wallet ceilings are unknown and may make the yearly plan unpayable on this rail.',
    'Whether repeat charges are possible without re-authorisation decides whether a subscription here renews or re-prompts.',
    'Settlement timing affects reconciliation: a payment may be confirmed to the customer before it settles to us.',
  ]),
});

/**
 * The JazzCash rail.
 *
 * In `sandbox` mode this is a fully working payment rail with the capabilities
 * declared above. In `live` mode every call fails with a message naming what
 * must be verified — it does not silently succeed, and it does not silently
 * fall back to sandbox.
 */
export const createJazzCashRail = (config: JazzCashConfig): PaymentRailAdapter => {
  if (config.mode === 'sandbox') {
    return createSandboxRail({
      rail: 'jazzcash',
      capabilities: JAZZCASH_ASSUMED_CAPABILITIES,
      verification: JAZZCASH_VERIFICATION,
      callbackSecret: config.sandboxCallbackSecret,
      now: config.now,
    });
  }

  return createUnverifiedLiveRail('jazzcash', JAZZCASH_ASSUMED_CAPABILITIES, JAZZCASH_VERIFICATION);
};

/* -------------------------------------------------------------------------- */

/**
 * A live rail that refuses.
 *
 * Shared by all four rails. Every method rejects with the same error naming the
 * outstanding checks, so the failure is loud, immediate, and actionable rather
 * than a wrong amount discovered in reconciliation.
 *
 * The alternative — returning a plausible success — is the single most
 * dangerous thing this package could do.
 */
export const createUnverifiedLiveRail = (
  rail: PaymentRailAdapter['rail'],
  capabilities: RailCapabilities,
  verification: RailVerification,
): PaymentRailAdapter => {
  const refuse = <T>(): Promise<T> =>
    Promise.reject(
      new RailNotVerifiedError(rail, outstandingChecks(verification), verification.source),
    );

  return {
    rail,
    capabilities,
    verification,
    mode: 'live',
    initiate: refuse,
    queryStatus: refuse,
    cancel: refuse,
    refund: refuse,
    verifyCallback: refuse,
  };
};
