-- =============================================================================
-- Pronunciation practice: curated content, richer results, and achievements.
-- =============================================================================
-- The existing `speech_practice` and `pronunciation_results` tables already hold
-- the shape of a session and an attempt. What they were missing is everything
-- needed to answer "how was this score produced, and how much should anyone
-- trust it?" — which for a feature that scores a child's speech is not a nice
-- to have.
--
-- THE RULE THAT GOVERNS THIS WHOLE MIGRATION: this is educational practice, not
-- assessment. No column here is named `level`, `grade`, `mastery`, `delay`, or
-- `disorder`, and none ever should be. A score is feedback on one attempt at one
-- word; it is not a measurement of a child (docs/CHILD_SAFETY.md §2, ADR-0006).
--
-- AND STILL NO AUDIO. Practice keeps the score and discards the recording. A
-- corpus of children repeating target phrases is the single worst dataset this
-- product could accumulate, and pronunciation practice is exactly the feature
-- that would accumulate it.

-- -----------------------------------------------------------------------------
-- 1. Curated practice content
-- -----------------------------------------------------------------------------
-- Exercises are DATA, so adding "words with the 'th' sound" is an insert rather
-- than a release, and so a speech-and-language professional reviewing the
-- content does not need to read TypeScript to do it.
create table practice_exercises (
  id             uuid        primary key default app.gen_uuid_v7(),
  exercise_key   text        not null,
  language_code  text        not null default 'en',
  title          text        not null,
  -- What the child is practising, as a stable taxonomy key that joins to
  -- learning_progress.skill_key.
  skill_key      text        not null,
  kind           text        not null,
  age_groups     text[]      not null default array['AGE_3_5', 'AGE_6_8', 'AGE_9_10'],
  sort_order     int         not null default 100,
  is_active      boolean     not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint fk_practice_exercises_language
    foreign key (language_code) references supported_languages (code) on delete restrict,
  constraint ck_practice_exercises_key check (exercise_key ~ '^[a-z0-9_]+\.[a-z0-9_]+$'),
  constraint ck_practice_exercises_skill check (skill_key ~ '^[a-z0-9_]+\.[a-z0-9_]+$'),
  constraint ck_practice_exercises_kind check (kind in ('word', 'syllable')),
  constraint ck_practice_exercises_age_groups
    check (age_groups <@ array['AGE_3_5', 'AGE_6_8', 'AGE_9_10']
           and cardinality(age_groups) >= 1)
);

create unique index uq_practice_exercises_key on practice_exercises (exercise_key);
create index idx_practice_exercises_active on practice_exercises (language_code, sort_order)
  where is_active;

create trigger trg_practice_exercises_touch
  before update on practice_exercises
  for each row execute function app.touch_updated_at();

comment on table practice_exercises is
  'S0 — curated practice content. No personal data. Reviewed product content, not user input.';

alter table practice_exercises enable row level security;
alter table practice_exercises force row level security;
create policy practice_exercises_select_active on practice_exercises
  for select to authenticated using (is_active);
grant select on practice_exercises to authenticated;

-- The individual words in an exercise.
create table practice_targets (
  id           uuid        primary key default app.gen_uuid_v7(),
  exercise_id  uuid        not null,
  sequence     int         not null,
  text         text        not null,
  -- The syllable split, for syllable practice and for per-part feedback.
  -- CURATED, not derived: automatic syllabification is wrong often enough that
  -- a child would be told they mispronounced a syllable that does not exist.
  syllables    text[]      not null default array[]::text[],
  -- The expected pronunciation, in whatever notation the content author used.
  -- NULLABLE AND MEANINGFUL WHEN NULL: absent means nobody has supplied one, and
  -- the scorer must not invent it. See services/practice/src/scoring.ts.
  expected_ipa text,
  hint         text,
  created_at   timestamptz not null default now(),

  constraint fk_practice_targets_exercise
    foreign key (exercise_id) references practice_exercises (id) on delete cascade,
  constraint ck_practice_targets_sequence check (sequence >= 0),
  constraint ck_practice_targets_text check (char_length(text) between 1 and 100)
);

