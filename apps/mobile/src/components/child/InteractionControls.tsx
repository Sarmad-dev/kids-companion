import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { childTheme } from '../../theme/child-theme';
import { fonts } from '../../theme/fonts';
import { CHARACTER_ACTIONS, type CharacterAction } from '../../three/actions';

/**
 * The buttons a child uses to play WITH the character rather than to talk to it.
 *
 * Each carries a face, a colour and a word — the same three channels as every
 * other child control — and every one is 72pt, the floor for a tap. They sit in
 * a horizontally scrolling row rather than a wrapped grid because a second row
 * would cover the middle of the set, which is the character.
 */

interface ActionLook {
  readonly face: string;
  readonly label: string;
  readonly colour: string;
}

const LOOKS: Readonly<Record<CharacterAction, ActionLook>> = {
  wave: { face: '👋', label: 'Wave', colour: '#ffb14a' },
  jump: { face: '🦘', label: 'Jump', colour: '#4fb3e8' },
  dance: { face: '💃', label: 'Dance', colour: '#e879b9' },
  clap: { face: '👏', label: 'Clap', colour: '#5cc48a' },
  spin: { face: '🌀', label: 'Spin', colour: '#a978d8' },
  peek: { face: '🙈', label: 'Peek', colour: '#f2725e' },
};

export const ActionBar = ({
  onAction,
  disabled = false,
  testID = 'action-bar',
}: {
  onAction: (action: CharacterAction) => void;
  /** True while the child is talking: the character stays still and listens. */
  disabled?: boolean;
  testID?: string;
}) => (
  <View testID={testID} pointerEvents="box-none" style={styles.bar}>
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.row}
    >
      {CHARACTER_ACTIONS.map((action) => {
        const look = LOOKS[action];
        return (
          <Pressable
            key={action}
            testID={`action-${action}`}
            disabled={disabled}
            onPress={() => {
              onAction(action);
            }}
            accessibilityRole="button"
            accessibilityLabel={look.label}
            accessibilityState={{ disabled }}
            style={({ pressed }) => [
              styles.button,
              { backgroundColor: look.colour },
              pressed && styles.pressed,
              disabled && styles.disabled,
            ]}
          >
            <Text style={styles.face}>{look.face}</Text>
            <Text style={styles.label}>{look.label}</Text>
          </Pressable>
        );
      })}
    </ScrollView>
  </View>
);

/** The music switch. A face that changes and a word that changes with it. */
export const MusicToggle = ({
  enabled,
  onToggle,
  testID = 'music-toggle',
}: {
  enabled: boolean;
  onToggle: () => void;
  testID?: string;
}) => (
  <Pressable
    testID={testID}
    onPress={onToggle}
    accessibilityRole="switch"
    accessibilityLabel="Music"
    accessibilityState={{ checked: enabled }}
    style={({ pressed }) => [
      styles.music,
      { backgroundColor: enabled ? '#5cc48a' : 'rgba(255,246,229,0.86)' },
      pressed && styles.pressed,
    ]}
  >
    <Text style={styles.musicFace}>{enabled ? '🎵' : '🔇'}</Text>
    <Text style={[styles.musicLabel, enabled && styles.musicLabelOn]}>
      {enabled ? 'Music on' : 'Music off'}
    </Text>
  </Pressable>
);

const styles = StyleSheet.create({
  // The parent centres its children; a scroller needs the full width to scroll in.
  bar: { alignSelf: 'stretch' },
  row: { gap: 10, paddingHorizontal: childTheme.spacing.md, alignItems: 'center' },
  button: {
    width: 76,
    minHeight: 84,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    ...childTheme.shadows.card,
  },
  face: { fontSize: 32 },
  label: { fontFamily: fonts.child.bold, fontSize: 18, color: '#ffffff' },
  pressed: { opacity: 0.85, transform: [{ scale: 0.96 }] },
  disabled: { opacity: 0.45 },
  music: {
    minHeight: 72,
    minWidth: 72,
    paddingHorizontal: 14,
    borderRadius: childTheme.radii.pill,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    ...childTheme.shadows.card,
  },
  musicFace: { fontSize: 28 },
  musicLabel: { fontFamily: fonts.child.bold, fontSize: 18, color: '#6b4a8f' },
  musicLabelOn: { color: '#ffffff' },
});
