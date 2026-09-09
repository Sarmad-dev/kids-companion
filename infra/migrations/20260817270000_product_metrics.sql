-- =============================================================================
-- Product metrics
-- =============================================================================
-- Activation, completion, retention, conversion, churn, MRR, ARR — computed
-- IN OUR OWN DATABASE, from data we already hold, in aggregate.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- THIS FILE IS THE PRIVACY ARGUMENT FOR THE WHOLE ANALYTICS PHASE.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The ordinary way to answer "what is our retention?" is to stream a per-user
-- event log to a product-analytics vendor and query it there. For a product
-- whose users are five-year-olds, that means a behavioural record of a child —
-- when they are awake, how long they talk, how often they come back —
-- accumulating at a third party under that third party's retention policy.
--
-- So none of it leaves. Every function here returns COUNTS AND RATIOS. Not one
-- returns a row per person, a child identifier, or anything derived from what a
-- child said. A dashboard built on these is a dashboard about the product, not
-- about anybody's child.
--
-- All of them are SECURITY DEFINER and none is granted to `authenticated`: a
-- parent has no business reading aggregate metrics, and an operator reaches
-- them through an authorised endpoint.

-- -----------------------------------------------------------------------------
-- 1. Activation
-- -----------------------------------------------------------------------------
-- The funnel a family walks through in its first session: register, add a
-- child, have a first conversation. Each step is a count, and the ratios are
-- computed by the caller so a zero denominator is the caller's problem rather
-- than a divide-by-zero in SQL.

