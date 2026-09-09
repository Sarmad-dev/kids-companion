import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useReducer, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { PracticeAttempt, PracticeExercise, PracticeSession } from '../../../src/api/client';
import { failureFor } from '../../../src/api/errors';
import {
  Avatar,
  Float,
  FriendlyError,
  QuietButton,
  Screen,
  Spacer,
  TalkButton,
  Thinking,
} from '../../../src/components/child/index';
import { initialTalkContext, talkReducer } from '../../../src/hooks/recorder-machine';
import { useResource } from '../../../src/hooks/use-resource';
import { useApp } from '../../../src/state/app-context';
import { childTheme, feedbackBand } from '../../../src/theme/child-theme';
import { fonts } from '../../../src/theme/fonts';
import { talkVisual } from '../../../src/theme/talk-states';

/**
 * Practice: one word at a time.
 *
 * The target is the biggest thing on the screen, in a white card with its
 * syllables as chips underneath. The character demonstrates; the talk button
 * sits exactly where it sits on the conversation screen, because it is the same
 * button doing the same job and a child should not have to find it twice.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE KICKER IS THE ONLY THING THAT CHANGES BETWEEN "LISTEN" AND "YOUR TURN"
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * No countdown, no "3, 2, 1", no timer bar. A child who is not ready simply has
 * not pressed the button yet, and a screen that hurries them is a screen that
 * teaches them speaking is a test.
 */
