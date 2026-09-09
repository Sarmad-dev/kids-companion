/**
 * Payment rails.
 *
 * Four adapters behind one interface: JazzCash, Easypaisa, carrier billing, and
 * cards. Every one of them runs a working sandbox and refuses to run live until
 * its wire format has been verified against the provider's own documentation —
 * see docs/PAYMENT_RAILS.md.
 */

export {
  isFullyVerified,
  isRetryableFailure,
  isTerminalPayment,
  failureMessage,
  NOTHING_VERIFIED,
  outstandingChecks,
  PAYMENT_FAILURE_CODES,
  PAYMENT_STATUSES,
  PaymentFailedError,
  RailCapabilityError,
  RailNotVerifiedError,
  RECURRING_SUPPORT,
  REFUND_SUPPORT,
  TERMINAL_PAYMENT_STATUSES,
} from './types.js';

export type {
  PaymentCallback,
  PaymentFailureCode,
  PaymentInitiation,
  PaymentRailAdapter,
  PaymentResult,
  PaymentStatus,
  RailCapabilities,
  RailVerification,
  RecurringSupport,
  RefundRequest,
  RefundResult,
  RefundSupport,
  VerificationChecklist,
} from './types.js';

export { createSandboxRail, signRailCallback, SANDBOX_BEHAVIOURS } from './sandbox.js';
export type { SandboxRailOptions } from './sandbox.js';

export {
  createJazzCashRail,
  createUnverifiedLiveRail,
  JAZZCASH_ASSUMED_CAPABILITIES,
  JAZZCASH_VERIFICATION,
} from './jazzcash.js';
export type { JazzCashConfig } from './jazzcash.js';

export {
  createEasypaisaRail,
  EASYPAISA_ASSUMED_CAPABILITIES,
  EASYPAISA_VERIFICATION,
} from './easypaisa.js';
export type { EasypaisaConfig } from './easypaisa.js';

export {
  CARRIER_BILLING_ASSUMED_CAPABILITIES,
  CARRIER_BILLING_VERIFICATION,
  createCarrierBillingRail,
} from './carrier-billing.js';
export type { CarrierBillingConfig } from './carrier-billing.js';

export {
  assertNoCardData,
  CARD_ASSUMED_CAPABILITIES,
  CARD_VERIFICATION,
  createCardRail,
} from './card.js';
export type { CardConfig } from './card.js';

export { createRailRegistry, describeRegistry } from './registry.js';
export type { RailRegistry, RailRegistryConfig, RailUnavailableReason } from './registry.js';
