import { router } from 'expo-router';

import type { SubscriptionStatus } from '../../src/api/client';
import { ParentHeader } from '../../src/components/parent/chrome';
import {
  Body,
  Card,
  CardTitle,
  Faint,
  ParentScreen,
  PrimaryButton,
  SecondaryButton,
  SectionTitle,
  TickLine,
} from '../../src/components/parent/index';
import { useResource } from '../../src/hooks/use-resource';
import { useApp } from '../../src/state/app-context';
import { parentTheme } from '../../src/theme/parent-theme';

/**
 * A payment that did not go through.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT HAPPENED, WHAT STILL WORKS, WHAT TO DO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * In that order, and the middle one is the part most billing screens skip. A
 * parent who has just been told a payment failed assumes the worst available
 * thing — that their child's transcripts are gone, that the profiles are gone,
 * that their controls have reset. None of that is true, and saying so is more
 * useful than another button.
 *
 * THE CHILD SEES NONE OF THIS. They drop to the Free allowance and meet their
 * usual friend, with no payment message, no price and no plan name. That is
 * stated here so a parent is not left wondering what their four-year-old has
 * been shown.
 */
export default function PayFailed() {
  const { api, child } = useApp();

  const status = useResource(
    async () => await api.get<SubscriptionStatus>('/api/subscriptions/status'),
    [api],
  );

  const name = child.childName ?? 'Your child';

  return (
    <>
      <ParentHeader
        title="Payment"
        onBack={() => {
          router.back();
        }}
      />
      <ParentScreen testID="screen-pay-failed">
        <Card tone="danger" gap={8} style={{ backgroundColor: parentTheme.colors.dangerWash }}>
          <SectionTitle>We couldn&apos;t take the payment</SectionTitle>
          <Body>
            {status.data?.explanation ??
              'Your payment method declined the charge. We will try again over the next few days and email you.'}
          </Body>
        </Card>

        <Card gap={10}>
          <CardTitle>What still works</CardTitle>
          <TickLine>Every profile, setting and transcript is untouched</TickLine>
          <TickLine>Your parental controls stay exactly as you set them</TickLine>
          <TickLine>You can switch to another payment method any time</TickLine>
          <Faint>
            {name} is on the Free allowance for now. They see no payment message, no price and no
            plan name — just their usual friend.
          </Faint>
        </Card>

        <PrimaryButton
          label="Use a different method"
          testID="pay-failed-change"
          onPress={() => {
            router.replace('/(parent)/pay-rail');
          }}
        />
        <SecondaryButton
          label="Try the same one again"
          testID="pay-failed-retry"
          onPress={() => {
            status.reload();
          }}
        />
      </ParentScreen>
    </>
  );
}
