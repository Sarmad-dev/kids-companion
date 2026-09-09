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
 * Deepgram — speech to text through Nova, and text to speech through Aura.
 *
 * ⚠️ NOT YET EXERCISED AGAINST THE LIVE API. Every behaviour below is written
 * from the documented contract; nothing here has been confirmed against a real
 * response. The mock is the default in local and ci, and this adapter must be
 * validated against real child speech before it carries a single real turn.
 * The Urdu question in particular is spike S-1 (Q-01) and is unanswered.
 *
 * Chosen first because it is the only candidate that documents a zero-retention
 * mode as a request parameter rather than an account setting — and ADR-0006
 * requires vendor-side retention to be verified rather than assumed. See §
 * "Retention" below for the flags this sends and what they do not guarantee.
 *
 * No Deepgram type crosses this file's boundary in either direction.
 */

export interface DeepgramProviderOptions {
  readonly apiKey: string;
  readonly model?: string;
  readonly baseUrl?: string;
  /** Injected so the adapter is testable without a network. */
  readonly fetchImpl?: typeof fetch;
}

/**
 * Our language codes to Deepgram's BCP-47.
 *
 * A code we cannot map is DROPPED rather than passed through: an unrecognised
 * language parameter makes Deepgram fall back to autodetect, which is precisely
 * what ARCHITECTURE.md §7.2 forbids on a four-year-old's two-second utterance.
 */
const LANGUAGE_CODES: Readonly<Partial<Record<SupportedLanguage, string>>> = Object.freeze({
  en: 'en',
  ur: 'ur',
  ar: 'ar',
  hi: 'hi',
  es: 'es',
  fr: 'fr',
  zh: 'zh',
});

interface DeepgramAlternative {
  transcript?: unknown;
  confidence?: unknown;
}

interface DeepgramResponse {
  results?: {
    channels?: {
      alternatives?: DeepgramAlternative[];
      detected_language?: unknown;
    }[];
  };
  metadata?: { duration?: unknown };
}

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

const asNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

export const createDeepgramProvider = (options: DeepgramProviderOptions): SpeechToTextProvider => {
  const baseUrl = options.baseUrl ?? 'https://api.deepgram.com';
  const model = options.model ?? 'nova-2-general';
  const doFetch = options.fetchImpl ?? fetch;

  return {
    name: 'deepgram',
    model,

    transcribe: async (request: TranscriptionRequest): Promise<Transcription> => {
      const language = LANGUAGE_CODES[request.languageHints[0] ?? 'en'];

      const params = new URLSearchParams({
        model,
        punctuate: 'true',
        smart_format: 'true',
        // RETENTION. `mip_opt_out` opts out of the Model Improvement Program,
        // which is the vendor-side half of ADR-0006. It is sent on every request
        // rather than relying on an account setting, because an account setting
        // is one console click from being wrong and nobody would notice.
        //
        // This is NOT a guarantee that no audio is retained anywhere in their
        // infrastructure. That has to be established contractually and verified,
        // and until it is, this adapter is not cleared for production traffic.
        mip_opt_out: 'true',
      });
      if (language !== undefined) params.set('language', language);

      let response: Response;
      try {
        response = await withTimeout(
          'deepgram.transcribe',
          request.timeoutMs,
          async (signal) =>
            await doFetch(`${baseUrl}/v1/listen?${params.toString()}`, {
              method: 'POST',
              headers: {
                authorization: `Token ${options.apiKey}`,
                'content-type': request.mimeType,
              },
              // Node 24 types the undici body as a union that does not name
              // Uint8Array directly; the runtime accepts it.
              body: request.audio,
              signal,
            }),
        );
      } catch (error) {
        if (error instanceof ProviderTimeoutError) throw error;
        throw new ProviderUnavailableError('deepgram.transcribe', error);
      }

      if (!response.ok) {
        // The body is deliberately not read into the error. A vendor error
        // response can echo submitted content, and the submitted content here is
        // a child's voice.
        throw new ProviderUnavailableError(`deepgram.transcribe:${String(response.status)}`);
      }

      let payload: DeepgramResponse;
      try {
        payload = (await response.json()) as DeepgramResponse;
      } catch (error) {
        throw new ProviderUnavailableError('deepgram.transcribe:unparseable', error);
      }

      const channel = payload.results?.channels?.[0];
      const alternative = channel?.alternatives?.[0];
      const text = asString(alternative?.transcript);

      // A response we cannot read is NOT an empty transcript. Treating it as one
      // would send a child a cheerful reply to a message we never understood.
      if (text === undefined) {
        throw new ProviderUnavailableError('deepgram.transcribe:no_transcript');
      }

      const detected = asString(channel?.detected_language)?.slice(0, 2);
      const durationSeconds = asNumber(payload.metadata?.duration) ?? 0;

      return {
        text: text.trim(),
        // A missing confidence is treated as LOW, not as certain. The
        // "I didn't quite catch that" path is the safe default here.
        confidence: asNumber(alternative?.confidence) ?? 0,
        ...(detected !== undefined && detected in LANGUAGE_CODES
          ? { detectedLanguage: detected as SupportedLanguage }
          : {}),
        durationMs: Math.round(durationSeconds * 1000),
      };
    },
  };
};

