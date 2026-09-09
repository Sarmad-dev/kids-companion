import { router } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import {
  Avatar,
  FriendlyError,
  GoHomeButton,
  ProgressBar,
  Screen,
  Spacer,
  Thinking,
  Title,
} from '../../src/components/child/index';
import { useResource } from '../../src/hooks/use-resource';
import { useApp } from '../../src/state/app-context';
import { childTheme } from '../../src/theme/child-theme';
import { fonts } from '../../src/theme/fonts';

/**
 * Look how you're growing!
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * NO NUMBERS. NO TOTALS. NO COMPARISONS.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Three bars that fill. A child seeing "12 of 50" learns they are behind; a
 * child seeing a bar that is fuller than last time learns they are growing, and
 * only one of those is true. There is no comparison to other children anywhere,
 * and the denominators below are deliberately arbitrary and unlabelled — they
 * exist so a bar can move, not so a child can work out a score.
 *
 * The real figures — with the caveat that none of it is an assessment of the
 * child — are a parent-mode surface, where an adult can read the caveat.
 */
const CEILINGS = { words: 50, chats: 20, practice: 40 } as const;

export default function Progress() {
  const { api, child } = useApp();

  const progress = useResource(
    async () =>
      await api.get<{
        vocabulary: { distinctWords: number };
        daily: { conversationCount: number; pronunciationAttempts: number }[];
      }>(`/api/parent/progress/${child.childId ?? ''}?days=30`),
    [api, child.childId],
  );

  if (progress.failure)
    return (
      <Screen testID="screen-progress">
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
      <Screen testID="screen-progress">
        <Thinking slug={child.characterSlug} />
      </Screen>
    );

  const data = progress.data;
  const chats = (data?.daily ?? []).reduce((sum, day) => sum + day.conversationCount, 0);
  const tries = (data?.daily ?? []).reduce((sum, day) => sum + day.pronunciationAttempts, 0);

  const rows = [
    {
      icon: '🔤',
      label: 'Words',
      fraction: (data?.vocabulary.distinctWords ?? 0) / CEILINGS.words,
      colour: childTheme.colors.professor,
    },
    {
      icon: '💬',
      label: 'Chats',
      fraction: chats / CEILINGS.chats,
      colour: childTheme.colors.accent,
    },
    {
      icon: '🗣️',
      label: 'Practice',
      fraction: tries / CEILINGS.practice,
      colour: childTheme.colors.captain,
    },
  ];

  return (
    <Screen testID="screen-progress" padding={24}>
      <Title>Look how you&apos;re growing!</Title>

      <View style={styles.character}>
        <Avatar slug={child.characterSlug} size={120} />
      </View>

      <View style={styles.rows}>
        {rows.map((row) => (
          <View key={row.label} style={styles.row} testID={`progress-${row.label.toLowerCase()}`}>
            <Text style={styles.rowLabel}>
              {row.icon} {row.label}
            </Text>
            <ProgressBar fraction={row.fraction} colour={row.colour} />
          </View>
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
  character: { alignSelf: 'center', marginTop: childTheme.spacing.md },
  rows: { gap: childTheme.spacing.lg + 2, marginTop: 30 },
  row: { gap: childTheme.spacing.sm + 2 },
  rowLabel: {
    fontFamily: fonts.child.bold,
    fontSize: childTheme.text.body,
    color: childTheme.colors.ink,
  },
});
