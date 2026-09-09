-- =============================================================================
-- parental_controls — one row per child.
-- =============================================================================
-- Per-child, not per-account: a 4-year-old and a 9-year-old in the same family
-- need different limits, and one shared setting means one child's ceiling
-- governs the other.
--
-- Every default is the conservative option. A parent who never opens the
-- settings screen gets the tightest configuration, not the loosest.

create table parental_controls (
  id                        uuid        primary key default app.gen_uuid_v7(),
  child_id                  uuid        not null,

  -- Time. Session limits exist to END sessions. There is no streak, no loss
  -- framing, and no "your friend misses you" notification anywhere in this
  -- product (docs/CHILD_SAFETY.md rule S-9).
  daily_minute_limit        int         not null default 20,
  session_minute_limit      int         not null default 15,
  quiet_hours_start         time,
  quiet_hours_end           time,

  -- Content scope.
  allowed_character_ids     uuid[]      not null default array[]::uuid[],  -- empty = all active
  blocked_topics            text[]      not null default array[]::text[],
  language_lock             text,

  -- Retention, exposed to the parent (PRIVACY.md §8). Raw audio is absent here
  -- on purpose: it is not a per-child setting because it is never retained.
  transcript_retention_days int         not null default 90,

  -- Oversight.
  notify_on_safety_flag     boolean     not null default true,
  notify_on_daily_summary   boolean     not null default false,
  is_paused                 boolean     not null default false,

  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),

  constraint fk_parental_controls_child
    foreign key (child_id) references children (id) on delete cascade,
  constraint fk_parental_controls_language
    foreign key (language_lock) references supported_languages (code) on delete set null,

  constraint ck_pc_daily_minute_limit check (daily_minute_limit between 0 and 240),
  constraint ck_pc_session_minute_limit check (session_minute_limit between 0 and 120),
  constraint ck_pc_session_within_daily check (session_minute_limit <= daily_minute_limit),
  constraint ck_pc_transcript_retention check (transcript_retention_days between 0 and 365),
  constraint ck_pc_blocked_topics_bounded check (cardinality(blocked_topics) <= 50),
  -- Quiet hours are either both set or both absent; one alone is meaningless.
  constraint ck_pc_quiet_hours_paired
    check ((quiet_hours_start is null) = (quiet_hours_end is null))
);

create unique index uq_parental_controls_child on parental_controls (child_id);

create trigger trg_parental_controls_touch
  before update on parental_controls
  for each row execute function app.touch_updated_at();

comment on table parental_controls is
  'S2 — per-child limits. Every default is the conservative one.';
comment on column parental_controls.transcript_retention_days is
  'S2 — parent-configurable 0..365, default 90. Whether 90 is right is open: Q-11.';

alter table parental_controls enable row level security;
alter table parental_controls force row level security;

create policy parental_controls_select_owner on parental_controls
  for select to authenticated using (app.owns_child(child_id));

create policy parental_controls_insert_owner on parental_controls
  for insert to authenticated with check (app.owns_child(child_id));

create policy parental_controls_update_owner on parental_controls
  for update to authenticated
  using (app.owns_child(child_id))
  with check (app.owns_child(child_id));

-- No DELETE policy: controls are reset, never removed. A child without a
-- controls row would fall back to an implicit default, and implicit defaults in
-- a safety-relevant setting are how limits quietly disappear.
grant select, insert, update on parental_controls to authenticated;

-- -----------------------------------------------------------------------------
-- Guaranteed at profile creation
-- -----------------------------------------------------------------------------
-- There must be no window, however brief, in which a child profile exists
-- without limits.
create or replace function app.create_default_parental_controls()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into parental_controls (child_id) values (new.id)
  on conflict (child_id) do nothing;
  return new;
end;
$$;

create trigger trg_children_default_controls
  after insert on children
  for each row execute function app.create_default_parental_controls();
