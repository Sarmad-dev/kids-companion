# Test report

**Date:** 2026-08-21
**Commit:** working tree at the end of the testing phase
**Command:** `pnpm run coverage` (Vitest 4.1.10, all three projects)

---

## Read this before the numbers

A test suite reports on itself, which makes it the least trustworthy witness in
any codebase. Two things follow, and both shaped this document:

**Passing is not the same as covered, and covered is not the same as correct.**
1,420 passing tests say that 1,420 assertions held. They say nothing about the
assertions nobody wrote. Where this suite has holes, they are named in
§6 and §7 rather than left for someone to discover.

**Some of these tests found bugs, which is the only real evidence they work.**
Four defects were found by tests written during this phase — two of them
production-affecting. They are listed in §3. A test suite that has never caught
anything is a suite that has never been shown to work.

---

## 1. Totals

|                      | Files  | Tests     | Passed    | Failed | Skipped     |
| -------------------- | ------ | --------- | --------- | ------ | ----------- |
| **unit**             | 40     | 730       | 730       | 0      | 0           |
| **integration**      | 22     | 690       | 690       | 0      | 0           |
| **e2e** (Vitest)     | 1      | 5         | 0         | 0      | **5**       |
| **Total (run)**      | **63** | **1,425** | **1,420** | **0**  | **5**       |
| e2e-web (Playwright) | 1      | 7         | —         | —      | **not run** |

Wall clock: unit ≈ 9 s, integration ≈ 340 s.

**Nothing failed. Nothing was disabled, skipped, or weakened to make it pass.**
The 5 skips are environmental and explained in §6.

---

## 2. Coverage

Measured with `v8` across `packages/*`, `services/*`, and `apps/api`.
`apps/web` and `apps/mobile` are excluded by `vitest.config.ts` (they have their
own unit tests, but their components are exercised by Playwright, which did not
run here — see §6).

| Metric     | Result                  | Floor |      |
| ---------- | ----------------------- | ----- | ---- |
| Statements | **88.18 %** (3806/4316) | 70 %  | pass |
| Branches   | **74.15 %** (2158/2910) | 65 %  | pass |
| Functions  | **88.48 %** (784/886)   | 70 %  | pass |
| Lines      | **90.40 %** (3561/3939) | 70 %  | pass |

91 source files instrumented.

### 2.1 The higher per-module gates

`docs/TESTING_STANDARDS.md` §4 sets stricter gates on modules whose failure mode
is severe. **Three of six are met. Three are not**, and pretending otherwise
would defeat the purpose of having written them down.

| Module                         | Gate               | Lines                | Branches             | Functions          | Meets gate        |
| ------------------------------ | ------------------ | -------------------- | -------------------- | ------------------ | ----------------- |
| Log redaction                  | 100 %              | **100 %** (21/21)    | **100 %** (13/13)    | **100 %** (6/6)    | **yes**           |
| Retention & deletion           | 95 %               | **100 %** (13/13)    | **100 %** (6/6)      | **100 %** (2/2)    | **yes**           |
| RLS policies                   | 100 % of policies  | see §2.2             |                      |                    | **partly**        |
| Safety pipeline                | 95 %, all branches | 97.2 % (280/288)     | **81.5 %** (185/227) | 97.0 % (64/66)     | **no — branches** |
| Authentication & authorization | 95 %               | 95.8 % (137/143)     | **85.4 %** (70/82)   | **93.9 %** (31/33) | **no**            |
| Entitlement & quota            | 90 %               | 90.1 % (154/171)     | **81.8 %** (193/236) | **84.6 %** (22/26) | **no**            |
| Payment webhooks               | 90 %               | **85.2 %** (632/742) | **69.7 %** (396/568) | 89.7 % (122/136)   | **no**            |

The weakest files inside each failing group:

- **Safety** — `services/safety/src/detectors.ts` (71.4 % branches).
  `services/ai/src/engine.ts` is 100 % of lines but 73.8 % of branches.
- **Auth** — `apps/api/src/plugins/auth.ts` (90.6 % lines), `services/auth/src/passwords.ts` (80 % functions).
- **Entitlement** — `apps/api/src/subscription-reconciler.ts` (69.2 % functions).
- **Payment webhooks** — `services/payments/src/rails/types.ts` (0 % branches),
  `apps/api/src/store-billing.ts` (65 % branches), `apps/api/src/payment-store.ts` (67.9 % branches).

The uncovered branches are concentrated in provider-failure permutations of the
unverified live rails — code that **refuses to run at all** until a rail is
verified (`RailNotVerifiedError`). That makes them hard to reach and low-risk
today, but it is an explanation, not a pass. See §7.

