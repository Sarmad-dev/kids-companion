import { router } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import {
  Avatar,
  BigButton,
  Float,
  QuietButton,
  Screen,
  SpeechBubble,
  Spacer,
} from '../../src/components/child/index';
import { useApp } from '../../src/state/app-context';
import { childTheme } from '../../src/theme/child-theme';
import { fonts } from '../../src/theme/fonts';

/**
 * Priming the microphone permission.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * TWO AUDIENCES, ONE SCREEN, AND THEY ARE ADDRESSED SEPARATELY
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The character speaks to the CHILD, in Baloo 2 at 20pt: "I need to be able to
 * hear you, so we can talk!" The grey box speaks to the ADULT holding the
 * phone, in IBM Plex Sans at 13pt, and tells them what the OS dialog that comes
 * next actually is and what happens to the recording.
 *
 * This runs BEFORE the system prompt because a four-year-old cannot parse
 * "Allow Kids Companion to record audio?", and a denied permission is close to
 * permanent — iOS will not ask twice. Priming is the difference between an
 * informed yes and a tap that ends the product.
 */
export default function MicPrime() {
  const { child } = useApp();

  return (
    <Screen testID="screen-mic-prime" style={styles.screen} padding={24}>
      <Float>
        <Avatar slug={child.characterSlug} size={150} />
      </Float>

      <View style={styles.bubble}>
        <SpeechBubble text="I need to be able to hear you, so we can talk!" />
      </View>

      <View style={styles.adultBox}>
        <Text style={styles.lock}>🔒</Text>
        <Text style={styles.adultText}>
          For the grown-up nearby: the next box is your phone asking for microphone access.
          Recordings are deleted within hours and are never used to train anything.
        </Text>
      </View>

      <Spacer />

      <BigButton
        label="Okay!"
        face="👂"
        colour={childTheme.colors.listening}
        onPress={() => {
          router.replace('/(child)/conversation');
        }}
        testID="mic-prime-continue"
      />
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
  screen: { alignItems: 'center' },
  bubble: { marginTop: childTheme.spacing.lg },
  /* IBM Plex Sans at 13pt is parent-mode type, on purpose: it is not addressed
   * to the child, and it should not look as though it is. */
  adultBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: childTheme.spacing.sm + 4,
    marginTop: childTheme.spacing.lg - 4,
    backgroundColor: '#f5ecd9',
    borderRadius: childTheme.radii.tile - 4,
    paddingVertical: 14,
    paddingHorizontal: childTheme.spacing.md,
  },
  lock: { fontSize: 26 },
  adultText: {
    flex: 1,
    fontFamily: fonts.parent.regular,
    fontSize: 13,
    lineHeight: 13 * 1.45,
    color: childTheme.colors.inkSoft,
  },
  home: { marginTop: 14 },
});
