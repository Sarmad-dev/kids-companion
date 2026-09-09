# Production readiness review

**Date:** 2026-08-23
**Scope:** the seventeen categories requested, each verified against the code
rather than recalled.
**Method:** every verdict below cites what was inspected. Where a claim was
surprising it was checked twice — two findings in §4 were corrected mid-review
because the first reading was wrong.

---

## Verdict

# NOT READY FOR PRODUCTION

**9 PASS · 6 PARTIAL · 2 FAIL** — of seventeen categories.

This is not a close call, and the reason is not the count. One finding is a
child-safety gap rather than an infrastructure one:

> **~~A child disclosing harm currently reaches no human.~~ RESOLVED**
> `SAFETY_ESCALATION_WEBHOOK_URL` is now read: an escalation is written to a
> durable delivery ledger and routed to the configured endpoint, retried by
> the worker until it lands. **Who that endpoint belongs to remains Q-07 and
> still blocks launch** — the mechanism exists, the protocol does not. See F-01.

Nothing here should be read as "close, pending sign-off", and the shift from
FAIL to PARTIAL across several rows is the point rather than the progress: those
categories now have tested mechanisms and **no evidence they work against real
infrastructure**. Storage has never reached a bucket, the limiter has never
counted against a real Redis, and the backup drill has never run. Standing up
staging once is what converts most of this column; writing more code does not.

Verdicts marked RESOLVED were fixed after this review. The original finding is
kept verbatim in each case, because what a readiness review said before the fix
is the part worth being able to read again.

---

## The table

| #   | Category                  | Status      | One-line reason                                                                                      |
| --- | ------------------------- | ----------- | ---------------------------------------------------------------------------------------------------- |
| 1   | Environment configuration | **PASS**    | 158 keys, Zod-validated, fails to boot rather than run misconfigured                                 |
| 2   | Secrets                   | **PASS**    | Nothing in any image or layer; scanned in CI, history included                                       |
| 3   | Database                  | **PASS**    | Forward-only migrations, checksum ledger, pool + timeout + TLS enforced                              |
| 4   | RLS                       | **PARTIAL** | All 50 tables `ENABLE`+`FORCE`, proven from the catalogue; 85 policies not each behaviourally tested |
| 5   | Backups                   | **PARTIAL** | Scripts, schedule and an automated restore drill exist; none has ever run (F-02)                     |
| 6   | Monitoring                | **PASS**    | Alerts reach a configured destination; production refuses to boot without one (F-07 resolved)        |
| 7   | Logging                   | **PASS**    | Redaction at 100 % coverage, request ids, no internals in responses                                  |
| 8   | Rate limits               | **PASS**    | Counted in Redis; falls back to per-instance rather than open or closed (F-03)                       |
| 9   | AI limits                 | **PARTIAL** | Per-child and per-plan enforced; the account-wide cost ceiling is not implemented                    |
| 10  | Payment webhooks          | **PARTIAL** | Mechanism is sound and tested; no rail is verified, so payments cannot run                           |
| 11  | Mobile configuration      | **FAIL**    | Placeholder bundle ids, version 0.0.0, no build profile, never submitted                             |
| 12  | Storage                   | **PARTIAL** | S3 adapter implemented and tested; never run against a real bucket (F-04)                            |
| 13  | Domain configuration      | **FAIL**    | No domain. Every hostname in the templates is an example                                             |
| 14  | SSL                       | **PARTIAL** | Enforced everywhere in config; no certificate or terminator exists to enforce it on                  |
| 15  | CORS                      | **PASS**    | Explicit origins, wildcard refused at boot in any deployed environment                               |
| 16  | Error tracking            | **PASS**    | Captured at the boundary, fingerprinted, release-correlated; production refuses `none` (F-06)        |
| 17  | Rollback strategy         | **PASS**    | Documented, correct about the forward-only database; never rehearsed                                 |

---

## The finding that cuts across seven categories

**Nine configuration keys are declared, validated, documented — and never read
by any code.** Several are the _only_ mechanism their category has.

