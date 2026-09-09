import { StyleSheet, Text, View } from 'react-native';

import { Avatar, Float, Screen, SpeechBubble } from '../../src/components/child/index';
import { useApp } from '../../src/state/app-context';
import { childTheme } from '../../src/theme/child-theme';
import { fonts } from '../../src/theme/fonts';

/**
 * Time's up.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * NOTHING ON THIS SCREEN IS TAPPABLE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The session limit exists to END the session, so this screen ends it. A button
 * here would be a negotiation — "five more minutes?" — and the one thing a
 * parental time limit must not be is negotiable by the person it applies to.
 *
 * No countdown led up to this, because a visible timer would have turned the
 * last ten minutes of a conversation into a race. And there is no "come back
 * tomorrow": a warm goodbye is the whole message, and a retention hook aimed at
 * a four-year-old is out of bounds.
 */
export default function TimesUp() {
  const { child } = useApp();

  return (
    <Screen testID="screen-times-up" background="#fff6e5" style={styles.screen} padding={28}>
      <View style={styles.wash} pointerEvents="none" />
      <Float>
        <Avatar slug={child.characterSlug} size={170} />
      </Float>

      <SpeechBubble text="That was such a good chat. I'm going to have a rest now — bye for now!" />

      <View style={styles.bye}>
        <Text style={styles.wave}>👋</Text>
        <Text style={styles.byeText}>Bye!</Text>
      </View>
    </Screen>
  );
}

/**
 * Fills the parent, as a plain style object.
 *
 * `StyleSheet.absoluteFill` is a registered style ID rather than an object, so
 * it cannot be spread into one; `absoluteFillObject` is absent from this
 * version's typings. Writing the four edges out is the version that compiles
 * and is the version that will keep compiling.
 */
const FILL_PARENT = { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 } as const;

const styles = StyleSheet.create({
  screen: { alignItems: 'center', justifyContent: 'center', gap: childTheme.spacing.lg + 2 },
  /* The warm dusk the design fades to — the visual equivalent of a light being
   * turned down rather than switched off. */
  wash: {
    ...FILL_PARENT,
    backgroundColor: '#f6e6c8',
    opacity: 0.55,
  },
  bye: { flexDirection: 'row', alignItems: 'center', gap: childTheme.spacing.sm + 2 },
  wave: { fontSize: 28 },
  byeText: { fontFamily: fonts.child.bold, fontSize: 22, color: '#8a6a2a' },
});
