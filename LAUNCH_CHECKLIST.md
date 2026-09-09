# Launch readiness

**Date:** 2026-08-23
**Items assessed:** 46
**Method:** each item checked against code and against what has actually been
executed. Nothing is marked PASS for existing.

---

## Verdict

# NOT READY TO LAUNCH

|                  | Count |
| ---------------- | ----: |
| **PASS**         |    23 |
| **FAIL**         |     4 |
| **NOT VERIFIED** |    19 |

**Not one item in Infrastructure or Mobile passes.** No container has been
built, no environment has ever run, no build has been produced for either
platform. Those two categories are not "nearly there" — they have not started
being verified.

Two product features were also weaker than they appeared, both found during
this assessment rather than earlier. **Both have since been fixed**; the original
findings are kept verbatim below rather than deleted, because what a release
review said before the fix is the part worth being able to read again:

> ~~**The parent dashboard's activity numbers will always be zero.** The pipeline
> is complete — event → rollup → dashboard — except that nothing ever emits the
> event. See P-01.~~ **RESOLVED** — the recorder is wired and proven end to end.
> See P-01.
>
> ~~**"Stories" is a conversation screen with different placeholder text.** No
> story is tracked, and the plan's weekly story limit is enforced nowhere.
> See P-02.~~ **RESOLVED** — the mode reaches the server, changes the prompt, is
> counted against the plan, and records a story. See P-02.

---

## What the marks mean

The brief asked for these to be distinguished, and the distinction is the whole
value of this document.

| Term                | Means                                                                     |
| ------------------- | ------------------------------------------------------------------------- |
| **implemented**     | The code exists and is reachable                                          |
| **tested**          | Automated tests exercise it, against mocks and an in-process database     |
| **verified**        | It has been observed working in something resembling its real setting     |
| **not verified**    | Implemented, possibly tested, never observed in a realistic setting       |
| **external config** | Blocked on infrastructure, an account, or a credential nobody has created |
| **legal review**    | Needs a lawyer or a compliance specialist, not an engineer                |

**PASS requires _verified_**, and the line runs along _what the real setting
is_:

- Where the real setting is **our own server** — RLS, authorization, webhook
  handling, log redaction — executed integration tests against the real
  application, real SQL and real policies **are** verification. What is missing
  is production scale, not realism.
- Where the real setting is **a device or a third party** — the microphone
  prompt, a model answering a child, a vendor taking money — tests against mocks
  are **not** verification, however thorough. They are evidence about our code
  and say nothing about the system.

Applying that line moved one item during review: mobile **Permissions** was
first marked PASS on the strength of a correct manifest, which is precisely the
"code exists" reasoning this assessment is supposed to refuse. The permission
prompt has never appeared on a device, because no build exists.

Most of the NOT VERIFIED items are implemented _and_ tested; they are marked
that way because the thing that would confirm them has never run.

**The single largest cause of NOT VERIFIED is that Docker was never available
on the machine this was built on.** No image, no staging stack, no e2e suite, no
real Postgres beyond CI's service container.

---

## Product

| Item             | Status           | Evidence level                                                                                              |
| ---------------- | ---------------- | ----------------------------------------------------------------------------------------------------------- |
| Onboarding       | **PASS**         | implemented, tested. Parent area is a deliberate dead end in child mode — no password field exists there    |
| Child profiles   | **PASS**         | implemented, tested. Create, edit, soft-delete, per-child languages, RLS-scoped                             |
| AI conversation  | **NOT VERIFIED** | implemented, tested against a **mock model**. No real model has ever answered a child                       |
| Voice            | **NOT VERIFIED** | implemented, tested. Playback was broken until this week (relative, unauthenticated URL); STT/TTS are mocks |
| Speech practice  | **NOT VERIFIED** | implemented, tested. Scoring is real; the analysis provider is a mock                                       |
| Stories          | **PASS**         | implemented, tested, **verified end to end** — prompt, plan limit and progress counter all real (P-02)      |
| Characters       | **PASS**         | implemented, tested. Four seeded, each with traits, colour and a face for pre-readers                       |
| Progress         | **PASS**         | implemented, tested, **verified end to end** — talking to the companion moves the numbers (P-01 resolved)   |
| Parent dashboard | **PASS**         | implemented, tested, verified. Activity numbers are produced by real use, not seeded (P-01 resolved)        |