| Key                                 | Category it belongs to | Consequence                                           |
| ----------------------------------- | ---------------------- | ----------------------------------------------------- |
| ~~`SAFETY_ESCALATION_WEBHOOK_URL`~~ | child safety           | **RESOLVED** — read, routed, retried (F-01)           |
| `AI_DAILY_COST_CEILING_USD`         | AI limits              | No account-wide spend ceiling                         |
| ~~`SENTRY_DSN`~~                    | error tracking         | **RESOLVED** — read, with no SDK attached (F-06)      |
| ~~`STORAGE_PROVIDER`~~              | storage                | **RESOLVED** — read; `memory` refused in production   |
| `OTEL_EXPORTER_OTLP_ENDPOINT`       | monitoring             | No tracing                                            |
| `ENCRYPTION_ACTIVE_KEY_ID`          | database               | Key id is hard-coded `'placeholder'`                  |
| ~~`RETENTION_TRANSCRIPT_DAYS`~~     | privacy                | **RESOLVED** — a ceiling the sweep enforces (F-05)    |
| `SAFETY_REVIEW_QUEUE_ENABLED`       | child safety           | No review queue                                       |
| `REDIS_URL`                         | rate limits            | Readiness probe only; the limiter never touches Redis |

This is why a configuration review alone would have passed this application.
Every one of these has a sensible default, a validation rule, and a paragraph in
`docs/ENVIRONMENT.md`. Four are _required_ in production by the schema. Setting
them changes nothing.

**Recommendation:** the schema should not require a variable nothing consumes.
Either implement the consumer or drop the requirement — a required setting with
no effect actively misleads whoever configures the environment.

---

## Findings

### F-01 · Safety escalations reach no human · **RESOLVED**

> **Fixed after this review.** Escalations are now recorded in
> `safety_escalations` and routed to `SAFETY_ESCALATION_WEBHOOK_URL`, with a
> worker sweep retrying anything undelivered and a failed delivery raising the
> safety alert. The payload carries no conversation content. **Q-07 — who is
> notified, and what duty attaches — is untouched and still blocks launch.**
>
> The original finding is kept below as written.

#### As originally found

**Category:** monitoring, child safety.

An escalation — the disclosure-of-harm path — does exactly two things
(`apps/api/src/routes/conversations.ts:1007`):

1. writes an audit row, `safety.escalation.raised`, with `requiresHumanReview: true`
2. logs one line at `warn`

There is no webhook call, no notification, no queue, no page. The code says so
itself:

> `// An escalation is not merely a block. It routes to the human protocol in`
> `// docs/CHILD_SAFETY.md §6 — which is unresolved (Q-07), so for now it is`
> `// recorded at the highest fidelity available and flagged loudly.`

So it is known and documented, and the code is honest. What makes it a finding
rather than a tracked gap is the configuration around it: the schema **requires**
`SAFETY_ESCALATION_WEBHOOK_URL` in production, with the message _"disclosures
must reach a human"_. Production refuses to boot without it. Nothing reads it.

Anyone setting that variable would reasonably conclude disclosures are routed.
They are not — detection works, delivery does not.

**Remediation:** implement delivery, or resolve Q-07 and say plainly in the
schema that escalation is audit-only. Do not ship a children's product where a
disclosure depends on someone reading logs.

### F-02 · No backups · ~~**CRITICAL**~~ **MECHANISM BUILT · NOT YET RUN**

**Category:** backups. No backup script, no schedule, no retention policy, no
restore procedure, and no restore ever performed. `DEPLOYMENT.md` §10 assumes
managed Postgres with automated backups and point-in-time recovery; nothing
selects, configures, or verifies that.

This interacts badly with the forward-only migration design. `CI_CD.md` §8.2 is
explicit that an unrecoverable migration leaves restore-from-backup as the only
option — a documented procedure whose one prerequisite does not exist.

**An untested backup is not a backup.** Configure it, then restore from it into
a scratch database and confirm the data is there.

#### Resolution

Four pieces, and the last one is the point:

- `infra/scripts/backup.sh` — dumps, **verifies, then encrypts**. It refuses to
  run without `BACKUP_ENCRYPT_CMD`, because a dump of this database is every
  child's conversations and the alternative is a nightly job quietly writing them
  in the clear. The plaintext is deleted on every exit path.
- `infra/scripts/verify-backup.mjs` — decides whether a dump is worth keeping,
  and runs BEFORE encryption, because once encrypted a truncated file cannot be
  told from a good one.
- `infra/scripts/restore.sh` — a data-destruction tool pointed the other way, so
  it verifies the dump before touching the target, names the target without its
  password, and refuses anything that looks like production without an explicit
  acknowledgement.
- `.github/workflows/backup-drill.yml` — **dumps and restores real Postgres every
  week**, then compares table, policy and row counts against the source.

#### The failure this is built around

A restore that comes back without the RLS policies. Every table is `ENABLE` plus
`FORCE` and 85 policies are what separate one family's conversations from
another's; a dump missing them restores into a database that starts, serves
traffic, and has no tenant isolation. It looks exactly like a successful
recovery.

