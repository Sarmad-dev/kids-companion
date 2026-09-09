import { router } from 'expo-router';
import { StyleSheet } from 'react-native';

import { Avatar, BigButton, Screen, SpeechBubble } from '../../src/components/child/index';
import { useApp } from '../../src/state/app-context';
import { childTheme } from '../../src/theme/child-theme';

/**
 * Opened with no connection at all.
 *
 * The full-screen version of the banner, for the case where there is nothing
 * behind it worth showing. One warm sentence and ONE retry — because retrying
 * is a thing that can plausibly help here, which is the only test for whether a
 * "Try again" button should exist at all.
 */
export default function Offline() {
  const { child, online } = useApp();

  return (
    <Screen testID="screen-offline" style={styles.screen} padding={28}>
      <Avatar slug={child.characterSlug} size={160} />
      <SpeechBubble text="I can't hear you from here! Let's try again when the internet is back." />
      <BigButton
        label="Try again"
        face="🔄"
        size="medium"
        fullWidth={false}
        disabled={!online}
        onPress={() => {
          router.replace('/(child)/home');
        }}
        testID="retry-button"
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  screen: { alignItems: 'center', justifyContent: 'center', gap: childTheme.spacing.lg },
});
