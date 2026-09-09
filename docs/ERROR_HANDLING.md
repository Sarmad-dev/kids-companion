# Error Handling Conventions

## 1. Three audiences, one error

Every failure in this system is read by three parties with incompatible needs:

| Audience        | Needs                                         | Must never see                                                  |
| --------------- | --------------------------------------------- | --------------------------------------------------------------- |
| **A child**     | A character that reacts warmly and moves on   | Any error at all — no text, no code, no spinner that never ends |
| **A parent**    | Plain language, and what to do next           | Internal detail, jargon, blame                                  |
| **An engineer** | Everything: cause, context, stack, request ID | —                                                               |

An error object therefore carries an internal representation and a client-safe projection, and the two never merge. Most error-handling bugs in production systems are one leaking into the other.

---

## 2. Expected failures are values; unexpected failures are exceptions

**Expected failures** — a quota exhausted, a safety block, a not-found — are part of the domain. They are modelled as return values:

```ts
type Result<T, E = AppError> = { ok: true; value: T } | { ok: false; error: E };
```

This makes the failure visible in the type, so a caller cannot forget it exists. A safety block is not exceptional; it is the pipeline working.

**Unexpected failures** — a database that vanished, a bug, an invariant violation — throw. They travel to the error boundary, are logged with full context, and become a generic 500. There is no value in a caller handling "the invariant is broken".

The line: _if a reasonable caller might do something specific about it, it is a value._

---

## 3. The error taxonomy

Every error is an `AppError` with a stable `code`, a category, an HTTP status, and a retryability flag. Defined once in `@kids/shared`.

```ts
class AppError extends Error {
  readonly code: AppErrorCode;
  readonly category: ErrorCategory;
  readonly httpStatus: number;
  readonly isRetryable: boolean;
  readonly context: Readonly<Record<string, unknown>>; // never sensitive
  readonly cause?: unknown;
}
```

