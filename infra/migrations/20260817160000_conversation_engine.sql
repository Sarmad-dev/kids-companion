-- =============================================================================
-- Conversation engine: the four launch characters, and turn-level accounting.
-- =============================================================================
-- Forward-only. Replaces the placeholder character catalogue with the four
-- specified for launch, and adds the columns the engine needs to bound context,
-- account for tokens, and terminate a session.

-- -----------------------------------------------------------------------------
-- 1. Characters
-- -----------------------------------------------------------------------------
-- `prompt_key` binds a row to a versioned prompt artefact in services/ai. The
-- prompt TEXT is never stored here: a character that can be re-prompted from the
-- database is a safety boundary an operator can move without a code review
-- (docs/CHILD_SAFETY.md §7).
alter table ai_characters add column prompt_key text;

update ai_characters set status = 'retired'
 where slug in ('pip-the-fox', 'nano-the-robot', 'mira-the-moon', 'captain-zia', 'dada-jee');

-- Retired, not deleted: `conversations.character_id` is ON DELETE RESTRICT, so a
-- child's history with a retired character survives (docs/DATA_MODEL.md §4).

insert into ai_characters
  (slug, display_name, tagline, description, prompt_version, prompt_key,
   allowed_age_groups, status, sort_order)
values
  ('buddy-the-dog',
   'Buddy the Dog',
   'A cheerful puppy who is excited about absolutely everything.',
   'Buddy is warm, simple, and endlessly encouraging. Short sentences, lots of affirmation, no complexity. Built for the youngest children, where the goal is that talking feels good rather than that anything is learned.',
   'v1.buddy', 'buddy',
   array['AGE_3_5', 'AGE_6_8'],
   'active', 10),

  ('lily-the-fairy',
   'Lily the Fairy',
   'A gentle fairy who tells little stories and notices small wonders.',
   'Lily is calm and imaginative, good for winding down. She invites a child to add to a story rather than performing one at them.',
   'v1.lily', 'lily',
   array['AGE_3_5', 'AGE_6_8', 'AGE_9_10'],
   'active', 20),

  ('captain-sky',
   'Captain Sky',
   'An adventurous explorer for bigger stories and pretend play.',
   'Captain Sky runs gentle adventures with a problem and a resolution inside one session. Not offered to the youngest group: sustained narrative and mild tension do not suit a three-year-old.',
   'v1.captain', 'captain',
   array['AGE_6_8', 'AGE_9_10'],
   'active', 30),

  ('professor-owl',
   'Professor Owl',
   'A patient owl who loves questions about how things work.',
   'Professor Owl explains everyday things simply and is delighted to be corrected. Aimed at older children, where "why" questions carry the conversation.',
   'v1.professor', 'professor',
   array['AGE_6_8', 'AGE_9_10'],
   'active', 40)
on conflict (slug) do update
  set display_name       = excluded.display_name,
      tagline            = excluded.tagline,
      description        = excluded.description,
      prompt_version     = excluded.prompt_version,
      prompt_key         = excluded.prompt_key,
      allowed_age_groups = excluded.allowed_age_groups,
      status             = excluded.status,
      sort_order         = excluded.sort_order;

-- Every launch character speaks English; Urdu is enabled per character only once
-- its safety classification reaches parity (docs/CHILD_SAFETY.md §9.1).
insert into character_languages (character_id, language_code)
select c.id, 'en' from ai_characters c
where c.slug in ('buddy-the-dog', 'lily-the-fairy', 'captain-sky', 'professor-owl')
on conflict do nothing;

insert into character_languages (character_id, language_code)
select c.id, 'ur' from ai_characters c
where c.slug in ('buddy-the-dog', 'lily-the-fairy')
on conflict do nothing;

alter table ai_characters add constraint ck_ai_characters_prompt_key
  check (prompt_key is null or prompt_key ~ '^[a-z0-9_]{2,40}$');

comment on column ai_characters.prompt_key is
  'Binds to a versioned prompt artefact in services/ai. Prompt text is never stored in the database.';

-- -----------------------------------------------------------------------------
-- 2. Conversation accounting and termination
-- -----------------------------------------------------------------------------
alter table conversations add column total_input_tokens  int not null default 0;
alter table conversations add column total_output_tokens int not null default 0;
alter table conversations add column provider            text;
alter table conversations add column model               text;
-- The last turn the model actually saw. Lets a support engineer reconstruct what
-- context produced a given reply without storing the assembled prompt.
alter table conversations add column context_message_count int not null default 0;

alter table conversations add constraint ck_conversations_tokens_nonnegative
  check (total_input_tokens >= 0 and total_output_tokens >= 0);

-- 'safety_ended' already exists as an end_reason. Adding the engine's own
-- terminal states, so "why did this session stop?" is always answerable.
alter table conversations drop constraint ck_conversations_end_reason;
alter table conversations add constraint ck_conversations_end_reason
  check (end_reason is null or end_reason in
    ('child_ended', 'timeout', 'quota_exhausted', 'parent_ended', 'safety_ended',
     'error', 'cost_ceiling', 'provider_unavailable', 'consent_withdrawn'));

-- -----------------------------------------------------------------------------
-- 3. Message provenance
-- -----------------------------------------------------------------------------
alter table messages add column provider text;
alter table messages add column model    text;
-- Which safety layers ran and passed, for this message. A number, not content:
-- enough to compute "block rate by layer" without storing what was said.
alter table messages add column safety_layers_passed text[] not null default array[]::text[];

alter table messages add constraint ck_messages_safety_layers
  check (safety_layers_passed <@ array['L1', 'L2', 'L3', 'L4', 'L5']);

comment on column messages.safety_layers_passed is
  'Which layers cleared this message. Layer names only — never the content that was checked.';

-- -----------------------------------------------------------------------------
-- 4. Per-child daily turn accounting
-- -----------------------------------------------------------------------------
-- Rate limiting a child is a SAFETY feature as much as a cost one: an unbounded
-- conversation loop is both a runaway bill and a child who has been talking to a
-- screen for four hours (docs/API_CONVENTIONS.md §7).
--
-- Counted in Postgres rather than Redis because the limit must hold when Redis
-- is unavailable — the degraded path for a quota is "be conservative", not
-- "allow everything" (ARCHITECTURE.md §13).
create or replace function app.child_turns_today(p_child_id uuid)
returns int
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select count(*)::int
  from messages m
  where m.child_id = p_child_id
    and m.role = 'child'
    and m.created_at >= date_trunc('day', now());
$$;

comment on function app.child_turns_today(uuid) is
  'Child turns since midnight UTC. Drives the per-child daily cap.';

create index idx_messages_child_role_created on messages (child_id, role, created_at desc);
