import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { ParentHeader } from '../../src/components/parent/chrome';
import {
  Body,
  Card,
  Faint,
  ParentScreen,
  PrimaryButton,
  SecondaryButton,
  SectionTitle,
} from '../../src/components/parent/index';
import { useApp } from '../../src/state/app-context';
import { parentTheme } from '../../src/theme/parent-theme';

/**
 * Email verification.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * PENDING IS NOT THE SAME AS BLOCKED
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * An unverified parent's CHILD can still play. Verification gates the things
 * that change money or change limits — subscribing, editing controls — because
 * those are the actions where "somebody typed an address they do not own"
 * actually matters. Stopping a four-year-old talking to a dog because a
 * confirmation email went to spam would be punishing the wrong person for the
 * wrong thing.
 *
 * The link in the email deep-links back here carrying a token, which is why
 * this screen confirms as a side effect of being opened rather than asking the
 * parent to press anything.
 */
export default function Verify() {
  const { token } = useLocalSearchParams<{ token?: string }>();
  const { api } = useApp();
  const [confirmed, setConfirmed] = useState(false);
  const [checking, setChecking] = useState(token !== undefined && token !== '');

  useEffect(() => {
    if (token === undefined || token === '') return;
    void api.post('/v1/auth/verify-email', { token }).then((result) => {
      setConfirmed(result.ok);
      setChecking(false);
    });
  }, [api, token]);

  return (
    <>
      <ParentHeader
        title="Email verification"
        onBack={() => {
          router.replace('/(parent)/(tabs)/account');
        }}
      />
      <ParentScreen testID="screen-verify" gap={14}>
        {confirmed ? (
          <Card tone="good">
            <View style={styles.head}>
              <View style={[styles.badge, { backgroundColor: parentTheme.colors.goodWash }]}>
                <Text style={[styles.badgeGlyph, { color: parentTheme.colors.good }]}>✓</Text>
              </View>
              <SectionTitle>Email confirmed</SectionTitle>
            </View>
            <Body>Everything in the parent area is open to you.</Body>
            <PrimaryButton
              label="Go to the dashboard"
              onPress={() => {
                router.replace('/(parent)/(tabs)/dashboard');
              }}
              testID="verify-dashboard"
            />
          </Card>
        ) : (
          <Card>
            <View style={styles.head}>
              <View style={[styles.badge, { backgroundColor: parentTheme.colors.warnWash }]}>
                <Text style={styles.badgeGlyph}>⏳</Text>
              </View>
              <SectionTitle>Verification pending</SectionTitle>
            </View>
            <Body>
              Your child can play, but you&apos;ll need to verify before you can change controls or
              subscribe.
            </Body>
            <SecondaryButton
              label="Resend the email"
              onPress={() => {
                void api.post('/v1/auth/verify-email', {});
              }}
              testID="verify-resend"
            />
            {checking && <Faint>Checking your link…</Faint>}
          </Card>
        )}
      </ParentScreen>
    </>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  badge: {
    width: 34,
    height: 34,
    borderRadius: parentTheme.radii.control,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeGlyph: { fontSize: 17 },
});