create unique index uq_practice_targets_sequence on practice_targets (exercise_id, sequence);

comment on column practice_targets.expected_ipa is
  'Curated phonetic transcription, or NULL. NULL means unknown — never guess one.';
comment on column practice_targets.syllables is
  'Curated syllable split. Automatic syllabification is wrong often enough to be unkind.';

alter table practice_targets enable row level security;
alter table practice_targets force row level security;
create policy practice_targets_select_all on practice_targets
  for select to authenticated using (true);
grant select on practice_targets to authenticated;

-- -----------------------------------------------------------------------------
-- 2. What a result has to record
-- -----------------------------------------------------------------------------
-- A score with no provenance is a number nobody can defend. Every result now
-- carries the language, the confidence, and enough provider metadata to answer
-- "which model produced this, and could it even see phonemes?".
alter table pronunciation_results add column language_code text not null default 'en';
alter table pronunciation_results add column exercise_key text;
alter table pronunciation_results add column confidence real not null default 0;
-- HOW the score was produced. The difference between these is the difference
-- between "the /θ/ was weak" and "that did not sound like the word" — and a
-- product that shows the first when it only knows the second is lying.
alter table pronunciation_results add column analysis_method text not null default 'transcript_similarity';
alter table pronunciation_results add column phoneme_data_available boolean not null default false;
alter table pronunciation_results add column provider text;
alter table pronunciation_results add column provider_model text;

alter table pronunciation_results add constraint fk_pronunciation_results_language
  foreign key (language_code) references supported_languages (code) on delete restrict;

alter table pronunciation_results add constraint ck_pr_confidence
  check (confidence between 0 and 1);

alter table pronunciation_results add constraint ck_pr_analysis_method
  check (analysis_method in ('phoneme_alignment', 'word_alignment', 'transcript_similarity'));

-- THE INVARIANT THAT MATTERS MOST IN THIS FILE.
--
-- Phoneme detail may only be present when a provider actually produced phoneme
-- data. Without this, a well-meaning change that back-fills plausible-looking
-- phoneme scores from a transcript would be invisible — and a child would be
-- told their /r/ needs work on the basis of a number somebody made up.
alter table pronunciation_results add constraint ck_pr_phonemes_need_provider_data
  check (phoneme_data_available or phoneme_scores = '{}'::jsonb);

alter table pronunciation_results add constraint ck_pr_method_matches_availability
  check ((analysis_method = 'phoneme_alignment') = phoneme_data_available);

comment on column pronunciation_results.phoneme_scores is
  'Per-phoneme detail FROM A PROVIDER. Empty unless phoneme_data_available. Never inferred.';
comment on column pronunciation_results.analysis_method is
  'How the score was produced. transcript_similarity is the weakest and most common.';
comment on column pronunciation_results.confidence is
  'The recogniser''s confidence in what it heard. Low confidence on child speech is expected (R-01).';

create index idx_pronunciation_results_exercise
  on pronunciation_results (child_id, exercise_key, created_at desc);

-- -----------------------------------------------------------------------------
-- 3. Achievements
-- -----------------------------------------------------------------------------
-- Rules as data, for the same reason as everything else: an achievement that
-- needs a deploy is an achievement nobody tunes.
--
-- Deliberately about EFFORT rather than ability. "Practised five days in a row"
-- is something a child controls; "scored 90% on /θ/" is not, and a child who
-- cannot yet make a sound should not be locked out of the reward for trying.
create table achievements (
  id            uuid        primary key default app.gen_uuid_v7(),
  achievement_key text      not null,
  title         text        not null,
  description   text        not null,
  icon_key      text        not null default 'star',
  -- What is counted, and how many of it. Kept as two columns rather than a
  -- rules DSL: three rule kinds is not a language.
  rule_kind     text        not null,
  threshold     int         not null,
  is_active     boolean     not null default true,
  sort_order    int         not null default 100,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint ck_achievements_key check (achievement_key ~ '^[a-z0-9_]{2,50}$'),
  constraint ck_achievements_rule_kind
    check (rule_kind in ('attempts_total', 'sessions_completed', 'distinct_days', 'exercises_tried')),
  constraint ck_achievements_threshold check (threshold >= 1)
);

