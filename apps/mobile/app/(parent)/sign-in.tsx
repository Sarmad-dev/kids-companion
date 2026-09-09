import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { View } from 'react-native';

import type { AuthSession } from '../../src/api/client';
import {
  Banner,
  Body,
  Display,
  Field,
  LinkButton,
  ParentScreen,
  PrimaryButton,
} from '../../src/components/parent/index';
import { useApp } from '../../src/state/app-context';

/**
 * Sign in.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ONE GENERIC FAILURE SENTENCE, AND THE COPY MUST NOT IMPLY OTHERWISE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The API deliberately cannot distinguish a wrong password from an unknown
 * account — an error that told them apart would let an unauthenticated caller
 * enumerate which addresses are registered, which for a product whose accounts
 * are attached to children is a genuinely serious leak. So there is one
 * sentence, it names both fields, and it never says "no such account".
 *
 * A device that already holds a valid session skips this screen entirely.
 */
export default function SignIn() {
  const { api, signIn, signedIn, gatePassed } = useApp();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    if (signedIn === true && gatePassed) router.replace('/(parent)/(tabs)/dashboard');
  }, [signedIn, gatePassed]);

  const submit = async () => {
    setError(undefined);
    if (email.trim() === '' || password === '') {
      setError('Enter your email address and password.');
      return;
    }

    setSubmitting(true);
    const result = await api.post<AuthSession>('/v1/auth/login', {
      email: email.trim(),
      password,
    });
    setSubmitting(false);

    if (!result.ok || result.data === undefined) {
      setError("Those details didn't work. Check the email address and password and try again.");
      return;
    }

    await signIn(result.data);
    router.replace('/(parent)/(tabs)/dashboard');
  };

  return (
    <ParentScreen testID="screen-parent-signin" gap={14}>
      <Display>Sign in</Display>
      <Body>The parent area for Kids Companion.</Body>

      {error !== undefined && <Banner tone="danger">{error}</Banner>}

      <Field
        label="Email"
        value={email}
        onChangeText={setEmail}
        keyboardType="email-address"
        autoCapitalize="none"
        autoComplete="email"
        testID="signin-email"
      />
      <Field
        label="Password"
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        autoCapitalize="none"
        autoComplete="password"
        testID="signin-password"
      />

      <PrimaryButton
        label="Sign in"
        loading={submitting}
        onPress={() => {
          void submit();
        }}
        testID="signin-submit"
      />
      <LinkButton
        label="New here? Create an account"
        onPress={() => {
          router.push('/(parent)/sign-up');
        }}
        testID="signin-register-link"
      />
      <LinkButton
        label="I've forgotten my password"
        onPress={() => {
          router.push('/(parent)/reset-request');
        }}
        testID="signin-reset-link"
      />

      <View style={{ flex: 1, minHeight: 8 }} />
      <LinkButton
        label="Back to playing"
        tone="quiet"
        onPress={() => {
          router.replace('/(child)/welcome');
        }}
        testID="signin-back"
      />
    </ParentScreen>
  );
}
