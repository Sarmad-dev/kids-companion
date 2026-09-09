import { router, useLocalSearchParams } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { Avatar, BigButton, Pop, Screen, Spacer } from '../../../src/components/child/index';
import { useApp } from '../../../src/state/app-context';
import { childTheme, FEEDBACK_BANDS, isFeedbackBand } from '../../../src/theme/child-theme';
import { fonts } from '../../../src/theme/fonts';

/**
 * Practice feedback.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * FOUR BANDS, ONE LAYOUT, NO FAILURE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Same size, same layout, same warmth, same character reaction. "Good try!"
 * looks exactly as pleased to see the child as "Perfect!" does — no red, no
 * cross, no score, no percentage, no "2 of 5". A four-year-old learning to say
 * "elephant" is not being assessed, and a screen that grades them teaches them
 * that speaking is something you can fail at.
 *
 * The real numbers — recognition rates, attempt counts, the disclaimer that
 * recognition measures our speech model rather than their mouth — live in the
 * parent app, where an adult can put them in context.
 */
export default function Feedback() {
  const { band, word, exerciseKey, index } = useLocalSearchParams<{
    band?: string;
    word?: string;
    exerciseKey?: string;
    index?: string;
  }>();
  const { child } = useApp();

  // A band we do not recognise lands on the kindest of the four. A child must
  // never meet a blank screen because a server added a fifth name.
  const tone = FEEDBACK_BANDS[isFeedbackBand(band) ? band : 'keepgoing'];
  const position = Number.parseInt(index ?? '0', 10);
  const current = Number.isInteger(position) && position >= 0 ? position : 0;

  const goTo = (next: number) => {
    router.replace({
      pathname: '/(child)/practice/[exerciseKey]',
      params: { exerciseKey: exerciseKey ?? '', index: String(next) },
    });
  };

  return (
    <Screen
      testID="screen-practice-feedback"
      background={tone.wash}
      style={styles.screen}
      padding={24}
    >
      <Pop>
        <View style={[styles.face, childTheme.shadows.raised, { backgroundColor: tone.colour }]}>
          <Text style={styles.faceGlyph}>{tone.face}</Text>
        </View>
      </Pop>

      <Text style={[styles.title, { color: tone.colour }]}>{tone.title}</Text>

      <View style={[styles.bubble, childTheme.shadows.card]}>
        <Text style={styles.bubbleText}>{tone.line}</Text>
      </View>

      <View style={[styles.wordRow, childTheme.shadows.card]}>
        <Avatar slug={child.characterSlug} size={56} />
        <Text style={styles.word}>{word ?? ''}</Text>
      </View>

      <Spacer />

      {/* Saying it again is offered FIRST and is never the smaller button —
          a child who wants another go should not have to hunt for it. */}
      <BigButton
        label="Say it again"
        face="🔄"
        size="medium"
        colour={childTheme.colors.surface}
        textColour={childTheme.colors.ink}
        onPress={() => {
          goTo(current);
        }}
        testID="say-again"
      />
      <BigButton
        label="Next word"
        face="👉"
        size="medium"
        colour={tone.colour}
        onPress={() => {
          goTo(current + 1);
        }}
        testID="next-word"
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  screen: { alignItems: 'center' },
  face: {
    width: 132,
    height: 132,
    borderRadius: 66,
    alignItems: 'center',
    justifyContent: 'center',
  },
  faceGlyph: { fontSize: 64 },
  title: {
    fontFamily: fonts.child.heavy,
    fontSize: childTheme.text.title,
    lineHeight: childTheme.text.title * 1.4,
    marginTop: childTheme.spacing.lg - 4,
  },
  bubble: {
    marginTop: 14,
    backgroundColor: childTheme.colors.surface,
    borderRadius: childTheme.radii.card,
    paddingVertical: 18,
    paddingHorizontal: childTheme.spacing.md + 4,
  },
  bubbleText: {
    fontFamily: fonts.child.regular,
    fontSize: childTheme.text.body,
    lineHeight: childTheme.text.body * 1.4,
    color: childTheme.colors.ink,
    textAlign: 'center',
  },
  wordRow: {
    marginTop: 22,
    flexDirection: 'row',
    alignItems: 'center',
    gap: childTheme.spacing.sm + 4,
    backgroundColor: childTheme.colors.surface,
    borderRadius: childTheme.radii.tile,
    paddingVertical: 12,
    paddingHorizontal: 18,
  },
  word: {
    fontFamily: fonts.child.bold,
    fontSize: childTheme.text.body,
    color: childTheme.colors.inkSoft,
  },
});
