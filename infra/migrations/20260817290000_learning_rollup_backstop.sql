-- =============================================================================
-- Learning rollups: the backstop for conversations nobody ends
-- =============================================================================
--
-- The dashboard reads `learning_daily`, never `learning_events` directly, so an
-- event that has not been rolled up is invisible to a parent. Rollups are
-- rebuilt when a conversation is explicitly ended.
--
-- THE PROBLEM WITH RELYING ON THAT: a five-year-old does not end conversations.
-- The app gets closed, the tablet gets taken away, the battery dies. Those turns
-- are recorded correctly and would sit in `learning_events` forever, with the
-- parent seeing zero — which is the exact failure this whole change set exists
-- to fix, arriving through a different door.
--
-- So the worker sweeps for days whose events are newer than their rollup and
-- rebuilds them. `rebuild_learning_daily` recomputes rather than increments, so
-- rebuilding a day that did not need it is a wasted query and nothing worse —
-- and two workers racing on the same day both write the same answer.
-- =============================================================================

create or replace function app.learning_days_awaiting_rebuild(
  p_limit int default 200,
  p_within interval default interval '7 days'
)
returns table (child_id uuid, day date)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select e.child_id,
         (e.occurred_at at time zone 'utc')::date as day
    from learning_events e
    left join learning_daily d
      on d.child_id = e.child_id
     and d.day = (e.occurred_at at time zone 'utc')::date
   -- Bounded by the index on occurred_at. A day older than the window that
   -- somehow never rolled up stays stale; that is a deliberate trade against an
   -- unbounded scan, and the window is far wider than any plausible outage.
   where e.occurred_at > now() - p_within
   group by e.child_id, (e.occurred_at at time zone 'utc')::date, d.computed_at
  having d.computed_at is null
      or max(e.created_at) > d.computed_at
   order by 2 desc
   limit p_limit;
$$;

comment on function app.learning_days_awaiting_rebuild(int, interval) is
  'Days with learning events newer than their rollup. The worker backstop for conversations that were never explicitly ended.';

revoke all on function app.learning_days_awaiting_rebuild(int, interval) from public;
