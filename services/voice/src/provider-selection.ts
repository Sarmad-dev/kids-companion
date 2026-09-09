import { createDeepgramProvider, createDeepgramTtsProvider } from './deepgram-provider.js';
import { createElevenLabsProvider, createElevenLabsSttProvider } from './elevenlabs-provider.js';
import { createMockSttProvider, createMockTtsProvider } from './mock-providers.js';
import type { SpeechToTextProvider, TextToSpeechProvider } from './ports.js';
import { createMemoryTtsCache, type TtsCache } from './tts-cache.js';

/**
 * Turning `STT_PROVIDER` / `TTS_PROVIDER` into two adapters.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS IS A FUNCTION RATHER THAN TWO CONDITIONALS IN `app.ts`
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * It used to be two, and each read "is this THE vendor, and is its key set —
 * otherwise the mock". That shape has a trap in it that only appears once a
 * vendor can serve both capabilities: the selection and the credential are
 * checked together, so naming a vendor whose key is missing does not fail, it
 * silently answers every child from a canned string. With one vendor per
 * capability that was survivable. With four combinations it is a coin toss
 * about which half of the loop is real.
 *
 * So the fallback is still a fallback — the mock is what a deployment gets
 * with no keys, which is the whole reason a fresh clone runs — but it is
 * REPORTED. `fellBackToMock` names each capability that asked for a vendor and
 * did not get one, and the caller logs it at boot. A mock in production is now
 * something you find in the startup log rather than in a support ticket.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ONE VENDOR FOR BOTH IS A CONFIGURATION, NOT A MODE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * There is deliberately no `VOICE_PROVIDER=deepgram` that sets both at once.
 * The two ports stay independently selected because they are independently
 * chosen — Urdu child-speech accuracy against voice character and per-character
 * pricing — and a single knob would quietly couple two decisions that ADR-0004
 * separates on purpose. Setting both variables to the same vendor is fully
 * supported and is the point of this change; it is just spelled as two choices,
 * because that is what it is.
 */

export interface VoiceProviderCredentials {
  readonly sttProvider: string;
  readonly ttsProvider: string;
  readonly deepgramApiKey?: string | undefined;
  readonly elevenLabsApiKey?: string | undefined;
  /** Overrides the per-vendor default model. Optional on both capabilities. */
  readonly sttModel?: string | undefined;
  readonly ttsModel?: string | undefined;
  /**
   * Shared by whichever TTS vendor is selected.
   *
   * Passed in rather than created here so a caller can supply the Redis-backed
   * one; an in-memory cache is created when none is given, because a TTS
   * adapter with no cache is the single largest avoidable cost in the product.
   */
  readonly ttsCache?: TtsCache | undefined;
}

export interface VoiceProviderSelection {
  readonly stt: SpeechToTextProvider;
  readonly tts: TextToSpeechProvider;
  /**
   * Capabilities that named a real vendor and got the mock anyway, because the
   * credential was missing. Empty on a correctly configured deployment, and on
   * one that asked for the mock in the first place.
   */
  readonly fellBackToMock: readonly ('stt' | 'tts')[];
}

export const resolveVoiceProviders = (
  credentials: VoiceProviderCredentials,
): VoiceProviderSelection => {
  const cache = credentials.ttsCache ?? createMemoryTtsCache();
  const fellBackToMock: ('stt' | 'tts')[] = [];

  /** Applies the configured model override, or leaves the vendor default. */
  const withModel = <T extends Record<string, unknown>>(base: T, model: string | undefined): T =>
    model === undefined ? base : { ...base, model };

  const stt = ((): SpeechToTextProvider => {
    switch (credentials.sttProvider) {
      case 'deepgram':
        if (credentials.deepgramApiKey !== undefined) {
          return createDeepgramProvider(
            withModel({ apiKey: credentials.deepgramApiKey }, credentials.sttModel),
          );
        }
        break;
      case 'elevenlabs':
        if (credentials.elevenLabsApiKey !== undefined) {
          return createElevenLabsSttProvider(
            withModel({ apiKey: credentials.elevenLabsApiKey }, credentials.sttModel),
          );
        }
        break;
      default:
        // `mock`, and the names the schema lists but nothing implements yet
        // (google, azure, openai). Both reach the mock; only the first is a
        // deliberate choice, which is why the other is reported below.
        break;
    }

    if (credentials.sttProvider !== 'mock') fellBackToMock.push('stt');
    return createMockSttProvider();
  })();

  const tts = ((): TextToSpeechProvider => {
    switch (credentials.ttsProvider) {
      case 'elevenlabs':
        if (credentials.elevenLabsApiKey !== undefined) {
          return createElevenLabsProvider(
            withModel({ apiKey: credentials.elevenLabsApiKey, cache }, credentials.ttsModel),
          );
        }
        break;
      case 'deepgram':
        if (credentials.deepgramApiKey !== undefined) {
          return createDeepgramTtsProvider(
            withModel({ apiKey: credentials.deepgramApiKey, cache }, credentials.ttsModel),
          );
        }
        break;
      default:
        break;
    }

    if (credentials.ttsProvider !== 'mock') fellBackToMock.push('tts');
    return createMockTtsProvider();
  })();

  return { stt, tts, fellBackToMock };
};
