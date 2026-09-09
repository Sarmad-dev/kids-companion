-- =============================================================================
-- Payment state, separate from subscription state
-- =============================================================================
-- The subscription tables answer "what is this family entitled to?". This
-- migration adds the tables that answer "did money move?", and keeps them apart
-- on purpose.
--
-- WHY THEY MUST BE SEPARATE. In the launch market they genuinely come apart:
--
--   * a wallet payment can succeed while the subscription is untouched — a
--     duplicate the customer made by tapping twice, a retry of something we
--     already credited,
--   * a subscription sits in grace for a week while three payments fail,
--   * carrier billing may not support recurring at all, so one subscription
--     period is one fresh payment authorised again each time.
--
-- Collapsing them gives one status column that is wrong in both directions, and
-- makes "the payment succeeded but the child still cannot talk" unreproducible.
--
-- WHAT IS NOT HERE. No card number, and no column that could hold one. No
-- merchant credential — those live in configuration and never in a row. And no
-- rail-specific column: `jazzcash_txn_ref` would bake one vendor's vocabulary
-- into a shared table, so every rail uses `rail_reference`.

-- -----------------------------------------------------------------------------
-- 1. Two new rails
-- -----------------------------------------------------------------------------
-- `card` is the processor-agnostic card rail; `stripe` stays because rows
-- already reference it. `carrier_billing` is new.

alter table subscriptions drop constraint ck_subscriptions_rail;
alter table subscriptions add constraint ck_subscriptions_rail
  check (rail in ('card', 'stripe', 'jazzcash', 'easypaisa', 'carrier_billing',
                  'apple_iap', 'google_play', 'mock'));

alter table transactions drop constraint ck_transactions_rail;
alter table transactions add constraint ck_transactions_rail
  check (rail in ('card', 'stripe', 'jazzcash', 'easypaisa', 'carrier_billing',
                  'apple_iap', 'google_play', 'mock'));

alter table payment_events drop constraint ck_payment_events_rail;
alter table payment_events add constraint ck_payment_events_rail
  check (rail in ('card', 'stripe', 'jazzcash', 'easypaisa', 'carrier_billing',
                  'apple_iap', 'google_play', 'mock'));

alter table subscription_checkouts drop constraint ck_subscription_checkouts_rail;
alter table subscription_checkouts add constraint ck_subscription_checkouts_rail
  check (rail in ('card', 'stripe', 'jazzcash', 'easypaisa', 'carrier_billing',
                  'apple_iap', 'google_play', 'mock'));

-- -----------------------------------------------------------------------------
-- 2. Payments
-- -----------------------------------------------------------------------------
-- One row per attempt to collect money. Its status vocabulary deliberately
-- shares no word with `subscriptions.status`: nothing here is "active" or
-- "cancelled", and nothing there is "captured".

create table payments (
  id                uuid        primary key default app.gen_uuid_v7(),
  parent_id         uuid        not null,
  -- NULLABLE, and that is the separation made concrete. A payment can exist
  -- without a subscription — a one-off, a retry we have not yet matched, a
  -- duplicate the rail sent us.
  subscription_id   uuid,
  checkout_id       uuid,
  rail              text        not null,
  status            text        not null default 'initiated',
  amount_minor      int         not null,
  currency          char(3)     not null,
  -- The rail's identifier. One name for every rail, so no query has to know
  -- which vendor it is reading.
  rail_reference    text,
  -- The caller's key. A retry after a timeout must not become a second charge.
  idempotency_key   text        not null,
  failure_code      text,
  -- The rail's own code, for reconciliation. NEVER shown to a parent.
  rail_failure_code text,
  payment_method_brand text,
  payment_method_last4 char(4),
  -- Set only where the rail issued a reusable token and the customer consented.
  instrument_token  text,
  attempt_count     int         not null default 1,
  -- Reconciliation bookkeeping: when we last asked the rail, and when its
  -- answer last agreed with ours.
  last_checked_at   timestamptz,
  reconciled_at     timestamptz,
  initiated_at      timestamptz not null default now(),
  completed_at      timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint fk_payments_parent
    foreign key (parent_id) references parents (id) on delete cascade,
  constraint fk_payments_subscription
    foreign key (subscription_id) references subscriptions (id) on delete set null,
  constraint fk_payments_checkout
    foreign key (checkout_id) references subscription_checkouts (id) on delete set null,

  constraint ck_payments_rail
    check (rail in ('card', 'stripe', 'jazzcash', 'easypaisa', 'carrier_billing',
                    'apple_iap', 'google_play', 'mock')),
  constraint ck_payments_status
    check (status in ('initiated', 'pending', 'authorized', 'captured', 'failed',
                      'cancelled', 'refunded', 'unresolved')),
  constraint ck_payments_amount_positive check (amount_minor > 0),
  -- A failure must say why. "It failed" with no code is unreconcilable, and it
  -- is what makes a dunning policy impossible to write.
  constraint ck_payments_failure_has_code
    check (status <> 'failed' or failure_code is not null),
  -- Four digits, or nothing. A longer value means someone is storing more of
  -- the card than they should be.
  constraint ck_payments_last4 check (payment_method_last4 ~ '^[0-9]{4}$'),
  constraint ck_payments_completed_when_terminal
    check (status not in ('captured', 'failed', 'cancelled', 'refunded')
           or completed_at is not null),
  constraint ck_payments_idempotency_key check (length(idempotency_key) between 8 and 128)
);

