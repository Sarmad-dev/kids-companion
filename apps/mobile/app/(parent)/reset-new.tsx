import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';

import { ParentHeader } from '../../src/components/parent/chrome';
import {
  Banner,
  Card,
  Display,
  Field,
  Helper,
  ParentScreen,
  PrimaryButton,
} from '../../src/components/parent/index';
import { useApp } from '../../src/state/app-context';

const MINIMUM_PASSWORD = 12;

/**
 * Set a new password.
 *
 * Two ways in, and they take different endpoints: a reset LINK carries a token
 * and goes to `/v1/auth/password-reset/confirm`, while a parent changing their
 * password from the account screen is already signed in and goes to
 * `/v1/parents/me/password` with their current one. Same form, same twelve
 * character rule, same inline validation.
 *
 * Either way it signs every OTHER device out, which the card says before the
 * button rather than after — including, pointedly, the phone the child plays on.
 */
export default function ResetNew() {
  const { token } = useLocalSearchParams<{ token?: string }>();
  const { api, signedIn } = useApp();

  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const withToken = token !== undefined && token !== '';
  const tooShort = password !== '' && password.length < MINIMUM_PASSWORD;
  const mismatch = confirm !== '' && confirm !== password;

  const submit = async () => {
    setError(undefined);
    if (password.length < MINIMUM_PASSWORD) {
      setError(`Your password needs to be at least ${String(MINIMUM_PASSWORD)} characters.`);
      return;
    }
    if (password !== confirm) {
      setError('Those passwords do not match.');
      return;
    }

    setSubmitting(true);
    const result = withToken
      ? await api.post('/v1/auth/password-reset/confirm', { token, password })
      : await api.post('/v1/parents/me/password', {
          currentPassword: current,
          newPassword: password,
        });
    setSubmitting(false);

    if (!result.ok) {
      setError('We could not change your password. Check the details and try again.');
      return;
    }

    router.replace(signedIn === true ? '/(parent)/(tabs)/account' : '/(parent)/sign-in');
  };

  return (
    <>
      <ParentHeader
        title="New password"
        onBack={() => {
          router.back();
        }}
      />
      <ParentScreen testID="screen-reset-new" gap={14}>
        <Display>Set a new password</Display>

        {error !== undefined && <Banner tone="danger">{error}</Banner>}

        {!withToken && (
          <Field
            label="Current password"
            value={current}
            onChangeText={setCurrent}
            secureTextEntry
            autoCapitalize="none"
            autoComplete="password"
            testID="reset-current"
          />
        )}

        <Field
          label="New password"
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          autoCapitalize="none"
          autoComplete="password-new"
          state={tooShort ? 'error' : password === '' ? 'rest' : 'valid'}
          {...(tooShort
            ? {
                error: `${String(password.length)} of ${String(
                  MINIMUM_PASSWORD,
                )} characters — a few more, please.`,
              }
            : password === ''
              ? {}
              : { success: `${String(password.length)} characters — that'll do nicely.` })}
          testID="reset-new-password"
        />
        <Field
          label="Confirm new password"
          value={confirm}
          onChangeText={setConfirm}
          secureTextEntry
          autoCapitalize="none"
          autoComplete="password-new"
          state={mismatch ? 'error' : 'rest'}
          {...(mismatch ? { error: 'Those passwords do not match.' } : {})}
          testID="reset-new-confirm"
        />

        <PrimaryButton
          label={withToken ? 'Save and sign in' : 'Save'}
          loading={submitting}
          onPress={() => {
            void submit();
          }}
          testID="reset-new-submit"
        />

        <Card>
          <Helper>Changing your password signs you out on every other device.</Helper>
        </Card>
      </ParentScreen>
    </>
  );
}