The policies are therefore counted in the file before it is kept, counted in the
target after the restore, and compared to the source by the drill. `ENABLE`
without `FORCE` is checked separately, since without `FORCE` the application's
own role bypasses every policy.

#### Still NOT VERIFIED, and why the verdict stays short of PASS

**None of this has ever run.** There is no Postgres on the machine it was written
on and no production database to back up. The verification logic is unit-tested
against synthetic dumps — including a truncated one, one with no policies, and
one where `FORCE` is missing — but the scripts themselves have not executed.

The drill is a real mechanism rather than a written procedure, which is the
difference between this and the original finding. It is still not a restore that
has happened. One `workflow_dispatch` run closes that, and until then the honest
status is a category that has a tested design and no evidence.

### F-03 · Rate limits are per-instance · ~~**HIGH**~~ **RESOLVED**

**Category:** rate limits. `@fastify/rate-limit` runs in-process. Behind _N_
instances the effective limit is _N_ × the configured value — including
`RATE_LIMIT_AUTH_PER_15_MIN=10`, which is what makes online password guessing
impractical. Three instances give an attacker 30 attempts per IP per window.

Redis is provisioned in staging and probed by `/ready`, but the limiter never
touches it. Also worth deciding deliberately: the subscription webhook route
hard-codes 600/minute where every other limit is configuration.

**Until this is fixed the API is single-instance.** F-04 no longer requires it
— audio is now shared — so distributed rate limiting is the remaining blocker on
running more than one instance.

#### Resolution

A `@fastify/rate-limit` store backed by Redis, so N instances enforce ONE limit.
Redis was already provisioned and already probed by `/ready`; the limiter simply
never touched it. `probeRedis`'s own comment said this should be replaced "when
the limiter moves to Redis, because by then a real client will exist" — it now
does.

The counter is `INCR` then `PTTL`, setting the expiry only when there is none.
The obvious version — INCR, then PEXPIRE when the result is 1 — leaves the key
immortal if the process dies between the two, and a parent locked out
permanently by a crash is not an acceptable way to fail. Reading the TTL back
self-heals on the next request, and works on any Redis version rather than
needing 7's `PEXPIRE ... NX`.

**What happens when Redis is down** is the decision that mattered. Fail open
removes the auth limiter at exactly the moment an attacker might be why Redis is
struggling; fail closed turns a cache outage into a total outage for a product a
child is mid-conversation with. So neither: it falls back to counting in the
process, which is what the product did before. **An outage costs the improvement,
never the protection** — and that containment is also what makes a hand-written
Redis client an acceptable risk, since the worst case of a bug in it is the
status quo, logged at `error` with `control: rate_limit_store`.

Not a sixth alert condition, deliberately: the list answers "would somebody have
to get out of bed for this?", and the answer here is no — the limits still work,
they are just per-instance again.

**Keys are hashed.** The limiter keys on an IP or a parent id, and storing those
raw would make Redis a new home for personal data — a record of who was where —
in a system nobody counted as holding any. A hash counts identically. Asserted by
a test.

**The hard-coded limit is gone.** The review noted the webhook routes hard-coded
600/minute where every other limit is configuration; it is now
`RATE_LIMIT_WEBHOOK_PER_MINUTE`, so it can be lowered during an incident without
a release.

**Verification.** `apps/api/src/rate-limit-store.test.ts` drives two independent
stores against a real TCP server speaking RESP and asserts the fifth request
sees 5 rather than 3-and-2. `tests/integration/rate-limiting.test.ts` boots the
real app, makes real login attempts, and looks in Redis to confirm the counting
happened there — because a correct store the application never asks is the defect
that has been found five times in this codebase. Plus 13 tests on the RESP
parser, focused on replies split across packets, which is how a limiter starts
attributing counts to the wrong caller.

### F-04 · Object storage does not exist · ~~**HIGH**~~ **RESOLVED (code) · NOT VERIFIED (against a real bucket)**

**Category:** storage. `createMemoryAudioStorage` is the only `AudioStorage`
implementation; `STORAGE_PROVIDER` is never read. Three consequences:

- Audio does not survive a restart.
- A signed audio URL issued by one instance 404s on another.
- **The audio retention backstop cannot run.** The bytes live in whichever
  process wrote them, so a sweep from the worker would mark ledger rows deleted
  while the objects survived in the API's heap — a retention record asserting a
  deletion that did not happen. The worker refuses to schedule it and logs why
  on every boot.

#### Resolution