/* -------------------------------------------------------------------------- */
/* Text to speech — Aura                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Deepgram Aura, so one vendor can serve both halves of the voice loop.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE VOICE IS THE MODEL HERE, WHICH IS NOT HOW THE OTHER VENDOR WORKS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ElevenLabs takes a voice id in the path and a model in the body; they vary
 * independently. Aura has no separate voice id at all — `aura-2-thalia-en` IS
 * both the model and the voice, and there is no second axis.
 *
 * So this adapter maps the port's `voiceId` onto Aura's model parameter, and
 * `options.model` is only the DEFAULT for a request that names no voice. That
 * is the honest mapping rather than an approximation: the port asks for "which
 * voice", and on this vendor the answer is spelled as a model name. The
 * alternative — sending our voice id as something Aura would ignore — would
 * give every character the same voice and look like it worked.
 *
 * The cache key carries the resolved Aura model, so this cannot collide with
 * ElevenLabs audio even before the `provider` field is taken into account.
 *
 * ⚠️ NOT YET EXERCISED AGAINST THE LIVE API, like every other adapter here.
 */

export interface DeepgramTtsProviderOptions {
  readonly apiKey: string;
  /** The Aura voice used when a request names none. */
  readonly model?: string;
  readonly baseUrl?: string;
  readonly cache?: TtsCache;
  readonly fetchImpl?: typeof fetch;
}

/**
 * MP3, to match what the other TTS adapter returns.
 *
 * The pipeline, the storage layer and the mobile player all deal in one reply
 * format, and a vendor switch that silently changed the container would be a
 * playback bug on the device rather than an error on the server. Aura defaults
 * to linear16 WAV, so this is set explicitly rather than left to the vendor.
 */
const AURA_ENCODING = 'mp3';

export const createDeepgramTtsProvider = (
  options: DeepgramTtsProviderOptions,
): TextToSpeechProvider => {
  const baseUrl = options.baseUrl ?? 'https://api.deepgram.com';
  const defaultModel = options.model ?? 'aura-2-thalia-en';
  const doFetch = options.fetchImpl ?? fetch;

  return {
    name: 'deepgram',
    model: defaultModel,

    synthesize: async (request: SynthesisRequest): Promise<SynthesisResult> => {
      // `default` is what the conversation routes send for a character with no
      // voice configured; it is our sentinel, not an Aura model, so it must not
      // reach the vendor.
      const voice =
        request.voiceId === '' || request.voiceId === 'default' ? defaultModel : request.voiceId;

      const key = ttsCacheKey({
        provider: 'deepgram',
        text: request.text,
        voiceId: voice,
        model: voice,
        format: AURA_ENCODING,
      });

      if (options.cache) {
        const hit = await options.cache.get(key);
        if (hit) return { ...hit, fromCache: true };
      }

      const params = new URLSearchParams({ model: voice, encoding: AURA_ENCODING });

      let response: Response;
      try {
        response = await withTimeout(
          'deepgram.synthesize',
          request.timeoutMs,
          async (signal) =>
            await doFetch(`${baseUrl}/v1/speak?${params.toString()}`, {
              method: 'POST',
              headers: {
                authorization: `Token ${options.apiKey}`,
                'content-type': 'application/json',
                accept: 'audio/mpeg',
              },
              body: JSON.stringify({ text: request.text }),
              signal,
            }),
        );
      } catch (error) {
        if (error instanceof ProviderTimeoutError) throw error;
        throw new ProviderUnavailableError('deepgram.synthesize', error);
      }

      if (!response.ok) {
        throw new ProviderUnavailableError(`deepgram.synthesize:${String(response.status)}`);
      }

      const audio = new Uint8Array(await response.arrayBuffer());
      if (audio.length === 0) {
        // Silence is not a valid reply. Better to degrade to the text-only path
        // than to hand a child a player that plays nothing.
        throw new ProviderUnavailableError('deepgram.synthesize:empty');
      }

      // Same 128 kbit/s estimate the other adapter uses: an approximation for a
      // progress indicator and a duration column, never enforced on.
      const durationMs = Math.round((audio.length / 16_000) * 1000);
      const result = { audio, mimeType: 'audio/mpeg', durationMs };

      if (options.cache) await options.cache.set(key, result);

      return { ...result, fromCache: false };
    },
  };
};
