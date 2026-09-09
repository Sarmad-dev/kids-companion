import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { ChildSummary, ConsentStatus } from '../../src/api/client';
import {
  Avatar,
  Card,
  FriendlyError,
  QuietButton,
  Screen,
  Thinking,
  Title,
  gridStyles,
} from '../../src/components/child/index';
import { useResource } from '../../src/hooks/use-resource';
import { useApp } from '../../src/state/app-context';
import { childTheme } from '../../src/theme/child-theme';
import { fonts } from '../../src/theme/fonts';

/**
 * Who's playing?
 *
 * Cards carry the avatar FIRST and the name second, because a pre-reader picks
 * by face. "Add another child" is dashed and muted so it never competes with a
 * child's own tile, and the empty state routes to a grown-up rather than
 * showing a child an empty screen and no way out of it.
 */
export default function ChildSelect() {
  const { api, online, setChild } = useApp();
  const [checking, setChecking] = useState(false);

  const children = useResource(
    async () => await api.get<{ items: ChildSummary[] }>('/v1/children'),
    [api, online],
  );

  /**
   * Choosing a child, via the consent gate.
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * WHY THE CHECK HAPPENS HERE AND NOT AT THE TALK BUTTON
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Conversation is gated by an RLS policy on `conversations`, so a child whose
   * consent is unsatisfied does not fail at "Talk" with something a four-year-old
   * could act on — they fail with a refusal from the database. Asking here, where
   * a parent may still be holding the phone, is the only point in the flow where
   * the answer can actually be given.
   *
   * A status we could not READ does not block play. The database is the gate
   * either way, and treating an unreachable check as a refusal would keep a
   * child out of a conversation they are entitled to.
   */
  const choose = async (kid: ChildSummary) => {
    setChild({ childId: kid.id, childName: kid.displayName });
    setChecking(true);
    const status = await api.get<ConsentStatus>(`/v1/children/${kid.id}/consent-status`);
    setChecking(false);

    const blocked =
      status.ok &&
      status.data !== undefined &&
      !status.data.conversationAllowed &&
      status.data.blockedReason === 'consent';

    if (blocked) {
      router.push('/(parent)/gate');
      return;
    }
    router.push('/(child)/character-select');
  };

  if (children.failure)
    return (
      <Screen testID="screen-child-select">
        <FriendlyError
          message={children.failure.message}
          slug={undefined}
          {...(children.failure.retryable ? { onRetry: children.reload } : {})}
        />
      </Screen>
    );

  if (children.loading || checking)
    return (
      <Screen testID="screen-child-select">
        <Thinking slug={undefined} />
      </Screen>
    );

  const items = children.data?.items ?? [];

  if (items.length === 0)
    return (
      <Screen testID="screen-child-select">
        <Title>Who&apos;s playing?</Title>
        <View style={styles.empty}>
          <View style={styles.emptyDisc}>
            <Text style={styles.emptyFace}>🙂</Text>
          </View>
          <Text style={styles.emptyLine}>Nobody is set up yet. A grown-up can add you.</Text>
          <QuietButton
            label="Get a grown-up"
            face="🔒"
            fullWidth={false}
            onPress={() => {
              router.push('/(child)/handoff');
            }}
            testID="get-a-grownup"
          />
        </View>
      </Screen>
    );

  return (
    <Screen scroll testID="screen-child-select">
      <Title>Who&apos;s playing?</Title>
      <View style={[gridStyles.grid, styles.grid]}>
        {items.map((kid) => (
          <Card
            key={kid.id}
            testID={`child-${kid.id}`}
            style={styles.kidCard}
            onPress={() => {
              void choose(kid);
            }}
          >
            <Avatar slug={kid.avatarKey} size={110} />
            <Text style={styles.kidName}>{kid.displayName}</Text>
          </Card>
        ))}

        {/* Dashed and muted, so it never competes with a child's own face. */}
        <Pressable
          testID="add-another-child"
          accessibilityRole="button"
          accessibilityLabel="Add another child"
          style={styles.addCardWrap}
          onPress={() => {
            router.push('/(child)/handoff');
          }}
        >
          <View style={styles.addCard}>
            <View style={styles.addDisc}>
              <Text style={styles.addPlus}>➕</Text>
            </View>
            <Text style={styles.addLabel}>Add another child</Text>
          </View>
        </Pressable>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  grid: { marginTop: childTheme.spacing.lg },

  kidCard: {
    minHeight: 168,
    alignItems: 'center',
    justifyContent: 'center',
    gap: childTheme.spacing.sm + 4,
    paddingVertical: 18,
  },
  kidName: {
    fontFamily: fonts.child.bold,
    fontSize: childTheme.text.body,
    color: childTheme.colors.ink,
  },

  addCardWrap: { flexGrow: 1, flexBasis: '46%' },
  addCard: {
    minHeight: 168,
    borderRadius: childTheme.radii.bigCard,
    backgroundColor: childTheme.colors.mutedSoft,
    borderWidth: 2,
    borderStyle: 'dashed',
    borderColor: '#d8cbb0',
    alignItems: 'center',
    justifyContent: 'center',
    gap: childTheme.spacing.sm + 4,
    padding: 18,
  },
  addDisc: {
    width: 110,
    height: 110,
    borderRadius: 55,
    backgroundColor: childTheme.colors.muted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addPlus: { fontSize: 44 },
  addLabel: {
    fontFamily: fonts.child.bold,
    fontSize: childTheme.text.aside,
    color: childTheme.colors.inkSoft,
    textAlign: 'center',
  },

  empty: {
    marginTop: 40,
    alignItems: 'center',
    gap: childTheme.spacing.lg - 4,
  },
  emptyDisc: {
    width: 132,
    height: 132,
    borderRadius: 66,
    backgroundColor: '#f5ecd9',
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyFace: { fontSize: 56 },
  emptyLine: {
    fontFamily: fonts.child.regular,
    fontSize: childTheme.text.body,
    lineHeight: childTheme.text.body * 1.4,
    color: childTheme.colors.inkSoft,
    textAlign: 'center',
    maxWidth: 250,
  },
});