### P-01 · Nothing ever records a learning event · ~~**blocking**~~ **RESOLVED**

The progress pipeline is built correctly end to end:

```
learning event  →  app.rebuild_learning_daily()  →  learning_daily / _weekly  →  dashboard
```

`createLearningStore().append()` inserts the event and rebuilds the rollup in
the same transaction. **It is called by nothing.** Every route in
`learning.ts` is a `GET`; no conversation turn and no practice attempt emits an
event.

The consequence is specific rather than total:

| Dashboard section                                                | Populated?                                     |
| ---------------------------------------------------------------- | ---------------------------------------------- |
| Conversation seconds, turns, words used, new vocabulary, stories | **never — always zero**                        |
| Safety flags and categories                                      | yes — `content_flags` is written on every turn |
| Practice results and achievements                                | yes — written directly by the practice route   |
| Parental controls, plan limits                                   | yes                                            |

So a parent who has watched their child talk for a week opens "Progress" and
sees zeros next to a chart with no bars, beside a safety section that clearly
did notice the conversations. That reads as broken, and it is.

**Why the tests did not catch it.** `parent-dashboard.test.ts` seeds
`conversations` directly and asserts structure and empty states. Nothing asserts
that _using the product_ produces a number. The aggregation logic itself is
well tested — in `services/learning`, in isolation, against events handed to it.

#### Resolution

`apps/api/src/learning-events.ts` — a recorder wired into the conversation and
practice routes. No part of the pipeline changed; the missing producer was
added.

| What emits              | Where                                                     | Events                                                                              |
| ----------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| A child's turn          | `routes/conversations.ts`, after the message is persisted | `conversation_turn`, `word_encountered` (a **count**)                               |
| A conversation ending   | `routes/conversations.ts` end route                       | `conversation_ended`, `conversation_time` (seconds from `app.conversation_seconds`) |
| A pronunciation attempt | `routes/practice.ts`, after the result is stored          | `pronunciation_scored` (averaged, not summed)                                       |

Four properties, each with a test:

1. **Never fails the thing it measures.** Every method swallows its own failures
   into the log. A metric that breaks a child's turn is worse than a missing
   metric.
2. **Never carries content.** Payloads are counts, durations and scores.
   `recordLearningEvent` throws rather than stripping, so a payload carrying
   content fails a test instead of silently disappearing in production.
3. **Never double-counts.** Idempotency keyed on the message, conversation or
   attempt id — a retried request must not inflate a child's morning.
4. **Reaches the dashboard even when nobody ends the conversation.** A
   five-year-old does not end conversations; the app gets closed. A worker sweep
   (`learning.rebuildRollups`, every 5 min) rebuilds days whose events are newer
   than their rollup.

**The test that was missing is now the test that guards it.**
`tests/integration/learning-events.test.ts` — 12 tests that drive the real HTTP
API and read the answer from the endpoint the dashboard reads. None of them
inserts a learning event.

**A second defect, found by wiring this up.** `learning_events.conversation_id`
is `on delete set null`, and the table is append-only via a BEFORE UPDATE
trigger. Those contradict: a set-null IS an update, so **deleting a conversation
failed** — and through the cascade from `children`, so did deleting a child's
data. It had been invisible because no event had ever carried a conversation id.
`20260817300000_learning_events_provenance_delete.sql` narrows the trigger to
permit exactly that one update — a provenance column moving to null, every other
column identical — and nothing else. Erasure outranks immutability. Both halves
are now tested, including deleting a child who has learning events.

### P-02 · "Stories" is a label, not a feature · ~~**blocking**~~ **RESOLVED**

