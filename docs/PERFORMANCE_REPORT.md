# Performance report

**Date:** 2026-08-23
**Suite:** `pnpm run perf` (`tests/performance/`)
**Machine:** Node 24.19.0, win32, **4 logical CPUs**, 3.7 GB RAM — a developer laptop, not a server.

---

## Read this before any number

**The single most important caveat: at concurrency 1, roughly 15 ms of every HTTP
figure below is the measuring apparatus, not the server.** The same route
measured in-process costs 0.1 ms; measured over a loopback socket from Node's
`fetch` it costs 15.4 ms. A server cannot get six times faster under more load,
and `/health` drops to 2.5 ms at concurrency 8 — so the 15 ms floor is the
client and the operating system (it matches Windows' default 15.6 ms timer
granularity almost exactly). **Read throughput and the higher rungs of the
ladder, not p50 at c=1.**

|                             | p50 at c=1 | p50 at c=8 | Throughput ceiling |
| --------------------------- | ---------: | ---------: | -----------------: |
| `GET /health` over a socket |    15.4 ms |     2.5 ms |        2,896 req/s |
| the same route in-process   |     0.1 ms |     0.6 ms |       13,320 req/s |

**Three things were not measured, and no number here covers them:**

1. **Vendor latency.** STT, the LLM, and TTS are mocks. Their real latency is
   the majority of the voice-loop budget. One scenario _injects_ a
   representative delay — that is arithmetic about the budget, not a
   measurement of any provider.
2. **Production Postgres.** The database is PGlite: Postgres compiled to
   WebAssembly, in-process, on **one connection**, with no network hop and no
   pool. Because it runs on the same thread, database time appears here as
   event-loop lag; in production it would be I/O wait instead. Absolute database
   numbers are not production numbers.
3. **The client.** VAD endpointing and mobile upload are two line items in the
   latency budget and both happen on a phone in Pakistan.

**Everything is closed-loop.** Fixed workers each send a request, wait, and send
the next. A slow response delays that worker's next request, so queues cannot
build the way they do when real users keep arriving regardless. This is
_coordinated omission_: **the p99 figures here are a floor, not a forecast.**

**Limits were raised to measure endpoints rather than limiters.** Rate limits
and plan quotas were lifted in the harness; the real values are reported in §7
as the capacity ceilings they are.

---

## 1. Method

- **Concurrency ladder:** 1 → 2 → 4 → 8 → 16 → 32 for every scenario.
- **Percentiles:** nearest rank, so every figure is a latency some request
  actually experienced rather than an interpolation between two that did not.
- **p99 honesty:** a percentile needs samples beyond it to mean anything. Rows
  with fewer than 500 samples carry a `*` on p99 — with 90 samples, p99 is the
  maximum wearing a hat.
- **Warm-up:** discarded iterations at the same concurrency before measuring, so
  percentiles describe steady state rather than JIT warm-up.
- **Event-loop lag:** how late a 10 ms timer actually fires, sampled throughout.
  This is what distinguishes "the database is slow" from "we are burning the
  only thread we have", and it is the column that explains most of this report.
- **Fixtures are rotated**, not reused: conversations are recreated before every
  rung so a scenario measures a session of realistic length rather than a
  transcript of several thousand turns that no child will ever have.

---

## 2. Baseline — the summary that matters

Cost per request derived from the throughput plateau (1 ÷ peak req/s). This is
the apparatus-free number: it is what one request actually consumes.

| Scenario                                 | Peak req/s | Cost per request |
| ---------------------------------------- | ---------: | ---------------: |
| `GET /health` (in-process)               |     13,320 |          0.08 ms |
| `GET /health` (over a socket)            |      2,896 |          0.35 ms |
| Database — point read                    |      2,774 |          0.36 ms |
| Database — dashboard aggregate           |      1,985 |          0.50 ms |
| Rate limiter scenario (see note)         |        244 |          4.10 ms |
| `GET /v1/children`                       |        182 |          5.49 ms |
| `POST /api/subscriptions/webhook/:rail`  |        181 |          5.53 ms |
| `GET /api/subscriptions/status`          |        162 |          6.18 ms |
| `POST /api/subscriptions/create`         |        111 |          8.99 ms |
| `GET /api/parent/dashboard/:childId`     |        104 |          9.66 ms |
| **Conversation turn** (instant provider) |         48 |     **20.89 ms** |
| **Voice turn** (instant providers)       |         38 |     **26.62 ms** |
| **`POST /v1/auth/login`**                |     **11** |     **89.69 ms** |