create or replace function app.activation_funnel(
  p_since timestamptz default now() - interval '30 days',
  p_now   timestamptz default now()
)
returns table (
  registered        int,
  added_a_child     int,
  granted_consent   int,
  first_conversation int,
  first_week_return int
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with cohort as (
    select id, created_at from parents
     where created_at >= p_since and created_at < p_now and deleted_at is null
  ),
  with_child as (
    select distinct c.parent_id from children c join cohort p on p.id = c.parent_id
     where c.deleted_at is null
  ),
  with_consent as (
    select distinct r.parent_id from consent_records r join cohort p on p.id = r.parent_id
     where r.granted and r.consent_type = 'child_data_processing'
  ),
  with_conversation as (
    select distinct ch.parent_id
      from conversations cv
      join children ch on ch.id = cv.child_id
      join cohort p on p.id = ch.parent_id
  ),
  -- Came back at least once after their first day. The simplest honest
  -- definition of "did this land?" and the one least sensitive to a single
  -- long first session.
  returned as (
    select distinct ch.parent_id
      from conversations cv
      join children ch on ch.id = cv.child_id
      join cohort p on p.id = ch.parent_id
     where cv.started_at >= p.created_at + interval '1 day'
       and cv.started_at <  p.created_at + interval '8 days'
  )
  select (select count(*)::int from cohort),
         (select count(*)::int from with_child),
         (select count(*)::int from with_consent),
         (select count(*)::int from with_conversation),
         (select count(*)::int from returned);
$$;

comment on function app.activation_funnel is
  'Counts only. The first-session funnel for a registration cohort.';

-- -----------------------------------------------------------------------------
-- 2. Conversations
-- -----------------------------------------------------------------------------
-- Completion rate and typical length. Note what is absent: no per-child row, no
-- content, and no "engagement score" — a number that would invite someone to
-- optimise how long a child stays in the app, which is the opposite of what
-- this product is for.

create or replace function app.conversation_metrics(
  p_since timestamptz default now() - interval '7 days',
  p_now   timestamptz default now()
)
returns table (
  started            int,
  completed          int,
  ended_by_child     int,
  ended_by_limit     int,
  ended_by_safety    int,
  abandoned          int,
  median_turns       int,
  median_seconds     int,
  p95_seconds        int
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with window_conversations as (
    select cv.id, cv.status, cv.end_reason, cv.message_count, cv.started_at, cv.ended_at,
           extract(epoch from (coalesce(cv.ended_at, p_now) - cv.started_at))::int as seconds
      from conversations cv
     where cv.started_at >= p_since and cv.started_at < p_now
  )
  select count(*)::int,
         count(*) filter (where status = 'ended')::int,
         count(*) filter (where end_reason = 'child_ended')::int,
         count(*) filter (where end_reason in ('turn_limit', 'time_limit'))::int,
         count(*) filter (where end_reason = 'safety_ended')::int,
         -- Abandoned: opened and never closed. A short chat is NOT a failure,
         -- and this is counted rather than judged.
         count(*) filter (where status = 'active' and started_at < p_now - interval '1 hour')::int,
         coalesce(percentile_disc(0.5) within group (order by message_count), 0)::int,
         coalesce(percentile_disc(0.5) within group (order by seconds), 0)::int,
         coalesce(percentile_disc(0.95) within group (order by seconds), 0)::int
    from window_conversations;
$$;

comment on function app.conversation_metrics is
  'Counts and durations only. No per-child rows and nothing derived from content.';

-- -----------------------------------------------------------------------------
-- 3. Feature adoption
-- -----------------------------------------------------------------------------
-- How many ACCOUNTS reached each capability. Account-scoped rather than
-- child-scoped on purpose: "how many families use speech practice?" is a
-- product question, and "which children use speech practice?" is surveillance.

create or replace function app.feature_adoption(
  p_since timestamptz default now() - interval '30 days',
  p_now   timestamptz default now()
)
returns table (feature text, accounts int)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select 'conversations'::text, count(distinct ch.parent_id)::int
    from conversations cv join children ch on ch.id = cv.child_id
   where cv.started_at >= p_since and cv.started_at < p_now
  union all
  select 'voice', count(distinct ch.parent_id)::int
    from messages m
    join conversations cv on cv.id = m.conversation_id
    join children ch on ch.id = cv.child_id
   where m.input_mode = 'voice' and m.created_at >= p_since and m.created_at < p_now
  union all
  select 'speech_practice', count(distinct ch.parent_id)::int
    from speech_practice sp join children ch on ch.id = sp.child_id
   where sp.started_at >= p_since and sp.started_at < p_now
  union all
  select 'parental_controls', count(distinct child_id)::int
    from parental_controls
   where updated_at >= p_since and updated_at < p_now and updated_at > created_at;
$$;

comment on function app.feature_adoption is
  'Distinct ACCOUNTS per capability. Never per child — that would be surveillance, not product analytics.';

-- -----------------------------------------------------------------------------
-- 4. Retention
-- -----------------------------------------------------------------------------
-- Weekly cohort retention, as counts. A classic triangle, computed here so the
-- underlying per-account activity never has to leave the database.

create or replace function app.retention_cohorts(
  p_weeks int default 8,
  p_now   timestamptz default now()
)
returns table (cohort_week date, cohort_size int, week_offset int, retained int)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with cohort as (
    select p.id,
           date_trunc('week', p.created_at)::date as cohort_week
      from parents p
     where p.deleted_at is null
       and p.created_at >= p_now - make_interval(weeks => p_weeks)
  ),
  sizes as (
    select cohort_week, count(*)::int as cohort_size from cohort group by 1
  ),
  activity as (
    select c.cohort_week,
           (extract(epoch from (date_trunc('week', cv.started_at) - c.cohort_week)) / 604800)::int
             as week_offset,
           c.id
      from cohort c
      join children ch on ch.parent_id = c.id
      join conversations cv on cv.child_id = ch.id
     where cv.started_at < p_now
  )
  select s.cohort_week, s.cohort_size, a.week_offset, count(distinct a.id)::int
    from sizes s
    join activity a on a.cohort_week = s.cohort_week
   where a.week_offset >= 0
   group by s.cohort_week, s.cohort_size, a.week_offset
   order by s.cohort_week desc, a.week_offset;
$$;

comment on function app.retention_cohorts is
  'Weekly cohort retention as counts. No account identifiers leave this function.';

-- -----------------------------------------------------------------------------
-- 5. Revenue
-- -----------------------------------------------------------------------------
-- MRR, ARR, conversion, and churn.
--
-- MRR normalises every billing interval to a month: a weekly plan is
-- 52/12 months, a yearly plan is 1/12. Getting that wrong is the classic SaaS
-- reporting error — a yearly plan counted at full price makes MRR jump twelvefold
-- the month it is sold and collapse the month after.
--
-- Amounts are in MINOR UNITS throughout, as everywhere else in this system.

create or replace function app.revenue_metrics(
  p_now timestamptz default now()
)
returns table (
  active_subscriptions int,
  trialing             int,
  in_grace             int,
  mrr_minor            bigint,
  arr_minor            bigint,
  currency             text,
  paying_accounts      int,
  total_accounts       int
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with live as (
    select s.parent_id, s.status, p.price_minor, p.billing_interval, p.currency
      from subscriptions s
      join subscription_plans p on p.id = s.plan_id
     where s.status in ('trialing', 'active', 'grace', 'past_due')
       and (s.status <> 'grace' or s.grace_ends_at > p_now)
       and (s.status in ('grace', 'past_due')
            or s.current_period_end is null
            or s.current_period_end > p_now)
  ),
  normalised as (
    select parent_id,
           status,
           currency,
           case billing_interval
             -- 52 weeks a year, over 12 months.
             when 'week'  then round(price_minor * 52.0 / 12.0)
             when 'month' then price_minor
             when 'year'  then round(price_minor / 12.0)
             else 0
           end as monthly_minor
      from live
     -- A trial contributes nothing until it converts. Counting it as revenue
     -- is how a forecast ends up wrong by the trial-to-paid rate.
     where status <> 'trialing'
  )
  select (select count(*)::int from live where status = 'active'),
         (select count(*)::int from live where status = 'trialing'),
         (select count(*)::int from live where status = 'grace'),
         (select coalesce(sum(monthly_minor), 0)::bigint from normalised),
         (select coalesce(sum(monthly_minor) * 12, 0)::bigint from normalised),
         (select coalesce(min(currency), 'PKR') from live),
         (select count(distinct parent_id)::int from normalised),
         (select count(*)::int from parents where deleted_at is null);
$$;

comment on function app.revenue_metrics is
  'MRR and ARR in minor units, with every billing interval normalised to a month.';

create or replace function app.churn_metrics(
  p_since timestamptz default now() - interval '30 days',
  p_now   timestamptz default now()
)
returns table (
  voluntary_cancellations int,
  involuntary_expiries    int,
  new_subscriptions       int,
  active_at_start         int
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    -- The parent decided.
    (select count(*)::int from subscriptions
      where cancelled_at >= p_since and cancelled_at < p_now),
    -- Payment failed. A different problem with a different remedy, and
    -- conflating the two hides a broken payment rail behind "churn".
    (select count(*)::int from subscriptions
      where status = 'expired' and cancelled_at is null
        and updated_at >= p_since and updated_at < p_now),
    (select count(*)::int from subscriptions
      where created_at >= p_since and created_at < p_now),
    (select count(*)::int from subscriptions
      where created_at < p_since
        and (cancelled_at is null or cancelled_at >= p_since));
$$;

comment on function app.churn_metrics is
  'Voluntary and involuntary churn kept apart: one is a product problem, the other a payments problem.';
