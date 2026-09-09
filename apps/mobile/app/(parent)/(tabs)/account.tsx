import { router } from 'expo-router';
import { useEffect, useState } from 'react';

import type { AiProviderName, ParentProfile } from '../../../src/api/client';
import { ParentHeader } from '../../../src/components/parent/chrome';
import {
  Banner,
  Card,
  Field,
  GroupLabel,
  Helper,
  ListRow,
  ParentScreen,
  PrimaryButton,
  RadioRow,
} from '../../../src/components/parent/index';
import { useResource } from '../../../src/hooks/use-resource';
import { useApp } from '../../../src/state/app-context';

/**
 * How each vendor is described to a parent.
 *
 * Named for what it means to them, not for the API being called. A parent
 * choosing between "Anthropic" and "OpenAI" is choosing between two words they
 * may well not recognise, so each carries a plain second line.
 *
 * `mock` is included because a deployment can genuinely be running on it — in
 * local development, and in any environment with no vendor keys — and a screen
 * that hid it would show a parent no selected option at all.
 */
const PROVIDER_COPY: Record<AiProviderName, { label: string; hint: string }> = {
  anthropic: { label: 'Anthropic', hint: 'Claude models.' },
  openai: { label: 'OpenAI', hint: 'GPT models.' },
  google: { label: 'Google', hint: 'Gemini models. Runs on the free tier.' },
  mock: { label: 'Practice mode', hint: 'Canned replies. No AI, and nothing leaves the device.' },
};

/**
 * Account.
 *
 * Your details, then the rows that lead somewhere, then the way out. The
 * destructive actions are grouped LAST and coloured — sign out is red text,
 * deleting the account is behind "Your data" and behind a typed confirmation
 * after that. Nothing on this screen deletes anything by itself.
 */
export default function Account() {
  const { api, signOut } = useApp();
  const [email, setEmail] = useState('');
  const [country, setCountry] = useState('');
  /** null is a real choice — "follow whatever the server is set to". */
  const [provider, setProvider] = useState<AiProviderName | null>(null);

  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const profile = useResource(async () => await api.get<ParentProfile>('/v1/parents/me'), [api]);

  useEffect(() => {
    if (profile.data === undefined) return;
    setEmail(profile.data.email);
    setCountry(profile.data.countryCode);
    setProvider(profile.data.aiProvider);
  }, [profile.data]);

  const save = async () => {
    setSaving(true);
    // The PATCH answers with `{ id, displayName }` rather than the whole
    // profile, so the result is checked and not merged back.
    const result = await api.patch<{ id: string }>('/v1/parents/me', {
      ...(country === '' ? {} : { countryCode: country }),
      // Always sent, null included: null is what CLEARS the preference, so
      // omitting it would make "back to the app default" unreachable. The
      // endpoint distinguishes an absent key from an explicit null.
      aiProvider: provider,
    });
    setSaving(false);
    setSaved(result.ok);
    if (result.ok) profile.reload();
  };

  return (
    <>
      <ParentHeader
        title="Account"
        action={{
          label: 'Save',
          onPress: () => {
            void save();
          },
          disabled: saving,
        }}
      />
      <ParentScreen testID="screen-parent-account">
        {saved && <Banner tone="good">✓ Saved.</Banner>}
        {profile.failure !== undefined && <Banner tone="danger">{profile.failure.message}</Banner>}

        <Card gap={12}>
          <GroupLabel>Your details</GroupLabel>
          {/* Not editable here: changing the address that receives safety alerts
              is a verification flow, not a text field. */}
          <Field
            label="Email"
            value={email}
            onChangeText={setEmail}
            editable={false}
            testID="account-email"
          />
          <Field
            label="Country"
            value={country}
            onChangeText={(next) => {
              setCountry(next.toUpperCase().slice(0, 2));
              setSaved(false);
            }}
            autoCapitalize="characters"
            placeholder="PK"
            testID="account-country"
          />
        </Card>

        {/* Only when there is a genuine choice. A deployment with one reachable
            vendor would otherwise draw a list of one, which reads as a setting
            and behaves as a label. */}
        {(profile.data?.aiProvidersAvailable.length ?? 0) > 1 && (
          <Card gap={8}>
            <GroupLabel>Who your child talks to</GroupLabel>
            <Helper>
              This changes the AI that writes the replies. Safety checks do not change — every
              message is still checked the same way, whichever you pick.
            </Helper>
            <RadioRow
              label="Use the app default"
              hint={`Currently ${
                PROVIDER_COPY[profile.data?.aiProviderEffective ?? 'mock'].label
              }. Follows the app if that changes.`}
              on={provider === null}
              testID="account-provider-default"
              onPress={() => {
                setProvider(null);
                setSaved(false);
              }}
            />
            {(profile.data?.aiProvidersAvailable ?? []).map((name) => (
              <RadioRow
                key={name}
                label={PROVIDER_COPY[name].label}
                hint={PROVIDER_COPY[name].hint}
                on={provider === name}
                testID={`account-provider-${name}`}
                onPress={() => {
                  setProvider(name);
                  setSaved(false);
                }}
              />
            ))}
          </Card>
        )}

        <ListRow
          label="Change password"
          testID="account-password"
          onPress={() => {
            router.push('/(parent)/reset-new');
          }}
        />
        <ListRow
          label="Where you are signed in"
          testID="account-sessions"
          onPress={() => {
            router.push('/(parent)/sessions');
          }}
        />
        <ListRow
          label="Your data"
          meta="export, delete"
          testID="account-your-data"
          onPress={() => {
            router.push('/(parent)/your-data');
          }}
        />
        <ListRow
          label="Privacy centre"
          testID="account-privacy"
          onPress={() => {
            router.push('/(parent)/privacy');
          }}
        />
        <ListRow
          label="Consent"
          testID="account-consent"
          onPress={() => {
            router.push('/(parent)/consent-management');
          }}
        />
        <ListRow
          label="Subscription"
          testID="account-subscription"
          onPress={() => {
            router.push('/(parent)/subscription');
          }}
        />
        <ListRow
          label="Notifications"
          testID="account-notifications"
          onPress={() => {
            router.push('/(parent)/notifications');
          }}
        />
        <ListRow
          label="Support"
          testID="account-support"
          onPress={() => {
            router.push('/(parent)/support');
          }}
        />
        <ListRow
          label="Sign out"
          tone="danger"
          testID="account-signout"
          onPress={() => {
            void signOut().then(() => {
              router.replace('/(child)/welcome');
            });
          }}
        />

        <PrimaryButton
          label="Back to playing"
          onPress={() => {
            router.replace('/(child)/welcome');
          }}
          testID="account-back-to-play"
        />
      </ParentScreen>
    </>
  );
}