`createS3AudioStorage` — any S3-compatible endpoint: AWS, Cloudflare R2, MinIO,
or Supabase Storage through its S3-compatible endpoint. `STORAGE_PROVIDER` is
read at last, and production refuses `memory`.

**The third consequence is the one that mattered, and it is now closed.** The
worker schedules `privacy.expireAudio` exactly when the store is shared, decided
by `audioStorage.name !== 'memory'` rather than by a constant. With a shared
store the DELETE is the deletion, so the ledger and the bytes agree. Local and CI
keep the in-memory store and keep the boot-time refusal, which is still the
honest thing to say there.

**No SDK.** Same reasoning as the Redis probe and the error tracker:
`@aws-sdk/client-s3` pulls a large dependency tree, retries and instruments on
its own schedule, and would put a third party between this service and a bucket
of children's voice recordings. SigV4 is written out — it is fully specified,
deterministic, and unforgiving in the useful direction: a signature wrong by one
byte 403s immediately and every time, so it cannot half-work.

**The client still never talks to storage.** The adapter exposes no URL-minting
method at all, and a test asserts the surface stays exactly `put`, `get`,
`delete`, `sweep`, `name`. The absence is the control — you cannot leak what
there is no function to produce. A credential scoped to a bucket of children's
voices, shipped in a mobile app, is a credential in a decompiled APK, and no
rotation un-leaks a child's voice.

Three decisions worth stating:

1. **Expiry is enforced on read, not left to the sweep.** A bucket lifecycle
   rule runs when the provider feels like it; the sweep runs on a timer. Neither
   is a guarantee at the moment somebody asks for a recording.
2. **The sweep lists everything before deleting anything.** Deleting while
   paginating means the listing changes under the cursor. AWS survives it
   because its continuation token encodes the last key, but that is one
   provider's property — an offset-based implementation would silently SKIP
   objects, and a retention sweep that quietly misses a child's audio looks
   exactly like a working one. Caught by a test.
3. **A failure is never reported as an absence.** `get` returning undefined
   means absent or expired. Returning it for a 500 would tell a caller a child's
   audio no longer exists when the truth is that the store was unreachable.

#### What is NOT verified

**No bucket has ever been configured, and no request has ever reached a real S3
endpoint.** The unit tests drive the adapter against a local HTTP server that
behaves as S3 does on the four operations used, and deliberately do not verify
the signature — that would be checking the implementation against itself.

So the signing is **implemented and structurally tested, not proven conformant**.
The first real deployment either works or 403s on the first voice turn; there is
no middle state, but the first run against a real endpoint is a genuine
verification step that has not happened. This stays NOT VERIFIED until it does.

One bug found by `tsc` and missed by the tests, worth recording because it shows
what the local server cannot catch: the adapter's audio-kind guard was
hand-written with three values, none of which were the real two
(`child_upload`, `companion_reply`). Every read would have reported a child's
audio as absent, and every sweep would have deleted unexpired recordings as
undatable. The runtime tests used the same wrong value and passed. The guard is
now derived from the type, so changing it is a compile error.

### F-05 · Transcripts are never deleted · ~~**HIGH**~~ **RESOLVED**

**Category:** database, privacy. `RETENTION_TRANSCRIPT_DAYS` exists (30 in the
staging template) and `parental_controls.transcript_retention_days` is a
per-child setting a parent can change. Nothing deletes a message by age —
there is no purge job, no SQL function, and no scheduled sweep.

Audio retention _is_ implemented (`app.expire_audio_artifacts`, wired through
`sweepExpiredAudio`), though it cannot be scheduled while F-04 stands.

A retention control a parent can set, that does nothing, is worse than not
offering it.

#### Resolution

`app.expire_transcripts`, swept hourly by the worker as
`privacy.expireTranscripts`. The ciphertext is **overwritten in place** — not
flagged, not soft-deleted — and the row survives.

**Why the row survives, which was the real design question.**
`content_flags.message_id` is `ON DELETE CASCADE`. Deleting message rows would
take the safety flags with them, so a parent shortening retention to seven days
would silently erase the record that anything was ever flagged about their
child. A retention setting must not be a way to wipe safety history. The flag
carries categories, severity and a decision and no content, so it is both safe
to keep and worth keeping. `messages.status` already had a `redacted` value
waiting, and `child_id` was already denormalised onto the row with a comment
saying it existed "so the retention sweep can delete by child without a join at
all" — this is the sweep that comment was written for.

