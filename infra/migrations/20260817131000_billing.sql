-- =============================================================================
-- subscriptions, transactions, payment_events
-- =============================================================================
-- PAYMENT DATA MINIMISATION IS A HARD REQUIREMENT HERE.
--
-- No table in this migration can hold a card number, a CVV, an expiry date, an
-- IBAN, or a bank account number. What is stored is a vendor TOKEN plus, at
-- most, a brand and the last four digits — the minimum needed for a parent to
-- recognise which card they used on a receipts screen.
--
-- This is enforced three ways: no column exists that could hold a PAN; a check
-- constraint bounds `payment_method_last4` to four digits; and `schema.test.ts`
-- fails the build if any column with a card-shaped name is ever added.
--
-- These are OUR records, reconciled from verified webhooks. Subscription state
-- is never inferred from a client claim, and entitlement is resolved from these
-- tables without calling a vendor synchronously — a webhook outage must not stop
-- a paying child from talking (docs/adr/0007).

create table subscriptions (
  id                   uuid        primary key default app.gen_uuid_v7(),
  parent_id            uuid        not null,
  plan_id              uuid        not null,
  rail                 text        not null,
  status               text        not null default 'free',
  -- The vendor's identifier. Unique per rail, so a replayed or duplicated
  -- webhook cannot create a second subscription.
  external_id          text,
  -- An opaque vendor token. NOT a card number — see the header.
  payment_method_token text,
  payment_method_brand text,
  payment_method_last4 char(4),
  currency             char(3)     not null default 'PKR',
  price_minor          int         not null default 0,
  current_period_start timestamptz,
  current_period_end   timestamptz,
  cancel_at            timestamptz,
  cancelled_at         timestamptz,
  trial_ends_at        timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  constraint fk_subscriptions_parent
    foreign key (parent_id) references parents (id) on delete cascade,
  constraint fk_subscriptions_plan
    foreign key (plan_id) references subscription_plans (id) on delete restrict,

  constraint ck_subscriptions_rail
    check (rail in ('stripe', 'jazzcash', 'easypaisa', 'apple_iap', 'google_play', 'mock')),
  constraint ck_subscriptions_status
    check (status in ('free', 'trialing', 'active', 'past_due', 'cancelled', 'expired')),
  constraint ck_subscriptions_price_nonnegative check (price_minor >= 0),
  constraint ck_subscriptions_period_ordered
    check (current_period_end is null or current_period_start is null
           or current_period_end >= current_period_start),
  -- Exactly four digits, or absent. A longer value would mean someone is
  -- storing more of the card than they should be.
  constraint ck_subscriptions_last4 check (payment_method_last4 ~ '^[0-9]{4}$'),
  constraint ck_subscriptions_brand
    check (payment_method_brand is null
           or payment_method_brand in ('visa', 'mastercard', 'amex', 'unionpay', 'wallet', 'other'))
);

create index idx_subscriptions_parent on subscriptions (parent_id);
create unique index uq_subscriptions_rail_external
  on subscriptions (rail, external_id) where external_id is not null;

-- One active subscription per parent. A second is a billing bug, and the
-- database is the only place that can make it impossible rather than unlikely.
create unique index uq_subscriptions_one_live_per_parent
  on subscriptions (parent_id) where status in ('trialing', 'active');

-- Drives the dunning and expiry sweeps.
create index idx_subscriptions_period_end on subscriptions (current_period_end)
  where status in ('trialing', 'active', 'past_due');

create trigger trg_subscriptions_touch
  before update on subscriptions
  for each row execute function app.touch_updated_at();

comment on table subscriptions is
  'S1 — our subscription record, reconciled from verified webhooks. Never trusted from a client.';
comment on column subscriptions.payment_method_token is
  'S1 — OPAQUE VENDOR TOKEN. Never a card number. See PRIVACY.md §3.1.';
comment on column subscriptions.payment_method_last4 is
  'S1 — last four digits only, for recognition on a receipts screen. Never the full PAN.';

-- -----------------------------------------------------------------------------

create table transactions (
  id                   uuid        primary key default app.gen_uuid_v7(),
  subscription_id      uuid        not null,
  parent_id            uuid        not null,
  rail                 text        not null,
  -- The vendor's reference. The idempotency key that makes a redelivered
  -- webhook a no-op instead of a double charge in our books.
  external_id          text        not null,
  kind                 text        not null,
  status               text        not null,
  -- Minor units plus a currency code. Never a float — 0.1 + 0.2 is not a
  -- billing strategy.
  amount_minor         int         not null,
  currency             char(3)     not null,
  payment_method_brand text,
  payment_method_last4 char(4),
  failure_code         text,
  occurred_at          timestamptz not null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  constraint fk_transactions_subscription
    foreign key (subscription_id) references subscriptions (id) on delete cascade,
  constraint fk_transactions_parent
    foreign key (parent_id) references parents (id) on delete cascade,

  constraint ck_transactions_rail
    check (rail in ('stripe', 'jazzcash', 'easypaisa', 'apple_iap', 'google_play', 'mock')),
  constraint ck_transactions_kind check (kind in ('charge', 'refund', 'chargeback', 'credit')),
  constraint ck_transactions_status
    check (status in ('pending', 'succeeded', 'failed', 'reversed')),
  -- Refunds and chargebacks are negative, charges positive. Enforcing the sign
  -- means a reconciliation SUM cannot silently be wrong.
  constraint ck_transactions_amount_sign
    check ((kind in ('charge', 'credit') and amount_minor >= 0)
        or (kind in ('refund', 'chargeback') and amount_minor <= 0)),
  constraint ck_transactions_last4 check (payment_method_last4 ~ '^[0-9]{4}$'),
  constraint ck_transactions_failure_only_when_failed
    check (failure_code is null or status in ('failed', 'reversed'))
);

