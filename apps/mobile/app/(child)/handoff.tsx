import { router } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { Avatar, Float, QuietButton, Screen, SpeechBubble } from '../../src/components/child/index';
import { useApp } from '../../src/state/app-context';
import { childTheme } from '../../src/theme/child-theme';
import { fonts } from '../../src/theme/fonts';

/**
 * Please give the phone to a grown-up.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * A HANDOFF, NOT A REJECTION
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The character stays on screen and says it will wait. There is no mention of
 * what was blocked, or why, or by whom — a child asked to fetch an adult should
 * not also be told they did something wrong, because they did not: the thing
 * they wanted needs a grown-up's decision, which is a fact about the product
 * rather than about them.
 *
 * "Go home" is always available. A child sent to find an adult who cannot find
 * one must not be stuck on this screen.
 */
export default function Handoff() {
  const { child } = useApp();

  return (
    <Screen testID="screen-handoff" style={styles.screen} padding={28}>
      <Float>
        <Avatar slug={child.characterSlug} size={160} />
      </Float>

      <SpeechBubble text="Please give the phone to a grown-up — they can help with this bit!" />

      <View style={styles.waiting}>
        <Text style={styles.wave}>👋</Text>
        <Text style={styles.waitingText}>I&apos;ll wait right here.</Text>
      </View>

      <QuietButton
        label="Go home"
        face="🏠"
        fullWidth={false}
        style={styles.home}
        onPress={() => {
          router.replace('/(child)/home');
        }}
        testID="home-button"
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  screen: { alignItems: 'center', justifyContent: 'center', gap: childTheme.spacing.lg },
  waiting: { flexDirection: 'row', alignItems: 'center', gap: childTheme.spacing.sm + 2 },
  wave: { fontSize: 26 },
  waitingText: {
    fontFamily: fonts.child.bold,
    fontSize: childTheme.text.aside,
    color: childTheme.colors.inkSoft,
  },
  home: { marginTop: childTheme.spacing.sm },
});
