# Analytics and observability

Two pipelines that look similar and are governed by opposite rules.

---

## 1. The rule everything follows

> **Privacy requirements override analytics requirements.**

Not as a principle to weigh against others — as the thing that decides the
architecture. Concretely:

- **No child-scoped event ever leaves this system.** Not pseudonymously, not
  aggregated, not at all. `sanitiseEvent` refuses it.
- **No metric label may carry an identifier.** `assertLabelsAreDimensions`
  throws, and the route label is the pattern (`/api/parent/dashboard/:childId`),
  never the URL.
- **Product questions about children are answered from aggregates in our own
  database**, computed by SQL functions that return counts and ratios and
  cannot return a row per person.
- **Analytics is off by default.** `ANALYTICS_ENABLED=false` ships the no-op
  provider. The burden is on whoever wants the data.

---

## 2. Two destinations, not equally trusted

|                          | Internal                     | External             |
| ------------------------ | ---------------------------- | -------------------- |
| Where                    | our `analytics_events` table | a third-party vendor |
| Retention                | our sweep, 395 days          | theirs               |
| Deleted with the account | yes                          | not reliably         |
| Child-scoped events      | permitted                    | **never**            |
| Account-scoped events    | permitted                    | permitted            |

A parent consented to their child talking to a character in our product. They
did not consent to a behavioural record of that child accumulating at a vendor
under that vendor's policy.

What a third party may receive is the parent-facing commercial funnel — an
account was created, a plan was viewed, a subscription started. Facts about a
customer, which is what product analytics is actually for.

### The event catalogue is an allow-list

An event not in `EVENT_CATALOGUE` is refused. Every entry carries a stated
purpose and the exact properties it may hold, so shipping a new one is a
decision somebody makes on purpose.

`sanitiseEvent` applies five rules in order, and each **refuses** rather than
redacting — a silently redacted event is one nobody notices is wrong until a
dashboard built on it is empty:

1. the event is in the catalogue,
2. the destination is permitted for its scope,
3. the subject is a pseudonym, not a raw id,
4. every property is declared,
5. no property **value** is an identifier or free text.

Rule 5 is the one that earns its keep. `reason` is a perfectly reasonable
declared property, and it is where a child's sentence ends up.

---

## 3. Never collected

- Session replay or screen recording.
- Device fingerprinting, and no advertising identifier.
- Any cross-application identity graph.
- A per-message or per-utterance event stream.
- Anything a child said, or how well they said it.
- Precise location — country at most, and only for the account.

Each of these is unremarkable in a consumer app and inappropriate in one used by
five-year-olds.

---

## 4. Technical metrics

`GET /metrics`, Prometheus text format, outside `/api` because it is
infrastructure rather than product surface.

Response time with p50/p95/p99, request volume, error rate, CPU, memory, event
loop lag, database connections, AI quota, queue size, and storage — the full
list is `TECHNICAL_METRICS`.

Three decisions worth knowing:

- **Percentiles use nearest rank, not interpolation.** An interpolated p99
  reports a latency no request experienced, and somebody chasing a slow endpoint
  wants a real number.
- **The histogram reservoir is bounded** (a ring, biased toward recent
  observations) but **count and sum are exact for all time** — an average that
  quietly covered only the last 2,048 requests would be a different number from
  the one anyone expects.
- **4xx is volume, not error.** A client being told no is the system working;
  counting it as an error makes the error rate a measure of how many people
  mistype a password.

### Why in-process rather than a vendor SDK

A metrics client is a long-lived process that batches data to a third party.
This application handles children's conversations, and the only feature we
actually need is a histogram.

---

## 5. Structured logging and request ids

Both already existed and are unchanged: `createLogger` emits JSON, every request
gets an id (`x-request-id`, echoed in error bodies so a parent can quote it),
and `redactObject` strips sensitive paths before anything is written.

Error tracking is the existing error boundary — an `AppError` taxonomy with a
per-category log level, a request id on every failure, and no stack or internal
hostname in any client-facing body.