Two numbers carry this whole report: **a login costs 90 ms of CPU**, and
**a conversation turn costs 21 ms of our own work** once vendor time is removed.

> **Note on the rate-limiter row.** That scenario drives the same
> `GET /v1/children` endpoint but on a **second, freshly migrated database**,
> so it is faster (244 vs 182 req/s) because it reads a nearly empty schema —
> not because the limiter makes anything quicker. Compare it only with itself,
> as the "before" for any future Redis-backed limiter.

---

## 3. Bottlenecks

### B-01 — Argon2id in the login path blocks everything else · **critical**

**Evidence.** Login throughput is flat at **7–11 req/s from concurrency 1 to
32** while latency grows linearly, 106 ms → 2,836 ms. Event-loop lag tracks
latency almost exactly (437 ms → 3,137 ms). Flat throughput with linear latency
and lag equal to latency is the signature of one CPU-bound thread.

**The consequence, measured.** A separate experiment
(`tests/performance/interference.ts`) holds one reader on `GET /v1/children`
while just **four** logins run continuously:

| `GET /v1/children` |      p50 |          p95 |      p99 |
| ------------------ | -------: | -----------: | -------: |
| quiet system       |  15.3 ms |      20.9 ms |  36.9 ms |
| while 4 logins run | 338.2 ms | **448.5 ms** | 534.9 ms |

**An unrelated read is 21× slower at p95 because four people signed in.** Not
the login — everything.

**Cause.** `services/auth/src/passwords.ts` uses Argon2id at the OWASP floor
(19,456 KiB, t=2, p=1) via WebAssembly, which is synchronous CPU work on the
request thread. Every login pays it, including failures: an unknown address is
verified against a dummy hash on purpose, so response time cannot be used to
enumerate accounts.

**This is a security control working correctly, and it must not be "optimised"
by lowering the cost.** See §4.

### B-02 — A conversation turn makes three sequential provider round trips · **high**

**Evidence.** Counting calls through a proxy around the provider, one turn makes
**three**: `generateResponse` ×1 and `moderateContent` ×2 (input safety and
output safety). They are sequential, so their latencies add. With 500 ms
injected per call, the measured turn latency is **1,555 ms at p50** — three
round trips plus our 21 ms, almost exactly.

**Why it matters.** [ARCHITECTURE.md §7.1](../ARCHITECTURE.md) budgets 500 ms
for LLM time-to-first-token, **0 ms effective** for input safety ("overlapped"),
and 80 ms for output safety on the first chunk. Measured, input safety is not
overlapped and output safety is a full round trip, not a chunk check. The budget
assumes an execution shape the code does not currently have.

### B-03 — Everything is queued behind one event loop · **high**

**Evidence.** Every endpoint shows the same shape: throughput plateaus, latency
grows linearly with concurrency, and event-loop lag rises to meet latency.

| Endpoint           |  c=1 p50 |   c=32 p50 | Throughput c=1 → c=32 |
| ------------------ | -------: | ---------: | --------------------- |
| `GET /v1/children` |  15.4 ms |   177.7 ms | 68 → 165 req/s        |
| Dashboard          |  15.5 ms |   304.2 ms | 63 → 104 req/s        |
| Conversation turn  |  31.1 ms |   649.6 ms | 32 → 48 req/s         |
| Login              | 106.5 ms | 2,835.7 ms | 7 → 11 req/s          |

Throughput barely moves while latency grows 10–25×. The process is saturated at
low concurrency and additional concurrency only adds queueing. Four logical CPUs
are available and one thread is serving requests.

### B-04 — The database is **not** a bottleneck · finding

Worth stating because it is where optimisation effort usually goes first, and
here it would be wasted:

|                                      |     p50 | Peak req/s | Event-loop lag |
| ------------------------------------ | ------: | ---------: | -------------: |
| Point read                           | 0.36 ms |      2,774 |       **0 ms** |
| Dashboard aggregate (heaviest query) | 0.50 ms |      1,985 |       **0 ms** |

