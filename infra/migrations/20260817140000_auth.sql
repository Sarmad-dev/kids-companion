-- =============================================================================
-- Authentication and authorization: roles, sessions, verification, reset.
-- =============================================================================
-- Children still do not authenticate. A child is data owned by a parent, and
-- nothing here creates a credential for one (docs/adr/0005).

-- -----------------------------------------------------------------------------
-- Roles
-- -----------------------------------------------------------------------------
-- Three principals share the `parents` table because they share an identity: all
-- three sign in, and Supabase issues all three the same `authenticated` database
-- role. Differentiation happens in policy, not in a Postgres role.
alter table parents add column role text not null default 'parent';
alter table parents add column email_verified_at timestamptz;
alter table parents add column last_login_at timestamptz;
alter table parents add column failed_login_count int not null default 0;
alter table parents add column locked_until timestamptz;

alter table parents add constraint ck_parents_role
  check (role in ('parent', 'admin', 'support'));

create index idx_parents_staff on parents (role) where role <> 'parent';

comment on column parents.role is
  'S1 — parent | admin | support. Staff roles are rare and audited; see app.current_role().';
comment on column parents.failed_login_count is
  'Reset on success. Drives lockout, which is why it is server-side and not a client concern.';

-- Resolves the caller's role from the DATABASE, not from a JWT claim.
--
-- A role in a token is stale for the lifetime of that token: revoking an admin
-- would leave them privileged for another 15 minutes. Reading the row costs a
-- cached index lookup per statement and removes that window entirely.
--
-- SECURITY DEFINER because it reads `parents`, and calling it from a policy on
-- `parents` would otherwise recurse.
create or replace function app.current_role()
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (select p.role from parents p
      where p.id = app.current_parent_id() and p.deleted_at is null),
    'anonymous'
  );
$$;

create or replace function app.is_staff()
returns boolean
language sql
stable
as $$
  select app.current_role() in ('admin', 'support');
$$;

comment on function app.current_role() is
  'The caller''s role, read live from parents. Never trusts a JWT claim, so revocation is immediate.';

-- -----------------------------------------------------------------------------
-- Staff access — deliberately narrow
-- -----------------------------------------------------------------------------
-- Staff can see ACCOUNTS and SAFETY METADATA. They cannot see what a child said.
--
-- There is no admin or support policy on `messages`, `conversations`,
-- `speech_practice`, `pronunciation_results`, `learning_*`, or `child_languages`
-- anywhere in this schema. That is the point: an operator browsing a child's
-- transcripts out of curiosity is a threat this product designs against
-- (SECURITY.md §1.2), and the review queue is a separate, access-controlled,
-- itself-audited path rather than a blanket SELECT.

create policy parents_select_staff on parents
  for select to authenticated
  using (app.is_staff() and deleted_at is null);

-- Support triages the safety queue. `content_flags` holds categories and
-- decisions — never the content that triggered them.
create policy content_flags_select_staff on content_flags
  for select to authenticated using (app.is_staff());

create policy content_flags_update_staff on content_flags
  for update to authenticated
  using (app.is_staff()) with check (app.is_staff());

-- Admins read the audit log. Nobody writes to it through a policy, and the
-- append-only trigger means nobody edits it at all.
create policy audit_logs_select_admin on audit_logs
  for select to authenticated using (app.current_role() = 'admin');

grant select on audit_logs to authenticated;
grant update on content_flags to authenticated;

-- Admins curate the reference catalogue.
create policy ai_characters_write_admin on ai_characters
  for all to authenticated
  using (app.current_role() = 'admin') with check (app.current_role() = 'admin');

create policy subscription_plans_write_admin on subscription_plans
  for all to authenticated
  using (app.current_role() = 'admin') with check (app.current_role() = 'admin');

create policy supported_languages_write_admin on supported_languages
  for all to authenticated
  using (app.current_role() = 'admin') with check (app.current_role() = 'admin');

grant insert, update, delete on ai_characters to authenticated;
grant insert, update, delete on subscription_plans to authenticated;
grant insert, update, delete on supported_languages to authenticated;

-- -----------------------------------------------------------------------------
-- sessions
-- -----------------------------------------------------------------------------
-- One row per issued refresh token. Access tokens are stateless JWTs and are not
-- stored; refresh tokens are opaque, stored ONLY as a SHA-256 hash, and rotate
-- on every use.
--
-- `family_id` groups every token descended from one login. It is what makes
-- theft detectable: if a token that has already been rotated is presented again,
-- either the legitimate client is replaying or an attacker is using a stolen
-- copy. We cannot tell which, so the whole family is revoked (SECURITY.md §2.1).
create table sessions (
  id                 uuid        primary key default app.gen_uuid_v7(),
  parent_id          uuid        not null,
  family_id          uuid        not null,
  -- SHA-256 of the opaque token. A database dump does not yield usable tokens.
  refresh_token_hash text        not null,
  device_label       text,
  user_agent         text,
  ip_address         inet,
  issued_at          timestamptz not null default now(),
  expires_at         timestamptz not null,
  last_used_at       timestamptz,
  revoked_at         timestamptz,
  revoked_reason     text,
  -- Set when this token is rotated, so a family can be walked forwards.
  replaced_by        uuid,
  created_at         timestamptz not null default now(),

  constraint fk_sessions_parent
    foreign key (parent_id) references parents (id) on delete cascade,
  constraint fk_sessions_replaced_by
    foreign key (replaced_by) references sessions (id) on delete set null,

  constraint ck_sessions_revoked_reason
    check (revoked_reason is null or revoked_reason in
      ('logout', 'rotated', 'reuse_detected', 'password_changed', 'account_deleted',
       'expired', 'admin_revoked')),
  constraint ck_sessions_revoked_has_reason
    check (revoked_at is null or revoked_reason is not null),
  constraint ck_sessions_expiry_after_issue check (expires_at > issued_at)
);

