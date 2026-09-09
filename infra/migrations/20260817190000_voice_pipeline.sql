-- =============================================================================
-- The voice pipeline: audio artefacts and their expiry.
-- =============================================================================
-- Governed by docs/adr/0006: raw child audio is transcribed and DISCARDED. This
-- table is not a store of recordings — it is the ledger that proves each one was
-- short-lived and says when it went.
--
-- THREE RULES, ENFORCED BY THE SCHEMA RATHER THAN BY CONVENTION:
--
--   1. NO AUDIO BYTES LIVE HERE. There is no bytea column and there must never
--      be one. `schema.test.ts` fails the build if a blob-shaped column appears.
--   2. EVERY ROW EXPIRES. `expires_at` is NOT NULL with no default — a row that
--      forgot to say when it dies cannot be inserted.
--   3. A PARENT CANNOT EXTEND IT. Parents read their children's artefacts and
--      write none of them. A retention window a user can lengthen is not one.

create table audio_artifacts (
  id             uuid        primary key default app.gen_uuid_v7(),
  child_id       uuid        not null,
  conversation_id uuid,
  message_id     uuid,
  kind           text        not null,
  -- The storage key. An opaque, unguessable handle produced by the storage
  -- adapter — never a path a client constructed, and never derived from
  -- anything about the child.
  storage_key    text        not null,
  mime_type      text        not null,
  byte_size      int         not null,
  duration_ms    int,
  -- Why this artefact has the lifetime it has. Kept because "why is this still
  -- here?" is the question an audit asks, and free text would not answer it.
  retention_basis text       not null,
  expires_at     timestamptz not null,
  deleted_at     timestamptz,
  created_at     timestamptz not null default now(),

  constraint fk_audio_artifacts_child
    foreign key (child_id) references children (id) on delete cascade,
  constraint fk_audio_artifacts_conversation
    foreign key (conversation_id) references conversations (id) on delete cascade,
  constraint fk_audio_artifacts_message
    foreign key (message_id) references messages (id) on delete set null,

  constraint ck_audio_artifacts_kind
    check (kind in ('child_upload', 'companion_reply')),
  constraint ck_audio_artifacts_basis
    check (retention_basis in ('policy_zero', 'no_consent', 'synthesis', 'parent_opt_in')),
  constraint ck_audio_artifacts_mime
    check (mime_type in ('audio/wav', 'audio/ogg', 'audio/webm', 'audio/mp4', 'audio/mpeg')),
  constraint ck_audio_artifacts_size check (byte_size > 0 and byte_size <= 33554432),
  constraint ck_audio_artifacts_duration check (duration_ms is null or duration_ms > 0),
  -- DELIBERATELY NOT `expires_at > created_at`.
  --
  -- That constraint was here and it was wrong: it made an artefact's lifetime
  -- impossible to SHORTEN. Revoking consent, responding to an incident, or a
  -- parent asking for their child's recording gone now are all "set expires_at
  -- to the past", and a schema that forbids them protects nothing — the only
  -- direction worth constraining is lengthening, and RLS already stops a parent
  -- doing either. Found by a test that tried to expire audio early.
  -- A child upload that outlives its turn must say a parent asked for that.
  -- Without this, a bug in the policy resolution could quietly start retaining
  -- every child's voice and nothing would object.
  constraint ck_audio_artifacts_retention_needs_consent
    check (retention_basis <> 'parent_opt_in' or kind = 'child_upload')
);

create index idx_audio_artifacts_child on audio_artifacts (child_id, created_at desc);
create index idx_audio_artifacts_expiry on audio_artifacts (expires_at) where deleted_at is null;
create unique index uq_audio_artifacts_storage_key on audio_artifacts (storage_key);

comment on table audio_artifacts is
  'S3 — the ledger of transient audio. NEVER the audio itself. See docs/adr/0006.';
comment on column audio_artifacts.storage_key is
  'Opaque handle from the storage adapter. Not a client-supplied path.';
comment on column audio_artifacts.expires_at is
  'NOT NULL with no default: an artefact that did not state its lifetime cannot exist. May be moved EARLIER at any time — shortening a retention window is always permitted.';

alter table audio_artifacts enable row level security;
alter table audio_artifacts force row level security;

-- A parent sees the ledger for their own children and writes none of it. Reading
-- it is how they answer "what did you keep, and until when?" for themselves.
create policy audio_artifacts_select_own on audio_artifacts
  for select to authenticated
  using (app.owns_child(child_id) and deleted_at is null);

grant select on audio_artifacts to authenticated;

-- -----------------------------------------------------------------------------
-- The sweep
-- -----------------------------------------------------------------------------
-- The BACKSTOP, not the mechanism. Audio is deleted inline the moment its turn
-- finishes; this exists for the deletes that did not happen — a crash between
-- writing an object and deleting it, a storage call that failed, a code path
-- someone adds later and forgets to clean up after.
--
-- It returns the keys so the caller can delete the objects themselves: the
-- database knows what expired, and only the storage adapter can reclaim bytes.
create or replace function app.expire_audio_artifacts(p_limit int default 500)
returns table (id uuid, storage_key text)
language sql
volatile
security definer
set search_path = public, pg_temp
as $$
  update audio_artifacts a
     set deleted_at = now()
   where a.id in (
     select b.id from audio_artifacts b
      where b.deleted_at is null
        and b.expires_at <= now()
      order by b.expires_at
      limit p_limit
   )
  returning a.id, a.storage_key;
