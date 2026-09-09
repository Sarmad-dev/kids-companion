# Data Model

**Status:** Implemented on Supabase PostgreSQL. 14 migrations in `infra/migrations/`, verified by 134 integration tests against real PostgreSQL.
**Conventions:** [DATABASE_CONVENTIONS.md](DATABASE_CONVENTIONS.md) · **Policy:** [PRIVACY.md](../PRIVACY.md) · [SECURITY.md](../SECURITY.md) · [CHILD_SAFETY.md](CHILD_SAFETY.md)

---

## 1. The shape

21 tables and 2 views. Every table except the four reference tables resolves, by joining upward, to a single question: **does this row belong to the authenticated parent?**

```
parents ──┬── children ──┬── child_languages
          │              ├── parental_controls (1:1, auto-created)
          │              ├── conversations ── messages ──┐
          │              ├── speech_practice ── pronunciation_results
          │              ├── learning_progress
          │              ├── learning_events
          │              └── content_flags ◀──────────────┘
          │
          ├── subscriptions ── transactions
          ├── consent_records          (append-only)
          ├── notifications
          └── analytics_events         (append-only)

payment_events   (webhook ledger; parent link SET NULL on erasure)
audit_logs       (append-only, no FK by design)

Reference, no owner: supported_languages · subscription_plans
                     ai_characters · character_languages

Views: current_consents
```

### 1.1 Naming

The user table is **`parents`**, not `users`. This product has exactly one kind of user, and naming the table for its role makes the schema read correctly: `parent_id` on a child row says what the relationship _is_.

`parents.id` **is** `auth.users.id` — not a separate key joined to it. Every policy is then a direct comparison against `auth.uid()` with no extra lookup, and the profile row cannot drift from the auth row. On Supabase a foreign key to `auth.users` is added automatically; on a vanilla cluster that step is skipped.

### 1.2 Tables added beyond the brief

| Table                     | Why                                                                                                                                                                                                                    |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `supported_languages`     | `child_languages` needs something to reference, and "supported" is not one boolean — a language can be fine for text long before its child-speech recognition works. Separate `stt_supported` / `tts_supported` flags. |
| `character_languages`     | Adding Urdu to a character is a content decision made per language, gated on that language's TTS quality — not a property of the character.                                                                            |
| `current_consents` (view) | The latest decision per parent/child/type, derived from the append-only ledger. Without it every caller reimplements the same `distinct on`.                                                                           |

---

## 2. Supabase RLS

### 2.1 How identity resolves

```
app.current_parent_id()
  ├─ auth.uid()                  -- Supabase; shimmed locally if absent
  └─ app.current_parent_id GUC   -- psql and the test harness
     └─ NULL when neither resolves
```

**NULL denies.** Every policy compares a column against this function, and `column = NULL` is never true — so no identity means no rows, never all rows. Malformed claims (`not json`, `{"sub": "not-a-uuid"}`, `{"sub": null}`, `{}`) are caught and treated as no identity, never as a bypass. Each of those is a test.

The wrapper exists rather than calling `auth.uid()` directly because Supabase's own `auth.uid()` raises on a malformed claim, and an exception inside a policy is a confusing 500 rather than a clean denial.

### 2.2 The role model

Policies are written against **`authenticated`** — the role Supabase switches to for a signed-in request. It is not the table owner and has no `BYPASSRLS`.

Every table is `ENABLE` **and** `FORCE ROW LEVEL SECURITY`. `FORCE` matters as much as `ENABLE`: without it the table owner is exempt, and policies silently do nothing for the connection that most often owns the tables. A test enumerates every table and fails if either flag is off.

`service_role` bypasses RLS by design, confined to the enumerated system operations in [SECURITY.md §3.2](../SECURITY.md).

### 2.3 The ownership helper

Child-scoped tables call `app.owns_child(child_id)` rather than repeating a two- or three-way join. `SECURITY DEFINER` with a pinned `search_path`, because a policy on `children` calling a function that reads `children` would otherwise recurse.

It also **excludes soft-deleted children** — so a child in the deletion grace window becomes unreachable across every table at once, in one place, rather than needing the same `deleted_at is null` clause repeated fifteen times and forgotten once.

---

## 3. The security requirements, and where each is enforced

