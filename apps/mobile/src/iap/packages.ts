/**
 * Our plan codes → RevenueCat package keys.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * NO STORE SKU LIVES ON THIS DEVICE. THAT IS THE POINT OF ROUTING THROUGH
 * REVENUECAT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Before RevenueCat, this file held the raw App Store / Play Store product
 * identifiers, and getting one wrong meant a purchase Apple or Google happily
 * took money for that our own server could never recognise. RevenueCat's
 * dashboard is now the one place that maps a package to a real store SKU per
 * platform — see docs/REVENUECAT.md §2 — so all this file needs is which of
 * RevenueCat's own predefined package slots (`monthly`, `annual`, …) our plan
 * lives in, which `PurchasesOffering` exposes as a direct property.
 */
export type StorePlanCode = 'family_monthly' | 'family_annual';

/** A `PurchasesOffering`'s own predefined package accessors. */
export type StorePackageKey = 'monthly' | 'annual';

const PACKAGE_KEYS: Readonly<Record<StorePlanCode, StorePackageKey>> = {
  family_monthly: 'monthly',
  family_annual: 'annual',
};

export const isStorePlanCode = (code: string): code is StorePlanCode =>
  Object.prototype.hasOwnProperty.call(PACKAGE_KEYS, code);

export const packageKeyFor = (planCode: string): StorePackageKey | undefined =>
  isStorePlanCode(planCode) ? PACKAGE_KEYS[planCode] : undefined;
