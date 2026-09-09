import { router } from 'expo-router';
import { useState } from 'react';

import { ParentHeader } from '../../src/components/parent/chrome';
import {
  Banner,
  Body,
  Card,
  DangerButton,
  Field,
  ParentScreen,
  SecondaryButton,
  SectionTitle,
} from '../../src/components/parent/index';
import { useApp } from '../../src/state/app-context';
import { parentTheme } from '../../src/theme/parent-theme';

/**
 * Your data.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE REAL CONSEQUENCES, IN PLAIN WORDS, BEFORE THE BUTTON
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Including the one most products leave out: backups age out on their own
 * schedule, and we cannot pull a single record out of one early. That is a real
 * limit rather than a policy, and a deletion promise that quietly excludes
 * backups is a promise made in bad faith.
 *
 * Deleting the account requires the password again — not because the session is
 * untrusted, but because this is the one action in the product that a phone
 * left unlocked on a table could otherwise take.
 */
export default function YourData() {
  const { api, signOut } = useApp();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState<string | undefined>(undefined);
  const [message, setMessage] = useState<{ tone: 'good' | 'danger'; text: string } | undefined>();

  const requestExport = async () => {
    setBusy('export');
    setMessage(undefined);
    const result = await api.post('/v1/parents/me/data-export');
    setBusy(undefined);
    setMessage(
      result.ok
        ? {
            tone: 'good',
            text: 'Requested. We will email you a link that works for 24 hours.',
          }
        : { tone: 'danger', text: 'We could not start that export. Try again in a moment.' },
    );
  };

  const deleteAccount = async () => {
    if (password === '') return;
    setBusy('delete');
    setMessage(undefined);
    const result = await api.delete('/v1/parents/me', { confirmPassword: password });
    setBusy(undefined);

    if (!result.ok) {
      setMessage({
        tone: 'danger',
        text: 'We could not start that. Check your password and try again — nothing has been deleted.',
      });
      return;
    }
    await signOut();
    router.replace('/(child)/welcome');
  };

  return (
    <>
      <ParentHeader
        title="Your data"
        onBack={() => {
          router.back();
        }}
      />
      <ParentScreen testID="screen-your-data">
        {message !== undefined && <Banner tone={message.tone}>{message.text}</Banner>}

        <Card gap={10}>
          <SectionTitle>Export everything</SectionTitle>
          <Body>
            A JSON file with every profile, every transcript we still hold, and every setting. We
            email a link that works for 24 hours.
          </Body>
          <SecondaryButton
            label="Request an export"
            disabled={busy === 'export'}
            testID="request-export"
            onPress={() => {
              void requestExport();
            }}
          />
        </Card>

        <Card tone="danger" gap={10}>
          <SectionTitle>Delete your account</SectionTitle>
          <Body>
            Every child profile, every transcript, every setting, and your sign-in. We start within
            an hour and finish within 30 days. Backups age out on their own schedule; we can&apos;t
            pull a record out of a backup early.
          </Body>
          <Field
            label="Confirm your password"
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            autoCapitalize="none"
            autoComplete="password"
            testID="delete-account-password"
          />
          <DangerButton
            label="Delete my account"
            enabled={password !== '' && busy !== 'delete'}
            testID="delete-account"
            onPress={() => {
              void deleteAccount();
            }}
          />
        </Card>

        <SecondaryButton
          label="Read the privacy centre"
          style={{ borderColor: parentTheme.colors.border }}
          testID="go-privacy"
          onPress={() => {
            router.push('/(parent)/privacy');
          }}
        />
      </ParentScreen>
    </>
  );
}
