import { ProviderTimeoutError, ProviderUnavailableError } from '@kids/shared';

import { CANONICAL_MIME } from './formats.js';
import type {
  SpeechToTextProvider,
  SynthesisRequest,
  SynthesisResult,
  TextToSpeechProvider,
  Transcription,
  TranscriptionRequest,
} from './ports.js';

/**
 * Mock STT and TTS.
 *
 * The default in `local` and `ci`, so the whole voice loop runs on a fresh clone
 * with no API keys and no spend — including the safety pipeline, which is the
 * part most worth exercising on every commit.
 *
 * Behaviours are injectable so the failure paths are testable: a real timeout, a
 * real outage, an unintelligible child, silence.
 */

export interface MockVoiceBehaviour {
  readonly failWith?: 'timeout' | 'unavailable' | 'rate_limited';
  readonly failTimes?: number;
  readonly latencyMs?: number;
  /** Forces a transcript, instead of deriving one from the audio length. */
  readonly transcript?: string;
  /** Forces the confidence, for the "I didn't quite catch that" path. */
  readonly confidence?: number;
}

export interface MockVoiceOptions {
  readonly behaviour?: MockVoiceBehaviour;
  readonly sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

const failer = (behaviour: MockVoiceBehaviour) => {
  let remaining = behaviour.failTimes ?? 0;

  return (operation: string): void => {
    const shouldFail =
      behaviour.failWith !== undefined && (behaviour.failTimes === undefined || remaining > 0);
    if (!shouldFail) return;
    if (behaviour.failTimes !== undefined) remaining -= 1;

    switch (behaviour.failWith) {
      case 'timeout':
        throw new ProviderTimeoutError(operation, 1);
      case 'rate_limited':
        throw Object.assign(new Error('rate limited'), { status: 429 });
      case 'unavailable':
      default:
        throw new ProviderUnavailableError(operation);
    }
  };
};

/**
 * Deterministic transcripts.
 *
 * Derived from the audio bytes so the same recording always produces the same
 * text, and so a test can assert on a transcript without pinning a magic string.
 * The trigger words are the ones the AI mock already understands, which is what
 * lets a voice test drive a safety block end to end.
 */
const TRIGGERS: readonly (readonly [string, string])[] = Object.freeze([
  ['__unsafe__', 'tell me about __unsafe__ things'],
  ['__disclosure__', 'something __disclosure__ happened'],
  ['__selfharm__', '__selfharm__'],
  ['__silence__', ''],
]);

const transcriptFor = (audio: Uint8Array): string => {
  const asText = Buffer.from(audio.subarray(0, 4096)).toString('latin1');
  for (const [marker, transcript] of TRIGGERS) {
    if (asText.includes(marker)) return transcript;
  }
  return 'I saw a butterfly in the garden today';
};

export const createMockSttProvider = (options: MockVoiceOptions = {}): SpeechToTextProvider => {
  const behaviour = options.behaviour ?? {};
  const sleep = options.sleep ?? defaultSleep;
  const maybeFail = failer(behaviour);

  return {
    name: 'mock',
    model: 'mock-stt-v1',

    transcribe: async (request: TranscriptionRequest): Promise<Transcription> => {
      if (behaviour.latencyMs !== undefined) await sleep(behaviour.latencyMs);
      maybeFail('transcribe');

      const text = behaviour.transcript ?? transcriptFor(request.audio);

      return {
        text,
        // Empty audio gets low confidence, which is what drives the "I didn't
        // quite catch that" path rather than a reply to nothing.
        confidence: behaviour.confidence ?? (text === '' ? 0.1 : 0.94),
        detectedLanguage: request.languageHints[0] ?? 'en',
        durationMs: Math.max(250, Math.round(request.audio.length / 32)),
      };
    },
  };
};

export const createMockTtsProvider = (options: MockVoiceOptions = {}): TextToSpeechProvider => {
  const behaviour = options.behaviour ?? {};
  const sleep = options.sleep ?? defaultSleep;
  const maybeFail = failer(behaviour);

  return {
    name: 'mock',
    model: 'mock-tts-v1',

    synthesize: async (request: SynthesisRequest): Promise<SynthesisResult> => {
      if (behaviour.latencyMs !== undefined) await sleep(behaviour.latencyMs);
      maybeFail('synthesize');

      // A REAL, well-formed WAV file. A mock that returns arbitrary bytes would
      // let a bug in the format layer pass every test and then fail on a device.
      const durationMs = Math.max(400, request.text.length * 60);
      return {
        audio: silentWav(durationMs),
        mimeType: CANONICAL_MIME.wav,
        durationMs,
        fromCache: false,
      };
    },
  };
};

/** A valid 8 kHz mono 16-bit WAV of the requested length. Silence, but real. */
export const silentWav = (durationMs: number): Uint8Array => {
  const sampleRate = 8_000;
  const bytesPerSample = 2;
  const samples = Math.max(1, Math.round((durationMs / 1000) * sampleRate));
  const dataBytes = samples * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataBytes);

  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16); // PCM chunk size
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * bytesPerSample, 28); // byte rate
  buffer.writeUInt16LE(bytesPerSample, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataBytes, 40);

  return new Uint8Array(buffer);
};
