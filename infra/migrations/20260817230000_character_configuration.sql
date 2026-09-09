-- =============================================================================
-- The character configuration system.
-- =============================================================================
-- THE TENSION THIS MIGRATION RESOLVES, STATED PLAINLY.
--
-- The brief asks for a configuration system so additional characters can be
-- added without code changes. The existing design says the opposite, and says it
-- for a good reason (the comment is still on `ai_characters.tagline`):
--
--   "prompts are versioned artefacts under review in services/ai, never rows an
--    operator can edit. A character that can be re-prompted from the database is
--    a safety boundary that moves without a code review."
--
-- Both are right. The resolution is to split what a character IS from what a
-- character SAYS TO THE MODEL:
--
--   * A character's TRAITS are data. Warmth, pace, vocabulary level, how it
--     encourages, how it tells a story — each is a choice from a CLOSED,
--     CHECK-constrained vocabulary. Adding "Marina the Whale" is an INSERT.
--
--   * The prose each trait becomes is CODE, in services/ai/src/character-traits.ts,
--     under review like every other prompt fragment.
--
-- So nobody can write free-form model instructions into a database row. The
-- worst an operator with table access can do is select a different valid
-- personality — which changes voice and manner, and cannot touch a safety rule,
-- because the safety block is assembled from `INVARIANTS` and comes first in
-- every prompt regardless of what any row says.

-- -----------------------------------------------------------------------------
-- 1. Traits
-- -----------------------------------------------------------------------------
-- Every column below is an enum, not free text. That is the whole mechanism.

alter table ai_characters add column personality_traits text[] not null
  default array['warm']::text[];
alter table ai_characters add column conversation_style text not null default 'responsive';
alter table ai_characters add column vocabulary_style text not null default 'simple';
alter table ai_characters add column encouragement_style text not null default 'warm';
alter table ai_characters add column story_style text not null default 'collaborative';
alter table ai_characters add column greeting_style text not null default 'friendly';
alter table ai_characters add column farewell_style text not null default 'warm';

-- The educational objectives this character leans towards. Curated taxonomy keys
-- that join to `learning_progress.skill_key`, never free text — a character
-- cannot invent a subject.
alter table ai_characters add column educational_objectives text[] not null
  default array[]::text[];

-- Voice configuration. A vendor voice id, plus rate and pitch as bounded
-- numbers. NOT a place for a vendor API key, and there is no column for one.
alter table ai_characters add column voice_config jsonb not null default '{}'::jsonb;

alter table ai_characters add constraint ck_ai_characters_personality
  check (personality_traits <@ array[
    'warm', 'playful', 'calm', 'curious', 'adventurous', 'patient',
    'gentle', 'enthusiastic', 'thoughtful', 'silly'
  ] and cardinality(personality_traits) between 1 and 4);

alter table ai_characters add constraint ck_ai_characters_conversation_style
  check (conversation_style in ('responsive', 'inquisitive', 'narrative', 'explanatory'));

alter table ai_characters add constraint ck_ai_characters_vocabulary_style
  check (vocabulary_style in ('simple', 'everyday', 'descriptive', 'precise'));

alter table ai_characters add constraint ck_ai_characters_encouragement_style
  check (encouragement_style in ('warm', 'celebratory', 'quiet', 'matter_of_fact'));

alter table ai_characters add constraint ck_ai_characters_story_style
  check (story_style in ('collaborative', 'gentle', 'adventurous', 'factual', 'none'));

alter table ai_characters add constraint ck_ai_characters_greeting_style
  check (greeting_style in ('friendly', 'bouncy', 'quiet', 'welcoming', 'curious'));

alter table ai_characters add constraint ck_ai_characters_farewell_style
  check (farewell_style in ('warm', 'sleepy', 'safe_landing', 'thoughtful'));

alter table ai_characters add constraint ck_ai_characters_objectives
  check (cardinality(educational_objectives) <= 8);

-- A voice config that could hold a credential is a voice config that will. The
-- bound is small enough that nothing but the three expected fields fits.
alter table ai_characters add constraint ck_ai_characters_voice_config_bounded
  check (pg_column_size(voice_config) <= 512);

comment on column ai_characters.personality_traits is
  'A CLOSED vocabulary. The prose each trait becomes lives in services/ai/src/character-traits.ts, under review.';