`StoryScreen` is `<ConversationScreen mode="story" />`, and `mode` changes
exactly two things: a `testID`, and one line of body text ("Shall we make a
story?" instead of "What shall we talk about?").

It does not change the prompt, does not tell the API anything, and does not
record a story. `story_completed` is a defined event type that **nothing
emits**. `weekly_story_limit` is a column on every plan that **nothing reads**.

The server-side `storytelling_enabled` is real — it is a parental control that
permits the model to tell stories at all — but that is a permission, not a mode.

A plan advertising a weekly story limit that is never enforced, next to a
progress counter that never moves, is a feature claim the product does not meet.

#### Resolution

A conversation now carries a `mode` (`chat` or `story`), set from the request
and defaulting to `chat` — so a client that predates this behaves exactly as it
did. A story is still a conversation: same messages, same safety pipeline, same
retention, same RLS. Only four things change.

| What                   | Before                  | Now                                                                         |
| ---------------------- | ----------------------- | --------------------------------------------------------------------------- |
| The prompt             | identical to a chat     | a `Making a story together` section, placed **below** the safety block      |
| `storytelling_enabled` | one line of prompt text | the session is **refused**; the prompt line stays as the second layer       |
| `weekly_story_limit`   | read by nothing         | enforced at `/start` — `429 QUOTA_WEEKLY_STORIES_EXHAUSTED` with `resetsAt` |
| `story_completed`      | emitted by nothing      | emitted when a story is finished, so the progress counter moves             |

Four decisions worth stating, because each could reasonably have gone the other
way:

1. **A story is built with the child, not performed at them.** The obvious
   reading of "tell me a story" is a monologue, and it would contradict the
   reply-length limits that exist because a three-year-old cannot hold six
   sentences — and would turn a conversation app into a playback device. The
   character builds it a beat at a time and hands it back constantly.
2. **The story frame sits below the safety rules and below the parental
   restrictions.** A later instruction tends to carry more weight, and "do not
   tell stories" must never be readable as something the story frame supersedes.
   Asserted in a test.
3. **A session with nothing said in it does not spend a story.** A five-year-old
   opens Story and the tablet is taken away; counting that would burn one of
   their three for the week, and they can neither understand it nor undo it.
4. **NULL means unlimited.** The paid plans are seeded with a null limit.
   Treating null as zero would take stories away from precisely the people who
   paid for them.

**Verification.** `tests/integration/stories.test.ts` — 14 tests through the
HTTP API, including one that wraps the AI provider and reads the system prompt
off the wire, because every piece of this can be individually correct while the
mode never reaches the model, which is exactly the state it was in before. Plus
5 unit tests in `services/ai/src/prompts.test.ts` for the prompt itself.

**Still true, and out of scope here.** The child app shows a Story tile whether
or not the parent has enabled storytelling; a child who taps it gets a warm
refusal rather than never seeing the tile. Hiding it needs the child app to know
the parental controls, which it currently does not fetch.

---

## Safety

| Item              | Status           | Evidence level                                                                                                                                                           |
| ----------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Child safety      | **NOT VERIFIED** | implemented, heavily tested. Five-layer pipeline, fails closed, adversarial corpus. Never run against a real model                                                       |
| AI moderation     | **NOT VERIFIED** | implemented, tested. Both classifiers are **mocks**; the real provider has never moderated anything                                                                      |
| Parental controls | **PASS**         | implemented, tested. Daily and session minutes, quiet hours, allowed days, character allowlist, pause — enforced server-side, not just rendered                          |
| Consent           | **PASS**         | implemented, tested. Versioned, per-child, and enforced by **RLS** — a child without consent cannot have a conversation row created, whatever the application layer does |
| Privacy           | **PASS**         | implemented, tested, verified against the stored bytes. Transcript retention deletes, the shorter of parent and operator wins, and each sweep is audited                 |
| Data deletion     | **NOT VERIFIED** | implemented, tested. Password re-entry, 30-day grace, cascade. Never executed against real data                                                                          |

**Escalation delivery is the gap that matters most, and it is counted under
Infrastructure → alerts** because that is where the missing piece is. Detection
and the decision rules are implemented and tested; a disclosure produces an
audit row and a log line and reaches no human.

---

## Security

| Item             | Status           | Evidence level                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authentication   | **PASS**         | implemented, tested. Argon2id at the OWASP floor, timing-safe unknown-account path, session revocation                                                                                                                                                                                                                                                                                                    |
| Authorization    | **PASS**         | implemented, tested. Role and permission checks, ownership checks, 403 and 404 deliberately indistinguishable                                                                                                                                                                                                                                                                                             |
| RLS              | **PASS**         | implemented, tested. All **50** tables `ENABLE` **and** `FORCE`, proven by a catalogue query that fails on any new table. Behavioural denial tested across the tenant-critical surface                                                                                                                                                                                                                    |
| Secrets          | **PASS**         | implemented, tested. Nothing in any image layer, no build args, history scanned in CI, workflows blocked from echoing a secret                                                                                                                                                                                                                                                                            |
| API security     | **PASS**         | implemented, tested. Helmet, CORS with no wildcard in deployed environments, Zod response schemas as a privacy control, no internals in errors. **Rate limiting is per-instance and in-memory** — behind N instances every limit is N times the configured value, including the authentication limit. That is a capacity and abuse concern, not an API-surface defect, and it is listed as blocking below |
| Storage          | **NOT VERIFIED** | implemented, tested against a local server; **never run against a real bucket**. The audio retention sweep is now schedulable                                                                                                                                                                                                                                                                             |
| Payment webhooks | **PASS**         | implemented, tested. Signature verified first, idempotent, replay-safe by two mechanisms, one transaction                                                                                                                                                                                                                                                                                                 |

RLS deserves its PASS with a stated limit: **85 policies are declared and not
each individually driven by a behavioural test.** The structural guarantee is
complete and self-maintaining; the behavioural coverage is a well-chosen subset.

---

## Payments

| Item                 | Status           | Evidence level                                                                                                                                   |
| -------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Subscriptions        | **NOT VERIFIED** | implemented, tested. Full lifecycle as a pure state machine. No real vendor has ever driven it                                                   |
| Free tier            | **PASS**         | implemented, tested. Plan limits resolved from the database and enforced on every turn; the operational ceiling and the plan, whichever is lower |
| Payment verification | **NOT VERIFIED** | implemented, tested against sandboxes. **No rail is verified**, and a deployed environment refuses to enable one that is not                     |
| Cancellation         | **PASS**         | implemented, tested. One click, reversible, access continues to period end, and the copy says so                                                 |
| Renewal              | **NOT VERIFIED** | implemented, tested. Driven only by mock webhooks and the sweep                                                                                  |
| Refunds              | **NOT VERIFIED** | implemented, tested on the card sandbox. Wallets and carrier billing correctly report `unsupported` rather than pretending                       |
| Store billing        | **NOT VERIFIED** | implemented, tested. Server-side receipt verification, client never trusted. Neither store account exists                                        |

**No payment can be taken today, by design.** `PAYMENTS_ENABLED_RAILS` and
`PAYMENTS_VERIFIED_RAILS` are both empty and the config refuses a rail that is
enabled but unverified. Every family would be on the free tier. That is the
safety mechanism working, not a defect — but it means the entire category is
unproven against a real vendor.

---

## Infrastructure

| Item                   | Status           | Evidence level                                                                                                                                                               |
| ---------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Production environment | **FAIL**         | does not exist. No host, no domain, no certificate, no orchestrator — **external config**                                                                                    |
| Database               | **NOT VERIFIED** | implemented, tested. Migrations forward-only with a checksum ledger, applied to real PostgreSQL 17 in CI. No production instance exists — **external config**                |
| Backups                | **NOT VERIFIED** | implemented: encrypted dumps, verification, restore guards, and a weekly automated restore drill. **None of it has ever run** — no database exists to back up                |
| Monitoring             | **FAIL**         | metrics implemented and tested; **no external system receives them**. `OTEL_EXPORTER_OTLP_ENDPOINT` is declared and unread                                                   |
| Logging                | **PASS**         | implemented, tested. Redaction at 100% of lines and branches, request ids, no internals in responses                                                                         |
| Alerts                 | **PASS**         | five conditions, each with a producer, delivered to a configured destination and verified against a real HTTP server. Production refuses to boot without one (I-01 resolved) |
| Rollback               | **NOT VERIFIED** | documented and correct about the forward-only database. **Never rehearsed**, and its backup fallback does not exist                                                          |

### I-01 · Alerts reach nobody · ~~_escalation half resolved_~~ **RESOLVED**

The alert monitor is correct and tested: it fires on the first safety failure,
does not repeat while firing, clears on recovery, and survives a webhook outage.
The default sink writes a `fatal` log line — deliberately, so alerting does not
depend on an outbound call during a network incident.

**No webhook is configured in any environment.** So every alert is a log line
that something else would have to notice, and nothing does.

For `safety_pipeline` that is an operational gap. For a **disclosure of harm**
it is worse: `SAFETY_ESCALATION_WEBHOOK_URL` is _required_ for production to
boot, with the message "disclosures must reach a human", and no code reads it.

#### Resolution

`ALERT_WEBHOOK_URL` exists, is wired, and production refuses to boot without it.
`generic` or `slack` bodies; three attempts; the `fatal` log line is still
written underneath, so a webhook outage does not lose the alert.

The assessment above was too kind. Three of the five conditions had **no
producer at all**, and `reportSafetyFailure` was called only by the escalation
delivery path — so the alert named after the safety pipeline could not fire when
the safety pipeline failed. Turns now report it, the readiness probe reports the
database, and a timer evaluates the thresholds instead of waiting for a scrape.

Two conditions could also fire only **once per process**, because nothing could
clear them and a firing condition is deliberately not re-delivered; and a
cleared alert told nobody it had recovered. Both fixed.

Verified end to end in `tests/integration/alerting.test.ts` against a real HTTP
server: a child talks, the classifier is unreachable, and a request arrives
saying so — carrying the condition and the measurement, and none of the child's
words.

---

## Mobile

| Item                | Status           | Evidence level                                                                                                                                                                            |
| ------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Android build       | **NOT VERIFIED** | never attempted. No `eas.json`, no build profile, no artifact — **external config**                                                                                                       |
| iOS build           | **NOT VERIFIED** | never attempted. Same, plus an Apple Developer account that does not exist — **external config**                                                                                          |
| Permissions         | **NOT VERIFIED** | implemented. `NSMicrophoneUsageDescription` present and honest about what happens to recordings; `RECORD_AUDIO` declared. **The prompt has never appeared on a device** — no build exists |
| Store configuration | **FAIL**         | bundle identifier and package are literally `app.kidscompanion.placeholder`; version is `0.0.0` — **external config**                                                                     |
| Privacy disclosures | **NOT VERIFIED** | privacy policy content exists in the dashboard. Neither store's data-safety declaration has been drafted — **legal review**                                                               |

**Nothing has been submitted to any store, and nothing here submits anything.**

Both stores review kids-category apps against additional criteria that have not
been addressed: Apple's Kids Category rules and Google Play's Families policy
each impose requirements on ads, analytics, external links and data collection
that need review before a first submission, not after a rejection.

---

## QA

| Item              | Status   | Evidence level                                                                                                            |
| ----------------- | -------- | ------------------------------------------------------------------------------------------------------------------------- |
| Unit tests        | **PASS** | 886 tests. Verified — they run, and they have caught real defects                                                         |
| Integration tests | **PASS** | 765 tests against the real app, real plugins, real SQL, real RLS                                                          |
| E2E tests         | **FAIL** | **never executed.** 5 Vitest specs skip without Docker; 7 Playwright specs have never run — browsers were never installed |
| Performance tests | **PASS** | implemented and executed. Ten scenarios, a concurrency ladder, p50/p95/p99, and they found two real defects               |
| Security tests    | **PASS** | 49 tests, twelve named attacks, with positive controls so a passing suite cannot be passing against nothing               |

**Current: 1,651 passing, 5 skipped, 0 failing.** Coverage 88.2% statements,
90.4% lines, against a 70% floor.

The honest caveat that applies to every row above: **integration tests run
against PGlite**, an in-process single-connection Postgres. RLS semantics are
exercised faithfully; connection pooling, concurrent backends and server
configuration are not.

---

## Blocking items, in the order they should be fixed

1. **The disclosure protocol** (Q-07). Delivery is now built — an escalation is
   recorded, routed and retried. What does not exist is the decision about WHO
   receives it and what duty attaches, which §6.2 of docs/CHILD_SAFETY.md is
   explicit cannot be made by engineers. A configured endpoint with nobody
   trained behind it is not a human path.
2. ~~**Learning events** (P-01). The parent dashboard is a core promise and it
   shows zeros.~~ **RESOLVED** — talking to the companion now moves the numbers,
   proven through the HTTP API rather than by seeding the tables.
3. **Backups** — the scripts and an automated weekly restore drill now exist;
   what remains is **running the drill once**, which needs a database rather
   than more code.
4. ~~**Object storage**, which also unblocks audio retention and multi-instance.~~
   **IMPLEMENTED, NOT VERIFIED** — the adapter and the audio retention sweep are
   real; no request has ever reached a real bucket. Verifying that is a
   deployment step, not a coding one.
5. ~~**Distributed rate limiting**, without which every limit multiplies by the
   instance count — including the one that makes password guessing impractical.~~
   **RESOLVED** — counted in Redis, with a fallback to per-instance counting
   rather than to allowing or refusing everything.
6. ~~**Transcript retention**, or withdraw the control that claims it.~~
   **RESOLVED** — the control now does what it says, and a parent is shown the
   retention that applies rather than the one they asked for.
7. ~~**An alert destination** that is not a log file.~~ **RESOLVED** — and the
   alerts themselves now have producers, which three of the five lacked.
8. ~~**Stories** (P-02) — implement it or stop advertising it in the plan table.~~
   **RESOLVED** — implemented, including the plan limit that was advertised and
   never enforced.

Then: ~~error tracking,~~ a domain and certificates, mobile release configuration,
at least one verified payment rail, the AI spend ceiling, and executing the e2e
and browser suites at least once.

---

## Requires external configuration

Not engineering work. Someone has to create an account, register a name, or
provision a service.

Hosting and orchestration · a domain · TLS certificates · managed Postgres with
PITR · managed Redis · an object store · an error-tracking project · an alert
destination · a metrics backend · Apple Developer and Google Play accounts ·
real bundle identifiers · payment rail merchant accounts and sandbox
credentials · store billing credentials.

## Requires legal or compliance review

Explicitly outside what an engineer can sign off, and **none of it is claimed as
complete anywhere in this repository**:

- **COPPA / GDPR-K and Pakistan's data protection regime** as they apply to
  voice recordings and transcripts of children.
- **Parental consent mechanism** — whether the current versioned in-app consent
  is sufficient in each target jurisdiction, or whether verifiable parental
  consent is required.
- **Retention periods** — the configured defaults are engineering guesses, not
  legal determinations.
- **Both stores' kids-category policies**, and the data-safety declarations that
  go with a submission.
- **The escalation protocol itself** — what happens when a child discloses harm,
  who is contacted, and what duty attaches. This is an open question (Q-07) and
  is a safeguarding decision before it is a technical one.
- Terms of service, privacy policy, and subscription terms as published text.

---

## Evidence base

| Never executed                 | Consequence                                                         |
| ------------------------------ | ------------------------------------------------------------------- |
| Docker                         | No image built, no staging stack started, no container smoke-tested |
| Playwright browsers            | The entire browser E2E suite is unrun                               |
| A production-like environment  | Nothing in Infrastructure can be verified                           |
| A real AI, STT or TTS provider | No conversation, transcription or synthesis has been real           |
| A real payment vendor          | No money has moved in any direction                                 |
| A store build                  | Neither app has been compiled for a device                          |

Supporting detail, none of it restated here:
`docs/TEST_REPORT.md` · `docs/SECURITY_AUDIT.md` · `docs/PERFORMANCE_REPORT.md`
· `PRODUCTION_READINESS.md` · `FINAL_PRODUCT_REVIEW.md` · `DEPLOYMENT.md` ·
`CI_CD.md`.

**Uncommitted at the time of writing:** the reduced-motion fix from the previous
phase (`apps/mobile/src/hooks/reduced-motion.ts` and two component changes) and
the updated `FINAL_PRODUCT_REVIEW.md`.

---

## What this document does not say

It does not say the application is badly built. Fourteen items pass on real
evidence, the security posture is genuinely strong, and the test suite has
repeatedly caught defects that a demo would not have.

It says something narrower and more useful: **a large amount of this system has
never been observed working**, and the gap between "implemented and tested" and
"verified" is where launches fail. Two features are additionally not what they
appear, and one safety path stops at a log line.

**No launch decision is made here, and nothing has been submitted anywhere.**
