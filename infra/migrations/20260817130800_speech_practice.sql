-- =============================================================================
-- speech_practice, pronunciation_results
-- =============================================================================
-- THE DEFINING PROPERTY OF THESE TABLES IS WHAT THEY DO NOT CONTAIN.
--
-- There is no audio column and no pointer to one, in either table. Practice
-- keeps the SCORE and discards the RECORDING (docs/adr/0006). A child's voice is
-- biometric-adjacent, permanently identifying, unchangeable, and increasingly
-- sufficient to clone their speech. A corpus of children repeating target
-- phrases is the worst dataset this product could accumulate — and pronunciation
-- practice is precisely the feature that would accumulate it.
--
-- A migration adding an audio column here requires a superseding ADR, not a
-- schema change. `schema.test.ts` fails the build if one appears.

create table speech_practice (
  id             uuid        primary key default app.gen_uuid_v7(),
  child_id       uuid        not null,
  language_code  text        not null default 'en',
  -- Which curated exercise this session worked through.
  exercise_key   text        not null,
  status         text        not null default 'in_progress',
  -- Rollups over the child's pronunciation_results for this session.
  attempt_count  int         not null default 0,
  average_score  real,
  started_at     timestamptz not null default now(),
  completed_at   timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint fk_speech_practice_child
    foreign key (child_id) references children (id) on delete cascade,
  constraint fk_speech_practice_language
    foreign key (language_code) references supported_languages (code) on delete restrict,

  constraint ck_speech_practice_status
    check (status in ('in_progress', 'completed', 'abandoned')),
  constraint ck_speech_practice_exercise_key check (exercise_key ~ '^[a-z0-9_]+\.[a-z0-9_]+$'),
  constraint ck_speech_practice_average_score
    check (average_score is null or average_score between 0 and 1),
  constraint ck_speech_practice_completed_after_started
    check (completed_at is null or completed_at >= started_at),
  constraint ck_speech_practice_completed_has_timestamp
    check (status <> 'completed' or completed_at is not null)
);

create index idx_speech_practice_child_started on speech_practice (child_id, started_at desc);
create index idx_speech_practice_exercise on speech_practice (child_id, exercise_key, started_at desc);

create trigger trg_speech_practice_touch
  before update on speech_practice
  for each row execute function app.touch_updated_at();

comment on table speech_practice is
  'S2 — a pronunciation practice session. NO AUDIO IS STORED, by design.';

-- -----------------------------------------------------------------------------

create table pronunciation_results (
  id                uuid        primary key default app.gen_uuid_v7(),
  speech_practice_id uuid       not null,
  -- Denormalised for RLS and retention, derived by trigger.
  child_id          uuid        not null,
  -- What the child was asked to say. Curated product content, not child speech,
  -- so it is safe in the clear.
  target_text       text        not null,
  sequence          int         not null,
  attempt_number    int         not null default 1,

  -- Scores only.
  overall_score     real        not null,
  -- Per-phoneme or per-word detail, e.g. {"th": 0.4, "cat": 0.9}. Derived signal
  -- about the attempt, never a transcript of what was said.
  phoneme_scores    jsonb       not null default '{}'::jsonb,
  is_correct        boolean     not null default false,
  duration_ms       int,

  created_at        timestamptz not null default now(),

  constraint fk_pronunciation_results_practice
    foreign key (speech_practice_id) references speech_practice (id) on delete cascade,
  constraint fk_pronunciation_results_child
    foreign key (child_id) references children (id) on delete cascade,

  constraint ck_pr_overall_score check (overall_score between 0 and 1),
  constraint ck_pr_attempt_number check (attempt_number >= 1),
  constraint ck_pr_sequence check (sequence >= 0),
  constraint ck_pr_target_text_length check (char_length(target_text) between 1 and 200)
);

create unique index uq_pronunciation_results_attempt
  on pronunciation_results (speech_practice_id, sequence, attempt_number);
create index idx_pronunciation_results_child_created
  on pronunciation_results (child_id, created_at desc);
-- Progress on one target over time: "is this child improving on 'th' sounds?"
create index idx_pronunciation_results_child_target
  on pronunciation_results (child_id, target_text, created_at desc);

comment on table pronunciation_results is
  'S2 — per-attempt scores. NO AUDIO. Whether this needs a specialised model is open: Q-06.';
comment on column pronunciation_results.target_text is
  'S0 — curated product content, not child speech.';

create or replace function app.set_pronunciation_child_id()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  select sp.child_id into new.child_id from speech_practice sp where sp.id = new.speech_practice_id;
  if new.child_id is null then
    raise exception 'speech_practice % does not exist', new.speech_practice_id
      using errcode = 'foreign_key_violation';
  end if;
  return new;
end;
$$;

create trigger trg_pronunciation_results_set_child_id
  before insert on pronunciation_results
  for each row execute function app.set_pronunciation_child_id();

-- -----------------------------------------------------------------------------
-- RLS
-- -----------------------------------------------------------------------------
alter table speech_practice enable row level security;
alter table speech_practice force row level security;

create policy speech_practice_select_owner on speech_practice
  for select to authenticated using (app.owns_child(child_id));
create policy speech_practice_insert_owner on speech_practice
  for insert to authenticated with check (app.owns_child(child_id));
create policy speech_practice_update_owner on speech_practice
  for update to authenticated
  using (app.owns_child(child_id)) with check (app.owns_child(child_id));
create policy speech_practice_delete_owner on speech_practice
  for delete to authenticated using (app.owns_child(child_id));

alter table pronunciation_results enable row level security;
alter table pronunciation_results force row level security;

create policy pronunciation_results_select_owner on pronunciation_results
  for select to authenticated using (app.owns_child(child_id));
create policy pronunciation_results_insert_owner on pronunciation_results
  for insert to authenticated with check (app.owns_child(child_id));
create policy pronunciation_results_delete_owner on pronunciation_results
  for delete to authenticated using (app.owns_child(child_id));

grant select, insert, update, delete on speech_practice to authenticated;
grant select, insert, delete on pronunciation_results to authenticated;
