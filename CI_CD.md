# CI/CD

How code gets from a pull request to a running environment, and how to undo it.

---

## Read this first

**The workflows have never run on GitHub.** They were written and validated
locally: every file parses, every script they call has been executed and
negative-tested, and the whole pull-request pipeline was run end to end from a
clean checkout (§10). What has not happened is a real Actions run, because that
requires pushing to the repository.

**Two of the guarantees in this document are repository settings, not files.**
Branch protection and production approval cannot be enabled from a workflow —
a workflow that names an environment with no protection rules runs straight
through, and a required check that nobody required blocks nothing. §3 and §5
give the exact settings; §9 says how to confirm they are on. Until then, this
document describes an intent, not an enforced rule.

**Nothing can deploy anywhere yet.** There is no hosting target, so
`infra/scripts/release.sh` fails deliberately rather than reporting success for
work it did not do. Production additionally refuses to start — see §5.3.

---

## 1. The pipeline

```
pull request ──► CI ──► review ──► merge to main
                                        │
                                        ├──► Deploy — development   (automatic)
                                        └──► Deploy — staging       (automatic)
                                                     │
                                                     ▼
                                        Deploy — production
                                        (manual dispatch + approval)
```

Images are built **once**, tagged by commit SHA, and promoted. Production
deploys the digest staging verified; it does not rebuild. A rebuild is a
different artifact than the one that was tested, however identical the inputs
look — base images move and mirrors resolve differently, and "it built again" is
not evidence.

---

## 2. What runs on a pull request

[`.github/workflows/ci.yml`](.github/workflows/ci.yml), five jobs plus an
aggregate.

| Job                 | What it runs                                                                                                                       | Needs            |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| **Verify**          | secret scan → install → format → typecheck → lint → db types → migration safeguards → deployment config → dependency audit → build | —                |
| **Tests**           | unit (734), integration (716)                                                                                                      | —                |
| **Database**        | migrations against real PostgreSQL 17, idempotency re-check, e2e                                                                   | postgres service |
| **Images**          | builds both images, smoke-tests the API container                                                                                  | Verify           |
| **Browser E2E**     | Playwright, Chromium                                                                                                               | Verify           |
| **Required checks** | fails unless Verify, Tests, Database and Images all succeeded                                                                      | those four       |

**Typecheck runs before lint, and the order is load-bearing.** `tsc -b` emits
the workspace `.d.ts` files that ESLint's type-aware rules need to resolve
cross-package types. Reversed, it passes locally — where `dist/` already exists
from the last build — and fails on a clean checkout, which is the state CI is
always in. §10 is partly there to keep that honest.

`Verify` and `Tests` are split so a failing test and a failing lint are two
separate red marks rather than one that has to be opened to interpret.

---

## 3. Preventing a merge when checks fail

**This is a repository setting. Nothing in this repository can enable it.**

Require exactly one check — `Required checks` — rather than listing the jobs
individually. That job fails unless every job it depends on succeeded, including
when one is _skipped_ or _cancelled_, which a naive `needs:` would let through
as green. Requiring the aggregate also means adding a job to the workflow does
not mean editing a repository setting to match.

With the GitHub CLI:

```bash
gh api -X PUT repos/:owner/:repo/branches/main/protection \
  -f 'required_status_checks[strict]=true' \
  -f 'required_status_checks[contexts][]=Required checks' \
  -F 'enforce_admins=true' \
  -f 'required_pull_request_reviews[required_approving_review_count]=1' \
  -F 'restrictions=null'
```

`strict=true` requires the branch to be up to date with main before merging.
Without it, two pull requests that each pass alone can break main together.

**`Browser E2E` is deliberately NOT required.** It has never been executed —
Playwright needs ~400 MB of browser binaries that were never installed here — so
requiring it would block every merge on a suite with no track record. Make it
required once it has passed a few times honestly.

---

## 4. Deployment workflows

| Environment | Trigger                            | Approval              | File                                                               |
| ----------- | ---------------------------------- | --------------------- | ------------------------------------------------------------------ |
| development | push to main, or manual            | none                  | [deploy-development.yml](.github/workflows/deploy-development.yml) |
| staging     | push to main, or manual with a SHA | none                  | [deploy-staging.yml](.github/workflows/deploy-staging.yml)         |
| production  | **manual only**                    | **required reviewer** | [deploy-production.yml](.github/workflows/deploy-production.yml)   |

