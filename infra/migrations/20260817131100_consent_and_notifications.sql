-- =============================================================================
-- consent_records, notifications
-- =============================================================================

-- -----------------------------------------------------------------------------
-- consent_records
-- -----------------------------------------------------------------------------
-- Append-only. Each grant and each withdrawal is a NEW ROW, never an update to
-- an old one, because the question a regulator or a parent asks is not "what is
-- consented now?" but "what was consented, to what text, on what date?"
-- Overwriting a consent row destroys exactly the evidence the record exists to
-- provide (PRIVACY.md §4.2).
--
-- Consent is per-purpose and unbundled: the core service works with every
-- optional consent refused. A consent that is a precondition for the service is
-- not consent.
create table consent_records (
  id                uuid        primary key default app.gen_uuid_v7(),
  parent_id         uuid        not null,
  -- Consent may be about a specific child (transcript retention for that child)
  -- or account-wide (analytics). NULL means account-wide.
  child_id          uuid,
  consent_type      text        not null,
  granted           boolean     not null,
  -- The exact version of the text shown. A hash rather than the text itself, so
  -- the record is small and the canonical wording lives in version control.
  policy_version    text        not null,
  policy_text_hash  text        not null,
  -- Collected for evidentiary value; both are S1 and redacted from logs.
  source_ip         inet,
  user_agent        text,
  recorded_at       timestamptz not null default now(),
  created_at        timestamptz not null default now(),

  constraint fk_consent_records_parent
    foreign key (parent_id) references parents (id) on delete cascade,
  constraint fk_consent_records_child
    foreign key (child_id) references children (id) on delete cascade,

  constraint ck_consent_records_type
    check (consent_type in (
      'terms_of_service',
      'privacy_policy',
      'child_data_processing',
      'transcript_retention',
      'audio_retention',
      'product_analytics',
      'model_improvement',
      'marketing_email')),
  constraint ck_consent_records_policy_version check (policy_version ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  constraint ck_consent_records_hash check (policy_text_hash ~ '^[0-9a-f]{64}$')
);

create index idx_consent_records_parent_type
  on consent_records (parent_id, consent_type, recorded_at desc);
create index idx_consent_records_child on consent_records (child_id) where child_id is not null;

comment on table consent_records is
  'S1 — append-only consent ledger. Each grant AND each withdrawal is a new row; rows are never updated.';
comment on column consent_records.policy_text_hash is
  'SHA-256 of the exact text shown, so what was agreed to is provable later.';

create trigger trg_consent_records_append_only
  before update on consent_records
  for each row execute function app.reject_update();

alter table consent_records enable row level security;
alter table consent_records force row level security;

-- A parent can read and add to their own consent history. They cannot alter it —
-- the append-only trigger blocks that even for the service role.
create policy consent_records_select_owner on consent_records
  for select to authenticated using (parent_id = app.current_parent_id());

create policy consent_records_insert_owner on consent_records
  for insert to authenticated with check (parent_id = app.current_parent_id());

grant select, insert on consent_records to authenticated;

-- Current consent state, derived from the ledger rather than stored. The most
-- recent row per (parent, child, type) wins.
create view current_consents as
select distinct on (parent_id, coalesce(child_id, '00000000-0000-0000-0000-000000000000'::uuid), consent_type)
  parent_id,
  child_id,
  consent_type,
  granted,
  policy_version,
  recorded_at
from consent_records
order by
  parent_id,
  coalesce(child_id, '00000000-0000-0000-0000-000000000000'::uuid),
  consent_type,
  recorded_at desc;

comment on view current_consents is
  'The latest consent decision per parent/child/type. Derived — the ledger is the source of truth.';

grant select on current_consents to authenticated;

-- -----------------------------------------------------------------------------
-- notifications
-- -----------------------------------------------------------------------------
-- Parent-facing only. There is no child-facing notification surface anywhere in
-- this product: no streaks, no "your friend misses you", no re-engagement push
-- (docs/CHILD_SAFETY.md rule S-9). Engagement mechanics work on children far
-- better than on adults, which is exactly why they are prohibited.
create table notifications (
  id            uuid        primary key default app.gen_uuid_v7(),
  parent_id     uuid        not null,
  child_id      uuid,
  kind          text        not null,
  channel       text        not null default 'in_app',
  -- Human-readable, and deliberately content-free about what the child said.
  -- "A conversation was flagged for review" — never the utterance itself. The
  -- content lives behind an authenticated dashboard view, not in a push payload
  -- that surfaces on a lock screen.
  title         text        not null,
  body          text        not null,
  -- What to open when tapped.
  resource_type text,
  resource_id   uuid,
  status        text        not null default 'pending',
  sent_at       timestamptz,
  read_at       timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint fk_notifications_parent
    foreign key (parent_id) references parents (id) on delete cascade,
  constraint fk_notifications_child
    foreign key (child_id) references children (id) on delete cascade,

  constraint ck_notifications_kind
    check (kind in (
      'safety_flag', 'safety_escalation', 'daily_summary', 'weekly_summary',
      'quota_reached', 'subscription_renewed', 'subscription_failed',
      'data_export_ready', 'account_deletion_scheduled', 'security_alert')),
  constraint ck_notifications_channel check (channel in ('in_app', 'email', 'push')),
  constraint ck_notifications_status
    check (status in ('pending', 'sent', 'read', 'dismissed', 'failed')),
  constraint ck_notifications_sent_has_timestamp
    check (status not in ('sent', 'read') or sent_at is not null),
  constraint ck_notifications_body_bounded check (char_length(body) <= 500)
);

create index idx_notifications_parent_created on notifications (parent_id, created_at desc);
create index idx_notifications_unread on notifications (parent_id, created_at desc)
  where status in ('pending', 'sent');
create index idx_notifications_pending_delivery on notifications (created_at)
  where status = 'pending';

create trigger trg_notifications_touch
  before update on notifications
  for each row execute function app.touch_updated_at();

comment on table notifications is
  'S1 — parent-facing only. No child-facing notifications exist in this product.';
comment on column notifications.body is
  'S1 — must never contain what a child said. Reference the resource; do not quote it.';

alter table notifications enable row level security;
alter table notifications force row level security;

create policy notifications_select_owner on notifications
  for select to authenticated using (parent_id = app.current_parent_id());

-- A parent may mark as read or dismissed. They cannot create notifications —
-- those are raised by the system, and a parent able to forge a "safety flag"
-- notification would be able to forge reassurance too.
create policy notifications_update_owner on notifications
  for update to authenticated
  using (parent_id = app.current_parent_id())
  with check (parent_id = app.current_parent_id());

grant select, update on notifications to authenticated;