create unique index uq_achievements_key on achievements (achievement_key);

comment on table achievements is
  'S0 — reward rules. About EFFORT, never about ability: a child who cannot yet '
  'make a sound must not be locked out of the reward for trying.';

alter table achievements enable row level security;
alter table achievements force row level security;
create policy achievements_select_active on achievements
  for select to authenticated using (is_active);
grant select on achievements to authenticated;

create table child_achievements (
  id             uuid        primary key default app.gen_uuid_v7(),
  child_id       uuid        not null,
  achievement_id uuid        not null,
  -- The domain fact: when the child earned it. Distinct from `created_at`, which
  -- is when the row was written — the two can differ if an award is ever
  -- backfilled, and the repo requires every table to carry the latter.
  awarded_at     timestamptz not null default now(),
  created_at     timestamptz not null default now(),

  constraint fk_child_achievements_child
    foreign key (child_id) references children (id) on delete cascade,
  constraint fk_child_achievements_achievement
    foreign key (achievement_id) references achievements (id) on delete cascade
);

-- Awarded once. A child seeing the same celebration twice learns it means
-- nothing.
create unique index uq_child_achievements on child_achievements (child_id, achievement_id);
create index idx_child_achievements_child on child_achievements (child_id, awarded_at desc);

comment on table child_achievements is 'S2 — which rewards a child has earned.';

alter table child_achievements enable row level security;
alter table child_achievements force row level security;

create policy child_achievements_select_own on child_achievements
  for select to authenticated using (app.owns_child(child_id));

grant select on child_achievements to authenticated;

-- -----------------------------------------------------------------------------
-- 4. Progress integration
-- -----------------------------------------------------------------------------
-- Practice feeds `learning_progress` through the same counters everything else
-- uses. Note what is counted: EXPOSURE and a coarse success flag. There is no
-- column here that could be shown to a parent as an educational score, and the
-- existing comment on `success_count` says so.
create or replace function app.record_practice_progress(
  p_child_id  uuid,
  p_skill_key text,
  p_success   boolean
)
returns void
language sql
volatile
security definer
set search_path = public, pg_temp
as $$
  insert into learning_progress as lp
    (child_id, skill_key, exposure_count, success_count, first_observed_at, last_observed_at)
  values
    (p_child_id, p_skill_key, 1, case when p_success then 1 else 0 end, now(), now())
  on conflict (child_id, skill_key) do update
    set exposure_count   = lp.exposure_count + 1,
        success_count    = lp.success_count + case when p_success then 1 else 0 end,
        last_observed_at = now(),
        updated_at       = now();
$$;

comment on function app.record_practice_progress(uuid, text, boolean) is
  'Exposure and a coarse success flag. Makes no claim about learning outcomes (Q-12).';

