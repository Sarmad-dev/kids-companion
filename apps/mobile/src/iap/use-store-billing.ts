import { useCallback, useRef, useState } from 'react';
import { Platform } from 'react-native';
import Purchases, { PURCHASES_ERROR_CODE, type PurchasesError } from 'react-native-purchases';

import type { ApiClient, ParentProfile } from '../api/client';

import { packageKeyFor } from './packages';

/**
 * Buying a subscription through the App Store or Play Store, via RevenueCat.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE SAME RULE EXTENDS TO REVENUECAT'S OWN LOCAL STATE, NOT JUST THE STORE'S.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `Purchases.purchasePackage` and `Purchases.getCustomerInfo` hand back a
 * `CustomerInfo` this app could read `entitlements.active[...]` from directly
 * — and this hook deliberately never does. That snapshot lives on the device,
 * which is exactly the thing this product's whole store-billing design
 * refuses to trust (apps/api/src/store-billing.ts: "the client sends a
 * token, it never sends a status"). What this hook actually acts on is
 * `/api/store/verify`'s answer: our OWN server asking RevenueCat's server,
 * directly, what this subscriber has.
 *
 * The "token" `/api/store/verify` receives is the RevenueCat `app_user_id` —
 * which this hook sets equal to the signed-in parent's own id via
 * `Purchases.logIn`, so a device can say WHO it is but still cannot say WHAT
 * it has.
 */

/** This device's store, or `undefined` off iOS/Android — the web app pays by card. */
export const currentStoreRail = (): 'apple' | 'google' | undefined => {
  if (Platform.OS === 'ios') return 'apple';
  if (Platform.OS === 'android') return 'google';
  return undefined;
};

/** What the plan catalogue's `availableRails` and `/api/store/verify` call this store. */
export const STORE_NAME: Record<'apple' | 'google', 'apple_iap' | 'google_play'> = {
  apple: 'apple_iap',
  google: 'google_play',
};

interface StoreVerifyResponse {
  readonly entitled: boolean;
  readonly state: string;
  readonly planCode: string | null;
  readonly expiresAt: string | null;
  readonly explanation: string;
}

interface StoreRestoreResponse {
  readonly restored: number;
  readonly entitled: boolean;
  readonly state: string;
  readonly planCode: string | null;
  readonly explanation: string;
}

const isPurchasesError = (value: unknown): value is PurchasesError =>
  typeof value === 'object' && value !== null && 'code' in value && 'message' in value;

const messageFor = (cause: unknown, fallback: string): string =>
  isPurchasesError(cause) ? cause.message : fallback;

export interface StoreBillingState {
  /** Whether this device even has a store to buy from. False on web. */
  readonly available: boolean;
  readonly purchasing: boolean;
  readonly restoring: boolean;
  /** A friendly message for the last failure, if any. Cleared on the next attempt. */
  readonly error: string | undefined;
  /** Buys `planCode` on this platform's store. Resolves once OUR server confirms it, or false. */
  readonly purchase: (planCode: string) => Promise<boolean>;
  /** Re-presents whatever this device's store account already holds. */
  readonly restore: () => Promise<StoreRestoreResponse | undefined>;
}

