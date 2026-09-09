import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import {
  Avatar,
  Body,
  FriendlyError,
  GoHomeButton,
  Screen,
  Spacer,
  Thinking,
  Title,
} from '../../../src/components/child/index';
import { useResource } from '../../../src/hooks/use-resource';
import { useApp } from '../../../src/state/app-context';
import { childTheme } from '../../../src/theme/child-theme';
import { fonts } from '../../../src/theme/fonts';

/**
 * Words I've used!
 *
 * Chips are 72pt tall so they are genuinely tappable by a small hand, and
 * tapping one hears the word again in the character's voice. The list is the
 * child's own vocabulary — words THEY said — which is why the empty state points
 * back at the conversation rather than offering a word list to study.
 */
export default function Words() {
  const { api, child } = useApp();

  const progress = useResource(
    async () =>
      await api.get<{ vocabulary: { recent: { word: string }[] } }>(
        `/api/parent/progress/${child.childId ?? ''}?days=30`,
      ),
    [api, child.childId],
  );

  if (progress.failure)
    return (
      <Screen testID="screen-words">
        <FriendlyError
          message={progress.failure.message}
          slug={child.characterSlug}
          onHome={() => {
            router.replace('/(child)/home');
          }}
          {...(progress.failure.retryable ? { onRetry: progress.reload } : {})}
        />
      </Screen>
    );

  if (progress.loading)
    return (
      <Screen testID="screen-words">
        <Thinking slug={child.characterSlug} />
      </Screen>
    );

  const words = progress.data?.vocabulary.recent ?? [];

  return (
    <Screen scroll testID="screen-words" padding={20}>
      <Title>Words I&apos;ve used!</Title>

      {words.length === 0 ? (
        <View style={styles.empty}>
          <Avatar slug={child.characterSlug} size={120} />
          <Body>Chat with your friend and your words will appear here.</Body>
        </View>
      ) : (
        <View style={styles.chips}>
          {words.map((entry) => (
            <Pressable
              key={entry.word}
              testID={`word-${entry.word}`}
              accessibilityRole="button"
              accessibilityLabel={`Hear ${entry.word}`}
              onPress={() => {
                router.push({
                  pathname: '/(child)/words/[word]',
                  params: { word: entry.word },
                });
              }}
            >
              {({ pressed }) => (
                <View style={[styles.chip, childTheme.shadows.card, pressed && styles.pressed]}>
                  <Text style={styles.chipText}>{entry.word}</Text>
                </View>
              )}
            </Pressable>
          ))}
        </View>
      )}

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
  empty: {
    marginTop: 44,
    alignItems: 'center',
    gap: childTheme.spacing.lg - 4,
    paddingHorizontal: childTheme.spacing.lg,
  },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: childTheme.spacing.sm + 2,
    marginTop: childTheme.spacing.lg - 4,
  },
  chip: {
    minHeight: childTheme.touch.min,
    justifyContent: 'center',
    backgroundColor: childTheme.colors.surface,
    borderRadius: childTheme.radii.pill,
    paddingHorizontal: 22,
  },
  pressed: { opacity: 0.9 },
  chipText: {
    fontFamily: fonts.child.bold,
    fontSize: childTheme.text.body,
    color: childTheme.colors.ink,
  },
});
