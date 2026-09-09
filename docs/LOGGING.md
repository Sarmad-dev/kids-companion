# Logging Conventions

## 1. The constraint that shapes everything

A log aggregator is a database with weaker access control, longer retention, wider read access, and — in most organisations — no data inventory at all. It is routinely queried by engineers who have no business reading a child's conversation.

> **Therefore: transcript text, raw audio, and child identifiers never enter a log line. At any level. In any environment. Including local development.**

"Just for debugging" is how child data ends up in a third-party SaaS with a three-year retention policy and no deletion path. Local logs get pasted into issues, screenshots, and support tickets.

This is enforced by construction, not by discipline: the logger cannot serialise these fields, `no-console` is a lint error so nothing bypasses the logger, and redaction has a 100 % coverage gate ([TESTING_STANDARDS.md §4](TESTING_STANDARDS.md)).

---

## 2. Structured JSON, via Pino

One line, one event, machine-parseable. No `console.log`, no string interpolation of values into messages.

```jsonc
{
  "level": "info",
  "time": "2026-08-17T09:31:00.123Z",
  "service": "kids-companion-api",
  "version": "1.4.2",
  "env": "production",
  "requestId": "01J8X2K9Q4",
  "traceId": "4bf92f3577b34da6",
  "parentRef": "p_8f3a2b", // pseudonymous, rotating — not the parent ID
  "childRef": "c_1d9e4c", // pseudonymous, rotating — not the child ID
  "msg": "conversation turn completed",
  "event": "conversation.turn.completed",
  "durationMs": 1642,
  "sttMs": 380,
  "llmMs": 610,
  "ttsMs": 340,
  "safetyVerdict": "allowed",
  "costUsd": 0.0031,
}
```

Note what this line contains: everything needed to debug a slow turn, attribute cost, and audit a safety outcome. Note what it does not contain: a single word the child said.

`msg` is a fixed string — never `` `turn for ${childName}` ``. Interpolation destroys aggregation _and_ is the most common way sensitive data reaches a log.

---

## 3. Levels

| Level   | Use                                                                              | Production                       |
| ------- | -------------------------------------------------------------------------------- | -------------------------------- |
| `fatal` | Process cannot continue; exiting                                                 | Pages                            |
| `error` | Operation failed, needs attention                                                | Alerts                           |
| `warn`  | Unexpected but handled — **authorization denials, safety blocks, breaker opens** | Dashboards                       |
| `info`  | Business events worth a permanent record                                         | Retained                         |
| `debug` | Developer detail                                                                 | Off                              |
| `trace` | Very verbose                                                                     | Off, never enabled in production |

**`warn` carries the security signal.** Authorization denials, safety blocks, refresh-token reuse, and rate-limit trips all land here. It is the level a security dashboard watches, which is why it must not be diluted with routine noise.

Rules: a caught-and-handled failure is not `error`. An expected validation failure is not `warn` — it is `debug`. A log at the wrong level trains people to ignore the level.

---

## 4. What must never be logged

| Never                                                 | Log instead                                    |
| ----------------------------------------------------- | ---------------------------------------------- |
| Transcript text, child speech, model output           | `turnLength`, `sttConfidence`, `safetyVerdict` |
| Raw audio, or a URL that resolves to it               | `audioDurationMs`, `audioBytes`                |
| Child name, birth date, interests                     | `childRef`, `ageBand`                          |
| Parent email, name, address                           | `parentRef`                                    |
| Passwords, hashes, tokens, API keys, secrets          | Nothing. Not even a prefix.                    |
| Full `Authorization` headers, cookies, session tokens | `sessionRef`                                   |
| Payment card data                                     | Vendor's token reference                       |
| Full request bodies on personal-data endpoints        | Field names only, never values                 |
| A precise location                                    | Country code                                   |

### 4.1 Pseudonymous references

