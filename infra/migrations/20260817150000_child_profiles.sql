-- =============================================================================
-- Child profile subsystem: age groups, languages, characters, learning, consent.
-- =============================================================================
-- Forward-only. This replaces the four-band age model with the three specified
-- age groups, tiers the language catalogue, and adds the consent gate that stops
-- a child reaching conversation before the required consent state is satisfied.

-- -----------------------------------------------------------------------------
-- 1. Age groups
-- -----------------------------------------------------------------------------
-- AGE_3_5 | AGE_6_8 | AGE_9_10, derived from birth month and year.
--
-- Derived, never stored: a stored group silently goes stale on the child's
-- birthday, and a 6th birthday changes vocabulary ceiling, turn length, and
-- content policy all at once.
--
-- Ages outside 3-10 CLAMP to the nearest group rather than erroring. A profile
-- created a month before a third birthday, or a child who ages past ten
-- mid-subscription, must not become unreadable — but `app.age_in_range()`
-- reports the fact so the product can act on it rather than silently pretending
-- an 11-year-old is nine.
create or replace function app.age_group(
  p_birth_year  int,
  p_birth_month int,
  p_at          date default current_date
)
returns text
language sql
stable
as $$
  select case
    when v.age <= 5 then 'AGE_3_5'
    when v.age <= 8 then 'AGE_6_8'
    else                 'AGE_9_10'
  end
  from (
    select extract(year from age(p_at, make_date(p_birth_year, p_birth_month, 1)))::int as age
  ) v;
$$;

comment on function app.age_group(int, int, date) is
  'AGE_3_5 | AGE_6_8 | AGE_9_10. Clamps outside 3-10; see app.age_in_range().';

create or replace function app.age_in_range(
  p_birth_year  int,
  p_birth_month int,
  p_at          date default current_date
)
returns boolean
language sql
stable
as $$
  select extract(year from age(p_at, make_date(p_birth_year, p_birth_month, 1)))::int
         between 3 and 10;
$$;

-- The old four-band function is superseded. Dropped rather than left in place:
-- two age vocabularies in one schema is how a safety threshold gets applied
-- against the wrong one.
drop function if exists app.age_band(int, int, date);

alter table ai_characters rename column allowed_bands to allowed_age_groups;
alter table ai_characters drop constraint ck_ai_characters_bands_valid;

update ai_characters set allowed_age_groups = (
  select array_agg(distinct g order by g)
  from unnest(allowed_age_groups) as b
  cross join lateral (
    select case
      when b in ('early', 'emerging') then 'AGE_3_5'
      when b = 'developing'           then 'AGE_6_8'
      else                                 'AGE_9_10'
    end as g
  ) mapped
);

alter table ai_characters
  alter column allowed_age_groups set default array['AGE_3_5', 'AGE_6_8', 'AGE_9_10'];

alter table ai_characters add constraint ck_ai_characters_age_groups_valid
  check (allowed_age_groups <@ array['AGE_3_5', 'AGE_6_8', 'AGE_9_10']
         and cardinality(allowed_age_groups) >= 1);

-- -----------------------------------------------------------------------------
-- 2. Language tiers
-- -----------------------------------------------------------------------------
-- Tier is a product commitment, not a preference: `primary` languages are ones
-- the companion is expected to be good at, `regional` ones are ones we intend to
-- support and have not proven. Keeping the distinction in the schema stops a
-- language being offered in the UI before its STT and — more importantly — its
-- safety classification are good enough (docs/CHILD_SAFETY.md §9.1).
alter table supported_languages add column tier text not null default 'secondary';

alter table supported_languages add constraint ck_supported_languages_tier
  check (tier in ('primary', 'secondary', 'regional'));

create index idx_supported_languages_tier on supported_languages (tier, sort_order)
  where is_active;

comment on column supported_languages.tier is
  'primary | secondary | regional. A product commitment level, not a user preference.';

insert into supported_languages
  (code, english_name, native_name, direction, tier, stt_supported, tts_supported, is_active, sort_order)
