import type { SpeechAnalysis } from './ports.js';

/**
 * Pronunciation scoring.
 *
 * READ THIS BEFORE CHANGING ANYTHING HERE.
 *
 * This produces ENCOURAGEMENT FOR A PRACTICE GAME. It is not an assessment, it
 * is not a measurement of a child's speech, and it is not evidence of anything.
 * A low score means one attempt at one word did not match what a recogniser
 * expected — which happens constantly with children, for reasons including a
 * quiet room, a wobbly tooth, a regional accent, and a recogniser trained mostly
 * on adults. The product must never present it as more than that
 * (docs/CHILD_SAFETY.md §2: no diagnosis, including of speech).
 *
 * THE SCORING METHOD IS PART OF THE RESULT. Three methods, in descending order
 * of what they can honestly claim:
 *
 *   phoneme_alignment      a provider scored individual sounds. Specific
 *                          feedback is possible.
 *   word_alignment         a provider scored whole words. Per-word feedback is
 *                          possible; per-sound feedback is NOT.
 *   transcript_similarity  we compared text to text. This is the weakest, it is
 *                          the most common, and it can say nothing about
 *                          articulation at all.
 *
 * The last one is a comparison of SPELLING, not of sound. "fone" and "phone"
 * score badly against each other and sound identical; "there" and "their" score
 * perfectly and may not. That limitation is why `phonemeDataAvailable` exists,
 * why the database refuses phoneme detail without it, and why the feedback
 * generated from it is general rather than specific.
 */

export type ScoringMethod = 'phoneme_alignment' | 'word_alignment' | 'transcript_similarity';

export interface PartScore {
  /** The syllable or word this covers, as written in the curated content. */
  readonly text: string;
  readonly score: number;
}

export interface PronunciationScore {
  readonly overall: number;
  readonly confidence: number;
  readonly method: ScoringMethod;
  /**
   * Whether a provider genuinely produced phoneme detail.
   *
   * The gate on specific feedback, and on the `phoneme_scores` column. False
   * here means nobody may claim to know how a particular sound was made.
   */
  readonly phonemeDataAvailable: boolean;
  /** Per-syllable or per-word, when the analysis supports it. Empty otherwise. */
  readonly parts: readonly PartScore[];
  /** Provider phoneme scores, verbatim. Empty unless `phonemeDataAvailable`. */
  readonly phonemeScores: Readonly<Record<string, number>>;
  /**
   * Whether this counts as a successful attempt for progress purposes.
   *
   * A COARSE ENGAGEMENT FLAG, deliberately generous. It feeds
   * `learning_progress.success_count`, which the schema comment already forbids
   * presenting to a parent as an educational score.
   */
  readonly isCorrect: boolean;
  readonly provider: string;
  readonly providerModel: string;
}

export interface ScoreInput {
  readonly analysis: SpeechAnalysis;
  readonly targetText: string;
  readonly syllables: readonly string[];
  /**
   * Below this, the attempt does not count as a success.
   *
   * Set low on purpose. This is a practice game: a child who had a go and was
   * roughly understood should be told they did well, because the alternative
   * teaches them that trying is failing.
   */
  readonly successThreshold?: number;
}

const clamp01 = (value: number): number =>
  Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;

const mean = (values: readonly number[]): number =>
  values.length === 0 ? 0 : values.reduce((sum, v) => sum + v, 0) / values.length;

/**
 * Normalises a word for comparison.
 *
 * Case, punctuation, and surrounding whitespace are noise from the recogniser,
 * not differences in what the child said. Diacritics are PRESERVED: in Urdu and
 * Arabic they are the sound, and stripping them would score a correct attempt as
 * wrong.
 */
