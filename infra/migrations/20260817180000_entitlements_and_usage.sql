-- =============================================================================
-- Entitlements and usage.
-- =============================================================================
-- Two questions the conversation API has to answer on every request, and one
-- rule about where the answers come from.
--
--   "What is this parent allowed?"  → subscription_plans, resolved through
--                                     app.parent_entitlements()
--   "What have they used today?"    → usage_daily
--
-- THE RULE: entitlement is resolved from OUR tables, never from a client claim
-- and never by calling a payment vendor synchronously. A webhook outage must not
-- stop a paying child from talking (docs/adr/0007).

-- -----------------------------------------------------------------------------
-- 1. Conversation entitlements on the plan
-- -----------------------------------------------------------------------------
-- `daily_minute_limit` already existed for the voice phase, where a session is
-- measured in wall time. Text turns need their own limits, and they belong here
-- with the rest of the plan rather than in application constants — so "why was
-- my child cut off?" has one answer a support engineer can read.
alter table subscription_plans add column daily_turn_limit int not null default 40;
alter table subscription_plans add column max_conversation_turns int not null default 60;
alter table subscription_plans add column concurrent_conversation_limit int not null default 1;

alter table subscription_plans add constraint ck_subscription_plans_turn_limits
  check (daily_turn_limit >= 1 and max_conversation_turns >= 1
         and concurrent_conversation_limit >= 1);

comment on column subscription_plans.daily_turn_limit is
  'Turns per child per UTC day. Counts blocked turns too — see usage_daily.';
comment on column subscription_plans.max_conversation_turns is
  'Turns in a single session before it ends. A cap on session length, not on the day.';
comment on column subscription_plans.concurrent_conversation_limit is
  'Simultaneously active conversations per child.';

update subscription_plans
   set daily_turn_limit = 20, max_conversation_turns = 20, concurrent_conversation_limit = 1
 where code = 'free';

update subscription_plans
   set daily_turn_limit = 400, max_conversation_turns = 200, concurrent_conversation_limit = 3
 where tier = 'paid';