-- The counters the achievement rules read. One function so a rule cannot invent
-- its own definition of "a day of practice".
create or replace function app.practice_counters(p_child_id uuid)
returns table (
  attempts_total     int,
  sessions_completed int,
  distinct_days      int,
  exercises_tried    int
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    (select count(*)::int from pronunciation_results r where r.child_id = p_child_id),
    (select count(*)::int from speech_practice s
      where s.child_id = p_child_id and s.status = 'completed'),
    (select count(distinct (r.created_at at time zone 'utc')::date)::int
       from pronunciation_results r where r.child_id = p_child_id),
    (select count(distinct s.exercise_key)::int from speech_practice s
      where s.child_id = p_child_id);
$$;

-- -----------------------------------------------------------------------------
-- 5. Seed content
-- -----------------------------------------------------------------------------
-- English only, and small. Urdu practice content waits on the same question as
-- Urdu conversation: a recogniser weaker in Urdu than English would score
-- Urdu-speaking children worse for reasons that have nothing to do with them
-- (docs/CHILD_SAFETY.md §9.1, Q-01).
insert into practice_exercises (exercise_key, language_code, title, skill_key, kind, age_groups, sort_order)
values
  ('phonics.s_sounds', 'en', 'Snakes and Stars', 'phonics.s', 'word', array['AGE_3_5', 'AGE_6_8'], 10),
  ('phonics.th_sounds', 'en', 'Thumbs and Thunder', 'phonics.th', 'word', array['AGE_6_8', 'AGE_9_10'], 20),
  ('phonics.r_sounds', 'en', 'Rockets and Rainbows', 'phonics.r', 'word', array['AGE_6_8', 'AGE_9_10'], 30),
  ('syllables.two_part', 'en', 'Clap the Beats', 'syllables.two', 'syllable', array['AGE_3_5', 'AGE_6_8'], 40),
  ('syllables.three_part', 'en', 'Longer Words', 'syllables.three', 'syllable', array['AGE_6_8', 'AGE_9_10'], 50)
on conflict (exercise_key) do nothing;

-- `expected_ipa` is supplied where a content author has actually written one and
-- left NULL where nobody has. NULL is a real answer here — the scorer degrades
-- to a weaker method rather than inventing a transcription.
insert into practice_targets (exercise_id, sequence, text, syllables, expected_ipa, hint)
select e.id, t.sequence, t.text, t.syllables, t.expected_ipa, t.hint
  from practice_exercises e
  join (values
    ('phonics.s_sounds', 0, 'sun',      array['sun'],                'sʌn',      'Long hissy s at the start!'),
    ('phonics.s_sounds', 1, 'star',     array['star'],               'stɑː',     'Keep the s going.'),
    ('phonics.s_sounds', 2, 'snake',    array['snake'],              'sneɪk',    'Ssssss like a snake.'),
    ('phonics.th_sounds', 0, 'thumb',   array['thumb'],              'θʌm',      'Tongue peeking out.'),
    ('phonics.th_sounds', 1, 'thunder', array['thun', 'der'],        'ˈθʌndə',   'Two beats: thun-der.'),
    ('phonics.th_sounds', 2, 'birthday', array['birth', 'day'],      null,       'Two beats: birth-day.'),
    ('phonics.r_sounds', 0, 'rocket',   array['rock', 'et'],         'ˈrɒkɪt',   'Round your lips.'),
    ('phonics.r_sounds', 1, 'rainbow',  array['rain', 'bow'],        null,       'Two beats: rain-bow.'),
    ('syllables.two_part', 0, 'apple',  array['ap', 'ple'],          null,       'Clap twice!'),
    ('syllables.two_part', 1, 'tiger',  array['ti', 'ger'],          null,       'Clap twice!'),
    ('syllables.three_part', 0, 'banana', array['ba', 'na', 'na'],   null,       'Clap three times!'),
    ('syllables.three_part', 1, 'elephant', array['el', 'e', 'phant'], null,     'Clap three times!')
  ) as t (exercise_key, sequence, text, syllables, expected_ipa, hint)
    on t.exercise_key = e.exercise_key
on conflict do nothing;

insert into achievements (achievement_key, title, description, icon_key, rule_kind, threshold, sort_order)
values
  ('first_try',      'First Try',       'You practised a word!',            'star',    'attempts_total',     1,  10),
  ('ten_attempts',   'Good Practice',   'You practised ten times.',         'medal',   'attempts_total',    10,  20),
  ('fifty_attempts', 'Super Practice',  'You practised fifty times!',       'trophy',  'attempts_total',    50,  30),
  ('first_session',  'All Done',        'You finished a whole practice.',   'flag',    'sessions_completed', 1,  40),
  ('five_sessions',  'Five Finishes',   'You finished five practices.',     'rocket',  'sessions_completed', 5,  50),
  ('three_days',     'Three Days',      'You practised on three days.',     'sun',     'distinct_days',      3,  60),
  ('explorer',       'Explorer',        'You tried three different games.', 'compass', 'exercises_tried',    3,  70)
on conflict (achievement_key) do nothing;
