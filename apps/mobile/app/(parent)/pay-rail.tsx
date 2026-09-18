import * as Crypto from 'expo-crypto';
import { router, useLocalSearchParams } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { PaymentRail, SubscriptionPlan } from '../../src/api/client';
import { ParentHeader } from '../../src/components/parent/chrome';
import {
  Banner,
  Body,
  Helper,
  PageTitle,
  ParentScreen,
  PrimaryButton,
  RadioRow,
} from '../../src/components/parent/index';
import { useResource } from '../../src/hooks/use-resource';
import { STORE_NAME, currentStoreRail, useStoreBilling } from '../../src/iap/use-store-billing';
import { useApp } from '../../src/state/app-context';
import { fonts } from '../../src/theme/fonts';
import { parentTheme } from '../../src/theme/parent-theme';

/**
 * How would you like to pay?
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * PAKISTAN FIRST
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * JazzCash and Easypaisa above the fold, card next, then platform billing. That
 * ordering is not cosmetic: mobile wallets are how most of this product's
 * families actually pay, and a screen that puts Visa first tells them they are
 * an afterthought before they have read a word.
 *
 * Each rail carries its own mark, its own name and a hint about how it confirms,
 * because "you will get an SMS code" is the single most useful thing to know
 * before starting a wallet payment.
 *
 * WHAT WE NEVER SEE: the wallet PIN, the card number. Both are entered on the
 * rail's own surface, and the sentence at the bottom says so.
 */
const RAIL_ORDER = ['jazzcash', 'easypaisa', 'card', 'stripe', 'apple', 'google'] as const;

const RAIL_LOOK: Readonly<
  Record<string, { name: string; abbr: string; mark: string; hint: string }>
> = {
  jazzcash: {
    name: 'JazzCash',
    abbr: 'JC',
    mark: '#b3261e',
    hint: 'Mobile wallet · confirm by SMS',
  },
  easypaisa: {
    name: 'Easypaisa',
    abbr: 'EP',
    mark: '#1f7a4d',
    hint: 'Mobile wallet · confirm by SMS',
  },
  card: { name: 'Card', abbr: 'CD', mark: '#1a4fa0', hint: 'Visa, Mastercard' },
  stripe: { name: 'Card', abbr: 'CD', mark: '#1a4fa0', hint: 'Visa, Mastercard · via Stripe' },
  apple: { name: 'Apple', abbr: '', mark: '#1a1c1f', hint: 'Billed with your Apple ID' },
  google: {
    name: 'Google Play',
    abbr: 'GP',
    mark: '#5b6069',
    hint: 'Billed with your Google account',
  },
};

/**
 * `POST /api/subscriptions/create` records a CHECKOUT, not a purchase — the
 * hosted page it points to is where the parent actually pays, and the
 * subscription itself lands only once the rail's webhook confirms it. Apple
 * and Google don't work that way: there is no hosted page, the native store
 * sheet IS the payment, and it confirms itself to `/api/store/verify` — so
 * that rail skips this response's `redirectUrl` entirely. See
 * `useStoreBilling`.
 */
interface CheckoutResponse {
  readonly checkoutId: string;
  readonly redirectUrl: string | null;
}

