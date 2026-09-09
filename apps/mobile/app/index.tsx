import { router } from 'expo-router';
import { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';

import { Avatar, Float } from '../src/components/child/index';
import { useReducedMotion } from '../src/hooks/reduced-motion';
import { useApp } from '../src/state/app-context';
import { childTheme, DEFAULT_CHARACTER } from '../src/theme/child-theme';
import { fonts } from '../src/theme/fonts';

/**
 * Splash.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * FIRST PAINT HAS TO SURVIVE A SLOW START
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Flat cream, the flat avatar, three calm dots. No progress bar and no
 * percentage — a percentage is a number a child would try to read, and a bar
 * that stalls at 80% is a promise broken in front of them.
 *
 * It waits for exactly one thing: whether the keystore holds a parent session.
 * That answer decides where the app opens, and guessing wrong means either a
 * signed-in family meeting a sign-in form or a signed-out one meeting an empty
 * child list. Both are worse than a beat of a screen a child rather likes.
 */
export default function Splash() {
  const { signedIn } = useApp();
  const reduced = useReducedMotion();
  const dots = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (reduced) {
      dots.setValue(0.6);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(dots, {
          toValue: 1,
          duration: 600,
          easing: Easing.linear,
          useNativeDriver: true,
        }),
        Animated.timing(dots, {
          toValue: 0,
          duration: 600,
          easing: Easing.linear,
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => {
      loop.stop();
    };
  }, [dots, reduced]);

  useEffect(() => {
    if (signedIn === undefined) return;
    // `replace`, never `push`: nothing in this app should be able to go "back"
    // to a splash screen.
    router.replace(signedIn ? '/(child)/child-select' : '/(child)/welcome');
  }, [signedIn]);

  return (
    <View style={styles.screen} testID="screen-splash">
      <Float>
        <Avatar slug={DEFAULT_CHARACTER} size={180} />
      </Float>
      <Text style={styles.wordmark}>Kids Companion</Text>
      <View style={styles.dots}>
        {[0, 0.2, 0.4].map((offset) => (
          <Animated.View
            key={offset}
            style={[
              styles.dot,
              {
                opacity: dots.interpolate({
                  inputRange: [0, 1],
                  outputRange: [0.28 + offset * 0.4, 1 - offset * 0.4],
                }),
              },
            ]}
          />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: childTheme.colors.background,
    alignItems: 'center',
    justifyContent: 'center',
    gap: childTheme.spacing.lg + 2,
  },
  wordmark: {
    fontFamily: fonts.child.heavy,
    fontSize: childTheme.text.hero,
    lineHeight: childTheme.text.hero * 1.4,
    color: childTheme.colors.ink,
  },
  dots: { flexDirection: 'row', gap: childTheme.spacing.sm },
  dot: { width: 10, height: 10, borderRadius: 5, backgroundColor: childTheme.colors.accent },
});