All three use `concurrency` with `cancel-in-progress: false`. One deployment at
a time, and an in-flight one is never cancelled: a deploy killed mid-migration
leaves a schema nobody chose.

Each deployment runs, in order: build (or verify) images → print pending
migrations → apply migrations → release → verify `/health` and `/ready`.

---

## 5. Production approval

Three independent gates.

### 5.1 No automatic trigger

`deploy-production.yml` has only `workflow_dispatch`. There is no `push`
trigger, so merging cannot reach production. A person picks a commit and starts
it, and must type `deploy to production` as a confirmation input — enough
friction to make the wrong button hard to press by accident.

### 5.2 A required reviewer · **repository setting**

The `deploy` job declares `environment: production`. GitHub pauses it before its
first step until an approver acts — **but only if the environment has protection
rules**. Configure at **Settings → Environments → production**:

- **Required reviewers**: at least one, and not the person who usually deploys.
- **Deployment branches**: `main` only.
- Secrets scoped to the environment, never repository-wide.

Without those, the workflow runs straight through with no pause. §9 says how to
confirm.

### 5.3 The preflight blocks it outright

Before the approval gate — so nobody is asked to approve a release that was
going to fail — `preflight` checks the confirmation phrase, that the commit is
an ancestor of `main`, and then **fails deliberately** on the two blockers from
[DEPLOYMENT.md §9](DEPLOYMENT.md): in-memory audio storage and per-instance rate
limiting. Neither is a setting; both are missing implementations.

Delete that step in the same change that resolves them.

---

## 6. Migration safeguards

Four layers, at three different times.

**At apply time**, `applyMigrations` refuses to run when a merged migration's
checksum has changed. That guard already existed and fires against a real
database, during a release.

**On every pull request**, [`check-migrations.mjs`](infra/scripts/check-migrations.mjs)
moves those failures earlier and adds two the runtime guard cannot make:

| Check                                                                   | Why                                                                                                                                                                         |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Filename, uniqueness, non-empty, forward-only                           | The version _is_ the filename.                                                                                                                                              |
| **Immutable** — no merged migration edited, deleted or renamed          | Someone has already run it. Editing produces a database that does not match what other environments applied.                                                                |
| **No back-dating** — a new migration must sort after everything on main | The ledger is keyed by version, so a back-dated file still runs, just in a different order than every environment that already applied the later one. Nothing reports that. |
| **Destructive statements need an acknowledgement**                      | During a rolling deploy both versions are live for a few minutes. Dropping a column the old version still selects is an outage during its own deploy.                       |

Destructive means `drop table`, `drop column`, `drop view`, `alter column …
type`, `set not null`, `rename`, `truncate`, and `delete` without a `where`.
`drop not null` is deliberately absent — widening a constraint is safe in both
directions. To ship one anyway, say why:

```sql
-- destructive-ok: `nickname` was added and removed inside this release train
-- and never reached a deployed version.
alter table children drop column nickname;
```

Only **new** migrations are checked for destructive statements. Existing ones
are immutable, so demanding a marker in them would require an edit this same
script forbids — they are grandfathered by construction, not by exception.

**During a deploy**, every workflow prints `db:status` before applying anything.
Versions only, never rows and never the connection string. When a deploy goes
wrong that list is the first thing anyone reads, and it needs to already be in
the log rather than reconstructed afterwards.

**In CI**, the `Database` job applies every migration to a real PostgreSQL 17
and then checks that a second pass reports nothing pending — a migration that is
not idempotent would corrupt state on a retried deploy.

---

## 7. Secrets in CI

**The pull-request workflow uses none.** `pull_request` gives a fork a read-only
token and no repository secrets, deliberately, because a pull request runs code
its author controls. Anything needing a credential is a deployment workflow.

`pull_request_target` is never used, and
[`check-deploy.mjs`](infra/scripts/check-deploy.mjs) fails the build if it
appears. It runs with repository secrets and the base repository's permissions
against a fork's code — which hands write credentials to anyone who opens a pull
request.

### Not printing them

GitHub masks registered secrets as `***`, and that is a safety net rather than a
control. It misses a value transformed before printing — base64, a substring,
JSON-encoded — because the transformed string is no longer the registered one.
So the enforced rule is _do not write them anywhere_:

