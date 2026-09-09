-- =============================================================================
-- content_flags — the safety record.
-- =============================================================================
-- One row per safety decision that stopped, redirected, or escalated something.
-- Deliberately broader than "a verdict on a message": a flag can attach to a
-- message, to a whole conversation, or to a speech-practice attempt, because the
-- review queue and the parent dashboard need one place to look.
--
-- Flags are shown to parents EVEN WHEN THE BLOCK WORKED. A parent finding out
-- their child asked about something concerning is the entire point of oversight;
-- hiding successful blocks to keep a dashboard looking clean would betray the
-- reason parents installed this (docs/CHILD_SAFETY.md §8).

create table content_flags (
  id               uuid        primary key default app.gen_uuid_v7(),
  -- Owning child, always present: it is what RLS resolves against, and what the
  -- retention sweep deletes by.
  child_id         uuid        not null,
  -- Exactly one subject. A flag about nothing is a bug.
  message_id       uuid,
  conversation_id  uuid,

  -- Which layer produced it. L1/L3 are model classifiers, L4 is deterministic,
  -- L5 is asynchronous review — see docs/CHILD_SAFETY.md §3.
  layer            text        not null,
  decision         text        not null,
  categories       text[]      not null default array[]::text[],
  severity         text        not null default 'low',
  confidence       real,

  -- Review workflow.
  status           text        not null default 'pending',
  reviewed_at      timestamptz,
  -- A pseudonymous reference to the reviewer, never a name. Reviewer identity
  -- lives in the audit log, under access control.
  reviewer_ref     text,
  parent_notified_at timestamptz,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  constraint fk_content_flags_child
    foreign key (child_id) references children (id) on delete cascade,
  constraint fk_content_flags_message
    foreign key (message_id) references messages (id) on delete cascade,
  constraint fk_content_flags_conversation
    foreign key (conversation_id) references conversations (id) on delete cascade,

  constraint ck_content_flags_layer check (layer in ('L1', 'L2', 'L3', 'L4', 'L5')),
  constraint ck_content_flags_decision
    check (decision in ('allowed', 'redirected', 'blocked', 'escalated')),
  constraint ck_content_flags_severity check (severity in ('low', 'medium', 'high', 'critical')),
  constraint ck_content_flags_status
    check (status in ('pending', 'reviewed', 'dismissed', 'escalated')),
  constraint ck_content_flags_confidence
    check (confidence is null or confidence between 0 and 1),
  -- A flag must point at something.
  constraint ck_content_flags_has_subject
    check (message_id is not null or conversation_id is not null),
  -- A reviewed flag records when. Without this, review latency — the metric that
  -- says whether the queue is actually being worked — cannot be computed.
  constraint ck_content_flags_reviewed_has_timestamp
    check (status = 'pending' or reviewed_at is not null),
  -- An escalation is never merely dismissed. Escalations are the disclosure
  -- path (docs/CHILD_SAFETY.md §6) and must resolve through the defined
  -- protocol, not by someone clearing a queue.
  constraint ck_content_flags_escalation_not_dismissed
    check (decision <> 'escalated' or status <> 'dismissed')
);

create index idx_content_flags_child_created on content_flags (child_id, created_at desc);
create index idx_content_flags_message on content_flags (message_id);
create index idx_content_flags_conversation on content_flags (conversation_id);

-- The safety dashboard: block rate by layer over time. A rate that suddenly
-- DROPS is as alarming as one that spikes — it usually means a classifier
-- stopped working (docs/CHILD_SAFETY.md §10).
create index idx_content_flags_layer_created on content_flags (layer, decision, created_at desc);

-- The review queue.
create index idx_content_flags_pending on content_flags (created_at)
  where status = 'pending';

-- Escalations, which are worked first and never in bulk.
create index idx_content_flags_escalated on content_flags (created_at desc)
  where decision = 'escalated';

create trigger trg_content_flags_touch
  before update on content_flags
  for each row execute function app.touch_updated_at();

comment on table content_flags is
  'S2 — safety decisions. Retention 365 days; outlives the message it describes so trends survive transcript expiry.';
comment on column content_flags.categories is
  'S2 — classifier category labels. NEVER the content that triggered the flag — that lives in the review queue, under access control.';
comment on column content_flags.reviewer_ref is
  'Pseudonymous. Reviewer identity is in audit_logs, not here.';

alter table content_flags enable row level security;
alter table content_flags force row level security;

-- Parents READ their children's flags. They cannot write, edit, or delete them:
-- a safety record a parent can erase is not a safety record.
create policy content_flags_select_owner on content_flags
  for select to authenticated using (app.owns_child(child_id));

grant select on content_flags to authenticated;