The heaviest read in the product costs half a millisecond and sustains ~2,000/s.
The dashboard _endpoint_ sustains 104/s. Query counts are modest and bounded:
`/health` 0, `/v1/children` 6, `/api/subscriptions/status` 8, dashboard 14,
conversation turn 24. No N+1 was found. **The cost is in application code and
the single thread, not in SQL.**

The PGlite caveat cuts both ways here: real Postgres adds a network hop these
figures do not include, but it also moves that work off the request thread.

---

## 4. What was deliberately **not** optimised

The brief says not to optimise prematurely. Each candidate below was measured,
considered, and rejected — with the reason, because a rejected optimisation is
only useful if the reasoning is recorded.

| Candidate                                                                                  | Measured gain                             | Why not                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------ | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Lower the Argon2 cost parameters**                                                       | Would raise login throughput several-fold | It is the security control. 19,456 KiB / t=2 is the OWASP floor and the module says never to lower it. Cheaper hashing is a cheaper offline attack on every parent's password.                                                                             |
| **Cache session validation** (a DB read on every authenticated request)                    | ~4 of 6 statements on `/v1/children`      | Weakens revocation: a revoked session would keep working for the cache lifetime. That is a security trade-off requiring a product decision, not a performance tweak.                                                                                       |
| **De-duplicate `app.recent_safety_blocks`** — called twice per turn, once per safety stage | ~2 of 24 statements (~4%)                 | It is a **child-safety** control. The value is stable within a turn today, but sharing it across stages would make a concurrent block for the same child invisible to the output stage. A 4% saving is not worth reasoning about races in the safety path. |
| **Merge the dashboard's two parental-control reads**                                       | ~1 of 14 statements                       | On inspection they are not the same query: one reads `parental_controls`, the other `app.parental_gate_inputs()` which also computes `seconds_used_today`. Merging needs a migration for a sub-millisecond gain.                                           |
| **Move Argon2 to worker threads**                                                          | Would address B-01 without weakening it   | The right answer, and recommended in §8 — but it changes the authentication path and deserves its own phase with its own review, not a drive-by change during measurement.                                                                                 |

**No micro-optimisation in this codebase is justified by this data.** Per-query
cost is sub-millisecond and query counts are bounded. The two real levers are
architectural.

---

## 5. Changes made during this phase, and their measured effect

These are **correctness defects found by performance testing**, not throughput
optimisations. Each is reported with what was measured before and after.

### 5.1 Seven routes were invisible to all metrics — _fixed_

`services/analytics/src/metrics.ts` rejected any label value matching
`^[A-Za-z0-9+/=_-]{24,}$` as "an identifier". That character class **includes
`/`**, so any route pattern of 24+ characters made only of letters and slashes
matched it and threw inside the `onResponse` hook.

**Before:** `/api/conversations/start`, all five static `/api/subscriptions/*`
routes, and `/api/observability/health` — seven routes — threw on **every
request**, and were recorded in **no metric at all**. Because the response had
already been sent, clients saw correct answers and every test passed. Routes
with a `:param` escaped only because `:` is outside the character class.

**Why it mattered beyond dashboards:** `http_errors_total` is also skipped, and
that is the series the `error_rate` alert reads. **A 5xx storm on subscriptions
or on conversation-start could not have raised the alarm.**

**After:** all seven record normally. Regression test asserts the real route
table, including the long static routes; a companion test proves a URL with a
real UUID in it is still rejected, so the cardinality protection is intact.

_Found because this phase drove real HTTP and read the server's own logs._

### 5.2 A signed webhook with an unparseable reference returned 500 — _fixed_

The reference from the vendor payload was cast with `$1::uuid` without
validation. A non-UUID reference raised Postgres 22P02 and surfaced as
`INTERNAL_ERROR`.

The module's own docstring states the contract this broke: _"a 5xx would make
the rail retry something that will never succeed."_ A malformed reference would
have been retried by the vendor indefinitely, each attempt counting toward the
5xx rate that alerting watches.

**Before:** HTTP 500. **After:** HTTP 200, `outcome: "ignored"` — the documented
path for an event we cannot act on. Regression test added.

### 5.3 Concurrent turns on one conversation raced and failed — _fixed_

`nextSequence` was read from `message_count` **before** the provider call, which
takes hundreds of milliseconds. Two turns in flight computed the same sequence
and the second died on `uq_messages_conversation_sequence`.

