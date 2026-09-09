import {
  AudioModule,
  createAudioPlayer,
  requestRecordingPermissionsAsync,
  RecordingPresets,
  setAudioModeAsync,
} from 'expo-audio';
import type { AudioPlayer, AudioRecorder } from 'expo-audio';

import type { AudioPort, PermissionOutcome, RecordedAudio } from './audio-port';

/**
 * The expo-audio implementation.
 *
 * ⚠️ NOT EXERCISED ON A DEVICE YET. The state machine above it is unit-tested
 * against the fake port; this adapter needs a real phone, a real microphone, and
 * a real child before it can be trusted.
 *
 * Recording settings are deliberately modest: a child's utterance is a few
 * seconds of speech, and higher fidelity costs upload time on a slow connection
 * for accuracy nobody gains.
 */
export interface ExpoAudioPortOptions {
  /**
   * Deletes a local file.
   *
   * Injected rather than imported so that DELETING A CHILD'S RECORDING never
   * depends on an optional package resolving. When it is absent the recording
   * still leaves the device on upload; what is lost is the belt-and-braces
   * cleanup of the cache copy, and that is a gap worth being explicit about
   * rather than a silent no-op hidden behind an import.
   */
  readonly deleteFile?: (uri: string) => Promise<void>;
}

export const createExpoAudioPort = (options: ExpoAudioPortOptions = {}): AudioPort => {
  let recorder: AudioRecorder | undefined;
  let player: AudioPlayer | undefined;

  return {
    requestPermission: async (): Promise<PermissionOutcome> => {
      const { granted } = await requestRecordingPermissionsAsync();
      return granted ? 'granted' : 'denied';
    },

    startRecording: async (): Promise<void> => {
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      const created = new AudioModule.AudioRecorder(RecordingPresets.LOW_QUALITY);
      await created.prepareToRecordAsync();
      created.record();
      recorder = created;
    },

    stopRecording: async (): Promise<RecordedAudio | undefined> => {
      const current = recorder;
      recorder = undefined;
      if (!current) return undefined;

      // READ THE DURATION BEFORE STOPPING.
      //
      // `RecorderState.durationMillis` is documented as the duration of the
      // CURRENT recording, and after `stop()` there is no current recording —
      // it reports 0. A turn that claims to be zero milliseconds long is then
      // refused by the server as too short to be speech (VOICE_MIN_DURATION_MS),
      // so every turn failed while the recording itself was fine.
      const durationMs = current.getStatus().durationMillis;

      await current.stop();
      const uri = current.uri;
      if (uri === null) return undefined;
      return {
        uri,
        mimeType: uri.endsWith('.wav') ? 'audio/wav' : 'audio/mp4',
        durationMs,
      };
    },

    discard: async (uri: string): Promise<void> => {
      // Best effort, and never fatal. A file that will not delete must not break
      // the child's turn — but it must be TRIED on every path, because a child's
      // voice sitting in a cache directory is the data the server refuses to keep.
      try {
        await options.deleteFile?.(uri);
      } catch {
        // Nothing useful to do, and nothing worth showing a child.
      }
    },

    play: async (source): Promise<void> => {
      player?.remove();
      const created = createAudioPlayer({
        uri: source.uri,
        ...(source.headers ? { headers: source.headers } : {}),
      });
      created.play();
      player = created;
    },

    stopPlayback: async (): Promise<void> => {
      player?.pause();
      player?.remove();
      player = undefined;
    },
  };
};
