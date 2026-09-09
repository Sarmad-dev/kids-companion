-- =============================================================================
-- Transcript retention: the control that deleted nothing
-- =============================================================================
--
-- `parental_controls.transcript_retention_days` has been a per-child setting a
-- parent could change since the schema was written, and
-- `RETENTION_TRANSCRIPT_DAYS` has been a configured operator policy. NOTHING
-- HAS EVER DELETED A MESSAGE BY AGE. No purge job, no function, no sweep.
--
-- A retention control a parent can set, that does nothing, is worse than not
-- offering one: it is a privacy promise the product does not keep, made to
-- somebody who took it seriously enough to change it.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- REDACTION IN PLACE, NOT DELETION OF THE ROW
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The sensitive thing is what the child SAID. The row also carries the fact
-- that a turn happened, its role, its position in the conversation, and what it
-- cost — none of which is content.
--
-- Deleting rows would take more than the transcript with it:
--
--   `content_flags.message_id` is ON DELETE CASCADE. Deleting messages deletes
--   the safety flags attached to them — so a parent shortening retention to
--   seven days would silently erase the record that anything was ever flagged
--   about their child. A retention setting must not be a way to wipe safety
--   history, deliberately or otherwise.
--
--   `conversations.message_count` and the learning rollups would stop agreeing
--   with the rows behind them.
--
-- So the ciphertext is OVERWRITTEN — not soft-deleted, not flagged for later —
-- and the skeleton stays. `messages.status` already had a `redacted` value
-- waiting for this, and `child_id` is already denormalised onto the row with a
-- comment saying it exists "so the retention sweep can delete by child without
-- a join at all". This is the sweep that comment was written for.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHAT THIS DELIBERATELY DOES NOT DECIDE
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Whether a conversation carrying a SAFETY ESCALATION should outlive the
-- parent's retention setting.
--
-- The argument each way is real. Deleting means a safeguarding case can lose
-- the words it was about. Holding means the most sensitive data we have is kept
-- against the wishes of the family it belongs to — and when the disclosure
-- concerns a parent, that parent is the one who sets the retention.
--
-- That is the same question as Q-07 and belongs to the same child-protection
-- and legal review, not to a migration. What this does instead is make sure
-- deletion never destroys the RECORD: `content_flags` (categories, severity,
-- decision, review state) carries no content and survives untouched, and
-- `safety_escalations` is a separate content-free ledger. The fact that
-- something happened outlives the words. See docs/CHILD_SAFETY.md §6.2.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. When a message was redacted
-- -----------------------------------------------------------------------------
-- Separate from `status` on purpose. Overwriting the status of a BLOCKED message
-- with `redacted` would lose the fact that the safety pipeline stopped it, which
-- is exactly the kind of quiet evidence loss the section above is about.

alter table messages add column redacted_at timestamptz;

comment on column messages.redacted_at is
  'When the retention sweep overwrote this message content. Null means the transcript is still held.';

-- The sweep looks for old rows that have not been redacted yet. Partial, so the
-- index shrinks as the backlog is worked rather than growing with the table.
create index idx_messages_retention_pending
  on messages (created_at)
  where redacted_at is null;

-- -----------------------------------------------------------------------------
-- 2. The effective retention for one child
-- -----------------------------------------------------------------------------
-- ═══════════════════════════════════════════════════════════════════════════
-- THE SHORTER OF THE TWO WINS. ALWAYS.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The same rule the turn limits use — plan versus configured ceiling, lower
-- wins — and it matters more here. A parent asking for seven days must get
-- seven even if the operator policy is ninety. An operator policy of thirty
-- must cap a parent who set three hundred and sixty-five.
--
-- A child with no `parental_controls` row inherits the operator ceiling rather
-- than defaulting to "keep forever".

create or replace function app.effective_transcript_retention_days(
  p_child_id uuid,
  p_ceiling_days int
)
returns int
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select least(
    greatest(p_ceiling_days, 0),
    coalesce(
      (select pc.transcript_retention_days from parental_controls pc
        where pc.child_id = p_child_id),
      greatest(p_ceiling_days, 0)
    )
  );
$$;

comment on function app.effective_transcript_retention_days(uuid, int) is
  'The shorter of the parent setting and the operator ceiling. A parent asking for less always gets less.';

-- -----------------------------------------------------------------------------
-- 3. The sweep
-- -----------------------------------------------------------------------------
-- ═══════════════════════════════════════════════════════════════════════════
-- WHY A LIVE CONVERSATION IS PROTECTED
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Retention of 0 is permitted by the column's CHECK and is the strongest
-- privacy setting a parent can choose. Taken literally it would redact a
-- message the moment it was written — including the history the engine loads to
-- keep the current conversation coherent, so the character would lose the
-- thread mid-sentence while the child was still talking.
--
-- So a message is only redacted once its conversation is over. "Over" means
-- ended, OR started more than a day ago and still marked active — because a
-- five-year-old does not end conversations, and an abandoned session must not
-- become a transcript that is kept for ever.

create or replace function app.expire_transcripts(
  p_ceiling_days int,
  p_limit int default 500
)
returns table (child_id uuid, redacted int)
language sql
volatile
security definer
set search_path = public, pg_temp
as $$
  with due as (
    select m.id, m.child_id
      from messages m
      join conversations c on c.id = m.conversation_id
     where m.redacted_at is null
       and (c.ended_at is not null or c.started_at <= now() - interval '24 hours')
       and m.created_at <= now()
             - make_interval(days => app.effective_transcript_retention_days(m.child_id, p_ceiling_days))
     order by m.created_at
     limit p_limit
  ),
  wiped as (
    update messages m
       set content_ciphertext = ''::bytea,
           content_length     = 0,
           -- Overwritten only if it was an ordinary delivered turn. A `blocked`
           -- message keeps its status: that the safety pipeline stopped it is a
           -- fact worth more than the label `redacted`.
           status             = case when m.status = 'delivered' then 'redacted' else m.status end,
           redacted_at        = now()
      from due
     where m.id = due.id
    returning m.child_id
  )
  select w.child_id, count(*)::int as redacted
    from wiped w
   group by w.child_id;
$$;

comment on function app.expire_transcripts(int, int) is
  'Overwrites message content past its retention. The row survives so safety flags and counts do; the words do not.';

revoke all on function app.expire_transcripts(int, int) from public;

-- -----------------------------------------------------------------------------
-- 4. How much is still held
-- -----------------------------------------------------------------------------
-- So "is retention actually running?" is answerable, and so a parent-facing
-- answer to "what do you still have?" is possible without reading any of it.

create or replace function app.transcript_retention_status(p_child_id uuid)
returns table (held int, redacted int, oldest_held timestamptz)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select count(*) filter (where m.redacted_at is null)::int,
         count(*) filter (where m.redacted_at is not null)::int,
         min(m.created_at) filter (where m.redacted_at is null)
    from messages m
   where m.child_id = p_child_id;
$$;

comment on function app.transcript_retention_status(uuid) is
  'Counts only. How many messages are still held for a child, and how old the oldest is.';