---

## 6. Alerts

Five conditions, not fifty. An alert that fires often is one nobody reads, and a
paging system nobody reads converts a real outage into a notification somebody
swipes away at 2 a.m. Every entry answers: **would a person have to get out of
bed for this?**

| Condition         | Severity | Fires on                                |
| ----------------- | -------- | --------------------------------------- |
| `safety_pipeline` | critical | the **first** occurrence                |
| `error_rate`      | critical | ≥5% of requests failing, min 50 samples |
| `latency`         | warning  | p99 ≥ 10s                               |
| `database`        | critical | unreachable                             |
| `ai_provider`     | critical | 5 consecutive failures                  |

**`safety_pipeline` is the one that matters most.** Every other condition means
the product is down. That one means the product is **up and unsafe** — children
are talking and the layer that checks what reaches them is not working. One
occurrence is enough.

Each condition has a producer, and they are worth naming because for a long
time three of them had none:

| Condition         | Reported by                                                   |
| ----------------- | ------------------------------------------------------------- |
| `safety_pipeline` | every conversation and voice turn (`turn-health.ts`)          |
| `ai_provider`     | the same, on a provider timeout or outage                     |
| `database`        | the readiness probe, which already runs against the real pool |
| `error_rate`      | the metrics registry, on the evaluation timer                 |
| `latency`         | the same                                                      |

**A blocked turn is not a safety failure.** It is the pipeline working: a rule
fired and a reply was stopped. The failure is `safety_unavailable` — the
classifier could not be reached, so the pipeline failed closed and children are
hitting a wall mid-conversation.

### 6.1 Where an alert goes

`ALERT_WEBHOOK_URL` is **required in production**. Without it every alert is a
`fatal` log line that something else would have to notice.

The log line is written either way and is never removed: every deployment
already ships logs somewhere, and an alerting path with a network dependency
fails exactly when it is needed. The webhook is layered on top of it, not
substituted for it — if the post fails, the alert is still recorded.

`ALERT_WEBHOOK_FORMAT` selects the body:

- `generic` — a JSON object (`event`, `condition`, `severity`, `summary`,
  `observed`). Point an Alertmanager receiver, an Opsgenie custom webhook, or
  anything in-house at it.
- `slack` — the incoming-webhook `text` shape, which Mattermost and others also
  accept.

Three attempts, briefly spaced, then it gives up and the log line stands alone.
A 4xx other than 429 is not retried. **The URL is a credential** — a Slack
incoming-webhook URL lets anyone holding it post into the channel — so it is
never written to a log, never included in an error message, and never placed in
an alert body.

An alert body carries the condition, the severity, and the measurement that
tripped it. **It never carries conversation content.**

### 6.2 Firing, and stopping

An alert already firing is not re-delivered — a condition that pages every
minute is one that gets muted.

It clears when the measurement recovers, or when nothing has reported it for
`reArmAfterMs` (15 minutes), and **a resolution is delivered when it does**.
That window exists because `safety_pipeline` and `database` are only ever told
about failures: with no way to clear them and no re-delivery, they fired once
per process and then went silent for good.

---

## 7. Error tracking

`ERROR_TRACKING_PROVIDER` is **required in production** and must not be `none`.
Three values: `none` (aggregate in process, send nothing), `sentry` (needs
`SENTRY_DSN`), `webhook` (needs `ERROR_TRACKING_WEBHOOK_URL`). A provider named
without its destination is refused at boot in every environment.

### 7.1 There is no Sentry SDK, on purpose

**This is the most important thing on this page.**

An error tracker's default integrations exist to capture as much surrounding
context as they can: request bodies, headers, cookies, query strings,
breadcrumbs, sometimes local variables. That is a good default for most products
and a catastrophic one here, because **the request body on the busiest route in
this application is a child speaking**.

So the Sentry envelope is written by hand, the same way `probeRedis` speaks RESP
without a Redis client. Every field on the event is placed there deliberately,
which is what makes the privacy assertion testable rather than aspirational.