create unique index uq_transactions_rail_external on transactions (rail, external_id);
create index idx_transactions_subscription on transactions (subscription_id, occurred_at desc);
create index idx_transactions_parent on transactions (parent_id, occurred_at desc);

create trigger trg_transactions_touch
  before update on transactions
  for each row execute function app.touch_updated_at();

comment on table transactions is
  'S1 — financial record. Subject to the narrow legal-retention exception in PRIVACY.md §7: amount, date, and a pseudonymous reference may outlive an account. Conversations and child data never do.';

-- -----------------------------------------------------------------------------
-- payment_events
-- -----------------------------------------------------------------------------
-- The raw webhook ledger: every event a rail sent us, whether its signature
-- verified, and what we did with it.
--
-- Kept separate from `transactions` because it answers a different question.
-- `transactions` is what we believe is true about money; `payment_events` is
-- what we were told and when. When those disagree — and eventually they will —
-- this table is the only way to find out which one is wrong.
--
-- It also carries the idempotency guarantee: a redelivered webhook hits the
-- unique index and is skipped before any state changes.
create table payment_events (
  id                 uuid        primary key default app.gen_uuid_v7(),
  rail               text        not null,
  external_event_id  text        not null,
  event_type         text        not null,
  -- Whether the signature verified. An unverified webhook endpoint is a
  -- free-subscription vulnerability and the most common flaw in payment
  -- integrations, so this is recorded, not assumed.
  signature_verified boolean     not null,
  processing_status  text        not null default 'pending',
  processing_error   text,
  -- The vendor payload with card fields stripped before insert. Bounded so a
  -- pathological payload cannot bloat the table.
  payload            jsonb       not null default '{}'::jsonb,
  subscription_id    uuid,
  parent_id          uuid,
  received_at        timestamptz not null default now(),
  processed_at       timestamptz,
  created_at         timestamptz not null default now(),

  constraint fk_payment_events_subscription
    foreign key (subscription_id) references subscriptions (id) on delete set null,
  -- SET NULL, not CASCADE: the payment ledger must survive account erasure, in
  -- the minimised form the legal-retention exception allows.
  constraint fk_payment_events_parent
    foreign key (parent_id) references parents (id) on delete set null,

  constraint ck_payment_events_rail
    check (rail in ('stripe', 'jazzcash', 'easypaisa', 'apple_iap', 'google_play', 'mock')),
  constraint ck_payment_events_status
    check (processing_status in ('pending', 'processed', 'ignored', 'failed')),
  constraint ck_payment_events_processed_has_timestamp
    check (processing_status = 'pending' or processed_at is not null),
  constraint ck_payment_events_payload_bounded check (pg_column_size(payload) <= 16384),
  -- An unverified event may be recorded for forensics but must never be acted
  -- on. This makes "we processed a forged webhook" unrepresentable.
  constraint ck_payment_events_unverified_not_processed
    check (signature_verified or processing_status <> 'processed')
);

create unique index uq_payment_events_rail_external on payment_events (rail, external_event_id);
create index idx_payment_events_pending on payment_events (received_at) where processing_status = 'pending';
create index idx_payment_events_subscription on payment_events (subscription_id);
create index idx_payment_events_unverified on payment_events (received_at desc)
  where not signature_verified;

comment on table payment_events is
  'S1 — raw webhook ledger. Provides idempotency and reconciliation evidence. Card fields are stripped before insert.';
comment on column payment_events.payload is
  'S1 — vendor payload, card data removed. Never contains a PAN, CVV, or expiry.';

-- -----------------------------------------------------------------------------
-- RLS
-- -----------------------------------------------------------------------------
alter table subscriptions enable row level security;
alter table subscriptions force row level security;

-- READ-ONLY to the application. Every write is a webhook reconciliation or a
-- checkout completion performed as a system operation after signature
-- verification — never in response to a request from the client that benefits.
create policy subscriptions_select_owner on subscriptions
  for select to authenticated using (parent_id = app.current_parent_id());

alter table transactions enable row level security;
alter table transactions force row level security;

create policy transactions_select_owner on transactions
  for select to authenticated using (parent_id = app.current_parent_id());

alter table payment_events enable row level security;
alter table payment_events force row level security;

-- No policy and no grant for `authenticated`: the raw webhook ledger is an
-- operational artefact, not something a parent has any reason to read.

grant select on subscriptions to authenticated;
grant select on transactions to authenticated;