export default function Practice() {
  const { exerciseKey, index } = useLocalSearchParams<{ exerciseKey: string; index?: string }>();
  const { api, audio, child, online } = useApp();

  const position = Number.parseInt(index ?? '0', 10);
  const targetIndex = Number.isInteger(position) && position >= 0 ? position : 0;

  const [talk, dispatch] = useReducer(talkReducer, initialTalkContext);
  const [session, setSession] = useState<PracticeSession | undefined>();
  const sessionRef = useRef<string | undefined>(undefined);

  const exercises = useResource(
    async () =>
      await api.get<{ items: PracticeExercise[] }>(
        `/api/practice/exercises?childId=${child.childId ?? ''}`,
      ),
    [api, child.childId],
  );

  const exercise = exercises.data?.items.find((item) => item.exerciseKey === exerciseKey);
  const target = exercise?.targets[targetIndex];

  /* One session per visit to the exercise, reused across every word in it.
   * `attemptNumber` and the session average only mean anything if the whole
   * drill is one session — starting a new one per word would report six
   * sessions of one attempt each on the parent's practice screen. */
  useEffect(() => {
    if (child.childId === undefined) return;
    if (sessionRef.current !== undefined) return;

    let cancelled = false;
    void api
      .post<PracticeSession>('/api/practice/sessions', {
        childId: child.childId,
        exerciseKey,
      })
      .then((result) => {
        if (cancelled || !result.ok || result.data === undefined) return;
        sessionRef.current = result.data.id;
        setSession(result.data);
      });

    return () => {
      cancelled = true;
    };
  }, [api, child.childId, exerciseKey]);

  const submit = async () => {
    const recorded = await audio.stopRecording();
    const sessionId = sessionRef.current;

    if (!recorded || sessionId === undefined || target === undefined) {
      dispatch({ type: 'FAILED', failure: failureFor('nothing_heard') });
      return;
    }

    try {
      const result = await api.uploadFile<PracticeAttempt>(
        `/api/practice/sessions/${sessionId}/attempts`,
        {
          uri: recorded.uri,
          fieldName: 'audio',
          mimeType: recorded.mimeType,
          fields: { sequence: String(target.sequence) },
        },
      );

      if (!result.ok || result.data === undefined) {
        dispatch({ type: 'FAILED', failure: result.failure ?? failureFor('unknown') });
        return;
      }

      const band = feedbackBand(result.data.feedback.band);
      const feedback = `/(child)/practice/feedback?exerciseKey=${encodeURIComponent(
        exerciseKey,
      )}&index=${String(targetIndex)}&band=${band}&word=${encodeURIComponent(target.text)}`;

      // A badge earned on this attempt gets its OWN calm moment first, and then
      // hands back to the feedback band. Two celebrations on one screen is
      // neither, and the badge is the rarer of the two.
      const earned = result.data.newAchievements[0];
      if (earned !== undefined) {
        router.replace({
          pathname: '/(child)/achievement',
          params: { title: earned.title, next: feedback },
        });
        return;
      }

      router.replace({
        pathname: '/(child)/practice/feedback',
        params: {
          exerciseKey,
          index: String(targetIndex),
          band,
          word: target.text,
        },
      });
    } finally {
      // ALWAYS. A child's voice in a cache directory is the data the server
      // refuses to keep, and a phone is a device that gets lost.
      await audio.discard(recorded.uri);
    }
  };

  const press = () => {
    if (talk.state === 'recording') {
      dispatch({ type: 'PRESS' });
      void submit();
      return;
    }
    dispatch({ type: 'PRESS' });
    void (async () => {
      const outcome = await audio.requestPermission();
      if (outcome !== 'granted') {
        dispatch({ type: 'PERMISSION_DENIED' });
        return;
      }
      try {
        await audio.startRecording();
        dispatch({ type: 'PERMISSION_GRANTED' });
      } catch {
        dispatch({ type: 'FAILED', failure: failureFor('microphone_blocked') });
      }
    })();
  };

  if (exercises.failure)
    return (
      <Screen testID="screen-practice">
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

  if (exercises.loading || session === undefined)
    return (
      <Screen testID="screen-practice">
        <Thinking slug={child.characterSlug} />
      </Screen>
    );

  // Past the last word: the drill is finished, and finishing it is what records
  // the session on the parent's practice screen.
  if (target === undefined) {
    router.replace({
      pathname: '/(child)/practice/done',
      params: {
        words: (exercise?.targets ?? []).map((t) => t.text).join('|'),
        kind: exercise?.kind ?? 'word',
      },
    });
    return (
      <Screen testID="screen-practice">
        <Thinking slug={child.characterSlug} />
      </Screen>
    );
  }

  if (talk.state === 'failed' && talk.failure !== undefined)
    return (
      <Screen testID="screen-practice">
        <FriendlyError
          message={talk.failure.message}
          slug={child.characterSlug}
          onHome={() => {
            router.replace('/(child)/home');
          }}
          onRetry={() => {
            dispatch({ type: 'RESET' });
          }}
        />
      </Screen>
    );

  const visual = talkVisual(talk.state, child.characterSlug, online);

  return (
    <Screen testID="screen-practice" background="#eaf4ff" style={styles.screen} padding={24}>
      <Text style={styles.kicker}>
        {talk.state === 'recording' ? 'Your turn — say it!' : 'Say it after me'}
      </Text>

      <View style={[styles.wordCard, childTheme.shadows.bubble]}>
        <Text style={styles.word}>{target.text}</Text>
        <View style={styles.syllables}>
          {target.syllables.map((syllable, i) => (
            /* Syllables repeat inside a word ("ba·na·na"), so position is
             * part of the only honest key here. */
            <View key={`${syllable}-${String(i)}`} style={styles.chip}>
              <Text style={styles.chipText}>{syllable}</Text>
            </View>
          ))}
        </View>
      </View>

      <Float style={styles.character}>
        <Avatar slug={child.characterSlug} size={120} />
      </Float>

      <Spacer />

      <TalkButton
        face={visual.face}
        label={visual.label}
        fill={visual.fill}
        breathing={visual.breathing}
        tappable={visual.tappable}
        onPress={press}
        testID="practice-talk-button"
      />
      <QuietButton
        label="Go home"
        face="🏠"
        fullWidth={false}
        style={styles.home}
        onPress={() => {
          router.replace('/(child)/home');
        }}
        testID="home-button"
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  screen: { alignItems: 'center' },
  kicker: {
    fontFamily: fonts.child.bold,
    fontSize: 16,
    color: childTheme.colors.inkSoft,
  },
  wordCard: {
    width: '100%',
    marginTop: 12,
    backgroundColor: childTheme.colors.surface,
    borderRadius: 28,
    paddingVertical: 22,
    paddingHorizontal: childTheme.spacing.lg + 2,
    alignItems: 'center',
    gap: childTheme.spacing.sm,
  },
  word: {
    fontFamily: fonts.child.heavy,
    fontSize: childTheme.text.hero,
    lineHeight: childTheme.text.hero * 1.2,
    color: childTheme.colors.ink,
  },
  syllables: { flexDirection: 'row', gap: childTheme.spacing.sm, flexWrap: 'wrap' },
  chip: {
    borderRadius: childTheme.radii.pill,
    backgroundColor: '#eaf4ff',
    paddingVertical: 6,
    paddingHorizontal: 14,
  },
  chipText: { fontFamily: fonts.child.bold, fontSize: 16, color: '#1a4fa0' },
  character: { marginTop: childTheme.spacing.md },
  home: { marginTop: childTheme.spacing.md },
});
