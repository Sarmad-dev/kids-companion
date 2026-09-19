import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { ApiClient, Turn } from '../../src/api/client';
import { failureFor, type FriendlyFailure } from '../../src/api/errors';
import {
  FriendlyError,
  PromptPill,
  QuietButton,
  Screen,
  SpeechBubble,
  TalkButton,
  Thinking,
} from '../../src/components/child/index';
import { ActionBar, MusicToggle } from '../../src/components/child/InteractionControls';
import { storySeedFor } from '../../src/content/story-seeds';
import { initialTalkContext, talkReducer, type TalkState } from '../../src/hooks/recorder-machine';
import { useBackgroundMusic } from '../../src/hooks/use-background-music';
import { useApp } from '../../src/state/app-context';
import { childTheme, DEFAULT_CHARACTER } from '../../src/theme/child-theme';
import { fonts } from '../../src/theme/fonts';
import { showsPrompt, talkVisual } from '../../src/theme/talk-states';
import {
  type ActionRequest,
  type CharacterAction,
  POKE_ACTIONS,
  talkingMsFor,
} from '../../src/three/actions';
import { ProceduralDiorama } from '../../src/three/ProceduralDiorama';

/**
 * The loop.
 *
 *   character → child speaks → AI responds → character speaks
 *
 * One implementation, used by chat, by voice and by story mode — the mode
 * changes the frame, not the mechanics. The state machine is in
 * `recorder-machine.ts` and is unit-tested; this route is the thin part that
 * draws it and moves bytes.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE DIORAMA IS THE SCREEN
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * It runs edge to edge behind the status bar, and every control floats on top
 * of it. `pointerEvents="box-none"` on the overlay is what keeps that from
 * being a trade: the layers that only carry text let a drag through to the
 * canvas underneath, so a child can spin the character by dragging anywhere the
 * buttons are not — which is the first thing every child tries.
 *
 * Every text element carries its OWN background, because what is behind it is a
 * moving 3D set rather than a known colour.
 */

/**
 * Ends conversations a previous session left `active`.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THE UNMOUNT CLEANUP IS NOT ENOUGH ON ITS OWN
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Ending a conversation when the screen closes handles the child walking away.
 * It does NOT handle the app being killed from the task switcher, the phone
 * running out of battery, or the network dying before the request lands — and
 * in every one of those the row stays `active` forever, because nothing on the
 * server sweeps it.
 *
 * With `concurrent_conversation_limit` of 1 on the free plan, ONE such death
 * locks the child out permanently: every later tap is refused, and the sentence
 * they are shown — "Let's play again a bit later!" — never stops being true.
 * Waiting for a grown-up to notice is not a recovery strategy, so the limit is
 * treated as a repairable condition rather than as a wall.
 */
const reclaimAbandoned = async (api: ApiClient, childId: string): Promise<void> => {
  const existing = await api.get<{ items: readonly { id: string; status: string }[] }>(
    `/api/conversations?childId=${childId}&limit=20`,
  );
  if (!existing.ok || !existing.data) return;

  for (const conversation of existing.data.items) {
    if (conversation.status !== 'active') continue;
    // Idempotent server-side, so racing another device is harmless.
    await api.post(`/api/conversations/${conversation.id}/end`, { reason: 'child_ended' });
  }
};

