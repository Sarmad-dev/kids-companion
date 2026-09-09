-- =============================================================================
-- Subscription lifecycle: plans, checkouts, grace, and event ordering
-- =============================================================================
-- The billing tables already existed. What was missing was the LIFECYCLE: the
-- states a subscription moves through, what moves it, and what stops a replayed
-- or forged message from moving it.
--
-- Three ideas run through this migration.
--
-- 1. PRICE AND POLICY LIVE HERE, NOT IN CODE. Every number a parent is charged,
--    every trial length, every grace window, and every limit is a column on
--    `subscription_plans`. Adding a plan is an INSERT. There is no price
--    literal anywhere in the application, and a test asserts that.
--
-- 2. A CLIENT CANNOT GRANT ITSELF A SUBSCRIPTION. `POST /subscriptions/create`
--    writes a row in `subscription_checkouts` — an INTENT — and nothing else.
--    The subscription itself is created only by the webhook reconciler, from an
--    event whose signature verified. There is no code path from a request body
--    to `subscriptions.status = 'active'`.
--
-- 3. EVENTS ARRIVE MORE THAN ONCE, AND OUT OF ORDER. Idempotency is the unique
--    index on (rail, external_event_id). Ordering is `last_event_at` — a
--    correctly signed but stale event is recorded and then ignored, because a
--    replayed `payment.succeeded` from last month must not extend anything.

-- -----------------------------------------------------------------------------
-- 1. Plans gain a billing week, a trial, and a grace window
-- -----------------------------------------------------------------------------

alter table subscription_plans drop constraint ck_subscription_plans_interval;
alter table subscription_plans add constraint ck_subscription_plans_interval
  check (billing_interval in ('week', 'month', 'year', 'once', 'none'));

-- How long a new subscriber gets before the first charge. 0 means no trial.
alter table subscription_plans add column trial_days int not null default 0;

-- How long access continues after a renewal payment fails.
--
-- NOT a generosity setting. A card expires, a wallet runs dry, a bank declines a
-- foreign transaction — and the person who loses access is a five-year-old
-- mid-story who did none of those things. The window is per plan because a
-- weekly plan cannot carry the same grace as an annual one without the grace
-- being longer than the billing period.
alter table subscription_plans add column grace_days int not null default 0;

alter table subscription_plans add constraint ck_subscription_plans_trial_grace
  check (trial_days >= 0 and trial_days <= 90 and grace_days >= 0 and grace_days <= 30);

-- A grace window longer than the billing period is a free subscription with
-- extra steps: the next renewal would fall due before the previous grace ended.
alter table subscription_plans add constraint ck_subscription_plans_grace_fits_period
  check (billing_interval <> 'week' or grace_days <= 5);

comment on column subscription_plans.trial_days is
  'S0 — days before the first charge. 0 means no trial.';
comment on column subscription_plans.grace_days is
  'S0 — days of continued access after a failed renewal, before expiry.';

-- -----------------------------------------------------------------------------
-- 2. Subscriptions gain grace, trial history, and event ordering
-- -----------------------------------------------------------------------------

alter table subscriptions drop constraint ck_subscriptions_status;
alter table subscriptions add constraint ck_subscriptions_status
  check (status in ('free', 'trialing', 'active', 'grace', 'past_due', 'cancelled', 'expired'));

-- When the grace window closes. The expiry sweep reads this, and so does every
-- entitlement check — a subscription in grace whose window has passed is
-- expired whether or not the sweep has run yet.
alter table subscriptions add column grace_ends_at timestamptz;

-- A trial is once per account, not once per subscription. Without this, cancel
-- and re-subscribe is an unlimited free trial.
alter table subscriptions add column trial_consumed boolean not null default false;

-- The ordering guard. Set from the event's own `occurred_at`, never from our
-- clock, so a redelivery that arrives late cannot look newer than what it
-- follows.
alter table subscriptions add column last_event_at timestamptz;
alter table subscriptions add column last_event_id text;

