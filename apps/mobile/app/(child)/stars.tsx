import { router } from 'expo-router';
import { View } from 'react-native';

import {
  BadgeTile,
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

/**
 * My stars.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * UNEARNED BADGES ARE DIMMED, NEVER HIDDEN — AND NEVER COUNTED
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Each keeps the same tile, the same position and the same name at 35%, so a
 * child can see what is still to come without being told they have missed
 * anything. There is no "3 of 7" and no progress bar toward the next one: a
 * count turns a set of nice moments into a checklist a child is behind on.
 *
 * The catalogue is fixed and local rather than fetched, because the ORDER is
 * part of the meaning — a badge that moves position between visits is a
 * different badge as far as a pre-reader is concerned.
 */
const CATALOGUE = [
  { key: 'first_try', icon: '⭐', label: 'first try' },
  { key: 'ten_attempts', icon: '🏅', label: 'ten tries' },
  { key: 'fifty_attempts', icon: '🏆', label: 'fifty tries' },
  { key: 'first_session', icon: '🚩', label: 'first chat' },
  { key: 'five_sessions', icon: '🚀', label: 'five chats' },
  { key: 'three_days', icon: '☀️', label: 'three days' },
  { key: 'explorer', icon: '🧭', label: 'explorer' },
] as const;

export default function Stars() {
  const { api, child } = useApp();

  const progress = useResource(
    async () =>
      await api.get<{ achievements: { key: string; title: string }[] }>(
        `/api/practice/progress?childId=${child.childId ?? ''}`,
      ),
    [api, child.childId],
  );

  if (progress.failure)
    return (
      <Screen testID="screen-stars">
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
      <Screen testID="screen-stars">
        <Thinking slug={child.characterSlug} />
      </Screen>
    );

  const earned = progress.data?.achievements ?? [];
  const held = new Set(earned.map((achievement) => achievement.key));

  return (
    <Screen scroll testID="screen-stars" padding={20}>
      <Title>My stars</Title>

      <View style={[gridStyles.grid, { marginTop: 18 }]}>
        {CATALOGUE.map((badge) => (
          <BadgeTile
            key={badge.key}
            testID={`badge-${badge.key}`}
            icon={badge.icon}
            label={earned.find((a) => a.key === badge.key)?.title ?? badge.label}
            earned={held.has(badge.key)}
          />
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