**The shorter of the two always wins.** `RETENTION_TRANSCRIPT_DAYS` is a
ceiling, never a floor. A parent asking for seven days gets seven even where the
operator policy is ninety; a parent asking for 365 is capped at the operator's
number. Both directions are tested. The parent is also now shown the retention
that APPLIES rather than the one they requested — being quietly overruled is its
own kind of dishonesty.

**Retention of zero works, and does not cut a child off mid-sentence.** Zero is
permitted by the column's CHECK and is the strongest setting a parent can pick,
so it has to function or the most privacy-minded parent in the product is the
one being misled. A message is only redacted once its conversation is over —
ended, or started more than a day ago and still marked active, because a
five-year-old does not end conversations and an abandoned session must not
become a transcript kept for ever.

**The deletion is provable.** One audit row per child per sweep
(`privacy.transcript.redacted`) carrying a count and nothing else — an answer to
"you said you delete after thirty days, did you?" that does not itself hold
anything needing deletion.

#### What this deliberately does not decide

Whether a conversation carrying a **safety escalation** should outlive the
parent's retention setting.

The argument runs both ways and neither side is an engineering call. Deleting
means a safeguarding case can lose the words it was about. Holding means the
most sensitive data in the system is kept against the wishes of the family it
belongs to — and when the disclosure concerns a parent, that parent is the one
who sets the retention. That is the same question as Q-07 and belongs to the
same child-protection and legal review.

What is guaranteed meanwhile is that deletion never destroys the RECORD:
`content_flags` and `safety_escalations` are both content-free and both survive
untouched. The fact that something happened outlives the words.

**Verification.** `tests/integration/transcript-retention.test.ts` — 15 tests
that read the ciphertext back out of the column rather than trusting a return
value, including that flags survive, that progress numbers survive, that a live
conversation is untouched, that an abandoned one is not, and that a parent
session cannot reach the redaction path (`authenticated` holds no UPDATE grant
on `messages`).

### F-06 · No error tracking · ~~**MEDIUM**~~ **RESOLVED**

**Category:** error tracking. `SENTRY_DSN` is declared and optional; no client
is installed in any package and no code reads it. Errors reach structured logs
with request ids — real, and not the same thing. There is no aggregation, no
deduplication, no release correlation, and no alert on a new error type.

#### Resolution

`apps/api/src/error-tracking.ts`, captured at the single error boundary.
`ERROR_TRACKING_PROVIDER` must name a real destination in production, and a
provider named without one is refused at boot in every environment.

Three of the four gaps are closed directly. **Aggregation and deduplication:**
errors are fingerprinted as `type | scrubbed message | innermost own frame`, so
"row 41" and "row 87" are one bug while the same message from two places stays
two. **Release correlation:** `SERVICE_VERSION` and `APP_ENV` on every event.
Only 5xx is captured — a 400 is a caller's mistake, and anyone able to post a
malformed body could otherwise fill the tracker on demand.

**The fourth is a deliberate refusal.** There is no alert on a new error type.
The alert list answers one question — would a person have to get out of bed for
this? — and a first sighting does not; the first deploy after a release would
page a dozen times, and a channel that cries wolf on release day is muted before
the failure that mattered arrives. Instead a new type gets a distinct `warn`
line and a `newSinceBoot` count on the operator console, and volume is already
covered by `error_rate`, which does page.

#### The decision that mattered more than any of that

**There is no Sentry SDK in this repository, and adding one would be a privacy
regression.**

An error tracker's default integrations capture request bodies, headers,
cookies and query strings. The request body on the busiest route in this
application is a **child speaking**. Getting that wrong does not produce a bug
report; it produces a transcript of a five-year-old in somebody else's database,
and no later configuration change takes it back out.

So the Sentry envelope is written by hand, the way `probeRedis` speaks RESP
without a Redis client. Every field is placed deliberately, which is what makes
the privacy property testable rather than aspirational — with an SDK no test
here would ever see a body being attached.

| Sent                              | Never sent                                   |
| --------------------------------- | -------------------------------------------- |
| error type, scrubbed message      | request body, query string, headers, cookies |
| our own frames, basenames only    | the child's utterance or the model's reply   |
| route **pattern**, method, status | any child, parent, or conversation id        |
| release, environment, counts      | any name                                     |

Messages are scrubbed before they leave: quoted strings, emails, uuids, long
tokens and numbers removed, then capped. Our own `AppError` messages are fixed
strings and safe by construction; the danger is the errors we did not write — a
driver quoting the row it choked on, a provider returning the prompt inside its
complaint.