export default function PayRail() {
  const { plan } = useLocalSearchParams<{ plan?: string }>();
  const { api } = useApp();
  const [chosen, setChosen] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const storeBilling = useStoreBilling(api);
  const storeRail = currentStoreRail();

  const rails = useResource(
    async () =>
      await api.get<{ available: boolean; items: PaymentRail[]; note: string }>(
        '/api/payments/rails',
      ),
    [api],
  );

  const plans = useResource(
    async () => await api.get<{ items: SubscriptionPlan[] }>('/api/subscriptions/plans'),
    [api],
  );

  const selected = plans.data?.items.find((item) => item.code === plan);

  // The App Store / Play Store rail never comes from `/api/payments/rails` —
  // that endpoint lists rails OUR server processes a checkout through, and a
  // native store purchase is a fundamentally different flow with no checkout
  // page (see `CheckoutResponse` above). Offered only when this platform HAS
  // that store, and the plan is actually sold through it.
  const storeRailOption: PaymentRail | undefined =
    storeBilling.available &&
    storeRail !== undefined &&
    (selected?.availableRails.includes(STORE_NAME[storeRail]) ?? false)
      ? {
          rail: storeRail,
          mode: 'live',
          verified: true,
          supportsRefunds: false,
          supportsRecurring: true,
          currencies: [],
        }
      : undefined;

  const ordered = [
    ...(rails.data?.items ?? []),
    ...(storeRailOption ? [storeRailOption] : []),
  ].sort(
    (a, b) =>
      (RAIL_ORDER.indexOf(a.rail as (typeof RAIL_ORDER)[number]) + 1 || 99) -
      (RAIL_ORDER.indexOf(b.rail as (typeof RAIL_ORDER)[number]) + 1 || 99),
  );

  const proceedWithStore = async () => {
    if (plan === undefined) return;
    setSubmitting(true);
    setError(undefined);
    const entitled = await storeBilling.purchase(plan);
    setSubmitting(false);

    if (!entitled) {
      setError(storeBilling.error ?? 'That purchase did not go through. Nothing has been charged.');
      return;
    }
    router.replace('/(parent)/subscription');
  };

  const proceedWithCheckout = async () => {
    if (chosen === undefined || plan === undefined) return;
    setSubmitting(true);
    setError(undefined);
    // Records an INTENT and grants nothing. The subscription itself is created
    // by a verified webhook, which is why a parent who closes the checkout has
    // not accidentally been given a plan they did not pay for.
    const result = await api.post<CheckoutResponse>('/api/subscriptions/create', {
      planCode: plan,
      rail: chosen,
      idempotencyKey: Crypto.randomUUID(),
    });

    if (!result.ok || result.data === undefined) {
      setSubmitting(false);
      router.replace('/(parent)/pay-failed');
      return;
    }

    // The card/wallet rails hand back a page where the parent enters payment
    // details or confirms an SMS code — opened in-app so leaving it (back
    // button, browser dismiss) returns here rather than stranding them in a
    // separate browser tab.
    if (result.data.redirectUrl !== null) {
      await WebBrowser.openBrowserAsync(result.data.redirectUrl);
    }
    setSubmitting(false);
    router.replace('/(parent)/subscription');
  };

  const proceed = async () => {
    if (chosen === undefined) return;
    if (storeRail !== undefined && chosen === storeRail) {
      await proceedWithStore();
      return;
    }
    await proceedWithCheckout();
  };

  return (
    <>
      <ParentHeader
        title="Payment method"
        onBack={() => {
          router.back();
        }}
      />
      <ParentScreen testID="screen-pay-rail" gap={10}>
        <PageTitle>How would you like to pay?</PageTitle>
        {selected !== undefined && (
          <Body>
            {selected.displayName} · {selected.currency}{' '}
            {(selected.priceMinor / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}{' '}
            per {selected.billingInterval} · cancel any time.
          </Body>
        )}

        {error !== undefined && <Banner tone="danger">{error}</Banner>}
        {rails.data?.available === false && <Banner tone="warn">{rails.data.note}</Banner>}

        {ordered.map((rail) => {
          const look = RAIL_LOOK[rail.rail] ?? {
            name: rail.rail,
            abbr: rail.rail.slice(0, 2).toUpperCase(),
            mark: parentTheme.colors.inkSoft,
            hint: '',
          };
          return (
            <RadioRow
              key={rail.rail}
              label={look.name}
              // An unverified integration says so rather than pretending.
              hint={rail.verified ? look.hint : `${look.hint} · in testing`}
              on={chosen === rail.rail}
              testID={`rail-${rail.rail}`}
              leading={
                <View style={[styles.mark, { backgroundColor: look.mark }]}>
                  <Text style={styles.markText}>{look.abbr}</Text>
                </View>
              }
              onPress={() => {
                setChosen(rail.rail);
              }}
            />
          );
        })}

        <PrimaryButton
          label="Continue"
          loading={submitting}
          disabled={chosen === undefined}
          onPress={() => {
            void proceed();
          }}
          testID="pay-rail-continue"
        />

        <Helper>
          JazzCash and Easypaisa confirm with an SMS code. We never see your wallet PIN or card
          number.
        </Helper>
      </ParentScreen>
    </>
  );
}

const styles = StyleSheet.create({
  mark: {
    width: 38,
    height: 38,
    borderRadius: parentTheme.radii.control,
    alignItems: 'center',
    justifyContent: 'center',
  },
  markText: { fontFamily: fonts.parent.bold, fontSize: 12, color: '#ffffff' },
});
