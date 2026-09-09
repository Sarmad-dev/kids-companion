-- =============================================================================
-- Append-only vs. the right to erasure
-- =============================================================================
--
-- `learning_events` is append-only, enforced by a BEFORE UPDATE trigger, and its
-- provenance columns are `on delete set null`:
--
--     conversation_id     uuid references conversations (id)     on delete set null
--     speech_practice_id  uuid references speech_practice (id)   on delete set null
--
-- Those two rules contradict each other. A set-null IS an update, so the trigger
-- rejects the foreign key's own action and DELETING A CONVERSATION FAILS.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHY THIS WAS INVISIBLE UNTIL NOW
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Nothing ever wrote a learning event carrying a conversation id, so the FK
-- action never had a row to perform. Wiring the recorder up gave it one, and the
-- suite failed on a parental-controls test that clears conversations between
-- cases — the cheapest possible place to find out.
--
-- The path that matters is not that test. `delete from children` cascades to
-- conversations, and the deletion of a child's data is the one operation that
-- must not fail. It would have failed here, or worse, failed intermittently:
-- the cascade to `learning_events` (delete) and the cascade to `conversations`
-- (set null) have no guaranteed order between them.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHAT IS ALLOWED, AND WHAT REMAINS FORBIDDEN
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The original author chose `set null` rather than `cascade` deliberately, and
-- that choice is right: a learning event is a COUNT, not content. Deleting a
-- transcript should drop the link to it, not rewrite the fact that a child
-- practised that day.
--
-- So this permits exactly that one update — a provenance column moving TO NULL,
-- every other column identical — and raises on anything else. The measurement
-- itself, its child, its type, its payload, its timestamps and its idempotency
-- key are as immutable as they were before.
--
-- No role holds UPDATE on this table (parents have SELECT only), so the widened
-- door is reachable only by the system role, which could bypass any trigger in
-- any case. This narrows what a bug can do, not what an administrator can.
-- =============================================================================

create or replace function app.reject_learning_event_update()
returns trigger
language plpgsql
as $$
begin
  if new.id is not distinct from old.id
     and new.child_id is not distinct from old.child_id
     and new.event_type is not distinct from old.event_type
     and new.skill_key is not distinct from old.skill_key
     and new.payload is not distinct from old.payload
     and new.occurred_at is not distinct from old.occurred_at
     and new.created_at is not distinct from old.created_at
     and new.idempotency_key is not distinct from old.idempotency_key
     -- Unchanged, or cleared. Never repointed at a different conversation.
     and (new.conversation_id is not distinct from old.conversation_id
          or new.conversation_id is null)
     and (new.speech_practice_id is not distinct from old.speech_practice_id
          or new.speech_practice_id is null)
  then
    return new;
  end if;

  raise exception 'table %.% is append-only and cannot be updated',
    tg_table_schema, tg_table_name;
end;
$$;

comment on function app.reject_learning_event_update() is
  'Append-only, except for a foreign key clearing provenance when a conversation or practice session is deleted. Erasure must never be blocked by immutability.';

drop trigger if exists trg_learning_events_append_only on learning_events;

create trigger trg_learning_events_append_only
  before update on learning_events
  for each row execute function app.reject_learning_event_update();
