-- =============================================================================
-- The weekly story limit stops being decorative
-- =============================================================================
--
-- `subscription_plans.weekly_story_limit` has existed since the reference data
-- was seeded — 3 on free, null (unlimited) on the paid plans — and NOTHING HAS
-- EVER READ IT. A plan table advertising a limit the server does not enforce is
-- a false claim about the product, and the direction of the error is the
-- expensive one: every free account has had unlimited stories.
--
-- Two things are added here: the limit is carried out of `parent_entitlements`
-- with the rest of the plan, and there is something to count it against.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Stories this week
-- -----------------------------------------------------------------------------
-- ═══════════════════════════════════════════════════════════════════════════
-- WHAT COUNTS AS A STORY AGAINST THE LIMIT
-- ═══════════════════════════════════════════════════════════════════════════
--
-- A story session the child actually spoke in — `message_count > 0`.
--
-- Counting every start would be simpler and would be wrong: a five-year-old
-- opens Story, the app is closed before they say anything, and one of their
-- three stories for the week is gone. They cannot understand that and cannot
-- undo it. A session with no messages in it is not a story by any reading a
-- parent would accept, so it does not count.
--
-- Counting only FINISHED stories would fail in the other direction: a child
-- could start unlimited stories and abandon each one, and the limit would never
-- bind. This counts what the child did, not what they completed.
--
-- The week starts Monday (`date_trunc('week')`), matching the ISO week the
-- learning rollups use, so "this week" means the same thing everywhere.

create or replace function app.child_stories_this_week(
  p_child_id uuid,
  p_now timestamptz default now()
)
returns int
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select count(*)::int
    from conversations c
   where c.child_id = p_child_id
     and c.mode = 'story'
     and c.message_count > 0
     and c.started_at >= date_trunc('week', p_now);
$$;

comment on function app.child_stories_this_week(uuid, timestamptz) is
  'Story sessions the child has spoken in since Monday. A session with no messages is not a story.';

-- -----------------------------------------------------------------------------
-- 2. Carry the limit with the rest of the plan
-- -----------------------------------------------------------------------------
-- Same body as before with one more column. `create or replace` cannot change a
-- function's return type, so the drop is required rather than tidy.

drop function if exists app.parent_entitlements(uuid, timestamptz);

create or replace function app.parent_entitlements(
  p_parent_id uuid,
  p_now timestamptz default now()
)
returns table (
  plan_code                     text,
  tier                          text,
  subscription_status           text,
  daily_turn_limit              int,
  max_conversation_turns        int,
  concurrent_conversation_limit int,
  child_profile_limit           int,
  daily_minute_limit            int,
  voice_enabled                 boolean,
  daily_voice_turn_limit        int,
  -- NULL means unlimited, which is how the paid plans are seeded. A caller that
  -- treats null as zero would take stories away from the people who paid for
  -- them, so every read of this has to say what it does with null.
  weekly_story_limit            int
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with live as (
    select sub.plan_id, sub.status
      from subscriptions sub
     where sub.parent_id = p_parent_id
       and sub.status in ('trialing', 'active', 'grace', 'past_due', 'cancelled')
       and (sub.status <> 'grace' or sub.grace_ends_at > p_now)
       and (sub.status in ('grace', 'past_due')
            or sub.current_period_end is null
            or sub.current_period_end > p_now)
     order by case sub.status
                when 'active'    then 1
                when 'trialing'  then 2
                when 'grace'     then 3
                when 'cancelled' then 4
                else 5
              end
     limit 1
  )
  select p.code,
         p.tier,
         coalesce((select status from live), 'free'),
         p.daily_turn_limit,
         p.max_conversation_turns,
         p.concurrent_conversation_limit,
         p.child_profile_limit,
         p.daily_minute_limit,
         p.voice_enabled,
         p.daily_voice_turn_limit,
         p.weekly_story_limit
    from subscription_plans p
   where p.id = coalesce(
       (select plan_id from live),
       (select id from subscription_plans where code = 'free')
     )
   limit 1;
$$;

comment on function app.parent_entitlements(uuid, timestamptz) is
  'Effective plan limits for a parent. Free when there is no live subscription. Grace counts as live until its window closes.';
