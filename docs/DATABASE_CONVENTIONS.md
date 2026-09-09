# Database Conventions

Postgres via Supabase. Row Level Security on every table holding parent or child data.

---

## 1. Naming

| Object                 | Convention                         | Example                                |
| ---------------------- | ---------------------------------- | -------------------------------------- |
| Table                  | `snake_case`, plural               | `child_profiles`                       |
| Column                 | `snake_case`, singular             | `display_name`                         |
| Primary key            | `id`                               | `id`                                   |
| Foreign key            | `<singular_table>_id`              | `parent_id`                            |
| Boolean                | `is_` / `has_` prefix              | `is_active`                            |
| Timestamp              | `_at` suffix, always `timestamptz` | `created_at`                           |
| Index                  | `idx_<table>_<cols>`               | `idx_turns_conversation_id_created_at` |
| Unique                 | `uq_<table>_<cols>`                | `uq_parents_email`                     |
| Foreign key constraint | `fk_<table>_<ref>`                 | `fk_child_profiles_parent`             |
| Check                  | `ck_<table>_<rule>`                | `ck_child_profiles_birth_year_range`   |
| RLS policy             | `<table>_<action>_<principal>`     | `child_profiles_select_owner`          |
| Function               | `snake_case`, verb-first           | `resolve_age_band`                     |

**`timestamptz`, never `timestamp`.** A companion used across Karachi, London, and Toronto stores absolute instants. `timestamp` without a zone is a bug waiting for a timezone boundary.

---

## 2. Keys

Primary keys are **UUIDv7** with a short type prefix in the application layer (`chp_`, `cnv_`, `trn_`).

- UUID, not sequential integer: a sequential ID in a URL tells an attacker how many children are on the platform and invites enumeration.
- **v7, not v4**: v7 is time-ordered, so B-tree inserts stay local instead of scattering across the index. On the `turns` table — the highest-write table in the system — this is the difference between healthy and steadily degrading write performance.
- The prefix is application-layer only. It makes a log line or a support ticket self-describing, and makes passing a `ChildId` where a `ConversationId` belongs obvious rather than silent.

No natural keys. Email is unique-constrained, never a primary key — people change email addresses.

---

## 3. Every table gets

```sql
id          uuid        primary key default gen_uuid_v7(),
created_at  timestamptz not null default now(),
updated_at  timestamptz not null default now()
```

`updated_at` is maintained by a trigger, not by application code — because application code will eventually forget.

---

## 4. Referential integrity

Foreign keys are declared, always, with an explicit `ON DELETE` that encodes a real decision:

| Relationship                                   | Rule                | Why                                                                                                     |
| ---------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------- |
| `child_profiles.parent_id` → `parents.id`      | `ON DELETE CASCADE` | Deleting a parent must delete their children's data — this is the erasure right, enforced by the schema |
| `conversations.child_id` → `child_profiles.id` | `ON DELETE CASCADE` | Same                                                                                                    |
| `turns.conversation_id` → `conversations.id`   | `ON DELETE CASCADE` | Same                                                                                                    |
| `audit_log.actor_id`                           | **No FK**           | Audit records outlive their subjects by design                                                          |

Cascade deletes are the mechanism that makes "delete my child's data" actually complete. Application-level deletion loops miss rows; the database does not.

---

## 5. Constraints belong in the database

A constraint enforced only in application code is a constraint that a migration script, an admin action, or a second service will violate.

```sql
constraint ck_child_profiles_birth_year_range
  check (birth_year between 2000 and 2100),

constraint ck_turns_role
  check (role in ('child', 'companion')),

constraint uq_parents_email
  -- NOTE: an expression cannot go in a UNIQUE *constraint*. Case-insensitive
  -- uniqueness is a unique INDEX:
  --   create unique index uq_parents_email on parents (lower(email));
```

Enum-like columns are `text` + `check`, not a Postgres `enum` type. Adding a value to a Postgres enum requires a migration that cannot run in a transaction on older versions; a check constraint is a one-line change.

---

## 6. Row Level Security

**Every table with parent or child data has RLS enabled.** A table without it must be justified in the migration's comment.

```sql
alter table child_profiles enable row level security;
alter table child_profiles force row level security;

create policy child_profiles_select_owner on child_profiles
  for select using (parent_id = auth.uid());

create policy child_profiles_insert_owner on child_profiles
  for insert with check (parent_id = auth.uid());

create policy child_profiles_update_owner on child_profiles
  for update using (parent_id = auth.uid())
             with check (parent_id = auth.uid());

create policy child_profiles_delete_owner on child_profiles
  for delete using (parent_id = auth.uid());
```

Notes that matter:

- **`force row level security`** so the table owner is not exempt. Without it, the policy silently does nothing for the connection that most often has owner rights.
- **Separate policies per action.** A single `for all` policy hides the case where update should be narrower than select.
- **`with check` on insert and update**, or a parent can write a row assigned to a different parent.
- **Deeper tables join upward** to the owning parent. Every policy resolves to "does this row belong to the authenticated parent?".

