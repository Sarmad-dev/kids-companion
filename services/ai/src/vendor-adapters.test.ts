import { ProviderUnavailableError } from '@kids/shared';
import { describe, expect, it } from 'vitest';

import { createGoogleProvider } from './google-provider.js';
import { createOpenAIProvider } from './openai-provider.js';
import type { ProviderContext } from './ports.js';

/**
 * The two adapters that have never met their live API.
 *
 * These tests cannot prove the request shapes are ACCEPTED — only a key can do
 * that, and the adapters say so. What they do prove is the part that would
 * otherwise be discovered in production: that the roles, the credential
 * placement, and above all the fail-closed classifier behaviour are what the
 * port promises, whichever vendor is answering.
 */

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** A `fetch` that records the request and answers with `payload`. */
const stub = (payload: unknown, captured: Captured[] = []) => {
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    // Every adapter here serialises its body with JSON.stringify, so this is a
    // string in practice; the guard keeps the cast honest rather than assumed.
    const body = typeof init?.body === 'string' ? init.body : '{}';
    captured.push({
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: JSON.parse(body) as Record<string, unknown>,
    });
    return {
      ok: true,
      status: 200,
      json: async () => payload,
    } as Response;
  }) as unknown as typeof fetch;

  return { fetchImpl, captured };
};

const context = (overrides: Partial<ProviderContext> = {}): ProviderContext => ({
  ageGroup: 'AGE_6_8',
  language: 'en',
  systemPrompt: 'You are Lily.',
  history: [],
  ...overrides,
});

/* -------------------------------------------------------------------------- */
/* OpenAI                                                                      */
/* -------------------------------------------------------------------------- */

const openaiReply = (content: string, finish = 'stop') => ({
  choices: [{ message: { content }, finish_reason: finish }],
  usage: { prompt_tokens: 100, completion_tokens: 50 },
  model: 'gpt-4.1-mini',
});

const openai = (payload: unknown) => {
  const { fetchImpl, captured } = stub(payload);
  return {
    captured,
    provider: createOpenAIProvider({
      apiKey: 'sk-test',
      conversationModel: 'gpt-4.1-mini',
      classifierModel: 'gpt-4.1-nano',
      fetchImpl,
    }),
  };
};

