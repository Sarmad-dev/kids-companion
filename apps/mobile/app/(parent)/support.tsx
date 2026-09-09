import Constants from 'expo-constants';
import { router } from 'expo-router';
import { useState } from 'react';
import { Platform } from 'react-native';

import { ParentHeader } from '../../src/components/parent/chrome';
import {
  Banner,
  Body,
  Card,
  Faint,
  ListRow,
  Mono,
  ParentScreen,
  SecondaryButton,
  SectionTitle,
} from '../../src/components/parent/index';
import { useApp } from '../../src/state/app-context';
import { parentTheme } from '../../src/theme/parent-theme';

/**
 * Support.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE ONE PLACE IN THE PRODUCT A REFERENCE CODE SURFACES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * To a parent, never to a child. Every failure the API reports carries a
 * request id; it goes into the support log a parent can send and never onto a
 * screen — the child sees one warm sentence in their character's voice, which
 * is the whole of what a four-year-old can do anything with.
 *
 * WHAT THE REPORT CONTAINS: app version, device model, and the last failure this
 * session recorded. No transcripts, no recordings, no child names. Said before
 * the button, because "send diagnostics" is a phrase people have learned to be
 * suspicious of, and they are right to be.
 */
const TOPICS = [
  'The character cannot hear my child',
  "My child's time limit is not being applied",
  'Changing the language to Urdu',
  'Payment and billing questions',
  'Deleting a profile or an account',
] as const;

export default function Support() {
  const { api, lastFailure } = useApp();
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  const version = Constants.expoConfig?.version ?? '0.0.0';
  const reference = lastFailure?.requestId;

  const send = async () => {
    setBusy(true);
    await api.post('/v1/support/diagnostics', {
      appVersion: version,
      platform: Platform.OS,
      ...(reference === undefined ? {} : { requestId: reference }),
      ...(lastFailure === undefined ? {} : { lastFailureKind: lastFailure.kind }),
    });
    setBusy(false);
    setSent(true);
  };

  return (
    <>
      <ParentHeader
        title="Support"
        onBack={() => {
          router.back();
        }}
      />
      <ParentScreen testID="screen-support" gap={10}>
        {sent && <Banner tone="good">Sent. Quote the reference below if you email us.</Banner>}

        {TOPICS.map((topic) => (
          <ListRow
            key={topic}
            label={topic}
            testID={`help-${topic.slice(0, 12)}`}
            onPress={() => {
              router.push('/(parent)/privacy');
            }}
          />
        ))}

        <Card gap={10} style={{ marginTop: 6 }}>
          <SectionTitle>Send a diagnostic report</SectionTitle>
          <Body>
            Sends your app version, device model and the last error this session recorded. No
            transcripts, no recordings.
          </Body>

          <Card style={{ borderWidth: 0, backgroundColor: parentTheme.colors.background }}>
            <Mono>
              Reference: {reference ?? '—'} · v{version} · {Platform.OS}
            </Mono>
          </Card>

          <SecondaryButton
            label="Send report"
            disabled={busy}
            testID="send-diagnostics"
            onPress={() => {
              void send();
            }}
          />
          <Faint>
            Quote that reference when you email us. It&apos;s the only place in the app a code like
            this appears — your child never sees one.
          </Faint>
        </Card>
      </ParentScreen>
    </>
  );
}