Not exotic: a child taps send twice, or the app retries on a flaky mobile
connection while the first turn is in flight — which ARCHITECTURE.md §7.3 says
it should do.

| Four simultaneous turns, one conversation | Result                               |
| ----------------------------------------- | ------------------------------------ |
| **Before**                                | 1 succeeded, **3 returned HTTP 500** |
| **After**                                 | 4 succeeded, sequence numbers unique |

The fix allocates the sequence inside the write transaction under
`select … for update` on the conversation row. The unique index was doing its
job; it was the only thing standing between a stale read and a corrupted
transcript order.

**The regression test was verified by reverting the fix** — it fails against the
old code with the exact 500, and passes against the new. A test that passes
either way would prove nothing.

**Full suite after all three fixes: 1,424 passed, 5 skipped, 0 failed.**

---

## 6. Against the documented latency budget

[ARCHITECTURE.md §7.1](../ARCHITECTURE.md) commits to **p50 ≤ 1.8 s, p95 ≤ 3.0 s**
from end-of-utterance to first audio byte.

> **This target was not measured, and this report does not claim it is met.**

Measuring it requires a real device doing VAD, a real mobile upload, and real
STT / LLM / TTS vendors. None of those were in this run.

What _was_ measured, and the arithmetic it supports:

| Budget line                   |        Target p50 | Measured here                                     |
| ----------------------------- | ----------------: | ------------------------------------------------- |
| VAD endpointing               |            250 ms | not measured (client)                             |
| Upload (PK mobile data)       |            200 ms | not measured (client)                             |
| STT                           |            400 ms | not measured (vendor)                             |
| Input safety (**overlapped**) |    0 ms effective | **a full provider round trip, not overlapped**    |
| LLM time-to-first-token       |            500 ms | not measured (vendor)                             |
| Output safety on first chunk  |             80 ms | **a full provider round trip on the whole reply** |
| TTS time-to-first-byte        |            350 ms | not measured (vendor)                             |
| **Our own orchestration**     | _not a line item_ | **20.9 ms**                                       |

Two observations follow, and only the first is comfortable:

**Our own code is not the problem.** 20.9 ms against an 1,800 ms budget is
1.2%. Server-side orchestration — safety, context assembly, persistence,
serialisation — is not what will make this product slow.

**The budget assumes an execution shape the code does not have.** It allocates
0 ms to input safety by overlapping it with upload, and 80 ms to output safety
by checking only the first chunk. Measured, both are full sequential provider
round trips. If each of the three calls hits the 500 ms the budget allows the
LLM alone, the server-side portion is **~1.52 s**, leaving ~280 ms for VAD,
upload, STT and TTS combined — against 1.8 s. **On current evidence the budget
does not close unless the overlap it assumes is actually implemented.**

That is a statement about arithmetic and call counts, both measured. It is not a
claim about any vendor's real latency.

---

## 7. Capacity ceilings that are configuration, not performance

These were raised in the harness to measure endpoints rather than limiters. They
are real limits and they bind before any figure in §2 does.

| Limit                                          |            Value | Effect                                           |
| ---------------------------------------------- | ---------------: | ------------------------------------------------ |
| `RATE_LIMIT_GLOBAL_PER_MINUTE`                 |              600 | 10 req/s per instance across everything          |
| `RATE_LIMIT_AUTH_PER_15_MIN`                   |               10 | Login attempts per IP                            |
| Subscription webhook (hard-coded in the route) |          600/min | **10 events/s — the one limit not configurable** |
| `RATE_LIMIT_CHECKOUT_PER_HOUR`                 |               20 | Checkouts per parent                             |
| `RATE_LIMIT_CONVERSATION_PER_MINUTE`           |               30 | Turns per minute                                 |
| Plan `daily_turn_limit`                        |     40/day/child | Paid plan; free is 20                            |
| Plan `max_conversation_turns`                  |               40 | Turns in one session                             |
| Parental control `daily_minute_limit`          | 20/day (max 240) | Per child, set by the parent                     |
| `AI_PER_CHILD_DAILY_TURN_LIMIT`                |              300 | Operational ceiling over the plan                |

**The global 600/minute binds long before the measured throughput does.** At the
measured 104 req/s the dashboard could serve 6,240 requests a minute; the
limiter permits 600. Rate limiting is also **per-instance and in-memory**, so
behind _N_ instances the effective limit is _N_ × the configured value.

