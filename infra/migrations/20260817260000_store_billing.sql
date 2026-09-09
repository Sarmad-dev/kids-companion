-- =============================================================================
-- Mobile store billing
-- =============================================================================
-- Apple App Store and Google Play own the subscription: they charge, they retry
-- a failed card, they run their own grace period, and they decide when it ends.
-- We MIRROR that. These tables are a cache of what the store told us, and when
-- ours and theirs disagree, theirs is right.
--
-- THE CLIENT NEVER WRITES ANY OF THIS. A device presents a purchase token; the
-- server asks the store; the store's answer is what lands here. There is no
-- column a client-supplied status could be written to, and no code path from a
-- request body to an entitlement.

-- -----------------------------------------------------------------------------
-- 1. Store purchases
-- -----------------------------------------------------------------------------

create table store_purchases (
  id                      uuid        primary key default app.gen_uuid_v7(),
  parent_id               uuid        not null,
  store                   text        not null,
  -- The store's stable identifier for the whole subscription, across renewals.
  -- Apple's original transaction id and Google's purchase token play this role.
  original_transaction_id text        not null,
  -- Changes on every renewal. Kept for support and reconciliation.
  latest_transaction_id   text,
  -- The store's product identifier, mapped to one of our plans by
  -- configuration. Deliberately NOT a foreign key to subscription_plans: the
  -- store's catalogue and ours are maintained separately, and a purchase of a
  -- product we have since renamed must still be honoured.
  product_id              text        not null,
  state                   text        not null,
  expires_at              timestamptz,
  -- The STORE's grace window, which is not the same thing as ours in
  -- `subscriptions.grace_ends_at` — that one applies to rails we bill directly.
  grace_period_ends_at    timestamptz,
  auto_renewing           boolean     not null default true,
  -- Sandbox or production. A sandbox purchase honoured in production is a free
  -- subscription for anyone with a test account, so this is stored explicitly
  -- rather than inferred.
  environment             text        not null,
  -- The store's own timestamp for its latest answer. ORDERING IS BY THIS, never
  -- by our clock: store notifications arrive out of order routinely, and a
  -- delayed "expired" must not overwrite a fresh renewal.
  verified_at             timestamptz not null,
  -- Our subscription this purchase backs, once linked.
  subscription_id         uuid,
  refunded_at             timestamptz,
  first_seen_at           timestamptz not null default now(),
  last_notification_at    timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),

  constraint fk_store_purchases_parent
    foreign key (parent_id) references parents (id) on delete cascade,
  constraint fk_store_purchases_subscription
    foreign key (subscription_id) references subscriptions (id) on delete set null,

  constraint ck_store_purchases_store check (store in ('apple_iap', 'google_play')),
  constraint ck_store_purchases_state
    check (state in ('active', 'trial', 'grace_period', 'on_hold', 'paused',
                     'cancelled', 'expired', 'refunded', 'invalid')),
  constraint ck_store_purchases_environment check (environment in ('sandbox', 'production')),
  constraint ck_store_purchases_refunded_has_timestamp
    check (state <> 'refunded' or refunded_at is not null)
);

-- ═══════════════════════════════════════════════════════════════════════════
-- ONE PURCHASE BELONGS TO EXACTLY ONE PARENT.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- This index is the entitlement-sharing defence, and it is worth being explicit
-- about the attack it stops.
--
-- A store account is not our account. One person can sign into the App Store or
-- Play on several devices, and Family Sharing can spread a purchase further
-- still. Nothing stops a subscriber pasting their purchase token to somebody
-- else — or an app being modified to send a token somebody published.
--
-- Without this constraint, that token verifies successfully for every parent
-- who presents it, and one subscription silently becomes many. With it, the
-- second parent's attempt fails on a unique violation, which the application
-- turns into a refusal AND a recorded event: the same token arriving under two
-- accounts is a signal, not merely an error.
create unique index uq_store_purchases_transaction
  on store_purchases (store, original_transaction_id);

create index idx_store_purchases_parent on store_purchases (parent_id, created_at desc);
create index idx_store_purchases_subscription on store_purchases (subscription_id)
  where subscription_id is not null;

