import { router, useLocalSearchParams } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import {
  Avatar,
  Body,
  GoHomeButton,
  Screen,
  Spacer,
  Title,
} from '../../../src/components/child/index';
import { useApp } from '../../../src/state/app-context';
import { childTheme } from '../../../src/theme/child-theme';
import { fonts } from '../../../src/theme/fonts';

/**
 * We practised together!
 *
 * What was practised, shown as the words THEMSELVES. No count, no accuracy, no
 * "you got 4 of 6", and no comparison to last time — those are parent-mode
 * figures, and putting any of them here would turn a warm ending into a report
 * card a child cannot argue with.
 *
 * "That's plenty for now" is the closing line on purpose: the drill ends
 * because it is finished, not because the child ran out of something.
 */
export default function PracticeDone() {
  const { words, kind } = useLocalSearchParams<{ words?: string; kind?: string }>();
  const { child } = useApp();

  const practised = (words ?? '').split('|').filter((word) => word !== '');
  const icon = kind === 'syllable' ? '👏' : '🗣️';

  return (
    <Screen testID="screen-practice-done" style={styles.screen} padding={24}>
      <Title>We practised together!</Title>

      <View style={styles.character}>
        <Avatar slug={child.characterSlug} size={140} />
      </View>

      <View style={styles.words}>
        {practised.map((word) => (
          <View key={word} style={[styles.pill, childTheme.shadows.card]}>
            <Text style={styles.pillText}>
              {icon} {word}
            </Text>
          </View>
        ))}
      </View>

      <View style={styles.closing}>
        <Body>That&apos;s plenty for now. Your mouth did lots of work!</Body>
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
  screen: { alignItems: 'center' },
  character: { marginTop: childTheme.spacing.lg - 4 },
  words: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: childTheme.spacing.sm + 2,
    justifyContent: 'center',
    marginTop: childTheme.spacing.lg,
  },
  pill: {
    backgroundColor: childTheme.colors.surface,
    borderRadius: childTheme.radii.pill,
    paddingVertical: 12,
    paddingHorizontal: 18,
  },
  pillText: {
    fontFamily: fonts.child.bold,
    fontSize: childTheme.text.aside,
    color: childTheme.colors.ink,
  },
  closing: { marginTop: childTheme.spacing.lg },
});
