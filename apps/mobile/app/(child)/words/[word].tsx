import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text } from 'react-native';

import {
  Avatar,
  BigButton,
  Float,
  QuietButton,
  Screen,
  Spacer,
} from '../../../src/components/child/index';
import { useApp } from '../../../src/state/app-context';
import { castMember, childTheme } from '../../../src/theme/child-theme';
import { fonts } from '../../../src/theme/fonts';

/**
 * One word.
 *
 * One job: hear it again, in the character's voice. The button is in the
 * CHARACTER'S colour rather than the app accent, so a child knows whose voice
 * is about to come out of the phone before they press it.
 *
 * A synthesis that fails says nothing at all. There is no error state worth
 * having here: the child pressed a speaker, no sound came out, and a warm
 * apology about a word would be more confusing than silence.
 */
export default function WordDetail() {
  const { word } = useLocalSearchParams<{ word: string }>();
  const { api, audio, child } = useApp();
  const [busy, setBusy] = useState(false);
  const member = castMember(child.characterSlug);

  const hear = async () => {
    if (busy || child.childId === undefined) return;
    setBusy(true);
    try {
      const said = await api.post<{ key: string }>('/api/voice/say', {
        childId: child.childId,
        word,
        ...(child.characterId === undefined ? {} : { characterId: child.characterId }),
      });
      if (said.ok && said.data !== undefined) {
        await audio.play(await api.mediaSource(`/api/voice/audio/${said.data.key}`));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen testID="screen-word-detail" style={styles.screen} padding={24}>
      <Text style={styles.word}>{word}</Text>

      <Float style={styles.character}>
        <Avatar slug={child.characterSlug} size={160} />
      </Float>

      <BigButton
        label="Hear it again"
        face="🔊"
        colour={member.colour}
        disabled={busy}
        style={styles.hear}
        onPress={() => {
          void hear();
        }}
        testID="hear-word"
      />

      <Spacer />
      <QuietButton
        label="More words"
        face="🔤"
        fullWidth={false}
        onPress={() => {
          router.back();
        }}
        testID="more-words"
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  screen: { alignItems: 'center' },
  word: {
    fontFamily: fonts.child.heavy,
    fontSize: childTheme.text.hero,
    lineHeight: childTheme.text.hero * 1.3,
    color: childTheme.colors.ink,
    textAlign: 'center',
  },
  character: { marginTop: childTheme.spacing.lg + 2 },
  hear: { marginTop: 30 },
});
