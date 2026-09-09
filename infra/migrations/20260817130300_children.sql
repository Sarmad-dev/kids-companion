-- =============================================================================
-- children, child_languages
-- =============================================================================
-- A child is DATA OWNED BY A PARENT, not an account: no password, no email, no
-- recovery path. Any credential implies a recovery flow, and every recovery flow
-- for a child requires collecting more identifying data about that child
-- (docs/adr/0005-auth-and-session-model.md).

create table children (
  id            uuid        primary key default app.gen_uuid_v7(),
  parent_id     uuid        not null,
  -- First name or nickname only. Surnames are never collected — they add
  -- identifiability without improving the experience (PRIVACY.md §3.2).
  display_name  text        not null,
  birth_year    int         not null,
  birth_month   int         not null,
  avatar_key    text,
  interests     text[]      not null default array[]::text[],
  status        text        not null default 'active',
  deleted_at    timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint fk_children_parent
    foreign key (parent_id) references parents (id) on delete cascade,

  constraint ck_children_status check (status in ('active', 'paused', 'archived')),
  constraint ck_children_display_name_length
    check (char_length(display_name) between 1 and 40),
  constraint ck_children_birth_year_range check (birth_year between 2000 and 2100),
  constraint ck_children_birth_month_range check (birth_month between 1 and 12),
  constraint ck_children_interests_bounded check (cardinality(interests) <= 20)
);

-- Indexed because it is an RLS predicate column. An unindexed policy predicate
-- turns every query on the table into a sequential scan — the most common reason
-- RLS gets blamed for making Postgres slow.
create index idx_children_parent_id on children (parent_id);
create index idx_children_active on children (parent_id) where deleted_at is null;

create trigger trg_children_touch
  before update on children
  for each row execute function app.touch_updated_at();

comment on table children is
  'S2 — child profiles. No password, no email, no recovery path.';
comment on column children.display_name is
  'S2 — child first name or nickname. Retention: life of profile.';
comment on column children.birth_year is
  'S2 — year only, with birth_month. No day-precision DOB is collected.';
comment on column children.interests is
  'S2 — parent-set. Never inferred from what the child says.';

-- -----------------------------------------------------------------------------
-- The ownership helper
-- -----------------------------------------------------------------------------
-- Deep tables (messages, pronunciation_results, learning_events) would otherwise
-- repeat a two- or three-way join in every policy. One function keeps the
-- policies readable and the plan consistent, and gives a single place to change
-- what "owns" means — note that it also excludes soft-deleted children, so a
-- child in the deletion grace window becomes unreachable everywhere at once.
--
-- SECURITY DEFINER is required: the function reads `children`, and calling it
-- from a policy ON `children` would otherwise recurse. `search_path` is pinned
-- so the definer's rights cannot be redirected by a caller.
create or replace function app.owns_child(p_child_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from children c
    where c.id = p_child_id
      and c.parent_id = app.current_parent_id()
      and c.deleted_at is null
  );
$$;

comment on function app.owns_child(uuid) is
  'Does the current parent own this child? SECURITY DEFINER to avoid policy recursion on children.';

alter table children enable row level security;
alter table children force row level security;

create policy children_select_owner on children
  for select to authenticated
  using (parent_id = app.current_parent_id() and deleted_at is null);

-- `with check` on insert, or a parent could write a row assigned to a different
-- parent — a cross-tenant WRITE rather than a cross-tenant read.
create policy children_insert_owner on children
  for insert to authenticated
  with check (parent_id = app.current_parent_id());

create policy children_update_owner on children
  for update to authenticated
  using (parent_id = app.current_parent_id() and deleted_at is null)
  with check (parent_id = app.current_parent_id());

create policy children_delete_owner on children
  for delete to authenticated
  using (parent_id = app.current_parent_id());

grant select, insert, update, delete on children to authenticated;

-- -----------------------------------------------------------------------------
-- child_languages
-- -----------------------------------------------------------------------------
-- Normalised out of the child row because a child's languages are a set with
-- attributes, not a scalar: which is primary, and how fluent the child is in
-- each. Pakistani households routinely code-switch mid-sentence, so "one
-- language per child" was never going to hold.
create table child_languages (
  child_id       uuid        not null,
  language_code  text        not null,
  is_primary     boolean     not null default false,
  proficiency    text        not null default 'learning',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  -- A composite natural key: the pair IS the identity, and a surrogate uuid here
  -- would add a column without preventing the duplicate this key prevents.
  constraint pk_child_languages primary key (child_id, language_code),

  constraint fk_child_languages_child
    foreign key (child_id) references children (id) on delete cascade,
  constraint fk_child_languages_language
    foreign key (language_code) references supported_languages (code) on delete restrict,

  constraint ck_child_languages_proficiency
    check (proficiency in ('learning', 'conversational', 'fluent', 'native'))
);

-- Exactly one primary language per child. Enforced here rather than in the
-- application, because "which language do we generate in?" must have exactly
-- one answer at request time.
create unique index uq_child_languages_one_primary
  on child_languages (child_id) where is_primary;

create index idx_child_languages_language on child_languages (language_code);

create trigger trg_child_languages_touch
  before update on child_languages
  for each row execute function app.touch_updated_at();

comment on table child_languages is
  'S2 — a child''s languages. Drives STT hints and generation language; never autodetected from speech.';

alter table child_languages enable row level security;
alter table child_languages force row level security;

create policy child_languages_select_owner on child_languages
  for select to authenticated using (app.owns_child(child_id));

create policy child_languages_insert_owner on child_languages
  for insert to authenticated with check (app.owns_child(child_id));

create policy child_languages_update_owner on child_languages
  for update to authenticated
  using (app.owns_child(child_id))
  with check (app.owns_child(child_id));

create policy child_languages_delete_owner on child_languages
  for delete to authenticated using (app.owns_child(child_id));

grant select, insert, update, delete on child_languages to authenticated;
