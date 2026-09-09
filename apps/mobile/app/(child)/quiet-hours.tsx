import { StyleSheet, Text } from 'react-native';

import { Avatar, Screen, SpeechBubble } from '../../src/components/child/index';
import { useApp } from '../../src/state/app-context';
import { childTheme } from '../../src/theme/child-theme';

/**
 * Quiet hours.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE CHILD IS TOLD IT IS LATER. NEVER THAT THEY WERE BLOCKED, OR BY WHOM.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * "Let's play again a bit later!" is the same sentence for quiet hours, a
 * paused profile, a daily limit reached, maintenance and a forced update — one
 * line that covers every reason the app is unavailable, because a child cannot
 * act on any of the differences and telling them "your mum turned this off"
 * puts them in the middle of a decision that is not theirs.
 *
 * A parent sees the real reason, named, on their own dashboard.
 */
export default function QuietHours() {
  const { child } = useApp();

  return (
    <Screen testID="screen-quiet-hours" background="#f0eaff" style={styles.screen} padding={28}>
      <Avatar slug={child.characterSlug} size={150} />
      <SpeechBubble text="Let's play again a bit later!" />
      <Text style={styles.moon}>🌙</Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  screen: { alignItems: 'center', justifyContent: 'center', gap: childTheme.spacing.lg + 2 },
  moon: { fontSize: 34 },
});