-- Drives synchronisation: purchases that should still be live and have not been
-- re-checked recently. Stores are reliable about eventually telling us and
-- unreliable about telling us promptly, so we also ask.
create index idx_store_purchases_syncable on store_purchases (verified_at)
  where state in ('active', 'trial', 'grace_period', 'on_hold');

create trigger trg_store_purchases_touch
  before update on store_purchases
  for each row execute function app.touch_updated_at();

comment on table store_purchases is
  'S1 — a mirror of what Apple or Google says about one subscription. Never written from a client claim.';
comment on column store_purchases.verified_at is
  'S1 — the STORE''s timestamp. Ordering is by this; notifications arrive out of order.';
comment on column store_purchases.environment is
  'S1 — sandbox or production. A sandbox purchase honoured in production is a free subscription.';

alter table store_purchases enable row level security;
alter table store_purchases force row level security;

-- Read-only to the owning parent. Every write is a system operation performed
-- after the STORE confirmed something.
create policy store_purchases_select_owner on store_purchases
  for select to authenticated using (parent_id = app.current_parent_id());

grant select on store_purchases to authenticated;

-- -----------------------------------------------------------------------------
-- 2. Store notifications
-- -----------------------------------------------------------------------------
-- The raw server-to-server ledger: what a store told us, whether it
-- authenticated, and what we did about it.
--
-- Kept separate from `payment_events` because it answers a different question.
-- That table is about money moving on a rail we bill; this one is about a store
-- announcing a change to a subscription it owns.
--
-- A NOTIFICATION IS A HINT TO GO AND ASK. The processing path never acts on the
-- payload — it re-verifies with the store and uses that answer. Which is also
-- why a forged notification is harmless: the worst it achieves is making us ask
-- a question we already knew the answer to.

create table store_notifications (
  id                      uuid        primary key default app.gen_uuid_v7(),
  store                   text        not null,
  -- The store's event identifier. The idempotency key for redelivery, and both
  -- stores redeliver.
  notification_id         text        not null,
  -- The store's own event name. Recorded for forensics, never branched on.
  kind                    text        not null,
  original_transaction_id text,
  environment             text        not null,
  signature_verified      boolean     not null,
  processing_status       text        not null default 'pending',
  processing_error        text,
  ignored_reason          text,
  -- Bounded, and stripped of anything sensitive before insert.
  payload                 jsonb       not null default '{}'::jsonb,
  store_purchase_id       uuid,
  parent_id               uuid,
  delivery_count          int         not null default 1,
  occurred_at             timestamptz,
  received_at             timestamptz not null default now(),
  processed_at            timestamptz,
  created_at              timestamptz not null default now(),

  constraint fk_store_notifications_purchase
    foreign key (store_purchase_id) references store_purchases (id) on delete set null,
  constraint fk_store_notifications_parent
    foreign key (parent_id) references parents (id) on delete set null,

  constraint ck_store_notifications_store check (store in ('apple_iap', 'google_play')),
  constraint ck_store_notifications_environment check (environment in ('sandbox', 'production')),
  constraint ck_store_notifications_status
    check (processing_status in ('pending', 'processed', 'ignored', 'failed')),
  constraint ck_store_notifications_processed_has_timestamp
    check (processing_status = 'pending' or processed_at is not null),
  constraint ck_store_notifications_payload_bounded check (pg_column_size(payload) <= 16384),
  -- An unauthenticated notification may be recorded for forensics but must
  -- never be marked processed. This makes "we acted on a forged notification"
  -- unrepresentable rather than merely unlikely.
  constraint ck_store_notifications_unverified_not_processed
    check (signature_verified or processing_status <> 'processed'),
  constraint ck_store_notifications_delivery_count check (delivery_count >= 1)
);

create unique index uq_store_notifications_identity
  on store_notifications (store, notification_id);
create index idx_store_notifications_purchase on store_notifications (store_purchase_id)
  where store_purchase_id is not null;
create index idx_store_notifications_unverified on store_notifications (received_at desc)
  where not signature_verified;

