import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import {
  Avatar,
  GoHomeButton,
  Screen,
  Spacer,
  gridStyles,
} from '../../../src/components/child/index';
import { STORY_SEEDS } from '../../../src/content/story-seeds';
import { useApp } from '../../../src/state/app-context';
import { childTheme } from '../../../src/theme/child-theme';
import { fonts } from '../../../src/theme/fonts';

/**
 * What shall the story be about?
 *
 * Story mode differs from chat by FRAME, not by mechanics: a violet ribbon, a
 * different opening line, and seeds offered as pictures. The seeds are the only
 * part that is really new — five of them, chosen by image, and "You choose!"
 * so a child who has no idea can hand the idea back to the character rather
 * than being stuck at a screen that demands one.
 */
export default function StorySeed() {
  const { child } = useApp();

  return (
    <Screen scroll testID="screen-story-seed" padding={20}>
      <View style={styles.header}>
        <Avatar slug={child.characterSlug} size={72} />
        <Text style={styles.question}>What shall the story be about?</Text>
      </View>

      <View style={[gridStyles.grid, styles.grid]}>
        {STORY_SEEDS.map((seed) => (
          <Pressable
            key={seed.key}
            testID={`seed-${seed.key}`}
            accessibilityRole="button"
            accessibilityLabel={seed.label}
            style={styles.cardWrap}
            onPress={() => {
              router.push({
                pathname: '/(child)/conversation',
                params: { mode: 'story', seed: seed.key },
              });
            }}
          >
            {({ pressed }) => (
              <View style={[styles.card, childTheme.shadows.card, pressed && styles.pressed]}>
                <Text style={styles.icon}>{seed.icon}</Text>
                <Text style={styles.label}>{seed.label}</Text>
              </View>
            )}
          </Pressable>
        ))}
      </View>

      <Spacer />
      <GoHomeButton
        onPress={() => {
          router.replace('/(child)/home');
        }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  question: {
    flex: 1,
    fontFamily: fonts.child.heavy,
    fontSize: childTheme.text.title,
    lineHeight: childTheme.text.title * 1.4,
    color: childTheme.colors.ink,
  },
  grid: { marginTop: childTheme.spacing.lg - 4 },
  cardWrap: { flexGrow: 1, flexBasis: '46%' },
  card: {
    minHeight: 128,
    backgroundColor: childTheme.colors.surface,
    borderRadius: childTheme.radii.card,
    alignItems: 'center',
    justifyContent: 'center',
    gap: childTheme.spacing.sm,
    padding: 14,
  },
  pressed: { opacity: 0.9 },
  icon: { fontSize: 40 },
  label: {
    fontFamily: fonts.child.bold,
    fontSize: childTheme.text.label,
    lineHeight: childTheme.text.label * 1.3,
    color: childTheme.colors.ink,
    textAlign: 'center',
  },
});
