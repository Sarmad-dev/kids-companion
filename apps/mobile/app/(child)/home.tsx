import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import {
  Avatar,
  QuietButton,
  Screen,
  Tile,
  Title,
  gridStyles,
} from '../../src/components/child/index';
import { useApp } from '../../src/state/app-context';
import { childTheme } from '../../src/theme/child-theme';

/**
 * Home.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * SIX TILES. FIXED ORDER. FOREVER.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Position IS the label for a pre-reader: a child learns "the star one is my
 * badges" long before they can read "Stars", and they learn it by where it sits
 * rather than by what it says. Reordering by "recent" or "suggested" would be a
 * perfectly ordinary product decision that quietly breaks the app for the
 * youngest users it exists for.
 *
 * Progress and settings sit below as muted pills, so they read as secondary to
 * the six things a child came here to do.
 */
const TILES = [
  { icon: '💬', label: 'Chat', colour: childTheme.colors.tileChat, href: '/(child)/conversation' },
  {
    icon: '🎤',
    label: 'Talk',
    colour: childTheme.colors.tileTalk,
    href: '/(child)/mic-prime',
  },
  { icon: '📖', label: 'Story', colour: childTheme.colors.tileStory, href: '/(child)/story' },
  { icon: '🗣️', label: 'Say it', colour: childTheme.colors.tileSayIt, href: '/(child)/say-it' },
  { icon: '🔤', label: 'Words', colour: childTheme.colors.tileWords, href: '/(child)/words' },
  { icon: '⭐', label: 'Stars', colour: childTheme.colors.tileStars, href: '/(child)/stars' },
] as const;

export default function Home() {
  const { child } = useApp();

  return (
    <Screen scroll testID="screen-home" padding={20}>
      <View style={styles.header}>
        <Avatar slug={child.characterSlug} size={120} />
        <Title>{child.childName === undefined ? 'Hello!' : `Hello, ${child.childName}!`}</Title>
      </View>

      <View style={[gridStyles.grid, styles.grid]}>
        {TILES.map((tile) => (
          <Tile
            key={tile.label}
            icon={tile.icon}
            label={tile.label}
            colour={tile.colour}
            testID={`home-${tile.label.toLowerCase().replace(' ', '-')}`}
            onPress={() => {
              router.push(tile.href);
            }}
          />
        ))}
      </View>

      <View style={styles.footer}>
        <QuietButton
          label="My progress"
          face="🌱"
          style={styles.grow}
          onPress={() => {
            router.push('/(child)/progress');
          }}
          testID="home-progress"
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Change things"
          testID="home-settings"
          onPress={() => {
            router.push('/(child)/settings');
          }}
          style={({ pressed }) => [styles.settingsButton, pressed && styles.pressed]}
        >
          <Text style={styles.settingsGlyph}>🔄</Text>
        </Pressable>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { alignItems: 'center', gap: childTheme.spacing.sm },
  grid: { marginTop: childTheme.spacing.md },
  footer: {
    flexDirection: 'row',
    gap: childTheme.spacing.sm + 4,
    marginTop: 14,
  },
  grow: { flex: 1 },
  settingsButton: {
    width: 88,
    minHeight: childTheme.touch.min,
    borderRadius: childTheme.radii.pill,
    backgroundColor: childTheme.colors.muted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  settingsGlyph: { fontSize: 30 },
  pressed: { opacity: 0.85 },
});
