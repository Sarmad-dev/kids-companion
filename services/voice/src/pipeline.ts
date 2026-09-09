import { ProviderTimeoutError, withRetry, type Clock, type RetryOptions } from '@kids/shared';
import type { AgeGroup, SupportedLanguage } from '@kids/types';

import type { AudioStorage, SpeechToTextProvider, TextToSpeechProvider } from './ports.js';
import { resolveRetention, type RetentionPolicy } from './retention.js';
import { validateAudioUpload, type AudioLimits, type RejectionReason } from './validation.js';

/**
 * The voice pipeline.
 *
 *   RECORD          the device; not our code
 *   UPLOAD          the API route; bytes arrive here already buffered
 *   VALIDATE        size, container, declared-type agreement, duration
 *   TRANSCRIBE      STT provider, with a timeout and a retry budget
 *   SAFETY CHECK    ─┐
 *   AI RESPONSE      ├─ the caller's callback: INPUT_SAFETY_CHECK →
 *   (               ─┘   AI_GENERATION → OUTPUT_SAFETY_CHECK, unchanged
 *   TTS             synthesise the reply
 *   RETURN          a key the client can fetch once, before it expires
 *
 * SAFETY IS NOT REIMPLEMENTED HERE. The `respond` callback is the existing
 * conversation turn, safety pipeline and all. Voice is an input and output
 * modality; it must not become a second, weaker path to the model. A transcript
 * goes through exactly the same three stages a typed message does.
 *
 * THE AUDIO IS DELETED BEFORE THIS FUNCTION RETURNS unless a policy explicitly
 * says otherwise, and the policy that could say otherwise requires a parent's
 * specific opt-in (docs/adr/0006).
 */

export type VoiceStage = 'VALIDATE' | 'TRANSCRIBE' | 'SAFETY_AND_RESPONSE' | 'TTS' | 'RETURN';

export interface VoiceTurnRequest {
  readonly audio: Uint8Array;
  readonly declaredMimeType: string;
  readonly ageGroup: AgeGroup;
  readonly languageHints: readonly SupportedLanguage[];
  readonly voiceId: string;
  /** Whether this child's parent has a live, specific `audio_retention` consent. */
  readonly retentionOptIn: boolean;
}

export interface VoiceResponse {
  /** What the companion says, as text. Always present, even when TTS failed. */
  readonly reply: string;
  readonly replyForStorage: string;
  readonly status: string;
  readonly escalation: boolean;
  readonly extra?: Readonly<Record<string, unknown>>;
}

export interface VoiceTurnOptions {
  readonly stt: SpeechToTextProvider;
  readonly tts: TextToSpeechProvider;
  readonly storage: AudioStorage;
  readonly clock: Clock;
  readonly retention: RetentionPolicy;
  readonly limits?: AudioLimits;
  readonly sttTimeoutMs?: number;
  readonly ttsTimeoutMs?: number;
  readonly retry?: RetryOptions;
  /**
   * Below this, the child is asked to say it again rather than answered.
   *
   * Low confidence on child speech is expected, not exceptional (R-01). The
   * failure mode this prevents is the worst one available: confidently replying
   * to something the child did not say.
   */
  readonly minConfidence?: number;
}

export type VoiceTurnOutcome =
  | {
      readonly kind: 'rejected';
      readonly stage: 'VALIDATE';
      readonly reason: RejectionReason;
      readonly detail?: string;
    }
  | {
      readonly kind: 'unintelligible';
      readonly stage: 'TRANSCRIBE';
      readonly confidence: number;
    }
  | {
      readonly kind: 'provider_failed';
      readonly stage: VoiceStage;
      readonly timedOut: boolean;
    }
  | {
      readonly kind: 'ok';
      readonly transcript: string;
      readonly confidence: number;
      readonly response: VoiceResponse;
      /** Absent when TTS failed — the turn still succeeded, as text. */
      readonly audioKey?: string;
      readonly audioMimeType?: string;
      readonly audioDurationMs?: number;
      readonly audioExpiresAt?: Date;
      /** What happened to the child's UPLOAD, for the audit record. */
      readonly uploadRetention: 'transient' | 'retained';
      readonly uploadKey?: string;
      readonly stagesCompleted: readonly VoiceStage[];
    };