values
  -- Primary: the launch commitment.
  ('en', 'English', 'English',  'ltr', 'primary',   true,  true,  true,  10),
  ('ur', 'Urdu',    'اردو',      'rtl', 'primary',   false, true,  true,  20),
  ('ar', 'Arabic',  'العربية',    'rtl', 'primary',   false, false, false, 30),
  -- Secondary: planned, not yet offered.
  ('hi', 'Hindi',   'हिन्दी',       'ltr', 'secondary', false, false, false, 40),
  ('es', 'Spanish', 'Español',  'ltr', 'secondary', false, false, false, 50),
  ('fr', 'French',  'Français', 'ltr', 'secondary', false, false, false, 60),
  ('zh', 'Mandarin','中文',      'ltr', 'secondary', false, false, false, 70),
  -- Regional: the languages many launch-market families actually speak at home,
  -- and the ones with the least training data. Listed honestly as unsupported
  -- until measured rather than omitted.
  ('pa', 'Punjabi', 'ਪੰਜਾਬੀ',     'ltr', 'regional',  false, false, false, 80),
  ('sd', 'Sindhi',  'سنڌي',      'rtl', 'regional',  false, false, false, 90),
  ('ps', 'Pashto',  'پښتو',      'rtl', 'regional',  false, false, false, 100)
on conflict (code) do update
  set tier         = excluded.tier,
      english_name = excluded.english_name,
      native_name  = excluded.native_name,
      direction    = excluded.direction,
      sort_order   = excluded.sort_order;

-- -----------------------------------------------------------------------------
-- 3. Children: character selection, and less personal data than before
-- -----------------------------------------------------------------------------
alter table children add column preferred_character_id uuid;

alter table children add constraint fk_children_preferred_character
  foreign key (preferred_character_id) references ai_characters (id) on delete set null;

create index idx_children_preferred_character on children (preferred_character_id)
  where preferred_character_id is not null;

alter table children add column archived_at timestamptz;

alter table children add constraint ck_children_archived_consistent
  check (archived_at is null or status = 'archived');

create index idx_children_archived on children (parent_id) where archived_at is not null;

-- DATA MINIMISATION: free-text `interests` is removed.
--
-- It was parent-set and bounded, which sounded safe. It was not: a free-text
-- field invites "loves visiting grandma in Lahore", and now the row carries a
-- family member, a city, and a routine — none of which the product needed and
-- all of which is S2 data about a child. Interests are now curated topic keys
-- from a fixed list (§4), which cannot carry an identifying detail no matter
-- what a parent types.
alter table children drop column interests;

comment on column children.preferred_character_id is
  'S2 — the character this child talks to by default. Validated against the child''s age group and languages.';
comment on column children.archived_at is
  'S2 — archive is reversible and retains data. Deletion is separate and is not reversible.';

-- -----------------------------------------------------------------------------
-- 4. Learning preferences
-- -----------------------------------------------------------------------------
-- A curated topic catalogue, so a child's interests are a set of KEYS rather
-- than anything a parent typed.
create table learning_topics (
  key           text        primary key,
  display_name  text        not null,
  description   text        not null default '',
  -- Which age groups this topic suits. A topic is never offered outside them.
  age_groups    text[]      not null default array['AGE_3_5', 'AGE_6_8', 'AGE_9_10'],
  sort_order    int         not null default 100,
  is_active     boolean     not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint ck_learning_topics_key check (key ~ '^[a-z0-9_]{2,40}$'),
  constraint ck_learning_topics_age_groups
    check (age_groups <@ array['AGE_3_5', 'AGE_6_8', 'AGE_9_10']
           and cardinality(age_groups) >= 1)
);

create index idx_learning_topics_active on learning_topics (sort_order) where is_active;

comment on table learning_topics is
  'S0 — curated catalogue. No personal data. The reason a child''s interests cannot carry identifying detail.';

alter table learning_topics enable row level security;
alter table learning_topics force row level security;

create policy learning_topics_select_all on learning_topics
  for select to authenticated, anon using (is_active);

create policy learning_topics_write_admin on learning_topics
  for all to authenticated
  using (app.current_role() = 'admin') with check (app.current_role() = 'admin');

grant select on learning_topics to authenticated, anon;
grant insert, update, delete on learning_topics to authenticated;