alter table subscriptions add constraint ck_subscriptions_grace_has_deadline
  check (status <> 'grace' or grace_ends_at is not null);

-- A cancelled subscription must say when it was cancelled. Without this, "did
-- this parent cancel or did we expire them?" is unanswerable, and those two
-- have very different consequences for a refund conversation.
alter table subscriptions add constraint ck_subscriptions_cancelled_has_timestamp
  check (status <> 'cancelled' or cancelled_at is not null);

comment on column subscriptions.grace_ends_at is
  'S1 — end of the post-failure grace window. Null unless status = grace.';
comment on column subscriptions.trial_consumed is
  'S1 — a trial is once per account. Prevents cancel-and-resubscribe looping a free trial.';
comment on column subscriptions.last_event_at is
  'S1 — occurred_at of the newest APPLIED event. Older events are recorded and ignored.';

-- One live subscription per parent, now that grace and past_due are live states
-- too. A parent in grace who starts a second checkout must not end up with two.
drop index if exists uq_subscriptions_one_live_per_parent;
create unique index uq_subscriptions_one_live_per_parent
  on subscriptions (parent_id)
  where status in ('trialing', 'active', 'grace', 'past_due');

drop index if exists idx_subscriptions_period_end;
create index idx_subscriptions_period_end on subscriptions (current_period_end)
  where status in ('trialing', 'active', 'grace', 'past_due');

-- Drives the grace sweep.
create index idx_subscriptions_grace_ends on subscriptions (grace_ends_at)
  where status = 'grace';

-- -----------------------------------------------------------------------------
-- 3. Checkout intents
-- -----------------------------------------------------------------------------
-- What `POST /api/subscriptions/create` actually writes.
--
-- This table is the boundary between "a parent asked to subscribe" and "a
-- parent has a subscription". It is deliberately separate from `subscriptions`
-- so that the request path has nothing to write in the table that grants
-- entitlement — the reconciler is the only writer there.
--
-- A pending checkout grants NOTHING. A parent who starts a checkout and closes
-- the tab is on the free tier, which is exactly right.

create table subscription_checkouts (
  id              uuid        primary key default app.gen_uuid_v7(),
  parent_id       uuid        not null,
  plan_id         uuid        not null,
  rail            text        not null,
  -- The caller's key. Retries on a flaky mobile connection are routine, and a
  -- parent tapping "subscribe" twice must not open two checkouts.
  idempotency_key text        not null,
  -- The vendor's session reference, once it has one. Null while we are still
  -- talking to the rail.
  external_id     text,
  status          text        not null default 'pending',
  expires_at      timestamptz not null,
  completed_at    timestamptz,
  subscription_id uuid,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint fk_subscription_checkouts_parent
    foreign key (parent_id) references parents (id) on delete cascade,
  constraint fk_subscription_checkouts_plan
    foreign key (plan_id) references subscription_plans (id) on delete restrict,
  constraint fk_subscription_checkouts_subscription
    foreign key (subscription_id) references subscriptions (id) on delete set null,

  constraint ck_subscription_checkouts_rail
    check (rail in ('stripe', 'jazzcash', 'easypaisa', 'apple_iap', 'google_play', 'mock')),
  constraint ck_subscription_checkouts_status
    check (status in ('pending', 'completed', 'expired', 'abandoned')),
  constraint ck_subscription_checkouts_completed_has_timestamp
    check (status <> 'completed' or completed_at is not null),
  constraint ck_subscription_checkouts_idempotency_key
    check (length(idempotency_key) between 8 and 128)
);

-- The idempotency guarantee for `create`: the same key from the same parent
-- returns the same checkout instead of opening a second one.
create unique index uq_subscription_checkouts_idempotency
  on subscription_checkouts (parent_id, idempotency_key);

create unique index uq_subscription_checkouts_rail_external
  on subscription_checkouts (rail, external_id) where external_id is not null;