### 2.2 RLS: what "100 % of policies" actually means here

Two different claims, and only one of them is fully true.

**Structural — complete.** `tests/integration/schema.test.ts` queries
`pg_catalog` for every table lacking both `ENABLE` and `FORCE ROW LEVEL
SECURITY` and fails if the list is non-empty. All **50** tables are covered by
construction, and a new table added without RLS fails the suite on the next run.
This is the assertion that cannot rot.

**Behavioural — partial.** `rls-tenant-isolation.test.ts` proves denial across
the tenant-critical surface: cross-parent reads and writes, planting a child
into another family, writing messages into another family's conversation,
soft-deleted children, immutable records (conversation history, safety flags,
consent, learning events), operational tables (`payment_events`, `audit_logs`)
being unreachable from an authenticated session, and the no-identity case.

**85 policies are declared; each is not individually driven by its own test.**
The gate as written is not met.

---

## 3. Defects found by these tests

The reason to believe any of this works.

### 3.1 Malformed request body returned HTTP 500 — _production-affecting_

**Found by:** `tests/integration/resilience.test.ts`
**Fixed in:** `packages/shared/src/errors.ts`, `apps/api/src/plugins/error-boundary.ts`

Fastify's content-type parser throws `FST_ERR_CTP_*` for a body that is not
valid JSON, is the wrong media type, is empty, or is too large. Those errors
carry a 4xx `statusCode` but no `validation` array, so they fell past the schema
branch and came out as `INTERNAL_ERROR` / 500.

Three consequences, in increasing order of seriousness:

1. The client is told the fault is ours when it is theirs.
2. It is logged at `error` — noise in exactly the place an operator looks during
   a real incident.
3. **It counted toward `http_errors_total`, which alerting watches.** The
   `error_rate` condition fires on a 5xx rate, so anyone posting broken JSON in
   a loop could drive the error rate past the threshold and page somebody. A
   client being told "no" had become a way to trigger an alert.

Fixed with a `clientFault` factory that preserves the 4xx status. This is the
same shape as the rate-limit bug fixed in an earlier phase; recognising one
plugin's throw and not the family was the original mistake.

### 3.2 N+1 query in `GET /v1/children` — _production-affecting_

**Found by:** `tests/integration/performance.test.ts`
**Fixed in:** `apps/api/src/routes/children.ts`

`rows.map(async row => present(row, await loadLanguages(tx, row.id)))` reads
well and issues one query per child. Six queries for one child, nine for four.
Invisible in development where every account has one profile; the standard shape
of an incident when a list grows. Replaced with a `loadLanguagesFor` batch loader
using `where child_id = any($1::uuid[])`.

### 3.3 `guardedTurn` — exported, documented, called by nothing

**Found by:** coverage analysis during this phase
**Tests added:** `services/safety/src/guarded-turn.test.ts` (6 tests)

A whole-turn safety wrapper exported from the safety package with **zero**
callers and zero tests. Not a live hole — the real conversation path in
`services/ai/src/engine.ts` runs `checkInput` and `checkOutput` itself and is
tested — but a second implementation of a safety-critical ordering that nobody
had ever executed. Anyone wiring it up later would reasonably assume a helper in
the safety package was covered.

Now tested (input checked before the model is called, output checked before
return, generation failure distinguishable from a safety stop). **It remains
unused** — see §7.

### 3.4 Alerting had never been observed to fire

**Found by:** coverage analysis during this phase
**Tests added:** `apps/api/src/alerts.test.ts` (18 tests)

The only assertion about alerting anywhere was that no alerts fire on a healthy
system — which passes just as happily against a monitor that _cannot_ fire.
`apps/api/src/alerts.ts` sat at 56 % of statements and 42 % of branches.

This is the worst failure mode available to a paging system: indistinguishable
from a working one right up to the incident, and it manufactures confidence in
the meantime. All five conditions are now driven until they fire and then until
they clear, including the properties that decide whether people keep trusting a
pager: no repeat delivery while firing, no firing on a small sample, a
consecutive-failure counter that resets on success, and a webhook failure that
does not become its own incident.

`alerts.ts` also had a fifth issue worth noting: `paymentSummary` in
`apps/api/src/payment-store.ts` is documented as "exported for the status
endpoint" — **no status endpoint calls it**. Now covered by a test; still unused.

---

## 4. Coverage by requested category