create unique index uq_sessions_refresh_token_hash on sessions (refresh_token_hash);
create index idx_sessions_parent_id on sessions (parent_id);
create index idx_sessions_family on sessions (family_id);
create index idx_sessions_active on sessions (parent_id, expires_at)
  where revoked_at is null;
-- Drives the expiry sweep.
create index idx_sessions_expires_at on sessions (expires_at) where revoked_at is null;

comment on table sessions is
  'S1 — refresh token records. Tokens are stored hashed, never in the clear.';
comment on column sessions.family_id is
  'Groups tokens descended from one login. Reuse of a rotated token revokes the whole family.';

alter table sessions enable row level security;
alter table sessions force row level security;

-- A parent can SEE their own sessions — that is the "where am I signed in?"
-- screen, and the ability to notice a session they do not recognise. They cannot
-- write them: minting and rotating tokens is the auth service's job.
create policy sessions_select_owner on sessions
  for select to authenticated using (parent_id = app.current_parent_id());

grant select on sessions to authenticated;

-- -----------------------------------------------------------------------------
-- email_verifications, password_resets
-- -----------------------------------------------------------------------------
-- Used by the self-managed auth adapter. Under Supabase Auth these flows live in
-- GoTrue and these tables stay empty — the AuthProvider port keeps both shapes
-- behind one interface (docs/adr/0009).
--
-- Both store a HASH of the token, never the token. Both are single-use and
-- expiring. Neither is readable by any authenticated session: possession of the
-- emailed token is the proof, and being able to LIST outstanding tokens would
-- defeat that entirely.
create table email_verifications (
  id          uuid        primary key default app.gen_uuid_v7(),
  parent_id   uuid        not null,
  token_hash  text        not null,
  email       text        not null,
  expires_at  timestamptz not null,
  consumed_at timestamptz,
  created_at  timestamptz not null default now(),

  constraint fk_email_verifications_parent
    foreign key (parent_id) references parents (id) on delete cascade
);

create unique index uq_email_verifications_token on email_verifications (token_hash);
create index idx_email_verifications_parent on email_verifications (parent_id)
  where consumed_at is null;

create table password_resets (
  id           uuid        primary key default app.gen_uuid_v7(),
  parent_id    uuid        not null,
  token_hash   text        not null,
  expires_at   timestamptz not null,
  consumed_at  timestamptz,
  requested_ip inet,
  created_at   timestamptz not null default now(),

  constraint fk_password_resets_parent
    foreign key (parent_id) references parents (id) on delete cascade
);

create unique index uq_password_resets_token on password_resets (token_hash);
create index idx_password_resets_parent on password_resets (parent_id)
  where consumed_at is null;

comment on table email_verifications is
  'S1 — token hashes only. No policy and no grant: possession of the emailed token is the proof.';
comment on table password_resets is
  'S1 — token hashes only. Single-use and expiring. Not listable by anyone.';

alter table email_verifications enable row level security;
alter table email_verifications force row level security;
alter table password_resets enable row level security;
alter table password_resets force row level security;

-- Deliberately no policies and no grants for `authenticated`.

-- -----------------------------------------------------------------------------
-- Login attempt throttling
-- -----------------------------------------------------------------------------
-- Recorded per email AND per IP so credential stuffing across many accounts is
-- visible, not just repeated attempts on one. Holds no password material.
create table login_attempts (
  id           uuid        primary key default app.gen_uuid_v7(),
  email_hash   text        not null,
  ip_address   inet,
  succeeded    boolean     not null,
  user_agent   text,
  attempted_at timestamptz not null default now(),
  created_at   timestamptz not null default now()
);

create index idx_login_attempts_email_time on login_attempts (email_hash, attempted_at desc);
create index idx_login_attempts_ip_time on login_attempts (ip_address, attempted_at desc)
  where ip_address is not null;
create index idx_login_attempts_failures on login_attempts (attempted_at desc)
  where not succeeded;

comment on table login_attempts is
  'S1 — throttling and abuse detection. Email is hashed; no credential material is stored.';

alter table login_attempts enable row level security;
alter table login_attempts force row level security;
-- No policies, no grants: operational data, read only under the service role.