comment on table store_notifications is
  'S1 — server-to-server notification ledger. Provides idempotency; the payload is never acted on directly.';

alter table store_notifications enable row level security;
alter table store_notifications force row level security;
-- No parent-facing policy at all. A parent has no business reading a store's
-- internal event stream, and there is nothing here they need.

-- -----------------------------------------------------------------------------
-- 3. Mapping a store product to one of our plans
-- -----------------------------------------------------------------------------
-- The store's catalogue is maintained in App Store Connect and Play Console;
-- ours is `subscription_plans`. They are separate systems edited by different
-- people, and a purchase of a product we no longer sell must still be honoured.
--
-- A table rather than configuration, so adding a store product is a data change
-- and so an unmapped product is a visible row rather than a silent fallback to
-- the free plan.

create table store_product_map (
  id         uuid        primary key default app.gen_uuid_v7(),
  store      text        not null,
  product_id text        not null,
  plan_id    uuid        not null,
  is_active  boolean     not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint fk_store_product_map_plan
    foreign key (plan_id) references subscription_plans (id) on delete restrict,
  constraint ck_store_product_map_store check (store in ('apple_iap', 'google_play'))
);

create unique index uq_store_product_map on store_product_map (store, product_id);

create trigger trg_store_product_map_touch
  before update on store_product_map
  for each row execute function app.touch_updated_at();

comment on table store_product_map is
  'S0 — store product identifier to plan. No personal data. An unmapped product is a visible gap, not a silent free tier.';

alter table store_product_map enable row level security;
alter table store_product_map force row level security;

create policy store_product_map_select on store_product_map
  for select to authenticated, anon using (is_active);

grant select on store_product_map to authenticated, anon;

-- -----------------------------------------------------------------------------
-- 4. Claiming a purchase
-- -----------------------------------------------------------------------------
-- SECURITY DEFINER because a parent has no INSERT on `store_purchases`, and
-- must not: the whole point is that the row is written from the STORE's answer.
--
-- The function's contract is narrow on purpose. It takes a state the caller
-- obtained from the store, and it refuses outright if the transaction already
-- belongs to somebody else — returning the conflicting parent so the caller can
-- record the collision rather than merely failing.

create or replace function app.claim_store_purchase(
  p_parent_id               uuid,
  p_store                   text,
  p_original_transaction_id text,
  p_latest_transaction_id   text,
  p_product_id              text,
  p_state                   text,
  p_expires_at              timestamptz,
  p_grace_ends_at           timestamptz,
  p_auto_renewing           boolean,
  p_environment             text,
  p_verified_at             timestamptz,
  p_refunded_at             timestamptz default null
)
returns table (outcome text, purchase_id uuid, owner_parent_id uuid)
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_existing store_purchases;
  v_id       uuid;
begin
  select * into v_existing
    from store_purchases
   where store = p_store and original_transaction_id = p_original_transaction_id
   for update;

  if found and v_existing.parent_id is distinct from p_parent_id then
    -- The same purchase, presented under a different account. Refused, and the
    -- caller is told whose it is so the attempt can be recorded.
    return query select 'owned_by_another'::text, v_existing.id, v_existing.parent_id;
    return;
  end if;

  if found then
    -- Ordering by the STORE's clock. A notification that arrives late must not
    -- overwrite a newer answer we already have.
    if v_existing.verified_at >= p_verified_at then
      return query select 'stale'::text, v_existing.id, v_existing.parent_id;
      return;
    end if;

    update store_purchases
       set latest_transaction_id = coalesce(p_latest_transaction_id, latest_transaction_id),
           product_id            = p_product_id,
           state                 = p_state,
           expires_at            = p_expires_at,
           grace_period_ends_at  = p_grace_ends_at,
           auto_renewing         = p_auto_renewing,
           environment           = p_environment,
           verified_at           = p_verified_at,
           refunded_at           = coalesce(p_refunded_at, refunded_at)
     where id = v_existing.id;

    return query select 'updated'::text, v_existing.id, v_existing.parent_id;
    return;
  end if;

  insert into store_purchases
    (parent_id, store, original_transaction_id, latest_transaction_id, product_id,
     state, expires_at, grace_period_ends_at, auto_renewing, environment,
     verified_at, refunded_at)
  values
    (p_parent_id, p_store, p_original_transaction_id, p_latest_transaction_id, p_product_id,
     p_state, p_expires_at, p_grace_ends_at, p_auto_renewing, p_environment,
     p_verified_at, p_refunded_at)
  returning id into v_id;

  return query select 'created'::text, v_id, p_parent_id;
