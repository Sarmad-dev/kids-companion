import { describe, expect, it } from 'vitest';

import type { SpeechAnalysis } from './ports.js';
import {
  bestWindowSimilarity,
  editDistance,
  normaliseWord,
  scorePronunciation,
  textSimilarity,
} from './scoring.js';

/**
 * Scoring.
 *
 * Two things are under test throughout: that the arithmetic is right, and that
 * the system never claims to know something it does not. The second is the one
 * that matters — a wrong number is a bug, but a fabricated phoneme score is a
 * seven-year-old being told about a sound nobody measured.
 */

const utterance = (transcript: string, confidence = 0.9): SpeechAnalysis => ({
  granularity: 'utterance',
  transcript,
  confidence,
  provider: 'test',
  model: 'test-v1',
});

const score = (analysis: SpeechAnalysis, targetText: string, syllables: string[] = []) =>
  scorePronunciation({ analysis, targetText, syllables });

describe('string helpers', () => {
  it('measures edit distance', () => {
    expect(editDistance('cat', 'cat')).toBe(0);
    expect(editDistance('cat', 'bat')).toBe(1);
    expect(editDistance('', 'cat')).toBe(3);
    expect(editDistance('cat', '')).toBe(3);
    expect(editDistance('kitten', 'sitting')).toBe(3);
  });

  it('normalises case, punctuation, and whitespace', () => {
    expect(normaliseWord('  Banana!  ')).toBe('banana');
    expect(normaliseWord("don't")).toBe('dont');
  });

  it('preserves diacritics', () => {
    // In Urdu and Arabic the diacritic IS the sound. Stripping it would score a
    // correct attempt as wrong.
    expect(normaliseWord('کِتاب')).toBe('کِتاب'.toLowerCase().normalize('NFC'));
    expect(textSimilarity('café', 'café')).toBe(1);
  });

  it('handles multi-byte characters by codepoint, not code unit', () => {
    // A naive `.length` counts a surrogate pair as two, which would make an
    // emoji-length word score as half wrong.
    expect(editDistance('😀', '😀')).toBe(0);
    expect(textSimilarity('😀', '😀')).toBe(1);
  });

  it('scores an empty comparison without dividing by zero', () => {
    expect(textSimilarity('', '')).toBe(1);
    expect(textSimilarity('', 'cat')).toBe(0);
    expect(textSimilarity('cat', '')).toBe(0);
  });
});

describe('finding the attempt inside a longer utterance', () => {
  it('ignores the surrounding chatter', () => {
    // A four-year-old asked to say "banana" says all of these. Scoring the whole
    // utterance would punish every one of them for enthusiasm.
    for (const said of ['banana', 'um banana', 'banana banana', 'its banana i think']) {
      expect(bestWindowSimilarity(said, 'banana'), said).toBe(1);
    }
  });

  it('still scores a genuinely different word low', () => {
    expect(bestWindowSimilarity('elephant', 'banana')).toBeLessThan(0.4);
  });

  it('handles a multi-word target', () => {
    expect(bestWindowSimilarity('um birthday cake please', 'birthday cake')).toBe(1);
  });

  it('returns zero for an empty transcript', () => {
    expect(bestWindowSimilarity('', 'banana')).toBe(0);
    expect(bestWindowSimilarity('   ', 'banana')).toBe(0);
  });
});

describe('transcript_similarity — the weakest method', () => {
  it('scores a correct attempt highly', () => {
    const result = score(utterance('banana'), 'banana');

    expect(result.method).toBe('transcript_similarity');
    expect(result.overall).toBeGreaterThan(0.9);
    expect(result.isCorrect).toBe(true);
  });

  it('never claims phoneme data', () => {
    const result = score(utterance('banana'), 'banana');

    // The invariant the whole architecture exists to protect.
    expect(result.phonemeDataAvailable).toBe(false);
    expect(result.phonemeScores).toEqual({});
  });

  it('does not attempt per-syllable scoring', () => {
    // Splitting a transcript across curated syllable boundaries would be
    // guesswork presented as detail. Better to say nothing.
    const result = score(utterance('banana'), 'banana', ['ba', 'na', 'na']);
    expect(result.parts).toEqual([]);
  });

  it('lets confidence dampen a match but never rescue a miss', () => {
    const sure = score(utterance('banana', 1), 'banana');
    const unsure = score(utterance('banana', 0), 'banana');
    expect(sure.overall).toBeGreaterThan(unsure.overall);

    // A recogniser being certain about the wrong word must not produce a good
    // score.
    const confidentlyWrong = score(utterance('elephant', 1), 'banana');
    expect(confidentlyWrong.overall).toBeLessThan(0.4);
    expect(confidentlyWrong.isCorrect).toBe(false);
  });

  it('scores silence as zero rather than as a perfect empty match', () => {
    const result = score(utterance('', 0.1), 'banana');
    expect(result.overall).toBe(0);
    expect(result.isCorrect).toBe(false);
  });

  it('is generous about a near miss', () => {
    // This is a practice game. A child who was roughly understood should be told
    // they did well, because the alternative teaches them that trying is failing.
    const result = score(utterance('bananna'), 'banana');
    expect(result.overall).toBeGreaterThan(0.6);
  });
});