**There is no Redis in this application.** `REDIS_URL` exists in the config
schema, `/health` reports redis as `skipped`, and no Redis client is installed
in any package. "Redis behaviour" could not be tested because there is none.
Scenario 11 measures what is actually deployed — the in-process limiter — at
**4.10 ms per request and 244 req/s**, which is the number any future
Redis-backed limiter has to be compared against: a network round trip per
request must buy something, and today the limiter costs approximately nothing.

---

## 8. Recommendations, in priority order

Each says what to measure, because none should be adopted on the strength of
this report alone.

1. **Move Argon2 off the request thread** (B-01). A small worker-thread pool
   keeps the parameters _exactly_ as they are — the security control is
   untouched; only where the CPU work happens changes. On 4 cores this should
   also raise login throughput. **Measure:** re-run scenario 4 and
   `interference.ts`; the target is the 21× cross-endpoint penalty falling to
   near 1×. Give it its own phase and its own review — it is an authentication
   change.

2. **Overlap input safety with upload, and check output safety on the first
   streamed chunk** (B-02) — the execution shape §7.1 already assumes. This is
   the difference between a ~1.5 s server-side floor and a ~0.6 s one.
   **Measure:** provider call count per turn, and turn latency with injected
   vendor delay, both of which this suite already reports.

3. **Run more than one process per host.** Four logical CPUs and one busy thread
   is the plainest finding in §2. **Measure:** the same ladder against a
   clustered server; expect throughput to scale with processes and latency
   curves to flatten.

4. **Decide the webhook ceiling deliberately.** 600/minute is hard-coded where
   every other limit is configuration. A rail catching up after an outage
   delivers in bursts. **Measure:** peak delivery rate from the real provider
   before choosing a number.

5. **Re-run against real Postgres before trusting any absolute figure.** Docker
   is not installed on this machine, so nothing here has seen a connection pool,
   a network hop, or a second backend.

---

## 9. Limitations

1. **A developer laptop, 4 logical CPUs, Windows.** Absolute numbers do not
   transfer to a server.
2. **~15 ms of apparatus overhead** at low concurrency on every HTTP figure.
3. **PGlite, single connection, in-process** — and therefore database time shows
   up as event-loop lag here but would not in production.
4. **Closed-loop measurement** — p99 is a floor, not a forecast.
5. **All external providers are mocks.** The one scenario with injected latency
   is arithmetic, not a vendor measurement.
6. **No Redis exists**, so no Redis behaviour was measured.
7. **Nothing here is a soak test.** The longest scenario runs a few minutes.
   Leaks, fragmentation and cache growth are invisible at this timescale.
8. **Rate limits and quotas were raised** to measure endpoints. §7 reports the
   real values.
9. **Some p99 figures are marked `*`** — drawn from fewer than 500 samples, and
   should be read as "roughly the worst we saw", not as a tail.
10. **A single run per configuration.** No repetition, no confidence intervals.

---

## 10. Full baseline results

Rows marked `*` on p99 have fewer than 500 samples.

#### 1. Baseline — GET /health (no auth, no database)

The floor. Routing, serialisation, and the socket, and nothing else.

| Concurrency | Samples | p50 ms | p95 ms | p99 ms | req/s | Loop lag p99 ms |
| ----------: | ------: | -----: | -----: | -----: | ----: | --------------: |
|           1 |     800 |   15.4 |   16.5 |   17.2 |    72 |               6 |
|           2 |     800 |   14.9 |   16.4 |   17.8 |   180 |              11 |
|           4 |     800 |    2.6 |   16.2 |   16.8 |   665 |              11 |
|           8 |     800 |    2.5 |    3.9 |   13.1 |  2896 |               5 |
|          16 |     800 |    5.0 |    9.1 |   15.9 |  2775 |               9 |
|          32 |     800 |   10.2 |   27.8 |   35.1 |  2648 |              20 |

#### 1b. Baseline — the same route via inject() (no socket, no client)

Isolates the Fastify pipeline from the transport. The difference from 1 is apparatus.