$$;

comment on function app.expire_audio_artifacts(int) is
  'Marks expired artefacts deleted and returns their keys for the storage sweep. '
  'A backstop — audio is deleted inline when its turn ends.';

-- How much audio is outstanding for a child. Zero is the expected answer, and a
-- non-zero one on a child whose parent has not opted in is an incident.
create or replace function app.child_live_audio_count(p_child_id uuid)
returns int
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select count(*)::int
    from audio_artifacts a
   where a.child_id = p_child_id
     and a.deleted_at is null
     and a.expires_at > now();
$$;

-- -----------------------------------------------------------------------------
-- Voice entitlements
-- -----------------------------------------------------------------------------
-- Voice costs materially more per turn than text — two provider calls on top of
-- the model — so it is a plan entitlement rather than something every tier gets
-- unmetered. Default true so nothing that exists today changes behaviour.
alter table subscription_plans add column voice_enabled boolean not null default true;
alter table subscription_plans add column daily_voice_turn_limit int not null default 40;

alter table subscription_plans add constraint ck_subscription_plans_voice_limit
  check (daily_voice_turn_limit >= 0);

update subscription_plans set daily_voice_turn_limit = 10 where code = 'free';
update subscription_plans set daily_voice_turn_limit = 200 where tier = 'paid';

comment on column subscription_plans.daily_voice_turn_limit is
  'Voice turns per child per UTC day. Separate from daily_turn_limit: a voice turn '
  'costs an STT call and a TTS call on top of the model.';

-- Voice turns are counted separately from text turns, so "we are spending more
-- on speech than on the model" is answerable without a join across providers.
alter table usage_daily add column voice_turns int not null default 0;
alter table usage_daily add constraint ck_usage_daily_voice_nonnegative
  check (voice_turns >= 0);

create or replace function app.record_voice_usage(
  p_child_id      uuid,
  p_voice_turns   int    default 1,
  p_audio_seconds numeric default 0
)
returns void
language sql
volatile
security definer
set search_path = public, pg_temp
as $$
  insert into usage_daily as u (child_id, usage_date, voice_turns)
  values (p_child_id, (now() at time zone 'utc')::date, p_voice_turns)
  on conflict (child_id, usage_date) do update
    set voice_turns = u.voice_turns + excluded.voice_turns,
        updated_at  = now();
$$;

create or replace function app.child_voice_turns_used_today(p_child_id uuid)
returns int
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (select u.voice_turns from usage_daily u
      where u.child_id = p_child_id
        and u.usage_date = (now() at time zone 'utc')::date),
    0
  );
$$;

-- -----------------------------------------------------------------------------
-- Entitlements now report voice as well
-- -----------------------------------------------------------------------------
drop function if exists app.parent_entitlements(uuid);

create or replace function app.parent_entitlements(p_parent_id uuid)
returns table (
  plan_code                     text,
  tier                          text,
  subscription_status           text,
  daily_turn_limit              int,
  max_conversation_turns        int,
  concurrent_conversation_limit int,
  child_profile_limit           int,
  daily_minute_limit            int,
  voice_enabled                 boolean,
  daily_voice_turn_limit        int
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with live as (
    select sub.plan_id, sub.status
      from subscriptions sub
     where sub.parent_id = p_parent_id
       and sub.status in ('trialing', 'active', 'past_due')
     order by case sub.status
                when 'active'   then 1
                when 'trialing' then 2
                else 3
              end
     limit 1
  )
  select p.code,
         p.tier,
         coalesce((select status from live), 'free'),
         p.daily_turn_limit,
         p.max_conversation_turns,
         p.concurrent_conversation_limit,
         p.child_profile_limit,
         p.daily_minute_limit,
         p.voice_enabled,
         p.daily_voice_turn_limit
    from subscription_plans p
   where p.is_active
     and p.id = coalesce(
       (select plan_id from live),
       (select id from subscription_plans where code = 'free')
     )
   limit 1;
$$;

comment on function app.parent_entitlements(uuid) is
  'Effective plan limits for a parent. Free when there is no live subscription.';

-- -----------------------------------------------------------------------------
-- How a message arrived
-- -----------------------------------------------------------------------------
-- Voice and text produce identical rows otherwise, which makes "is speech
-- recognition failing for this child?" unanswerable without it. Defaults to
-- 'text' so every existing row keeps its meaning.
alter table messages add column input_mode text not null default 'text';

alter table messages add constraint ck_messages_input_mode
  check (input_mode in ('text', 'voice'));

comment on column messages.input_mode is
  'How the child produced this message. A companion message is always text — the '
  'audio is synthesised from it and recorded in audio_artifacts.';

create index idx_messages_voice on messages (child_id, created_at desc)
  where input_mode = 'voice';
