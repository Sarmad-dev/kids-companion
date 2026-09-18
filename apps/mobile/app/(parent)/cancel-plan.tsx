import { router } from 'expo-router';
import { useState } from 'react';

import type { SubscriptionStatus } from '../../src/api/client';
import { ParentHeader } from '../../src/components/parent/chrome';
import {
  Banner,
  Body,
  Card,
  DangerOutlineButton,
  ParentScreen,
  PrimaryButton,
  SecondaryButton,
  SectionTitle,
} from '../../src/components/parent/index';
import { useResource } from '../../src/hooks/use-resource';
import { useStoreBilling } from '../../src/iap/use-store-billing';
import { useApp } from '../../src/state/app-context';

/**
 * Cancel, resume, restore.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * CANCELLING STATES THE DATE, AND WHAT THE CHILD WILL NOTICE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Not "you will lose premium features" — the specific date access changes, the
 * specific allowance it changes to, and the honest sentence that the child will
 * notice shorter sessions and will not be told why. A parent deciding whether
 * to cancel is deciding something about their child's week, and the screen owes
 * them that in plain words rather than a retention-optimised shrug.
 *
 * There is no "are you sure?", no discount offer, and no survey. Cancelling is
 * reversible with one button on this same screen, which is a better answer to
 * "are you sure" than a modal.
 */
export default function CancelPlan() {
  const { api, child } = useApp();
  const [busy, setBusy] = useState<string | undefined>(undefined);
  const [message, setMessage] = useState<{ tone: 'good' | 'danger'; text: string } | undefined>();
  const storeBilling = useStoreBilling(api);

  const status = useResource(
    async () => await api.get<SubscriptionStatus>('/api/subscriptions/status'),
    [api],
  );

  const act = async (key: string, route: string, good: string): Promise<void> => {
    setBusy(key);
    setMessage(undefined);
    const result = await api.post(route);
    setBusy(undefined);

    if (!result.ok) {
      setMessage({ tone: 'danger', text: 'That did not go through. Nothing has changed.' });
      return;
    }
    setMessage({ tone: 'good', text: good });
    status.reload();
  };

  const endsAt = status.data?.currentPeriodEnd;
  const endDate =
    endsAt == null ? 'the end of your current period' : new Date(endsAt).toLocaleDateString();
  const name = child.childName ?? 'Your child';
  const cancelled = status.data?.status === 'cancelled';

  return (
    <>
      <ParentHeader
        title="Plan"
        onBack={() => {
          router.back();
        }}
      />
      <ParentScreen testID="screen-cancel-plan">
        {message !== undefined && <Banner tone={message.tone}>{message.text}</Banner>}

        {!cancelled && (
          <Card gap={10}>
            <SectionTitle>Cancel {status.data?.plan.displayName ?? 'your plan'}</SectionTitle>
            <Body>
              You keep everything until {endDate}. After that you are on the Free allowance: shorter
              sessions, one child, fewer stories, and transcripts kept for less time.
            </Body>
            <Body>
              {name} will notice shorter sessions. They won&apos;t be told why, and nothing will be
              deleted.
            </Body>
            <DangerOutlineButton
              label="Cancel at the end of the period"
              testID="do-cancel"
              onPress={() => {
                void act(
                  'cancel',
                  '/api/subscriptions/cancel',
                  'Cancelled. You keep access until the date above.',
                );
              }}
            />
          </Card>
        )}

        {cancelled && (
          <Card gap={10}>
            <SectionTitle>Resume</SectionTitle>
            <Body>
              Turn the plan back on and it picks up where it left off. No new sign-up, no lost
              history.
            </Body>
            <PrimaryButton
              label="Resume the plan"
              loading={busy === 'resume'}
              testID="do-resume"
              onPress={() => {
                void act('resume', '/api/subscriptions/resume', 'Resumed. Nothing was lost.');
              }}
            />
          </Card>
        )}

        {storeBilling.available && (
          <Card gap={10}>
            <SectionTitle>Restore purchases</SectionTitle>
            <Body>
              If you paid through the App Store or Google Play on another device, this finds it.
            </Body>
            <SecondaryButton
              label={storeBilling.restoring ? 'Checking…' : 'Restore purchases'}
              disabled={storeBilling.restoring}
              testID="do-restore"
              onPress={() => {
                void (async () => {
                  setMessage(undefined);
                  const restored = await storeBilling.restore();
                  if (restored === undefined) {
                    setMessage({
                      tone: 'danger',
                      text: storeBilling.error ?? 'That did not go through. Nothing has changed.',
                    });
                    return;
                  }
                  setMessage({ tone: 'good', text: restored.explanation });
                  status.reload();
                })();
              }}
            />
          </Card>
        )}
      </ParentScreen>
    </>
  );
}