create index idx_subscription_checkouts_parent on subscription_checkouts (parent_id, created_at desc);
create index idx_subscription_checkouts_pending on subscription_checkouts (expires_at)
  where status = 'pending';

create trigger trg_subscription_checkouts_touch
  before update on subscription_checkouts
  for each row execute function app.touch_updated_at();

comment on table subscription_checkouts is
  'S1 — a request to subscribe. Grants nothing. Only a verified webhook creates a subscription.';

alter table subscription_checkouts enable row level security;
alter table subscription_checkouts force row level security;

-- Read-only to the parent who owns it, exactly like `subscriptions`. Every
-- write is a system operation: the request path writes through a SECURITY
-- DEFINER function, and the reconciler writes as the system.
create policy subscription_checkouts_select_owner on subscription_checkouts
  for select to authenticated using (parent_id = app.current_parent_id());

grant select on subscription_checkouts to authenticated;

-- -----------------------------------------------------------------------------
-- 4. Opening a checkout
-- -----------------------------------------------------------------------------
-- SECURITY DEFINER because the request runs as the parent and a parent has no
-- INSERT on this table. The function is the only door, and it can only ever
-- write a row for the caller — `p_parent_id` is checked against the RLS claim
-- rather than trusted from the argument.

create or replace function app.open_checkout(
  p_parent_id       uuid,
  p_plan_code       text,
  p_rail            text,
  p_idempotency_key text,
  p_ttl_minutes     int default 30
)
returns subscription_checkouts
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_plan_id uuid;
  v_row     subscription_checkouts;
begin
  if p_parent_id is distinct from app.current_parent_id() then
    raise exception 'open_checkout may only be called for the current parent'
      using errcode = '42501';
  end if;

  select id into v_plan_id
    from subscription_plans
   where code = p_plan_code and is_active and tier = 'paid'
     and p_rail = any(available_rails);

  if v_plan_id is null then
    raise exception 'plan % is not purchasable on rail %', p_plan_code, p_rail
      using errcode = '23514';
  end if;

  -- The same key returns the same checkout. `do update` rather than `do
  -- nothing` so the row comes back either way; nothing meaningful changes.
  insert into subscription_checkouts
    (parent_id, plan_id, rail, idempotency_key, expires_at)
  values
    (p_parent_id, v_plan_id, p_rail, p_idempotency_key,
     now() + make_interval(mins => p_ttl_minutes))
  on conflict (parent_id, idempotency_key) do update
    set updated_at = now()
  returning * into v_row;

  return v_row;
end;
$$;

comment on function app.open_checkout is
  'Records an intent to subscribe. Grants no entitlement — only a verified webhook does that.';

-- -----------------------------------------------------------------------------
-- 5. Entitlements now understand grace
-- -----------------------------------------------------------------------------
-- A subscription in grace is still a paying subscription: the child keeps
-- talking. A subscription whose grace window has PASSED is not, whether or not
-- the sweep has caught up with it — which is why the window is checked here
-- rather than relying on a background job to have run.

drop function if exists app.parent_entitlements(uuid);
drop function if exists app.parent_entitlements(uuid, timestamptz);

