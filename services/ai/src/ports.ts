import { SAFETY_CATEGORIES, type SafetyCategory } from '@kids/safety';
import type { AgeGroup, SupportedLanguage } from '@kids/types';

/**
 * The AI provider port.
 *
 * Shaped by what this product needs, never by what a vendor's SDK offers — a
 * port shaped around one vendor is not an abstraction (docs/adr/0004). No
 * Anthropic, OpenAI, or Bedrock type crosses this boundary in either direction.
 *
 * Four capabilities, deliberately separate:
 *
 *   generateResponse           free-form reply, the conversational path
 *   generateStructuredResponse JSON conforming to a schema, for classification
 *                              and any machine-read output
 *   moderateContent            safety classification, called on BOTH the child's
 *                              input and the model's output
 *   detectLanguage             which language an utterance is in
 *
 * They are separate because they are billed, tuned, and — most importantly —
 * FAILED differently. A moderation timeout must block the turn; a language
 * detection timeout must fall back to the child's declared language and carry
 * on. Collapsing them into one method loses that distinction.
 */

/* -------------------------------------------------------------------------- */
/* The outbound payload — deliberately minimal                                 */
/* -------------------------------------------------------------------------- */

/**
 * ONE MESSAGE AS THE PROVIDER SEES IT.
 *
 * Note what is absent: no message id, no child id, no timestamp, no
 * conversation id. A provider needs the words and who said them, and nothing
 * else. Every additional field is a field that ends up in someone's logs.
 */
export interface ProviderMessage {
  readonly role: 'child' | 'companion';
  readonly text: string;
}

/**
 * The context a provider receives.
 *
 * This is the ONLY shape that leaves our infrastructure, and it is built by
 * `buildProviderContext()` from the much richer internal context. The narrowing
 * is the point: see `assertNoProhibitedData()`, which fails the request if
 * anything resembling child PII appears in the assembled payload.
 *
 * The child's NAME is not here. The system prompt instructs the model to address
 * the child as `{{name}}`, and the application substitutes the real name into
 * the reply after generation — so the name never leaves this system at all.
 */
export interface ProviderContext {
  readonly ageGroup: AgeGroup;
  readonly language: SupportedLanguage;
  /** The assembled system prompt: safety rules, age rules, and persona. */
  readonly systemPrompt: string;
  /** Bounded window, oldest first. Never the full history. */
  readonly history: readonly ProviderMessage[];
}

/* -------------------------------------------------------------------------- */
/* generateResponse                                                            */
/* -------------------------------------------------------------------------- */

export interface GenerateRequest {
  readonly context: ProviderContext;
  readonly utterance: string;
  readonly maxOutputTokens: number;
  readonly temperature: number;
  readonly timeoutMs: number;
}

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Recorded per turn. Cost per conversation is a first-class metric (C3). */
  readonly estimatedCostUsd: number;
}

export interface GenerateResult {
  readonly text: string;
  readonly usage: TokenUsage;
  readonly model: string;
  /** True when the model hit the output ceiling — the reply may be cut short. */
  readonly truncated: boolean;
}

/* -------------------------------------------------------------------------- */
/* generateStructuredResponse                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A JSON Schema the provider must conform to.
 *
 * Passed as data rather than a Zod schema so the port stays free of any
 * validation library, and so an adapter can hand it to a vendor's native
 * structured-output feature where one exists.
 */
export interface StructuredRequest {
  readonly context: ProviderContext;
  readonly instruction: string;
  readonly schemaName: string;
  readonly jsonSchema: Readonly<Record<string, unknown>>;
  readonly maxOutputTokens: number;
  readonly timeoutMs: number;
}

export interface StructuredResult {
  /**
   * Parsed JSON. `unknown` on purpose: the CALLER validates it against its own
   * schema. A provider claiming conformance is a claim, not a guarantee, and
   * model output is input — it is never trusted (SECURITY.md §1.3).
   */
  readonly value: unknown;
  readonly usage: TokenUsage;
  readonly model: string;
}

/* -------------------------------------------------------------------------- */
/* moderateContent                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The moderation taxonomy is OWNED BY `@kids/safety`, not by this port.
 *
 * It used to be declared here, which meant the provider adapters and the safety
 * subsystem each carried their own idea of what "substances" meant. One list, in
 * the package whose job is deciding what is unsafe; this port only names it.
 */
export const MODERATION_CATEGORIES = SAFETY_CATEGORIES;
export type ModerationCategory = SafetyCategory;

export interface ModerationRequest {
  readonly text: string;
  readonly ageGroup: AgeGroup;
  readonly language: SupportedLanguage;
  /** Whose text this is. The thresholds differ; see docs/CHILD_SAFETY.md §3. */
  readonly source: 'child_input' | 'model_output';
  readonly timeoutMs: number;
}

export interface ModerationResult {
  readonly flagged: boolean;
  readonly categories: readonly ModerationCategory[];
  /** 0..1. The engine's thresholds live in safety config, not in the adapter. */
  readonly confidence: number;
  /**
   * Some categories are not merely blocked — a child disclosing harm, or in
   * distress, routes to a human protocol (docs/CHILD_SAFETY.md §6). An adapter
   * reports it; the engine decides what happens.
   */
  readonly requiresEscalation: boolean;
}

/* -------------------------------------------------------------------------- */
/* detectLanguage                                                              */
/* -------------------------------------------------------------------------- */

export interface DetectLanguageRequest {
  readonly text: string;
  /**
   * The child's declared languages, as a constrained hypothesis set. Never open
   * detection: Pakistani households code-switch mid-sentence, and open detection
   * on a four-year-old's two-second utterance produces nonsense that then drives
   * the whole turn (ARCHITECTURE.md §7.2).
   */
  readonly candidates: readonly SupportedLanguage[];
  readonly timeoutMs: number;
}

export interface DetectLanguageResult {
  readonly language: SupportedLanguage;
  readonly confidence: number;
  /** True when the text mixes languages, which is normal rather than an error. */
  readonly mixed: boolean;
}

/* -------------------------------------------------------------------------- */

export interface AIProvider {
  readonly name: string;
  readonly conversationModel: string;
  readonly classifierModel: string;

  generateResponse(request: GenerateRequest): Promise<GenerateResult>;
  generateStructuredResponse(request: StructuredRequest): Promise<StructuredResult>;
  moderateContent(request: ModerationRequest): Promise<ModerationResult>;
  detectLanguage(request: DetectLanguageRequest): Promise<DetectLanguageResult>;
}
