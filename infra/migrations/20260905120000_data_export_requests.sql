-- -----------------------------------------------------------------------------
-- Data export requests
-- -----------------------------------------------------------------------------
-- PRIVACY.md and the privacy centre both promise a parent can export everything
-- we hold — "a JSON file with every profile, transcript we still hold, and
-- setting", emailed as a link that works for 24 hours. Deletion had an endpoint
-- (`DELETE /v1/parents/me`); export had a promise and nowhere to record one, so
-- the button had nothing to press.
--
-- WHY A TABLE AND NOT A SYNCHRONOUS RESPONSE
--
-- An export is every transcript, every profile, every setting, and every
-- practice attempt for a whole family. Building it inside a request means a
-- request that holds a connection for as long as the largest family takes, and
-- a timeout that leaves a parent with no idea whether it happened. It is a job,
-- so it is a row a job can pick up.
--
-- WHY THE ROW HOLDS NO DATA
--
-- Only that an export was ASKED FOR, by whom, and what happened to it. The
-- artefact itself lives in the same expiring object storage as everything else
-- transient, and `download_key` is the same opaque handle shape the audio
-- ledger uses — never a path a client constructed, never derived from anything
-- about the family. A table of ready-made archives of children's conversations
-- is precisely the table that should not exist for longer than it must, which is
-- what `expires_at` is for.
--
-- WHY THERE IS NO UPDATE OR DELETE POLICY
--
-- A parent may ask for an export and may see the state of their own requests.
-- They may not mark one complete, retarget it, or make one disappear — those
-- are the system's writes, performed by the worker as `system`, and an audit
-- that a parent can edit is not an audit.
-- -----------------------------------------------------------------------------

create table data_export_requests (
  id            uuid        primary key default app.gen_uuid_v7(),
  parent_id     uuid        not null,
  status        text        not null default 'pending',
  -- The opaque storage handle for the finished archive. Null until it exists.
  download_key  text,
  byte_size     int,
  -- When the download stops working. Null until there is something to expire.
  expires_at    timestamptz,
  requested_at  timestamptz not null default now(),
  completed_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  -- Why it failed, in operator language. Never shown to a parent verbatim.
  failure_reason text,

  constraint fk_data_export_requests_parent
    foreign key (parent_id) references parents (id) on delete cascade,
  constraint ck_data_export_requests_status
    check (status in ('pending', 'running', 'ready', 'failed', 'expired')),
  -- A ready export has something to download and a date it stops working.
  constraint ck_data_export_requests_ready
    check (status <> 'ready' or (download_key is not null and expires_at is not null))
);

-- The worker's queue: oldest pending first.
create index idx_data_export_requests_pending
  on data_export_requests (requested_at)
  where status in ('pending', 'running');

create index idx_data_export_requests_parent
  on data_export_requests (parent_id, requested_at desc);

-- One outstanding request per parent. A parent who taps twice has asked once;
-- without this, an impatient tap becomes two full exports of the same family.
create unique index uq_data_export_requests_outstanding
  on data_export_requests (parent_id)
  where status in ('pending', 'running');

create trigger trg_data_export_requests_touch
  before update on data_export_requests
  for each row execute function app.touch_updated_at();

comment on table data_export_requests is
  'A parent asked for their data. Holds no data — only that it was asked for, and where the archive went.';
comment on column data_export_requests.download_key is
  'Opaque storage handle, produced by the storage adapter. Never a client-constructed path.';
-- `requested_at` and `created_at` are the same instant today and are both kept:
-- the first is the domain fact a parent is shown, the second is the row-level
-- convention every table here carries. A backfill or an admin re-insert would
-- move one and not the other, and it should be visible when it does.
comment on column data_export_requests.requested_at is
  'When the parent asked. The domain fact, not the row bookkeeping.';

alter table data_export_requests enable row level security;
alter table data_export_requests force row level security;

create policy data_export_requests_select_own on data_export_requests
  for select to authenticated
  using (parent_id = app.current_parent_id());

create policy data_export_requests_insert_own on data_export_requests
  for insert to authenticated
  with check (parent_id = app.current_parent_id());

grant select, insert on data_export_requests to authenticated;
