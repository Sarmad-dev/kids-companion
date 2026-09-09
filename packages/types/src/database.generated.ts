/**
 * GENERATED FILE — DO NOT EDIT.
 *
 * Produced from infra/migrations/ by infra/scripts/generate-db-types.mjs.
 * Regenerate with `pnpm db:types`; CI fails if this file is stale.
 *
 * `Row` is what a SELECT returns. `Insert` marks nullable and defaulted columns
 * optional. `Update` makes everything optional, matching a PATCH.
 */

export type Json = string | number | boolean | null | { [key: string]: Json } | Json[];

/** `public.achievements` */
export interface AchievementsRow {
  id: string;
  achievement_key: string;
  title: string;
  description: string;
  icon_key: string;
  rule_kind: 'attempts_total' | 'sessions_completed' | 'distinct_days' | 'exercises_tried';
  threshold: number;
  is_active: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface AchievementsInsert {
  id?: string;
  achievement_key: string;
  title: string;
  description: string;
  icon_key?: string;
  rule_kind: 'attempts_total' | 'sessions_completed' | 'distinct_days' | 'exercises_tried';
  threshold: number;
  is_active?: boolean;
  sort_order?: number;
  created_at?: string;
  updated_at?: string;
}

export type AchievementsUpdate = Partial<AchievementsInsert>;

/** `public.ai_characters` */
export interface AiCharactersRow {
  id: string;
  slug: string;
  display_name: string;
  tagline: string;
  description: string;
  prompt_version: string;
  allowed_age_groups: string[];
  voice_id: string | null;
  avatar_key: string | null;
  status: 'active' | 'beta' | 'retired';
  sort_order: number;
  created_at: string;
  updated_at: string;
  prompt_key: string | null;
  requires_paid_plan: boolean;
  personality_traits: string[];
  conversation_style: 'responsive' | 'inquisitive' | 'narrative' | 'explanatory';
  vocabulary_style: 'simple' | 'everyday' | 'descriptive' | 'precise';
  encouragement_style: 'warm' | 'celebratory' | 'quiet' | 'matter_of_fact';
  story_style: 'collaborative' | 'gentle' | 'adventurous' | 'factual' | 'none';
  greeting_style: 'friendly' | 'bouncy' | 'quiet' | 'welcoming' | 'curious';
  farewell_style: 'warm' | 'sleepy' | 'safe_landing' | 'thoughtful';
  educational_objectives: string[];
  voice_config: Json;
}

export interface AiCharactersInsert {
  id?: string;
  slug: string;
  display_name: string;
  tagline: string;
  description?: string;
  prompt_version: string;
  allowed_age_groups?: string[];
  voice_id?: string | null;
  avatar_key?: string | null;
  status?: 'active' | 'beta' | 'retired';
  sort_order?: number;
  created_at?: string;
  updated_at?: string;
  prompt_key?: string | null;
  requires_paid_plan?: boolean;
  personality_traits?: string[];
  conversation_style?: 'responsive' | 'inquisitive' | 'narrative' | 'explanatory';
  vocabulary_style?: 'simple' | 'everyday' | 'descriptive' | 'precise';
  encouragement_style?: 'warm' | 'celebratory' | 'quiet' | 'matter_of_fact';
  story_style?: 'collaborative' | 'gentle' | 'adventurous' | 'factual' | 'none';
  greeting_style?: 'friendly' | 'bouncy' | 'quiet' | 'welcoming' | 'curious';
  farewell_style?: 'warm' | 'sleepy' | 'safe_landing' | 'thoughtful';
  educational_objectives?: string[];
  voice_config?: Json;
}

export type AiCharactersUpdate = Partial<AiCharactersInsert>;

/** `public.analytics_events` */
export interface AnalyticsEventsRow {
  id: string;
  parent_id: string | null;
  child_id: string | null;
  parent_ref: string;
  child_ref: string | null;
  event_name: string;
  properties: Json;
  app_version: string | null;
  platform: 'ios' | 'android' | 'web' | null;
  occurred_at: string;
  created_at: string;
}

export interface AnalyticsEventsInsert {
  id?: string;
  parent_id?: string | null;
  child_id?: string | null;
  parent_ref: string;
  child_ref?: string | null;
  event_name: string;
  properties?: Json;
  app_version?: string | null;
  platform?: 'ios' | 'android' | 'web' | null;
  occurred_at?: string;
  created_at?: string;
}

export type AnalyticsEventsUpdate = Partial<AnalyticsEventsInsert>;

/** `public.audio_artifacts` */
export interface AudioArtifactsRow {
  id: string;
  child_id: string;
  conversation_id: string | null;
  message_id: string | null;
  kind: 'child_upload' | 'companion_reply';
  storage_key: string;
  mime_type: 'audio/wav' | 'audio/ogg' | 'audio/webm' | 'audio/mp4' | 'audio/mpeg';
  byte_size: number;
  duration_ms: number | null;
  retention_basis: 'policy_zero' | 'no_consent' | 'synthesis' | 'parent_opt_in';
  expires_at: string;
  deleted_at: string | null;
  created_at: string;
}

export interface AudioArtifactsInsert {
  id?: string;
  child_id: string;
  conversation_id?: string | null;
  message_id?: string | null;
  kind: 'child_upload' | 'companion_reply';
  storage_key: string;
  mime_type: 'audio/wav' | 'audio/ogg' | 'audio/webm' | 'audio/mp4' | 'audio/mpeg';
  byte_size: number;
  duration_ms?: number | null;
  retention_basis: 'policy_zero' | 'no_consent' | 'synthesis' | 'parent_opt_in';
  expires_at: string;
  deleted_at?: string | null;
  created_at?: string;
}

export type AudioArtifactsUpdate = Partial<AudioArtifactsInsert>;

/** `public.audit_logs` */
export interface AuditLogsRow {
  id: string;
  actor_id: string | null;
  actor_type: 'parent' | 'child_session' | 'system' | 'operator' | 'service_role';
  action: string;
  resource_type: string;
  resource_id: string | null;
  subject_child_id: string | null;
  outcome: 'success' | 'denied' | 'error';
  justification: string | null;
  request_id: string | null;
  source_ip: string | null;
  user_agent: string | null;
  metadata: Json;
  occurred_at: string;
  created_at: string;
}

export interface AuditLogsInsert {
  id?: string;
  actor_id?: string | null;
  actor_type: 'parent' | 'child_session' | 'system' | 'operator' | 'service_role';
  action: string;
  resource_type: string;
  resource_id?: string | null;
  subject_child_id?: string | null;
  outcome: 'success' | 'denied' | 'error';
  justification?: string | null;
  request_id?: string | null;
  source_ip?: string | null;
  user_agent?: string | null;
  metadata?: Json;
  occurred_at?: string;
  created_at?: string;
}

export type AuditLogsUpdate = Partial<AuditLogsInsert>;

/** `public.character_catalogue` (view) */
export interface CharacterCatalogueRow {
  id: string | null;
  slug: string | null;
  display_name: string | null;
  tagline: string | null;
  description: string | null;
  allowed_age_groups: string[] | null;
  avatar_key: string | null;
  personality_traits: string[] | null;
  conversation_style: string | null;
  vocabulary_style: string | null;
  encouragement_style: string | null;
  story_style: string | null;
  educational_objectives: string[] | null;
  requires_paid_plan: boolean | null;
  sort_order: number | null;
}

/** `public.character_languages` */
export interface CharacterLanguagesRow {
  character_id: string;
  language_code: string;
  voice_id: string | null;
  created_at: string;
}

export interface CharacterLanguagesInsert {
  character_id: string;
  language_code: string;
  voice_id?: string | null;
  created_at?: string;
}

export type CharacterLanguagesUpdate = Partial<CharacterLanguagesInsert>;

/** `public.child_achievements` */
export interface ChildAchievementsRow {
  id: string;
  child_id: string;
  achievement_id: string;
  awarded_at: string;
  created_at: string;
}

export interface ChildAchievementsInsert {
  id?: string;
  child_id: string;
  achievement_id: string;
  awarded_at?: string;
  created_at?: string;
}

export type ChildAchievementsUpdate = Partial<ChildAchievementsInsert>;

/** `public.child_languages` */
export interface ChildLanguagesRow {
  child_id: string;
  language_code: string;
  is_primary: boolean;
  proficiency: 'learning' | 'conversational' | 'fluent' | 'native';
  created_at: string;
  updated_at: string;
}

export interface ChildLanguagesInsert {
  child_id: string;
  language_code: string;
  is_primary?: boolean;
  proficiency?: 'learning' | 'conversational' | 'fluent' | 'native';
  created_at?: string;
  updated_at?: string;
}

export type ChildLanguagesUpdate = Partial<ChildLanguagesInsert>;

/** `public.child_learning_preferences` */
export interface ChildLearningPreferencesRow {
  child_id: string;
  session_length: 'short' | 'medium' | 'long';
  storytelling_enabled: boolean;
  roleplay_enabled: boolean;
  pronunciation_practice: boolean;
  correction_style: 'none' | 'gentle' | 'active';
  created_at: string;
  updated_at: string;
}

export interface ChildLearningPreferencesInsert {
  child_id: string;
  session_length?: 'short' | 'medium' | 'long';
  storytelling_enabled?: boolean;
  roleplay_enabled?: boolean;
  pronunciation_practice?: boolean;
  correction_style?: 'none' | 'gentle' | 'active';
  created_at?: string;
  updated_at?: string;
}

export type ChildLearningPreferencesUpdate = Partial<ChildLearningPreferencesInsert>;

/** `public.child_learning_topics` */
export interface ChildLearningTopicsRow {
  child_id: string;
  topic_key: string;
  created_at: string;
}

export interface ChildLearningTopicsInsert {
  child_id: string;
  topic_key: string;
  created_at?: string;
}

export type ChildLearningTopicsUpdate = Partial<ChildLearningTopicsInsert>;

/** `public.child_vocabulary` */
export interface ChildVocabularyRow {
  id: string;
  child_id: string;
  vocabulary_word_id: string;
  times_used: number;
  first_used_at: string;
  last_used_at: string;
  created_at: string;
  updated_at: string;
}

export interface ChildVocabularyInsert {
  id?: string;
  child_id: string;
  vocabulary_word_id: string;
  times_used?: number;
  first_used_at?: string;
  last_used_at?: string;
  created_at?: string;
  updated_at?: string;
}

export type ChildVocabularyUpdate = Partial<ChildVocabularyInsert>;

/** `public.children` */
export interface ChildrenRow {
  id: string;
  parent_id: string;
  display_name: string;
  birth_year: number;
  birth_month: number;
  avatar_key: string | null;
  status: 'active' | 'paused' | 'archived';
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
  preferred_character_id: string | null;
  archived_at: string | null;
}

export interface ChildrenInsert {
  id?: string;
  parent_id: string;
  display_name: string;
  birth_year: number;
  birth_month: number;
  avatar_key?: string | null;
  status?: 'active' | 'paused' | 'archived';
  deleted_at?: string | null;
  created_at?: string;
  updated_at?: string;
  preferred_character_id?: string | null;
  archived_at?: string | null;
}

export type ChildrenUpdate = Partial<ChildrenInsert>;

/** `public.consent_records` */
export interface ConsentRecordsRow {
  id: string;
  parent_id: string;
  child_id: string | null;
  consent_type: 'terms_of_service' | 'privacy_policy' | 'child_data_processing' | 'transcript_retention' | 'audio_retention' | 'product_analytics' | 'model_improvement' | 'marketing_email';
  granted: boolean;
  policy_version: string;
  policy_text_hash: string;
  source_ip: string | null;
  user_agent: string | null;
  recorded_at: string;
  created_at: string;
}

export interface ConsentRecordsInsert {
  id?: string;
  parent_id: string;
  child_id?: string | null;
  consent_type: 'terms_of_service' | 'privacy_policy' | 'child_data_processing' | 'transcript_retention' | 'audio_retention' | 'product_analytics' | 'model_improvement' | 'marketing_email';
  granted: boolean;
  policy_version: string;
  policy_text_hash: string;
  source_ip?: string | null;
  user_agent?: string | null;
  recorded_at?: string;
  created_at?: string;
}

export type ConsentRecordsUpdate = Partial<ConsentRecordsInsert>;

/** `public.consent_requirements` */
export interface ConsentRequirementsRow {
  id: string;
  consent_type: 'terms_of_service' | 'privacy_policy' | 'child_data_processing' | 'transcript_retention' | 'audio_retention' | 'product_analytics' | 'model_improvement' | 'marketing_email';
  scope: 'account' | 'child';
  jurisdiction: string;
  min_policy_version: string;
  blocks_conversation: boolean;
  effective_from: string;
  effective_until: string | null;
  rationale: string;
  created_at: string;
  updated_at: string;
}

export interface ConsentRequirementsInsert {
  id?: string;
  consent_type: 'terms_of_service' | 'privacy_policy' | 'child_data_processing' | 'transcript_retention' | 'audio_retention' | 'product_analytics' | 'model_improvement' | 'marketing_email';
  scope: 'account' | 'child';
  jurisdiction?: string;
  min_policy_version: string;
  blocks_conversation?: boolean;
  effective_from?: string;
  effective_until?: string | null;
  rationale: string;
  created_at?: string;
  updated_at?: string;
}

export type ConsentRequirementsUpdate = Partial<ConsentRequirementsInsert>;

/** `public.content_flags` */
export interface ContentFlagsRow {
  id: string;
  child_id: string;
  message_id: string | null;
  conversation_id: string | null;
  layer: 'L1' | 'L2' | 'L3' | 'L4' | 'L5';
  decision: 'allowed' | 'redirected' | 'blocked' | 'escalated';
  categories: string[];
  severity: 'low' | 'medium' | 'high' | 'critical';
  confidence: number | null;
  status: 'pending' | 'reviewed' | 'dismissed' | 'escalated';
  reviewed_at: string | null;
  reviewer_ref: string | null;
  parent_notified_at: string | null;
  created_at: string;
  updated_at: string;
  detector: string | null;
  policy_version: string | null;
  action_taken: 'allow' | 'observe' | 'redirect' | 'block' | 'end_session' | null;
  attempt_index: number;
}

export interface ContentFlagsInsert {
  id?: string;
  child_id: string;
  message_id?: string | null;
  conversation_id?: string | null;
  layer: 'L1' | 'L2' | 'L3' | 'L4' | 'L5';
  decision: 'allowed' | 'redirected' | 'blocked' | 'escalated';
  categories?: string[];
  severity?: 'low' | 'medium' | 'high' | 'critical';
  confidence?: number | null;
  status?: 'pending' | 'reviewed' | 'dismissed' | 'escalated';
  reviewed_at?: string | null;
  reviewer_ref?: string | null;
  parent_notified_at?: string | null;
  created_at?: string;
  updated_at?: string;
  detector?: string | null;
  policy_version?: string | null;
  action_taken?: 'allow' | 'observe' | 'redirect' | 'block' | 'end_session' | null;
  attempt_index?: number;
}

export type ContentFlagsUpdate = Partial<ContentFlagsInsert>;

/** `public.conversations` */
export interface ConversationsRow {
  id: string;
  child_id: string;
  character_id: string;
  language_code: string;
  status: 'active' | 'ended' | 'flagged';
  message_count: number;
  total_cost_usd: string;
  started_at: string;
  ended_at: string | null;
  end_reason: 'child_ended' | 'timeout' | 'quota_exhausted' | 'parent_ended' | 'safety_ended' | 'error' | 'cost_ceiling' | 'provider_unavailable' | 'consent_withdrawn' | null;
  created_at: string;
  updated_at: string;
  total_input_tokens: number;
  total_output_tokens: number;
  provider: string | null;
  model: string | null;
  context_message_count: number;
}

export interface ConversationsInsert {
  id?: string;
  child_id: string;
  character_id: string;
  language_code?: string;
  status?: 'active' | 'ended' | 'flagged';
  message_count?: number;
  total_cost_usd?: string;
  started_at?: string;
  ended_at?: string | null;
  end_reason?: 'child_ended' | 'timeout' | 'quota_exhausted' | 'parent_ended' | 'safety_ended' | 'error' | 'cost_ceiling' | 'provider_unavailable' | 'consent_withdrawn' | null;
  created_at?: string;
  updated_at?: string;
  total_input_tokens?: number;
  total_output_tokens?: number;
  provider?: string | null;
  model?: string | null;
  context_message_count?: number;
}

export type ConversationsUpdate = Partial<ConversationsInsert>;

/** `public.current_consents` (view) */
export interface CurrentConsentsRow {
  parent_id: string | null;
  child_id: string | null;
  consent_type: string | null;
  granted: boolean | null;
  policy_version: string | null;
  recorded_at: string | null;
}

/** `public.email_verifications` */
export interface EmailVerificationsRow {
  id: string;
  parent_id: string;
  token_hash: string;
  email: string;
  expires_at: string;
  consumed_at: string | null;
  created_at: string;
}

export interface EmailVerificationsInsert {
  id?: string;
  parent_id: string;
  token_hash: string;
  email: string;
  expires_at: string;
  consumed_at?: string | null;
  created_at?: string;
}

export type EmailVerificationsUpdate = Partial<EmailVerificationsInsert>;

/** `public.learning_daily` */
export interface LearningDailyRow {
  id: string;
  child_id: string;
  day: string;
  conversation_seconds: number;
  conversation_turns: number;
  conversation_count: number;
  words_used: number;
  new_vocabulary: number;
  stories_completed: number;
  exercises_completed: number;
  pronunciation_score_sum: number;
  pronunciation_score_count: number;
  computed_at: string;
  created_at: string;
  updated_at: string;
}

export interface LearningDailyInsert {
  id?: string;
  child_id: string;
  day: string;
  conversation_seconds?: number;
  conversation_turns?: number;
  conversation_count?: number;
  words_used?: number;
  new_vocabulary?: number;
  stories_completed?: number;
  exercises_completed?: number;
  pronunciation_score_sum?: number;
  pronunciation_score_count?: number;
  computed_at?: string;
  created_at?: string;
  updated_at?: string;
}

export type LearningDailyUpdate = Partial<LearningDailyInsert>;

/** `public.learning_event_types` */
export interface LearningEventTypesRow {
  event_type: string;
  display_name: string;
  metric_key: string | null;
  aggregation: 'count' | 'distinct';
  payload_field: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface LearningEventTypesInsert {
  event_type: string;
  display_name: string;
  metric_key?: string | null;
  aggregation?: 'count' | 'distinct';
  payload_field?: string | null;
  is_active?: boolean;
  created_at?: string;
  updated_at?: string;
}

export type LearningEventTypesUpdate = Partial<LearningEventTypesInsert>;

/** `public.learning_events` */
export interface LearningEventsRow {
  id: string;
  child_id: string;
  event_type: string;
  skill_key: string | null;
  conversation_id: string | null;
  speech_practice_id: string | null;
  payload: Json;
  occurred_at: string;
  created_at: string;
  idempotency_key: string | null;
}

export interface LearningEventsInsert {
  id?: string;
  child_id: string;
  event_type: string;
  skill_key?: string | null;
  conversation_id?: string | null;
  speech_practice_id?: string | null;
  payload?: Json;
  occurred_at?: string;
  created_at?: string;
  idempotency_key?: string | null;
}

export type LearningEventsUpdate = Partial<LearningEventsInsert>;

/** `public.learning_milestones` */
export interface LearningMilestonesRow {
  id: string;
  child_id: string;
  milestone_key: string;
  title: string;
  achieved_at: string;
  created_at: string;
}

export interface LearningMilestonesInsert {
  id?: string;
  child_id: string;
  milestone_key: string;
  title: string;
  achieved_at?: string;
  created_at?: string;
}

export type LearningMilestonesUpdate = Partial<LearningMilestonesInsert>;

/** `public.learning_progress` */
export interface LearningProgressRow {
  id: string;
  child_id: string;
  skill_key: string;
  exposure_count: number;
  success_count: number;
  first_observed_at: string;
  last_observed_at: string;
  created_at: string;
  updated_at: string;
}

export interface LearningProgressInsert {
  id?: string;
  child_id: string;
  skill_key: string;
  exposure_count?: number;
  success_count?: number;
  first_observed_at?: string;
  last_observed_at?: string;
  created_at?: string;
  updated_at?: string;
}

export type LearningProgressUpdate = Partial<LearningProgressInsert>;

/** `public.learning_skill_levels` */
export interface LearningSkillLevelsRow {
  id: string;
  child_id: string;
  vocabulary_level: 'getting_started' | 'growing' | 'confident';
  pronunciation_level: 'getting_started' | 'growing' | 'confident';
  conversation_skill_level: 'getting_started' | 'growing' | 'confident';
  basis: Json;
  computed_at: string;
  created_at: string;
  updated_at: string;
}

export interface LearningSkillLevelsInsert {
  id?: string;
  child_id: string;
  vocabulary_level?: 'getting_started' | 'growing' | 'confident';
  pronunciation_level?: 'getting_started' | 'growing' | 'confident';
  conversation_skill_level?: 'getting_started' | 'growing' | 'confident';
  basis?: Json;
  computed_at?: string;
  created_at?: string;
  updated_at?: string;
}

export type LearningSkillLevelsUpdate = Partial<LearningSkillLevelsInsert>;

/** `public.learning_topics` */
export interface LearningTopicsRow {
  key: string;
  display_name: string;
  description: string;
  age_groups: string[];
  sort_order: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface LearningTopicsInsert {
  key: string;
  display_name: string;
  description?: string;
  age_groups?: string[];
  sort_order?: number;
  is_active?: boolean;
  created_at?: string;
  updated_at?: string;
}

export type LearningTopicsUpdate = Partial<LearningTopicsInsert>;

/** `public.learning_weekly` */
export interface LearningWeeklyRow {
  id: string;
  child_id: string;
  week_start: string;
  active_days: number;
  conversation_seconds: number;
  conversation_turns: number;
  conversation_count: number;
  words_used: number;
  new_vocabulary: number;
  stories_completed: number;
  exercises_completed: number;
  pronunciation_score_sum: number;
  pronunciation_score_count: number;
  computed_at: string;
  created_at: string;
  updated_at: string;
}

export interface LearningWeeklyInsert {
  id?: string;
  child_id: string;
  week_start: string;
  active_days?: number;
  conversation_seconds?: number;
  conversation_turns?: number;
  conversation_count?: number;
  words_used?: number;
  new_vocabulary?: number;
  stories_completed?: number;
  exercises_completed?: number;
  pronunciation_score_sum?: number;
  pronunciation_score_count?: number;
  computed_at?: string;
  created_at?: string;
  updated_at?: string;
}

export type LearningWeeklyUpdate = Partial<LearningWeeklyInsert>;

/** `public.login_attempts` */
export interface LoginAttemptsRow {
  id: string;
  email_hash: string;
  ip_address: string | null;
  succeeded: boolean;
  user_agent: string | null;
  attempted_at: string;
  created_at: string;
}

export interface LoginAttemptsInsert {
  id?: string;
  email_hash: string;
  ip_address?: string | null;
  succeeded: boolean;
  user_agent?: string | null;
  attempted_at?: string;
  created_at?: string;
}

export type LoginAttemptsUpdate = Partial<LoginAttemptsInsert>;

/** `public.messages` */
export interface MessagesRow {
  id: string;
  conversation_id: string;
  child_id: string;
  role: 'child' | 'companion';
  sequence: number;
  status: 'delivered' | 'blocked' | 'redacted';
  content_ciphertext: Uint8Array;
  content_key_id: string;
  content_length: number;
  stt_confidence: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: string | null;
  latency_ms: number | null;
  created_at: string;
  provider: string | null;
  model: string | null;
  safety_layers_passed: string[];
  input_mode: 'text' | 'voice';
}

export interface MessagesInsert {
  id?: string;
  conversation_id: string;
  child_id: string;
  role: 'child' | 'companion';
  sequence: number;
  status?: 'delivered' | 'blocked' | 'redacted';
  content_ciphertext: Uint8Array;
  content_key_id: string;
  content_length?: number;
  stt_confidence?: number | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  cost_usd?: string | null;
  latency_ms?: number | null;
  created_at?: string;
  provider?: string | null;
  model?: string | null;
  safety_layers_passed?: string[];
  input_mode?: 'text' | 'voice';
}

export type MessagesUpdate = Partial<MessagesInsert>;

/** `public.notifications` */
export interface NotificationsRow {
  id: string;
  parent_id: string;
  child_id: string | null;
  kind: 'safety_flag' | 'safety_escalation' | 'daily_summary' | 'weekly_summary' | 'quota_reached' | 'subscription_renewed' | 'subscription_failed' | 'data_export_ready' | 'account_deletion_scheduled' | 'security_alert';
  channel: 'in_app' | 'email' | 'push';
  title: string;
  body: string;
  resource_type: string | null;
  resource_id: string | null;
  status: 'pending' | 'sent' | 'read' | 'dismissed' | 'failed';
  sent_at: string | null;
  read_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface NotificationsInsert {
  id?: string;
  parent_id: string;
  child_id?: string | null;
  kind: 'safety_flag' | 'safety_escalation' | 'daily_summary' | 'weekly_summary' | 'quota_reached' | 'subscription_renewed' | 'subscription_failed' | 'data_export_ready' | 'account_deletion_scheduled' | 'security_alert';
  channel?: 'in_app' | 'email' | 'push';
  title: string;
  body: string;
  resource_type?: string | null;
  resource_id?: string | null;
  status?: 'pending' | 'sent' | 'read' | 'dismissed' | 'failed';
  sent_at?: string | null;
  read_at?: string | null;
  created_at?: string;
  updated_at?: string;
}

export type NotificationsUpdate = Partial<NotificationsInsert>;

/** `public.parental_controls` */
export interface ParentalControlsRow {
  id: string;
  child_id: string;
  daily_minute_limit: number;
  session_minute_limit: number;
  quiet_hours_start: string | null;
  quiet_hours_end: string | null;
  allowed_character_ids: string[];
  blocked_topics: string[];
  language_lock: string | null;
  transcript_retention_days: number;
  notify_on_safety_flag: boolean;
  notify_on_daily_summary: boolean;
  is_paused: boolean;
  created_at: string;
  updated_at: string;
  content_filter_level: 'standard' | 'strict';
  allowed_days: number[];
  notify_on_weekly_summary: boolean;
  notify_on_time_limit: boolean;
}

export interface ParentalControlsInsert {
  id?: string;
  child_id: string;
  daily_minute_limit?: number;
  session_minute_limit?: number;
  quiet_hours_start?: string | null;
  quiet_hours_end?: string | null;
  allowed_character_ids?: string[];
  blocked_topics?: string[];
  language_lock?: string | null;
  transcript_retention_days?: number;
  notify_on_safety_flag?: boolean;
  notify_on_daily_summary?: boolean;
  is_paused?: boolean;
  created_at?: string;
  updated_at?: string;
  content_filter_level?: 'standard' | 'strict';
  allowed_days?: number[];
  notify_on_weekly_summary?: boolean;
  notify_on_time_limit?: boolean;
}

export type ParentalControlsUpdate = Partial<ParentalControlsInsert>;

/** `public.parents` */
export interface ParentsRow {
  id: string;
  email: string;
  password_hash: string | null;
  display_name: string | null;
  country_code: string;
  locale: string;
  timezone: string;
  status: 'active' | 'suspended' | 'pending_deletion';
  parent_gate_mode: 'arithmetic' | 'device_biometric' | 'pin';
  marketing_opt_in: boolean;
  last_seen_at: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
  role: 'parent' | 'admin' | 'support';
  email_verified_at: string | null;
  last_login_at: string | null;
  failed_login_count: number;
  locked_until: string | null;
}

export interface ParentsInsert {
  id: string;
  email: string;
  password_hash?: string | null;
  display_name?: string | null;
  country_code?: string;
  locale?: string;
  timezone?: string;
  status?: 'active' | 'suspended' | 'pending_deletion';
  parent_gate_mode?: 'arithmetic' | 'device_biometric' | 'pin';
  marketing_opt_in?: boolean;
  last_seen_at?: string | null;
  deleted_at?: string | null;
  created_at?: string;
  updated_at?: string;
  role?: 'parent' | 'admin' | 'support';
  email_verified_at?: string | null;
  last_login_at?: string | null;
  failed_login_count?: number;
  locked_until?: string | null;
}

export type ParentsUpdate = Partial<ParentsInsert>;

/** `public.password_resets` */
export interface PasswordResetsRow {
  id: string;
  parent_id: string;
  token_hash: string;
  expires_at: string;
  consumed_at: string | null;
  requested_ip: string | null;
  created_at: string;
}

export interface PasswordResetsInsert {
  id?: string;
  parent_id: string;
  token_hash: string;
  expires_at: string;
  consumed_at?: string | null;
  requested_ip?: string | null;
  created_at?: string;
}

export type PasswordResetsUpdate = Partial<PasswordResetsInsert>;

/** `public.payment_events` */
export interface PaymentEventsRow {
  id: string;
  rail: 'card' | 'stripe' | 'jazzcash' | 'easypaisa' | 'carrier_billing' | 'apple_iap' | 'google_play' | 'mock';
  external_event_id: string;
  event_type: string;
  signature_verified: boolean;
  processing_status: 'pending' | 'processed' | 'ignored' | 'failed';
  processing_error: string | null;
  payload: Json;
  subscription_id: string | null;
  parent_id: string | null;
  received_at: string;
  processed_at: string | null;
  created_at: string;
  delivery_count: number;
  event_occurred_at: string | null;
  ignored_reason: string | null;
  payment_id: string | null;
}

export interface PaymentEventsInsert {
  id?: string;
  rail: 'card' | 'stripe' | 'jazzcash' | 'easypaisa' | 'carrier_billing' | 'apple_iap' | 'google_play' | 'mock';
  external_event_id: string;
  event_type: string;
  signature_verified: boolean;
  processing_status?: 'pending' | 'processed' | 'ignored' | 'failed';
  processing_error?: string | null;
  payload?: Json;
  subscription_id?: string | null;
  parent_id?: string | null;
  received_at?: string;
  processed_at?: string | null;
  created_at?: string;
  delivery_count?: number;
  event_occurred_at?: string | null;
  ignored_reason?: string | null;
  payment_id?: string | null;
}

export type PaymentEventsUpdate = Partial<PaymentEventsInsert>;

/** `public.payment_refunds` */
export interface PaymentRefundsRow {
  id: string;
  payment_id: string;
  parent_id: string;
  rail: 'card' | 'stripe' | 'jazzcash' | 'easypaisa' | 'carrier_billing' | 'apple_iap' | 'google_play' | 'mock';
  rail_reference: string | null;
  idempotency_key: string;
  status: 'requested' | 'succeeded' | 'failed' | 'unsupported';
  amount_minor: number;
  currency: string;
  reason: string;
  failure_code: string | null;
  requested_by: string | null;
  requested_at: string;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface PaymentRefundsInsert {
  id?: string;
  payment_id: string;
  parent_id: string;
  rail: 'card' | 'stripe' | 'jazzcash' | 'easypaisa' | 'carrier_billing' | 'apple_iap' | 'google_play' | 'mock';
  rail_reference?: string | null;
  idempotency_key: string;
  status?: 'requested' | 'succeeded' | 'failed' | 'unsupported';
  amount_minor: number;
  currency: string;
  reason: string;
  failure_code?: string | null;
  requested_by?: string | null;
  requested_at?: string;
  completed_at?: string | null;
  created_at?: string;
  updated_at?: string;
}

export type PaymentRefundsUpdate = Partial<PaymentRefundsInsert>;

/** `public.payments` */
export interface PaymentsRow {
  id: string;
  parent_id: string;
  subscription_id: string | null;
  checkout_id: string | null;
  rail: 'card' | 'stripe' | 'jazzcash' | 'easypaisa' | 'carrier_billing' | 'apple_iap' | 'google_play' | 'mock';
  status: 'initiated' | 'pending' | 'authorized' | 'captured' | 'failed' | 'cancelled' | 'refunded' | 'unresolved';
  amount_minor: number;
  currency: string;
  rail_reference: string | null;
  idempotency_key: string;
  failure_code: string | null;
  rail_failure_code: string | null;
  payment_method_brand: string | null;
  payment_method_last4: string | null;
  instrument_token: string | null;
  attempt_count: number;
  last_checked_at: string | null;
  reconciled_at: string | null;
  initiated_at: string;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface PaymentsInsert {
  id?: string;
  parent_id: string;
  subscription_id?: string | null;
  checkout_id?: string | null;
  rail: 'card' | 'stripe' | 'jazzcash' | 'easypaisa' | 'carrier_billing' | 'apple_iap' | 'google_play' | 'mock';
  status?: 'initiated' | 'pending' | 'authorized' | 'captured' | 'failed' | 'cancelled' | 'refunded' | 'unresolved';
  amount_minor: number;
  currency: string;
  rail_reference?: string | null;
  idempotency_key: string;
  failure_code?: string | null;
  rail_failure_code?: string | null;
  payment_method_brand?: string | null;
  payment_method_last4?: string | null;
  instrument_token?: string | null;
  attempt_count?: number;
  last_checked_at?: string | null;
  reconciled_at?: string | null;
  initiated_at?: string;
  completed_at?: string | null;
  created_at?: string;
  updated_at?: string;
}

export type PaymentsUpdate = Partial<PaymentsInsert>;

/** `public.practice_exercises` */
export interface PracticeExercisesRow {
  id: string;
  exercise_key: string;
  language_code: string;
  title: string;
  skill_key: string;
  kind: 'word' | 'syllable';
  age_groups: string[];
  sort_order: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface PracticeExercisesInsert {
  id?: string;
  exercise_key: string;
  language_code?: string;
  title: string;
  skill_key: string;
  kind: 'word' | 'syllable';
  age_groups?: string[];
  sort_order?: number;
  is_active?: boolean;
  created_at?: string;
  updated_at?: string;
}

export type PracticeExercisesUpdate = Partial<PracticeExercisesInsert>;

/** `public.practice_targets` */
export interface PracticeTargetsRow {
  id: string;
  exercise_id: string;
  sequence: number;
  text: string;
  syllables: string[];
  expected_ipa: string | null;
  hint: string | null;
  created_at: string;
}

export interface PracticeTargetsInsert {
  id?: string;
  exercise_id: string;
  sequence: number;
  text: string;
  syllables?: string[];
  expected_ipa?: string | null;
  hint?: string | null;
  created_at?: string;
}

export type PracticeTargetsUpdate = Partial<PracticeTargetsInsert>;

/** `public.pronunciation_results` */
export interface PronunciationResultsRow {
  id: string;
  speech_practice_id: string;
  child_id: string;
  target_text: string;
  sequence: number;
  attempt_number: number;
  overall_score: number;
  phoneme_scores: Json;
  is_correct: boolean;
  duration_ms: number | null;
  created_at: string;
  language_code: string;
  exercise_key: string | null;
  confidence: number;
  analysis_method: 'phoneme_alignment' | 'word_alignment' | 'transcript_similarity';
  phoneme_data_available: boolean;
  provider: string | null;
  provider_model: string | null;
}

export interface PronunciationResultsInsert {
  id?: string;
  speech_practice_id: string;
  child_id: string;
  target_text: string;
  sequence: number;
  attempt_number?: number;
  overall_score: number;
  phoneme_scores?: Json;
  is_correct?: boolean;
  duration_ms?: number | null;
  created_at?: string;
  language_code?: string;
  exercise_key?: string | null;
  confidence?: number;
  analysis_method?: 'phoneme_alignment' | 'word_alignment' | 'transcript_similarity';
  phoneme_data_available?: boolean;
  provider?: string | null;
  provider_model?: string | null;
}

export type PronunciationResultsUpdate = Partial<PronunciationResultsInsert>;

/** `public.safety_escalations` */
export interface SafetyEscalationsRow {
  id: string;
  child_id: string;
  conversation_id: string | null;
  reason: 'signal_category' | 'evasion_of_safety' | 'repeated_attempts' | 'unspecified';
  categories: string[];
  severity: 'low' | 'medium' | 'high' | 'critical';
  occurred_at: string;
  delivery_status: 'pending' | 'delivered' | 'abandoned';
  attempts: number;
  last_attempt_at: string | null;
  last_error: string | null;
  delivered_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SafetyEscalationsInsert {
  id?: string;
  child_id: string;
  conversation_id?: string | null;
  reason: 'signal_category' | 'evasion_of_safety' | 'repeated_attempts' | 'unspecified';
  categories?: string[];
  severity?: 'low' | 'medium' | 'high' | 'critical';
  occurred_at?: string;
  delivery_status?: 'pending' | 'delivered' | 'abandoned';
  attempts?: number;
  last_attempt_at?: string | null;
  last_error?: string | null;
  delivered_at?: string | null;
  created_at?: string;
  updated_at?: string;
}

export type SafetyEscalationsUpdate = Partial<SafetyEscalationsInsert>;

/** `public.safety_policies` */
export interface SafetyPoliciesRow {
  id: string;
  category: string;
  age_group: '*' | 'AGE_3_5' | 'AGE_6_8' | 'AGE_9_10';
  applies_to: 'child_input' | 'model_output' | 'both';
  action: 'allow' | 'observe' | 'redirect' | 'block' | 'end_session';
  min_confidence: number;
  escalates: boolean;
  policy_version: string;
  rationale: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface SafetyPoliciesInsert {
  id?: string;
  category: string;
  age_group?: '*' | 'AGE_3_5' | 'AGE_6_8' | 'AGE_9_10';
  applies_to: 'child_input' | 'model_output' | 'both';
  action: 'allow' | 'observe' | 'redirect' | 'block' | 'end_session';
  min_confidence?: number;
  escalates?: boolean;
  policy_version: string;
  rationale: string;
  is_active?: boolean;
  created_at?: string;
  updated_at?: string;
}

export type SafetyPoliciesUpdate = Partial<SafetyPoliciesInsert>;

/** `public.sessions` */
export interface SessionsRow {
  id: string;
  parent_id: string;
  family_id: string;
  refresh_token_hash: string;
  device_label: string | null;
  user_agent: string | null;
  ip_address: string | null;
  issued_at: string;
  expires_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  revoked_reason: 'logout' | 'rotated' | 'reuse_detected' | 'password_changed' | 'account_deleted' | 'expired' | 'admin_revoked' | null;
  replaced_by: string | null;
  created_at: string;
}

export interface SessionsInsert {
  id?: string;
  parent_id: string;
  family_id: string;
  refresh_token_hash: string;
  device_label?: string | null;
  user_agent?: string | null;
  ip_address?: string | null;
  issued_at?: string;
  expires_at: string;
  last_used_at?: string | null;
  revoked_at?: string | null;
  revoked_reason?: 'logout' | 'rotated' | 'reuse_detected' | 'password_changed' | 'account_deleted' | 'expired' | 'admin_revoked' | null;
  replaced_by?: string | null;
  created_at?: string;
}

export type SessionsUpdate = Partial<SessionsInsert>;

/** `public.speech_practice` */
export interface SpeechPracticeRow {
  id: string;
  child_id: string;
  language_code: string;
  exercise_key: string;
  status: 'in_progress' | 'completed' | 'abandoned';
  attempt_count: number;
  average_score: number | null;
  started_at: string;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SpeechPracticeInsert {
  id?: string;
  child_id: string;
  language_code?: string;
  exercise_key: string;
  status?: 'in_progress' | 'completed' | 'abandoned';
  attempt_count?: number;
  average_score?: number | null;
  started_at?: string;
  completed_at?: string | null;
  created_at?: string;
  updated_at?: string;
}

export type SpeechPracticeUpdate = Partial<SpeechPracticeInsert>;

/** `public.store_notifications` */
export interface StoreNotificationsRow {
  id: string;
  store: 'apple_iap' | 'google_play';
  notification_id: string;
  kind: string;
  original_transaction_id: string | null;
  environment: 'sandbox' | 'production';
  signature_verified: boolean;
  processing_status: 'pending' | 'processed' | 'ignored' | 'failed';
  processing_error: string | null;
  ignored_reason: string | null;
  payload: Json;
  store_purchase_id: string | null;
  parent_id: string | null;
  delivery_count: number;
  occurred_at: string | null;
  received_at: string;
  processed_at: string | null;
  created_at: string;
}

export interface StoreNotificationsInsert {
  id?: string;
  store: 'apple_iap' | 'google_play';
  notification_id: string;
  kind: string;
  original_transaction_id?: string | null;
  environment: 'sandbox' | 'production';
  signature_verified: boolean;
  processing_status?: 'pending' | 'processed' | 'ignored' | 'failed';
  processing_error?: string | null;
  ignored_reason?: string | null;
  payload?: Json;
  store_purchase_id?: string | null;
  parent_id?: string | null;
  delivery_count?: number;
  occurred_at?: string | null;
  received_at?: string;
  processed_at?: string | null;
  created_at?: string;
}

export type StoreNotificationsUpdate = Partial<StoreNotificationsInsert>;

/** `public.store_product_map` */
export interface StoreProductMapRow {
  id: string;
  store: 'apple_iap' | 'google_play';
  product_id: string;
  plan_id: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface StoreProductMapInsert {
  id?: string;
  store: 'apple_iap' | 'google_play';
  product_id: string;
  plan_id: string;
  is_active?: boolean;
  created_at?: string;
  updated_at?: string;
}

export type StoreProductMapUpdate = Partial<StoreProductMapInsert>;

/** `public.store_purchases` */
export interface StorePurchasesRow {
  id: string;
  parent_id: string;
  store: 'apple_iap' | 'google_play';
  original_transaction_id: string;
  latest_transaction_id: string | null;
  product_id: string;
  state: 'active' | 'trial' | 'grace_period' | 'on_hold' | 'paused' | 'cancelled' | 'expired' | 'refunded' | 'invalid';
  expires_at: string | null;
  grace_period_ends_at: string | null;
  auto_renewing: boolean;
  environment: 'sandbox' | 'production';
  verified_at: string;
  subscription_id: string | null;
  refunded_at: string | null;
  first_seen_at: string;
  last_notification_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface StorePurchasesInsert {
  id?: string;
  parent_id: string;
  store: 'apple_iap' | 'google_play';
  original_transaction_id: string;
  latest_transaction_id?: string | null;
  product_id: string;
  state: 'active' | 'trial' | 'grace_period' | 'on_hold' | 'paused' | 'cancelled' | 'expired' | 'refunded' | 'invalid';
  expires_at?: string | null;
  grace_period_ends_at?: string | null;
  auto_renewing?: boolean;
  environment: 'sandbox' | 'production';
  verified_at: string;
  subscription_id?: string | null;
  refunded_at?: string | null;
  first_seen_at?: string;
  last_notification_at?: string | null;
  created_at?: string;
  updated_at?: string;
}

export type StorePurchasesUpdate = Partial<StorePurchasesInsert>;

/** `public.subscription_checkouts` */
export interface SubscriptionCheckoutsRow {
  id: string;
  parent_id: string;
  plan_id: string;
  rail: 'card' | 'stripe' | 'jazzcash' | 'easypaisa' | 'carrier_billing' | 'apple_iap' | 'google_play' | 'mock';
  idempotency_key: string;
  external_id: string | null;
  status: 'pending' | 'completed' | 'expired' | 'abandoned';
  expires_at: string;
  completed_at: string | null;
  subscription_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface SubscriptionCheckoutsInsert {
  id?: string;
  parent_id: string;
  plan_id: string;
  rail: 'card' | 'stripe' | 'jazzcash' | 'easypaisa' | 'carrier_billing' | 'apple_iap' | 'google_play' | 'mock';
  idempotency_key: string;
  external_id?: string | null;
  status?: 'pending' | 'completed' | 'expired' | 'abandoned';
  expires_at: string;
  completed_at?: string | null;
  subscription_id?: string | null;
  created_at?: string;
  updated_at?: string;
}

export type SubscriptionCheckoutsUpdate = Partial<SubscriptionCheckoutsInsert>;

/** `public.subscription_plans` */
export interface SubscriptionPlansRow {
  id: string;
  code: string;
  display_name: string;
  description: string;
  tier: 'free' | 'paid';
  price_minor: number;
  currency: string;
  billing_interval: 'week' | 'month' | 'year' | 'once' | 'none';
  daily_minute_limit: number;
  child_profile_limit: number;
  weekly_story_limit: number | null;
  features: Json;
  available_rails: string[];
  is_active: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
  daily_turn_limit: number;
  max_conversation_turns: number;
  concurrent_conversation_limit: number;
  voice_enabled: boolean;
  daily_voice_turn_limit: number;
  trial_days: number;
  grace_days: number;
}

export interface SubscriptionPlansInsert {
  id?: string;
  code: string;
  display_name: string;
  description?: string;
  tier: 'free' | 'paid';
  price_minor?: number;
  currency?: string;
  billing_interval?: 'week' | 'month' | 'year' | 'once' | 'none';
  daily_minute_limit: number;
  child_profile_limit: number;
  weekly_story_limit?: number | null;
  features?: Json;
  available_rails?: string[];
  is_active?: boolean;
  sort_order?: number;
  created_at?: string;
  updated_at?: string;
  daily_turn_limit?: number;
  max_conversation_turns?: number;
  concurrent_conversation_limit?: number;
  voice_enabled?: boolean;
  daily_voice_turn_limit?: number;
  trial_days?: number;
  grace_days?: number;
}

export type SubscriptionPlansUpdate = Partial<SubscriptionPlansInsert>;

/** `public.subscriptions` */
export interface SubscriptionsRow {
  id: string;
  parent_id: string;
  plan_id: string;
  rail: 'card' | 'stripe' | 'jazzcash' | 'easypaisa' | 'carrier_billing' | 'apple_iap' | 'google_play' | 'mock';
  status: 'free' | 'trialing' | 'active' | 'grace' | 'past_due' | 'cancelled' | 'expired';
  external_id: string | null;
  payment_method_token: string | null;
  payment_method_brand: 'visa' | 'mastercard' | 'amex' | 'unionpay' | 'wallet' | 'other' | null;
  payment_method_last4: string | null;
  currency: string;
  price_minor: number;
  current_period_start: string | null;
  current_period_end: string | null;
  cancel_at: string | null;
  cancelled_at: string | null;
  trial_ends_at: string | null;
  created_at: string;
  updated_at: string;
  grace_ends_at: string | null;
  trial_consumed: boolean;
  last_event_at: string | null;
  last_event_id: string | null;
}

export interface SubscriptionsInsert {
  id?: string;
  parent_id: string;
  plan_id: string;
  rail: 'card' | 'stripe' | 'jazzcash' | 'easypaisa' | 'carrier_billing' | 'apple_iap' | 'google_play' | 'mock';
  status?: 'free' | 'trialing' | 'active' | 'grace' | 'past_due' | 'cancelled' | 'expired';
  external_id?: string | null;
  payment_method_token?: string | null;
  payment_method_brand?: 'visa' | 'mastercard' | 'amex' | 'unionpay' | 'wallet' | 'other' | null;
  payment_method_last4?: string | null;
  currency?: string;
  price_minor?: number;
  current_period_start?: string | null;
  current_period_end?: string | null;
  cancel_at?: string | null;
  cancelled_at?: string | null;
  trial_ends_at?: string | null;
  created_at?: string;
  updated_at?: string;
  grace_ends_at?: string | null;
  trial_consumed?: boolean;
  last_event_at?: string | null;
  last_event_id?: string | null;
}

export type SubscriptionsUpdate = Partial<SubscriptionsInsert>;

/** `public.supported_languages` */
export interface SupportedLanguagesRow {
  code: string;
  english_name: string;
  native_name: string;
  direction: 'ltr' | 'rtl';
  stt_supported: boolean;
  tts_supported: boolean;
  is_active: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
  tier: 'primary' | 'secondary' | 'regional';
}

export interface SupportedLanguagesInsert {
  code: string;
  english_name: string;
  native_name: string;
  direction?: 'ltr' | 'rtl';
  stt_supported?: boolean;
  tts_supported?: boolean;
  is_active?: boolean;
  sort_order?: number;
  created_at?: string;
  updated_at?: string;
  tier?: 'primary' | 'secondary' | 'regional';
}

export type SupportedLanguagesUpdate = Partial<SupportedLanguagesInsert>;

/** `public.transactions` */
export interface TransactionsRow {
  id: string;
  subscription_id: string | null;
  parent_id: string;
  rail: 'card' | 'stripe' | 'jazzcash' | 'easypaisa' | 'carrier_billing' | 'apple_iap' | 'google_play' | 'mock';
  external_id: string;
  kind: 'charge' | 'credit';
  status: 'failed' | 'reversed';
  amount_minor: number;
  currency: string;
  payment_method_brand: string | null;
  payment_method_last4: string | null;
  failure_code: string | null;
  occurred_at: string;
  created_at: string;
  updated_at: string;
  payment_id: string | null;
}

export interface TransactionsInsert {
  id?: string;
  subscription_id?: string | null;
  parent_id: string;
  rail: 'card' | 'stripe' | 'jazzcash' | 'easypaisa' | 'carrier_billing' | 'apple_iap' | 'google_play' | 'mock';
  external_id: string;
  kind: 'charge' | 'credit';
  status: 'failed' | 'reversed';
  amount_minor: number;
  currency: string;
  payment_method_brand?: string | null;
  payment_method_last4?: string | null;
  failure_code?: string | null;
  occurred_at: string;
  created_at?: string;
  updated_at?: string;
  payment_id?: string | null;
}

export type TransactionsUpdate = Partial<TransactionsInsert>;

/** `public.usage_daily` */
export interface UsageDailyRow {
  id: string;
  child_id: string;
  usage_date: string;
  turns: number;
  blocked_turns: number;
  conversations_started: number;
  input_tokens: string;
  output_tokens: string;
  cost_usd: string;
  created_at: string;
  updated_at: string;
  voice_turns: number;
}

export interface UsageDailyInsert {
  id?: string;
  child_id: string;
  usage_date: string;
  turns?: number;
  blocked_turns?: number;
  conversations_started?: number;
  input_tokens?: string;
  output_tokens?: string;
  cost_usd?: string;
  created_at?: string;
  updated_at?: string;
  voice_turns?: number;
}

export type UsageDailyUpdate = Partial<UsageDailyInsert>;

/** `public.vocabulary_words` */
export interface VocabularyWordsRow {
  id: string;
  language_code: string;
  word: string;
  tier: number;
  topic_key: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface VocabularyWordsInsert {
  id?: string;
  language_code?: string;
  word: string;
  tier?: number;
  topic_key?: string | null;
  is_active?: boolean;
  created_at?: string;
  updated_at?: string;
}

export type VocabularyWordsUpdate = Partial<VocabularyWordsInsert>;

/** Supabase-shaped schema map: `createClient<Database>(...)`. */
export interface Database {
  public: {
    Tables: {
      achievements: { Row: AchievementsRow; Insert: AchievementsInsert; Update: AchievementsUpdate };
      ai_characters: { Row: AiCharactersRow; Insert: AiCharactersInsert; Update: AiCharactersUpdate };
      analytics_events: { Row: AnalyticsEventsRow; Insert: AnalyticsEventsInsert; Update: AnalyticsEventsUpdate };
      audio_artifacts: { Row: AudioArtifactsRow; Insert: AudioArtifactsInsert; Update: AudioArtifactsUpdate };
      audit_logs: { Row: AuditLogsRow; Insert: AuditLogsInsert; Update: AuditLogsUpdate };
      character_languages: { Row: CharacterLanguagesRow; Insert: CharacterLanguagesInsert; Update: CharacterLanguagesUpdate };
      child_achievements: { Row: ChildAchievementsRow; Insert: ChildAchievementsInsert; Update: ChildAchievementsUpdate };
      child_languages: { Row: ChildLanguagesRow; Insert: ChildLanguagesInsert; Update: ChildLanguagesUpdate };
      child_learning_preferences: { Row: ChildLearningPreferencesRow; Insert: ChildLearningPreferencesInsert; Update: ChildLearningPreferencesUpdate };
      child_learning_topics: { Row: ChildLearningTopicsRow; Insert: ChildLearningTopicsInsert; Update: ChildLearningTopicsUpdate };
      child_vocabulary: { Row: ChildVocabularyRow; Insert: ChildVocabularyInsert; Update: ChildVocabularyUpdate };
      children: { Row: ChildrenRow; Insert: ChildrenInsert; Update: ChildrenUpdate };
      consent_records: { Row: ConsentRecordsRow; Insert: ConsentRecordsInsert; Update: ConsentRecordsUpdate };
      consent_requirements: { Row: ConsentRequirementsRow; Insert: ConsentRequirementsInsert; Update: ConsentRequirementsUpdate };
      content_flags: { Row: ContentFlagsRow; Insert: ContentFlagsInsert; Update: ContentFlagsUpdate };
      conversations: { Row: ConversationsRow; Insert: ConversationsInsert; Update: ConversationsUpdate };
      email_verifications: { Row: EmailVerificationsRow; Insert: EmailVerificationsInsert; Update: EmailVerificationsUpdate };
      learning_daily: { Row: LearningDailyRow; Insert: LearningDailyInsert; Update: LearningDailyUpdate };
      learning_event_types: { Row: LearningEventTypesRow; Insert: LearningEventTypesInsert; Update: LearningEventTypesUpdate };
      learning_events: { Row: LearningEventsRow; Insert: LearningEventsInsert; Update: LearningEventsUpdate };
      learning_milestones: { Row: LearningMilestonesRow; Insert: LearningMilestonesInsert; Update: LearningMilestonesUpdate };
      learning_progress: { Row: LearningProgressRow; Insert: LearningProgressInsert; Update: LearningProgressUpdate };
      learning_skill_levels: { Row: LearningSkillLevelsRow; Insert: LearningSkillLevelsInsert; Update: LearningSkillLevelsUpdate };
      learning_topics: { Row: LearningTopicsRow; Insert: LearningTopicsInsert; Update: LearningTopicsUpdate };
      learning_weekly: { Row: LearningWeeklyRow; Insert: LearningWeeklyInsert; Update: LearningWeeklyUpdate };
      login_attempts: { Row: LoginAttemptsRow; Insert: LoginAttemptsInsert; Update: LoginAttemptsUpdate };
      messages: { Row: MessagesRow; Insert: MessagesInsert; Update: MessagesUpdate };
      notifications: { Row: NotificationsRow; Insert: NotificationsInsert; Update: NotificationsUpdate };
      parental_controls: { Row: ParentalControlsRow; Insert: ParentalControlsInsert; Update: ParentalControlsUpdate };
      parents: { Row: ParentsRow; Insert: ParentsInsert; Update: ParentsUpdate };
      password_resets: { Row: PasswordResetsRow; Insert: PasswordResetsInsert; Update: PasswordResetsUpdate };
      payment_events: { Row: PaymentEventsRow; Insert: PaymentEventsInsert; Update: PaymentEventsUpdate };
      payment_refunds: { Row: PaymentRefundsRow; Insert: PaymentRefundsInsert; Update: PaymentRefundsUpdate };
      payments: { Row: PaymentsRow; Insert: PaymentsInsert; Update: PaymentsUpdate };
      practice_exercises: { Row: PracticeExercisesRow; Insert: PracticeExercisesInsert; Update: PracticeExercisesUpdate };
      practice_targets: { Row: PracticeTargetsRow; Insert: PracticeTargetsInsert; Update: PracticeTargetsUpdate };
      pronunciation_results: { Row: PronunciationResultsRow; Insert: PronunciationResultsInsert; Update: PronunciationResultsUpdate };
      safety_escalations: { Row: SafetyEscalationsRow; Insert: SafetyEscalationsInsert; Update: SafetyEscalationsUpdate };
      safety_policies: { Row: SafetyPoliciesRow; Insert: SafetyPoliciesInsert; Update: SafetyPoliciesUpdate };
      sessions: { Row: SessionsRow; Insert: SessionsInsert; Update: SessionsUpdate };
      speech_practice: { Row: SpeechPracticeRow; Insert: SpeechPracticeInsert; Update: SpeechPracticeUpdate };
      store_notifications: { Row: StoreNotificationsRow; Insert: StoreNotificationsInsert; Update: StoreNotificationsUpdate };
      store_product_map: { Row: StoreProductMapRow; Insert: StoreProductMapInsert; Update: StoreProductMapUpdate };
      store_purchases: { Row: StorePurchasesRow; Insert: StorePurchasesInsert; Update: StorePurchasesUpdate };
      subscription_checkouts: { Row: SubscriptionCheckoutsRow; Insert: SubscriptionCheckoutsInsert; Update: SubscriptionCheckoutsUpdate };
      subscription_plans: { Row: SubscriptionPlansRow; Insert: SubscriptionPlansInsert; Update: SubscriptionPlansUpdate };
      subscriptions: { Row: SubscriptionsRow; Insert: SubscriptionsInsert; Update: SubscriptionsUpdate };
      supported_languages: { Row: SupportedLanguagesRow; Insert: SupportedLanguagesInsert; Update: SupportedLanguagesUpdate };
      transactions: { Row: TransactionsRow; Insert: TransactionsInsert; Update: TransactionsUpdate };
      usage_daily: { Row: UsageDailyRow; Insert: UsageDailyInsert; Update: UsageDailyUpdate };
      vocabulary_words: { Row: VocabularyWordsRow; Insert: VocabularyWordsInsert; Update: VocabularyWordsUpdate };
    };
    Views: {
      character_catalogue: { Row: CharacterCatalogueRow };
      current_consents: { Row: CurrentConsentsRow };
    };
  };
}
