-- =============================================================================
-- learning_progress, learning_events
-- =============================================================================
-- Two tables because they answer different questions: `learning_events` is the
-- append-only record of what happened, `learning_progress` is the rolled-up
-- current state. Keeping both means a progress row can be rebuilt from events
-- if the aggregation is ever found to be wrong — which, for a metric shown to
-- parents, matters more than the disk it costs.
--
-- DELIBERATELY MODEST. What "learning progress" can honestly claim to measure is
-- open (docs/OPEN_QUESTIONS.md Q-12), and the temptation to overstate it is
-- structural: parents are the buyers, and a dashboard implying educational
-- outcomes sells better than one reporting engagement. So there is no column
-- named `mastery`, `level`, or `grade` — only exposure and activity, which are
-- things we can actually observe.

create table learning_progress (
  id                uuid        primary key default app.gen_uuid_v7(),
  child_id          uuid        not null,
  -- A stable key from a curated taxonomy, e.g. 'vocabulary.animals',
  -- 'phonics.th'. Not free text: an open string column becomes an un-analysable
  -- mess within a month.
  skill_key         text        not null,
  exposure_count    int         not null default 0,
  -- Engagement, by a coarse and explicitly-defined rule. Never presented to a
  -- parent as an educational score.
  success_count     int         not null default 0,
  first_observed_at timestamptz not null default now(),
  last_observed_at  timestamptz not null default now(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint fk_learning_progress_child
    foreign key (child_id) references children (id) on delete cascade,

  constraint ck_lp_skill_key check (skill_key ~ '^[a-z0-9_]+\.[a-z0-9_]+$'),
  constraint ck_lp_counts_nonnegative check (exposure_count >= 0 and success_count >= 0),
  constraint ck_lp_success_within_exposure check (success_count <= exposure_count),
  constraint ck_lp_observed_ordered check (last_observed_at >= first_observed_at)
);

create unique index uq_learning_progress_child_skill on learning_progress (child_id, skill_key);
create index idx_learning_progress_child_last on learning_progress (child_id, last_observed_at desc);

create trigger trg_learning_progress_touch
  before update on learning_progress
  for each row execute function app.touch_updated_at();

comment on table learning_progress is
  'S2 — exposure and activity counters, rolled up from learning_events. Makes no claim about learning outcomes (Q-12).';
comment on column learning_progress.success_count is
  'S2 — coarse engagement signal. MUST NOT be presented to a parent as an educational score.';

-- -----------------------------------------------------------------------------

create table learning_events (
  id               uuid        primary key default app.gen_uuid_v7(),
  child_id         uuid        not null,
  event_type       text        not null,
  skill_key        text,
  -- Optional provenance: which conversation or practice session produced this.
  conversation_id  uuid,
  speech_practice_id uuid,
  -- Non-content metadata only: counts, durations, a curated word key. Never a
  -- transcript, never anything the child said verbatim.
  payload          jsonb       not null default '{}'::jsonb,
  occurred_at      timestamptz not null default now(),
  created_at       timestamptz not null default now(),

  constraint fk_learning_events_child
    foreign key (child_id) references children (id) on delete cascade,
  constraint fk_learning_events_conversation
    foreign key (conversation_id) references conversations (id) on delete set null,
  constraint fk_learning_events_practice
    foreign key (speech_practice_id) references speech_practice (id) on delete set null,

  constraint ck_learning_events_type
    check (event_type in (
      'skill_exposed', 'skill_practised', 'skill_succeeded',
      'word_encountered', 'story_completed', 'session_completed')),
  constraint ck_learning_events_skill_key
    check (skill_key is null or skill_key ~ '^[a-z0-9_]+\.[a-z0-9_]+$'),
  -- A bounded payload. An unbounded jsonb column is where transcript text ends
  -- up when someone is in a hurry.
  constraint ck_learning_events_payload_bounded
    check (pg_column_size(payload) <= 2048)
);

create index idx_learning_events_child_occurred on learning_events (child_id, occurred_at desc);
create index idx_learning_events_skill on learning_events (child_id, skill_key, occurred_at desc)
  where skill_key is not null;
create index idx_learning_events_occurred_at on learning_events (occurred_at);

comment on table learning_events is
  'S2 — append-only record of learning activity. Payload is non-content metadata only.';
comment on column learning_events.payload is
  'S2 — counts, durations, curated keys. A transcript here is a defect.';

-- Append-only: raising rather than silently discarding, so an attempt is
-- visible in logs and provable in tests.
create trigger trg_learning_events_append_only
  before update on learning_events
  for each row execute function app.reject_update();

-- -----------------------------------------------------------------------------
-- RLS
-- -----------------------------------------------------------------------------
alter table learning_progress enable row level security;
alter table learning_progress force row level security;

create policy learning_progress_select_owner on learning_progress
  for select to authenticated using (app.owns_child(child_id));
create policy learning_progress_insert_owner on learning_progress
  for insert to authenticated with check (app.owns_child(child_id));
create policy learning_progress_update_owner on learning_progress
  for update to authenticated
  using (app.owns_child(child_id)) with check (app.owns_child(child_id));
create policy learning_progress_delete_owner on learning_progress
  for delete to authenticated using (app.owns_child(child_id));

alter table learning_events enable row level security;
alter table learning_events force row level security;

create policy learning_events_select_owner on learning_events
  for select to authenticated using (app.owns_child(child_id));
create policy learning_events_insert_owner on learning_events
  for insert to authenticated with check (app.owns_child(child_id));

grant select, insert, update, delete on learning_progress to authenticated;
grant select, insert on learning_events to authenticated;