export const normaliseWord = (text: string): string =>
  text
    .toLowerCase()
    .normalize('NFC')
    .replace(/[.,!?;:'"()[\]{}]/g, '')
    .trim();

/**
 * Levenshtein distance, iterative and with a single row.
 *
 * Bounded by the caller's input lengths, which come from curated content on one
 * side and a recogniser transcript on the other — both short.
 */
export const editDistance = (a: string, b: string): number => {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const aChars = [...a];
  const bChars = [...b];
  let previous = Array.from({ length: bChars.length + 1 }, (_, i) => i);

  for (let i = 1; i <= aChars.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= bChars.length; j += 1) {
      const substitution = previous[j - 1]! + (aChars[i - 1] === bChars[j - 1] ? 0 : 1);
      current[j] = Math.min(substitution, previous[j]! + 1, current[j - 1]! + 1);
    }
    previous = current;
  }

  return previous[bChars.length]!;
};

/**
 * Similarity of two strings, 0–1.
 *
 * A COMPARISON OF SPELLING. See the header: it says nothing about articulation,
 * and the only reason it is acceptable as a fallback is that the feedback built
 * on it is correspondingly general.
 */
export const textSimilarity = (a: string, b: string): number => {
  const left = normaliseWord(a);
  const right = normaliseWord(b);
  if (left === '' && right === '') return 1;
  if (left === '' || right === '') return 0;

  const longest = Math.max([...left].length, [...right].length);
  return clamp01(1 - editDistance(left, right) / longest);
};

/**
 * Finds the child's attempt at the target inside a longer transcript.
 *
 * A four-year-old asked to say "banana" says "banana!" or "um banana" or
 * "banana banana". Scoring the whole utterance against one word would punish
 * every one of those, so the best-matching window is what gets scored — and the
 * child is not marked down for enthusiasm.
 */
export const bestWindowSimilarity = (transcript: string, target: string): number => {
  const words = normaliseWord(transcript).split(/\s+/).filter(Boolean);
  if (words.length === 0) return 0;

  const targetWordCount = normaliseWord(target).split(/\s+/).filter(Boolean).length;
  const widths = new Set([targetWordCount, 1, Math.min(words.length, targetWordCount + 1)]);

  let best = 0;
  for (const width of widths) {
    if (width < 1 || width > words.length) continue;
    for (let start = 0; start + width <= words.length; start += 1) {
      best = Math.max(best, textSimilarity(words.slice(start, start + width).join(' '), target));
      if (best === 1) return 1;
    }
  }
  return best;
};

export const scorePronunciation = (input: ScoreInput): PronunciationScore => {
  const { analysis, targetText } = input;
  const successThreshold = input.successThreshold ?? 0.55;
  const confidence = clamp01(analysis.confidence);

  const base = {
    confidence,
    provider: analysis.provider,
    providerModel: analysis.model,
  };

  /* ---------------- phoneme_alignment ---------------- */
  // A provider scored individual sounds AND said so for this response. Only
  // here may anything claim to know how a particular sound was made.
  const phonemes = (analysis.words ?? []).flatMap((w) => w.phonemes ?? []);
  if (analysis.granularity === 'phoneme' && phonemes.length > 0) {
    const phonemeScores: Record<string, number> = {};
    for (const phoneme of phonemes) {
      // Later occurrences of the same symbol average with earlier ones rather
      // than overwriting: "banana" has three /ə/ and the child may have managed
      // some of them.
      const existing = phonemeScores[phoneme.symbol];
      const score = clamp01(phoneme.score);
      phonemeScores[phoneme.symbol] = existing === undefined ? score : (existing + score) / 2;
    }

    const parts = partScoresFrom(analysis, input.syllables);
    const overall = clamp01(mean(phonemes.map((p) => clamp01(p.score))));

    return {
      ...base,
      overall,
      method: 'phoneme_alignment',
      phonemeDataAvailable: true,
      parts,
      phonemeScores,
      isCorrect: overall >= successThreshold,
    };
  }

  /* ---------------- word_alignment ---------------- */
  // Per-word scores, no phoneme detail. Feedback can name the word; it cannot
  // name a sound.
  const words = analysis.words ?? [];
  if (analysis.granularity !== 'utterance' && words.length > 0) {
    const overall = clamp01(mean(words.map((w) => clamp01(w.score))));
    return {
      ...base,
      overall,
      method: 'word_alignment',
      phonemeDataAvailable: false,
      // Same mapping as the phoneme branch: curated syllable labels when the
      // counts line up exactly, the provider’s own word labels otherwise.
      parts: partScoresFrom(analysis, input.syllables),
      phonemeScores: {},
      isCorrect: overall >= successThreshold,
    };
  }

  /* ---------------- transcript_similarity ---------------- */
  // The weakest method and the common one. Spelling against spelling.
  const transcript = analysis.transcript ?? '';
  const similarity = bestWindowSimilarity(transcript, targetText);

  // Confidence DAMPENS a good similarity but never rescues a bad one. A
  // recogniser that is unsure of what it heard cannot make a match more
  // trustworthy, and an attempt that clearly did not match should not score well
  // because the recogniser was certain about something else.
  const overall = clamp01(similarity * (0.6 + 0.4 * confidence));

  return {
    ...base,
    overall,
    method: 'transcript_similarity',
    phonemeDataAvailable: false,
    // Per-syllable scoring is NOT attempted here. Splitting a transcript across
    // curated syllable boundaries would be guesswork presented as detail.
    parts: [],
    phonemeScores: {},
    isCorrect: overall >= successThreshold,
  };
};

/**
 * Maps word-level observations onto the curated syllables, when they line up.
 *
 * Only when the counts match exactly. A partial mapping would attach a score to
 * the wrong syllable, and telling a child the second half of "birthday" was
 * wrong when it was the first is worse than saying nothing specific.
 */
const partScoresFrom = (
  analysis: SpeechAnalysis,
  syllables: readonly string[],
): readonly PartScore[] => {
  const words = analysis.words ?? [];
  if (words.length === 0) return [];

  if (syllables.length > 1 && words.length === syllables.length) {
    return syllables.map((text, i) => ({ text, score: clamp01(words[i]!.score) }));
  }

  return words.map((w) => ({ text: w.text, score: clamp01(w.score) }));
};
