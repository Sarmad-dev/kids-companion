import { ProviderUnavailableError } from '@kids/shared';
import { describe, expect, it } from 'vitest';

import { createDeepgramTtsProvider } from './deepgram-provider.js';
import { createElevenLabsSttProvider } from './elevenlabs-provider.js';
import { ttsCacheKey, createMemoryTtsCache } from './tts-cache.js';

/**
 * The two adapters added so one vendor can serve both halves of the loop.
 *
 * Neither has met its live API — the same caveat every adapter here carries.
 * What these pin down is the part that would otherwise surface as a child
 * hearing the wrong voice or being answered confidently about something they
 * never said.
 */

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

const stub = (respond: () => Partial<Response> & { json?: () => Promise<unknown> }) => {
  const captured: Captured[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    captured.push({
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body,
    });
    return respond() as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, captured };
};

const jsonOk = (payload: unknown) => () => ({
  ok: true,
  status: 200,
  json: async () => payload,
});

const audioOk = (bytes: Uint8Array) => () => ({
  ok: true,
  status: 200,
  // Copied into a fresh buffer rather than sliced out of the view's own: a
  // typed array's `.buffer` is typed as possibly shared, which a Response is
  // not allowed to hand back.
  arrayBuffer: async (): Promise<ArrayBuffer> => {
    const copy = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(copy).set(bytes);
    return await Promise.resolve(copy);
  },
});

/* -------------------------------------------------------------------------- */
/* ElevenLabs Scribe — speech to text                                          */
/* -------------------------------------------------------------------------- */

const scribe = (payload: unknown) => {
  const { fetchImpl, captured } = stub(jsonOk(payload));
  return {
    captured,
    provider: createElevenLabsSttProvider({ apiKey: 'xi-test', fetchImpl }),
  };
};

const transcribeRequest = {
  audio: new Uint8Array([1, 2, 3]),
  mimeType: 'audio/webm',
  languageHints: ['ur', 'en'] as const,
  ageGroup: 'AGE_6_8' as const,
  timeoutMs: 5_000,
};

describe('the ElevenLabs Scribe adapter', () => {
  it('sends the audio to the speech-to-text endpoint with the vendor key header', async () => {
    const { provider, captured } = scribe({ text: 'hello', words: [] });

    await provider.transcribe(transcribeRequest);

    expect(captured[0]?.url).toBe('https://api.elevenlabs.io/v1/speech-to-text');
    expect(captured[0]?.headers['xi-api-key']).toBe('xi-test');
    // The multipart boundary has to come from fetch; setting content-type by
    // hand produces a body the server cannot parse.
    expect(captured[0]?.headers['content-type']).toBeUndefined();
    expect(captured[0]?.body).toBeInstanceOf(FormData);
  });

  it('constrains detection to the child profile rather than autodetecting', async () => {
    // Autodetect on a four-year-old's two-second utterance produces nonsense
    // that then drives the whole turn (ARCHITECTURE.md §7.2).
    const { provider, captured } = scribe({ text: 'hello', words: [] });

    await provider.transcribe(transcribeRequest);

    const form = captured[0]?.body as FormData;
    expect(form.get('language_code')).toBe('urd');
    expect(form.get('model_id')).toBe('scribe_v1');
    expect(form.get('diarize')).toBe('false');
  });

  it('derives confidence from word logprobs, not from language probability', async () => {
    // language_probability answers "which language", not "which words". Using
    // it would reply confidently to a mumble in unmistakable English (R-01).
    const { provider } = scribe({
      text: 'I went to the park',
      language_code: 'eng',
      language_probability: 0.99,
      words: [
        { type: 'word', logprob: Math.log(0.8) },
        { type: 'word', logprob: Math.log(0.6) },
      ],
    });

    const result = await provider.transcribe(transcribeRequest);

    expect(result.confidence).toBeCloseTo(0.7, 5);
    expect(result.detectedLanguage).toBe('en');
  });

  it('ignores audio events when scoring, because they are not words', async () => {
    const { provider } = scribe({
      text: 'hello',
      words: [
        { type: 'word', logprob: Math.log(0.9) },
        { type: 'audio_event', logprob: Math.log(0.1) },
      ],
    });

    const result = await provider.transcribe(transcribeRequest);

    expect(result.confidence).toBeCloseTo(0.9, 5);
  });

  it('treats an unscored transcript as LOW confidence, never as certain', async () => {
    // Routes to "I didn't quite catch that" — loud and safe — rather than
    // silently trusting a transcript nothing vouched for.
    const { provider } = scribe({ text: 'hello', words: [] });

    const result = await provider.transcribe(transcribeRequest);

    expect(result.confidence).toBe(0);
  });

  it('raises rather than reporting an empty transcript when the body is unreadable', async () => {
    // An empty transcript would send a child a cheerful reply to a message we
    // never understood.
    const { provider } = scribe({ language_code: 'eng' });

    await expect(provider.transcribe(transcribeRequest)).rejects.toBeInstanceOf(
      ProviderUnavailableError,
    );
  });

  it('does not read the vendor error body into the error', async () => {
    // A vendor error response can echo submitted content, and the submitted
    // content here is a child's voice.
    const { fetchImpl } = stub(() => ({ ok: false, status: 422 }));
    const provider = createElevenLabsSttProvider({ apiKey: 'xi-test', fetchImpl });

    await expect(provider.transcribe(transcribeRequest)).rejects.toThrow(/422/);
  });
});