comment on column ai_characters.voice_config is
  'Vendor voice id, rate, pitch. NEVER a credential — see the migration header.';
comment on column ai_characters.educational_objectives is
  'Curated taxonomy keys. A character cannot invent a subject.';

-- -----------------------------------------------------------------------------
-- 2. `prompt_key` becomes optional
-- -----------------------------------------------------------------------------
-- It pinned a row to one of four code-defined personas, which is exactly what
-- made a fifth character a code change. A row with traits and no prompt_key is
-- assembled entirely from its trait selections; a row WITH one keeps using the
-- reviewed built-in, so the four launch characters are unchanged.
alter table ai_characters drop constraint if exists ck_ai_characters_prompt_key;

comment on column ai_characters.prompt_key is
  'Binds to a reviewed built-in persona in services/ai. NULL means "assemble from traits".';

-- -----------------------------------------------------------------------------
-- 3. The four launch characters
-- -----------------------------------------------------------------------------
-- Their traits are recorded even though `prompt_key` still drives their prose.
-- Two reasons: the API can describe them without loading the prompt module, and
-- the trait vocabulary is exercised by real content rather than only by a test.

update ai_characters set
  personality_traits = array['playful', 'enthusiastic', 'warm'],
  conversation_style = 'responsive',
  vocabulary_style = 'simple',
  encouragement_style = 'celebratory',
  story_style = 'gentle',
  greeting_style = 'bouncy',
  farewell_style = 'sleepy',
  educational_objectives = array['vocabulary.everyday', 'social.turn_taking'],
  voice_config = '{"voiceId": "buddy-en-1", "rate": 1.0, "pitch": 1.15}'::jsonb
where slug = 'buddy-the-dog';

update ai_characters set
  personality_traits = array['gentle', 'calm', 'thoughtful'],
  conversation_style = 'narrative',
  vocabulary_style = 'descriptive',
  encouragement_style = 'quiet',
  story_style = 'collaborative',
  greeting_style = 'quiet',
  farewell_style = 'sleepy',
  educational_objectives = array['vocabulary.descriptive', 'imagination.storytelling'],
  voice_config = '{"voiceId": "lily-en-1", "rate": 0.92, "pitch": 1.08}'::jsonb
where slug = 'lily-the-fairy';

update ai_characters set
  personality_traits = array['adventurous', 'enthusiastic', 'curious'],
  conversation_style = 'narrative',
  vocabulary_style = 'everyday',
  encouragement_style = 'celebratory',
  story_style = 'adventurous',
  greeting_style = 'welcoming',
  farewell_style = 'safe_landing',
  educational_objectives = array['imagination.storytelling', 'reasoning.problem_solving'],
  voice_config = '{"voiceId": "captain-en-1", "rate": 1.02, "pitch": 0.95}'::jsonb
where slug = 'captain-sky';

update ai_characters set
  personality_traits = array['patient', 'curious', 'thoughtful'],
  conversation_style = 'explanatory',
  vocabulary_style = 'precise',
  encouragement_style = 'matter_of_fact',
  story_style = 'factual',
  greeting_style = 'curious',
  farewell_style = 'thoughtful',
  educational_objectives = array['knowledge.how_things_work', 'vocabulary.precise', 'reasoning.questions'],
  voice_config = '{"voiceId": "professor-en-1", "rate": 0.95, "pitch": 0.9}'::jsonb
where slug = 'professor-owl';

-- -----------------------------------------------------------------------------
-- 4. Everything a client needs to choose a character, and nothing else
-- -----------------------------------------------------------------------------
-- A view rather than a table grant, so `voice_config` and `prompt_key` cannot
-- reach a client by someone selecting `*`. A child's device has no use for a
-- vendor voice id, and every field it does not receive is a field that cannot
-- leak from it.
create or replace view character_catalogue as
select c.id,
       c.slug,
       c.display_name,
       c.tagline,
       c.description,
       c.allowed_age_groups,
       c.avatar_key,
       c.personality_traits,
       c.conversation_style,
       c.vocabulary_style,
       c.encouragement_style,
       c.story_style,
       c.educational_objectives,
       c.requires_paid_plan,
       c.sort_order
  from ai_characters c
 where c.status in ('active', 'beta');

comment on view character_catalogue is
  'S0 — what a client may know about a character. Excludes voice_config and prompt_key on purpose.';

grant select on character_catalogue to authenticated;
