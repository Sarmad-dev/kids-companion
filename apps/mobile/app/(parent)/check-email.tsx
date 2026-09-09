import { router, useLocalSearchParams } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import {
  Body,
  Card,
  Display,
  Helper,
  LinkButton,
  ParentScreen,
  SecondaryButton,
} from '../../src/components/parent/index';
import { useApp } from '../../src/state/app-context';
import { parentTheme } from '../../src/theme/parent-theme';

/**
 * Check your email.
 *
 * Shown when the account exists but the address is not yet verified. It gives
 * NO hint about whether the password was right, and the card says so out loud:
 * "If an account already exists for this address, the link will sign you in
 * instead. We don't say which, on purpose." Explaining the ambiguity is better
 * than letting a parent conclude the app is broken.
 */
export default function CheckEmail() {
  const { email } = useLocalSearchParams<{ email?: string }>();
  const { api } = useApp();

  const resend = () => {
    if (email === undefined) return;
    // Answers the same way whether or not the address is known, so a resend
    // cannot be used to test which addresses exist.
    void api.post('/v1/auth/verify-email', { email });
  };

  return (
    <ParentScreen testID="screen-check-email" gap={16}>
      <View style={styles.icon}>
        <Text style={styles.iconGlyph}>✉️</Text>
      </View>

      <Display>Check your email</Display>
      <Body>
        We&apos;ve sent a link to <Text style={styles.strong}>{email ?? 'your address'}</Text>. Open
        it on this phone and you&apos;ll come straight back here.
      </Body>

      <Card>
        <Helper>
          If an account already exists for this address, the link will sign you in instead. We
          don&apos;t say which, on purpose.
        </Helper>
      </Card>

      <SecondaryButton label="Send it again" onPress={resend} testID="resend-verification" />
      <LinkButton
        label="Back to sign in"
        tone="quiet"
        onPress={() => {
          router.replace('/(parent)/sign-in');
        }}
        testID="check-email-back"
      />
    </ParentScreen>
  );
}

const styles = StyleSheet.create({
  icon: {
    width: 52,
    height: 52,
    borderRadius: parentTheme.radii.control,
    backgroundColor: parentTheme.colors.actionWash,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconGlyph: { fontSize: 24 },
  strong: { color: parentTheme.colors.ink },
});
