import { router, useLocalSearchParams } from 'expo-router';
import { StyleSheet, Text } from 'react-native';

import {
  Avatar,
  BigButton,
  Float,
  QuietButton,
  Screen,
  SpeechBubble,
  Spacer,
} from '../../../src/components/child/index';
import { useApp } from '../../../src/state/app-context';
import { childTheme } from '../../../src/theme/child-theme';
import { fonts } from '../../../src/theme/fonts';

/**
 * A satisfying full stop.
 *
 * The ending is read back so the story feels finished rather than abandoned,
 * and "Make another story" is a choice the child makes — NOT a hook. There is
 * no counter, no weekly quota shown, no "you have two left", and no urgency of
 * any kind. If the weekly allowance is gone the child finds that out from the
 * character, warmly, on the next screen, and is offered a chat instead.
 */
export default function StoryDone() {
  const { ending } = useLocalSearchParams<{ ending?: string }>();
  const { child } = useApp();

  return (
    <Screen
      testID="screen-story-done"
      background="#f6ecff"
      style={styles.screen}
      padding={childTheme.spacing.lg}
    >
      <Text style={styles.title}>What a lovely story!</Text>

      <Float style={styles.character}>
        <Avatar slug={child.characterSlug} size={140} />
      </Float>

      <SpeechBubble
        text={ending ?? 'The balloon found its way home, and everybody had jam on toast. The end!'}
      />

      <Spacer />

      <BigButton
        label="Make another story"
        face="📖"
        size="medium"
        colour={childTheme.colors.lily}
        onPress={() => {
          router.replace('/(child)/story');
        }}
        testID="another-story"
      />
      <QuietButton
        label="Go home"
        face="🏠"
        onPress={() => {
          router.replace('/(child)/home');
        }}
        testID="home-button"
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  screen: { alignItems: 'center', gap: childTheme.spacing.md - 2 },
  title: {
    fontFamily: fonts.child.heavy,
    fontSize: childTheme.text.title,
    lineHeight: childTheme.text.title * 1.4,
    color: '#6b4a8f',
    textAlign: 'center',
  },
  character: { marginTop: 22 },
});
