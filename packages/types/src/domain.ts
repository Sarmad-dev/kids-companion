import type {
  CharacterId,
  ChildId,
  ConversationId,
  IsoTimestamp,
  MessageId,
  ParentId,
  SafetyVerdictId,
  SubscriptionId,
  TransactionId,
} from './ids.js';

/* -------------------------------------------------------------------------- */
/* Age groups                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Age groups drive vocabulary ceiling, turn length, topic policy, and quota.
 *
 * A const array plus a derived union rather than an enum: iterable,
 * JSON-serialisable, exhaustively checkable, and leaving no runtime object.
 * `erasableSyntaxOnly` bans enums outright.
 *
 * Mirrors `app.age_group()` in the database, which derives the value from birth
 * month and year at read time. Never stored — a stored group goes stale on a
 * birthday, and a sixth birthday changes the content policy.
 */
export const AGE_GROUPS = ['AGE_3_5', 'AGE_6_8', 'AGE_9_10'] as const;
export type AgeGroup = (typeof AGE_GROUPS)[number];

/* -------------------------------------------------------------------------- */
/* Languages                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Tier is a product commitment, not a user preference. A `primary` language is
 * one the companion is expected to be good at; a `regional` one is intended and
 * unproven. The distinction keeps a language out of the UI until its STT and —
 * more importantly — its safety classification are good enough
 * (docs/CHILD_SAFETY.md §9.1).
 */
export const LANGUAGE_TIERS = ['primary', 'secondary', 'regional'] as const;
export type LanguageTier = (typeof LANGUAGE_TIERS)[number];

export const SUPPORTED_LANGUAGES = [
  'en',
  'ur',
  'ar', // primary
  'hi',
  'es',
  'fr',
  'zh', // secondary
  'pa',
  'sd',
  'ps', // regional
] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

export const LANGUAGE_PROFICIENCIES = ['learning', 'conversational', 'fluent', 'native'] as const;
export type LanguageProficiency = (typeof LANGUAGE_PROFICIENCIES)[number];

export interface ChildLanguage {
  readonly languageCode: SupportedLanguage;
  readonly isPrimary: boolean;
  readonly proficiency: LanguageProficiency;
}

export const SESSION_LENGTHS = ['short', 'medium', 'long'] as const;
export type SessionLength = (typeof SESSION_LENGTHS)[number];

export const CORRECTION_STYLES = ['none', 'gentle', 'active'] as const;
export type CorrectionStyle = (typeof CORRECTION_STYLES)[number];

/** Bounded preferences only. No free text about a child. */
export interface ChildLearningPreferences {
  readonly childId: ChildId;
  readonly sessionLength: SessionLength;
  readonly storytellingEnabled: boolean;
  readonly roleplayEnabled: boolean;
  readonly pronunciationPractice: boolean;
  readonly correctionStyle: CorrectionStyle;
  /** Curated topic keys — never anything a parent typed. */
  readonly topicKeys: readonly string[];
}

export const CHILD_STATUSES = ['active', 'paused', 'archived'] as const;
export type ChildStatus = (typeof CHILD_STATUSES)[number];

/* -------------------------------------------------------------------------- */
/* Safety                                                                      */
/* -------------------------------------------------------------------------- */

/** The five independent layers of the safety pipeline. See docs/CHILD_SAFETY.md. */
export const SAFETY_LAYERS = ['L1', 'L2', 'L3', 'L4', 'L5'] as const;
export type SafetyLayer = (typeof SAFETY_LAYERS)[number];

export const SAFETY_DECISIONS = ['allowed', 'redirected', 'blocked', 'escalated'] as const;
export type SafetyDecision = (typeof SAFETY_DECISIONS)[number];

export interface SafetyVerdict {
  readonly id: SafetyVerdictId;
  readonly messageId: MessageId;
  readonly decision: SafetyDecision;
  /** Absent only when the decision is `allowed` — nothing stopped the turn. */
  readonly layer?: SafetyLayer;
  readonly categories: readonly string[];
  readonly confidence?: number;
  readonly reviewedAt?: IsoTimestamp;
  readonly createdAt: IsoTimestamp;
}