/* -------------------------------------------------------------------------- */
/* Deepgram Aura — text to speech                                              */
/* -------------------------------------------------------------------------- */

const synthesisRequest = {
  text: 'Once upon a time',
  voiceId: 'aura-2-luna-en',
  language: 'en' as const,
  timeoutMs: 5_000,
};

describe('the Deepgram Aura adapter', () => {
  it('sends the voice as the model, which is how Aura names voices', async () => {
    const { fetchImpl, captured } = stub(audioOk(new Uint8Array([1, 2, 3, 4])));
    const provider = createDeepgramTtsProvider({ apiKey: 'dg-test', fetchImpl });

    await provider.synthesize(synthesisRequest);

    expect(captured[0]?.url).toContain('model=aura-2-luna-en');
    expect(captured[0]?.headers.authorization).toBe('Token dg-test');
  });

  it('asks for mp3 explicitly, because Aura defaults to WAV', async () => {
    // The pipeline, storage and the mobile player all deal in one reply format.
    // A vendor switch that changed the container would be a playback bug on the
    // device rather than an error on the server.
    const { fetchImpl, captured } = stub(audioOk(new Uint8Array([1, 2, 3, 4])));
    const provider = createDeepgramTtsProvider({ apiKey: 'dg-test', fetchImpl });

    const result = await provider.synthesize(synthesisRequest);

    expect(captured[0]?.url).toContain('encoding=mp3');
    expect(result.mimeType).toBe('audio/mpeg');
  });

  it('substitutes its own voice for the "default" sentinel', async () => {
    // `default` is what the conversation routes send for a character with no
    // voice configured. It is our sentinel, not an Aura model.
    const { fetchImpl, captured } = stub(audioOk(new Uint8Array([1, 2, 3, 4])));
    const provider = createDeepgramTtsProvider({
      apiKey: 'dg-test',
      model: 'aura-2-thalia-en',
      fetchImpl,
    });

    await provider.synthesize({ ...synthesisRequest, voiceId: 'default' });

    expect(captured[0]?.url).toContain('model=aura-2-thalia-en');
    expect(captured[0]?.url).not.toContain('default');
  });

  it('serves a repeated line from the cache — the largest cost lever there is', async () => {
    const { fetchImpl, captured } = stub(audioOk(new Uint8Array([1, 2, 3, 4])));
    const provider = createDeepgramTtsProvider({
      apiKey: 'dg-test',
      cache: createMemoryTtsCache(),
      fetchImpl,
    });

    const first = await provider.synthesize(synthesisRequest);
    const second = await provider.synthesize(synthesisRequest);

    expect(first.fromCache).toBe(false);
    expect(second.fromCache).toBe(true);
    expect(captured).toHaveLength(1);
  });

  it('cannot serve another vendor audio out of a shared cache', async () => {
    // Both TTS adapters share one cache object, so the key has to separate them.
    const shared = { text: 'hi', voiceId: 'v1', model: 'm1', format: 'mp3' };

    expect(ttsCacheKey({ ...shared, provider: 'deepgram' })).not.toBe(
      ttsCacheKey({ ...shared, provider: 'elevenlabs' }),
    );
  });

  it('refuses to hand back silence', async () => {
    // Better to degrade to the text-only path than to give a child a player
    // that plays nothing.
    const { fetchImpl } = stub(audioOk(new Uint8Array([])));
    const provider = createDeepgramTtsProvider({ apiKey: 'dg-test', fetchImpl });

    await expect(provider.synthesize(synthesisRequest)).rejects.toBeInstanceOf(
      ProviderUnavailableError,
    );
  });
});
