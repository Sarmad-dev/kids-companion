import { router } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { ParentHeader } from '../../src/components/parent/chrome';
import {
  Body,
  Card,
  Display,
  Helper,
  ParentScreen,
  SecondaryButton,
} from '../../src/components/parent/index';
import { useApp } from '../../src/state/app-context';
import { parentTheme } from '../../src/theme/parent-theme';

/**
 * Maintenance.
 *
 * A window, in the parent's words, plus what the child sees RIGHT NOW. The
 * second half is the part that stops a parent debugging a phone that is working
 * exactly as intended.
 *
 * "Nothing is lost" is stated because it is the first thing anybody wonders and
 * the last thing a status page usually says.
 */
export default function Maintenance() {
  const { api } = useApp();
  const [checking, setChecking] = useState(false);

  const check = async () => {
    setChecking(true);
    const result = await api.get('/v1/version');
    setChecking(false);
    // Back up: leave rather than sit on a screen that is no longer true.
    if (result.ok) router.replace('/(parent)/(tabs)/dashboard');
  };

  return (
    <>
      <ParentHeader title="Maintenance" />
      <ParentScreen testID="screen-maintenance" centred gap={16}>
        <View style={styles.icon}>
          <Text style={styles.iconGlyph}>🛠️</Text>
        </View>

        <Display>We&apos;re doing some work</Display>
        <Body>
          We&apos;ll be back shortly. Nothing is lost — settings, transcripts and profiles are all
          where you left them.
        </Body>

        <Card>
          <Helper>
            Right now your child sees &quot;let&apos;s play again a bit later&quot;. If they open
            the app during the work, that&apos;s all they&apos;ll see.
          </Helper>
        </Card>

        <SecondaryButton
          label={checking ? 'Checking…' : 'Check again'}
          disabled={checking}
          testID="maintenance-check"
          onPress={() => {
            void check();
          }}
        />
      </ParentScreen>
    </>
  );
}

const styles = StyleSheet.create({
  icon: {
    width: 52,
    height: 52,
    borderRadius: parentTheme.radii.control,
    backgroundColor: parentTheme.colors.warnWash,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconGlyph: { fontSize: 24 },
});
