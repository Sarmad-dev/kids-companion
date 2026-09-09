-- =============================================================================
-- parents — the user table. The only principal that authenticates.
-- =============================================================================
-- Named `parents` rather than `users` because this product has exactly one kind
-- of user, and naming it for its role keeps the schema readable: `parent_id` on
-- a child row says what the relationship is, `user_id` does not.
--
-- `id` IS the Supabase `auth.users.id`, not a separate key joined to it. That
-- makes every policy a direct comparison against `auth.uid()` with no extra
-- lookup, and makes it impossible for the profile row and the auth row to drift
-- apart. Children never authenticate (docs/adr/0005).

create table parents (
  id                 uuid        primary key,
  email              text        not null,
  -- NULL when the account uses Supabase Auth, which holds the credential in
  -- auth.users. Present only if a self-managed Argon2id hash is ever needed.
  password_hash      text,
  display_name       text,
  country_code       char(2)     not null default 'PK',
  locale             text        not null default 'en',
  timezone           text        not null default 'Asia/Karachi',
  status             text        not null default 'active',
  -- Parent-gate configuration (a child barrier, not an auth control).
  parent_gate_mode   text        not null default 'arithmetic',
  marketing_opt_in   boolean     not null default false,
  last_seen_at       timestamptz,
  -- Soft delete exists for exactly one reason: the 30-day account grace window
  -- in PRIVACY.md §6. The retention sweep then HARD deletes, cascading to every
  -- child, conversation, and message. A flag that merely hides a row from the
  -- UI is retained data wearing a disguise, not erasure.
  deleted_at         timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  constraint ck_parents_status
    check (status in ('active', 'suspended', 'pending_deletion')),
  constraint ck_parents_gate_mode
    check (parent_gate_mode in ('arithmetic', 'device_biometric', 'pin')),
  constraint ck_parents_email_shape check (position('@' in email) > 1),
  constraint ck_parents_country_code check (country_code ~ '^[A-Z]{2}$'),
  -- A row marked deleted must also be marked pending_deletion, so the grace
  -- window cannot be entered by setting only one of the two.
  constraint ck_parents_deletion_consistent
    check (deleted_at is null or status = 'pending_deletion')
);

-- On Supabase, tie the profile to the auth row so deleting the auth user
-- cascades the whole family's data. Skipped on a vanilla cluster, where
-- auth.users does not exist.
do $$
begin
  if exists (
    select 1 from information_schema.tables
    where table_schema = 'auth' and table_name = 'users'
  ) then
    execute 'alter table parents add constraint fk_parents_auth_user
             foreign key (id) references auth.users (id) on delete cascade';
  end if;
end
$$;

-- Expression uniqueness must be an index; a UNIQUE constraint cannot hold an
-- expression. Case-insensitive because people capitalise inconsistently and
-- would otherwise create a second account they cannot sign into.
create unique index uq_parents_email on parents (lower(email)) where deleted_at is null;

create index idx_parents_pending_deletion on parents (deleted_at)
  where deleted_at is not null;

create trigger trg_parents_touch
  before update on parents
  for each row execute function app.touch_updated_at();

comment on table parents is
  'S1 — account holders. id = auth.users.id. The only principal that authenticates.';
comment on column parents.email is
  'S1 — parent email. Retention: life of account + 30d grace.';
comment on column parents.password_hash is
  'S1 — Argon2id when self-managed; NULL under Supabase Auth. Never logged, never returned.';
comment on column parents.country_code is
  'S1 — country only. Precise location is never collected (PRIVACY.md §3.2).';

-- -----------------------------------------------------------------------------
-- RLS
-- -----------------------------------------------------------------------------
-- Enabled in the same migration that creates the table. A window in which a
-- table exists without policies is a window in which a deploy can expose it.
alter table parents enable row level security;
alter table parents force row level security;   -- the owner is not exempt either

create policy parents_select_self on parents
  for select to authenticated
  using (id = app.current_parent_id() and deleted_at is null);

create policy parents_update_self on parents
  for update to authenticated
  using (id = app.current_parent_id() and deleted_at is null)
  with check (id = app.current_parent_id());

-- No INSERT or DELETE policy by design. Account creation is driven by the auth
-- provider, and erasure is a system operation under the service role — neither
-- is something a request handler performs on behalf of the account itself.

grant select, update on parents to authenticated;