end;
$$;

comment on function app.claim_store_purchase is
  'Records the store''s answer about a purchase. Refuses a transaction already owned by another parent, and ignores an answer older than the one held.';

-- -----------------------------------------------------------------------------
-- 5. What a store purchase entitles, right now
-- -----------------------------------------------------------------------------
-- Deadlines pass whether or not a notification arrives to say so. Both stores
-- eventually tell us; neither tells us promptly. Between the two lies a window,
-- and this is what stops it being free service.

create or replace function app.store_entitlement(
  p_parent_id uuid,
  p_now       timestamptz default now()
)
returns table (
  purchase_id      uuid,
  store            text,
  product_id       text,
  stored_state     text,
  effective_state  text,
  entitled         boolean,
  expires_at       timestamptz,
  grace_ends_at    timestamptz,
  auto_renewing    boolean,
  plan_code        text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select sp.id,
         sp.store,
         sp.product_id,
         sp.state,
         case
           when sp.state = 'grace_period'
                and sp.grace_period_ends_at is not null
                and sp.grace_period_ends_at <= p_now                     then 'expired'
           when sp.state in ('active', 'trial', 'cancelled')
                and sp.expires_at is not null
                and sp.expires_at <= p_now                               then 'expired'
           else sp.state
         end,
         case
           when sp.state = 'grace_period'
             then coalesce(sp.grace_period_ends_at > p_now, true)
           when sp.state in ('active', 'trial', 'cancelled')
             then coalesce(sp.expires_at > p_now, true)
           else false
         end,
         sp.expires_at,
         sp.grace_period_ends_at,
         sp.auto_renewing,
         p.code
    from store_purchases sp
    left join store_product_map m on m.store = sp.store and m.product_id = sp.product_id
    left join subscription_plans p on p.id = m.plan_id
   where sp.parent_id = p_parent_id
   order by case sp.state
              when 'active'       then 1
              when 'trial'        then 2
              when 'grace_period' then 3
              when 'cancelled'    then 4
              when 'on_hold'      then 5
              when 'paused'       then 6
              else 7
            end,
            sp.verified_at desc
   limit 1;
$$;

comment on function app.store_entitlement is
  'The resolved store entitlement for a parent. Applies elapsed deadlines that no notification has yet reported.';

-- -----------------------------------------------------------------------------
-- 6. Purchases due a re-check
-- -----------------------------------------------------------------------------
-- Synchronisation exists because notifications are unreliable, not because they
-- are absent. A subscription that should be live and has not been confirmed
-- recently is asked about again.

create or replace function app.store_purchases_needing_sync(
  p_older_than_hours int default 24,
  p_limit            int default 100,
  p_now              timestamptz default now()
)
returns table (
  purchase_id             uuid,
  parent_id               uuid,
  store                   text,
  original_transaction_id text,
  state                   text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select sp.id, sp.parent_id, sp.store, sp.original_transaction_id, sp.state
    from store_purchases sp
   where sp.state in ('active', 'trial', 'grace_period', 'on_hold')
     and sp.verified_at < p_now - make_interval(hours => p_older_than_hours)
   order by sp.verified_at
   limit p_limit;
$$;

comment on function app.store_purchases_needing_sync is
  'Store subscriptions that should still be live and have not been confirmed recently.';

-- -----------------------------------------------------------------------------
-- 7. Store rails are already in the enums
-- -----------------------------------------------------------------------------
-- `apple_iap` and `google_play` were in every rail CHECK constraint from the
-- first billing migration, so a subscription backed by a store purchase needs
-- no schema change to record which store it came from.