| #   | Category         | Where                                                                                           | Notes                                                           |
| --- | ---------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| 1   | Unit             | 40 files across `packages/`, `services/`, `apps/`                                               | 730 tests                                                       |
| 2   | Integration      | `tests/integration/` (22 files)                                                                 | Real app, real plugins, real SQL                                |
| 3   | API endpoints    | `api-baseline`, `conversation-api`, `children`, `consent`, `characters`, `practice`, `learning` | Contract + error shapes                                         |
| 4   | Database & RLS   | `schema`, `rls-tenant-isolation`                                                                | See §2.2                                                        |
| 5   | Authentication   | `auth`, `authorization`, `services/auth/*`                                                      | Sessions, tokens, roles, password hashing                       |
| 6   | AI service       | `services/ai/*`, `conversations`                                                                | Mock provider; timeouts and malformed responses in `resilience` |
| 7   | Safety           | `services/safety/*`, `safety`, `guarded-turn`, `adversarial`                                    | Adversarial corpus + fail-closed                                |
| 8   | Voice            | `services/voice/*`, `voice`                                                                     | Formats, pipeline, retention, signed URLs                       |
| 9   | Payment          | `payment-rails`, `services/payments/rails/*`, `mock-provider`                                   | Sandbox rails; refunds added this phase                         |
| 10  | Subscription     | `subscriptions`, `lifecycle`, `pricing-source`                                                  | Full lifecycle + webhook replay                                 |
| 11  | Mobile           | `apps/mobile/src/*`, `store-billing`, `stores/*`                                                | Receipt verification server-side; no store secrets in client    |
| 12  | Parent dashboard | `parent-dashboard`, `apps/web/src/lib/*`                                                        | Server logic; browser layer not run (§6)                        |
| 13  | End-to-end       | `tests/e2e/`, `tests/e2e-web/`                                                                  | **Both skipped** (§6)                                           |
| 14  | Security         | `security-audit` (49 tests), `redaction`, `no-client-secrets`                                   | 12 named attacks + positive controls                            |
| 15  | Performance      | `performance`, `resilience`                                                                     | Query counts, not stopwatches (§6)                              |

### 4.1 Failure scenarios specifically requested

All present, in `tests/integration/resilience.test.ts` unless noted:

| Scenario                     | Covered                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------- |
| Network failures             | yes                                                                             |
| Provider timeouts            | yes                                                                             |
| Malformed provider responses | yes — both invalid JSON and well-formed-but-wrong shapes                        |
| Database failures            | yes — fails loudly, leaks no database detail, recovers                          |
| Concurrent requests          | yes, with the caveat in §6                                                      |
| Duplicate webhooks           | yes — `subscriptions`, `payment-rails`, `store-billing`, and a concurrent burst |
| Unauthorized requests        | yes — `authorization`, `rls-tenant-isolation`, `security-audit`                 |

### 4.2 External services

**No test in any tier contacts a live vendor.** Every provider port defaults to
a mock in `local` and `ci`; AI, voice, payment rails, and both app stores have
mock implementations that can also _fail_ on demand. No real money moves and no
paid AI quota is consumed by the suite.

The store and rail mocks are deliberately **real verification services that can
say no** rather than stubs that always approve — a mock that always succeeds
cannot catch a client claiming an entitlement it does not have.

---

## 5. Gates

| Gate                                | Result                             |
| ----------------------------------- | ---------------------------------- |
| `tsc -b` (TypeScript 6.0.3, strict) | pass                               |
| `eslint .`                          | pass, 0 problems                   |
| `prettier --check .`                | pass                               |
| `pnpm run build`                    | pass (`apps/web` + `apps/api`)     |
| `db:types:check`                    | pass — 52 tables and views in sync |
| `verify:no-secrets`                 | pass — no secret patterns detected |
| Coverage thresholds                 | pass (global floor)                |

---

## 6. Known limitations

Stated plainly. Each of these is a real limit on what the numbers above mean.

1. **Concurrency is not truly concurrent.** Integration tests run on PGlite —
   Postgres compiled to WebAssembly on a **single connection**. Requests
   interleave at every `await`, but the database serialises them. The
   concurrency tests exercise application logic and the unique indexes that make
   those operations safe; **a lost update that only appears with two concurrent
   Postgres backends would pass here.**
2. **The e2e suite did not run.** 5 tests skipped: no `DATABASE_URL`, and Docker
   is not installed on this machine. Nothing in this report exercised a real
   server process over a real socket.
3. **The Playwright browser suite has never been run.** 7 specs in
   `tests/e2e-web/`, requiring downloaded browser binaries. The dashboard's
   rendering, navigation, and client-side behaviour are therefore **unverified
   by execution**.
4. **`apps/web` and `apps/mobile` are excluded from coverage.** Their unit tests
   run and pass, but no coverage figure in §2 describes them.