describe('word_alignment', () => {
  const wordAnalysis = (scores: number[]): SpeechAnalysis => ({
    granularity: 'word',
    confidence: 0.8,
    provider: 'test',
    model: 'test-v1',
    words: scores.map((s, i) => ({ text: `w${String(i)}`, score: s })),
  });

  it('averages the word scores', () => {
    const result = score(wordAnalysis([0.8, 0.6]), 'two words');

    expect(result.method).toBe('word_alignment');
    expect(result.overall).toBeCloseTo(0.7, 5);
    expect(result.parts).toHaveLength(2);
  });

  it('still claims no phoneme data', () => {
    // Word scores are real; sound-level detail is not. Feedback may name the
    // word and must not name a sound.
    const result = score(wordAnalysis([0.9]), 'word');
    expect(result.phonemeDataAvailable).toBe(false);
    expect(result.phonemeScores).toEqual({});
  });

  it('maps words onto curated syllables only when the counts match', () => {
    const two = scorePronunciation({
      analysis: wordAnalysis([0.9, 0.4]),
      targetText: 'birthday',
      syllables: ['birth', 'day'],
    });
    expect(two.parts.map((p) => p.text)).toEqual(['birth', 'day']);

    // Mismatched counts: telling a child the second half was wrong when it was
    // the first is worse than saying nothing specific.
    const three = scorePronunciation({
      analysis: wordAnalysis([0.9, 0.4]),
      targetText: 'banana',
      syllables: ['ba', 'na', 'na'],
    });
    expect(three.parts.map((p) => p.text)).not.toEqual(['ba', 'na', 'na']);
  });
});

describe('phoneme_alignment', () => {
  const phonemeAnalysis = (scores: Record<string, number>): SpeechAnalysis => ({
    granularity: 'phoneme',
    confidence: 0.85,
    provider: 'test',
    model: 'test-v1',
    words: [
      {
        text: 'thumb',
        score: 0.7,
        phonemes: Object.entries(scores).map(([symbol, s]) => ({ symbol, score: s })),
      },
    ],
  });

  it('averages the phoneme scores and keeps them verbatim', () => {
    const result = score(phonemeAnalysis({ θ: 0.4, ʌ: 0.9, m: 0.8 }), 'thumb');

    expect(result.method).toBe('phoneme_alignment');
    expect(result.phonemeDataAvailable).toBe(true);
    expect(result.overall).toBeCloseTo(0.7, 5);
    // Verbatim: the provider's own symbols, untranslated. Mapping between
    // notations is lossy, and a wrong mapping means feedback about a sound the
    // child never attempted.
    expect(result.phonemeScores).toEqual({ θ: 0.4, ʌ: 0.9, m: 0.8 });
  });

  it('averages repeated symbols rather than overwriting', () => {
    const analysis: SpeechAnalysis = {
      granularity: 'phoneme',
      confidence: 0.8,
      provider: 'test',
      model: 'test-v1',
      words: [
        {
          text: 'banana',
          score: 0.6,
          phonemes: [
            { symbol: 'ə', score: 0.2 },
            { symbol: 'n', score: 0.9 },
            { symbol: 'ə', score: 1 },
          ],
        },
      ],
    };

    // "banana" has three /ə/ and the child may have managed some of them.
    expect(score(analysis, 'banana').phonemeScores['ə']).toBeCloseTo(0.6, 5);
  });

  it('falls back when a phoneme-capable provider returned no phonemes', () => {
    // The provider CAN do phonemes; this response did not contain any. The
    // per-response granularity is what the scorer believes, not the capability.
    const analysis: SpeechAnalysis = {
      granularity: 'phoneme',
      confidence: 0.8,
      provider: 'test',
      model: 'test-v1',
      words: [{ text: 'thumb', score: 0.7 }],
    };

    const result = score(analysis, 'thumb');
    expect(result.method).toBe('word_alignment');
    expect(result.phonemeDataAvailable).toBe(false);
  });
});

describe('hostile and degenerate input', () => {
  it('clamps scores outside the declared range', () => {
    // Providers have been known to exceed their own documented range.
    const analysis: SpeechAnalysis = {
      granularity: 'phoneme',
      confidence: 5,
      provider: 'test',
      model: 'test-v1',
      words: [
        {
          text: 'x',
          score: 2,
          phonemes: [
            { symbol: 'a', score: 1.4 },
            { symbol: 'b', score: -3 },
          ],
        },
      ],
    };

    const result = score(analysis, 'x');
    expect(result.overall).toBeGreaterThanOrEqual(0);
    expect(result.overall).toBeLessThanOrEqual(1);
    expect(result.confidence).toBe(1);
    for (const value of Object.values(result.phonemeScores)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it('survives NaN and Infinity from a provider', () => {
    const analysis: SpeechAnalysis = {
      granularity: 'phoneme',
      confidence: Number.NaN,
      provider: 'test',
      model: 'test-v1',
      words: [
        {
          text: 'x',
          score: Number.POSITIVE_INFINITY,
          phonemes: [{ symbol: 'a', score: Number.NaN }],
        },
      ],
    };

    const result = score(analysis, 'x');
    expect(Number.isFinite(result.overall)).toBe(true);
    expect(Number.isFinite(result.confidence)).toBe(true);
  });

  it('handles an empty target without dividing by zero', () => {
    const result = score(utterance(''), '');
    expect(Number.isFinite(result.overall)).toBe(true);
  });

  it('handles a very long transcript', () => {
    const rambling = Array.from({ length: 500 }, (_, i) => `word${String(i)}`).join(' ');
    const result = score(utterance(`${rambling} banana`), 'banana');

    // Still found, and still cheap.
    expect(result.overall).toBeGreaterThan(0.5);
  });

  it('scores a non-Latin target', () => {
    const result = score(utterance('کتاب'), 'کتاب');
    expect(result.overall).toBeGreaterThan(0.9);
  });

  it('always records which provider produced the score', () => {
    // A score with no provenance is a number nobody can defend.
    const result = score(utterance('banana'), 'banana');
    expect(result.provider).toBe('test');
    expect(result.providerModel).toBe('test-v1');
  });
});
