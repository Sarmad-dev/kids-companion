import { router } from 'expo-router';
import { useState } from 'react';

import type { ConsentRecord } from '../../src/api/client';
import { ParentHeader } from '../../src/components/parent/chrome';
import {
  Banner,
  Card,
  DangerOutlineButton,
  Faint,
  GroupLabel,
  ParentScreen,
  Row,
  SectionTitle,
  SettingRow,
  Switch,
  Tag,
  TAG_TONES,
} from '../../src/components/parent/index';
import { CONSENT_COPY, isBlockingConsentType } from '../../src/content/consent-text';
import { useResource } from '../../src/hooks/use-resource';
import { useApp } from '../../src/state/app-context';

/**
 * Consent management.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * OPTIONAL CONSENTS ARE NEVER BUNDLED WITH REQUIRED ONES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The required three were granted on their own screen, with their own wording,
 * one decision. The optional two live here, default OFF, behind their own
 * switches. Putting all five behind one "I agree" button is the standard trick
 * for getting analytics consent out of somebody who was trying to let their
 * child talk to a dog, and it is not available in this product.
 *
 * Withdrawal is real and immediate, and the warning says what it costs before
 * it is pressed: withdrawing a REQUIRED consent stops the child's access and
 * starts deletion. That is what "required" means, and hiding it would make the
 * word decorative.
 */
const OPTIONAL = [
  {
    type: 'transcript_retention',
    label: 'Keep transcripts',
    hint: 'Off means we screen each message, answer, and keep nothing. You lose the transcript reader.',
  },
  {
    type: 'product_analytics',
    label: 'Product analytics',
    hint: 'Anonymous counts of which screens are used. Never linked to your child.',
  },
] as const;

export default function ConsentManagement() {
  const { api } = useApp();
  const [busy, setBusy] = useState<string | undefined>(undefined);
  const [message, setMessage] = useState<{ tone: 'good' | 'danger'; text: string } | undefined>();

  const history = useResource(
    async () => await api.get<{ items: ConsentRecord[] }>('/v1/consent/history'),
    [api],
  );

  const records = history.data?.items ?? [];
  const latestFor = (type: string): ConsentRecord | undefined =>
    records.find((record) => record.consentType === type);

  const set = async (type: string, granted: boolean, policyVersion: string) => {
    setBusy(type);
    setMessage(undefined);
    const result = await api.post('/v1/consent', {
      consentType: type,
      granted,
      policyVersion,
      ...(isBlockingConsentType(type) ? { policyText: CONSENT_COPY[type].body } : {}),
    });
    setBusy(undefined);

    if (!result.ok) {
      setMessage({ tone: 'danger', text: 'We could not record that. Nothing has changed.' });
      return;
    }
    setMessage({ tone: 'good', text: 'Recorded.' });
    history.reload();
  };

  const granted = records.filter(
    (record) => record.granted && isBlockingConsentType(record.consentType),
  );

  return (
    <>
      <ParentHeader
        title="Consent"
        onBack={() => {
          router.back();
        }}
      />
      <ParentScreen testID="screen-consent-management">
        {message !== undefined && <Banner tone={message.tone}>{message.text}</Banner>}
        {history.failure !== undefined && <Banner tone="danger">{history.failure.message}</Banner>}

        <GroupLabel>Required — the app can&apos;t run without these</GroupLabel>

        {granted.map((record) => (
          <Card key={record.consentType} gap={8} testID={`consent-${record.consentType}`}>
            <Row align="center">
              <SectionTitle>
                {isBlockingConsentType(record.consentType)
                  ? CONSENT_COPY[record.consentType].title
                  : record.consentType}
              </SectionTitle>
              <Tag label="Granted" bg={TAG_TONES.good.bg} fg={TAG_TONES.good.fg} />
            </Row>
            <Faint>
              Granted {new Date(record.recordedAt).toLocaleDateString()} · policy{' '}
              {record.policyVersion}
            </Faint>
            <DangerOutlineButton
              label="Withdraw"
              testID={`withdraw-${record.consentType}`}
              onPress={() => {
                void set(record.consentType, false, record.policyVersion);
              }}
            />
          </Card>
        ))}

        <Banner tone="warn">
          Withdrawing a required consent stops your child&apos;s access immediately and starts
          deletion. We&apos;ll say so again before it takes effect.
        </Banner>

        <GroupLabel>Optional — off unless you turn them on</GroupLabel>

        <Card gap={0} style={{ paddingVertical: 4 }}>
          {OPTIONAL.map((option, index) => {
            const record = latestFor(option.type);
            const on = record?.granted ?? false;
            return (
              <SettingRow
                key={option.type}
                label={option.label}
                hint={option.hint}
                last={index === OPTIONAL.length - 1}
              >
                <Switch
                  on={on}
                  label={option.label}
                  testID={`optional-${option.type}`}
                  onToggle={() => {
                    if (busy !== undefined) return;
                    void set(option.type, !on, record?.policyVersion ?? '1.0.0');
                  }}
                />
              </SettingRow>
            );
          })}
        </Card>
      </ParentScreen>
    </>
  );
}
