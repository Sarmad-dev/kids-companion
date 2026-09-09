/**
 * `@kids/voice` — speech to text, text to speech, and the voice pipeline.
 *
 * Two things govern this package.
 *
 * **Audio is transcribed and discarded** (docs/adr/0006). Retention exists as a
 * policy object rather than a hard-coded lifetime, so that turning it on is a
 * visible, reviewable decision requiring both configuration and a parent's
 * specific opt-in — and so that a reader can find every input that could make a
 * child's voice survive a turn in one function.
 *
 * **Voice is a modality, not a second path to the model.** A transcript goes
 * through the same INPUT_SAFETY_CHECK → AI_GENERATION → OUTPUT_SAFETY_CHECK
 * stages a typed message does, via a callback this package knows nothing about.
 */

export {
  CANONICAL_MIME,
  declarationMatches,
  normaliseMime,
  sniffAudio,
  type AudioContainer,
  type SniffedAudio,
} from './formats.js';

export type {
  AudioKind,
  AudioStorage,
  PutAudioRequest,
  SpeechToTextProvider,
  StoredAudio,
  SynthesisRequest,
  SynthesisResult,
  TextToSpeechProvider,
  Transcription,
  TranscriptionRequest,
} from './ports.js';

export {
  DEFAULT_AUDIO_LIMITS,
  CLIENT_REJECTION_MESSAGE,
  validateAudioUpload,
  type AudioLimits,
  type RejectionReason,
  type ValidateInput,
  type ValidationOutcome,
} from './validation.js';

export {
  DEFAULT_RETENTION_POLICY,
  isReadable,
  resolveRetention,
  type ResolvedRetention,
  type RetentionDecision,
  type RetentionInput,
  type RetentionPolicy,
} from './retention.js';

export {
  createMemoryAudioStorage,
  newAudioKey,
  type MemoryAudioStorageOptions,
} from './storage.js';

export { createS3AudioStorage, type S3AudioStorageOptions } from './s3-storage.js';

export {
  amzDates,
  canonicalRequest,
  signRequest,
  signingKey,
  uriEncode,
  type S3Credentials,
} from './s3-signing.js';

export {
  createMockSttProvider,
  createMockTtsProvider,
  silentWav,
  type MockVoiceBehaviour,
  type MockVoiceOptions,
} from './mock-providers.js';

/**
 * Vendor adapters, one per CAPABILITY rather than one per vendor.
 *
 * Deepgram and ElevenLabs each serve both halves of the loop, so either can be
 * used for speech-to-text, for text-to-speech, or for both. The two ports stay
 * separate regardless — see the note in `ports.ts`, and `resolveVoiceProviders`
 * for how the environment picks.
 */
export {
  createDeepgramProvider,
  createDeepgramTtsProvider,
  type DeepgramProviderOptions,
  type DeepgramTtsProviderOptions,
} from './deepgram-provider.js';

export {
  createElevenLabsProvider,
  createElevenLabsSttProvider,
  type ElevenLabsProviderOptions,
  type ElevenLabsSttProviderOptions,
} from './elevenlabs-provider.js';

export { createMemoryTtsCache, ttsCacheKey, type TtsCache } from './tts-cache.js';

export {
  resolveVoiceProviders,
  type VoiceProviderSelection,
  type VoiceProviderCredentials,
} from './provider-selection.js';

export {
  fallbackForRejection,
  runVoiceTurn,
  VOICE_FALLBACKS,
  type VoiceFallback,
  type VoiceResponse,
  type VoiceStage,
  type VoiceTurnOptions,
  type VoiceTurnOutcome,
  type VoiceTurnRequest,
} from './pipeline.js';
