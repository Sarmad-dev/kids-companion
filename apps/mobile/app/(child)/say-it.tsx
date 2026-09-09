import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { PracticeExercise } from '../../src/api/client';
import {
  FriendlyError,
  GoHomeButton,
  Screen,
  Spacer,
  Thinking,
  Title,
  gridStyles,
} from '../../src/components/child/index';
import { useResource } from '../../src/hooks/use-resource';
import { useApp } from '../../src/state/app-context';
import { childTheme } from '../../src/theme/child-theme';
import { fonts } from '../../src/theme/fonts';

/**
 * Say it with me!
 *
 * Two drill types, distinguished by icon AND colour AND word: 👏 on blue for
 * syllables, 🗣️ on peach for whole words. The exercise titles are written for
 * the adult who may be sitting alongside — a child picks by the picture and by
 * where the tile sits, which is why the two kinds never interleave randomly.
 *
 * The list is age-gated on the server, the same way characters are: what a
 * child is offered gets smaller as they get younger, never larger.
 */
export default function SayIt() {
  const { api, child } = useApp();

  const exercises = useResource(
    async () =>
      await api.get<{ items: PracticeExercise[] }>(
        `/api/practice/exercises?childId=${child.childId ?? ''}`,
      ),
    [api, child.childId],
  );

  if (exercises.failure)
    return (
      <Screen testID="screen-say-it">
        <FriendlyError
          message={exercises.failure.message}
          slug={child.characterSlug}
          onHome={() => {
            router.replace('/(child)/home');
          }}
          {...(exercises.failure.retryable ? { onRetry: exercises.reload } : {})}
        />
      </Screen>
    );

  if (exercises.loading)
    return (
      <Screen testID="screen-say-it">
        <Thinking slug={child.characterSlug} />
      </Screen>
    );

  const items = exercises.data?.items ?? [];

  return (
    <Screen scroll testID="screen-say-it" padding={20}>
      <Title>Say it with me!</Title>

      <View style={[gridStyles.grid, styles.grid]}>
        {items.map((exercise) => {
          const syllables = exercise.kind === 'syllable';
          return (
            <Pressable
              key={exercise.exerciseKey}
              testID={`exercise-${exercise.exerciseKey}`}
              accessibilityRole="button"
              accessibilityLabel={exercise.title}
              style={styles.cardWrap}
              onPress={() => {
                router.push({
                  pathname: '/(child)/practice/[exerciseKey]',
                  params: { exerciseKey: exercise.exerciseKey },
                });
              }}
            >
              {({ pressed }) => (
                <View style={[styles.card, childTheme.shadows.card, pressed && styles.pressed]}>
                  <View
                    style={[
                      styles.disc,
                      {
                        backgroundColor: syllables
                          ? childTheme.colors.tileSayIt
                          : childTheme.colors.tileChat,
                      },
                    ]}
                  >
                    <Text style={styles.icon}>{syllables ? '👏' : '🗣️'}</Text>
                  </View>
                  <Text style={styles.label}>{exercise.title}</Text>
                </View>
              )}
            </Pressable>
          );
        })}
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
  grid: { marginTop: 18 },
  cardWrap: { flexGrow: 1, flexBasis: '46%' },
  card: {
    minHeight: 124,
    backgroundColor: childTheme.colors.surface,
    borderRadius: childTheme.radii.card,
    alignItems: 'center',
    justifyContent: 'center',
    gap: childTheme.spacing.sm,
    padding: 14,
  },
  pressed: { opacity: 0.9 },
  disc: {
    width: 58,
    height: 58,
    borderRadius: 29,
    alignItems: 'center',
    justifyContent: 'center',
  },
  icon: { fontSize: 28 },
  label: {
    fontFamily: fonts.child.bold,
    fontSize: childTheme.text.label,
    lineHeight: childTheme.text.label * 1.3,
    color: childTheme.colors.ink,
    textAlign: 'center',
  },
});