/* -------------------------------------------------------------------------- */
/* AI providers                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Which vendor answers a child.
 *
 * Declared here rather than in `@kids/ai` because four layers need to agree on
 * the spelling and none of them should depend on the adapter package to do it:
 * the environment schema validates it, the `parents` table stores it, the API
 * accepts it on a PATCH, and the parent app draws a list of it.
 *
 * `mock` is a first-class member, not a test fixture. It is the default in
 * `local` and `ci`, and it is what a deployment falls back to when a selected
 * vendor has no key configured — a conversation that degrades to a canned
 * answer is better than one that fails.
 */
export const AI_PROVIDER_NAMES = ['anthropic', 'openai', 'google', 'mock'] as const;
export type AiProviderName = (typeof AI_PROVIDER_NAMES)[number];

export const isAiProviderName = (value: unknown): value is AiProviderName =>
  (AI_PROVIDER_NAMES as readonly unknown[]).includes(value);

/* -------------------------------------------------------------------------- */
/* Parents and children                                                        */
/* -------------------------------------------------------------------------- */

export const PARENT_STATUSES = ['active', 'suspended', 'pending_deletion'] as const;
export type ParentStatus = (typeof PARENT_STATUSES)[number];

export interface Parent {
  readonly id: ParentId;
  readonly email: string;
  readonly displayName?: string;
  readonly countryCode: string;
  readonly locale: string;
  readonly status: ParentStatus;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

export interface ChildProfile {
  readonly id: ChildId;
  readonly parentId: ParentId;
  /** First name or nickname only. Never a surname — see PRIVACY.md §3.2. */
  readonly displayName: string;
  /** Month and year only. A day-precision date of birth is never collected. */
  readonly birthYear: number;
  readonly birthMonth: number;
  /** Derived from birth month/year at read time, never stored — it goes stale. */
  readonly ageGroup: AgeGroup;
  /** False once a child ages past ten, or before they turn three. Surfaced, not hidden. */
  readonly ageInSupportedRange: boolean;
  readonly languages: readonly ChildLanguage[];
  readonly preferredCharacterId?: CharacterId;
  readonly status: ChildStatus;
  readonly archivedAt?: IsoTimestamp;
  readonly avatarKey?: string;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

/* -------------------------------------------------------------------------- */
/* Parental controls                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Per-child, not per-account: a 4-year-old and a 9-year-old in the same family
 * need different limits. Every default is the conservative one.
 */
export interface ParentalControls {
  readonly childId: ChildId;
  readonly dailyMinuteLimit: number;
  readonly sessionMinuteLimit: number;
  readonly quietHoursStart?: string;
  readonly quietHoursEnd?: string;
  readonly timezone: string;
  /** Empty means every active character is allowed. */
  readonly allowedCharacterIds: readonly CharacterId[];
  readonly blockedTopics: readonly string[];
  readonly languageLock?: SupportedLanguage;
  readonly transcriptRetentionDays: number;
  readonly notifyOnSafetyFlag: boolean;
  readonly isPaused: boolean;
  readonly updatedAt: IsoTimestamp;
}

/* -------------------------------------------------------------------------- */
/* Characters                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Global product content, not per-parent. A persona differs in voice and manner
 * only — it never alters safety policy (docs/CHILD_SAFETY.md §7).
 */
export interface AiCharacter {
  readonly id: CharacterId;
  readonly slug: string;
  readonly displayName: string;
  readonly tagline: string;
  /** Pins the reviewed prompt in services/ai. A prompt change is a safety change. */
  readonly promptVersion: string;
  readonly languages: readonly SupportedLanguage[];
  readonly allowedAgeGroups: readonly AgeGroup[];
  readonly voiceId?: string;
  readonly isActive: boolean;
}

/* -------------------------------------------------------------------------- */
/* Conversations                                                               */
/* -------------------------------------------------------------------------- */

export const CONVERSATION_END_REASONS = [
  'child_ended',
  'timeout',
  'quota_exhausted',
  'parent_ended',
  'safety_ended',
  'error',
] as const;
export type ConversationEndReason = (typeof CONVERSATION_END_REASONS)[number];

export interface Conversation {
  readonly id: ConversationId;
  readonly childId: ChildId;
  readonly characterId: CharacterId;
  readonly language: SupportedLanguage;
  readonly messageCount: number;
  readonly startedAt: IsoTimestamp;
  readonly endedAt?: IsoTimestamp;
  readonly endReason?: ConversationEndReason;
}

export const MESSAGE_ROLES = ['child', 'companion'] as const;
export type MessageRole = (typeof MESSAGE_ROLES)[number];

/**
 * One side of an exchange.
 *
 * A *turn* is the round trip — a child utterance plus the companion's reply —
 * and is the unit the latency budget and cost metrics use. A *message* is one
 * row. Keeping the words distinct avoids the ambiguity of "turn" meaning both.
 *
 * Note the absence of a plaintext `content` field: content is encrypted at the
 * application layer and is never carried in a general-purpose domain object,
 * because a domain object ends up in a log line eventually.
 */
export interface Message {
  readonly id: MessageId;
  readonly conversationId: ConversationId;
  readonly role: MessageRole;
  readonly sequence: number;
  readonly contentLength: number;
  readonly sttConfidence?: number;
  readonly latencyMs?: number;
  readonly createdAt: IsoTimestamp;
}

/* -------------------------------------------------------------------------- */
/* Speech practice and learning                                                */
/* -------------------------------------------------------------------------- */

/** The score is retained; the recording is not. See docs/adr/0006. */
export interface SpeechPracticeAttempt {
  readonly childId: ChildId;
  readonly targetPhrase: string;
  readonly language: SupportedLanguage;
  readonly overallScore: number;
  readonly detailScores: Readonly<Record<string, number>>;
  readonly attemptNumber: number;
  readonly practicedAt: IsoTimestamp;
}

/**
 * Exposure and activity counters.
 *
 * Deliberately not named `mastery` or `level`. What learning progress can
 * honestly claim to measure is open (docs/OPEN_QUESTIONS.md Q-12), and reporting
 * engagement honestly beats reporting education dishonestly.
 */
export interface LearningProgress {
  readonly childId: ChildId;
  readonly skillKey: string;
  readonly exposureCount: number;
  readonly successCount: number;
  readonly firstObservedAt: IsoTimestamp;
  readonly lastObservedAt: IsoTimestamp;
}

/* -------------------------------------------------------------------------- */
/* Billing                                                                     */
/* -------------------------------------------------------------------------- */

export const PAYMENT_RAILS = [
  'stripe',
  'jazzcash',
  'easypaisa',
  'apple_iap',
  'google_play',
  'mock',
] as const;
export type PaymentRail = (typeof PAYMENT_RAILS)[number];

export const SUBSCRIPTION_STATUSES = [
  'free',
  'active',
  'past_due',
  'cancelled',
  'expired',
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

/** Minor units plus a currency code. Never a float. */
export interface Money {
  readonly amountMinor: number;
  readonly currency: string;
}

export interface Subscription {
  readonly id: SubscriptionId;
  readonly parentId: ParentId;
  readonly rail: PaymentRail;
  readonly planCode: string;
  readonly status: SubscriptionStatus;
  readonly price: Money;
  readonly currentPeriodStart?: IsoTimestamp;
  readonly currentPeriodEnd?: IsoTimestamp;
  readonly cancelAt?: IsoTimestamp;
}

export const TRANSACTION_KINDS = ['charge', 'refund', 'chargeback', 'credit'] as const;
export type TransactionKind = (typeof TRANSACTION_KINDS)[number];

export const TRANSACTION_STATUSES = ['pending', 'succeeded', 'failed', 'reversed'] as const;
export type TransactionStatus = (typeof TRANSACTION_STATUSES)[number];

export interface Transaction {
  readonly id: TransactionId;
  readonly subscriptionId: SubscriptionId;
  readonly rail: PaymentRail;
  readonly kind: TransactionKind;
  readonly status: TransactionStatus;
  /** Negative for refunds and chargebacks — enforced by a check constraint. */
  readonly amount: Money;
  readonly occurredAt: IsoTimestamp;
}

/* -------------------------------------------------------------------------- */
/* Turn outcomes                                                               */
/* -------------------------------------------------------------------------- */

export const DEGRADATION_REASONS = [
  'provider_unavailable',
  'provider_timeout',
  'quota_exhausted',
  'cost_ceiling_reached',
] as const;
export type DegradationReason = (typeof DEGRADATION_REASONS)[number];

/**
 * A discriminated union rather than a bag of optional fields, so illegal states
 * cannot be represented and `switch` exhaustiveness is checked at compile time.
 * See docs/CODING_STANDARDS.md#14-make-illegal-states-unrepresentable.
 */
export type TurnOutcome =
  | { readonly status: 'ok'; readonly text: string; readonly audioUrl: string }
  | { readonly status: 'blocked'; readonly layer: SafetyLayer; readonly redirect: string }
  | { readonly status: 'degraded'; readonly reason: DegradationReason; readonly fallback: string };
