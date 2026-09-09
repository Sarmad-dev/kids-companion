import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { CharacterSummary } from '../../src/api/client';
import {
  Avatar,
  Aside,
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
import { castMember, childTheme } from '../../src/theme/child-theme';
import { fonts } from '../../src/theme/fonts';

/**
 * Who shall we play with?
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * A CHARACTER A PARENT HAS TURNED OFF IS DIMMED, NOT HIDDEN
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The card keeps its place, its face and its colour at 55%, and says
 * "🌙 Not today". No lock icon drama, no price, no plan name, nothing to want —
 * a child is never told they were restricted, or by whom, and is certainly
 * never shown something they must ask a grown-up to buy.
 *
 * Each card is filled with the character's OWN colour and carries its own face,
 * so hue is never the only signal.
 */
export default function CharacterSelect() {
  const { api, child, setChild } = useApp();

  const characters = useResource(
    async () =>
      await api.get<{ items: CharacterSummary[] }>(
        child.childId === undefined ? '/v1/characters' : `/v1/characters?childId=${child.childId}`,
      ),
    [api, child.childId],
  );

  if (characters.failure)
    return (
      <Screen testID="screen-character-select">
        <FriendlyError
          message={characters.failure.message}
          slug={child.characterSlug}
          {...(characters.failure.retryable ? { onRetry: characters.reload } : {})}
        />
      </Screen>
    );

  if (characters.loading)
    return (
      <Screen testID="screen-character-select">
        <Thinking slug={child.characterSlug} />
      </Screen>
    );

  const items = characters.data?.items ?? [];
  // `available` is absent on an older server; absent means allowed, because the
  // server is the gate either way and dimming a character we simply could not
  // ask about would take a friend away for no reason.
  const anyLocked = items.some((c) => c.available === false);
  const open = items.filter((c) => c.available !== false).map((c) => castMember(c.slug).short);

  return (
    <Screen scroll testID="screen-character-select" padding={20}>
      <Title>Who shall we play with?</Title>

      <View style={[gridStyles.grid, styles.grid]}>
        {items.map((character) => {
          const locked = character.available === false;
          const member = castMember(character.slug);
          return (
            <Pressable
              key={character.id}
              testID={`character-${character.slug}`}
              accessibilityRole="button"
              accessibilityLabel={
                locked ? `${member.name}, resting today` : `Play with ${member.name}`
              }
              accessibilityState={{ disabled: locked }}
              disabled={locked}
              style={styles.cardWrap}
              onPress={() => {
                setChild({ characterSlug: character.slug, characterId: character.id });
                router.push({
                  pathname: '/(child)/character/[slug]',
                  params: { slug: character.slug },
                });
              }}
            >
              {({ pressed }) => (
                <View
                  style={[
                    styles.card,
                    childTheme.shadows.raised,
                    { backgroundColor: member.colour },
                    locked && styles.locked,
                    pressed && !locked && styles.pressed,
                  ]}
                >
                  <Avatar slug={character.slug} size={110} />
                  <Text style={styles.name}>{member.name}</Text>
                  {locked && (
                    <View style={styles.restBadge}>
                      <Text style={styles.restText}>🌙 Not today</Text>
                    </View>
                  )}
                </View>
              )}
            </Pressable>
          );
        })}
      </View>

      {anyLocked && open.length > 0 && (
        <View style={styles.restingLine}>
          <Aside>
            Some friends are resting. {open.join(' and ')} {open.length === 1 ? 'is' : 'are'} here
            to play!
          </Aside>
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
  grid: { marginTop: childTheme.spacing.lg - 4 },
  cardWrap: { flexGrow: 1, flexBasis: '46%' },
  card: {
    minHeight: 196,
    borderRadius: childTheme.radii.bigCard,
    alignItems: 'center',
    justifyContent: 'center',
    gap: childTheme.spacing.sm + 2,
    paddingVertical: childTheme.spacing.md,
    paddingHorizontal: childTheme.spacing.sm,
  },
  locked: { opacity: 0.55 },
  pressed: { opacity: 0.9 },
  name: {
    fontFamily: fonts.child.heavy,
    fontSize: childTheme.text.body,
    color: '#ffffff',
    textAlign: 'center',
    textShadowColor: 'rgba(58,42,20,0.28)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 2,
  },
  restBadge: {
    position: 'absolute',
    top: 12,
    right: 12,
    backgroundColor: childTheme.colors.background,
    borderRadius: childTheme.radii.pill,
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  restText: {
    fontFamily: fonts.child.bold,
    fontSize: 14,
    color: childTheme.colors.inkSoft,
  },
  restingLine: { marginTop: childTheme.spacing.md },
});
