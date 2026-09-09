-- =============================================================================
-- Adaptive learning: an extensible event taxonomy, and the rollups over it.
-- =============================================================================
-- Three problems this migration solves.
--
-- 1. `learning_events.event_type` was a CHECK constraint listing six values,
--    which means adding a learning activity is a MIGRATION. The brief asks for
--    an architecture where new activities can be added later, so the taxonomy
--    becomes a reference table and the constraint becomes a foreign key.
--
-- 2. Counting over the raw event log on every dashboard load does not survive
--    contact with a real child's usage, so daily and weekly rollups exist —
--    derived, rebuildable, and never the source of truth.
--
-- 3. "New vocabulary" needs to know which words a child has already used, which
--    means storing words. See §3 for how that is bounded.
--
-- THE RULE THAT GOVERNS THE WHOLE FILE, unchanged from the existing tables it
-- builds on: this measures EXPOSURE AND ACTIVITY. There is no column named
-- `mastery`, `grade`, `percentile`, `delay`, or `risk`, and there never should
-- be. What "learning progress" can honestly claim to measure is open (Q-12) and
-- the commercial pressure to overstate it is structural — parents are the
-- buyers, and a dashboard implying educational outcomes sells better than one
-- reporting engagement.

-- -----------------------------------------------------------------------------
-- 1. The event taxonomy, as data
-- -----------------------------------------------------------------------------
create table learning_event_types (
  event_type   text        primary key,
  display_name text        not null,
  -- Which rollup column this event feeds, if any. NULL means "recorded but not
  -- yet aggregated" — a legitimate state for a new activity whose metric has
  -- not been designed yet, and much better than inventing one.
  metric_key   text,
  -- How the payload contributes: a count of one, or a numeric field summed.
  aggregation  text        not null default 'count',
  payload_field text,
  is_active    boolean     not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint ck_let_event_type check (event_type ~ '^[a-z0-9_]{3,50}$'),
  constraint ck_let_metric_key check (metric_key is null or metric_key ~ '^[a-z0-9_]{3,50}$'),
  constraint ck_let_aggregation check (aggregation in ('count', 'sum', 'average', 'distinct')),
  -- `sum` and `average` need to know WHICH number to read.
  constraint ck_let_field_required
    check (aggregation in ('count', 'distinct') or payload_field is not null)
);

comment on table learning_event_types is
  'S0 — the learning activity taxonomy. A new activity is an INSERT, not a migration.';
comment on column learning_event_types.metric_key is
  'The rollup column this feeds, or NULL for "recorded, not yet aggregated".';

alter table learning_event_types enable row level security;
alter table learning_event_types force row level security;
create policy learning_event_types_select on learning_event_types
  for select to authenticated using (is_active);
grant select on learning_event_types to authenticated;

insert into learning_event_types (event_type, display_name, metric_key, aggregation, payload_field)
values
  -- The six that already existed, preserved exactly.
  ('skill_exposed',      'Skill seen',            null,                   'count',    null),
  ('skill_practised',    'Skill practised',       null,                   'count',    null),
  ('skill_succeeded',    'Skill managed',         null,                   'count',    null),
  ('word_encountered',   'Word used',             'words_used',           'sum',      'count'),
  ('story_completed',    'Story finished',        'stories_completed',    'count',    null),
  ('session_completed',  'Session finished',      'exercises_completed',  'count',    null),
  -- New, and the reason the taxonomy is a table.
  ('conversation_turn',  'Conversation turn',     'conversation_turns',   'count',    null),
  ('conversation_time',  'Time in conversation',  'conversation_seconds', 'sum',      'seconds'),
  ('conversation_ended', 'Conversation finished', 'conversation_count',   'count',    null),
  ('vocabulary_new',     'New word used',         'new_vocabulary',       'count',    null),
  ('pronunciation_scored', 'Pronunciation try',   'pronunciation_score',  'average',  'score')
on conflict (event_type) do nothing;

-- Swap the closed CHECK for a foreign key. The old constraint is what made this
-- table un-extendable; the FK keeps it just as strict about typos.
alter table learning_events drop constraint ck_learning_events_type;
alter table learning_events add constraint fk_learning_events_type
  foreign key (event_type) references learning_event_types (event_type) on delete restrict;

-- Idempotency for the recorder. A retried request must not double-count a
-- child's morning: the same activity, from the same source, on the same day,
-- is one event.
alter table learning_events add column idempotency_key text;

create unique index uq_learning_events_idempotency
  on learning_events (child_id, idempotency_key) where idempotency_key is not null;