| Concurrency | Samples | p50 ms | p95 ms | p99 ms | req/s | Loop lag p99 ms |
| ----------: | ------: | -----: | -----: | -----: | ----: | --------------: |
|           1 |     800 |    0.1 |    0.2 |    0.3 |  6623 |               0 |
|           2 |     800 |    0.2 |    0.3 |    0.4 |  8736 |               0 |
|           4 |     800 |    0.3 |    0.5 |    1.0 |  9280 |               0 |
|           8 |     800 |    0.6 |    0.7 |    0.8 | 13320 |               0 |
|          16 |     800 |    1.2 |    1.8 |    3.2 | 12222 |               0 |
|          32 |     800 |    2.5 |    6.7 |   10.6 |  9310 |               0 |

#### 2. API latency — GET /v1/children (authenticated, one query)

Token verification, RLS transaction, one batched query, Zod response serialisation.

| Concurrency | Samples | p50 ms | p95 ms | p99 ms | req/s | Loop lag p99 ms |
| ----------: | ------: | -----: | -----: | -----: | ----: | --------------: |
|           1 |     800 |   15.4 |   19.4 |   27.3 |    68 |              11 |
|           2 |     800 |   12.0 |   20.9 |   25.6 |   154 |               9 |
|           4 |     800 |   24.2 |   47.6 |   71.1 |   145 |              32 |
|           8 |     800 |   43.5 |   53.4 |   68.2 |   178 |              32 |
|          16 |     800 |   86.3 |   98.7 |  156.4 |   182 |              70 |
|          32 |     800 |  177.7 |  238.6 |  385.5 |   165 |             279 |

#### 3a. Database — single-row point read (direct, no HTTP)

PGlite in-process. Absolute value is not a production number; it is a control for 3b.

| Concurrency | Samples | p50 ms | p95 ms | p99 ms | req/s | Loop lag p99 ms |
| ----------: | ------: | -----: | -----: | -----: | ----: | --------------: |
|           1 |     800 |    0.4 |    0.5 |    0.8 |  2583 |               0 |
|           2 |     800 |    0.7 |    1.1 |    1.9 |  2681 |               0 |
|           4 |     800 |    1.4 |    2.3 |    2.7 |  2618 |               0 |
|           8 |     800 |    2.7 |    4.1 |    5.5 |  2774 |               0 |
|          16 |     800 |    5.6 |    8.7 |   10.5 |  2676 |               0 |
|          32 |     800 |   11.4 |   14.0 |   14.6 |  2741 |               0 |

#### 3b. Database — the dashboard aggregate (direct, no HTTP)

The heaviest read in the product. Compare against 3a, not against a production target.

| Concurrency | Samples | p50 ms | p95 ms | p99 ms | req/s | Loop lag p99 ms |
| ----------: | ------: | -----: | -----: | -----: | ----: | --------------: |
|           1 |     400 |    0.5 |    0.8 |  1.1 * |  1817 |               0 |
|           2 |     400 |    1.0 |    1.3 |  2.8 * |  1872 |               0 |
|           4 |     400 |    2.0 |    3.1 |  4.6 * |  1872 |               0 |
|           8 |     400 |    4.5 |    7.4 |  8.2 * |  1654 |               0 |
|          16 |     400 |    7.9 |   11.2 | 12.8 * |  1913 |               0 |
|          32 |     400 |   15.4 |   20.3 | 21.0 * |  1985 |               0 |

#### 4. Authentication — POST /v1/auth/login (Argon2id at production cost)

Argon2id is 19 MiB and 2 iterations by policy. This is CPU, on one thread.

| Concurrency | Samples | p50 ms | p95 ms | p99 ms | req/s | Loop lag p99 ms |
| ----------: | ------: | -----: | -----: | -----: | ----: | --------------: |
|           1 |     600 |  106.5 |  300.0 |  562.8 |     7 |             437 |
|           2 |     600 |  189.0 |  293.5 |  416.0 |    10 |             188 |
|           4 |     600 |  386.4 |  557.8 | 1277.6 |     9 |             564 |
|           8 |     600 |  972.1 | 1755.8 | 2862.7 |     7 |            1570 |
|          16 |     600 | 1699.8 | 3409.4 | 4769.3 |     8 |            2420 |
|          32 |     600 | 2835.7 | 3478.1 | 3480.3 |    11 |            3137 |

#### 5. Conversation turn — POST /api/conversations/:id/message (instant provider)

