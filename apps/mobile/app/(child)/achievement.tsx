import { router, useLocalSearchParams } from 'expo-router';
import { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Pop } from '../../src/components/child/index';
import { childTheme } from '../../src/theme/child-theme';
import { fonts } from '../../src/theme/fonts';

/**
 * A badge, earned.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * A CALM CELEBRATION THAT LEAVES ON ITS OWN
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The badge pops once, two lines fade in, and after 1.8 seconds it goes. There
 * is no confetti, no sound sting, no share button, no streak, and nothing to
 * dismiss — a child who looks away for a moment has not missed a dialog they
 * now have to close.
 *
 * There is also nothing to CHASE. It does not say what the next badge is, how
 * close they are to it, or how many they have: a reward that arrives with a
 * progress bar toward the next one is not a reward, it is a hook, and hooks
 * aimed at children are out of bounds here.
 */
export default function Achievement() {
  const { title, next } = useLocalSearchParams<{ title?: string; next?: string }>();

  useEffect(() => {
    const timer = setTimeout(() => {
      /* Back to whatever was interrupted, or the badge shelf when nothing was.
       * A celebration that dumps a child somewhere they were not going is a
       * celebration that costs them their place. */
      router.replace(next ?? '/(child)/stars');
    }, childTheme.motion.celebrate);
    return () => {
      clearTimeout(timer);
    };
  }, [next]);

  return (
    <View style={styles.screen} testID="screen-achievement">
      <Pop>
        <View style={[styles.disc, childTheme.shadows.raised]}>
          <Text style={styles.star}>⭐</Text>
        </View>
      </Pop>
      <Text style={styles.headline}>You did it!</Text>
      <Text style={styles.subline}>{title ?? 'a new star'}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: childTheme.colors.background,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 22,
  },
  disc: {
    width: 140,
    height: 140,
    borderRadius: 70,
    backgroundColor: childTheme.colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  star: { fontSize: 68 },
  headline: {
    fontFamily: fonts.child.heavy,
    fontSize: childTheme.text.title,
    lineHeight: childTheme.text.title * 1.4,
    color: childTheme.colors.ink,
  },
  subline: {
    fontFamily: fonts.child.regular,
    fontSize: childTheme.text.body,
    lineHeight: childTheme.text.body * 1.4,
    color: childTheme.colors.inkSoft,
  },
});
