/**
 * `@kids/practice` — pronunciation practice.
 *
 * THE ONE THING TO KNOW: this produces encouragement for a practice game, and
 * nothing here is a speech assessment. See `feedback.ts` and `scoring.ts`, both
 * of which say so at length, and `PRACTICE_DISCLAIMER`, which says so to parents.
 *
 * The scoring architecture supports phoneme-level analysis and refuses to invent
 * it: a provider declares what it actually observed, the scorer branches on
 * that, and a database constraint rejects phoneme detail no provider produced.
 */

export {
  ANALYSIS_GRANULARITIES,
  type AnalysisGranularity,
  type PhonemeObservation,
  type SpeechAnalysis,
  type SpeechAnalysisProvider,
  type SpeechAnalysisRequest,
  type WordObservation,
} from './ports.js';

export {
  bestWindowSimilarity,
  editDistance,
  normaliseWord,
  scorePronunciation,
  textSimilarity,
  type PartScore,
  type PronunciationScore,
  type ScoreInput,
  type ScoringMethod,
} from './scoring.js';

export {
  bandFor,
  buildFeedback,
  DIAGNOSTIC_VOCABULARY,
  PRACTICE_DISCLAIMER,
  type Feedback,
  type FeedbackBand,
  type FeedbackInput,
} from './feedback.js';

export {
  newlyEarned,
  progressTowards,
  RULE_KINDS,
  type AchievementRule,
  type AwardInput,
  type PracticeCounters,
  type RuleKind,
} from './achievements.js';

export {
  createMockAnalysisProvider,
  createTranscriptionAnalysisProvider,
  type MockAnalysisBehaviour,
  type MockAnalysisOptions,
  type TranscribeLike,
} from './providers.js';
