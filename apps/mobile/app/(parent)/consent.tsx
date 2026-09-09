import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';

import type { ConsentRequirement } from '../../src/api/client';
import { ParentHeader } from '../../src/components/parent/chrome';
import {
  Banner,
  Body,
  Card,
  Faint,
  Helper,
  LinkButton,
  PageTitle,
  ParentScreen,
  PrimaryButton,
  SectionTitle,
} from '../../src/components/parent/index';
import { CONSENT_COPY, isBlockingConsentType } from '../../src/content/consent-text';
import { useResource } from '../../src/hooks/use-resource';
import { useApp } from '../../src/state/app-context';

/**
 * The consent gate.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS IS IN THE FLOW AND NOT IN A SETTINGS MENU
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Conversation is gated by an RLS policy on `conversations`, computed from
 * `app.child_missing_consents`. Without this screen the flow is: register, add
 * a child, hand the phone over, and let the child discover the refusal. The only
 * person who can answer is the parent, and the only moment they are reliably
 * still holding the phone is now.
 *
 * WHAT IS ASKED FOR: exactly the requirements the server says block
 * conversation, in the server's own order. WHICH consents are required is data
 * in `consent_requirements`, not code, so this screen READS them rather than
 * hardcoding three names — a new blocking requirement appears here without a
 * release.
 *
 * WHAT IS NOT ASKED FOR: the optional consents. They block nothing, they are off
 * by default, and putting them behind this same button would bundle a free
 * choice with a required one. They live in Consent management, off.
 *
 * `policyVersion` is echoed back from the requirement itself. The gate compares
 * `policy_version >= min_policy_version`, so the version whose wording was
 * actually shown is both sufficient and honest — claiming a newer version we did
 * not display would be a lie told to a database.
 */
export default function Consent() {
  const { childName } = useLocalSearchParams<{ childName?: string }>();
  const { api, child } = useApp();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const requirements = useResource(
    async () => await api.get<{ items: ConsentRequirement[] }>('/v1/consent/requirements'),
    [api],
  );

  // A requirement we have no wording for cannot be consented to honestly:
  // `policyText` is stored as proof of what was shown, and there would be
  // nothing to show. Better to omit it and leave the child gated than to record
  // a consent against an empty string.
  const blocking = (requirements.data?.items ?? []).filter(
    (item) => item.blocksConversation && isBlockingConsentType(item.consentType),
  );

  const agree = async () => {
    setError(undefined);
    if (child.childId === undefined) {
      setError('Something went wrong. Go back and choose a child again.');
      return;
    }

    setSubmitting(true);

    // Sequential, not concurrent: each is a separate audited decision, and if
    // the third fails the parent needs to know which ones were recorded rather
    // than watching three requests fail together.
    for (const requirement of blocking) {
      if (!isBlockingConsentType(requirement.consentType)) continue;

      const result = await api.post('/v1/consent', {
        consentType: requirement.consentType,
        granted: true,
        policyVersion: requirement.minPolicyVersion,
        policyText: CONSENT_COPY[requirement.consentType].body,
        // Present for a child-scoped consent, ABSENT for an account-scoped one.
        // The gate matches `child_id is null` for account scope, so sending an
        // id there would record a consent that never satisfies anything.
        ...(requirement.scope === 'child' ? { childId: child.childId } : {}),
      });

      if (!result.ok) {
        setSubmitting(false);
        setError('We could not save that. Check your connection and try again.');
        return;
      }
    }

    setSubmitting(false);
    router.replace('/(parent)/(tabs)/dashboard');
  };

  const name = childName ?? child.childName ?? 'your child';

  return (
    <>
      <ParentHeader title="Before we start" />
      <ParentScreen testID="screen-consent" gap={12}>
        <PageTitle>Before {name}&apos;s first chat</PageTitle>
        <Body>
          Please read these while you&apos;re holding the phone. All of them are needed for the app
          to work at all.
        </Body>

        {error !== undefined && <Banner tone="danger">{error}</Banner>}
        {requirements.failure !== undefined && (
          <Banner tone="danger">{requirements.failure.message}</Banner>
        )}

        {blocking.map((requirement) =>
          isBlockingConsentType(requirement.consentType) ? (
            <Card
              key={requirement.consentType}
              gap={8}
              testID={`consent-${requirement.consentType}`}
            >
              <SectionTitle>{CONSENT_COPY[requirement.consentType].title}</SectionTitle>
              <Body>{CONSENT_COPY[requirement.consentType].body}</Body>
              <Faint>{requirement.rationale}</Faint>
            </Card>
          ) : null,
        )}

        <PrimaryButton
          label="I agree, and I am the parent"
          loading={submitting}
          disabled={blocking.length === 0}
          onPress={() => {
            void agree();
          }}
          testID="consent-agree"
        />
        <LinkButton
          label="Not now"
          tone="quiet"
          onPress={() => {
            router.replace('/(parent)/(tabs)/children');
          }}
          testID="consent-decline"
        />

        <Helper>
          Optional things — keeping transcripts, product analytics — are not in here. They&apos;re
          off, and they live in Consent management.
        </Helper>
      </ParentScreen>
    </>
  );
}