Provider latency removed, so every millisecond here is ours to fix. Fresh conversations each rung.

| Concurrency | Samples | p50 ms | p95 ms | p99 ms | req/s | Loop lag p99 ms |
| ----------: | ------: | -----: | -----: | -----: | ----: | --------------: |
|           1 |     600 |   31.1 |   39.5 |   49.3 |    32 |              26 |
|           2 |     600 |   42.7 |   76.5 |  100.3 |    43 |              41 |
|           4 |     600 |   84.4 |   98.8 |  137.3 |    46 |              45 |
|           8 |     600 |  168.1 |  215.6 |  282.6 |    47 |             108 |
|          16 |     600 |  329.0 |  389.9 |  584.9 |    47 |             455 |
|          32 |     600 |  649.6 |  739.4 |  768.2 |    48 |             658 |

#### 6. Concurrent conversations — 8 children, distinct conversations

Different rows, different RLS subjects. Isolates contention from per-row locking.

| Concurrency | Samples | p50 ms | p95 ms |   p99 ms | req/s | Loop lag p99 ms |
| ----------: | ------: | -----: | -----: | -------: | ----: | --------------: |
|           1 |     480 |   33.4 |   61.3 |  115.2 * |    26 |              77 |
|           2 |     480 |   41.9 |   73.1 |   93.6 * |    44 |              36 |
|           4 |     480 |   82.0 |  109.5 |  185.7 * |    47 |              62 |
|           8 |     480 |  158.4 |  180.8 |  237.7 * |    49 |              96 |
|          16 |     480 |  313.5 |  340.9 |  377.8 * |    51 |             280 |
|          32 |     480 |  648.5 | 1118.7 | 1141.2 * |    45 |            1035 |

#### 7. Voice — POST /api/voice/turns (multipart upload, STT + turn + TTS)

Speech providers are mocks. Measures multipart parsing, validation, storage, persistence.

| Concurrency | Samples | p50 ms | p95 ms |  p99 ms | req/s | Loop lag p99 ms |
| ----------: | ------: | -----: | -----: | ------: | ----: | --------------: |
|           1 |     300 |   31.4 |   40.1 |  67.0 * |    30 |              32 |
|           2 |     300 |   53.3 |   74.8 |  94.9 * |    36 |              39 |
|           4 |     300 |  111.2 |  253.3 | 387.5 * |    30 |             157 |
|           8 |     300 |  212.0 |  265.8 | 285.9 * |    37 |             175 |
|          16 |     300 |  417.8 |  468.2 | 487.6 * |    38 |             342 |
|          32 |     300 |  837.5 |  928.8 | 928.9 * |    37 |             852 |

#### 8. Dashboard — GET /api/parent/dashboard/:childId

The heaviest authenticated read: activity, levels, milestones, safety counts, controls.

| Concurrency | Samples | p50 ms | p95 ms | p99 ms | req/s | Loop lag p99 ms |
| ----------: | ------: | -----: | -----: | -----: | ----: | --------------: |
|           1 |     600 |   15.5 |   22.1 |   27.9 |    63 |              13 |
|           2 |     600 |   24.1 |   38.2 |   96.3 |    76 |              49 |
|           4 |     600 |   40.5 |   63.5 |   75.0 |    93 |              31 |
|           8 |     600 |   77.8 |  138.8 |  203.6 |    95 |              90 |
|          16 |     600 |  152.7 |  179.6 |  206.8 |   103 |             155 |
|          32 |     600 |  304.2 |  340.7 |  360.1 |   104 |             287 |

#### 9a. Subscription — GET /api/subscriptions/status (computed entitlement)

Entitlement is derived in SQL on every read rather than cached.

| Concurrency | Samples | p50 ms | p95 ms | p99 ms | req/s | Loop lag p99 ms |
| ----------: | ------: | -----: | -----: | -----: | ----: | --------------: |
|           1 |     600 |   15.4 |   18.0 |   20.1 |    68 |               7 |
|           2 |     600 |   14.6 |   24.3 |   28.0 |   135 |              11 |
|           4 |     600 |   24.8 |   47.9 |   64.4 |   147 |              25 |
|           8 |     600 |   49.3 |   63.3 |   69.2 |   158 |              43 |
|          16 |     600 |   97.4 |  114.0 |  121.6 |   162 |              75 |
|          32 |     600 |  201.3 |  303.2 |  306.8 |   156 |             287 |

