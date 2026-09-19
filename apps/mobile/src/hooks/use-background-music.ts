import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from 'expo-audio';
import * as SecureStore from 'expo-secure-store';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { musicFor } from './character-music';
import type { TalkState } from './recorder-machine';

/**
 * The conversation screen's background music, with an on/off switch.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE MUSIC NEVER COMPETES WITH A VOICE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Three rules, all driven by the talk state rather than by the screen:
 *
 *   * It is PAUSED while the microphone is open. Otherwise the recording would
 *     capture the lullaby, and the transcript of a four-year-old's sentence
 *     would come back with a song stuck to it.
 *   * It DUCKS while the character is speaking, so a reply is always the
 *     loudest thing on the device.
 *   * It stops when the app is backgrounded and when the screen closes. Music
 *     that follows a child out of the app is the fastest way to get it deleted.
 *
 * The preference is remembered, and defaults to ON: the switch is the child's
 * (or a grown-up's) way to turn it off, not a step they must take to get it.
 */

const PREFERENCE_KEY = 'kc.music.enabled';
const VOLUME_NORMAL = 0.25;
const VOLUME_DUCKED = 0.07;

export const useBackgroundMusic = (
  talkState: TalkState,
  slug: string | undefined,
): { readonly enabled: boolean; readonly toggle: () => void } => {
  const [enabled, setEnabled] = useState(true);
  const [foreground, setForeground] = useState(AppState.currentState === 'active');
  const player = useRef<AudioPlayer | undefined>(undefined);
  const track = musicFor(slug);
  const playing = useRef<number | undefined>(undefined);

  // Read the saved choice once. Until it lands the default (on) applies, which
  // is the same answer for anyone who has never touched the switch.
  useEffect(() => {
    let active = true;
    void SecureStore.getItemAsync(PREFERENCE_KEY)
      .then((saved) => {
        if (active && saved === 'off') setEnabled(false);
      })
      .catch(() => {
        // An unreadable preference is not worth failing a child's screen for.
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      setForeground(next === 'active');
    });
    return () => {
      subscription.remove();
    };
  }, []);

  useEffect(
    () => () => {
      player.current?.pause();
      player.current?.remove();
      player.current = undefined;
    },
    [],
  );

  const recording = talkState === 'recording' || talkState === 'requesting_permission';
  const ducked = talkState === 'speaking';
  const shouldPlay = enabled && foreground && !recording;

  useEffect(() => {
    if (!shouldPlay) {
      player.current?.pause();
      return;
    }

    let cancelled = false;
    const start = async (): Promise<void> => {
      try {
        // The voice port switches the session to record mode and leaves it
        // there; playing music needs it back on the speaker.
        await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
        if (cancelled) return;
        // A different character is a different tune: drop the old player.
        if (playing.current !== track) {
          player.current?.pause();
          player.current?.remove();
          player.current = undefined;
        }
        if (player.current === undefined) {
          const created = createAudioPlayer(track);
          playing.current = track;
          created.loop = true;
          player.current = created;
        }
        player.current.volume = ducked ? VOLUME_DUCKED : VOLUME_NORMAL;
        player.current.play();
      } catch {
        // No music is a fine outcome. A screen that cannot play a lullaby is
        // still a screen a child can talk on.
      }
    };
    void start();

    return () => {
      cancelled = true;
    };
  }, [shouldPlay, ducked, track]);

  const toggle = useCallback(() => {
    setEnabled((current) => {
      const next = !current;
      void SecureStore.setItemAsync(PREFERENCE_KEY, next ? 'on' : 'off').catch(() => {
        // Remembered for this session either way.
      });
      return next;
    });
  }, []);

  return { enabled, toggle };
};
