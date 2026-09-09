import { declarationMatches, sniffAudio, type AudioContainer } from './formats.js';

/**
 * Upload validation.
 *
 * The order matters, and it is cheapest-first on purpose: an attacker should not
 * be able to make us parse a container before we have checked that the thing is
 * even a plausible size. Every rejection reason is an enum rather than a string,
 * so the API can decide what a client is told without a handler inventing
 * wording, and so the metrics can count them.
 */

export type RejectionReason =
  | 'empty'
  | 'too_large'
  | 'unsupported_format'
  | 'declared_type_mismatch'
  | 'duration_unknown'
  | 'too_long'
  | 'too_short';

export interface AudioLimits {
  readonly maxBytes: number;
  readonly maxDurationMs: number;
  /**
   * Below this, there is nothing to transcribe.
   *
   * Not a security control — it stops a stream of empty taps from each costing a
   * provider call, and it gives the child "I didn't quite catch that" rather
   * than a confusing reply to silence.
   */
  readonly minDurationMs: number;
  /**
   * Whether a container that does not carry a duration may be accepted.
   *
   * Browser MediaRecorder produces WebM with no duration until the stream is
   * finalised, which is normal. When this is false, the byte ceiling is the only
   * bound left — which is why it defaults to false anywhere the duration limit
   * is doing real work.
   */
  readonly allowUnknownDuration: boolean;
}

export const DEFAULT_AUDIO_LIMITS: AudioLimits = Object.freeze({
  // A child's turn is a few seconds. 8 MB is generous for 30 s of any codec
  // here, and small enough that a hostile upload cannot occupy a request worker
  // for long.
  maxBytes: 8 * 1024 * 1024,
  maxDurationMs: 30_000,
  minDurationMs: 250,
  allowUnknownDuration: true,
});

export type ValidationOutcome =
  | {
      readonly ok: true;
      readonly container: AudioContainer;
      readonly mimeType: string;
      readonly durationMs?: number;
    }
  | { readonly ok: false; readonly reason: RejectionReason; readonly detail?: string };

export interface ValidateInput {
  readonly bytes: Uint8Array;
  /** What the client SAID it was sending. Checked for agreement, never trusted. */
  readonly declaredMimeType: string;
  readonly limits?: AudioLimits;
}

export const validateAudioUpload = (input: ValidateInput): ValidationOutcome => {
  const limits = input.limits ?? DEFAULT_AUDIO_LIMITS;
  const { bytes } = input;

  // TEMP DEBUG: remove once "ok: false when I talk to it" is understood.
  {
    const head = Array.from(bytes.subarray(0, 32));
    // eslint-disable-next-line no-console
    console.error(
      '[validateAudioUpload]',
      JSON.stringify({
        byteLength: bytes.length,
        declaredMimeType: input.declaredMimeType,
        headHex: head.map((b) => b.toString(16).padStart(2, '0')).join(' '),
        headAscii: head.map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')).join(''),
        sniff: sniffAudio(bytes) ?? null,
      }),
    );
  }

  if (bytes.length === 0) return { ok: false, reason: 'empty' };

  // Size FIRST, before anything reads the bytes. A 400 MB "wav" should cost one
  // comparison, not a container walk.
  if (bytes.length > limits.maxBytes) {
    return { ok: false, reason: 'too_large', detail: `${String(limits.maxBytes)} bytes` };
  }

  const sniffed = sniffAudio(bytes);
  if (!sniffed) return { ok: false, reason: 'unsupported_format' };

  // The declared type has to AGREE with what the bytes are. A mismatch is not
  // a format problem — it is a client asserting something untrue about its own
  // payload, which is worth counting separately from an honest wrong format.
  if (!declarationMatches(sniffed.container, input.declaredMimeType)) {
    return { ok: false, reason: 'declared_type_mismatch', detail: sniffed.mimeType };
  }

  if (sniffed.durationMs === undefined) {
    if (!limits.allowUnknownDuration) return { ok: false, reason: 'duration_unknown' };
    return { ok: true, container: sniffed.container, mimeType: sniffed.mimeType };
  }

  if (sniffed.durationMs > limits.maxDurationMs) {
    return { ok: false, reason: 'too_long', detail: `${String(limits.maxDurationMs)} ms` };
  }
  if (sniffed.durationMs < limits.minDurationMs) {
    return { ok: false, reason: 'too_short' };
  }

  return {
    ok: true,
    container: sniffed.container,
    mimeType: sniffed.mimeType,
    durationMs: sniffed.durationMs,
  };
};

/**
 * What a client is told about a rejection.
 *
 * Deliberately vague about WHY a format was refused. "Not a supported audio
 * format" is all a legitimate client needs; telling a prober that their polyglot
 * file was caught by the RIFF chunk walk rather than the brand check helps only
 * the prober.
 */
export const CLIENT_REJECTION_MESSAGE: Readonly<Record<RejectionReason, string>> = Object.freeze({
  empty: 'No audio was received.',
  too_large: 'That recording is too large.',
  unsupported_format: 'That is not a supported audio format.',
  declared_type_mismatch: 'That is not a supported audio format.',
  duration_unknown: 'That is not a supported audio format.',
  too_long: 'That recording is too long.',
  too_short: 'That recording is too short.',
});