5. **Performance tests are not load tests.** They assert query counts and
   payload sizes, plus latency ceilings loose enough to catch only a pathology.
   They predict nothing about production latency under real concurrency.
6. **PGlite is not the production Postgres.** RLS semantics are exercised
   faithfully; server configuration, connection limits, pooling behaviour, and
   extensions are not.
7. **Rate limiting is per-instance and in-memory.** Tests verify one instance.
   Behind a load balancer with _N_ instances the effective limit is _N_ × the
   configured value.
8. **Message encryption uses a `placeholder` codec.** Tests verify the column and
   key-id plumbing, not encryption. Conversation content is protected by RLS and
   database access control, not by application-layer encryption at rest.
9. **Mocked providers are our model of a vendor, not the vendor.** Every rail and
   store adapter marked unverified refuses to run in a deployed environment
   precisely because no test here can prove what a real provider does.
10. **Coverage counts executed lines, not meaningful assertions.** A line can be
    covered by a test that asserts nothing about it.

---

## 7. Unresolved issues

Nothing here is failing. Each is a known gap carried forward.

| #    | Issue                                                                                                    | Impact                                                                                   | Suggested action                                                                          |
| ---- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| U-01 | **Three per-module coverage gates unmet** (safety branches 81.5 %, auth 85.4 %, payment webhooks 69.7 %) | Uncovered branches in safety-critical code                                               | Add branch tests for `detectors.ts`, `plugins/auth.ts`, and the rail failure permutations |
| U-02 | **RLS behavioural coverage is a subset** of the 85 declared policies                                     | A policy could be wrong without a test noticing; the structural guard would not catch it | Enumerate `pg_policies` and assert a behavioural test exists per policy                   |
| U-03 | **`guardedTurn` is dead code** duplicating the safety ordering                                           | A future caller might adopt an unused path                                               | Delete it, or adopt it in `engine.ts` and delete the duplication                          |
| U-04 | **`paymentSummary` is dead code**, and its comment names a consumer that does not exist                  | Misleading documentation                                                                 | Wire up the status endpoint, or remove                                                    |
| U-05 | **e2e and Playwright suites unexecuted**                                                                 | The full stack over a socket, and the entire browser layer, are unverified               | Run in CI with Docker and browser binaries                                                |
| U-06 | **No containerised CI against real Postgres**                                                            | See §6.1 and §6.6                                                                        | Add a Postgres service container                                                          |
| U-07 | **No automated dependency scanning in CI**                                                               | Advisories found only by hand                                                            | Add `pnpm audit` to the pipeline                                                          |
| U-08 | **3 dependency advisories** (2 high, 1 moderate) in `expo > @expo/cli`                                   | Developer build tooling only — zero paths from `apps/api`, not in any shipped artefact   | Re-check on each Expo bump (F-04 in `SECURITY_AUDIT.md`)                                  |
| U-09 | **Scheduled jobs are tested but not scheduled** — `sweepExpired`, `reconcile()`, `synchronise()`         | Correct logic, never invoked in a deployment                                             | Wire to a scheduler                                                                       |
| U-10 | **Auth spine tables deferred** (`devices`, refresh-token rotation records)                               | Carried from an earlier phase                                                            | Design exists; not built                                                                  |

---

## 8. What this report does not claim

- **Not that the application is correct.** It says 1,420 assertions held on this
  machine, on this commit, against mocked providers and an in-process database.
- **Not that it is secure.** `docs/SECURITY_AUDIT.md` covers that separately and
  is equally explicit about its limits — no penetration test, no external review.
- **Not that it is ready for production.** §6 and §7 list what has never been
  executed. Items U-05 and U-06 in particular should be closed before launch.
- **Not that coverage percentages are a quality measure.** They are a floor for
  finding untested code. The four defects in §3 were found by tests that assert
  behaviour, and two of them were found in code that coverage already counted.

---

## 9. Reproducing this

Everything in this report:

```bash
pnpm install && pnpm run build && pnpm run coverage
```

`pnpm test` runs the unit and integration projects as two separate commands and
produces no combined coverage report. `pnpm run coverage` runs all three
projects in one pass, which is where the figures in §2 come from.

The per-module gates in §2.1 are computed from `coverage/lcov.info`, not from the
terminal table. The `text` reporter omits fully-covered files and truncates long
paths, so it cannot be used to check a gate on a named module —
`packages/shared/src/redaction.ts` is missing from that table precisely because
it is at 100 %. The browsable report is at `coverage/lcov-report/index.html`.

The two suites that did not run here:

```bash
pnpm docker:up && pnpm db:migrate && pnpm run test:e2e
```

```bash
npx playwright install && pnpm run test:e2e:web
```