#### 9b. Subscription — POST /api/subscriptions/create (a write, unique idempotency key)

Opens a checkout row. A genuine write path under load.

| Concurrency | Samples | p50 ms | p95 ms |  p99 ms | req/s | Loop lag p99 ms |
| ----------: | ------: | -----: | -----: | ------: | ----: | --------------: |
|           1 |     400 |   15.5 |   21.8 |  25.1 * |    64 |              14 |
|           2 |     400 |   18.9 |   28.1 |  33.5 * |   100 |              12 |
|           4 |     400 |   38.9 |   76.9 | 102.8 * |    95 |              35 |
|           8 |     400 |   74.4 |  136.2 | 213.5 * |    98 |              93 |
|          16 |     400 |  145.2 |  176.0 | 211.4 * |   107 |             127 |
|          32 |     400 |  285.8 |  307.9 | 308.1 * |   111 |             230 |

#### 10. Webhooks — POST /api/subscriptions/webhook/mock (signed, unique event id)

HMAC verification, idempotency insert, lifecycle, ledger — one transaction. Sized to stay under the route’s hard-coded 600/minute, which is itself the ceiling.

| Concurrency | Samples | p50 ms | p95 ms |  p99 ms | req/s | Loop lag p99 ms |
| ----------: | ------: | -----: | -----: | ------: | ----: | --------------: |
|           1 |      90 |   15.6 |   18.2 |  23.7 * |    65 |               9 |
|           2 |      90 |   11.2 |   14.3 |  27.2 * |   168 |               6 |
|           4 |      90 |   22.5 |   32.6 |  76.4 * |   155 |              48 |
|           8 |      90 |   44.3 |   56.2 |  57.6 * |   177 |              45 |
|          16 |      90 |   85.3 |   96.2 |  96.3 * |   180 |              79 |
|          32 |      90 |  173.9 |  177.7 | 178.4 * |   181 |             161 |

#### 5b. Conversation turn — with 500 ms of injected provider latency

Our overhead plus the budget’s p50 allocation for the model. Not a vendor measurement.

| Concurrency | Samples | p50 ms | p95 ms |   p99 ms | req/s | Loop lag p99 ms |
| ----------: | ------: | -----: | -----: | -------: | ----: | --------------: |
|           1 |     180 | 1555.4 | 1570.3 | 1576.6 * |     1 |              13 |
|           2 |     180 | 1569.0 | 1579.6 | 1607.5 * |     1 |              17 |
|           4 |     180 | 1577.4 | 1621.8 | 1642.4 * |     3 |              27 |
|           8 |     180 | 1592.5 | 1669.2 | 1744.4 * |     5 |              41 |
|          16 |     180 | 1645.1 | 1957.3 | 2108.3 * |     9 |             108 |
|          32 |     180 | 2282.8 | 3164.9 | 3932.7 * |    12 |             579 |

#### 11. Rate limiting — in-memory limiter on the hot path (NO REDIS EXISTS)

Measures the limiter that is actually deployed. See the report for what this is not.

| Concurrency | Samples | p50 ms | p95 ms | p99 ms | req/s | Loop lag p99 ms |
| ----------: | ------: | -----: | -----: | -----: | ----: | --------------: |
|           1 |     800 |   15.5 |   23.5 |   35.3 |    64 |              16 |
|           2 |     800 |    9.3 |   19.2 |   23.0 |   184 |              10 |
|           4 |     800 |   17.9 |   33.8 |   55.0 |   199 |              23 |
|           8 |     800 |   32.5 |   40.0 |   52.3 |   239 |              17 |
|          16 |     800 |   62.8 |   90.8 |  135.9 |   244 |             103 |
|          32 |     800 |  130.8 |  180.4 |  191.5 |   236 |             115 |

---

## 11. Reproducing this

```bash
pnpm run perf
```

Writes `perf-results.json` and prints every table above. `PERF_SCALE=0.05` and
`PERF_LADDER=1,4` shrink it for a smoke check — never for a reported figure,
since a scaled run cannot produce an honest p99.

Diagnostics behind §3:

```bash
npx tsx tests/performance/analyse.ts
```

```bash
npx tsx tests/performance/interference.ts
```