| Category         | Meaning                         | Status                    | Log level |
| ---------------- | ------------------------------- | ------------------------- | --------- |
| `validation`     | Client sent something malformed | 400/422                   | debug     |
| `authentication` | Who are you                     | 401                       | info      |
| `authorization`  | Not yours                       | 403/**404**               | **warn**  |
| `not_found`      | Does not exist                  | 404                       | debug     |
| `conflict`       | State collision                 | 409                       | info      |
| `quota`          | Limit reached                   | 429                       | info      |
| `safety`         | Blocked by the safety pipeline  | 200 with a blocked result | **warn**  |
| `provider`       | An external vendor failed       | 502/503                   | error     |
| `internal`       | Our bug                         | 500                       | error     |

Two rows are deliberately unusual:

**`authorization` logs at warn, not debug.** A parent hitting another parent's resource is either a client bug or an attack. Either way, someone should be able to see the rate of it.

**`safety` returns 200, not an error status.** A blocked turn is a successful request with a blocked outcome. Returning a 4xx would make safety blocks indistinguishable from client bugs in every dashboard, and would push clients toward retrying them.

---

## 4. Codes are contracts

```ts
export const APP_ERROR_CODES = [
  'VALIDATION_FAILED',
  'AUTH_INVALID_CREDENTIALS',
  'AUTH_TOKEN_EXPIRED',
  'AUTH_REFRESH_REUSE_DETECTED',
  'AUTHZ_FORBIDDEN',
  'RESOURCE_NOT_FOUND',
  'QUOTA_DAILY_MINUTES_EXHAUSTED',
  'QUOTA_CHILD_PROFILE_LIMIT',
  'SAFETY_INPUT_BLOCKED',
  'SAFETY_OUTPUT_BLOCKED',
  'SAFETY_CLASSIFIER_UNAVAILABLE',
  'PROVIDER_TIMEOUT',
  'PROVIDER_RATE_LIMITED',
  'PROVIDER_UNAVAILABLE',
  'INTERNAL_ERROR',
] as const;
```

Clients branch on `code`, never on `message`. Once shipped, a code's meaning cannot change — a mobile app from eighteen months ago is still branching on it.

---

## 5. Never leak internals

The client-safe projection contains exactly: `code`, a safe `message`, `requestId`, and — for validation only — field-level `details`.

Never crossing the boundary: stack traces, SQL, vendor error text, internal IDs, file paths, configuration values, or any personal data. This applies to the `context` field too — context is for logs, and even there it is redacted ([LOGGING.md](LOGGING.md)).

```ts
// ✗ hands the attacker a map, and the parent nothing useful
{ "error": "duplicate key value violates unique constraint \"uq_parents_email\"" }

// ✓
{ "error": { "code": "CONFLICT_EMAIL_IN_USE",
             "message": "That email is already registered.",
             "requestId": "01J8X2K9Q4" } }
```

Even that example needs care: on registration, confirming an email exists is account enumeration. The registration flow returns an identical response either way and resolves the conflict by email — a case where the _most informative_ error is the wrong one.

---

## 6. Wrapping, not swallowing

Preserve the chain with `cause`. Every adapter maps vendor errors into the taxonomy at its boundary:

```ts
catch (err) {
  throw new AppError({
    code: 'PROVIDER_TIMEOUT',
    category: 'provider',
    context: { provider: 'deepgram', operation: 'transcribe', attemptMs: elapsed },
    cause: err,
  });
}
```

Never `catch {}`. An empty catch discards the evidence you will need at 3 a.m. If a failure is genuinely ignorable, log at debug and say why in a comment.

---

## 7. Retries

Retry only what is retryable: timeouts, 5xx, connection resets, and 429 with `Retry-After`. Never retry a 4xx that is not a 429 — the answer will not change.

Exponential backoff with full jitter. Without jitter, every client that failed together retries together, and the recovering service is knocked over by its own users.

**Retry budgets, not retry counts.** The voice loop has a total time budget ([ARCHITECTURE.md §7](../ARCHITECTURE.md)); a retry that would exceed the remaining budget is not attempted. Three dutiful retries that deliver an answer nine seconds later is a worse outcome than failing fast into a graceful exit — the child has already left.

Non-idempotent operations retry only under an `Idempotency-Key` ([API_CONVENTIONS.md §3](API_CONVENTIONS.md)).

---

## 8. Circuit breakers

Each provider adapter has a breaker. Open after a failure threshold, half-open probe after a cooldown, closed on success. A hard-down vendor should cost one fast failure per interval, not a full timeout on every request while children wait.

Breaker state changes are logged and alerted — an open breaker is the earliest signal of a vendor incident.

---

## 9. Fail closed on safety, fail open on convenience

The single most important rule here.

| Component fails       | Behaviour                                                                        |
| --------------------- | -------------------------------------------------------------------------------- |
| **Safety classifier** | **Block the turn.** Always. There is no configuration that changes this.         |
| Analytics             | Continue silently                                                                |
| TTS cache             | Continue, synthesise fresh                                                       |
| Metrics               | Continue                                                                         |
| Quota counter (Redis) | Fall back to a conservative Postgres read                                        |
| Audit log write       | **Fail the operation.** An unauditable security-relevant action does not happen. |

The generalisation: **failures that could harm a child, or lose accountability, fail closed. Failures that only degrade convenience fail open.**

---

## 10. What the child sees

No error reaches a child as an error. Every failure maps to character behaviour:

| Internal                        | Character does                                                                           |
| ------------------------------- | ---------------------------------------------------------------------------------------- |
| `SAFETY_INPUT_BLOCKED`          | Redirects warmly: "Ooh — let's talk about something else! What's your favourite animal?" |
| `SAFETY_OUTPUT_BLOCKED`         | Same class of redirect; the child never learns a block occurred                          |
| `PROVIDER_TIMEOUT` (STT)        | Cups an ear: "I didn't quite catch that — say it again?"                                 |
| `PROVIDER_UNAVAILABLE` (LLM)    | Yawns: "I'm feeling sleepy — can we play later?" then a gentle exit                      |
| `QUOTA_DAILY_MINUTES_EXHAUSTED` | Warm goodbye, and a **parent-facing** notice about the limit                             |
| `INTERNAL_ERROR`                | Generic gentle exit                                                                      |

Three rules that follow from this:

1. **The redirect text ships in the app bundle.** It must work when the network does not, and it must not itself require a model call.
2. **Blocks are never announced to the child.** "I can't talk about that" teaches a child what the boundary is and invites probing. A warm change of subject does not.
3. **A parent always sees what the child did not.** Blocks and repeated failures appear in the dashboard. The child gets a smooth experience; the parent gets the truth.

---

## 11. The error boundary

One handler in `apps/api`, at the framework level. It:

1. Assigns the request ID if absent.
2. Normalises anything thrown into an `AppError` (an unrecognised throw becomes `INTERNAL_ERROR`).
3. Logs at the category's level, with redacted context and the full cause chain.
4. Emits a metric tagged by code and category.
5. Serialises the client-safe projection.

Handlers do not format errors themselves. One place, one shape — which is also what makes the "never leak internals" rule auditable rather than aspirational.

Uncaught exceptions and unhandled rejections are logged and then **exit the process**. A Node process with a broken invariant should be replaced, not nursed — and `no-floating-promises` exists so this path stays theoretical.
