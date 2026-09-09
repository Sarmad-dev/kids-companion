-- =============================================================================
-- Bootstrap: Supabase compatibility shims, identity, ID generation, triggers.
-- =============================================================================
-- Written to run unchanged on Supabase AND on a vanilla PostgreSQL 15+ cluster
-- (the Compose stack, and the PGlite test harness). Everything Supabase already
-- provides is created only `if not exists`, so on a real project this migration
-- adds the `app` schema and nothing else.

create schema if not exists app;

comment on schema app is
  'Helper functions and identity resolution. No tables live here.';

-- -----------------------------------------------------------------------------
-- Supabase roles
-- -----------------------------------------------------------------------------
-- `authenticated` is the role PostgREST/Supabase switches to for a signed-in
-- request, and the role every policy below is written against. It is not the
-- table owner and has no BYPASSRLS, which is what makes RLS actually apply.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    -- Bypasses RLS by design. Confined to the enumerated system operations in
    -- SECURITY.md §3.2 — migrations, retention sweeps, webhook reconciliation.
    create role service_role nologin noinherit bypassrls;
  end if;
end
$$;

grant usage on schema public to anon, authenticated, service_role;
grant usage on schema app to anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- auth.uid() shim
-- -----------------------------------------------------------------------------
-- Supabase supplies `auth.uid()`. Creating it only when absent means the local
-- stack and the test harness behave identically to a real project without
-- forking the policies.
create schema if not exists auth;

-- Supabase grants these; a freshly created schema grants USAGE to nobody but its
-- owner. Without this, `auth.uid()` raises "permission denied for schema auth"
-- for the `authenticated` role, `app.current_parent_id()` swallows it as "no
-- identity", and every policy denies — a total outage that looks like an
-- authorization bug.
grant usage on schema auth to anon, authenticated, service_role;

do $$
begin
  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'auth' and p.proname = 'uid'
  ) then
    execute $shim$
      create function auth.uid() returns uuid
      language sql stable
      as $body$
        select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', '')::uuid
      $body$;
    $shim$;
  end if;
end
$$;

-- -----------------------------------------------------------------------------
-- Identity resolution
-- -----------------------------------------------------------------------------
-- The single function every RLS policy calls.
--
-- Wrapping `auth.uid()` rather than calling it directly buys two things:
--   1. Malformed or absent JWT claims yield NULL instead of raising. Supabase's
--      own auth.uid() throws on a malformed claim, and an exception inside a
--      policy is a confusing 500 rather than a clean denial.
--   2. A GUC fallback (`app.current_parent_id`) so the test harness and a local
--      psql session can assume an identity without minting a JWT.
--
-- NULL is the safe value: every policy compares a column to this function, and
-- `column = NULL` is never true — so no identity means no rows, never all rows.
create or replace function app.current_parent_id()
returns uuid
language plpgsql
stable
as $$
declare
  v_id  text;
begin
  begin
    v_id := auth.uid()::text;
  exception when others then
    v_id := null;
  end;

  if v_id is null or v_id = '' then
    v_id := nullif(current_setting('app.current_parent_id', true), '');
  end if;

  if v_id is null then
    return null;
  end if;

  begin
    return v_id::uuid;
  exception when invalid_text_representation then
    return null;
  end;
end;
$$;

comment on function app.current_parent_id() is
  'The authenticated parent for this request, or NULL. Every RLS policy depends on it; NULL denies.';

-- -----------------------------------------------------------------------------
-- Identifiers
-- -----------------------------------------------------------------------------
-- UUIDv7: 48-bit big-endian millisecond timestamp, version 7, RFC 4122 variant,
-- remainder random.
--
-- Hand-rolled rather than PostgreSQL 18's native `uuidv7()` because Supabase is
-- currently PG15-17. A function that exists on the test cluster and not the
-- deployment target is a migration that passes CI and fails in production.
--
-- v7 over v4 matters most on `messages` and `analytics_events`, the highest-write
-- tables here: time-ordered keys keep B-tree inserts local instead of scattering
-- across the index.
create or replace function app.gen_uuid_v7()
returns uuid
language plpgsql
volatile
as $$
declare
  v_bytes bytea;
  v_ms    bigint;