**Verification.** `tests/integration/error-tracking.test.ts` fails the database
mid-turn with an error carrying the child's sentence inside it, and asserts the
delivered event contains no word of it, no id, and no credential. Plus 22 unit
tests on scrubbing, frames, grouping, volume control and the envelope.

A first draft used a failing AI provider and captured nothing — the engine
catches provider failures and returns a degraded reply, which is the product
working correctly. The database path is the one that genuinely reaches the
boundary.

### F-07 · Alerts have nowhere to go · ~~**HIGH**~~ **RESOLVED**

**Category:** monitoring. Five alert conditions exist, are correct, and are
tested to fire and clear (18 tests). The default sink writes a `fatal` log line
— deliberately, so alerting does not depend on an outbound call succeeding
during a network incident. A webhook sink exists and wraps it.

**No webhook is configured, in any environment.** So today every alert,
including `safety_pipeline`, is a log line that something else would have to
notice. Nothing does.

`OTEL_EXPORTER_OTLP_ENDPOINT` is likewise declared and unread: no tracing.

#### Resolution

`ALERT_WEBHOOK_URL` now exists, is wired, and **production refuses to boot
without it** — the same treatment `SAFETY_ESCALATION_WEBHOOK_URL` gets, for the
same reason. `generic` posts a JSON body for an Alertmanager-style receiver;
`slack` posts the incoming-webhook shape, so a person can be reading alerts on
their phone without anybody building a receiver first. Three attempts, then the
log line stands alone.

**The finding understated the problem.** Wiring the destination revealed that
three of the five conditions had no producer at all: `reportAiFailure`,
`reportAiSuccess` and `reportDatabaseFailure` were called by nothing, and
`reportSafetyFailure` had exactly one caller — the escalation delivery failure
path — so the alert named after the safety pipeline could not fire when the
safety pipeline failed. `evaluate()` ran only when something scraped
`/metrics`, so the error-rate and latency thresholds were never checked on their
own. A destination with nothing to send is not alerting.

| Now reported by                                                   | Condition                        |
| ----------------------------------------------------------------- | -------------------------------- |
| every conversation and voice turn (`apps/api/src/turn-health.ts`) | `safety_pipeline`, `ai_provider` |
| the readiness probe, already running against the real pool        | `database`                       |
| a boot-time timer, `ALERT_EVALUATION_INTERVAL_MS`                 | `error_rate`, `latency`          |

Two further defects fixed in passing, both of which made alerting quietly stop
working rather than fail visibly:

1. **`safety_pipeline` and `database` could fire only once per process.** They
   are only ever told about failures, so nothing could clear them — and an
   already-firing condition is deliberately not re-delivered. Together that
   meant the most important alert in the system went permanently silent after
   its first firing. Both now have a positive signal, plus a 15-minute re-arm
   for the case where the failure simply stops recurring.
2. **A cleared condition told nobody.** Somebody woken at 2 a.m. had no way to
   learn it had recovered. Resolutions are now delivered.

**Verification.** `tests/integration/alerting.test.ts` runs a real HTTP server,
points the API at it, breaks the safety classifier through the real conversation
route, and asserts a real request arrives carrying no conversation content —
plus 12 unit tests on the transport, the bodies, and re-arming. The URL is
treated as a credential throughout: never logged, never in an error, never in a
body, and asserted so.

### F-08 · Mobile is not release-configured · **MEDIUM**

**Category:** mobile configuration.

| Item                      | State                                                      |
| ------------------------- | ---------------------------------------------------------- |
| Bundle id / package       | `app.kidscompanion.placeholder` — explicitly a placeholder |
| Version                   | `0.0.0`                                                    |
| `eas.json`                | absent — no build profiles                                 |
| Store submission          | never attempted, correctly                                 |
| Microphone usage string   | present, and honest about what happens to recordings       |
| `RECORD_AUDIO` permission | present                                                    |
| Store secrets in the app  | **none** — verified by a dedicated test                    |

The safety-relevant parts are right. The release-relevant parts do not exist.
Kids-category review on both stores carries additional requirements not yet
addressed.

### F-09 · No domain, and therefore no real TLS · **MEDIUM**

**Categories:** domain configuration, SSL. Every hostname in the templates is an
example (`api-staging.kidscompanion.app`). No domain is registered, no DNS, no
certificate, no terminator, no CDN.

The _configuration_ is right, and enforced: `DATABASE_SSL_MODE=require` and
`REDIS_TLS_ENABLED=true` are refused otherwise in production, HSTS is set with a
two-year max-age and `preload` on both the API (helmet) and the dashboard, and a
wildcard CORS origin fails at boot. None of it has been exercised against a real
certificate.

