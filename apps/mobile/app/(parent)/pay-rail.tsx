import { router, useLocalSearchParams } from 'expo-router';
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

export default function PayRail() {
  const { plan } = useLocalSearchParams<{ plan?: string }>();
  const { api } = useApp();
  const [chosen, setChosen] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

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

  const ordered = [...(rails.data?.items ?? [])].sort(
    (a, b) =>
      (RAIL_ORDER.indexOf(a.rail as (typeof RAIL_ORDER)[number]) + 1 || 99) -
      (RAIL_ORDER.indexOf(b.rail as (typeof RAIL_ORDER)[number]) + 1 || 99),
  );

  const proceed = async () => {
    if (chosen === undefined || plan === undefined) return;
    setSubmitting(true);
    setError(undefined);
    // Records an INTENT and grants nothing. The subscription itself is created
    // by a verified webhook, which is why a parent who closes the checkout has
    // not accidentally been given a plan they did not pay for.
    const result = await api.post<{ checkoutUrl?: string }>('/api/subscriptions/create', {
      planCode: plan,
      rail: chosen,
    });
    setSubmitting(false);

    if (!result.ok) {
      router.replace('/(parent)/pay-failed');
      return;
    }
    router.replace('/(parent)/subscription');
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