-- The idempotency guarantee. A repeated key from the same parent finds the
-- existing payment instead of starting a second one.
create unique index uq_payments_idempotency on payments (parent_id, idempotency_key);

-- One rail reference belongs to one payment. This is what makes a redelivered
-- callback resolvable to a single row.
create unique index uq_payments_rail_reference
  on payments (rail, rail_reference) where rail_reference is not null;

create index idx_payments_parent on payments (parent_id, created_at desc);
create index idx_payments_subscription on payments (subscription_id)
  where subscription_id is not null;

-- Drives reconciliation: everything the rail has not given us a final answer
-- about. A partial index because the interesting set is small and the table is
-- not.
create index idx_payments_unresolved on payments (initiated_at)
  where status in ('initiated', 'pending', 'authorized', 'unresolved');

create trigger trg_payments_touch
  before update on payments
  for each row execute function app.touch_updated_at();

comment on table payments is
  'S1 — one attempt to collect money. Separate from subscription state by design; see docs/PAYMENT_RAILS.md.';
comment on column payments.subscription_id is
  'S1 — nullable. A payment need not belong to a subscription, and often does not.';
comment on column payments.instrument_token is
  'S1 — OPAQUE PROCESSOR TOKEN. Never a card number. The processor collects card details on the device.';
comment on column payments.rail_failure_code is
  'S1 — the rail''s own code, for reconciliation. Never shown to a parent; vendor strings are written for merchants.';

alter table payments enable row level security;
alter table payments force row level security;

-- Read-only to the parent who owns it. Every write is a system operation
-- performed after a verified callback or a rail query — never in response to a
-- request from the client that benefits.
create policy payments_select_owner on payments
  for select to authenticated using (parent_id = app.current_parent_id());

grant select on payments to authenticated;

-- -----------------------------------------------------------------------------
-- 3. Refunds
-- -----------------------------------------------------------------------------
-- A refund has its own lifecycle — requested, then succeeded or failed — and it
-- is not the same object as the payment it reverses. Modelling it as a status
-- on `payments` would lose partial refunds entirely, and lose the audit trail
-- of a refund that was attempted and refused.
--
-- Most rails in this market are expected NOT to support refunds at all. This
-- table exists so that the ones which do have somewhere to record it, and so
-- that an attempt against a rail which does not is recorded as a refusal rather
-- than vanishing.

create table payment_refunds (
  id                uuid        primary key default app.gen_uuid_v7(),
  payment_id        uuid        not null,
  parent_id         uuid        not null,
  rail              text        not null,
  rail_reference    text,
  idempotency_key   text        not null,
  status            text        not null default 'requested',
  -- Positive here; the corresponding `transactions` row is negative. Two signs
  -- for one event is confusing, so: this table records the refund, the ledger
  -- records its effect on the balance.
  amount_minor      int         not null,
  currency          char(3)     not null,
  reason            text        not null,
  failure_code      text,
  requested_by      uuid,
  requested_at      timestamptz not null default now(),
  completed_at      timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint fk_payment_refunds_payment
    foreign key (payment_id) references payments (id) on delete cascade,
  constraint fk_payment_refunds_parent
    foreign key (parent_id) references parents (id) on delete cascade,
  constraint fk_payment_refunds_requested_by
    foreign key (requested_by) references parents (id) on delete set null,

  constraint ck_payment_refunds_rail
    check (rail in ('card', 'stripe', 'jazzcash', 'easypaisa', 'carrier_billing',
                    'apple_iap', 'google_play', 'mock')),
  constraint ck_payment_refunds_status
    check (status in ('requested', 'succeeded', 'failed', 'unsupported')),
  constraint ck_payment_refunds_amount_positive check (amount_minor > 0),
  constraint ck_payment_refunds_failure_has_code
    check (status <> 'failed' or failure_code is not null),
  constraint ck_payment_refunds_completed_when_terminal
    check (status = 'requested' or completed_at is not null)
);

create unique index uq_payment_refunds_idempotency
  on payment_refunds (payment_id, idempotency_key);
create index idx_payment_refunds_parent on payment_refunds (parent_id, requested_at desc);

create trigger trg_payment_refunds_touch
  before update on payment_refunds
  for each row execute function app.touch_updated_at();

comment on table payment_refunds is
  'S1 — refund attempts, including refusals. Most rails in the launch market are expected not to support refunds at all.';

