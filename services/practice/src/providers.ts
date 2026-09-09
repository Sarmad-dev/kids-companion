import { ProviderTimeoutError, ProviderUnavailableError } from '@kids/shared';

import type { SpeechAnalysis, SpeechAnalysisProvider, SpeechAnalysisRequest } from './ports.js';

/**
 * Speech-analysis adapters.
 *
 * Two shipped, and the difference between them is the whole point of the port.
 */

/* -------------------------------------------------------------------------- */
/* Transcription-backed — the first real provider                             */
/* -------------------------------------------------------------------------- */

/** The narrow slice of `@kids/voice`'s STT port this needs. Structural, not a dependency. */
export interface TranscribeLike {
  readonly name: string;
  readonly model: string;
  transcribe(request: {
    audio: Uint8Array;
    mimeType: string;
    languageHints: readonly string[];
    ageGroup: string;
    timeoutMs: number;
  }): Promise<{ text: string; confidence: number; durationMs: number }>;
}

/**
 * Pronunciation analysis from a plain transcription API.
 *
 * THE FIRST REAL PROVIDER, and deliberately the weakest one. It reports
 * `granularity: 'utterance'` — a transcript and a confidence, and nothing about
 * how anything was articulated — which is exactly what a transcription API can
 * honestly claim.
 *
 * It exists because it is what we can actually run today: the dedicated
 * pronunciation-assessment vendors are an open question (Q-06), and a subsystem
 * that cannot ship until that resolves is a subsystem nobody can test. The
 * scoring architecture is built for phoneme data; this adapter simply does not
 * pretend to have any, and the constraint in the migration makes sure it cannot
 * start pretending later.
 */
export const createTranscriptionAnalysisProvider = (
  stt: TranscribeLike,
): SpeechAnalysisProvider => ({
  name: `transcription:${stt.name}`,
  model: stt.model,
  granularity: 'utterance',

  analyse: async (request: SpeechAnalysisRequest): Promise<SpeechAnalysis> => {
    const result = await stt.transcribe({
      audio: request.audio,
      mimeType: request.mimeType,
      languageHints: [request.language],
      ageGroup: request.ageGroup,
      timeoutMs: request.timeoutMs,
    });

    return {
      granularity: 'utterance',
      transcript: result.text,
      confidence: result.confidence,
      provider: `transcription:${stt.name}`,
      model: stt.model,
      // No `words`, and no phonemes. The absence is the honest part.
    };
  },
});

/* -------------------------------------------------------------------------- */
/* Mock                                                                        */
/* -------------------------------------------------------------------------- */

export interface MockAnalysisBehaviour {
  readonly failWith?: 'timeout' | 'unavailable';
  readonly failTimes?: number;
  /** What the recogniser "heard". Defaults to the target, said correctly. */
  readonly transcript?: string;
  readonly confidence?: number;
  /**
   * Emit phoneme detail.
   *
   * Off by default, because off is what a real transcription provider does. The
   * tests that exercise phoneme scoring turn it on explicitly, which keeps the
   * two paths visibly distinct.
   */
  readonly withPhonemes?: boolean;
  /** Per-symbol scores, when phonemes are on. */
  readonly phonemeScores?: Readonly<Record<string, number>>;
  readonly wordScore?: number;
}

export interface MockAnalysisOptions {
  readonly behaviour?: MockAnalysisBehaviour;
  readonly granularity?: SpeechAnalysisProvider['granularity'];
}

export const createMockAnalysisProvider = (
  options: MockAnalysisOptions = {},
): SpeechAnalysisProvider => {
  const behaviour = options.behaviour ?? {};
  let remaining = behaviour.failTimes ?? 0;

  const maybeFail = (): void => {
    const shouldFail =
      behaviour.failWith !== undefined && (behaviour.failTimes === undefined || remaining > 0);
    if (!shouldFail) return;
    if (behaviour.failTimes !== undefined) remaining -= 1;

    if (behaviour.failWith === 'timeout') throw new ProviderTimeoutError('analyse', 1);
    throw new ProviderUnavailableError('analyse');
  };

  const granularity =
    options.granularity ?? (behaviour.withPhonemes === true ? 'phoneme' : 'utterance');

  return {
    name: 'mock',
    model: 'mock-analysis-v1',
    granularity,

    analyse: async (request: SpeechAnalysisRequest): Promise<SpeechAnalysis> => {
      await Promise.resolve();
      maybeFail();

      const transcript = behaviour.transcript ?? request.targetText;
      const confidence = behaviour.confidence ?? 0.9;

      if (behaviour.withPhonemes !== true) {
        return {
          granularity: 'utterance',
          transcript,
          confidence,
          provider: 'mock',
          model: 'mock-analysis-v1',
        };
      }

      // A stand-in for a phoneme-capable vendor. The symbols come from the
      // configured scores or from the curated IPA — NEVER derived from the
      // spelling, because that is the exact thing this subsystem refuses to do.
      const scores = behaviour.phonemeScores ?? {};
      const symbols =
        Object.keys(scores).length > 0
          ? Object.keys(scores)
          : [...(request.expectedIpa ?? '')].filter((c) => c.trim() !== '');

      return {
        granularity: 'phoneme',
        transcript,
        confidence,
        provider: 'mock',
        model: 'mock-analysis-v1',
        words: [
          {
            text: request.targetText,
            score: behaviour.wordScore ?? 0.9,
            phonemes: symbols.map((symbol) => ({
              symbol,
              score: scores[symbol] ?? 0.9,
            })),
          },
        ],
      };
    },
  };
};
