import type { AgeGroup, SupportedLanguage } from '@kids/types';

/**
 * Speech-to-text, text-to-speech, and transient audio storage ports.
 *
 * STT and TTS are deliberately separate: the two vendors are chosen on entirely
 * different criteria (Urdu child-speech accuracy versus voice character and
 * per-character pricing) and there is no reason to assume one wins both. See
 * docs/adr/0004-provider-abstraction.md.
 *
 * No vendor SDK type crosses this boundary in either direction.
 */

/* -------------------------------------------------------------------------- */
/* Speech to text                                                              */
/* -------------------------------------------------------------------------- */

export interface TranscriptionRequest {
  readonly audio: Uint8Array;
  /** The SNIFFED type, never the client's declared one. See formats.ts. */
  readonly mimeType: string;
  /**
   * A constrained hypothesis set from the child's profile — never autodetect.
   * Pakistani households code-switch mid-sentence, and autodetect on a 4-year-
   * old's two-second utterance produces nonsense that then reaches the model.
   * See ARCHITECTURE.md §7.2.
   */
  readonly languageHints: readonly SupportedLanguage[];
  readonly ageGroup: AgeGroup;
  readonly timeoutMs: number;
}

export interface Transcription {
  readonly text: string;
  /**
   * Drives the "I didn't quite catch that" path. Low confidence on child speech
   * is expected, not exceptional — see R-01.
   */
  readonly confidence: number;
  readonly detectedLanguage?: SupportedLanguage;
  readonly durationMs: number;
}

export interface SpeechToTextProvider {
  readonly name: string;
  readonly model: string;
  /**
   * Implementations MUST NOT persist the audio, and MUST be configured for
   * zero vendor-side retention. Raw child audio is transcribed and discarded —
   * see docs/adr/0006-voice-pipeline-and-audio-retention.md.
   */
  transcribe(request: TranscriptionRequest): Promise<Transcription>;
}

/* -------------------------------------------------------------------------- */
/* Text to speech                                                              */
/* -------------------------------------------------------------------------- */

export interface SynthesisRequest {
  readonly text: string;
  readonly voiceId: string;
  readonly language: SupportedLanguage;
  readonly timeoutMs: number;
}

export interface SynthesisResult {
  readonly audio: Uint8Array;
  readonly mimeType: string;
  readonly durationMs: number;
  /** True when served from the content-hash cache — the largest single cost lever. */
  readonly fromCache: boolean;
}

export interface TextToSpeechProvider {
  readonly name: string;
  readonly model: string;
  synthesize(request: SynthesisRequest): Promise<SynthesisResult>;
}

/* -------------------------------------------------------------------------- */
/* Transient audio storage                                                     */
/* -------------------------------------------------------------------------- */

export type AudioKind = 'child_upload' | 'companion_reply';

export interface StoredAudio {
  readonly key: string;
  readonly kind: AudioKind;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly durationMs?: number;
  /** When this becomes unreadable. Never null — everything here expires. */
  readonly expiresAt: Date;
}

export interface PutAudioRequest {
  readonly kind: AudioKind;
  readonly bytes: Uint8Array;
  readonly mimeType: string;
  readonly durationMs?: number;
  readonly expiresAt: Date;
}

/**
 * Transient storage for audio.
 *
 * THE CLIENT NEVER TALKS TO THIS DIRECTLY. There are no presigned upload URLs
 * and no bucket credentials on a device: a mobile app posts bytes to our API and
 * fetches reply audio from our API, and the storage backend is reachable only
 * from the server. Handing a child's device a credential scoped to a bucket of
 * children's voices is a credential that will end up in a decompiled APK.
 *
 * Every implementation must:
 *   * honour `expiresAt` on read — an expired object is gone, not merely old,
 *   * delete rather than tombstone,
 *   * and provide `sweep()` as a backstop for the deletes that did not happen.
 */
export interface AudioStorage {
  readonly name: string;
  put(request: PutAudioRequest): Promise<StoredAudio>;
  /** `undefined` for absent OR expired. The caller cannot tell the difference, deliberately. */
  get(key: string): Promise<{ meta: StoredAudio; bytes: Uint8Array } | undefined>;
  delete(key: string): Promise<void>;
  /** Deletes everything past its expiry. Returns how many objects went. */
  sweep(): Promise<number>;
}
