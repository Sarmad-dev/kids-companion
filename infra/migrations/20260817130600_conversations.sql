-- =============================================================================
-- conversations, messages
-- =============================================================================
-- Vocabulary: a "turn" is the round trip (a child utterance plus the companion's
-- reply) and is the unit the latency budget and cost metrics use. A "message" is
-- one row — one side of that exchange.

create table conversations (
  id              uuid        primary key default app.gen_uuid_v7(),
  child_id        uuid        not null,
  character_id    uuid        not null,
  language_code   text        not null default 'en',
  status          text        not null default 'active',
  -- Denormalised counters, maintained by the application rather than a trigger:
  -- a trigger on the highest-write table in the system buys convenience at the
  -- cost of throughput on the one path a child is standing in front of.
  message_count   int         not null default 0,
  total_cost_usd  numeric(10, 6) not null default 0,
  started_at      timestamptz not null default now(),
  ended_at        timestamptz,
  end_reason      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint fk_conversations_child
    foreign key (child_id) references children (id) on delete cascade,
  -- RESTRICT, not CASCADE: retiring a character must never delete the
  -- conversations a child had with it. Characters are retired, not deleted.
  constraint fk_conversations_character
    foreign key (character_id) references ai_characters (id) on delete restrict,
  constraint fk_conversations_language
    foreign key (language_code) references supported_languages (code) on delete restrict,

  constraint ck_conversations_status
    check (status in ('active', 'ended', 'flagged')),
  constraint ck_conversations_end_reason
    check (end_reason is null or end_reason in
      ('child_ended', 'timeout', 'quota_exhausted', 'parent_ended', 'safety_ended', 'error')),
  constraint ck_conversations_ended_after_started
    check (ended_at is null or ended_at >= started_at),
  -- An ended conversation says why. Without this, "why did sessions end?" is
  -- unanswerable, and that is the metric that reveals a broken quota or a
  -- safety pipeline ending sessions unexpectedly.
  constraint ck_conversations_ended_has_reason
    check (status <> 'ended' or end_reason is not null)
);

create index idx_conversations_child_started on conversations (child_id, started_at desc);
create index idx_conversations_character on conversations (character_id);
create index idx_conversations_active on conversations (child_id) where status = 'active';

create trigger trg_conversations_touch
  before update on conversations
  for each row execute function app.touch_updated_at();

comment on table conversations is
  'S2 — a session between one child and one character.';

-- -----------------------------------------------------------------------------

create table messages (
  id                  uuid        primary key default app.gen_uuid_v7(),
  conversation_id     uuid        not null,
  -- Denormalised from conversations so RLS resolves ownership with one join
  -- instead of two, and so the retention sweep can delete by child without a
  -- join at all. Kept honest by a trigger below.
  child_id            uuid        not null,
  role                text        not null,
  -- Ordinal within the conversation. Explicit rather than inferred from
  -- created_at: two messages can share a millisecond, and ordering a child's
  -- conversation wrongly is user-visible nonsense.
  sequence            int         not null,
  status              text        not null default 'delivered',

  -- S3 — the most sensitive column in the database.
  --
  -- Application-layer encryption ON TOP OF at-rest encryption, so a database
  -- dump alone does not read a child's conversations (SECURITY.md §6). The key
  -- id is per row, which makes rotation a background re-encryption rather than
  -- a maintenance window. The crypto module lands with the conversation engine;
  -- the column shape is correct now so that arrival needs no migration.
  content_ciphertext  bytea       not null,
  content_key_id      text        not null,
  content_length      int         not null default 0,

  -- Operational metrics. Cost per conversation is a first-class metric because
  -- unit economics are an existential constraint (ARCHITECTURE.md C3).
  stt_confidence      real,
  input_tokens        int,
  output_tokens       int,
  cost_usd            numeric(10, 6),
  latency_ms          int,

  created_at          timestamptz not null default now(),

  constraint fk_messages_conversation
    foreign key (conversation_id) references conversations (id) on delete cascade,
  constraint fk_messages_child
    foreign key (child_id) references children (id) on delete cascade,

  constraint ck_messages_role check (role in ('child', 'companion')),
  constraint ck_messages_status check (status in ('delivered', 'blocked', 'redacted')),
  constraint ck_messages_sequence_nonnegative check (sequence >= 0),
  constraint ck_messages_confidence_range
    check (stt_confidence is null or stt_confidence between 0 and 1)
);

create unique index uq_messages_conversation_sequence on messages (conversation_id, sequence);
create index idx_messages_conversation_created on messages (conversation_id, created_at);
create index idx_messages_child_id on messages (child_id);
-- Drives the retention sweep without scanning the table.
create index idx_messages_created_at on messages (created_at);

comment on table messages is
  'S3 — conversation content, encrypted at the application layer. Default retention 90 days.';
comment on column messages.content_ciphertext is
  'S3 — child speech and model output. NEVER logged, never in analytics, never leaves production.';
comment on column messages.child_id is
  'Denormalised for RLS and retention. Kept consistent with the parent conversation by trigger.';

-- The denormalised child_id is a correctness risk if it can disagree with the
-- conversation it belongs to — that would make an RLS policy answer the wrong
-- ownership question. Derive it rather than trusting the caller.
create or replace function app.set_message_child_id()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  select c.child_id into new.child_id from conversations c where c.id = new.conversation_id;
  if new.child_id is null then
    raise exception 'conversation % does not exist', new.conversation_id
      using errcode = 'foreign_key_violation';
  end if;
  return new;
end;
$$;

create trigger trg_messages_set_child_id
  before insert on messages
  for each row execute function app.set_message_child_id();

-- -----------------------------------------------------------------------------
-- RLS
-- -----------------------------------------------------------------------------
alter table conversations enable row level security;
alter table conversations force row level security;

create policy conversations_select_owner on conversations
  for select to authenticated using (app.owns_child(child_id));

create policy conversations_insert_owner on conversations
  for insert to authenticated with check (app.owns_child(child_id));

create policy conversations_update_owner on conversations
  for update to authenticated
  using (app.owns_child(child_id))
  with check (app.owns_child(child_id));

create policy conversations_delete_owner on conversations
  for delete to authenticated using (app.owns_child(child_id));

alter table messages enable row level security;
alter table messages force row level security;

create policy messages_select_owner on messages
  for select to authenticated using (app.owns_child(child_id));

create policy messages_insert_owner on messages
  for insert to authenticated with check (app.owns_child(child_id));

create policy messages_delete_owner on messages
  for delete to authenticated using (app.owns_child(child_id));

-- No UPDATE policy: conversation history is append-only from the application's
-- point of view. Editing what a child said, or what the companion replied, would
-- corrupt the record a parent relies on for oversight.

grant select, insert, update, delete on conversations to authenticated;
grant select, insert, delete on messages to authenticated;