export default function Conversation() {
  const { mode, seed } = useLocalSearchParams<{ mode?: string; seed?: string }>();
  const isStory = mode === 'story';
  const { api, audio, child, online } = useApp();
  const insets = useSafeAreaInsets();
  const slug = child.characterSlug ?? DEFAULT_CHARACTER;

  const [talk, dispatch] = useReducer(talkReducer, initialTalkContext);
  const [conversationId, setConversationId] = useState<string | undefined>();
  const [starting, setStarting] = useState(true);

  /** The conversation this screen owns, in a ref so the cleanup can end it even
   * when the id arrived after the child had already left. */
  const startedId = useRef<string | undefined>(undefined);

  /**
   * Why the conversation never opened, kept so the talk button can repeat it.
   *
   * Without this the child presses Talk, records, and is told "I didn't quite
   * catch that" — their voice blamed for a failure that happened before they
   * said anything.
   */
  const startFailure = useRef<FriendlyFailure | undefined>(undefined);

  /** The move the child last asked for; a new nonce replays even the same move. */
  const [action, setAction] = useState<ActionRequest | undefined>();
  const playAction = useCallback((kind: CharacterAction) => {
    setAction((current) => ({ kind, nonce: (current?.nonce ?? 0) + 1 }));
  }, []);
  // Cycles rather than picks at random: a child tapping the character wants to
  // see it do something DIFFERENT each time, and a random pick repeats.
  const pokes = useRef(0);
  const poke = useCallback(() => {
    const kind = POKE_ACTIONS[pokes.current % POKE_ACTIONS.length];
    pokes.current += 1;
    if (kind !== undefined) playAction(kind);
  }, [playAction]);

  /**
   * Whether the mouth should move for a reply that has no audio.
   *
   * `speaking` only exists while a clip is playing, so a text-only reply (every
   * story opening, and any turn the voice service could not synthesise) would
   * otherwise leave the character silent-mouthed while the caption talks.
   */
  const [captionTalking, setCaptionTalking] = useState(false);
  useEffect(() => {
    if (talk.reply === undefined || talk.state !== 'idle') return undefined;
    setCaptionTalking(true);
    const timer = setTimeout(() => {
      setCaptionTalking(false);
    }, talkingMsFor(talk.reply));
    return () => {
      clearTimeout(timer);
    };
  }, [talk.reply, talk.state]);

  const music = useBackgroundMusic(talk.state, slug);

  useEffect(() => {
    let cancelled = false;
    /* The mode is the whole difference between a chat and a story on the
     * server: it changes the prompt, it is what the weekly story limit counts,
     * and finishing one is what records a story on the parent's dashboard. */
    const body = {
      childId: child.childId,
      mode: isStory ? 'story' : 'chat',
      // Honours the character the child actually picked. Omitted rather than
      // sent as undefined, because the server treats absence as "you choose".
      ...(child.characterId === undefined ? {} : { characterId: child.characterId }),
    };

    /**
     * Opens a story with the picture the child chose.
     *
     * The seed goes in as the child's first message on the TEXT endpoint, which
     * is the one path in the product that takes words rather than audio. That
     * keeps the whole thing inside machinery that already exists — safety
     * screening, quotas, retention, the lot — instead of adding a story-topic
     * column and a second way for text to reach the model.
     *
     * A seed that fails is not worth telling a child about: they still have a
     * story conversation and a character waiting to be talked to, which is what
     * they came for.
     */
    const openWithSeed = async (id: string): Promise<void> => {
      const chosen = storySeedFor(seed);
      if (!isStory || chosen === undefined) return;

      dispatch({ type: 'PRESS' });
      dispatch({ type: 'PERMISSION_GRANTED' });
      dispatch({ type: 'RECORDING_STOPPED' });

      const opened = await api.post<{ reply: string; status: string }>(
        `/api/conversations/${id}/message`,
        { text: chosen.opening },
      );
      if (cancelled) return;

      if (opened.ok && opened.data !== undefined) {
        dispatch({ type: 'REPLY', reply: opened.data.reply, hasAudio: false });
      } else {
        dispatch({ type: 'RESET' });
      }
    };

    const openConversation = async (): Promise<void> => {
      let result = await api.post<{ id: string }>('/api/conversations/start', body);

      // The only quota worth arguing with: it says a conversation is already
      // open, and the one thing this child cannot do is close it.
      if (!result.ok && result.failure?.code === 'QUOTA_CONCURRENT_CONVERSATIONS') {
        if (child.childId !== undefined) await reclaimAbandoned(api, child.childId);
        result = await api.post<{ id: string }>('/api/conversations/start', body);
      }

      if (result.ok && result.data) {
        startedId.current = result.data.id;
        // Left while the request was still in flight. The conversation exists on
        // the server regardless, so end it now rather than orphan it.
        if (cancelled) {
          void api.post(`/api/conversations/${result.data.id}/end`, { reason: 'child_ended' });
          return;
        }
        setStarting(false);
        setConversationId(result.data.id);
        void openWithSeed(result.data.id);
        return;
      }

      if (cancelled) return;
      setStarting(false);
      const failure = result.failure ?? failureFor('unknown');
      startFailure.current = failure;
      dispatch({ type: 'FAILED', failure });
    };

    void openConversation();

    return () => {
      cancelled = true;
      const id = startedId.current;
      startedId.current = undefined;
      // Walking away from the screen is how a four-year-old ends a
      // conversation; it therefore has to be what ends the conversation.
      // Idempotent server-side, so a double-end is harmless.
      if (id !== undefined) {
        void api.post(`/api/conversations/${id}/end`, { reason: 'child_ended' });
      }
    };
  }, [api, child.childId, child.characterId, isStory, seed]);

  const begin = async () => {
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
  };

  const finishTurn = async () => {
    const recorded = await audio.stopRecording();

    // Two different failures that used to share one sentence. Only the second is
    // about what the child said.
    if (conversationId === undefined) {
      dispatch({ type: 'FAILED', failure: startFailure.current ?? failureFor('unknown') });
      return;
    }
    if (!recorded) {
      dispatch({ type: 'FAILED', failure: failureFor('nothing_heard') });
      return;
    }

    try {
      // The platform moves the bytes; see src/api/expo-upload.ts.
      const result = await api.uploadFile<Turn>('/api/voice/turns', {
        uri: recorded.uri,
        fieldName: 'audio',
        mimeType: recorded.mimeType,
        fields: { conversationId },
      });

      if (!result.ok || !result.data) {
        dispatch({ type: 'FAILED', failure: result.failure ?? failureFor('unknown') });
        return;
      }

      const turn = result.data;

      if (turn.status === 'unintelligible' || turn.status === 'rejected') {
        dispatch({ type: 'FAILED', failure: failureFor('nothing_heard') });
        return;
      }

      // The session limit exists to END the session, so it does: a warm goodbye
      // with nothing tappable on it that would extend things.
      if (turn.status === 'ended') {
        dispatch({ type: 'REPLY', reply: turn.reply, hasAudio: turn.audio != null });
        if (turn.audio != null) {
          await audio.play(await api.mediaSource(`/api/voice/audio/${turn.audio.key}`));
        }
        router.replace('/(child)/times-up');
        return;
      }

      dispatch({ type: 'REPLY', reply: turn.reply, hasAudio: turn.audio != null });

      if (turn.audio != null) {
        // Absolute, and carrying the session token: the player fetches this
        // itself, so it gets neither the base url nor the authorization header
        // that `api.post` would have added. See `mediaSource`.
        await audio.play(await api.mediaSource(`/api/voice/audio/${turn.audio.key}`));
        dispatch({ type: 'PLAYBACK_FINISHED' });
      }
    } finally {
      // ALWAYS, on every path including the failures above. A child's voice
      // sitting in a cache directory is the data the server refuses to keep,
      // and a phone is a device that gets lost.
      await audio.discard(recorded.uri);
    }
  };

  const press = () => {
    if (talk.state === 'recording') {
      dispatch({ type: 'PRESS' });
      void finishTurn();
      return;
    }
    if (talk.state === 'speaking') void audio.stopPlayback();

    // Nothing to talk INTO. Recording here would end at the check in
    // `finishTurn` and surface as "I didn't quite catch that", which tells a
    // child their voice was the problem when the session never opened at all.
    if (conversationId === undefined) {
      dispatch({ type: 'FAILED', failure: startFailure.current ?? failureFor('unknown') });
      return;
    }

    dispatch({ type: 'PRESS' });
    void begin();
  };

  const leave = () => {
    void audio.stopPlayback();
    router.replace('/(child)/home');
  };

  if (starting)
    return (
      <Screen testID="screen-conversation-loading">
        <Thinking slug={slug} />
      </Screen>
    );

  // A failure that is not about this turn gets the whole screen: the character,
  // one warm sentence, and a way out. Nothing about the 3D set helps here.
  if (talk.state === 'failed' && talk.failure !== undefined && talk.reply === undefined) {
    return (
      <Screen testID="screen-conversation">
        <FriendlyError
          message={talk.failure.message}
          slug={slug}
          onHome={leave}
          {...(talk.failure.retryable
            ? {
                onRetry: () => {
                  dispatch({ type: 'RESET' });
                },
              }
            : {})}
        />
      </Screen>
    );
  }

  const visual = talkVisual(talk.state, slug, online);
  // The character's mouth follows the words, not only the audio clip.
  const stageState: TalkState = talk.state === 'idle' && captionTalking ? 'speaking' : talk.state;
  const listening = talk.state === 'recording' || talk.state === 'requesting_permission';
  const prompt = isStory ? 'Shall we make a story?' : 'What shall we talk about?';

  return (
    <View style={styles.stage} testID={isStory ? 'screen-story' : 'screen-conversation'}>
      <ProceduralDiorama
        slug={slug}
        talkState={stageState}
        action={action}
        onPoke={poke}
        testID="character-scene"
      />

      <View
        style={[styles.overlay, { paddingTop: insets.top + 16, paddingBottom: insets.bottom + 16 }]}
        pointerEvents="box-none"
      >
        <View style={styles.top} pointerEvents="box-none">
          <View style={styles.topRow} pointerEvents="box-none">
            <QuietButton
              label="Go home"
              face="🏠"
              fullWidth={false}
              onPress={leave}
              testID="home-button"
              style={styles.homePill}
            />
            <MusicToggle enabled={music.enabled} onToggle={music.toggle} />
          </View>

          <View style={styles.speech} pointerEvents="none">
            {isStory && (
              <View style={styles.ribbon}>
                <Text style={styles.ribbonText}>📖 Our story</Text>
              </View>
            )}
            {showsPrompt(talk.state) && talk.reply === undefined ? (
              <PromptPill text={prompt} testID="prompt-pill" />
            ) : null}
            {talk.reply !== undefined && <SpeechBubble text={talk.reply} testID="reply-bubble" />}
            {talk.state === 'failed' && talk.failure !== undefined && (
              <SpeechBubble text={talk.failure.message} testID="apology-bubble" />
            )}
          </View>
        </View>

        <View style={styles.controls} pointerEvents="box-none">
          <ActionBar onAction={playAction} disabled={listening} />
          <TalkButton
            face={visual.face}
            label={visual.label}
            fill={visual.fill}
            breathing={visual.breathing}
            tappable={visual.tappable}
            onPress={press}
          />
        </View>
      </View>
    </View>
  );
}