comment on column learning_events.idempotency_key is
  'Caller-supplied de-duplication handle. A retried request must not double-count.';

-- -----------------------------------------------------------------------------
-- 2. Curated vocabulary
-- -----------------------------------------------------------------------------
-- "New vocabulary" requires knowing which words a child has already used, which
-- requires storing words. THE BOUND: only words on a curated list are ever
-- recorded.
--
-- That is the difference between "this child has now used 'elephant', which is
-- word 412 on our reviewed list" and a log of everything a child says. The
-- second is a transcript by another name, and it is exactly what the rest of
-- this system refuses to keep (PRIVACY.md §4). The cost is real: a child using a
-- wonderful word that is not on the list gets no credit for it. That is the
-- right trade.
create table vocabulary_words (
  id            uuid        primary key default app.gen_uuid_v7(),
  language_code text        not null default 'en',
  word          text        not null,
  -- Roughly when a word becomes common for a child, used to weight the level.
  -- A soft ordering for a progress ring, NOT an expected age of acquisition and
  -- not a benchmark to compare a child against.
  tier          int         not null default 1,
  topic_key     text,
  is_active     boolean     not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint fk_vocabulary_words_language
    foreign key (language_code) references supported_languages (code) on delete restrict,
  constraint ck_vocabulary_words_word check (char_length(word) between 1 and 60),
  constraint ck_vocabulary_words_tier check (tier between 1 and 5)
);

create unique index uq_vocabulary_words on vocabulary_words (language_code, word);
create index idx_vocabulary_words_active on vocabulary_words (language_code, tier) where is_active;

comment on table vocabulary_words is
  'S0 — the curated word list. Reviewed product content, not child speech.';
comment on column vocabulary_words.tier is
  'A soft ordering for a progress ring. NOT an expected age of acquisition, and never a benchmark.';

alter table vocabulary_words enable row level security;
alter table vocabulary_words force row level security;
create policy vocabulary_words_select on vocabulary_words
  for select to authenticated using (is_active);
grant select on vocabulary_words to authenticated;

create table child_vocabulary (
  id                 uuid        primary key default app.gen_uuid_v7(),
  child_id           uuid        not null,
  vocabulary_word_id uuid        not null,
  times_used         int         not null default 1,
  first_used_at      timestamptz not null default now(),
  last_used_at       timestamptz not null default now(),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  constraint fk_child_vocabulary_child
    foreign key (child_id) references children (id) on delete cascade,
  constraint fk_child_vocabulary_word
    foreign key (vocabulary_word_id) references vocabulary_words (id) on delete cascade,
  constraint ck_child_vocabulary_times check (times_used >= 1),
  constraint ck_child_vocabulary_ordered check (last_used_at >= first_used_at)
);

create unique index uq_child_vocabulary on child_vocabulary (child_id, vocabulary_word_id);
create index idx_child_vocabulary_child on child_vocabulary (child_id, first_used_at desc);

comment on table child_vocabulary is
  'S2 — which CURATED words a child has used. Bounded by vocabulary_words on purpose.';

alter table child_vocabulary enable row level security;
alter table child_vocabulary force row level security;
create policy child_vocabulary_select_own on child_vocabulary
  for select to authenticated using (app.owns_child(child_id));
grant select on child_vocabulary to authenticated;

-- -----------------------------------------------------------------------------
-- 3. Daily and weekly rollups
-- -----------------------------------------------------------------------------
-- DERIVED AND REBUILDABLE. `learning_events` is the source of truth; these are a
-- cache with a schedule. Every column here can be recomputed from the log, which
-- is what makes it safe to change how a metric is defined later.
create table learning_daily (
  id                     uuid        primary key default app.gen_uuid_v7(),
  child_id               uuid        not null,
  day                    date        not null,
  conversation_seconds   int         not null default 0,
  conversation_turns     int         not null default 0,
  conversation_count     int         not null default 0,
  words_used             int         not null default 0,
  new_vocabulary         int         not null default 0,
  stories_completed      int         not null default 0,
  exercises_completed    int         not null default 0,
  -- Sum and count rather than a stored average, so a week can be aggregated
  -- from days without averaging averages.
  pronunciation_score_sum   real     not null default 0,
  pronunciation_score_count int      not null default 0,
  computed_at            timestamptz not null default now(),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),

  constraint fk_learning_daily_child
    foreign key (child_id) references children (id) on delete cascade,
  constraint ck_learning_daily_nonnegative
    check (conversation_seconds >= 0 and conversation_turns >= 0 and conversation_count >= 0
           and words_used >= 0 and new_vocabulary >= 0 and stories_completed >= 0
           and exercises_completed >= 0 and pronunciation_score_sum >= 0
           and pronunciation_score_count >= 0),
  constraint ck_learning_daily_new_vocab_within_words
    check (new_vocabulary <= words_used)
);