describe('the OpenAI adapter', () => {
  it('sends the system prompt as the first message and maps our roles', async () => {
    const { provider, captured } = openai(openaiReply('Hello!'));

    await provider.generateResponse({
      context: context({
        history: [
          { role: 'child', text: 'hi' },
          { role: 'companion', text: 'hello there' },
        ],
      }),
      utterance: 'what shall we do',
      maxOutputTokens: 200,
      temperature: 0.7,
      timeoutMs: 5_000,
    });

    expect(captured[0]?.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(captured[0]?.headers.authorization).toBe('Bearer sk-test');
    expect(captured[0]?.body.messages).toEqual([
      { role: 'system', content: 'You are Lily.' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello there' },
      { role: 'user', content: 'what shall we do' },
    ]);
  });

  it('uses max_completion_tokens, which the reasoning models require', async () => {
    const { provider, captured } = openai(openaiReply('Hello!'));

    await provider.generateResponse({
      context: context(),
      utterance: 'hi',
      maxOutputTokens: 200,
      temperature: 0.7,
      timeoutMs: 5_000,
    });

    expect(captured[0]?.body.max_completion_tokens).toBe(200);
    expect(captured[0]?.body.max_tokens).toBeUndefined();
  });

  it('reports a length stop as truncated, and prices the turn', async () => {
    const { provider } = openai(openaiReply('Hello!', 'length'));

    const result = await provider.generateResponse({
      context: context(),
      utterance: 'hi',
      maxOutputTokens: 200,
      temperature: 0.7,
      timeoutMs: 5_000,
    });

    expect(result.truncated).toBe(true);
    expect(result.usage.inputTokens).toBe(100);
    expect(result.usage.outputTokens).toBe(50);
    expect(result.usage.estimatedCostUsd).toBeGreaterThan(0);
  });

  it('classifies on the small model, never the conversation one', async () => {
    // Classification runs twice per turn. Using the conversation model would
    // roughly triple the cost of every exchange (ARCHITECTURE.md C3).
    const { provider, captured } = openai(
      openaiReply('{"flagged":false,"categories":[],"confidence":0.9}'),
    );

    await provider.moderateContent({
      text: 'I went to the park',
      ageGroup: 'AGE_6_8',
      language: 'en',
      source: 'child_input',
      timeoutMs: 4_000,
    });

    expect(captured[0]?.body.model).toBe('gpt-4.1-nano');
  });

  it('fails closed when the classifier answers with something unreadable', async () => {
    const { provider } = openai(openaiReply('I am afraid I cannot help with that.'));

    const result = await provider.moderateContent({
      text: 'anything',
      ageGroup: 'AGE_6_8',
      language: 'en',
      source: 'child_input',
      timeoutMs: 4_000,
    });

    expect(result.flagged).toBe(true);
    expect(result.confidence).toBe(0);
  });

  it('escalates the categories that route to a human', async () => {
    const { provider } = openai(
      openaiReply('{"flagged":true,"categories":["disclosure_of_harm"],"confidence":0.95}'),
    );

    const result = await provider.moderateContent({
      text: 'anything',
      ageGroup: 'AGE_6_8',
      language: 'en',
      source: 'child_input',
      timeoutMs: 4_000,
    });

    expect(result.requiresEscalation).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Google                                                                      */
/* -------------------------------------------------------------------------- */

const geminiReply = (text: string, finishReason = 'STOP') => ({
  candidates: [{ content: { parts: [{ text }] }, finishReason }],
  usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 },
  modelVersion: 'gemini-2.5-flash',
});

const google = (payload: unknown) => {
  const { fetchImpl, captured } = stub(payload);
  return {
    captured,
    provider: createGoogleProvider({
      apiKey: 'AIza-test',
      conversationModel: 'gemini-2.5-flash',
      classifierModel: 'gemini-2.5-flash-lite',
      fetchImpl,
    }),
  };
};

describe('the Google adapter', () => {
  it('puts the key in a header, never in the query string', async () => {
    // Every Gemini example uses `?key=…`, which then lands in proxy logs and in
    // anything that records an outbound URL (SECURITY.md §4.1).
    const { provider, captured } = google(geminiReply('Hello!'));

    await provider.generateResponse({
      context: context(),
      utterance: 'hi',
      maxOutputTokens: 200,
      temperature: 0.7,
      timeoutMs: 5_000,
    });

    expect(captured[0]?.url).not.toContain('key=');
    expect(captured[0]?.url).not.toContain('AIza-test');
    expect(captured[0]?.headers['x-goog-api-key']).toBe('AIza-test');
  });

  it('sends the system prompt separately and calls the companion "model"', async () => {
    const { provider, captured } = google(geminiReply('Hello!'));

    await provider.generateResponse({
      context: context({
        history: [
          { role: 'child', text: 'hi' },
          { role: 'companion', text: 'hello there' },
        ],
      }),
      utterance: 'what shall we do',
      maxOutputTokens: 200,
      temperature: 0.7,
      timeoutMs: 5_000,
    });

    expect(captured[0]?.body.systemInstruction).toEqual({ parts: [{ text: 'You are Lily.' }] });
    expect(captured[0]?.body.contents).toEqual([
      { role: 'user', parts: [{ text: 'hi' }] },
      { role: 'model', parts: [{ text: 'hello there' }] },
      { role: 'user', parts: [{ text: 'what shall we do' }] },
    ]);
  });

  it('drops leading companion turns, which Gemini rejects outright', async () => {
    // A story the app seeded opens with the companion speaking. Sending that
    // window verbatim is a 400, not a worse answer.
    const { provider, captured } = google(geminiReply('Hello!'));

    await provider.generateResponse({
      context: context({
        history: [
          { role: 'companion', text: 'Once upon a time...' },
          { role: 'child', text: 'and then?' },
        ],
      }),
      utterance: 'go on',
      maxOutputTokens: 200,
      temperature: 0.7,
      timeoutMs: 5_000,
    });

    expect(captured[0]?.body.contents).toEqual([
      { role: 'user', parts: [{ text: 'and then?' }] },
      { role: 'user', parts: [{ text: 'go on' }] },
    ]);
  });

  it('treats a blocked, candidate-less answer as an outage rather than as silence', async () => {
    // Gemini's own filters answer 200 with no candidate. Returning that
    // verbatim would give a child a character that says nothing; raising sends
    // the turn down the path that already degrades to something warm.
    const { provider } = google({ candidates: [], promptFeedback: { blockReason: 'SAFETY' } });

    await expect(
      provider.generateResponse({
        context: context(),
        utterance: 'hi',
        maxOutputTokens: 200,
        temperature: 0.7,
        timeoutMs: 5_000,
      }),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  it('fails closed when the classifier is the thing Gemini blocked', async () => {
    const { provider } = google({ candidates: [] });

    const result = await provider.moderateContent({
      text: 'anything',
      ageGroup: 'AGE_6_8',
      language: 'en',
      source: 'child_input',
      timeoutMs: 4_000,
    });

    expect(result.flagged).toBe(true);
  });

  it('falls back to the declared language when detection is unreadable', async () => {
    // Detection fails OPEN, unlike moderation: blocking a turn because we could
    // not tell which language a four-year-old used is the wrong trade.
    const { provider } = google(geminiReply('no idea, sorry'));

    const result = await provider.detectLanguage({
      text: 'kya haal hai',
      candidates: ['ur', 'en'],
      timeoutMs: 2_000,
    });

    expect(result.language).toBe('ur');
    expect(result.confidence).toBe(0);
  });

  it('reports a token ceiling as truncated', async () => {
    const { provider } = google(geminiReply('Hello!', 'MAX_TOKENS'));

    const result = await provider.generateResponse({
      context: context(),
      utterance: 'hi',
      maxOutputTokens: 200,
      temperature: 0.7,
      timeoutMs: 5_000,
    });

    expect(result.truncated).toBe(true);
  });

  /**
   * Non-zero on purpose, even though the default models are free-tier.
   * `AI_DAILY_COST_CEILING_USD` is enforced against this estimate, so an
   * adapter reporting zero would make that ceiling inert the day someone points
   * it at a paid key.
   */
  it('prices a turn even on the free tier, so the cost ceiling stays load-bearing', async () => {
    const { provider } = google(geminiReply('Hello!'));

    const result = await provider.generateResponse({
      context: context(),
      utterance: 'hi',
      maxOutputTokens: 200,
      temperature: 0.7,
      timeoutMs: 5_000,
    });

    expect(result.usage.estimatedCostUsd).toBeGreaterThan(0);
  });
});
