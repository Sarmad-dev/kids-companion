-- =============================================================================
-- analytics_events, audit_logs
-- =============================================================================
-- Two append-only tables with opposite purposes, deliberately not conflated.
--
--   analytics_events — product measurement. Pseudonymous, aggregate-oriented,
--                      opt-in, and deleted on request.
--   audit_logs       — accountability. Identified, never content, retained
--                      longer than the data it describes, and NOT deletable.

-- -----------------------------------------------------------------------------
-- analytics_events
-- -----------------------------------------------------------------------------
-- Event-level and pseudonymous. `parent_ref` and `child_ref` are salted rotating
-- hashes, not IDs: enough to correlate a session within a debugging window, not
-- enough to build a profile across months (docs/LOGGING.md §4.1).
--
-- The real IDs are still present as nullable foreign keys, and that is a
-- deliberate trade-off: without them, the erasure right could not be honoured,
-- because there would be no way to find a given family's events. They cascade on
-- delete, so "delete my data" reaches here too.
create table analytics_events (
  id           uuid        primary key default app.gen_uuid_v7(),
  parent_id    uuid,
  child_id     uuid,
  parent_ref   text        not null,
  child_ref    text,
  event_name   text        not null,
  -- Non-identifying properties only: counts, durations, enum values, feature
  -- flags. Bounded, because an unbounded jsonb column is where transcript text
  -- ends up when someone is in a hurry.
  properties   jsonb       not null default '{}'::jsonb,
  app_version  text,
  platform     text,
  occurred_at  timestamptz not null default now(),
  created_at   timestamptz not null default now(),

  constraint fk_analytics_events_parent
    foreign key (parent_id) references parents (id) on delete cascade,
  constraint fk_analytics_events_child
    foreign key (child_id) references children (id) on delete cascade,

  constraint ck_analytics_events_name check (event_name ~ '^[a-z0-9_]+\.[a-z0-9_.]+$'),
  constraint ck_analytics_events_platform
    check (platform is null or platform in ('ios', 'android', 'web')),
  constraint ck_analytics_events_properties_bounded check (pg_column_size(properties) <= 4096)
);

create index idx_analytics_events_name_occurred on analytics_events (event_name, occurred_at desc);
create index idx_analytics_events_parent on analytics_events (parent_id) where parent_id is not null;
create index idx_analytics_events_child on analytics_events (child_id) where child_id is not null;
-- Drives the retention sweep.
create index idx_analytics_events_occurred_at on analytics_events (occurred_at);

comment on table analytics_events is
  'S0/S1 — pseudonymous product analytics. Retention 395 days. Opt-in; off by default (PRIVACY.md §4).';
comment on column analytics_events.properties is
  'Non-identifying only. No transcript text, no child name, no raw audio reference.';
comment on column analytics_events.child_ref is
  'Salted rotating pseudonym. Rotating the salt bounds how long the corpus stays linkable.';

create trigger trg_analytics_events_append_only
  before update on analytics_events
  for each row execute function app.reject_update();

alter table analytics_events enable row level security;
alter table analytics_events force row level security;

-- A parent may read their own events — this is what makes the access and
-- portability rights implementable for analytics data (PRIVACY.md §6). They
-- cannot write them: a client-authored analytics row is not measurement.
create policy analytics_events_select_owner on analytics_events
  for select to authenticated using (parent_id = app.current_parent_id());

grant select on analytics_events to authenticated;

-- -----------------------------------------------------------------------------
-- audit_logs
-- -----------------------------------------------------------------------------
-- WHO did WHAT to WHICH resource, and whether it succeeded. Never the content of
-- what was accessed: an entry saying "an operator read a transcript" must not
-- contain the transcript, or the audit log becomes a second, less-protected copy
-- of the exact thing it exists to protect (docs/LOGGING.md §8).
create table audit_logs (
  id             uuid        primary key default app.gen_uuid_v7(),
  -- No foreign key, by design. Audit records outlive their subjects; a cascade
  -- from `parents` would erase the evidence of the deletion itself.
  actor_id       uuid,
  actor_type     text        not null,
  action         text        not null,
  resource_type  text        not null,
  resource_id    uuid,
  -- The child the action concerned, when applicable. Used to answer "who has
  -- touched this child's data?" — the question that matters in an incident.
  subject_child_id uuid,
  outcome        text        not null,
  -- Why a service-role operation was performed. Required for them, because an
  -- RLS-bypassing action without a stated reason is not auditable.
  justification  text,
  request_id     text,
  source_ip      inet,
  user_agent     text,
  -- Bounded non-content metadata: a rail name, a count, a policy version.
  -- A field VALUE here is a defect.
  metadata       jsonb       not null default '{}'::jsonb,
  -- `occurred_at` is when the action happened; `created_at` is when we wrote the
  -- record. They differ for anything batched or replayed, and the gap between
  -- them is itself a signal worth being able to see in an incident.
  occurred_at    timestamptz not null default now(),
  created_at     timestamptz not null default now(),

  constraint ck_audit_logs_actor_type
    check (actor_type in ('parent', 'child_session', 'system', 'operator', 'service_role')),
  constraint ck_audit_logs_outcome check (outcome in ('success', 'denied', 'error')),
  constraint ck_audit_logs_action check (action ~ '^[a-z0-9_]+\.[a-z0-9_.]+$'),
  constraint ck_audit_logs_metadata_bounded check (pg_column_size(metadata) <= 4096),
  -- An RLS-bypassing operation must say why it happened.
  constraint ck_audit_logs_service_role_justified
    check (actor_type <> 'service_role' or justification is not null)
);

create index idx_audit_logs_actor_occurred on audit_logs (actor_id, occurred_at desc);
create index idx_audit_logs_resource on audit_logs (resource_type, resource_id, occurred_at desc);
create index idx_audit_logs_child on audit_logs (subject_child_id, occurred_at desc)
  where subject_child_id is not null;

-- The security dashboard: authorization denials and refresh-token reuse over
-- time. These are the events worth alerting on (SECURITY.md §8).
create index idx_audit_logs_denied on audit_logs (occurred_at desc) where outcome = 'denied';
create index idx_audit_logs_service_role on audit_logs (occurred_at desc)
  where actor_type = 'service_role';

comment on table audit_logs is
  'S1 — append-only. Retention 730 days. Records actor/action/target/outcome, NEVER content.';
comment on column audit_logs.justification is
  'Required for service_role actions. An RLS-bypassing action without a reason is not auditable.';

-- Append-only, enforced. Personnel who can trigger audited actions must not be
-- able to edit or remove the record of them, and "we agreed not to update this
-- table" is not a control.
-- The stronger guard: UPDATE and DELETE both blocked. Safe here — and only here
-- — because audit_logs has no foreign key, so no cascade can be caught by it.
-- The retention sweep opts in explicitly via the `app.retention_sweep` GUC.
create trigger trg_audit_logs_append_only
  before update or delete on audit_logs
  for each row execute function app.reject_mutation();

alter table audit_logs enable row level security;
alter table audit_logs force row level security;

-- No policy and no SELECT grant for `authenticated`. The audit log is written by
-- system operations and read through a restricted, itself-audited path — never
-- by a request handler, and never by a parent. Read access fails at the
-- privilege check, before a policy is even consulted.
grant insert on audit_logs to authenticated;