create unique index uq_learning_daily on learning_daily (child_id, day);
create index idx_learning_daily_day on learning_daily (child_id, day desc);

comment on table learning_daily is
  'S2 — a day of activity, derived from learning_events. Rebuildable; never the source of truth.';

alter table learning_daily enable row level security;
alter table learning_daily force row level security;
create policy learning_daily_select_own on learning_daily
  for select to authenticated using (app.owns_child(child_id));
grant select on learning_daily to authenticated;

create table learning_weekly (
  id                     uuid        primary key default app.gen_uuid_v7(),
  child_id               uuid        not null,
  -- The MONDAY of the week, in UTC. Stored rather than computed so a query does
  -- not have to agree with the aggregator about where a week starts.
  week_start             date        not null,
  active_days            int         not null default 0,
  conversation_seconds   int         not null default 0,
  conversation_turns     int         not null default 0,
  conversation_count     int         not null default 0,
  words_used             int         not null default 0,
  new_vocabulary         int         not null default 0,
  stories_completed      int         not null default 0,
  exercises_completed    int         not null default 0,
  pronunciation_score_sum   real     not null default 0,
  pronunciation_score_count int      not null default 0,
  computed_at            timestamptz not null default now(),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),

  constraint fk_learning_weekly_child
    foreign key (child_id) references children (id) on delete cascade,
  constraint ck_learning_weekly_active_days check (active_days between 0 and 7),
  constraint ck_learning_weekly_nonnegative
    check (conversation_seconds >= 0 and conversation_turns >= 0 and conversation_count >= 0
           and words_used >= 0 and new_vocabulary >= 0 and stories_completed >= 0
           and exercises_completed >= 0 and pronunciation_score_sum >= 0
           and pronunciation_score_count >= 0)
);

create unique index uq_learning_weekly on learning_weekly (child_id, week_start);

comment on table learning_weekly is
  'S2 — a week of activity, derived from learning_daily. Rebuildable.';

alter table learning_weekly enable row level security;
alter table learning_weekly force row level security;
create policy learning_weekly_select_own on learning_weekly
  for select to authenticated using (app.owns_child(child_id));
grant select on learning_weekly to authenticated;

create trigger trg_learning_daily_touch before update on learning_daily
  for each row execute function app.touch_updated_at();
create trigger trg_learning_weekly_touch before update on learning_weekly
  for each row execute function app.touch_updated_at();
create trigger trg_child_vocabulary_touch before update on child_vocabulary
  for each row execute function app.touch_updated_at();
create trigger trg_vocabulary_words_touch before update on vocabulary_words
  for each row execute function app.touch_updated_at();
create trigger trg_learning_event_types_touch before update on learning_event_types
  for each row execute function app.touch_updated_at();

-- -----------------------------------------------------------------------------
-- 4. Levels
-- -----------------------------------------------------------------------------
-- Three bands per dimension, and the naming is deliberate: `getting_started`,
-- `growing`, `confident`. Not 1-5, not a percentage, not a grade.
--
-- A NUMBER INVITES COMPARISON. "Level 3 of 5" makes a parent ask what level
-- other children are, and this system has no answer to that question and must
-- not appear to. A word describes where this child is with no scale behind it.
create table learning_skill_levels (
  id                       uuid        primary key default app.gen_uuid_v7(),
  child_id                 uuid        not null,
  vocabulary_level         text        not null default 'getting_started',
  pronunciation_level      text        not null default 'getting_started',
  conversation_skill_level text        not null default 'getting_started',
  -- What the level was computed from, for the "why does it say this?" question.
  basis                    jsonb       not null default '{}'::jsonb,
  computed_at              timestamptz not null default now(),
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),

  constraint fk_learning_skill_levels_child
    foreign key (child_id) references children (id) on delete cascade,
  constraint ck_lsl_vocabulary
    check (vocabulary_level in ('getting_started', 'growing', 'confident')),
  constraint ck_lsl_pronunciation
    check (pronunciation_level in ('getting_started', 'growing', 'confident')),
  constraint ck_lsl_conversation
    check (conversation_skill_level in ('getting_started', 'growing', 'confident')),
  constraint ck_lsl_basis_bounded check (pg_column_size(basis) <= 2048)
);