`childRef` and `parentRef` are salted, rotating hashes — enough to correlate one child's requests within a debugging window, not enough to identify a child from logs alone or to build a persistent profile across months. Rotating the salt bounds how long a log corpus stays linkable.

### 4.2 Redaction is structural

Redaction happens in the logger's serialisers, so passing a forbidden field is a no-op rather than a leak:

```ts
const logger = pino({
  redact: {
    paths: [
      'transcript',
      '*.transcript',
      '*.text',
      '*.utterance',
      '*.audio',
      'password',
      '*.password',
      'token',
      '*.token',
      'authorization',
      'req.headers.authorization',
      'req.headers.cookie',
      'childName',
      '*.childName',
      'email',
      '*.email',
    ],
    censor: '[REDACTED]',
  },
});
```

Path-based redaction alone is not enough — it misses a field named something unforeseen. Domain objects therefore define their own log serialisers that **allowlist** what may be emitted, so a new field on `ChildProfile` is invisible to logs until someone deliberately adds it.

Allowlist, not blocklist. A blocklist fails open on every field nobody thought of, and this is a domain where failing open means a child's data in a SaaS dashboard.

---

## 5. Mandatory context

Every line: `service`, `version`, `env`, `level`, `time`, `msg`.
Every request-scoped line: `requestId`, `traceId`.
Every child-scoped line: `childRef`, `ageBand`. **Never `childId`, never a name.**

`requestId` propagates from the client header ([API_CONVENTIONS.md §3](API_CONVENTIONS.md)) through every log line, every downstream call, and the error response. A parent's support email quotes it, and it resolves to a full trace without anyone reading a transcript.

---

## 6. Event naming

`domain.entity.action`, past tense, in an `event` field distinct from the human-readable `msg`:

```
auth.session.created
auth.refresh.reuse_detected
child.profile.created
conversation.turn.completed
conversation.turn.blocked
safety.escalation.raised
payment.subscription.activated
privacy.export.completed
privacy.deletion.completed
retention.sweep.completed
```

Stable names are what make a dashboard survive a refactor.

---

## 7. What to log at each stage of the voice loop

One line per completed turn, with a duration per stage — not a line per stage, which multiplies volume by eight for no analytical gain.

Errors log at the point of failure with the stage named. `safety.turn.blocked` always logs at `warn` with the layer and verdict, and never the content that triggered it. The review queue holds content, under access control, with retention — a log line does not.

---

## 8. Audit log vs application log

Different systems. Do not conflate them.

|             | Application log       | Audit log                                                           |
| ----------- | --------------------- | ------------------------------------------------------------------- |
| Purpose     | Debugging, operations | Accountability                                                      |
| Storage     | Log aggregator        | Append-only Postgres table                                          |
| Mutable     | Rotated, dropped      | **Never**                                                           |
| Retention   | 30 days               | 730 days                                                            |
| Failure     | Log and continue      | **Fails the operation** ([ERROR_HANDLING.md §9](ERROR_HANDLING.md)) |
| Read access | Engineers             | Restricted, and itself audited                                      |

The audit log records actor, action, target, and outcome — **never content**. An audit entry saying an admin read a transcript must not contain the transcript, or the audit log becomes a second, less-protected copy of the thing it exists to protect.

---

## 9. Operational

- **Sampling:** errors and warnings, never. High-volume info, sampled with the rate recorded on the line.
- **No PII in metric labels or trace attributes.** Cardinality and privacy fail together — never a child ID as a label.
- **Log retention: 30 days**, shorter than transcript retention on purpose. Logs are the least controlled store, so they hold the least for the shortest time.
- **Local development follows the same rules.** Pretty-printed, more verbose, same redaction. A logger that redacts only in production has never been tested.

---

## 10. Reviewer's checklist

- Could this line contain something a child said? → Remove it.
- Is a value interpolated into `msg`? → Move it to a field.
- Would I be comfortable with this line in a vendor dashboard read by someone I have never met? → If not, it does not ship.
