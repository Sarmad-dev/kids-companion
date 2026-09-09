/**
 * The audio port.
 *
 * Recording and playback behind an interface, for the same reason every vendor
 * in this repo sits behind one: the thing above it should be testable without
 * the thing below it. Here that matters more than usual — the alternative is a
 * simulator, a permission dialog, and a human tapping a button.
 */

export type PermissionOutcome = 'granted' | 'denied';

export interface RecordedAudio {
  /** A file URI on device. Uploaded, then deleted — see `discard`. */
  readonly uri: string;
  readonly mimeType: string;
  readonly durationMs: number;
}

export interface AudioPort {
  requestPermission(): Promise<PermissionOutcome>;
  startRecording(): Promise<void>;
  stopRecording(): Promise<RecordedAudio | undefined>;
  /**
   * Deletes a local recording.
   *
   * Called after every upload AND on every failure path. A child's voice sitting
   * in the app's cache directory is the same data the server refuses to keep
   * (docs/adr/0006), and a phone is a device that gets lost.
   */
  discard(uri: string): Promise<void>;
  play(source: { uri: string; headers?: Record<string, string> }): Promise<void>;
  stopPlayback(): Promise<void>;
}

/**
 * An in-memory port, for tests and for Expo Go where recording is unavailable.
 *
 * A real implementation of the interface rather than a stub: it tracks state, so
 * a test can assert that a recording was discarded rather than merely that
 * `discard` exists.
 */
export const createFakeAudioPort = (
  behaviour: {
    permission?: PermissionOutcome;
    recorded?: RecordedAudio;
    failStart?: boolean;
  } = {},
): AudioPort & { readonly discarded: readonly string[]; readonly played: readonly string[] } => {
  const discarded: string[] = [];
  const played: string[] = [];
  let recording = false;

  return {
    discarded,
    played,
    requestPermission: async () => await Promise.resolve(behaviour.permission ?? 'granted'),
    startRecording: async () => {
      await Promise.resolve();
      if (behaviour.failStart === true) throw new Error('microphone unavailable');
      recording = true;
    },
    stopRecording: async () => {
      await Promise.resolve();
      if (!recording) return undefined;
      recording = false;
      return (
        behaviour.recorded ?? {
          uri: 'file:///tmp/turn.m4a',
          mimeType: 'audio/mp4',
          durationMs: 1_200,
        }
      );
    },
    discard: async (uri: string) => {
      await Promise.resolve();
      discarded.push(uri);
    },
    play: async (source) => {
      await Promise.resolve();
      played.push(source.uri);
    },
    stopPlayback: async () => await Promise.resolve(),
  };
};
