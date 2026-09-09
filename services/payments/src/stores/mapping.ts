import type { SubscriptionStatus } from '../ports.js';

import { isEntitlingStoreState, type StorePurchaseState, type VerifiedPurchase } from './types.js';

/**
 * Store state → our subscription state.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * PURE, AND THE ONLY PLACE THE TRANSLATION HAPPENS.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Both stores run their own billing lifecycle, and we mirror it. This function
 * is the mirror. Doing the translation inline at each call site is how a
 * `grace_period` ends up entitling in one code path and not in another — and
 * the family who notices is the one whose card expired.
 *
 * The mapping is not one-to-one, and the places where it is not are the ones
 * worth reading:
 *
 *   `on_hold` → `expired`. Google's account hold means the store has given up
 *   retrying for now and access should stop. It is recoverable — the subscriber
 *   can fix their payment method and the store resumes — so the row stays and
 *   the next notification revives it. But while it lasts, no entitlement.
 *
 *   `paused` → `expired`. A paused subscription is one the subscriber asked to
 *   stop. Treating it as entitled would give away service somebody explicitly
 *   declined to pay for; treating it as cancelled would be wrong in the other
 *   direction, because it comes back.
 *
 *   `cancelled` → `cancelled`, which still entitles until the period ends. The
 *   subscriber paid for the month. This matches how our own rails behave.
 *
 *   `refunded` → `expired` immediately. Money went back, so entitlement goes
 *   with it — not at period end.
 */
export const toSubscriptionStatus = (state: StorePurchaseState): SubscriptionStatus => {
  switch (state) {
    case 'active':
      return 'active';
    case 'trial':
      return 'trialing';
    case 'grace_period':
      return 'grace';
    case 'cancelled':
      return 'cancelled';
    case 'on_hold':
    case 'paused':
    case 'expired':
    case 'refunded':
    case 'invalid':
      return 'expired';
  }
};

/**
 * Whether the family gets what they paid for, given the store's answer AND the
 * clock.
 *
 * The clock matters because a store's `expiresAt` passes whether or not a
 * notification arrives to say so. Both stores are reliable about eventually
 * telling us; neither is reliable about telling us promptly. Between the expiry
 * and the notification lies a window, and this is what stops it being free
 * service.
 */
export const isStoreEntitled = (purchase: VerifiedPurchase, nowIso: string): boolean => {
  if (!isEntitlingStoreState(purchase.state)) return false;

  const now = new Date(nowIso).getTime();

  // A grace period runs to its own deadline, which outlives the paid period —
  // that is the entire point of it.
  if (purchase.state === 'grace_period') {
    if (purchase.gracePeriodEndsAt === undefined) return true;
    return new Date(purchase.gracePeriodEndsAt).getTime() > now;
  }

  if (purchase.expiresAt === undefined) return true;
  return new Date(purchase.expiresAt).getTime() > now;
};

/**
 * Whether a newly verified purchase should replace what we already hold.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ORDERING BY THE STORE'S CLOCK, NOT OURS.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Store notifications arrive out of order — routinely, not exceptionally. A
 * delayed `DID_RENEW` landing after an `EXPIRED` would, applied naively,
 * resurrect a dead subscription; a delayed `EXPIRED` landing after a renewal
 * would kill a live one.
 *
 * `verifiedAt` is when the STORE produced the answer. Comparing on it means a
 * late arrival is recognised as stale rather than newest.
 */
export const isFresherThan = (
  candidate: VerifiedPurchase,
  existing: { verifiedAt?: string | undefined } | undefined,
): boolean => {
  if (existing?.verifiedAt === undefined) return true;

  const a = new Date(candidate.verifiedAt).getTime();
  const b = new Date(existing.verifiedAt).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return false;

  // Strictly newer. An equal timestamp is the same answer arriving twice.
  return a > b;
};

/**
 * Whether a store environment may be honoured in this deployment.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * A SANDBOX PURCHASE ACCEPTED IN PRODUCTION IS A FREE SUBSCRIPTION FOR ANYONE
 * WITH A TEST ACCOUNT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Both stores make this easy to get wrong: a sandbox receipt and a production
 * receipt look alike, and the usual advice is to try one endpoint and fall back
 * to the other. That fallback, pointed the wrong way, is the vulnerability.
 *
 * Production accepts production only. A development deployment accepts sandbox,
 * because that is the only thing it can get.
 */
export const environmentAllowed = (
  purchaseEnvironment: 'sandbox' | 'production',
  deploymentEnvironment: 'sandbox' | 'production',
): boolean => (deploymentEnvironment === 'sandbox' ? true : purchaseEnvironment === 'production');