export const runVoiceTurn = async (
  options: VoiceTurnOptions,
  request: VoiceTurnRequest,
  /** The existing conversation turn. Safety runs inside this, not around it. */
  respond: (transcript: string) => Promise<VoiceResponse>,
): Promise<VoiceTurnOutcome> => {
  const stages: VoiceStage[] = [];
  const sttTimeoutMs = options.sttTimeoutMs ?? 10_000;
  const ttsTimeoutMs = options.ttsTimeoutMs ?? 10_000;
  const minConfidence = options.minConfidence ?? 0.4;

  /* ---------------- VALIDATE ---------------- */
  const validation = validateAudioUpload({
    bytes: request.audio,
    declaredMimeType: request.declaredMimeType,
    ...(options.limits ? { limits: options.limits } : {}),
  });

  if (!validation.ok) {
    // Nothing was stored and nothing was sent anywhere. A rejected upload should
    // leave no trace beyond a counter.
    return {
      kind: 'rejected',
      stage: 'VALIDATE',
      reason: validation.reason,
      ...(validation.detail === undefined ? {} : { detail: validation.detail }),
    };
  }
  stages.push('VALIDATE');

  /* ---------------- Retention, decided BEFORE anything is written ----------
   * The decision comes first so there is no window in which audio exists
   * without an expiry attached to it. An object written now and given a
   * lifetime later is an object that outlives a crash in between.
   */
  const retention = resolveRetention({
    policy: options.retention,
    kind: 'child_upload',
    parentOptedIn: request.retentionOptIn,
    clock: options.clock,
  });

  let uploadKey: string | undefined;
  if (retention.decision === 'retained') {
    const stored = await options.storage.put({
      kind: 'child_upload',
      bytes: request.audio,
      mimeType: validation.mimeType,
      ...(validation.durationMs === undefined ? {} : { durationMs: validation.durationMs }),
      expiresAt: retention.expiresAt,
    });
    uploadKey = stored.key;
  }

  /* ---------------- TRANSCRIBE ---------------- */
  let transcription;
  try {
    transcription = await runWithRetry(
      options.retry,
      async () =>
        await options.stt.transcribe({
          audio: request.audio,
          // The SNIFFED type, never what the client declared.
          mimeType: validation.mimeType,
          languageHints: request.languageHints,
          ageGroup: request.ageGroup,
          timeoutMs: sttTimeoutMs,
        }),
    );
  } catch (error) {
    return {
      kind: 'provider_failed',
      stage: 'TRANSCRIBE',
      timedOut: error instanceof ProviderTimeoutError,
    };
  }
  stages.push('TRANSCRIBE');

  // An empty or low-confidence transcript is asked about, never answered. This
  // is the single most important line in the file: the alternative is a
  // confident reply to something the child did not say.
  if (transcription.text.trim() === '' || transcription.confidence < minConfidence) {
    return { kind: 'unintelligible', stage: 'TRANSCRIBE', confidence: transcription.confidence };
  }

  /* ---------------- SAFETY CHECK → AI RESPONSE ----------------
   * The existing conversation turn, unchanged. Voice does not get its own
   * safety path, because a second path is a weaker path.
   */
  const response = await respond(transcription.text);
  stages.push('SAFETY_AND_RESPONSE');

  /* ---------------- TTS ---------------- */
  let audio: { key: string; mimeType: string; durationMs: number; expiresAt: Date } | undefined;
  try {
    const synthesised = await runWithRetry(
      options.retry,
      async () =>
        await options.tts.synthesize({
          text: response.reply,
          voiceId: request.voiceId,
          language: request.languageHints[0] ?? 'en',
          timeoutMs: ttsTimeoutMs,
        }),
    );

    const replyRetention = resolveRetention({
      policy: options.retention,
      kind: 'companion_reply',
      parentOptedIn: false,
      clock: options.clock,
    });

    const stored = await options.storage.put({
      kind: 'companion_reply',
      bytes: synthesised.audio,
      mimeType: synthesised.mimeType,
      durationMs: synthesised.durationMs,
      expiresAt: replyRetention.expiresAt,
    });

    audio = {
      key: stored.key,
      mimeType: stored.mimeType,
      durationMs: synthesised.durationMs,
      expiresAt: replyRetention.expiresAt,
    };
    stages.push('TTS');
  } catch {
    // TTS FAILING DOES NOT FAIL THE TURN. The reply exists and is safe; the
    // client falls back to showing it as text. Losing the voice is a degraded
    // experience, losing the answer is a broken one.
    audio = undefined;
  }

  stages.push('RETURN');

  return {
    kind: 'ok',
    transcript: transcription.text,
    confidence: transcription.confidence,
    response,
    ...(audio
      ? {
          audioKey: audio.key,
          audioMimeType: audio.mimeType,
          audioDurationMs: audio.durationMs,
          audioExpiresAt: audio.expiresAt,
        }
      : {}),
    uploadRetention: retention.decision,
    ...(uploadKey === undefined ? {} : { uploadKey }),
    stagesCompleted: stages,
  };
};

const runWithRetry = async <T>(
  retry: RetryOptions | undefined,
  fn: () => Promise<T>,
): Promise<T> => (retry ? await withRetry('voice', fn, retry) : await fn());

/**
 * What the child hears when the pipeline could not produce an answer.
 *
 * In the character's voice, never an error. A child who has just spoken into a
 * microphone and gets a spinner or an error code has learned that the thing does
 * not work (docs/ERROR_HANDLING.md §10).
 */
export const VOICE_FALLBACKS = Object.freeze({
  unintelligible: "Ooh, I didn't quite catch that! Can you say it again?",
  too_quiet: "I can't hear you very well. Can you say that a bit louder?",
  transcribe_failed: 'My ears went funny for a moment! Can you try again?',
  transcribe_timeout: 'I was listening really hard and got lost. Say that again?',
  rejected: "Hmm, that didn't come through. Let's try recording again!",
});

export type VoiceFallback = keyof typeof VOICE_FALLBACKS;

/** Maps a validation rejection onto something a child can hear. */
export const fallbackForRejection = (reason: RejectionReason): VoiceFallback =>
  reason === 'too_short' ? 'unintelligible' : 'rejected';