alter table payment_refunds enable row level security;
alter table payment_refunds force row level security;

create policy payment_refunds_select_owner on payment_refunds
  for select to authenticated using (parent_id = app.current_parent_id());

grant select on payment_refunds to authenticated;

-- -----------------------------------------------------------------------------
-- 4. The ledger no longer requires a subscription
-- -----------------------------------------------------------------------------
-- `transactions.subscription_id` was NOT NULL, which quietly asserted that
-- every payment belongs to a subscription. On a rail without recurring support
-- that is false, and a one-off purchase could not be recorded at all.

alter table transactions alter column subscription_id drop not null;
alter table transactions add column payment_id uuid;
alter table transactions add constraint fk_transactions_payment
  foreign key (payment_id) references payments (id) on delete set null;

create index idx_transactions_payment on transactions (payment_id)
  where payment_id is not null;

comment on column transactions.subscription_id is
  'S1 — nullable. A payment need not belong to a subscription; see payments.';

-- -----------------------------------------------------------------------------
-- 5. Callbacks resolve to a payment
-- -----------------------------------------------------------------------------

alter table payment_events add column payment_id uuid;
alter table payment_events add constraint fk_payment_events_payment
  foreign key (payment_id) references payments (id) on delete set null;

create index idx_payment_events_payment on payment_events (payment_id)
  where payment_id is not null;

-- -----------------------------------------------------------------------------
-- 6. Which rails a plan may be bought on
-- -----------------------------------------------------------------------------
-- `subscription_plans.available_rails` already existed. What it lacked was any
-- relationship to what a rail can actually do — a yearly plan offered on a rail
-- with a low per-transaction ceiling is a checkout that always fails.
--
-- Enforcing that needs limits we do not have yet (they are on every rail's
-- verification checklist), so this records the intent and the sweep that will
-- check it once the numbers are known.

comment on column subscription_plans.available_rails is
  'S0 — rails this plan may be purchased on. Must be reconciled against each rail''s verified transaction ceiling; see docs/PAYMENT_RAILS.md.';

-- -----------------------------------------------------------------------------
-- 7. Reconciliation: what the rail says versus what we believe
-- -----------------------------------------------------------------------------
-- Payments that have not reached a terminal state and are old enough that the
-- silence is suspicious. The reconciler asks the rail about each one.
--
-- The threshold is a parameter rather than a literal because it is genuinely
-- rail-dependent: a card authorises in seconds, a wallet may wait for a
-- customer to open an app, and carrier billing can take minutes.

create or replace function app.payments_needing_reconciliation(
  p_older_than_minutes int default 15,
  p_limit int default 100,
  p_now timestamptz default now()
)
returns table (
  payment_id     uuid,
  parent_id      uuid,
  rail           text,
  rail_reference text,
  status         text,
  initiated_at   timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p.id, p.parent_id, p.rail, p.rail_reference, p.status, p.initiated_at
    from payments p
   where p.status in ('initiated', 'pending', 'authorized', 'unresolved')
     and p.initiated_at < p_now - make_interval(mins => p_older_than_minutes)
     -- Do not re-ask about something we asked about a moment ago; a rail that
     -- is down should not be hammered by the sweep that noticed.
     and (p.last_checked_at is null
          or p.last_checked_at < p_now - make_interval(mins => p_older_than_minutes))
   order by p.initiated_at
   limit p_limit;
$$;

comment on function app.payments_needing_reconciliation is
  'Payments the rail has not given a final answer about. The input to reconciliation.';

-- -----------------------------------------------------------------------------
-- 8. What a family has actually been charged
-- -----------------------------------------------------------------------------
-- Reconciliation in the accounting sense: our ledger against our payments. A
-- disagreement means one of the two is wrong, and finding out which is the
-- whole reason both exist.

create or replace function app.parent_payment_summary(p_parent_id uuid)
returns table (
  payments_captured   int,
  payments_failed     int,
  payments_unresolved int,
  captured_minor      bigint,
  refunded_minor      bigint,
  ledger_net_minor    bigint
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    (select count(*)::int from payments
      where parent_id = p_parent_id and status = 'captured'),
    (select count(*)::int from payments
      where parent_id = p_parent_id and status = 'failed'),
    (select count(*)::int from payments
      where parent_id = p_parent_id and status in ('unresolved', 'pending', 'authorized')),
    (select coalesce(sum(amount_minor), 0)::bigint from payments
      where parent_id = p_parent_id and status in ('captured', 'refunded')),
    (select coalesce(sum(amount_minor), 0)::bigint from payment_refunds
      where parent_id = p_parent_id and status = 'succeeded'),
    (select coalesce(sum(amount_minor), 0)::bigint from transactions
      where parent_id = p_parent_id and status = 'succeeded');
$$;

comment on function app.parent_payment_summary is
  'Payments against ledger for one parent. A disagreement between the two is the signal reconciliation exists to find.';
