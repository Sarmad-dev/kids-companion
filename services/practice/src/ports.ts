import type { AgeGroup, SupportedLanguage } from '@kids/types';

/**
 * The speech-analysis port.
 *
 * THE CENTRAL PROBLEM THIS INTERFACE SOLVES: providers differ enormously in what
 * they can actually tell you about an attempt, and the honest thing to do is to
 * let a provider say so rather than to paper over the difference.
 *
 *   * A dedicated pronunciation-assessment service returns a score per PHONEME.
 *   * A general recogniser with word timings returns a score per WORD.
 *   * A plain transcription API returns a string and a confidence, and nothing
 *     about how anything was articulated.
 *
 * The tempting design is one interface that always returns phoneme scores, with
 * the weaker providers "filling in" plausible values. That design produces a
 * product that tells a seven-year-old their /θ/ needs work on the basis of a
 * number nobody measured. So instead a provider DECLARES its granularity, the
 * scorer branches on what is genuinely present, and the result records which
 * method was used — all the way into the database, where a CHECK constraint
 * refuses phoneme detail that no provider produced.
 *
 * No vendor SDK type crosses this boundary.
 */

/** What a provider can observe. Ordered weakest to strongest. */
export const ANALYSIS_GRANULARITIES = ['utterance', 'word', 'phoneme'] as const;
export type AnalysisGranularity = (typeof ANALYSIS_GRANULARITIES)[number];

export interface PhonemeObservation {
  /**
   * The provider's own symbol — IPA, ARPAbet, or whatever it uses.
   *
   * Passed through UNTRANSLATED. Mapping between notations is lossy and
   * language-specific, and a wrong mapping produces feedback about a sound the
   * child never attempted.
   */
  readonly symbol: string;
  /** 0–1. Clamped by the scorer; providers have been known to exceed their own range. */
  readonly score: number;
  readonly startMs?: number;
  readonly endMs?: number;
}

export interface WordObservation {
  readonly text: string;
  readonly score: number;
  /** Present only from a phoneme-capable provider. */
  readonly phonemes?: readonly PhonemeObservation[];
}

export interface SpeechAnalysis {
  /**
   * What this response ACTUALLY contains — not what the provider is capable of.
   *
   * A phoneme-capable provider that returned no phoneme data for this attempt
   * must report `'word'` or `'utterance'` here. The scorer trusts this field
   * over the provider's advertised capability, because a capability is a claim
   * about the vendor and this is a fact about the response.
   */
  readonly granularity: AnalysisGranularity;
  /** What the recogniser heard. Absent when the provider does not transcribe. */
  readonly transcript?: string;
  /** 0–1. Low confidence on child speech is expected, not exceptional (R-01). */
  readonly confidence: number;
  readonly words?: readonly WordObservation[];
  readonly provider: string;
  readonly model: string;
}

export interface SpeechAnalysisRequest {
  readonly audio: Uint8Array;
  /** The SNIFFED type from `@kids/voice`, never a client's declared one. */
  readonly mimeType: string;
  /** What the child was asked to say. Curated content, not child speech. */
  readonly targetText: string;
  /** The curated syllable split, when the exercise has one. */
  readonly syllables: readonly string[];
  /**
   * The curated phonetic transcription, when a content author wrote one.
   *
   * Undefined means NOBODY HAS SUPPLIED ONE — never "derive it". A provider that
   * needs a reference transcription and does not get one should degrade, not
   * guess.
   */
  readonly expectedIpa?: string;
  readonly language: SupportedLanguage;
  readonly ageGroup: AgeGroup;
  readonly timeoutMs: number;
}

export interface SpeechAnalysisProvider {
  readonly name: string;
  readonly model: string;
  /**
   * The best this provider can do. Advertised for routing and capacity planning;
   * the per-response `granularity` is what the scorer actually believes.
   */
  readonly granularity: AnalysisGranularity;
  /**
   * Implementations MUST NOT persist the audio, and MUST be configured for
   * zero vendor-side retention (docs/adr/0006).
   */
  analyse(request: SpeechAnalysisRequest): Promise<SpeechAnalysis>;
}
