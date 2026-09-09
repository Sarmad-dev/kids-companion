/**
 * @kids/payments — subscription ports, lifecycle, and rail adapters.
 *
 * The shape of this package is the security argument:
 *
 *   ports.ts       the only way to obtain a `VerifiedWebhookEvent` is to verify
 *                  a signature over raw bytes,
 *   lifecycle.ts   the only thing that changes a subscription is a verified
 *                  event, applied by a pure function,
 *   redaction.ts   nothing reaches storage until card-shaped data is gone,
 *   mock-provider  a real signature scheme, so the tests test something.
 *
 * Rail selection remains a business and legal decision blocked on Q-02
 * (app-store billing versus Pakistani local rails). The mock rail is what
 * ships; adding Stripe or JazzCash is one file implementing
 * `SubscriptionProvider`, with no change to the lifecycle or the reconciler.
 */

export type * from './ports.js';
export {
  BILLING_INTERVALS,
  ENTITLED_STATUSES,
  isPaymentRail,
  isWebhookEventType,
  PAYMENT_RAILS,
  SUBSCRIPTION_STATUSES,
  WEBHOOK_EVENT_TYPES,
  WebhookVerificationError,
} from './ports.js';

export {
  advancePeriod,
  applyLifecycleEvent,
  effectiveStatus,
  isEntitled,
  type IgnoredReason,
  type LifecycleInput,
  type LifecycleOutcome,
  type SubscriptionState,
} from './lifecycle.js';

export { lastFour, looksLikeCardNumber, redactPayload, REDACTED } from './redaction.js';

export * from './rails/index.js';
export * from './stores/index.js';

export {
  createMockSubscriptionProvider,
  signMockWebhook,
  type MockProviderOptions,
} from './mock-provider.js';