---

## What passes, and why

### 1 · Environment configuration — PASS

158 keys in one Zod schema with cross-field rules. Configuration is validated
**before anything starts**, so a broken environment fails the deploy rather than
the first child's request — verified directly: booting without `DATABASE_URL`
exits 78 with a named error rather than starting and failing later.

Production-only rules are enforced and tested: no `mock` payment provider, TLS
required, no CORS wildcard, `LOG_LEVEL` not `trace`, both safety classifiers
non-disableable, distinct Redis key prefix, and raw-audio retention requiring an
explicit acknowledgement flag.

Three templates (`.env.example`, `.env.staging.example`, `.env.production.example`)
and `pnpm verify:deploy` fails if a deployment-critical key is missing from any
of them.

_Caveat:_ the schema requires four keys nothing reads. See the cross-cutting
finding.

### 2 · Secrets — PASS

- `verify:no-secrets` scans the repository **including git history**; runs first
  in CI.
- `.gitignore` excludes every `.env*` except templates; templates carry no values.
- **No secret in any image layer**: `.dockerignore` excludes `.env*`, and no
  Docker **build arg** is used anywhere — a build arg is readable in image
  history forever, so it publishes rather than hides.
- The web image needs no build args at all, because the dashboard reads no
  `NEXT_PUBLIC_*` values.
- `verify:deploy` fails the build if a workflow echoes a secret, dumps the
  environment, enables `set -x`, writes a secret to a step summary, or uses
  `pull_request_target`. Negative-tested.
- The pull-request workflow uses **no** secrets at all.

### 3 · Database — PASS

Forward-only migrations, immutable once merged, tracked in `schema_migrations`
with a **checksum** that refuses to apply an edited migration. CI adds
immutability, back-dating, and destructive-statement review before merge, and
applies all 28 migrations to a real PostgreSQL 17 then re-checks idempotency.

Pool bounded (`DATABASE_POOL_MAX`), statement timeout set, TLS required in every
deployed environment, migrations run as a job that completes before the
application starts.

_Not covered here:_ backups (F-02), transcript retention (F-05), and message
encryption, which uses a codec named `placeholder` — deliberately named so a
row encoded that way is obvious rather than plausible. Conversation content is
protected by RLS and database access control, not by application-layer
encryption at rest.

### 4 · RLS — PARTIAL

**Structural: complete and self-maintaining.** All **50** tables have both
`ENABLE` and `FORCE ROW LEVEL SECURITY`, verified not by inspection but by a
test that queries `pg_catalog` for any table missing either and fails if the
list is non-empty. A new table added without RLS fails CI on the next run. This
is the assertion that cannot rot.

**Behavioural: a subset.** **85** policies are declared. `rls-tenant-isolation.test.ts`
proves denial across the tenant-critical surface — cross-parent reads and
writes, planting a child into another family, writing into another family's
conversation, soft-deleted children, immutable records, operational tables
unreachable from an authenticated session, and the no-identity case. Each of the
85 is not individually driven.

_Two corrections made during this review:_ I first recorded transcript retention
as implemented because `RETENTION_RAW_AUDIO_DAYS` is wired — a different key.
And I first read two dashboard queries as duplicates; they read different
tables. Both were checked again before being written down.

### 7 · Logging — PASS

Pino with `redact` configured from a shared `REDACTED_PATHS` list, so redaction
is a property of the logger instance rather than of each call site. The
redaction module is at **100 % of lines and branches** — one of two modules
meeting its spec gate.

Every request carries a request id, returned on every response and present in
every error. The error boundary never returns database internals, driver
messages, or provider errors; readiness reports `unavailable` without saying
why, because it is reachable without credentials.

`LOG_LEVEL=trace` is refused in production.

### 15 · CORS — PASS

Explicit origin list, `credentials: true`, methods limited, 24-hour preflight
cache. A wildcard in any deployed environment fails at boot, and that rule is
tested. The dashboard additionally sets `X-Frame-Options: DENY`,
`X-Content-Type-Options: nosniff`, a referrer policy, and a permissions policy
denying camera, microphone, and geolocation.

### 17 · Rollback strategy — PASS (documented), never rehearsed

`CI_CD.md` §8 covers it, and is correct about the part people get wrong:

- **Application:** re-run the production workflow with the previous SHA. It
  promotes the image already in the registry rather than rebuilding, so the
  rollback is the exact artifact that was running before. Approval still
  applies — a rollback is a production deployment, and the fastest way to worsen
  an incident is an unreviewed change made under pressure.