create unique index uq_learning_skill_levels on learning_skill_levels (child_id);

comment on table learning_skill_levels is
  'S2 — three descriptive bands. Deliberately words rather than numbers: a number invites '
  'a comparison this system cannot make and must not imply.';

alter table learning_skill_levels enable row level security;
alter table learning_skill_levels force row level security;
create policy learning_skill_levels_select_own on learning_skill_levels
  for select to authenticated using (app.owns_child(child_id));
grant select on learning_skill_levels to authenticated;

create trigger trg_learning_skill_levels_touch before update on learning_skill_levels
  for each row execute function app.touch_updated_at();

-- -----------------------------------------------------------------------------
-- 5. Milestones
-- -----------------------------------------------------------------------------
-- Things a child DID, celebrated once. Not stages a child should reach by an
-- age — this table records history, it does not set expectations.
create table learning_milestones (
  id            uuid        primary key default app.gen_uuid_v7(),
  child_id      uuid        not null,
  milestone_key text        not null,
  title         text        not null,
  achieved_at   timestamptz not null default now(),
  created_at    timestamptz not null default now(),

  constraint fk_learning_milestones_child
    foreign key (child_id) references children (id) on delete cascade,
  constraint ck_learning_milestones_key check (milestone_key ~ '^[a-z0-9_]{3,60}$')
);

create unique index uq_learning_milestones on learning_milestones (child_id, milestone_key);
create index idx_learning_milestones_child on learning_milestones (child_id, achieved_at desc);

comment on table learning_milestones is
  'S2 — things a child did. NOT stages a child is expected to reach by an age.';

alter table learning_milestones enable row level security;
alter table learning_milestones force row level security;
create policy learning_milestones_select_own on learning_milestones
  for select to authenticated using (app.owns_child(child_id));
grant select on learning_milestones to authenticated;

-- -----------------------------------------------------------------------------
-- 6. Aggregation
-- -----------------------------------------------------------------------------
-- Rebuilds one day for one child from the event log. Idempotent by construction:
-- it recomputes from scratch rather than incrementing, so running it twice, or
-- after a backfill, gives the same answer.
create or replace function app.rebuild_learning_daily(p_child_id uuid, p_day date)
returns void
language sql
volatile
security definer
set search_path = public, pg_temp
as $$
  insert into learning_daily as d (
    child_id, day, conversation_seconds, conversation_turns, conversation_count,
    words_used, new_vocabulary, stories_completed, exercises_completed,
    pronunciation_score_sum, pronunciation_score_count, computed_at
  )
  select
    p_child_id,
    p_day,
    coalesce(sum(case when e.event_type = 'conversation_time'
                      then greatest(0, (e.payload->>'seconds')::int) end), 0),
    count(*) filter (where e.event_type = 'conversation_turn'),
    count(*) filter (where e.event_type = 'conversation_ended'),
    coalesce(sum(case when e.event_type = 'word_encountered'
                      then greatest(0, coalesce((e.payload->>'count')::int, 1)) end), 0),
    count(*) filter (where e.event_type = 'vocabulary_new'),
    count(*) filter (where e.event_type = 'story_completed'),
    count(*) filter (where e.event_type = 'session_completed'),
    coalesce(sum(case when e.event_type = 'pronunciation_scored'
                      then greatest(0, least(1, (e.payload->>'score')::real)) end), 0),
    count(*) filter (where e.event_type = 'pronunciation_scored'),
    now()
  from learning_events e
  where e.child_id = p_child_id
    and (e.occurred_at at time zone 'utc')::date = p_day
  on conflict (child_id, day) do update
    set conversation_seconds      = excluded.conversation_seconds,
        conversation_turns        = excluded.conversation_turns,
        conversation_count        = excluded.conversation_count,
        words_used                = greatest(excluded.words_used, excluded.new_vocabulary),
        new_vocabulary            = excluded.new_vocabulary,
        stories_completed         = excluded.stories_completed,
        exercises_completed       = excluded.exercises_completed,
        pronunciation_score_sum   = excluded.pronunciation_score_sum,
        pronunciation_score_count = excluded.pronunciation_score_count,
        computed_at               = now(),
        updated_at                = now();
$$;

comment on function app.rebuild_learning_daily(uuid, date) is
  'Recomputes one day from learning_events. Idempotent: recomputes rather than increments.';