| Requirement                                             | Mechanism                                                                  | Test   |
| ------------------------------------------------------- | -------------------------------------------------------------------------- | ------ |
| A parent can only access their own account              | `parents_select_self`, `parents_update_self`                               | ✅     |
| A parent can only access their own children             | `children_*_owner` on `parent_id`                                          | ✅     |
| A parent can only access their children's conversations | `app.owns_child()` on `conversations`, `messages`                          | ✅     |
| A parent cannot access another parent's child           | Read, update, delete, **and cross-tenant write**                           | ✅ ×4  |
| A child profile never exposes another user's data       | Every child-scoped table joins upward to one parent                        | ✅ ×15 |
| Payment data is minimised, no raw card                  | No column can hold a PAN; `last4` bounded to 4 digits                      | ✅     |
| Sensitive operations are auditable                      | `audit_logs`, append-only, service-role actions must carry a justification | ✅     |

Every child-owned table carries **both** assertions: Bob cannot read Alice's rows, _and_ Alice can read her own. Without the second, a policy that denies everyone would pass the isolation suite while breaking the product.

---

## 4. What the schema refuses to do

Enforced by the database, not by application code — a constraint that lives only in application code is one a migration script, an admin action, or a second service will eventually violate.

| Rule                                                        | Mechanism                                                                            |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| A parent cannot write a row into another parent's scope     | `with check` on every INSERT and UPDATE policy                                       |
| A parent cannot rewrite conversation history                | No UPDATE policy on `messages`                                                       |
| A parent cannot delete or edit a safety flag                | SELECT-only policy on `content_flags`                                                |
| A parent cannot grant themselves a subscription             | SELECT-only; state comes from verified webhooks                                      |
| A parent cannot forge a notification                        | SELECT + UPDATE only; system raises them                                             |
| A parent cannot rewrite consent history                     | No UPDATE grant, plus an append-only trigger behind it                               |
| An audit record cannot be altered or removed                | Append-only trigger; retention sweep must opt in explicitly                          |
| A child cannot exist without limits                         | Trigger creates `parental_controls` at profile creation                              |
| A message's ownership cannot disagree with its conversation | `child_id` derived by trigger, not trusted from the caller                           |
| An unverified webhook cannot be marked processed            | `ck_payment_events_unverified_not_processed`                                         |
| A replayed webhook cannot double-charge                     | `unique (rail, external_id)` on both `transactions` and `payment_events`             |
| A parent cannot hold two live subscriptions                 | Partial unique index on `status in ('trialing','active')`                            |
| A refund cannot be positive                                 | Sign check per transaction kind                                                      |
| A "free" plan cannot have a price                           | `ck_subscription_plans_free_is_free`                                                 |
| An ended conversation cannot omit why                       | `ck_conversations_ended_has_reason`                                                  |
| A safety escalation cannot simply be dismissed              | `ck_content_flags_escalation_not_dismissed`                                          |
| A child cannot have two primary languages                   | Partial unique index on `is_primary`                                                 |
| **Speech practice cannot store audio**                      | No `bytea` or audio-named column exists — and a test fails the build if one is added |

---

## 5. Payment data minimisation

No table can hold a card number, CVV, expiry, IBAN, or bank account number. What is stored:

- an **opaque vendor token** (`payment_method_token`),
- a brand (`visa`, `wallet`, …),
- `payment_method_last4`, constrained to exactly four digits.

Enforced structurally: a test greps every column in the schema for card-shaped names (`card_number`, `pan`, `cvv`, `cvc`, `expiry`, `exp_month`, `iban`, `routing`, …) and fails the build on a match. `payment_events.payload` has card fields stripped before insert and is size-bounded.

---

## 6. Erasure — and the conflict it created

Deleting a parent cascades through children, languages, controls, conversations, messages, flags, practice, results, progress, events, subscriptions, transactions, consents, notifications, and analytics. A test asserts each is empty afterwards.

**This surfaced a real design bug during implementation.** The append-only triggers on `consent_records`, `learning_events`, and `analytics_events` blocked the cascade — making account erasure impossible. Two legitimate requirements in direct conflict: _history cannot be rewritten_ versus _deletion must actually delete_.

The resolution splits append-only into two strengths:

- **`app.reject_update()`** — UPDATE only. For ledgers that must remain erasable. User-initiated deletes are prevented by withholding the DELETE grant, not by a trigger, so a cascade still works.
- **`app.reject_mutation()`** — UPDATE and DELETE. For `audit_logs` alone, which has no foreign key so nothing cascades into it. The retention sweep opts in explicitly via the `app.retention_sweep` GUC, making legitimate deletion visible rather than indistinguishable from tampering.

`payment_events.parent_id` is `ON DELETE SET NULL`, not cascade: the payment ledger survives erasure in the minimised form the legal-retention exception in [PRIVACY.md §7](../PRIVACY.md) allows — amount and date, no link to the person. Tested.

---

## 7. Soft delete

`deleted_at` exists on **`parents` and `children` only**, for exactly one purpose: the 30-day account grace window. The retention sweep then hard-deletes.