export const useStoreBilling = (api: ApiClient): StoreBillingState => {
  const rail = currentStoreRail();
  const [purchasing, setPurchasing] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  // Cached for this hook's lifetime, not the app's — `Purchases.logIn` is
  // cheap to repeat and a stale parent id cached across a sign-out/sign-in
  // would correlate the wrong purchase to the wrong family.
  const parentIdRef = useRef<string | undefined>(undefined);

  /**
   * Makes sure RevenueCat knows this subscriber by our own parent id before
   * a purchase or restore touches the store.
   *
   * `Purchases.configure()` runs once, anonymously, at app launch (see
   * `state/app-context.tsx`) — long before this hook can know who is signed
   * in. This is where the two get linked, lazily, at the one moment it
   * actually matters.
   */
  const ensureIdentified = useCallback(async (): Promise<string | undefined> => {
    if (parentIdRef.current !== undefined) return parentIdRef.current;

    const profile = await api.get<ParentProfile>('/v1/parents/me');
    if (!profile.ok || profile.data === undefined) return undefined;

    await Purchases.logIn(profile.data.id);
    parentIdRef.current = profile.data.id;
    return profile.data.id;
  }, [api]);

  const verifyWithServer = useCallback(
    async (parentId: string): Promise<StoreVerifyResponse | undefined> => {
      if (rail === undefined) return undefined;
      const result = await api.post<StoreVerifyResponse>('/api/store/verify', {
        store: STORE_NAME[rail],
        token: parentId,
      });
      return result.ok ? result.data : undefined;
    },
    [api, rail],
  );

  const purchase = useCallback(
    async (planCode: string): Promise<boolean> => {
      setError(undefined);
      if (rail === undefined) {
        setError('Purchases are not available on this device right now.');
        return false;
      }

      const packageKey = packageKeyFor(planCode);
      if (packageKey === undefined) {
        setError('That plan is not sold through the app store on this device.');
        return false;
      }

      setPurchasing(true);
      try {
        const parentId = await ensureIdentified();
        if (parentId === undefined) {
          setError('Could not confirm who is signed in. Please try again.');
          return false;
        }

        let offering;
        try {
          offering = (await Purchases.getOfferings()).current;
        } catch (cause) {
          setError(messageFor(cause, 'Could not reach the app store. Please try again.'));
          return false;
        }

        const pkg = offering?.[packageKey] ?? null;
        if (pkg === null) {
          setError('That plan is not available for purchase right now.');
          return false;
        }

        try {
          // The result carries RevenueCat's own CustomerInfo — deliberately
          // unread. See the file banner: only our server's re-ask counts.
          await Purchases.purchasePackage(pkg);
        } catch (cause) {
          if (
            isPurchasesError(cause) &&
            cause.code === PURCHASES_ERROR_CODE.PURCHASE_CANCELLED_ERROR
          ) {
            // A parent closing the sheet is not a failure worth a banner.
            return false;
          }
          setError(
            messageFor(cause, 'That purchase did not go through. Nothing has been charged.'),
          );
          return false;
        }

        const verified = await verifyWithServer(parentId);
        if (verified?.entitled !== true) {
          setError(
            verified?.explanation ?? 'That purchase did not go through. Nothing has been charged.',
          );
          return false;
        }
        return true;
      } finally {
        setPurchasing(false);
      }
    },
    [ensureIdentified, rail, verifyWithServer],
  );

  const restore = useCallback(async (): Promise<StoreRestoreResponse | undefined> => {
    setError(undefined);
    if (rail === undefined) {
      setError('Purchases are not available on this device right now.');
      return undefined;
    }

    setRestoring(true);
    try {
      const parentId = await ensureIdentified();
      if (parentId === undefined) {
        setError('Could not confirm who is signed in. Please try again.');
        return undefined;
      }

      try {
        // Refreshes RevenueCat's own record from the device's store account.
        // Still not trusted on its own — the receipt below sends our server
        // to re-ask RevenueCat directly, same as any other purchase.
        await Purchases.restorePurchases();
      } catch (cause) {
        setError(messageFor(cause, 'That did not go through. Nothing has changed.'));
        return undefined;
      }

      const result = await api.post<StoreRestoreResponse>('/api/store/restore', {
        receipts: [{ store: STORE_NAME[rail], token: parentId }],
      });

      if (!result.ok || result.data === undefined) {
        setError(result.failure?.message ?? 'That did not go through. Nothing has changed.');
        return undefined;
      }
      return result.data;
    } finally {
      setRestoring(false);
    }
  }, [api, ensureIdentified, rail]);

  return {
    available: rail !== undefined,
    purchasing,
    restoring,
    error,
    purchase,
    restore,
  };
};
