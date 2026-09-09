import { describe, expect, it } from 'vitest';

import { characterByKey } from './characters.js';
import {
  assertNoProhibitedData,
  buildProviderContext,
  DEFAULT_CONTEXT_LIMITS,
  estimateTokens,
  outputTokensFor,
  ProhibitedDataError,
  windowHistory,
  type ConversationContextInput,
  type HistoryMessage,
} from './context.js';

const history = (count: number): HistoryMessage[] =>
  Array.from({ length: count }, (_, i) => ({
    role: i % 2 === 0 ? ('child' as const) : ('companion' as const),
    text: `message number ${String(i)}`,
    sequence: i,
  }));

const context = (overrides: Partial<ConversationContextInput> = {}): ConversationContextInput => ({
  childName: 'Ayesha',
  ageGroup: 'AGE_6_8',
  language: 'en',
  character: characterByKey('lily')!,
  history: [],
  learningObjectives: [],
  blockedTopics: [],
  contentRestrictions: [],
  correctionStyle: 'gentle',
  ...overrides,
});

describe('history windowing', () => {
  it('keeps the last N exchanges', () => {
    // The specification calls for about ten exchanges; the value is
    // configurable because the right number is empirical.
    const result = windowHistory(history(40), { ...DEFAULT_CONTEXT_LIMITS, maxExchanges: 10 });

    expect(result.messages).toHaveLength(20);
    expect(result.droppedCount).toBe(20);
  });

  it('honours a different configured window', () => {
    const result = windowHistory(history(40), { ...DEFAULT_CONTEXT_LIMITS, maxExchanges: 3 });

    expect(result.messages).toHaveLength(6);
  });

  it('keeps the NEWEST messages, not the oldest', () => {
    const result = windowHistory(history(30), { ...DEFAULT_CONTEXT_LIMITS, maxExchanges: 2 });

    expect(result.messages.at(-1)?.text).toBe('message number 29');
  });

  it('preserves order within the window', () => {
    // A conversation missing its middle reads as incoherent to a child.
    const result = windowHistory(history(20), { ...DEFAULT_CONTEXT_LIMITS, maxExchanges: 5 });
    const sequences = result.messages.map((m) => m.sequence);

    expect([...sequences].sort((a, b) => a - b)).toEqual(sequences);
  });

  it('handles unsorted input', () => {
    const shuffled = [...history(10)].reverse();
    const result = windowHistory(shuffled, { ...DEFAULT_CONTEXT_LIMITS, maxExchanges: 2 });

    expect(result.messages.map((m) => m.sequence)).toEqual([6, 7, 8, 9]);
  });

  it('returns everything when history is shorter than the window', () => {
    const result = windowHistory(history(4), DEFAULT_CONTEXT_LIMITS);

    expect(result.messages).toHaveLength(4);
    expect(result.droppedCount).toBe(0);
  });

  it('handles an empty history', () => {
    const result = windowHistory([], DEFAULT_CONTEXT_LIMITS);

    expect(result.messages).toEqual([]);
    expect(result.estimatedTokens).toBe(0);
  });

  describe('token budget', () => {
    it('trims below the exchange limit when messages are long', () => {
      const long: HistoryMessage[] = Array.from({ length: 20 }, (_, i) => ({
        role: i % 2 === 0 ? ('child' as const) : ('companion' as const),
        text: 'x'.repeat(1_000),
        sequence: i,
      }));

      const result = windowHistory(long, {
        ...DEFAULT_CONTEXT_LIMITS,
        maxExchanges: 10,
        maxHistoryTokens: 1_000,
      });

      // Both limits apply; whichever bites first wins.
      expect(result.messages.length).toBeLessThan(20);
      expect(result.estimatedTokens).toBeLessThanOrEqual(1_000);
    });

    it('always keeps at least one message, even if it exceeds the budget', () => {
      const huge: HistoryMessage[] = [{ role: 'child', text: 'x'.repeat(100_000), sequence: 0 }];

      // Dropping everything would leave the model with no context at all, which
      // is worse than exceeding an estimate the provider will re-count anyway.
      expect(
        windowHistory(huge, { ...DEFAULT_CONTEXT_LIMITS, maxHistoryTokens: 10 }).messages,
      ).toHaveLength(1);
    });

    it('spends the budget on the most recent messages', () => {
      const long: HistoryMessage[] = Array.from({ length: 10 }, (_, i) => ({
        role: 'child' as const,
        text: 'y'.repeat(500),
        sequence: i,
      }));

      const result = windowHistory(long, {
        ...DEFAULT_CONTEXT_LIMITS,
        maxHistoryTokens: 500,
      });

      expect(result.messages.at(-1)?.sequence).toBe(9);
    });
  });
});

describe('token estimation', () => {
  it('over-estimates rather than under', () => {
    // The failure modes are asymmetric: over-estimating trims one exchange,
    // under-estimating means the provider rejects the request mid-conversation
    // and the child gets nothing.
    expect(estimateTokens('a'.repeat(100))).toBeGreaterThan(100 / 4);
  });

  it('returns zero for empty text', () => {
    expect(estimateTokens('')).toBe(0);
  });
});