insert into learning_topics (key, display_name, description, age_groups, sort_order) values
  ('animals',        'Animals',           'Creatures, habitats, and the noises they make.', array['AGE_3_5','AGE_6_8','AGE_9_10'], 10),
  ('colours_shapes', 'Colours and shapes','Naming, sorting, and spotting.',                 array['AGE_3_5'],                       20),
  ('counting',       'Numbers',           'Counting, simple sums, and patterns.',           array['AGE_3_5','AGE_6_8'],             30),
  ('stories',        'Stories',           'Short tales with a beginning and an end.',       array['AGE_3_5','AGE_6_8','AGE_9_10'],  40),
  ('vehicles',       'Things that go',    'Cars, trains, boats, and rockets.',              array['AGE_3_5','AGE_6_8'],             50),
  ('space',          'Space',             'Planets, stars, and astronauts.',                array['AGE_6_8','AGE_9_10'],            60),
  ('nature',         'Nature',            'Weather, plants, and the seasons.',              array['AGE_3_5','AGE_6_8','AGE_9_10'],  70),
  ('sports',         'Sports',            'Games, teams, and how to play.',                 array['AGE_6_8','AGE_9_10'],            80),
  ('music',          'Music',             'Songs, rhythm, and instruments.',                array['AGE_3_5','AGE_6_8','AGE_9_10'],  90),
  ('science',        'How things work',   'Simple science and everyday curiosity.',         array['AGE_6_8','AGE_9_10'],           100),
  ('history',        'Long ago',          'People and places from the past.',               array['AGE_9_10'],                     110),
  ('word_play',      'Word play',         'Rhymes, riddles, and new words.',                array['AGE_6_8','AGE_9_10'],           120)
on conflict (key) do nothing;

-- -----------------------------------------------------------------------------

create table child_learning_preferences (
  child_id                uuid        primary key,
  -- How the child likes to be talked to. Bounded enums, not free text.
  session_length          text        not null default 'short',
  storytelling_enabled    boolean     not null default true,
  roleplay_enabled        boolean     not null default false,
  pronunciation_practice  boolean     not null default false,
  -- How much the companion corrects. `gentle` is the default because a
  -- correction-heavy companion is one a small child stops talking to.
  correction_style        text        not null default 'gentle',
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),

  constraint fk_child_learning_preferences_child
    foreign key (child_id) references children (id) on delete cascade,

  constraint ck_clp_session_length check (session_length in ('short', 'medium', 'long')),
  constraint ck_clp_correction_style check (correction_style in ('none', 'gentle', 'active'))
);

create trigger trg_child_learning_preferences_touch
  before update on child_learning_preferences
  for each row execute function app.touch_updated_at();

comment on table child_learning_preferences is
  'S2 — bounded preferences only. No free text: a free-text field about a child eventually contains a school name.';

create table child_learning_topics (
  child_id   uuid        not null,
  topic_key  text        not null,
  created_at timestamptz not null default now(),

  constraint pk_child_learning_topics primary key (child_id, topic_key),
  constraint fk_child_learning_topics_child
    foreign key (child_id) references children (id) on delete cascade,
  constraint fk_child_learning_topics_topic
    foreign key (topic_key) references learning_topics (key) on delete restrict
);

create index idx_child_learning_topics_topic on child_learning_topics (topic_key);

comment on table child_learning_topics is
  'S2 — curated keys only. Replaces the free-text interests column for exactly that reason.';

-- Every child gets preferences at creation, so there is no window in which a
-- child exists without them and something has to invent a default at runtime.
create or replace function app.create_default_learning_preferences()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into child_learning_preferences (child_id) values (new.id)
  on conflict (child_id) do nothing;
  return new;
end;
$$;

create trigger trg_children_default_learning_preferences
  after insert on children
  for each row execute function app.create_default_learning_preferences();

alter table child_learning_preferences enable row level security;
alter table child_learning_preferences force row level security;
alter table child_learning_topics enable row level security;
alter table child_learning_topics force row level security;

create policy clp_select_owner on child_learning_preferences
  for select to authenticated using (app.owns_child(child_id));
create policy clp_insert_owner on child_learning_preferences
  for insert to authenticated with check (app.owns_child(child_id));
create policy clp_update_owner on child_learning_preferences
  for update to authenticated
  using (app.owns_child(child_id)) with check (app.owns_child(child_id));

