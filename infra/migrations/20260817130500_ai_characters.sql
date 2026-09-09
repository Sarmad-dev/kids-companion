-- =============================================================================
-- ai_characters — the global character catalogue.
-- =============================================================================
-- Curated product content, not user data. The only domain table with no owning
-- parent, and therefore the only one with a genuinely public read policy.

create table ai_characters (
  id              uuid        primary key default app.gen_uuid_v7(),
  slug            text        not null,
  display_name    text        not null,
  -- A short, parent-facing description. NOT the system prompt: prompts are
  -- versioned artefacts under review in services/ai, never rows an operator can
  -- edit. A character that can be re-prompted from the database is a safety
  -- boundary that moves without a code review.
  tagline         text        not null,
  description     text        not null default '',
  prompt_version  text        not null,
  -- Bands this character may be selected for. Bands narrow what is permitted;
  -- they never widen it.
  allowed_bands   text[]      not null default array['early','emerging','developing','fluent'],
  voice_id        text,
  avatar_key      text,
  status          text        not null default 'active',
  sort_order      int         not null default 100,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint ck_ai_characters_slug check (slug ~ '^[a-z0-9-]{2,40}$'),
  constraint ck_ai_characters_status check (status in ('active', 'beta', 'retired')),
  constraint ck_ai_characters_bands_valid
    check (allowed_bands <@ array['early','emerging','developing','fluent']
           and cardinality(allowed_bands) >= 1)
);

create unique index uq_ai_characters_slug on ai_characters (slug);
create index idx_ai_characters_active on ai_characters (sort_order) where status = 'active';

create trigger trg_ai_characters_touch
  before update on ai_characters
  for each row execute function app.touch_updated_at();

comment on table ai_characters is
  'S0 — global catalogue. No personal data. Personas differ in voice and manner only, never in safety policy.';
comment on column ai_characters.prompt_version is
  'Pins the reviewed prompt in services/ai. A prompt change is a safety change.';

alter table ai_characters enable row level security;
alter table ai_characters force row level security;

-- Read-only, and only what is live. Writes are a content operation under the
-- service role, after review.
create policy ai_characters_select_live on ai_characters
  for select to authenticated, anon using (status in ('active', 'beta'));

grant select on ai_characters to authenticated, anon;

-- -----------------------------------------------------------------------------
-- character_languages
-- -----------------------------------------------------------------------------
-- Which characters can speak which languages. Separate from the character row
-- because adding Urdu to a character is a content decision made per language,
-- gated on that language's TTS quality — not a property of the character.
create table character_languages (
  character_id   uuid        not null,
  language_code  text        not null,
  voice_id       text,
  created_at     timestamptz not null default now(),

  constraint pk_character_languages primary key (character_id, language_code),
  constraint fk_character_languages_character
    foreign key (character_id) references ai_characters (id) on delete cascade,
  constraint fk_character_languages_language
    foreign key (language_code) references supported_languages (code) on delete restrict
);

create index idx_character_languages_language on character_languages (language_code);

comment on table character_languages is
  'S0 — which character speaks which language, and with which voice.';

alter table character_languages enable row level security;
alter table character_languages force row level security;

create policy character_languages_select_all on character_languages
  for select to authenticated, anon using (true);

grant select on character_languages to authenticated, anon;