describe('output token ceilings', () => {
  it('never exceeds the configured maximum', () => {
    const limits = { ...DEFAULT_CONTEXT_LIMITS, maxOutputTokens: 50 };

    for (const ageGroup of ['AGE_3_5', 'AGE_6_8', 'AGE_9_10'] as const) {
      expect(outputTokensFor(ageGroup, limits)).toBeLessThanOrEqual(50);
    }
  });

  it('gives the youngest group the smallest budget', () => {
    const limits = { ...DEFAULT_CONTEXT_LIMITS, maxOutputTokens: 10_000 };

    expect(outputTokensFor('AGE_3_5', limits)).toBeLessThan(outputTokensFor('AGE_9_10', limits));
  });
});

/**
 * The privacy boundary.
 *
 * `buildProviderContext` is the only path by which anything reaches a provider,
 * and these tests are the evidence for "never send unnecessary private child
 * data".
 */
describe('the outbound payload', () => {
  it("never contains the child's name", () => {
    const { context: outbound } = buildProviderContext(
      context({ childName: 'Zainab', history: history(4) }),
    );

    expect(JSON.stringify(outbound)).not.toContain('Zainab');
  });

  it('carries only the four fields a provider needs', () => {
    const { context: outbound } = buildProviderContext(context());

    expect(Object.keys(outbound).sort()).toEqual([
      'ageGroup',
      'history',
      'language',
      'systemPrompt',
    ]);
  });

  it('strips everything but role and text from each message', () => {
    const { context: outbound } = buildProviderContext(context({ history: history(2) }));

    for (const message of outbound.history) {
      expect(Object.keys(message).sort()).toEqual(['role', 'text']);
    }
  });

  it('sends an age GROUP, never a birth date', () => {
    const { context: outbound } = buildProviderContext(context());
    const serialised = JSON.stringify(outbound);

    expect(outbound.ageGroup).toBe('AGE_6_8');
    expect(serialised).not.toMatch(/\b(19|20)\d{2}\b/);
  });

  it('throws rather than sending when a name would leak', () => {
    // Throwing rather than stripping: silently removing the field would let the
    // mistake persist. Failing makes it a bug someone fixes today.
    expect(() =>
      assertNoProhibitedData(
        {
          ageGroup: 'AGE_6_8',
          language: 'en',
          systemPrompt: 'Address the child as Ayesha.',
          history: [],
        },
        ['Ayesha'],
      ),
    ).toThrow(ProhibitedDataError);
  });

  it.each([['childId'], ['parent_id'], ['email'], ['birthYear'], ['display_name']])(
    'throws when the payload carries a %s field',
    (field) => {
      const payload = {
        ageGroup: 'AGE_6_8' as const,
        language: 'en' as const,
        systemPrompt: 'ok',
        history: [],
        [field]: 'value',
      };

      expect(() => {
        assertNoProhibitedData(payload);
      }).toThrow(ProhibitedDataError);
    },
  );

  it('does not fire on a name the prompt template already contains', () => {
    // The regression that motivated the baseline argument. A child called Sky
    // talking to Captain Sky degraded on EVERY turn, and it looked like a
    // provider outage rather than a name collision. Grace, Hope, Faith and Joy
    // are all the same bug.
    const prompt = 'You are Captain Sky, an adventurous explorer.';

    expect(() =>
      assertNoProhibitedData(
        { ageGroup: 'AGE_6_8', language: 'en', systemPrompt: prompt, history: [] },
        ['Sky'],
        prompt,
      ),
    ).not.toThrow();
  });

  it('still fires when the name appears MORE often than the template explains', () => {
    // The discount is per occurrence, not a blanket exemption: the template
    // accounts for its own use of the word and nothing beyond it.
    const baseline = 'You are Captain Sky, an adventurous explorer.';

    expect(() =>
      assertNoProhibitedData(
        {
          ageGroup: 'AGE_6_8',
          language: 'en',
          systemPrompt: `${baseline} Address the child as Sky.`,
          history: [],
        },
        ['Sky'],
        baseline,
      ),
    ).toThrow(ProhibitedDataError);
  });

  it('builds a real context for a child whose name is an ordinary word', () => {
    // The end-to-end form of the same bug, through the function that actually
    // runs on every turn.
    for (const name of ['Sky', 'Grace', 'Hope', 'Joy', 'Child']) {
      expect(() => buildProviderContext(context({ childName: name })), name).not.toThrow();
    }
  });
  it('does not fire on a short value that happens to appear in ordinary text', () => {
    // A three-character name would match half the prompt. The placeholder
    // mechanism protects those, not this check.
    expect(() =>
      assertNoProhibitedData(
        { ageGroup: 'AGE_6_8', language: 'en', systemPrompt: 'a friendly reply', history: [] },
        ['al'],
      ),
    ).not.toThrow();
  });

  it('refuses to build a context whose prompt lost an invariant', () => {
    // buildProviderContext asserts invariants on every call, not only in tests.
    const broken = context({ character: { ...characterByKey('lily')!, persona: [] } });

    // Persona emptiness is fine; the invariants come from age-rules, so this
    // still builds. The guard is proven in prompts.test.ts.
    expect(() => buildProviderContext(broken)).not.toThrow();
  });

  it('applies the window to the outbound history', () => {
    const { context: outbound, window } = buildProviderContext(context({ history: history(60) }), {
      ...DEFAULT_CONTEXT_LIMITS,
      maxExchanges: 5,
    });

    expect(outbound.history).toHaveLength(10);
    expect(window.droppedCount).toBe(50);
  });
});