begin
  v_ms := (extract(epoch from clock_timestamp()) * 1000)::bigint;
  v_bytes := uuid_send(gen_random_uuid());   -- 16 random bytes, no pgcrypto needed

  v_bytes := set_byte(v_bytes, 0, ((v_ms >> 40) & 255)::int);
  v_bytes := set_byte(v_bytes, 1, ((v_ms >> 32) & 255)::int);
  v_bytes := set_byte(v_bytes, 2, ((v_ms >> 24) & 255)::int);
  v_bytes := set_byte(v_bytes, 3, ((v_ms >> 16) & 255)::int);
  v_bytes := set_byte(v_bytes, 4, ((v_ms >> 8) & 255)::int);
  v_bytes := set_byte(v_bytes, 5, (v_ms & 255)::int);

  v_bytes := set_byte(v_bytes, 6, ((get_byte(v_bytes, 6) & 15) | 112));   -- version 7
  v_bytes := set_byte(v_bytes, 8, ((get_byte(v_bytes, 8) & 63) | 128));   -- variant 10xx

  return encode(v_bytes, 'hex')::uuid;
end;
$$;

-- `app.owns_child()` — the ownership helper every child-scoped policy calls — is
-- defined in the `children` migration, because a SQL-bodied function is
-- validated at creation time and cannot reference a table that does not yet
-- exist.

-- -----------------------------------------------------------------------------
-- Age bands
-- -----------------------------------------------------------------------------
-- Derived, never stored: a stored band goes stale on the child's birthday, and
-- a generated column would need an IMMUTABLE expression, which age is not.
create or replace function app.age_band(
  p_birth_year  int,
  p_birth_month int,
  p_at          date default current_date
)
returns text
language sql
stable
as $$
  select case
    when v.age <= 4 then 'early'
    when v.age <= 6 then 'emerging'
    when v.age <= 8 then 'developing'
    else                 'fluent'
  end
  from (
    select extract(year from age(p_at, make_date(p_birth_year, p_birth_month, 1)))::int as age
  ) v;
$$;

-- -----------------------------------------------------------------------------
-- Shared triggers
-- -----------------------------------------------------------------------------
create or replace function app.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- Append-only enforcement, in two strengths.
--
-- Raising rather than using a DO INSTEAD NOTHING rule, because a rule silently
-- discards the statement — the caller believes it worked, and a test cannot tell
-- the difference between "blocked" and "no rows matched".
--
-- `reject_update` — UPDATE only. For ledgers that must still be ERASABLE: a
-- consent record, a learning event, and an analytics event all cascade from
-- `parents`, and blocking DELETE here would make account erasure impossible.
-- The erasure right and the integrity of the ledger are both real requirements,
-- and this is where they meet: history cannot be rewritten, but it can be
-- deleted wholesale when the person it belongs to asks. User-initiated deletes
-- are prevented by withholding the DELETE grant, not by this trigger.
create or replace function app.reject_update()
returns trigger
language plpgsql
as $$
begin
  raise exception 'table %.% is append-only and cannot be updated',
    tg_table_schema, tg_table_name
    using errcode = 'restrict_violation';
end;
$$;

-- `reject_mutation` — UPDATE and DELETE. For `audit_logs`, which deliberately
-- has no foreign key and must outlive its subjects, so nothing ever cascades
-- into it. The retention sweep is the one legitimate deleter and must say so
-- explicitly by setting the GUC, which makes the intent visible in the audit
-- trail rather than indistinguishable from tampering.
create or replace function app.reject_mutation()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' and coalesce(current_setting('app.retention_sweep', true), '') = 'on' then
    return old;
  end if;

  raise exception 'table %.% is append-only', tg_table_schema, tg_table_name
    using errcode = 'restrict_violation';
end;
$$;

-- -----------------------------------------------------------------------------
-- Migration ledger
-- -----------------------------------------------------------------------------
create table if not exists schema_migrations (
  version     text        primary key,
  applied_at  timestamptz not null default now(),
  checksum    text        not null
);

comment on table schema_migrations is
  'Applied migrations. Forward-only; a merged migration is never edited.';
