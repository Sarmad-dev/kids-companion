import { router } from 'expo-router';
import { useState } from 'react';

import type { AuthSession } from '../../src/api/client';
import {
  Banner,
  Display,
  Field,
  LinkButton,
  ParentScreen,
  PrimaryButton,
} from '../../src/components/parent/index';
import { useApp } from '../../src/state/app-context';

/** Stated up front and validated as it is typed, never discovered on submit. */
const MINIMUM_PASSWORD = 12;

/**
 * Create an account.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHEN THE FOLLOW-UP SIGN-IN FAILS, IT IS USUALLY NOT A WRONG PASSWORD
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `/v1/auth/register` never returns a token, so a successful registration signs
 * in with the same credentials rather than bouncing a parent back to a form
 * they have just filled in. If the identity provider requires email
 * confirmation, that sign-in fails: the account exists but cannot be used yet.
 *
 * The sign-in endpoint cannot say so — it gives every failure the same answer on
 * purpose. THIS screen can, and only this screen: it just registered the
 * address itself, so telling the person in front of it to check their mail
 * reveals nothing they did not already know. The alternative, which is what a
 * bare redirect does, is to drop them on a sign-in form with no explanation,
 * where the only available reading is that the password they typed twice was
 * wrong.
 */
export default function SignUp() {
  const { api, signIn } = useApp();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const tooShort = password !== '' && password.length < MINIMUM_PASSWORD;
  const mismatch = confirm !== '' && confirm !== password;

  const submit = async () => {
    setError(undefined);
    if (email.trim() === '' || password === '') {
      setError('Enter your email address and a password.');
      return;
    }
    if (password.length < MINIMUM_PASSWORD) {
      setError(`Your password needs to be at least ${String(MINIMUM_PASSWORD)} characters.`);
      return;
    }
    if (password !== confirm) {
      setError('Those passwords do not match.');
      return;
    }

    setSubmitting(true);
    const registered = await api.post('/v1/auth/register', { email: email.trim(), password });
    if (!registered.ok) {
      setSubmitting(false);
      setError('We could not create that account. Check your details and try again.');
      return;
    }

    // The credentials are still in memory, so they are used once more rather
    // than asking a parent who just typed a password to type it again.
    const session = await api.post<AuthSession>('/v1/auth/login', {
      email: email.trim(),
      password,
    });
    setSubmitting(false);

    if (!session.ok || session.data === undefined) {
      router.replace({ pathname: '/(parent)/check-email', params: { email: email.trim() } });
      return;
    }

    await signIn(session.data);
    router.replace('/(parent)/add-child');
  };

  return (
    <ParentScreen testID="screen-parent-signup" gap={14}>
      <Display>Create an account</Display>

      {error !== undefined && <Banner tone="danger">{error}</Banner>}

      <Field
        label="Email"
        value={email}
        onChangeText={setEmail}
        keyboardType="email-address"
        autoCapitalize="none"
        autoComplete="email"
        testID="signup-email"
      />
      <Field
        label="Password"
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
        hint="Twelve characters minimum. A short sentence you'll remember beats a clever password."
        testID="signup-password"
      />
      <Field
        label="Confirm password"
        value={confirm}
        onChangeText={setConfirm}
        secureTextEntry
        autoCapitalize="none"
        autoComplete="password-new"
        state={mismatch ? 'error' : 'rest'}
        {...(mismatch ? { error: 'Those passwords do not match.' } : {})}
        testID="signup-confirm"
      />

      <PrimaryButton
        label="Create account"
        loading={submitting}
        onPress={() => {
          void submit();
        }}
        testID="signup-submit"
      />
      <LinkButton
        label="I already have an account"
        onPress={() => {
          router.replace('/(parent)/sign-in');
        }}
        testID="signup-signin-link"
      />
    </ParentScreen>
  );
}