-- -----------------------------------------------------------------------------
-- 2. Effective entitlements for a parent
-- -----------------------------------------------------------------------------
-- One function, so every caller resolves entitlement the same way. A parent with
-- no subscription row is on the free plan — absence is a state, not an error.
--
-- `past_due` KEEPS ACCESS. A failed card should not cut a child off mid-session;
-- dunning is a billing conversation with the parent, not a punishment for the
-- child. Expiry is what removes access, and the dunning sweep sets it.
create or replace function app.parent_entitlements(p_parent_id uuid)
returns table (
  plan_code                     text,
  tier                          text,
  subscription_status           text,
  daily_turn_limit              int,
  max_conversation_turns        int,
  concurrent_conversation_limit int,
  child_profile_limit           int,
  daily_minute_limit            int
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
       and sub.status in ('trialing', 'active', 'past_due')
     order by case sub.status
                when 'active'   then 1
                when 'trialing' then 2
                else 3
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
         p.daily_minute_limit
    from subscription_plans p
   where p.is_active
     and p.id = coalesce(
       (select plan_id from live),
       (select id from subscription_plans where code = 'free')
     )
   limit 1;
$$;

comment on function app.parent_entitlements(uuid) is
  'Effective plan limits for a parent. Free when there is no live subscription.';

-- -----------------------------------------------------------------------------
-- 3. Usage
-- -----------------------------------------------------------------------------
-- An aggregate per child per day. Deliberately NOT a count over `messages`:
--
--   * the free-tier check runs on the request path and must be one indexed read,
--   * cost and token totals have to survive message deletion, since a parent
--     erasing a transcript must not erase what it cost us to produce, and
--   * `messages` is the highest-write table in the system and is the last place
--     to put a reporting scan.
--
-- No content. Counts, tokens, and cost only.
create table usage_daily (
  id                    uuid        primary key default app.gen_uuid_v7(),
  child_id              uuid        not null,
  usage_date            date        not null,
  -- Every turn ATTEMPTED, including ones safety stopped. A blocked turn still
  -- costs a classifier call, and not counting them would make the safety layer a
  -- free way around the quota.
  turns                 int         not null default 0,
  blocked_turns         int         not null default 0,
  conversations_started int         not null default 0,
  input_tokens          bigint      not null default 0,
  output_tokens         bigint      not null default 0,
  cost_usd              numeric(12, 6) not null default 0,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  constraint fk_usage_daily_child
    foreign key (child_id) references children (id) on delete cascade,
  constraint ck_usage_daily_nonnegative
    check (turns >= 0 and blocked_turns >= 0 and conversations_started >= 0
           and input_tokens >= 0 and output_tokens >= 0 and cost_usd >= 0),
  constraint ck_usage_daily_blocked_subset check (blocked_turns <= turns)
);

create unique index uq_usage_daily_child_date on usage_daily (child_id, usage_date);
create index idx_usage_daily_date on usage_daily (usage_date desc);

create trigger trg_usage_daily_touch
  before update on usage_daily
  for each row execute function app.touch_updated_at();

comment on table usage_daily is
  'S2 — per-child daily counters. Counts, tokens, and cost. Never content.';

alter table usage_daily enable row level security;
alter table usage_daily force row level security;

-- A parent sees their own children's usage and cannot write it. A quota a parent
-- could edit is not a quota.
create policy usage_daily_select_own on usage_daily
  for select to authenticated using (app.owns_child(child_id));

grant select on usage_daily to authenticated;

-- -----------------------------------------------------------------------------
-- 4. Recording and reading usage
-- -----------------------------------------------------------------------------
-- The upsert is the only writer. SECURITY DEFINER because the request that needs
-- to record usage runs as the parent, and a parent must not be able to write
-- this table directly.
create or replace function app.record_usage(
  p_child_id      uuid,
  p_turns         int     default 0,
  p_blocked_turns int     default 0,
  p_conversations int     default 0,
  p_input_tokens  bigint  default 0,
  p_output_tokens bigint  default 0,
  p_cost_usd      numeric default 0
)
returns void
language sql
volatile
security definer
set search_path = public, pg_temp
as $$
  insert into usage_daily as u
    (child_id, usage_date, turns, blocked_turns, conversations_started,
     input_tokens, output_tokens, cost_usd)
  values
    (p_child_id, (now() at time zone 'utc')::date, p_turns, p_blocked_turns, p_conversations,
     p_input_tokens, p_output_tokens, p_cost_usd)
  on conflict (child_id, usage_date) do update
    set turns                 = u.turns + excluded.turns,
        blocked_turns         = u.blocked_turns + excluded.blocked_turns,
        conversations_started = u.conversations_started + excluded.conversations_started,
        input_tokens          = u.input_tokens + excluded.input_tokens,
        output_tokens         = u.output_tokens + excluded.output_tokens,
        cost_usd              = u.cost_usd + excluded.cost_usd,
        updated_at            = now();
$$;

comment on function app.record_usage is
  'Accumulates one day of usage for a child. The only writer of usage_daily.';

-- Today's turn count, for the entitlement check.
create or replace function app.child_turns_used_today(p_child_id uuid)
returns int
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (select u.turns from usage_daily u
      where u.child_id = p_child_id
        and u.usage_date = (now() at time zone 'utc')::date),
    0
  );
$$;

comment on function app.child_turns_used_today(uuid) is
  'Turns recorded for this child today. Authoritative for the daily limit; '
  'app.child_turns_today() counts messages and exists to reconcile against it.';

-- How many conversations this child currently has open.
create or replace function app.child_active_conversations(p_child_id uuid)
returns int
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select count(*)::int
    from conversations c
   where c.child_id = p_child_id
     and c.status = 'active';
$$;

-- -----------------------------------------------------------------------------
-- 5. Which characters a plan includes
-- -----------------------------------------------------------------------------
-- The free plan's seeded features already say `"characters": "limited"`. This is
-- what makes that true, as a column rather than as application knowledge.
--
-- Personas differ in voice and manner only, never in safety policy — a paid
-- character is not a less-restricted character, and nothing in this column
-- changes what any layer of the safety pipeline does.
alter table ai_characters add column requires_paid_plan boolean not null default false;

comment on column ai_characters.requires_paid_plan is
  'Plan gating only. Never a safety distinction — see the table comment.';

update ai_characters set requires_paid_plan = true
 where slug in ('captain-sky', 'professor-owl');
