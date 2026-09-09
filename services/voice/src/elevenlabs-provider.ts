import { ProviderTimeoutError, ProviderUnavailableError, withTimeout } from '@kids/shared';
import type { SupportedLanguage } from '@kids/types';

import type {
  SpeechToTextProvider,
  SynthesisRequest,
  SynthesisResult,
  TextToSpeechProvider,
  Transcription,
  TranscriptionRequest,
} from './ports.js';
import { ttsCacheKey, type TtsCache } from './tts-cache.js';

/**
 * ElevenLabs — text to speech, and speech to text through Scribe.
 *
 * ⚠️ NOT YET EXERCISED AGAINST THE LIVE API. Written from the documented
 * contract; no behaviour here has been confirmed against a real response. The
 * mock is the default in local and ci.
 *
 * Two things make TTS different from every other provider in this system.
 *
 * **Cost is per character, and children repeat themselves.** "Tell me a story"
 * produces the same opening line hundreds of times a day. The content-hash cache
 * below is the single largest cost lever in the product, and it is in the
 * adapter rather than the pipeline because the cache key depends on the vendor's
 * voice and model, not on our conversation.
 *
 * **The text is already safe.** By the time synthesis runs, OUTPUT_SAFETY_CHECK
 * has passed — TTS is downstream of the safety pipeline, never a way around it.
 */

export interface ElevenLabsProviderOptions {
  readonly apiKey: string;
  readonly model?: string;
  readonly baseUrl?: string;
  readonly cache?: TtsCache;
  readonly fetchImpl?: typeof fetch;
}

const OUTPUT_FORMAT = 'mp3_44100_128';

export const createElevenLabsProvider = (
  options: ElevenLabsProviderOptions,
): TextToSpeechProvider => {
  const baseUrl = options.baseUrl ?? 'https://api.elevenlabs.io';
  const model = options.model ?? 'eleven_turbo_v2_5';
  const doFetch = options.fetchImpl ?? fetch;

  return {
    name: 'elevenlabs',
    model,

    synthesize: async (request: SynthesisRequest): Promise<SynthesisResult> => {
      const key = ttsCacheKey({
        provider: 'elevenlabs',
        text: request.text,
        voiceId: request.voiceId,
        model,
        format: OUTPUT_FORMAT,
      });

      if (options.cache) {
        const hit = await options.cache.get(key);
        if (hit) return { ...hit, fromCache: true };
      }

      let response: Response;
      try {
        response = await withTimeout(
          'elevenlabs.synthesize',
          request.timeoutMs,
          async (signal) =>
            await doFetch(
              `${baseUrl}/v1/text-to-speech/${encodeURIComponent(request.voiceId)}?output_format=${OUTPUT_FORMAT}`,
              {
                method: 'POST',
                headers: {
                  'xi-api-key': options.apiKey,
                  'content-type': 'application/json',
                  accept: 'audio/mpeg',
                },
                body: JSON.stringify({ text: request.text, model_id: model }),
                signal,
              },
            ),
        );
      } catch (error) {
        if (error instanceof ProviderTimeoutError) throw error;
        throw new ProviderUnavailableError('elevenlabs.synthesize', error);
      }

      if (!response.ok) {
        throw new ProviderUnavailableError(`elevenlabs.synthesize:${String(response.status)}`);
      }

      const audio = new Uint8Array(await response.arrayBuffer());
      if (audio.length === 0) {
        // Silence is not a valid reply. Better to degrade to the text-only path
        // than to hand a child a player that plays nothing.
        throw new ProviderUnavailableError('elevenlabs.synthesize:empty');
      }

      // 128 kbit/s is 16 kB per second. An estimate, and it is only used for a
      // progress indicator and a duration column — nothing enforces on it.
      const durationMs = Math.round((audio.length / 16_000) * 1000);
      const result = { audio, mimeType: 'audio/mpeg', durationMs };

      if (options.cache) await options.cache.set(key, result);

      return { ...result, fromCache: false };
    },
  };
};

/* -------------------------------------------------------------------------- */
/* Speech to text — Scribe                                                     */
/* -------------------------------------------------------------------------- */

/**
 * ElevenLabs Scribe, so one vendor can serve both halves of the voice loop.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THIS DOES NOT MERGE THE TWO PORTS, AND MUST NOT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `ports.ts` keeps STT and TTS separate because the two are chosen on entirely
 * different criteria — Urdu child-speech accuracy against voice character and
 * per-character pricing — and there is no reason to assume one vendor wins
 * both. That reasoning is unchanged. What changes is only that picking one
 * vendor for both is now POSSIBLE: one adapter per capability, selected
 * independently by `STT_PROVIDER` and `TTS_PROVIDER`.
 *
 * ⚠️ NOT YET EXERCISED AGAINST THE LIVE API, and the Urdu question (Q-01) is
 * open for this vendor exactly as it is for Deepgram. Adding a second candidate
 * does not answer that spike; it gives the spike something to compare.
 */

const SCRIBE_LANGUAGE_CODES: Readonly<Partial<Record<SupportedLanguage, string>>> = Object.freeze({
  en: 'eng',
  ur: 'urd',
  ar: 'ara',
  hi: 'hin',
  es: 'spa',
  fr: 'fra',
  zh: 'cmn',
});