Everywhere else, delete means delete. A soft-delete flag that leaves the row in place is retained data wearing a disguise. A soft-deleted child is invisible even to its owner — `app.owns_child()` filters it — because the grace window is a deletion in progress, not a hidden row that still serves reads.

---

## 8. Type generation

```bash
pnpm db:types
```

Generates `packages/types/src/database.generated.ts` from the migrations: `Row`, `Insert`, and `Update` per table, plus a Supabase-shaped `Database` interface for `createClient<Database>()`.

Equivalent in spirit to `supabase gen types typescript`, but driven by the committed migration files rather than a live project — so it runs in CI with no network, no Supabase credentials, and no Docker, and cannot drift from the SQL actually in the repository.

`CHECK (col in (...))` constraints become string-literal unions, so `status` is `'active' | 'paused' | 'archived'` rather than `string`. `pnpm db:types:check` fails CI if the committed file is stale.

---

## 9. How this is tested

`tests/integration/` runs against **real PostgreSQL** via PGlite (Postgres compiled to WebAssembly), applying the same migration files through the same loader (`@kids/db`) that `pnpm db:migrate` uses in production. Identity is assumed exactly as Supabase does it — by setting `request.jwt.claims` — so the tests exercise the real code path rather than a test-only shortcut.

Testcontainers was the obvious alternative and was rejected: it needs a Docker daemon, which turns "run the tests" into a machine-setup problem. The suite proving one family cannot read another family's child's conversations must be the one that always runs, not the one people skip.

**Known limitation — version skew.** PGlite is PG18; Supabase is currently 15–17. Migrations are written to PG15+ portable SQL and `app.gen_uuid_v7()` is hand-rolled rather than using PG18's native `uuidv7()`. This suite proves the policies are correct; it does not replace running the migrations against the real target version before deploying. That containerised run belongs in CI before Phase 1 closes.

---

## 10. Seed data

**Reference data ships in a migration** (`20260817131300_seed_reference.sql`) because it belongs in every environment: 6 languages, 3 subscription plans, 5 characters, and their language mappings. Idempotent.

Two things there are worth noticing:

- **Urdu has `stt_supported = false`.** Child-speech recognition for Urdu is unproven until the S-1 spike reports ([Q-01](OPEN_QUESTIONS.md)). Marking it supported before it is measured would be the schema asserting something we do not know.
- **`dada-jee` ships as `beta`.** It is the Urdu-first character, and it stays beta until Urdu safety classification reaches parity with English. A classifier weaker in Urdu than in English is a safety gap, not a localisation gap.

**Development fixtures are a script, not a migration:**

```bash
pnpm db:seed:dev
```

`infra/scripts/seed-dev.mjs` refuses to run unless `APP_ENV` is `local` or `ci`. Migrations run everywhere; these records must never exist in staging or production, and keeping them out of the migration path means "seeded a test family into production" cannot happen by running the normal deploy. It creates **two** families deliberately — a single-family fixture set makes a cross-tenant leak invisible while clicking around by hand.

---

## 11. Commands

| Command                 | Does                                            |
| ----------------------- | ----------------------------------------------- |
| `pnpm db:migrate`       | Apply pending migrations to `$DATABASE_URL`     |
| `pnpm db:status`        | List applied and pending migrations             |
| `pnpm db:types`         | Regenerate TypeScript types from the migrations |
| `pnpm db:types:check`   | Fail if the committed types are stale           |
| `pnpm db:seed:dev`      | Development fixtures (refuses outside local/ci) |
| `pnpm test:integration` | Schema and RLS suites                           |

---

## 12. Open questions this model touches

- **[Q-11](OPEN_QUESTIONS.md)** — `parental_controls.transcript_retention_days` defaults to 90. That default is the weakest link in the minimisation story and deserves to be argued rather than inherited.
- **[Q-12](OPEN_QUESTIONS.md)** — `learning_progress` stores exposure and activity counts, with no column named `mastery`, `level`, or `grade`. The temptation to overstate this is structural: parents are the buyers.
- **[Q-06](OPEN_QUESTIONS.md)** — whether pronunciation scoring needs a specialised model. Whatever the answer, the audio is not retained.
- **[Q-02](OPEN_QUESTIONS.md)** — `subscription_plans.available_rails` exists because app-store billing and Pakistani wallets are in tension. The column shape is right whichever way that resolves.

## 13. Not yet built

`devices`, `sessions`, and `refresh_tokens` — the authentication spine from [ADR-0005](adr/0005-auth-and-session-model.md). RLS works without them because identity resolves through the JWT claim. They are the remaining Phase 1 database work, alongside the API surface over this schema.