| Refused                                                                 | Why                                                         |
| ----------------------------------------------------------------------- | ----------------------------------------------------------- |
| `echo`/`printf` of a `secrets.*` expression                             | The obvious leak.                                           |
| a `run: env` or `printenv` step                                         | Dumps everything the step can see.                          |
| `set -x`                                                                | Echoes the expanded command line of every command after it. |
| writing a secret to `$GITHUB_OUTPUT`, `$GITHUB_ENV` or the step summary | Those are readable artifacts.                               |

Secrets reach a step through `env:` on that step alone, or as an input to an
action that handles them — which is why registry sign-in uses
`docker/login-action` rather than piping a token to `docker login`.

Build logs are readable by anyone with read access to the repository.

---

## 8. Rollback

### 8.1 Application — fast, and always available

Re-run **Deploy — production** with the previous commit SHA. It promotes the
image already in the registry rather than rebuilding, so the rollback is the
exact artifact that was running before.

```
Actions → Deploy — production → Run workflow
  ref:     <previous SHA>
  confirm: deploy to production
```

The same approval applies. That is intentional: a rollback is a production
deployment, and the fastest way to make an incident worse is an unreviewed
change made under pressure.

`verify-release.sh` polls `/health` and then `/ready` afterwards. **A deploy
whose readiness never reaches 200 is not a success** — the process started but
cannot reach something it needs, and that is another rollback, not a wait.

### 8.2 Database — there is no rollback, and that is the design

**Migrations are forward-only. They are never undone.** There are no down
migrations, and `check-migrations.mjs` rejects any file that looks like one.

This is why the ordering rule in [DEPLOYMENT.md §4](DEPLOYMENT.md) matters: a
migration must be backward-compatible with the version currently running,
because for the minutes around a deploy both versions are live. Get that right
and an application rollback is safe on its own — the old version runs fine
against the new schema.

To undo a schema change, **write a new migration that moves forward to the state
you want.** Reversing is not available.

If a migration is genuinely unrecoverable — data lost, not merely a schema in an
unwanted shape — restoring from backup is the only option, and it means losing
everything written since. That is a decision with a data-loss window, not a
rollback:

1. Stop the deployment. Leave the application on whatever version is running.
2. Confirm the damage from `db:status` and the migration in question.
3. Restore — either provider point-in-time recovery to a timestamp before the
   migration, or the most recent dump via `infra/scripts/restore.sh`. The script
   verifies the dump before touching anything and refuses a production target
   without an explicit acknowledgement, because the realistic accident here is
   somebody restoring with the wrong URL in their shell at 3 a.m.
4. Confirm the RLS policy count came back. A restore missing them serves traffic
   with no tenant isolation and looks like a success — the script checks, and so
   should you.
5. Write a forward migration that reaches the intended state correctly.

> This procedure's one prerequisite used to not exist. The scripts and a weekly
> automated drill are now in place, **but the drill has never run** — see
> DEPLOYMENT.md §10.3 before relying on this.

### 8.3 Order

| Situation                              | Do                                                                                                          |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Bad code, schema fine                  | Redeploy the previous SHA. Nothing else.                                                                    |
| Bad migration, backward-compatible     | Redeploy the previous SHA; write a forward fix.                                                             |
| Bad migration, not backward-compatible | Roll **forward** with a fix. Rolling the app back would run the old version against a schema it cannot use. |
| Data destroyed                         | §8.2, restore from backup (`infra/scripts/restore.sh`; see DEPLOYMENT.md §10.3), accept the loss window.    |

The third row is the one that catches people. If the schema has already moved
past what the previous version can read, going backwards makes it worse.

---

## 9. Confirming the settings are actually on

Two of this document's guarantees live in repository settings, and a setting
nobody verified is a setting nobody has.

```bash
# Is `Required checks` actually required on main?
gh api repos/:owner/:repo/branches/main/protection/required_status_checks \
  --jq '.contexts'

# Does the production environment have reviewers?
gh api repos/:owner/:repo/environments/production \
  --jq '.protection_rules[] | select(.type=="required_reviewers")'
```

An empty result from either means the gate does not exist, whatever this
document or a workflow file says.

Then test it once, honestly: open a pull request that deliberately fails one
check, and confirm the merge button is blocked. A protection rule that has never
refused anything has not been observed working.

---

## 10. Verifying from a clean state

CI always starts from nothing: no `node_modules`, no `dist`, no
`*.tsbuildinfo`. Locally none of those are true, and the difference hides real
failures — the typecheck-before-lint ordering in §2 is exactly the kind of thing
that only breaks on a clean checkout.

