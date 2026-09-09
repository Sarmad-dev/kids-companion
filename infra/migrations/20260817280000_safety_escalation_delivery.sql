-- Safety escalation delivery.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHAT THIS CLOSES, AND WHAT IT DELIBERATELY DOES NOT
-- ═══════════════════════════════════════════════════════════════════════════
--
-- docs/CHILD_SAFETY.md §6.1 lists what holds regardless of how Q-07 resolves.
-- Item 5 is "escalation is recorded and routed to a defined human path". The
-- RECORDING half already existed — `content_flags` carries the escalated turn,
-- and `audit_logs` carries `safety.escalation.raised`. The ROUTING half did
-- not: `SAFETY_ESCALATION_WEBHOOK_URL` was required for production to boot and
-- read by nothing, so a disclosure produced a log line and reached no human.
--
-- This table is the delivery ledger that makes routing durable. An escalation
-- that cannot be delivered is not lost; it stays `pending` and is retried.
--
-- WHAT THIS DOES NOT DECIDE — and must not:
--
--   * WHO is notified. §6.2 is explicit that the obvious answer, the parent, is
--     UNSAFE when the disclosure concerns the parent. That is a child-protection
--     and legal decision, not an engineering one. This table routes to whatever
--     endpoint the operator configures, and takes no view on who reads it.
--   * WHAT a reviewer sees beyond a reference. See the content rule below.
--   * WHETHER a mandatory-reporting duty applies.
--
-- Q-07 remains open and still blocks launch. What changes here is that the
-- mechanism exists, so resolving Q-07 becomes a configuration and process
-- decision rather than an unwritten feature.

-- ═══════════════════════════════════════════════════════════════════════════
-- THE CONTENT RULE
-- ═══════════════════════════════════════════════════════════════════════════
--
-- There is NO column here for the child's utterance, the model's reply, a
-- transcript, or the child's name — and there must never be one. This row is a
-- POINTER: it says an escalation happened, why, and where to look. A trained
-- reviewer opens the case in a system with proper access control; the
-- disclosure itself never travels in a webhook payload and never sits in a
-- delivery queue.
--
-- §6.2 lists "what is retained, for how long, and who may read it" as
-- unresolved. Storing the least possible is the only safe posture while that
-- is true.

create table safety_escalations (
  id               uuid        primary key default app.gen_uuid_v7(),
  child_id         uuid        not null,
  conversation_id  uuid,

  -- Which of the three rules in services/safety/src/escalation.ts fired.
  reason           text        not null,
  categories       text[]      not null default array[]::text[],
  severity         text        not null default 'critical',
  occurred_at      timestamptz not null default now(),

  -- Delivery state. `pending` is the only state that means "a human has not
  -- been told yet", and it is what the worker sweeps for.
  delivery_status  text        not null default 'pending',
  attempts         int         not null default 0,
  last_attempt_at  timestamptz,
  -- A SHORT reason, never a response body: an endpoint that echoes the request
  -- back would otherwise put the payload in this column.
  last_error       text,
  delivered_at     timestamptz,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  constraint fk_safety_escalations_child
    foreign key (child_id) references children (id) on delete cascade,
  -- A deleted conversation must not delete the record that one happened.
  constraint fk_safety_escalations_conversation
    foreign key (conversation_id) references conversations (id) on delete set null,

  -- `unspecified` is permitted deliberately. The reason is optional upstream,
  -- and an escalation whose rule cannot be named is still an escalation that
  -- must reach a human. Defaulting it to a named rule would misattribute it;
  -- refusing to record it would lose it. Both are worse than saying so.
  constraint ck_safety_escalations_reason
    check (reason in ('signal_category', 'evasion_of_safety', 'repeated_attempts', 'unspecified')),
  constraint ck_safety_escalations_status
    check (delivery_status in ('pending', 'delivered', 'abandoned')),
  constraint ck_safety_escalations_severity
    check (severity in ('low', 'medium', 'high', 'critical')),
  constraint ck_safety_escalations_error_length
    check (last_error is null or length(last_error) <= 500)
);

comment on table safety_escalations is
  'Delivery ledger for safety escalations. A POINTER, never the disclosure: no '
  'transcript, no reply, no child name. See docs/CHILD_SAFETY.md §6.';

comment on column safety_escalations.delivery_status is
  'pending = no human has been told yet. The worker sweeps for these.';

-- The sweep reads only what is undelivered, so the index covers only that.
create index idx_safety_escalations_pending
  on safety_escalations (occurred_at)
  where delivery_status = 'pending';

create index idx_safety_escalations_child on safety_escalations (child_id, occurred_at desc);

create trigger trg_safety_escalations_touch before update on safety_escalations
  for each row execute function app.touch_updated_at();

-- ═══════════════════════════════════════════════════════════════════════════
-- NO POLICY FOR `authenticated`, ON PURPOSE
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Enabled and FORCED with no policy granted to the authenticated role means
-- this table is unreachable from any parent session, exactly like
-- `payment_events`. That is the safe default while §6.2's "who may read it" is
-- unresolved — and it is specifically the right default for a disclosure that
-- may concern the parent holding the session.
--
-- Widening this later is a deliberate act requiring a new migration, which is
-- the correct amount of friction for the decision it represents.
alter table safety_escalations enable row level security;
alter table safety_escalations force row level security;

-- ═══════════════════════════════════════════════════════════════════════════
-- The sweep
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Ordered oldest first: the escalation that has been waiting longest is the one
-- most overdue. `for update skip locked` so a second worker — which should not
-- exist, but might briefly during a deploy — cannot deliver the same row twice.
create or replace function app.escalations_awaiting_delivery(
  p_limit int default 50,
  p_max_attempts int default 10
)
returns table (
  id uuid,
  child_id uuid,
  conversation_id uuid,
  reason text,
  categories text[],
  severity text,
  occurred_at timestamptz,
  attempts int
)
language sql
volatile
security definer
set search_path = public, pg_temp
as $$
  select e.id, e.child_id, e.conversation_id, e.reason, e.categories,
         e.severity, e.occurred_at, e.attempts
    from safety_escalations e
   where e.delivery_status = 'pending'
     and e.attempts < p_max_attempts
   order by e.occurred_at
   limit p_limit
     for update skip locked;
$$;

comment on function app.escalations_awaiting_delivery(int, int) is
  'Escalations no human has been told about yet, oldest first.';