**RLS is enabled in the same migration that creates the table**, not a later one. A window in which a table exists without policies is a window in which a deploy can expose it, and migrations do not always land in the order they were written.

### 6.1 Every policy is tested

A policy that has never been exercised is a guess. For each table: the owner can read, a non-owner **cannot**, and a non-owner cannot write a row into someone else's scope. See [TESTING_STANDARDS.md §5.1](TESTING_STANDARDS.md).

### 6.2 The service role

`SUPABASE_SERVICE_ROLE_KEY` bypasses every policy above. Its use is confined to the enumerated system operations in [SECURITY.md §3.2](../SECURITY.md), never to normal request handling. Reaching for it to "make a query work" defeats the entire backstop.

---

## 7. Migrations

Forward-only, versioned, immutable once merged.

```
infra/migrations/
├── 20260817090000_create_parents.sql
├── 20260817090100_create_child_profiles.sql
└── 20260817090200_conversations.sql
```

**Rules:**

1. **Never edit a merged migration.** Write a new one. Someone has already run the old one.
2. **One logical change per file.** A failed migration should leave an obvious question about one thing.
3. **Reversible where possible**, with a documented rollback. Where it is not (a destructive change), say so explicitly in a comment.
4. **Expand/contract for anything breaking.** Add the new column → backfill → dual-write → switch reads → drop the old column, across separate deploys. A mobile app on an old version will be talking to the new database for weeks.
5. **Every migration runs in a transaction** unless it genuinely cannot (concurrent index creation), and that exception is commented.
6. **Long-running changes must not lock a hot table.** `create index concurrently`, batched backfills. A `turns` table lock is a product outage.
7. Every migration is applied to staging before production, and rehearsed against a production-sized dataset for anything touching a large table.

---

## 8. Indexing

Index for the queries actually written, not speculatively — every index costs write throughput on a system whose highest-volume table is written on every conversational turn.

Mandatory:

- Every foreign key column.
- Every column in a RLS policy predicate. **An unindexed policy predicate turns every query on that table into a sequential scan**, which is the most common way RLS "makes Postgres slow".
- Sort and filter columns for list endpoints, as composite indexes in the query's order (`(conversation_id, created_at desc)`).

Partial indexes for the common filtered case:

```sql
create index idx_child_profiles_active on child_profiles (parent_id)
  where deleted_at is null;
```

---

## 9. Deletion, and why soft delete is the exception

Default to **hard delete**. In a system where erasure is a legal right and the data is children's conversations, a soft-delete flag that leaves the row in place is retained data wearing a disguise.

Soft delete (`deleted_at timestamptz`) is used only for the 30-day account grace window in [PRIVACY.md §6](../PRIVACY.md), and the grace period ends in a real, hard delete performed by the retention sweep.

Where soft delete is used, **every query must filter it** — enforced by a repository-layer default rather than by remembering, and by the partial indexes above.

---

## 10. Retention

Retention is a scheduled job driven by the `RETENTION_*` variables, not a manual process.

```sql
-- Nightly. Raw audio is already gone at transcription time; this is the backstop.
delete from audio_artifacts where created_at < now() - interval '1 day';

delete from turns
  where created_at < now() - (
    select retention_days from retention_policies where scope = 'transcript'
  ) * interval '1 day';
```

The sweep is **monitored**. A sweep that silently stops is a privacy incident and alerts as one — retained-past-policy data is exactly the situation that turns a breach into a much larger breach.

---

## 11. Queries

- **Parameterised, always.** String-built SQL is a build-blocking defect.
- **No `select *`** in application code. Adding a column should never change what an endpoint returns — that is how a sensitive field leaks.
- **No N+1.** Join, or batch.
- **Statement timeout** on every connection (`DATABASE_STATEMENT_TIMEOUT_MS`). An unbounded query in the voice loop is worse than a failed one.
- **Transactions** for multi-statement writes that must be atomic, held for the shortest possible time. No external calls inside a transaction — never hold a database lock across an LLM round trip.

---

## 12. Sensitive columns

Columns holding S3-class data ([PRIVACY.md §3](../PRIVACY.md)) carry application-layer encryption in addition to at-rest encryption, so a database dump alone is not sufficient to read a child's conversations:

```sql
transcript_ciphertext  bytea not null,
transcript_key_id      text  not null,   -- ENCRYPTION_ACTIVE_KEY_ID at write time
```

Storing the key ID per row is what makes key rotation a background re-encryption instead of a maintenance window.

Every column holding personal data is annotated in the migration with its class, so the schema itself documents the data inventory:

```sql
comment on column child_profiles.display_name is 'S2 — child first name. Retention: life of profile.';
```
