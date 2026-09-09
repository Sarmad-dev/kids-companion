/**
 * @kids/ai — the conversation engine, behind a provider-independent port.
 *
 * No vendor SDK type crosses this package's boundary. Swapping providers is a
 * configuration change plus one adapter file (docs/adr/0004).
 *
 * The mock provider is the default in `local` and `ci`, so the whole loop runs
 * with no API key and no spend.
 */

export type {
  AIProvider,
  DetectLanguageRequest,
  DetectLanguageResult,
  GenerateRequest,
  GenerateResult,
  ModerationCategory,
  ModerationRequest,
  ModerationResult,
  ProviderContext,
  ProviderMessage,
  StructuredRequest,
  StructuredResult,
  TokenUsage,
} from './ports.js';
export { MODERATION_CATEGORIES } from './ports.js';

export {
  INVARIANTS,
  REDIRECTION_GUIDANCE,
  rulesFor,
  SENSITIVE_TOPIC_GUIDANCE,
  STORY_GUIDANCE,
  type AgeRules,
} from './age-rules.js';

export {
  allCharacters,
  characterByKey,
  characterBySlug,
  characterFromConfig,
  isCharacterAllowedFor,
  resolveCharacter,
  type CharacterConfig,
  type CharacterDefinition,
} from './characters.js';

export {
  assertTraitsAreManner,
  CAPABILITY_LANGUAGE,
  CONVERSATION_PROSE,
  CONVERSATION_STYLES,
  ENCOURAGEMENT_PROSE,
  ENCOURAGEMENT_STYLES,
  FAREWELL_PROSE,
  FAREWELL_STYLES,
  GREETING_PROSE,
  GREETING_STYLES,
  isConversationStyle,
  isEncouragementStyle,
  isFarewellStyle,
  isGreetingStyle,
  isPersonalityTrait,
  isStoryStyle,
  isVocabularyStyle,
  PERSONALITY_PROSE,
  PERSONALITY_TRAITS,
  STORY_PROSE,
  STORY_STYLES,
  VOCABULARY_PROSE,
  VOCABULARY_STYLES,
  type ConversationStyle,
  type EncouragementStyle,
  type FarewellStyle,
  type GreetingStyle,
  type PersonalityTrait,
  type StoryStyle,
  type VocabularyStyle,
} from './character-traits.js';

export {
  assertInvariantsPresent,
  buildSystemPrompt,
  NAME_PLACEHOLDER,
  substituteName,
  type PromptInputs,
} from './prompts.js';

export {
  assertNoProhibitedData,
  buildProviderContext,
  DEFAULT_CONTEXT_LIMITS,
  estimateTokens,
  outputTokensFor,
  ProhibitedDataError,
  windowHistory,
  type ContextLimits,
  type ConversationContextInput,
  type HistoryMessage,
  type WindowedHistory,
} from './context.js';

/**
 * The safety layer lives in `@kids/safety` and is re-exported here ONLY as an
 * adapter. Anything reaching for safety behaviour should import that package
 * directly — it is independent of this one, and depends on nothing in it.
 */
export { providerAsClassifier } from './safety-classifier.js';

/**
 * Resilience primitives moved to `@kids/shared` — the AI, STT, and TTS adapters
 * all need them, and three copies of a retry budget is three places for it to
 * drift. Import them from there.
 */

export {
  createMockProvider,
  type MockBehaviour,
  type MockProviderOptions,
} from './mock-provider.js';
export { createAnthropicProvider, type AnthropicProviderOptions } from './anthropic-provider.js';
export { createOpenAIProvider, type OpenAIProviderOptions } from './openai-provider.js';
export {
  createGoogleProvider,
  GOOGLE_FREE_TIER_MODELS,
  type GoogleProviderOptions,
} from './google-provider.js';

/**
 * The provider set this deployment can reach, and the name → adapter lookup a
 * per-family preference is resolved through.
 */
export {
  createProviderRegistry,
  type ProviderRegistry,
  type ProviderRegistryOptions,
} from './provider-registry.js';

export {
  createConversationEngine,
  type ConversationEngine,
  type EngineOptions,
  type RespondInput,
  type SafetyRecord,
  type TurnResult,
  type TurnStatus,
} from './engine.js';