/**
 * Fills the parent, as a plain style object.
 *
 * `StyleSheet.absoluteFill` is a registered style ID rather than an object, so
 * it cannot be spread into one; `absoluteFillObject` is absent from this
 * version's typings. Writing the four edges out is the version that compiles
 * and is the version that will keep compiling.
 */
const FILL_PARENT = { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 } as const;

const styles = StyleSheet.create({
  stage: { flex: 1, backgroundColor: childTheme.colors.background },
  overlay: {
    ...FILL_PARENT,
    justifyContent: 'space-between',
    paddingHorizontal: childTheme.spacing.lg,
  },
  top: { gap: childTheme.spacing.sm + 2 },
  topRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  speech: { alignItems: 'center', gap: childTheme.spacing.sm + 2 },
  controls: { alignItems: 'center', gap: 18 },
  /* Translucent, so the set is still visible through the one control that sits
   * over the middle of it. */
  homePill: { backgroundColor: 'rgba(255,246,229,0.86)' },
  ribbon: {
    backgroundColor: 'rgba(255,246,229,0.94)',
    borderRadius: childTheme.radii.pill,
    paddingVertical: 8,
    paddingHorizontal: 18,
    ...childTheme.shadows.card,
  },
  ribbonText: { fontFamily: fonts.child.bold, fontSize: 16, color: '#6b4a8f' },
});