| Sent                                  | Never sent                                       |
| ------------------------------------- | ------------------------------------------------ |
| error type, scrubbed message          | the request body, query string, headers, cookies |
| our own stack frames, basenames only  | the child's utterance or the model's reply       |
| the route **pattern**, method, status | any child, parent, or conversation id            |
| release, environment, counts          | any name                                         |

### 7.2 Scrubbing

Our own `AppError` messages are fixed strings and safe by construction. The
dangerous ones are the errors we did not write — a driver quoting the row it
choked on, a validator echoing the value it rejected, a provider returning the
prompt inside its complaint. Any of those can contain a child's words.

So a message is stripped of quoted strings, emails, uuids, long tokens and
numbers, then capped at 200 characters. A message that loses its meaning to that
was carrying data, which is the trade we want.

### 7.3 Grouping and volume

The fingerprint is `type | scrubbed message | innermost own frame`. Scrubbing is
what makes it work as deduplication: "row 41" and "row 87" are one bug. The same
message thrown from two different places stays two bugs.

The first occurrence of a fingerprint is sent immediately. After that the same
fingerprint is sent at most once per `ERROR_TRACKING_RESEND_AFTER_MS` (5 min),
with its count — a failure repeating a thousand times a minute is still one bug,
and forwarding each occurrence turns our incident into the tracker's incident.

**Only 5xx is captured.** A 400 is a caller's mistake, a 429 is a limit working,
a 404 is a client asking for something absent. None is a bug in this
application, and anyone able to send a malformed body could otherwise fill the
tracker on demand.

### 7.4 A new error type does not page

The readiness review asked for an alert on a new error type. There deliberately
is not one, and that is a refusal rather than an omission.

The alert list answers one question — would a person have to get out of bed for
this? — and a first sighting of an error type does not. The first deploy after a
release would page a dozen times, and a channel that cries wolf on release day
is muted before the failure that mattered arrives.

Instead a new type gets a distinct `warn` line with `control: error_tracking`
(alert on it in your own log platform if you want to) and a `newSinceBoot` count
on `GET /api/admin/health/detailed`. Volume is already covered: a new error that
actually matters shows up in `error_rate`, which does page.

---

## 8. Product metrics

`GET /api/admin/metrics/product`, staff-only (`audit:read`), every figure an
aggregate computed by SQL in our own database.

Activation funnel · conversation completion and duration · feature adoption ·
weekly retention cohorts · subscription conversion · churn · MRR · ARR.

Two details worth checking if you change them:

- **MRR normalises every billing interval to a month** — weekly × 52/12, yearly
  ÷ 12. Counting a yearly plan at full price is the classic SaaS reporting
  error: MRR jumps twelvefold the month it sells and collapses the month after.
- **Voluntary and involuntary churn are separate.** A cancellation is a product
  problem; an expiry after a failed payment is a payments problem. Conflating
  them hides a broken rail behind "churn".

There is deliberately **no engagement score** — a number that would invite
someone to optimise how long a child stays in the app, which is the opposite of
what this product is for.

---

## 9. Known limitations

- **Tracing is declared and unread.** `OTEL_EXPORTER_OTLP_ENDPOINT` is a
  configuration key with no exporter behind it.
- **Error aggregation is per process.** Each instance keeps its own map, so
  the operator console shows the instance that answered. The configured
  provider is what aggregates across a fleet.
- **`ai_quota_remaining`, `queue_size`, and `storage_bytes` are registered but
  not yet populated** — the providers that would report them do not expose the
  figures today. They render as empty series rather than as zeros, which is the
  honest state.
- **Database connection gauges are not wired** to the PGlite test adapter, so
  they are empty in tests.
- **No external analytics provider is implemented.** The port and the gate
  exist; `ANALYTICS_PROVIDER` accepts `posthog` in configuration and nothing
  implements it. Adding one is a provider that receives already-sanitised
  account-scoped events.
- **Retention is weekly cohorts only.** No daily or monthly rollup.