create or replace function app.parent_entitlements(
  p_parent_id uuid,
  -- The instant to evaluate against. Defaults to the database clock so existing
  -- single-argument callers are unaffected; passed explicitly by anything that
  -- carries an injected Clock, which is what makes deadline behaviour testable.
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
  daily_voice_turn_limit        int
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
       -- 'cancelled' is here on purpose: a parent who cancels keeps the period
       -- they paid for. The period check below is what eventually removes it.
       and sub.status in ('trialing', 'active', 'grace', 'past_due', 'cancelled')
       -- An elapsed grace window is not a live subscription.
       and (sub.status <> 'grace' or sub.grace_ends_at > p_now)
       -- Neither is a period that ended without renewing. 'grace' and
       -- 'past_due' are exempt because their whole purpose is to outlive the
       -- period end while payment is retried.
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
         p.daily_voice_turn_limit
    from subscription_plans p
   where p.id = coalesce(
       (select plan_id from live),
       (select id from subscription_plans where code = 'free')
     )
   limit 1;
$$;

comment on function app.parent_entitlements(uuid, timestamptz) is
  'Effective plan limits for a parent. Free when there is no live subscription. Grace counts as live until its window closes.';

-- -----------------------------------------------------------------------------
-- 6. The resolved lifecycle state
-- -----------------------------------------------------------------------------
-- One answer to "what is this account's subscription doing right now?", derived
-- rather than stored, so a stale row cannot outrank the clock.
--
-- `effective_status` is what the product acts on. `stored_status` is what the
-- table says. They differ exactly when a deadline has passed and no sweep has
-- run, which is precisely the window in which a bug would hand out free
-- service.

create or replace function app.subscription_state(
  p_parent_id uuid,
  p_now timestamptz default now()
)
returns table (
  subscription_id   uuid,
  plan_code         text,
  stored_status     text,
  effective_status  text,
  rail              text,
  trial_ends_at     timestamptz,
  current_period_end timestamptz,
  grace_ends_at     timestamptz,
  cancel_at         timestamptz,
  cancelled_at      timestamptz,
  trial_consumed    boolean
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select s.id,
         p.code,
         s.status,
         case
           when s.status = 'grace'    and s.grace_ends_at <= p_now     then 'expired'
           when s.status = 'trialing' and s.trial_ends_at <= p_now     then 'expired'
           when s.status in ('trialing', 'active')
                and s.current_period_end is not null
                and s.current_period_end <= p_now                       then 'expired'
           when s.status = 'cancelled'
                and (s.current_period_end is null or s.current_period_end <= p_now)
                                                                        then 'expired'
           else s.status
         end,
         s.rail,
         s.trial_ends_at,
         s.current_period_end,
         s.grace_ends_at,
         s.cancel_at,
         s.cancelled_at,
         s.trial_consumed
    from subscriptions s
    join subscription_plans p on p.id = s.plan_id
   where s.parent_id = p_parent_id
   order by case s.status
              when 'active'    then 1
              when 'trialing'  then 2
              when 'grace'     then 3
              when 'past_due'  then 4
              when 'cancelled' then 5
              else 6
            end,
            s.created_at desc
   limit 1;
$$;

comment on function app.subscription_state(uuid, timestamptz) is
  'The resolved lifecycle state. effective_status applies elapsed deadlines that no sweep has processed yet.';

-- -----------------------------------------------------------------------------
-- 7. The plan catalogue
-- -----------------------------------------------------------------------------
-- FREE, WEEKLY, MONTHLY, YEARLY, FAMILY.
--
-- Every figure below is data. Changing a price is an UPDATE and a receipt to
-- reconcile, not a deploy — and no part of the application may read a price
-- from anywhere but this table.
--
-- The two plans seeded in the original reference data are deactivated rather
-- than deleted: `subscriptions.plan_id` references them with ON DELETE RESTRICT
-- precisely so that a price a parent actually paid cannot be erased.

update subscription_plans set is_active = false
 where code in ('family_monthly', 'family_annual');

insert into subscription_plans
  (code, display_name, description, tier, price_minor, currency, billing_interval,
   trial_days, grace_days,
   daily_minute_limit, child_profile_limit, weekly_story_limit,
   daily_turn_limit, max_conversation_turns, concurrent_conversation_limit,
   voice_enabled, daily_voice_turn_limit,
   available_rails, sort_order, features)
values
  ('free',
   'Free',
   'A short daily session, so you can see whether your child takes to it.',
   'free', 0, 'PKR', 'none',
   0, 0,
   10, 1, 3,
   20, 20, 1,
   true, 10,
   array['mock'],
   10,
   '{"characters": "limited", "parent_dashboard": true, "transcript_history_days": 7}'::jsonb),

  ('weekly',
   'Weekly',
   'Everything, a week at a time. Cancel whenever.',
   'paid', 14900, 'PKR', 'week',
   0, 3,
   45, 2, null,
   120, 60, 1,
   true, 80,
   array['jazzcash', 'easypaisa', 'stripe', 'apple_iap', 'google_play', 'mock'],
   20,
   '{"characters": "all", "parent_dashboard": true, "transcript_history_days": 30, "speech_practice": true}'::jsonb),

  ('monthly',
   'Monthly',
   'The usual choice. Longer sessions and every character.',
   'paid', 49900, 'PKR', 'month',
   7, 7,
   60, 2, null,
   200, 80, 2,
   true, 150,
   array['jazzcash', 'easypaisa', 'stripe', 'apple_iap', 'google_play', 'mock'],
   30,
   '{"characters": "all", "parent_dashboard": true, "transcript_history_days": 90, "speech_practice": true}'::jsonb),

  ('yearly',
   'Yearly',
   'The monthly plan, billed once a year.',
   'paid', 499000, 'PKR', 'year',
   7, 14,
   60, 2, null,
   200, 80, 2,
   true, 150,
   array['jazzcash', 'easypaisa', 'stripe', 'apple_iap', 'google_play', 'mock'],
   40,
   '{"characters": "all", "parent_dashboard": true, "transcript_history_days": 90, "speech_practice": true}'::jsonb),

  ('family',
   'Family',
   'Up to four children, each with their own profile, settings, and progress.',
   'paid', 79900, 'PKR', 'month',
   7, 7,
   90, 4, null,
   320, 80, 3,
   true, 240,
   array['jazzcash', 'easypaisa', 'stripe', 'apple_iap', 'google_play', 'mock'],
   50,
   '{"characters": "all", "parent_dashboard": true, "transcript_history_days": 90, "speech_practice": true}'::jsonb)

on conflict (code) do update
  set display_name                  = excluded.display_name,
      description                   = excluded.description,
      tier                          = excluded.tier,
      price_minor                   = excluded.price_minor,
      currency                      = excluded.currency,
      billing_interval              = excluded.billing_interval,
      trial_days                    = excluded.trial_days,
      grace_days                    = excluded.grace_days,
      daily_minute_limit            = excluded.daily_minute_limit,
      child_profile_limit           = excluded.child_profile_limit,
      weekly_story_limit            = excluded.weekly_story_limit,
      daily_turn_limit              = excluded.daily_turn_limit,
      max_conversation_turns        = excluded.max_conversation_turns,
      concurrent_conversation_limit = excluded.concurrent_conversation_limit,
      voice_enabled                 = excluded.voice_enabled,
      daily_voice_turn_limit        = excluded.daily_voice_turn_limit,
      available_rails               = excluded.available_rails,
      sort_order                    = excluded.sort_order,
      features                      = excluded.features,
      is_active                     = true;

-- -----------------------------------------------------------------------------
-- 8. Webhook forensics
-- -----------------------------------------------------------------------------
-- `payment_events` already carried the idempotency index and the verification
-- flag. What it lacked was a record of how many times a rail delivered the same
-- event, which is the difference between "the vendor retried" and "someone is
-- replaying our traffic".

alter table payment_events add column delivery_count int not null default 1;
alter table payment_events add column event_occurred_at timestamptz;
alter table payment_events add column ignored_reason text;

alter table payment_events add constraint ck_payment_events_delivery_count
  check (delivery_count >= 1);

comment on column payment_events.delivery_count is
  'S1 — how many times this event id arrived. >1 is normal for a retrying rail.';
comment on column payment_events.event_occurred_at is
  'S1 — the vendor timestamp. Ordering is decided by this, never by our clock.';
comment on column payment_events.ignored_reason is
  'S1 — why a verified event changed nothing: stale, unknown subscription, or no-op transition.';