So the pipeline was run against a pristine copy of the tree: source and git
history, with every build artifact and `node_modules` excluded.

| Step                          | Result |  Time |
| ----------------------------- | ------ | ----: |
| Scan for committed secrets    | pass   |   0 s |
| Install (`--frozen-lockfile`) | pass   |  17 s |
| Format                        | pass   |  11 s |
| Project references            | pass   |   2 s |
| Typecheck                     | pass   |  23 s |
| Lint                          | pass   |  58 s |
| Database types are current    | pass   |   6 s |
| Migration safeguards          | pass   |   1 s |
| Deployment configuration      | pass   |   2 s |
| Dependency audit              | pass   |   3 s |
| Build                         | pass   |  36 s |
| Unit tests                    | pass   |  13 s |
| Integration tests             | pass   | 328 s |

**13 of 13, from an empty tree.** It took four attempts, and the three failures
along the way are the reason this section exists.

### What the clean room found

**1. `tsc -b` could not resolve four workspace packages · would have failed
every PR**

`apps/api` imports `@kids/learning`, `@kids/practice`, `@kids/safety` and
`@kids/voice`, and referenced none of them in `tsconfig.json`. `tsc -b` takes
build order from `references`, so those four were never built before the API was
type-checked:

```
apps/api/src/routes/voice.ts(15,8): error TS2307:
  Cannot find module '@kids/voice' or its corresponding type declarations.
```

It passes on any machine that has built the repository before, because
`services/voice/dist` is already sitting there from last time. It fails on a
runner that starts from nothing — which is every CI run.

Fixed by adding the four references, and by adding
[`check-project-references.mjs`](infra/scripts/check-project-references.mjs) to
the pipeline so the next one is caught in a second rather than after a
three-minute install.

**2. A flaky test, ~1 run in 100 · would have eroded trust in the pipeline**

`voice.test.ts` asserts the response leaks no storage provider name by
serialising the whole body and searching for short substrings — including
`"s3"`. One of those fields is the audio key: 24 random bytes, base64url. It
failed on a key that happened to contain the letters:

```
"key":"8ekjchl14c9s3zwtap_1zzmr3lkutqkc"
                  ^^
```

Roughly a one-in-a-hundred chance per run: often enough to make the pipeline
untrustworthy, rare enough to be waved away as "just CI". The key is an opaque
handle that is _supposed_ to be in the response, so it is now excluded from that
scan while every other field stays under it.

Found by running the suite from clean twice, and only visible because the second
run disagreed with the first.

**3. Unformatted file** — trivial, and the sort of thing that is only trivial
because a machine caught it.

### One failure that was NOT the repository

The first attempt put the clean room under
`…/AppData/Local/Temp/claude/D--Web-Development-…/scratchpad/cleanroom` — a deep
path containing a space. Vitest workers died with `Worker exited unexpectedly`
and the suite took 952 s instead of ~310 s. Moving the clean room to `D:/…`
fixed it with no code change.

Recorded because the honest conclusion was "my test harness is in a bad
location", not "integration tests are broken" — and the two look identical in a
log.

### What this does and does not prove

**Proves:** the `Verify` and `Tests` jobs pass from nothing, in workflow order,
with a fresh dependency install and no cached build output.

**Does not prove:** the `Database`, `Images` and `Browser E2E` jobs. Those need
a PostgreSQL service, a Docker daemon, and Playwright browsers, none of which
exist on the machine this was written on. They are also the three jobs most
likely to need adjustment on their first real run —
[DEPLOYMENT.md §11](DEPLOYMENT.md) says the same about the images specifically.

---

## 11. Reference

| Command                      | What it checks                                    |
| ---------------------------- | ------------------------------------------------- |
| `pnpm run check`             | format, typecheck, lint, unit tests               |
| `pnpm run verify:no-secrets` | committed secrets, across git history             |
| `pnpm run verify:migrations` | the safeguards in §6                              |
| `pnpm run verify:deploy`     | compose/env contract, and workflow secret hygiene |
| `pnpm run verify:audit`      | dependency advisories, against a dated allowlist  |

The audit gate uses an explicit allowlist rather than a lowered threshold. Three
advisories in Expo's build tooling are accepted by id, each with a reason and a
review date; anything else at `high` or above fails, and an exception past its
review date fails too — an exception nobody has revisited is not a decision any
more. See [`check-audit.mjs`](infra/scripts/check-audit.mjs).
