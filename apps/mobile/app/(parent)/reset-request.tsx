import { router } from 'expo-router';
import { useState } from 'react';

import {
  Body,
  Card,
  Display,
  Field,
  Helper,
  ParentScreen,
  PrimaryButton,
} from '../../src/components/parent/index';
import { useApp } from '../../src/state/app-context';

/**
 * Reset your password.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE SAME ANSWER WHETHER OR NOT THE ADDRESS EXISTS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Same reason as sign-in: an endpoint that says "we don't know that address"
 * lets anybody enumerate which parents have accounts. The screen therefore
 * navigates to "check your email" unconditionally, and the card explains that
 * it does — a parent who mistyped their address deserves to know why nothing
 * arrived, without that explanation also being a lookup service.
 */
export default function ResetRequest() {
  const { api } = useApp();
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    if (email.trim() === '') return;
    setSubmitting(true);
    await api.post('/v1/auth/password-reset', { email: email.trim() });
    setSubmitting(false);
    router.replace({ pathname: '/(parent)/check-email', params: { email: email.trim() } });
  };

  return (
    <ParentScreen testID="screen-reset-request" gap={14}>
      <Display>Reset your password</Display>
      <Body>We&apos;ll email you a link. It works once and lasts an hour.</Body>

      <Field
        label="Email"
        value={email}
        onChangeText={setEmail}
        keyboardType="email-address"
        autoCapitalize="none"
        autoComplete="email"
        testID="reset-email"
      />

      <PrimaryButton
        label="Send the link"
        loading={submitting}
        onPress={() => {
          void submit();
        }}
        testID="reset-submit"
      />

      <Card>
        <Helper>
          You&apos;ll see the same message whether or not we have an account for that address.
        </Helper>
      </Card>
    </ParentScreen>
  );
}