-- Rebuilds one week from the daily rows. Weeks start MONDAY, in UTC.
create or replace function app.rebuild_learning_weekly(p_child_id uuid, p_week_start date)
returns void
language sql
volatile
security definer
set search_path = public, pg_temp
as $$
  insert into learning_weekly as w (
    child_id, week_start, active_days, conversation_seconds, conversation_turns,
    conversation_count, words_used, new_vocabulary, stories_completed,
    exercises_completed, pronunciation_score_sum, pronunciation_score_count, computed_at
  )
  select
    p_child_id,
    p_week_start,
    -- A day counts as active only if something actually happened on it. A row
    -- of zeroes is not a day of practice.
    count(*) filter (where d.conversation_turns + d.words_used + d.stories_completed
                           + d.exercises_completed + d.pronunciation_score_count > 0),
    coalesce(sum(d.conversation_seconds), 0),
    coalesce(sum(d.conversation_turns), 0),
    coalesce(sum(d.conversation_count), 0),
    coalesce(sum(d.words_used), 0),
    coalesce(sum(d.new_vocabulary), 0),
    coalesce(sum(d.stories_completed), 0),
    coalesce(sum(d.exercises_completed), 0),
    coalesce(sum(d.pronunciation_score_sum), 0),
    coalesce(sum(d.pronunciation_score_count), 0),
    now()
  from learning_daily d
  where d.child_id = p_child_id
    and d.day >= p_week_start
    and d.day < p_week_start + 7
  on conflict (child_id, week_start) do update
    set active_days               = excluded.active_days,
        conversation_seconds      = excluded.conversation_seconds,
        conversation_turns        = excluded.conversation_turns,
        conversation_count        = excluded.conversation_count,
        words_used                = excluded.words_used,
        new_vocabulary            = excluded.new_vocabulary,
        stories_completed         = excluded.stories_completed,
        exercises_completed       = excluded.exercises_completed,
        pronunciation_score_sum   = excluded.pronunciation_score_sum,
        pronunciation_score_count = excluded.pronunciation_score_count,
        computed_at               = now(),
        updated_at                = now();
$$;

/** The Monday of the week containing a date, in UTC. One definition, everywhere. */
create or replace function app.week_start(p_day date)
returns date
language sql
immutable
as $$
  select p_day - ((extract(isodow from p_day)::int - 1));
$$;

-- Records a curated word and says whether it was NEW for this child. The
-- "was it new?" answer is what the caller turns into a `vocabulary_new` event,
-- and doing it here means the check and the write cannot race apart.
create or replace function app.record_vocabulary_use(
  p_child_id uuid,
  p_language text,
  p_word     text
)
returns boolean
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_word_id uuid;
  v_is_new  boolean;
begin
  select id into v_word_id from vocabulary_words
   where language_code = p_language and word = lower(p_word) and is_active;

  -- A word that is not on the curated list is NOT recorded. That is the bound
  -- that keeps this from becoming a transcript.
  if v_word_id is null then
    return false;
  end if;

  insert into child_vocabulary (child_id, vocabulary_word_id)
  values (p_child_id, v_word_id)
  on conflict (child_id, vocabulary_word_id) do update
    set times_used   = child_vocabulary.times_used + 1,
        last_used_at = now(),
        updated_at   = now()
  returning (times_used = 1) into v_is_new;

  return coalesce(v_is_new, false);
end;
$$;

comment on function app.record_vocabulary_use(uuid, text, text) is
  'Records a CURATED word. Returns true the first time. Words off the list are ignored.';

-- -----------------------------------------------------------------------------
-- 7. Seed
-- -----------------------------------------------------------------------------
insert into vocabulary_words (language_code, word, tier, topic_key)
values
  ('en', 'cat', 1, 'animals'), ('en', 'dog', 1, 'animals'), ('en', 'sun', 1, 'nature'),
  ('en', 'red', 1, 'colours'), ('en', 'blue', 1, 'colours'), ('en', 'happy', 1, 'feelings'),
  ('en', 'rabbit', 2, 'animals'), ('en', 'garden', 2, 'nature'), ('en', 'butterfly', 2, 'animals'),
  ('en', 'purple', 2, 'colours'), ('en', 'excited', 2, 'feelings'), ('en', 'rocket', 2, 'science'),
  ('en', 'elephant', 3, 'animals'), ('en', 'mountain', 3, 'nature'), ('en', 'curious', 3, 'feelings'),
  ('en', 'planet', 3, 'science'), ('en', 'volcano', 4, 'science'), ('en', 'enormous', 4, 'describing'),
  ('en', 'delighted', 4, 'feelings'), ('en', 'magnificent', 5, 'describing')
on conflict (language_code, word) do nothing;