- **Database:** there is no rollback. Migrations are forward-only and
  `check-migrations.mjs` rejects any file that looks like a down migration. This
  is why every migration must be backward-compatible with the running version.
- **The case people get wrong:** if the schema has moved past what the previous
  version can read, rolling the application back makes it worse. Roll forward.

Never exercised. Its backup fallback now exists but has never been run (F-02).

---

## Payment webhooks — PARTIAL, and correctly so

The **mechanism** is sound and covered by 44 tests: HMAC signature verification
before anything else, idempotency on `(rail, external_event_id)` inserted first
in the transaction, replay-safety through both a signed timestamp and vendor
`last_event_at` ordering, and one transaction covering the event, the
subscription, the ledger and the checkout. A defect found this session — a
non-UUID reference producing a 500, which tells the rail to retry forever — is
fixed and has a regression test.

**But no payment can be taken.** `PAYMENTS_ENABLED_RAILS` and
`PAYMENTS_VERIFIED_RAILS` are both empty, and a deployed environment refuses to
boot with a rail enabled that is not also listed as verified. No rail has been
verified against its real API documentation and sandbox, so production would run
with zero rails — every family on the free tier.

That is the design working as intended rather than a defect. It is recorded as
PARTIAL because the category cannot be said to pass when the capability cannot
run.

## AI limits — PARTIAL

**Enforced and tested:** per-child daily turn limit (300 operational ceiling,
40/day by plan, whichever is lower), per-conversation turn limit, per-child
daily minutes via parental controls, request timeout, moderation timeout, retry
bound, max output tokens, context window bound.

**Not implemented:** `AI_DAILY_COST_CEILING_USD`. Per-turn cost is recorded
(`total_cost_usd`, `app.record_usage`) but nothing reads the ceiling and nothing
stops spend. Account-wide exposure is bounded only by (children × 40 turns ×
cost per turn) with no cap on signups.

---

## What must be true before this question is asked again

**Blocking, in order:**

1. **F-01** — escalation delivery. A children's product where a disclosure
   reaches no human should not launch.
2. **F-02** — backups configured _and_ a restore performed. The mechanism now exists; **running the drill once** is what remains.
3. **F-04** — object storage, which also unblocks audio retention and
   multi-instance.
4. **F-03** — Redis-backed rate limiting, which also unblocks multi-instance.
5. **F-05** — transcript retention, or withdraw the control that claims it.
6. ~~**F-07** — an alert destination that is not a log file.~~ **RESOLVED.**

**Then:** ~~error tracking (F-06),~~ domain and certificates (F-09), mobile release
configuration (F-08), at least one verified payment rail, and the AI cost
ceiling.

**Also outstanding, from earlier reviews:** real AES-GCM encryption replacing
the placeholder codec; no penetration test or external security review; the e2e
and browser suites have never been executed; images have never been built; the
deployment workflows have never run; no distributed lock, so exactly one worker.

---

## Confidence in this review

**Evidence-based, and incomplete in a specific way.** Every verdict cites code
that was read during the review. What could not be verified, because it does not
exist yet: any behaviour of a real deployment. No container has run, no image
has been built, no certificate has been issued, no backup has been restored.

Categories 5, 9, 13, and 14 are judged on absence of implementation, which is
straightforward. Categories 1, 2, 3, 7, and 15 are judged on code and tests that
do run. Category 4 is split because the two halves of it genuinely differ.

State of the checks at the time of this review, all green:

|                                |                                                           |
| ------------------------------ | --------------------------------------------------------- |
| Test suite                     | **1,450 passed**, 5 skipped (e2e, needs Docker), 0 failed |
| `tsc -b`, `eslint`, `prettier` | pass                                                      |
| `verify:no-secrets`            | pass                                                      |
| `verify:deploy`                | pass                                                      |
| `verify:audit`                 | pass — 2 accepted advisories, 0 blocking                  |
| `verify:references`            | pass                                                      |
| `verify:migrations`            | pass                                                      |

A green suite is not evidence of readiness, and none of the failures above would
turn a single one of those checks red. That is the point worth taking from this
document: **every one of the seven failures is invisible to CI**, because each is
something absent rather than something broken.

The test suite behind these judgements is recorded in `docs/TEST_REPORT.md`; the
security review in `docs/SECURITY_AUDIT.md`; measured behaviour under load in
`docs/PERFORMANCE_REPORT.md`. This document does not restate them and does not
supersede them.

**No production readiness declaration is made.**
