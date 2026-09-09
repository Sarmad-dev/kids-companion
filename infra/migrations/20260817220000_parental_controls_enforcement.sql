-- =============================================================================
-- Parental controls: the columns the brief asks for, and the SQL that enforces
-- what was already there.
-- =============================================================================
-- THE PROBLEM THIS MIGRATION EXISTS TO FIX: `parental_controls` has held
-- `daily_minute_limit`, `session_minute_limit`, `quiet_hours_*`,
-- `allowed_character_ids`, and `language_lock` since the first schema migration,
-- and NOT ONE OF THEM WAS ENFORCED ANYWHERE. A parent could set a twenty-minute
-- daily limit, see it saved, and their child could talk for four hours.
--
-- A setting a parent can see and the server ignores is worse than no setting at
-- all: it is a promise the product does not keep, and the parent has no way to
-- discover that. So this migration adds the remaining columns AND the functions
-- that make every one of them real, and `apps/api/src/parental-gate.ts` calls
-- them on every path a child can reach.

-- -----------------------------------------------------------------------------
-- 1. The remaining controls
-- -----------------------------------------------------------------------------

-- The content filter. Two levels, both of which sit ON TOP OF the universal
-- safety pipeline rather than replacing any of it — `standard` is not "unsafe",
-- it is the floor every child gets. There is no level that turns safety off.
alter table parental_controls add column content_filter_level text not null default 'standard';

alter table parental_controls add constraint ck_pc_content_filter_level
  check (content_filter_level in ('standard', 'strict'));

comment on column parental_controls.content_filter_level is
  'Sits ON TOP of the universal safety pipeline. `standard` is the floor, not "off".';

-- The allowed schedule. ISO weekday numbers (1 = Monday), empty meaning every
-- day — the same "empty means all" convention `allowed_character_ids` uses.
alter table parental_controls add column allowed_days int[] not null default array[]::int[];

alter table parental_controls add constraint ck_pc_allowed_days
  check (allowed_days <@ array[1, 2, 3, 4, 5, 6, 7] and cardinality(allowed_days) <= 7);

comment on column parental_controls.allowed_days is
  'ISO weekdays a child may use the app. Empty means every day.';

-- Notification preferences, completing the set.
alter table parental_controls add column notify_on_weekly_summary boolean not null default false;
alter table parental_controls add column notify_on_time_limit boolean not null default true;

-- -----------------------------------------------------------------------------
-- 2. Time actually used
-- -----------------------------------------------------------------------------
-- Derived from `conversations` rather than from a counter, because a counter can
-- drift and a parent's time limit is not a thing that may drift. An in-flight
-- conversation counts from when it started, so a child cannot sit just under the
-- limit by never ending a session.
create or replace function app.child_seconds_today(p_child_id uuid)
returns int
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(sum(
    greatest(0, extract(epoch from (coalesce(c.ended_at, now()) - c.started_at))::int)
  ), 0)::int
  from conversations c
  where c.child_id = p_child_id
    and c.started_at >= date_trunc('day', now() at time zone 'utc');
$$;

comment on function app.child_seconds_today(uuid) is
  'Conversation time today, INCLUDING an in-flight session. Derived, so it cannot drift.';

create or replace function app.conversation_seconds(p_conversation_id uuid)
returns int
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (select greatest(0, extract(epoch from (coalesce(c.ended_at, now()) - c.started_at))::int)
       from conversations c where c.id = p_conversation_id),
    0
  );
$$;

-- -----------------------------------------------------------------------------
-- 3. The gate, in one place
-- -----------------------------------------------------------------------------
-- Every input a decision needs, in one round trip, so no caller can accidentally
-- check three of the five things. The DECISION is made in TypeScript
-- (`parental-gate.ts`) where it can be unit-tested against a clock; this
-- function only gathers facts.
create or replace function app.parental_gate_inputs(p_child_id uuid)
returns table (
  is_paused             boolean,
  daily_minute_limit    int,
  session_minute_limit  int,
  quiet_hours_start     time,
  quiet_hours_end       time,
  allowed_days          int[],
  allowed_character_ids uuid[],
  blocked_topics        text[],
  language_lock         text,
  content_filter_level  text,
  seconds_used_today    int
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select pc.is_paused,
         pc.daily_minute_limit,
         pc.session_minute_limit,
         pc.quiet_hours_start,
         pc.quiet_hours_end,
         pc.allowed_days,
         pc.allowed_character_ids,
         pc.blocked_topics,
         pc.language_lock,
         pc.content_filter_level,
         app.child_seconds_today(p_child_id)
    from parental_controls pc
   where pc.child_id = p_child_id;
$$;

comment on function app.parental_gate_inputs(uuid) is
  'Every fact a parental-control decision needs, in one read. The decision itself '
  'lives in apps/api/src/parental-gate.ts so it can be tested against a fixed clock.';

-- -----------------------------------------------------------------------------
-- 4. Notification preferences, readable as one row
-- -----------------------------------------------------------------------------
create or replace function app.notification_preferences(p_child_id uuid)
returns table (
  on_safety_flag     boolean,
  on_daily_summary   boolean,
  on_weekly_summary  boolean,
  on_time_limit      boolean
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select pc.notify_on_safety_flag,
         pc.notify_on_daily_summary,
         pc.notify_on_weekly_summary,
         pc.notify_on_time_limit
    from parental_controls pc
   where pc.child_id = p_child_id;
$$;
