-- =============================================================================
-- Reference tables: supported_languages, subscription_plans
-- =============================================================================
-- Global configuration, not user data. Both are readable by any authenticated
-- session and writable only under the service role — they are product content
-- that changes through review, not through a request handler.

-- -----------------------------------------------------------------------------
-- supported_languages
-- -----------------------------------------------------------------------------
-- A table rather than a CHECK constraint on a text column, because a language
-- carries data the application needs: writing direction for RTL layout, and
-- whether STT and TTS actually work for it. Urdu STT quality is the largest
-- technical risk in this product (docs/OPEN_QUESTIONS.md Q-01), so "supported"
-- has to be a per-capability fact, not a single boolean.
create table supported_languages (
  code           text        primary key,
  english_name   text        not null,
  native_name    text        not null,
  direction      text        not null default 'ltr',
  -- Capability flags are independent on purpose: a language can be good enough
  -- to read and write long before its child-speech recognition is usable.
  stt_supported  boolean     not null default false,
  tts_supported  boolean     not null default false,
  is_active      boolean     not null default false,
  sort_order     int         not null default 100,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint ck_supported_languages_code check (code ~ '^[a-z]{2}(-[A-Z]{2})?$'),
  constraint ck_supported_languages_direction check (direction in ('ltr', 'rtl'))
);

create index idx_supported_languages_active on supported_languages (sort_order) where is_active;

create trigger trg_supported_languages_touch
  before update on supported_languages
  for each row execute function app.touch_updated_at();

comment on table supported_languages is
  'S0 — reference data. No personal data.';

alter table supported_languages enable row level security;
alter table supported_languages force row level security;

create policy supported_languages_select_all on supported_languages
  for select to authenticated, anon using (is_active);

grant select on supported_languages to authenticated, anon;

-- -----------------------------------------------------------------------------
-- subscription_plans
-- -----------------------------------------------------------------------------
-- Entitlement limits live here, not in the application, so the answer to "how
-- many minutes may this child have today?" comes from one place that a support
-- engineer can read and a migration can change.
create table subscription_plans (
  id                       uuid        primary key default app.gen_uuid_v7(),
  code                     text        not null,
  display_name             text        not null,
  description              text        not null default '',
  tier                     text        not null,
  -- Minor units plus a currency code. Never a float.
  price_minor              int         not null default 0,
  currency                 char(3)     not null default 'PKR',
  billing_interval         text        not null default 'month',
  -- Entitlements.
  daily_minute_limit       int         not null,
  child_profile_limit      int         not null,
  weekly_story_limit       int,
  features                 jsonb       not null default '{}'::jsonb,
  -- Which rails may sell this plan. Pakistan's local wallets and app-store
  -- billing are in tension (docs/OPEN_QUESTIONS.md Q-02); until that resolves,
  -- a plan states which rails it is actually available through.
  available_rails          text[]      not null default array[]::text[],
  is_active                boolean     not null default true,
  sort_order               int         not null default 100,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),

  constraint ck_subscription_plans_code check (code ~ '^[a-z0-9_]{2,40}$'),
  constraint ck_subscription_plans_tier check (tier in ('free', 'paid')),
  constraint ck_subscription_plans_interval
    check (billing_interval in ('month', 'year', 'once', 'none')),
  constraint ck_subscription_plans_price_nonnegative check (price_minor >= 0),
  constraint ck_subscription_plans_limits
    check (daily_minute_limit >= 0 and child_profile_limit >= 1),
  -- A free plan is free. Catching this here stops a pricing typo from silently
  -- charging for what the marketing page calls free.
  constraint ck_subscription_plans_free_is_free
    check (tier <> 'free' or price_minor = 0)
);

create unique index uq_subscription_plans_code on subscription_plans (code);
create index idx_subscription_plans_active on subscription_plans (sort_order) where is_active;

create trigger trg_subscription_plans_touch
  before update on subscription_plans
  for each row execute function app.touch_updated_at();

comment on table subscription_plans is
  'S0 — plan catalogue and entitlement limits. No personal data.';

alter table subscription_plans enable row level security;
alter table subscription_plans force row level security;

create policy subscription_plans_select_active on subscription_plans
  for select to authenticated, anon using (is_active);

grant select on subscription_plans to authenticated, anon;