/** Scribe's ISO-639-3 back to ours, for the `detectedLanguage` field. */
const SCRIBE_TO_OURS: Readonly<Record<string, SupportedLanguage>> = Object.freeze(
  Object.fromEntries(
    Object.entries(SCRIBE_LANGUAGE_CODES).map(([ours, theirs]) => [theirs, ours]),
  ) as Record<string, SupportedLanguage>,
);

export interface ElevenLabsSttProviderOptions {
  readonly apiKey: string;
  readonly model?: string;
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
}

interface ScribeWord {
  type?: unknown;
  logprob?: unknown;
}

interface ScribeResponse {
  text?: unknown;
  language_code?: unknown;
  words?: ScribeWord[];
}

const asStringValue = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

const asFiniteNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

/**
 * Mean per-word probability, as this port's `confidence`.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY NOT `language_probability`, WHICH IS THE OBVIOUS FIELD TO REACH FOR
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Because it answers a different question. It says how sure Scribe is about
 * WHICH LANGUAGE it heard, not about the WORDS — and this port's confidence
 * drives "I didn't quite catch that". A child mumbling something
 * unintelligible in unmistakable English scores high on language and low on
 * words, so using the wrong field would reply confidently to something they
 * never said (R-01).
 *
 * Word logprobs are the closest thing Scribe exposes to a transcription
 * confidence, so they are what gets averaged. Audio events — Scribe emits
 * `audio_event` entries for laughter and the like — are skipped: they are not
 * words, and their scores say nothing about whether we heard the sentence.
 *
 * Returns `undefined` when there is nothing to average, which the caller treats
 * as LOW rather than as certain. If a future API version stops returning
 * logprobs, every turn routes to "say that again" — loud, visible and safe,
 * unlike the alternative of silently trusting an unscored transcript.
 */
const confidenceFrom = (words: readonly ScribeWord[] | undefined): number | undefined => {
  const scores = (words ?? [])
    .filter((word) => asStringValue(word.type) !== 'audio_event')
    .map((word) => asFiniteNumber(word.logprob))
    .filter((logprob): logprob is number => logprob !== undefined);

  if (scores.length === 0) return undefined;

  const mean = scores.reduce((total, logprob) => total + Math.exp(logprob), 0) / scores.length;
  // Clamped: a logprob above 0 is not meaningful, and a confidence above 1
  // would silently defeat every threshold that compares against it.
  return Math.min(1, Math.max(0, mean));
};

export const createElevenLabsSttProvider = (
  options: ElevenLabsSttProviderOptions,
): SpeechToTextProvider => {
  const baseUrl = options.baseUrl ?? 'https://api.elevenlabs.io';
  const model = options.model ?? 'scribe_v1';
  const doFetch = options.fetchImpl ?? fetch;

  return {
    name: 'elevenlabs',
    model,

    transcribe: async (request: TranscriptionRequest): Promise<Transcription> => {
      const language = SCRIBE_LANGUAGE_CODES[request.languageHints[0] ?? 'en'];

      const form = new FormData();
      form.set('model_id', model);
      form.set('file', new Blob([request.audio], { type: request.mimeType }), 'audio');
      // An unmappable code is DROPPED rather than passed through. Same rule as
      // Deepgram, for the same reason: a rejected request is worse than letting
      // the vendor detect.
      if (language !== undefined) form.set('language_code', language);
      // Diarisation off, timestamps unrequested: neither is used, and both make
      // the response carry more of a child's voice than the one thing this
      // pipeline needs from it (docs/adr/0006).
      form.set('diarize', 'false');

      let response: Response;
      try {
        response = await withTimeout(
          'elevenlabs.transcribe',
          request.timeoutMs,
          async (signal) =>
            await doFetch(`${baseUrl}/v1/speech-to-text`, {
              method: 'POST',
              // No content-type header: fetch sets the multipart boundary, and
              // setting it by hand produces a body the server cannot parse.
              headers: { 'xi-api-key': options.apiKey },
              body: form,
              signal,
            }),
        );
      } catch (error) {
        if (error instanceof ProviderTimeoutError) throw error;
        throw new ProviderUnavailableError('elevenlabs.transcribe', error);
      }

      if (!response.ok) {
        // The body is deliberately not read into the error. A vendor error
        // response can echo submitted content, and the submitted content here
        // is a child's voice.
        throw new ProviderUnavailableError(`elevenlabs.transcribe:${String(response.status)}`);
      }

      let payload: ScribeResponse;
      try {
        payload = (await response.json()) as ScribeResponse;
      } catch (error) {
        throw new ProviderUnavailableError('elevenlabs.transcribe:unparseable', error);
      }

      const text = asStringValue(payload.text);

      // A response we cannot read is NOT an empty transcript. Treating it as one
      // would send a child a cheerful reply to a message we never understood.
      if (text === undefined) {
        throw new ProviderUnavailableError('elevenlabs.transcribe:no_transcript');
      }

      const detected = asStringValue(payload.language_code);
      const ours = detected === undefined ? undefined : SCRIBE_TO_OURS[detected];

      return {
        text: text.trim(),
        // A missing confidence is treated as LOW, not as certain.
        confidence: confidenceFrom(payload.words) ?? 0,
        ...(ours === undefined ? {} : { detectedLanguage: ours }),
        // Scribe does not return an audio duration. The pipeline measures the
        // upload itself and nothing enforces on this field, so reporting 0 is
        // honest where an invented number would not be.
        durationMs: 0,
      };
    },
  };
};
