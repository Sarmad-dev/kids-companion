-- =============================================================================
-- The safety subsystem: configurable policy, and the minimal safety event log.
-- =============================================================================
-- Two ideas here.
--
-- 1. WHAT COUNTS AS UNSAFE IS DATA, not code. Thresholds, actions, and
--    escalation rules live in `safety_policies` so they can be tightened after
--    a real-world miss without a deploy — the same reasoning as
--    `consent_requirements`. A safety fix that needs a release is a safety fix
--    that ships on Monday.
--
-- 2. A SAFETY EVENT RECORDS THAT SOMETHING HAPPENED, NEVER WHAT WAS SAID.
--    `content_flags` is the event log. It carries categories, a layer, a
--    detector name, and a decision. It does not carry the utterance, and it must
--    never be widened to.

-- -----------------------------------------------------------------------------
-- 1. Policy
-- -----------------------------------------------------------------------------
create table safety_policies (
  id              uuid        primary key default app.gen_uuid_v7(),
  -- The category this rule governs. Free text against a documented taxonomy
  -- rather than a CHECK constraint: adding a category must not require a
  -- migration when a new class of harm is identified.
  category        text        not null,
  -- '*' applies to every age group.
  age_group       text        not null default '*',
  -- Which side of the turn. Thresholds differ: a child SAYING something
  -- frightening is a signal to act on; a model saying it is a failure to block.
  applies_to      text        not null,
  action          text        not null,
  -- Below this classifier confidence the finding is recorded but not acted on.
  -- Deterministic detectors report 1.0 and are unaffected.
  min_confidence  real        not null default 0.5,
  -- Whether this routes to a human (docs/CHILD_SAFETY.md §6).
  escalates       boolean     not null default false,
  policy_version  text        not null,
  -- Why this rule exists, in plain language. When someone asks in two years why
  -- a category is treated this way, the answer must be in the row.
  rationale       text        not null,
  is_active       boolean     not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint ck_safety_policies_category check (category ~ '^[a-z0-9_]{2,50}$'),
  constraint ck_safety_policies_age_group
    check (age_group in ('*', 'AGE_3_5', 'AGE_6_8', 'AGE_9_10')),
  constraint ck_safety_policies_applies_to
    check (applies_to in ('child_input', 'model_output', 'both')),
  -- `allow` exists so a category can be downgraded to observation without
  -- deleting the row and losing the rationale.
  constraint ck_safety_policies_action
    check (action in ('allow', 'observe', 'redirect', 'block', 'end_session')),
  constraint ck_safety_policies_confidence check (min_confidence between 0 and 1),
  constraint ck_safety_policies_version check (policy_version ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')
);

create unique index uq_safety_policies_scope
  on safety_policies (category, age_group, applies_to) where is_active;

create index idx_safety_policies_lookup on safety_policies (applies_to, category) where is_active;

create trigger trg_safety_policies_touch
  before update on safety_policies
  for each row execute function app.touch_updated_at();

comment on table safety_policies is
  'S0 — configurable safety policy. No personal data. Tightening a rule is an UPDATE, not a deploy.';

alter table safety_policies enable row level security;
alter table safety_policies force row level security;

-- Readable by any signed-in session so a parent can see what is enforced.
-- Writable only by an admin, and every write is audited.
create policy safety_policies_select_all on safety_policies
  for select to authenticated using (is_active);

create policy safety_policies_write_admin on safety_policies
  for all to authenticated
  using (app.current_role() = 'admin') with check (app.current_role() = 'admin');

grant select on safety_policies to authenticated;
grant insert, update, delete on safety_policies to authenticated;

-- -----------------------------------------------------------------------------
-- 2. The default policy set
-- -----------------------------------------------------------------------------
-- Every category the product recognises, with its action and the reason.
--
-- Note where `escalates` is true: those four are not "bad content to block",
-- they are a child telling us something. Blocking and moving on would teach a
-- child that telling someone produces nothing (docs/CHILD_SAFETY.md §6.1).
insert into safety_policies
  (category, age_group, applies_to, action, min_confidence, escalates, policy_version, rationale)
values
  -- Prohibited content. Blocked on both sides, at every age.
  ('sexual_content', '*', 'both', 'block', 0.3, false, '2026-08-01',
   'Absolute prohibition. Low threshold deliberately: a false positive costs one redirect, a false negative is unacceptable.'),
  ('violence', '*', 'both', 'block', 0.5, false, '2026-08-01',
   'Prohibited, including inside stories and pretend play.'),
  ('weapons', '*', 'both', 'block', 0.5, false, '2026-08-01',
   'Prohibited. Separated from violence so the metrics distinguish "asked about a sword in a story" from depicted harm.'),
  ('dangerous_activities', '*', 'both', 'block', 0.4, false, '2026-08-01',
   'Anything a child could copy and be hurt by. Lower threshold than violence because imitation is the risk, not exposure.'),
  ('drugs', '*', 'both', 'block', 0.5, false, '2026-08-01',
   'Includes alcohol and tobacco.'),
  ('hate', '*', 'both', 'block', 0.4, false, '2026-08-01',
   'Demeaning content about any group. Blocked on input too: a child repeating something heard elsewhere is a moment to redirect, not to engage.'),
  ('harassment', '*', 'both', 'block', 0.5, false, '2026-08-01',
   'Cruelty directed at a person, including the child themselves.'),
  ('abuse', '*', 'model_output', 'block', 0.3, false, '2026-08-01',
   'On OUTPUT this is a hard block. On INPUT it is a disclosure, handled by disclosure_of_harm rather than blocked.'),
  ('exploitation', '*', 'both', 'block', 0.2, true, '2026-08-01',
   'Lowest threshold in the policy, and escalating. Grooming-adjacent patterns are the one class where a false positive is clearly cheaper than a miss.'),

  -- Boundary violations by the companion itself.
  ('personal_data_request', '*', 'both', 'block', 0.4, false, '2026-08-01',
   'The companion must never elicit identifying information, and a child volunteering it must not have it echoed back or stored.'),
  ('secret_keeping', '*', 'both', 'block', 0.2, true, '2026-08-01',
   'The strongest correlate of grooming behaviour, with no legitimate use in this product. Escalates because a child being ASKED to keep secrets elsewhere may be disclosing.'),
  ('inappropriate_relationship', '*', 'both', 'block', 0.3, true, '2026-08-01',
   'The companion positioning itself as a substitute for a trusted adult, or claiming a special private bond.'),
  ('impersonation', '*', 'model_output', 'block', 0.3, false, '2026-08-01',
   'The companion claiming to be human, alive, or a real person the child knows.'),

  -- Advice the product must never give.
  ('unsafe_medical_advice', '*', 'model_output', 'block', 0.4, false, '2026-08-01',
   'Includes diagnosis of speech and developmental conditions, which is the boundary this product could most plausibly drift across.'),
  ('unsafe_psychological_advice', '*', 'model_output', 'block', 0.4, false, '2026-08-01',
   'No diagnosis, no therapy, no assessment of a child''s mental state. Route to a trusted adult instead.'),

  -- Signals that a child needs a human, not a block.
  ('self_harm', '*', 'both', 'redirect', 0.3, true, '2026-08-01',
   'ESCALATES. A child expressing this is disclosing, not producing prohibited content. The reply is warm and points to a trusted adult; a human is notified.'),
  ('disclosure_of_harm', '*', 'child_input', 'redirect', 0.2, true, '2026-08-01',
   'ESCALATES. Never silently swallowed. The companion does not investigate and does not ask follow-up questions.'),
  ('distress_signal', '*', 'child_input', 'redirect', 0.4, true, '2026-08-01',
   'ESCALATES. Sadness and fear are handled with care, not refused.'),

  -- Attacks on the system.
  ('prompt_injection', '*', 'child_input', 'redirect', 0.5, false, '2026-08-01',
   'Treated as a game a child is playing, not an attack to punish. Redirect warmly and stay in character.'),

  -- Age-specific tightening. These rows override the '*' rows above for the
  -- youngest group, which is how the policy narrows with age rather than widens.
  ('frightening', 'AGE_3_5', 'model_output', 'block', 0.3, false, '2026-08-01',
   'A three-year-old has no way to put down a frightening idea. Tighter than for older children.'),
  ('frightening', 'AGE_6_8', 'model_output', 'block', 0.5, false, '2026-08-01',
   'Mild story tension is permitted at this age if resolved in the same session.'),
  ('frightening', 'AGE_9_10', 'model_output', 'observe', 0.6, false, '2026-08-01',
   'Observed rather than blocked: story tension is developmentally appropriate here.')
on conflict do nothing;

-- -----------------------------------------------------------------------------
-- 3. The safety event log
-- -----------------------------------------------------------------------------
-- `content_flags` IS the safety event. Extending it rather than adding a second
-- table, because two places to look during an incident is one too many.
alter table content_flags add column detector text;
alter table content_flags add column policy_version text;
alter table content_flags add column action_taken text;
-- How many blocked turns this child has had in the current session. Drives the
-- repeated-attempt rule without storing what any of them said.
alter table content_flags add column attempt_index int not null default 1;

alter table content_flags add constraint ck_content_flags_action_taken
  check (action_taken is null or action_taken in
    ('allow', 'observe', 'redirect', 'block', 'end_session'));

alter table content_flags add constraint ck_content_flags_attempt_index
  check (attempt_index >= 1);

comment on column content_flags.detector is
  'Which detector fired — a RULE NAME, never the text that matched it.';
comment on column content_flags.attempt_index is
  'Position in a run of blocked turns. A number, not a history of what was said.';

create index idx_content_flags_child_recent on content_flags (child_id, created_at desc);

-- Counts recent blocked turns for a child, for the repeated-attempt rule.
--
-- Deliberately a COUNT and nothing else. The rule needs to know that a child has
-- tried five times; it does not need, and must not have, the five utterances.
create or replace function app.recent_safety_blocks(p_child_id uuid, p_within_minutes int default 15)
returns int
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select count(*)::int
  from content_flags f
  where f.child_id = p_child_id
    and f.decision in ('blocked', 'redirected', 'escalated')
    and f.created_at >= now() - make_interval(mins => p_within_minutes);
$$;

comment on function app.recent_safety_blocks(uuid, int) is
  'How many turns were stopped for this child recently. A count only — never the content.';
