/**
 * Mobile store billing.
 *
 * Apple App Store and Google Play, behind one interface. The client sends a
 * token; the server asks the store; the store's answer is the only thing that
 * grants anything. See docs/STORE_BILLING.md.
 */

export {
  ENTITLING_STORE_STATES,
  isEntitlingStoreState,
  isMobileStore,
  MOBILE_STORES,
  PurchaseVerificationError,
  STORE_PURCHASE_STATES,
  StoreNotificationError,
} from './types.js';

export type {
  MobileStore,
  PurchaseReceipt,
  StoreBillingProvider,
  StoreCapabilities,
  StoreNotification,
  StorePurchaseState,
  VerifiedPurchase,
} from './types.js';

export {
  environmentAllowed,
  isFresherThan,
  isStoreEntitled,
  toSubscriptionStatus,
} from './mapping.js';

export {
  capabilitiesFor,
  createMockStoreProvider,
  MOCK_PURCHASE_BEHAVIOURS,
  signStoreNotification,
} from './mock-store.js';
export type { MockBehaviour, MockStoreOptions } from './mock-store.js';

export {
  APPLE_VERIFICATION,
  createAppleStoreProvider,
  createGooglePlayProvider,
  createUnverifiedStoreProvider,
  GOOGLE_VERIFICATION,
} from './adapters.js';
export type { AppleStoreConfig, GooglePlayConfig } from './adapters.js';