create policy clt_select_owner on child_learning_topics
  for select to authenticated using (app.owns_child(child_id));
create policy clt_insert_owner on child_learning_topics
  for insert to authenticated with check (app.owns_child(child_id));
create policy clt_delete_owner on child_learning_topics
  for delete to authenticated using (app.owns_child(child_id));

grant select, insert, update on child_learning_preferences to authenticated;
grant select, insert, delete on child_learning_topics to authenticated;

-- -----------------------------------------------------------------------------
-- 5. Consent requirements — the part designed to change
-- -----------------------------------------------------------------------------
-- WHAT consent is required is DATA, not code.
--
-- The legal position is unresolved and will change: verifiable parental consent
-- may need a mechanism we have not built ([Q-08]), Pakistan's regime is moving,
-- and every expansion market adds its own. Encoding "these four consents are
-- required" in application code means every legal update is a deploy, and every
-- jurisdiction is a branch.
--
-- So requirements are rows: consent type, scope, jurisdiction, the minimum
-- policy version that counts, and an effective window. Adding a requirement for
-- one country on one date is an INSERT. The gate function in §6 reads whatever
-- is currently in force.
--
-- THIS DOES NOT MAKE US COMPLIANT. It makes the requirements expressible and
-- auditable. Whether the set is correct is a question for counsel, and a row in
-- this table is not a legal opinion (PRIVACY.md §1).
create table consent_requirements (
  id                 uuid        primary key default app.gen_uuid_v7(),
  consent_type       text        not null,
  -- 'account' — required once per parent.
  -- 'child'   — required per child profile.
  scope              text        not null,
  -- ISO country code, or '*' for everywhere. The most specific match wins.
  jurisdiction       text        not null default '*',
  -- A consent granted against an older policy no longer counts once this rises,
  -- which is how a material policy change forces re-consent.
  min_policy_version text        not null,
  -- Whether conversation is blocked without it. A requirement can exist and be
  -- advisory — recorded, surfaced, but not gating.
  blocks_conversation boolean    not null default true,
  effective_from     timestamptz not null default now(),
  effective_until    timestamptz,
  -- Why this exists, in plain language. Not decoration: when someone asks in two
  -- years why a consent is required, the answer must be in the row.
  rationale          text        not null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  constraint ck_consent_requirements_scope check (scope in ('account', 'child')),
  constraint ck_consent_requirements_type
    check (consent_type in (
      'terms_of_service', 'privacy_policy', 'child_data_processing',
      'transcript_retention', 'audio_retention', 'product_analytics',
      'model_improvement', 'marketing_email')),
  constraint ck_consent_requirements_version
    check (min_policy_version ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  constraint ck_consent_requirements_jurisdiction
    check (jurisdiction = '*' or jurisdiction ~ '^[A-Z]{2}$'),
  constraint ck_consent_requirements_window
    check (effective_until is null or effective_until > effective_from)
);

create unique index uq_consent_requirements_live
  on consent_requirements (consent_type, scope, jurisdiction)
  where effective_until is null;

create index idx_consent_requirements_effective
  on consent_requirements (effective_from, effective_until);

create trigger trg_consent_requirements_touch
  before update on consent_requirements
  for each row execute function app.touch_updated_at();

comment on table consent_requirements is
  'S0 — which consents are required, as data. Changing the legal position is an INSERT, not a deploy. Not a legal opinion.';

alter table consent_requirements enable row level security;
alter table consent_requirements force row level security;

-- Readable by any signed-in session: a parent is entitled to see what is being
-- asked of them and why. Writable only by an admin, and every write is audited.
create policy consent_requirements_select_all on consent_requirements
  for select to authenticated using (true);

create policy consent_requirements_write_admin on consent_requirements
  for all to authenticated
  using (app.current_role() = 'admin') with check (app.current_role() = 'admin');

grant select on consent_requirements to authenticated;
grant insert, update, delete on consent_requirements to authenticated;

insert into consent_requirements
  (consent_type, scope, jurisdiction, min_policy_version, blocks_conversation, rationale)
values
  ('terms_of_service', 'account', '*', '2026-08-01', true,
   'Contractual basis for the service. Required before any account activity.'),
  ('privacy_policy', 'account', '*', '2026-08-01', true,
   'The parent must have been shown what is collected about their child, and when it is deleted.'),
  ('child_data_processing', 'child', '*', '2026-08-01', true,
   'Per-child consent to process that child''s speech and conversation. The parent consents on the child''s behalf; the child cannot (PRIVACY.md §4.1).'),
  ('transcript_retention', 'child', '*', '2026-08-01', false,
   'Advisory, not gating. The core service must work with every optional consent refused, or it is not consent (PRIVACY.md §4.2).'),
  ('product_analytics', 'account', '*', '2026-08-01', false,
   'Advisory, opt-in, off by default.')
on conflict do nothing;

-- -----------------------------------------------------------------------------
-- 6. The gate
-- -----------------------------------------------------------------------------
-- Which required consents a child is missing. Empty means conversation is
-- permitted.
--
-- SECURITY DEFINER because it reads consent_records and parents across the
-- ownership boundary to answer one boolean; the caller learns only the list of
-- missing consent types for a child they already own.
create or replace function app.child_missing_consents(p_child_id uuid)
returns table (consent_type text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with child as (
    select c.id, c.parent_id, p.country_code
    from children c
    join parents p on p.id = c.parent_id
    where c.id = p_child_id
  ),
  required as (
    select distinct on (r.consent_type, r.scope) r.consent_type, r.scope, r.min_policy_version
    from consent_requirements r
    cross join child ch
    where r.blocks_conversation
      and r.effective_from <= now()
      and (r.effective_until is null or r.effective_until > now())
      -- Most specific jurisdiction wins: a country rule overrides the global one.
      and (r.jurisdiction = '*' or r.jurisdiction = ch.country_code)
    order by r.consent_type, r.scope, (r.jurisdiction <> '*') desc, r.effective_from desc
  ),
  granted as (
    select cr.consent_type, cr.child_id, cr.granted, cr.policy_version
    from consent_records cr
    join child ch on ch.parent_id = cr.parent_id
    where cr.id in (
      -- The latest decision per (type, child scope). A withdrawal supersedes an
      -- earlier grant, which is the whole reason the ledger is append-only.
      select distinct on (c2.consent_type, coalesce(c2.child_id, '00000000-0000-0000-0000-000000000000'::uuid))
             c2.id
      from consent_records c2
      join child ch2 on ch2.parent_id = c2.parent_id
      where c2.child_id is null or c2.child_id = ch2.id
      order by c2.consent_type,
               coalesce(c2.child_id, '00000000-0000-0000-0000-000000000000'::uuid),
               c2.recorded_at desc
    )
  )
  select r.consent_type
  from required r
  where not exists (
    select 1 from granted g
    where g.consent_type = r.consent_type
      and g.granted
      -- A consent given against a superseded policy version does not count.
      and g.policy_version >= r.min_policy_version
      and ((r.scope = 'child' and g.child_id = p_child_id)
        or (r.scope = 'account' and g.child_id is null))
  );
$$;

comment on function app.child_missing_consents(uuid) is
  'Required consents this child still lacks. Empty means conversation is permitted.';

create or replace function app.child_conversation_allowed(p_child_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select not exists (select 1 from app.child_missing_consents(p_child_id))
     and exists (
       select 1 from children c
       where c.id = p_child_id and c.deleted_at is null and c.status = 'active'
     );
$$;

comment on function app.child_conversation_allowed(uuid) is
  'The consent gate. Enforced by RLS on conversations, not only by application code.';

-- ENFORCEMENT AT THE DATABASE.
--
-- Replacing the ownership-only insert policy: a conversation cannot be created
-- for a child whose consent state is unsatisfied, whatever the application layer
-- believes. An archived or soft-deleted child is refused by the same policy.
drop policy conversations_insert_owner on conversations;

create policy conversations_insert_consented on conversations
  for insert to authenticated
  with check (app.owns_child(child_id) and app.child_conversation_allowed(child_id));

-- Messages hang off a conversation that could not exist without consent, so the
-- gate does not need repeating there — but a conversation that predates a
-- WITHDRAWAL must stop accepting new messages, which this does.
drop policy messages_insert_owner on messages;

create policy messages_insert_consented on messages
  for insert to authenticated
  with check (app.owns_child(child_id) and app.child_conversation_allowed(child_id));
