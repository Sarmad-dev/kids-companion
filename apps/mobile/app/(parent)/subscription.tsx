import { router } from 'expo-router';

import type { SubscriptionPlan, SubscriptionStatus } from '../../src/api/client';
import { ParentHeader } from '../../src/components/parent/chrome';
import {
  Banner,
  Body,
  Card,
  CardTitle,
  Faint,
  GroupLabel,
  LinkButton,
  ParentScreen,
  PrimaryButton,
  Row,
  SectionTitle,
  Tag,
  TAG_TONES,
  TickLine,
} from '../../src/components/parent/index';
import { useResource } from '../../src/hooks/use-resource';
import { useApp } from '../../src/state/app-context';

/**
 * Subscription.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THIS ENTIRE SURFACE IS UNREACHABLE FROM CHILD MODE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * No price, no plan name, no upsell and no "ask a grown-up to unlock this" ever
 * appears on a screen a child can see. A character a plan does not include is
 * shown to the child as resting, in exactly the same way as a character a parent
 * has switched off — because from the child's side those are the same fact, and
 * only one of them is something they could be made to want.
 *
 * "If a payment fails" sits on this screen rather than only in an email,
 * because it is the thing a parent most needs to know BEFORE subscribing:
 * nothing is deleted, and the child quietly drops to the Free allowance.
 */

/** Minor units into something a parent recognises on their own bank statement. */
const price = (plan: SubscriptionPlan): string => {
  if (plan.priceMinor === 0) return `${plan.currency} 0`;
  const major = (plan.priceMinor / 100).toLocaleString(undefined, {
    maximumFractionDigits: 0,
  });
  const per =
    plan.billingInterval === 'month'
      ? '/mo'
      : plan.billingInterval === 'year'
        ? '/yr'
        : plan.billingInterval === 'week'
          ? '/wk'
          : '';
  return `${plan.currency} ${major}${per}`;
};

/**
 * What a plan allows, in the parent's words.
 *
 * Derived from the same limit numbers the server enforces rather than from a
 * marketing list, so a plan cannot advertise something the gate will refuse.
 */
const allowances = (plan: SubscriptionPlan): string[] => [
  `${String(plan.limits.dailyMinuteLimit)} minutes a day`,
  `${String(plan.limits.childProfileLimit)} child ${
    plan.limits.childProfileLimit === 1 ? 'profile' : 'profiles'
  }`,
  `${String(plan.limits.dailyTurnLimit)} conversation turns a day`,
  plan.limits.voiceEnabled ? 'Talking out loud' : 'Typed conversation only',
];

export default function Subscription() {
  const { api } = useApp();

  const status = useResource(
    async () => await api.get<SubscriptionStatus>('/api/subscriptions/status'),
    [api],
  );

  const plans = useResource(
    async () => await api.get<{ items: SubscriptionPlan[] }>('/api/subscriptions/plans'),
    [api],
  );

  const current = status.data?.plan;

  return (
    <>
      <ParentHeader
        title="Subscription"
        onBack={() => {
          router.back();
        }}
      />
      <ParentScreen testID="screen-subscription">
        {status.failure !== undefined && <Banner tone="danger">{status.failure.message}</Banner>}

        {status.data !== undefined &&
          (status.data.status === 'past_due' || status.data.status === 'grace') && (
            <Banner tone="danger">{status.data.explanation}</Banner>
          )}

        {current !== undefined && (
          <Card tone="action" gap={10} testID="current-plan">
            <Row align="center" style={{ justifyContent: 'space-between' }}>
              <SectionTitle>{current.displayName}</SectionTitle>
              <Tag label="Current plan" bg={TAG_TONES.action.bg} fg={TAG_TONES.action.fg} />
            </Row>
            {allowances(current).map((line) => (
              <TickLine key={line}>{line}</TickLine>
            ))}
            <Faint>{status.data?.explanation}</Faint>
          </Card>
        )}

        <GroupLabel>All plans</GroupLabel>

        {(plans.data?.items ?? []).map((plan) => (
          <Card key={plan.code} gap={10} testID={`plan-${plan.code}`}>
            <Row align="baseline" style={{ justifyContent: 'space-between' }}>
              <SectionTitle>{plan.displayName}</SectionTitle>
              <CardTitle>{price(plan)}</CardTitle>
            </Row>
            <Faint>{plan.description}</Faint>
            {plan.code !== current?.code && plan.tier === 'paid' && (
              <PrimaryButton
                label={`Choose ${plan.displayName}`}
                testID={`choose-${plan.code}`}
                onPress={() => {
                  router.push({ pathname: '/(parent)/pay-rail', params: { plan: plan.code } });
                }}
              />
            )}
          </Card>
        ))}

        <Card gap={8} style={{ borderWidth: 0, backgroundColor: '#eceef1' }}>
          <CardTitle>If a payment fails</CardTitle>
          <Body>
            We try again over five days and email you. Nothing is deleted. Your child quietly drops
            to the Free allowance — they are never shown a payment message, a price or a plan name.
          </Body>
        </Card>

        <LinkButton
          label="Cancel, resume or restore purchases"
          tone="quiet"
          testID="go-cancel-plan"
          onPress={() => {
            router.push('/(parent)/cancel-plan');
          }}
        />
      </ParentScreen>
    </>
  );
}
