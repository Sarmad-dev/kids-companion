# API Conventions

Applies to `apps/api`. Every rule here is enforceable in review, and most are enforced by Fastify's schema layer.

---

## 1. Shape

REST over HTTPS, JSON in and out. Resource-oriented, versioned in the path.

```
https://api.kidscompanion.app/v1/children/{childId}/conversations
```

**Versioning.** `/v1` from the first endpoint. Adding a version prefix later is a migration; having one from the start costs a folder name. A breaking change means `/v2` and a documented deprecation window — never a silent change to `/v1`, because a mobile app on a two-year-old install will still be calling it.

### 1.1 The `/api` prefix on conversations ⚠️

The conversation endpoints are mounted under `/api`, not `/v1`:

```
POST /api/conversations/start
POST /api/conversations/{id}/message
GET  /api/conversations/{id}
POST /api/conversations/{id}/end
GET  /api/conversations?childId={childId}
```

This came from the product specification and it is **inconsistent with the rest of this service**, which is under `/v1`. It is recorded here rather than quietly resolved in one direction, because both fixes cost something and the choice belongs to whoever owns the client contract:

- Move conversations to `/v1/conversations/…` — consistent, and it discards a specification that clients may already have been written against.
- Move everything else to `/api/v1/…` — consistent, and it is a breaking change to five route families to make one of them fit.

Until that is decided, `/api` carries no version, which means the versioning guarantee above does not apply to it. **That is the real cost of leaving this open**, and it is the reason this needs a decision before a client ships against these paths rather than after.

### 1.2 Conversation limits and quotas

Two things are worth knowing about how the conversation endpoints refuse work.

**A reached limit is a 429 at `/start` and a 200 at `/message`.** That is deliberate, not an inconsistency. Nobody is listening when a session is created, so the client gets the machine-readable form and can decide between "upgrade" and "come back tomorrow". A child IS listening on `/message`, and a raw error there surfaces to a five-year-old as a broken app — so the turn returns `status: "ended"` with a warm goodbye, and the same facts travel in the `limits` block ([ERROR_HANDLING.md §10](ERROR_HANDLING.md)).

**Quota and subscription errors carry a `meta` object.** Error bodies otherwise expose only `code`, `message`, `requestId`, and `details`. `meta` is an explicit opt-in for facts a client is meant to read — the limit, what was used, when it resets — and is set per error constructor rather than by default, so exposing anything through it is a decision someone made.

### 1.3 Conversation mode

`POST /api/conversations/start` takes an optional `mode`, either `chat` (the
default) or `story`. It is echoed on every conversation body.

The mode is not cosmetic. It changes the system prompt, it is what the plan's
weekly story limit counts, and finishing a story session is what records a story
on the parent's progress screen. Two refusals are specific to it:

| Situation                                            | Response                                              |
| ---------------------------------------------------- | ----------------------------------------------------- |
| The parent has turned storytelling off for the child | `400 VALIDATION_FAILED` on `mode`                     |
| The weekly story allowance is spent                  | `429 QUOTA_WEEKLY_STORIES_EXHAUSTED`, with `resetsAt` |

Omitting `mode` is always safe: a client that predates it gets exactly the
behaviour it had before.

```json
{
  "error": {
    "code": "QUOTA_DAILY_TURNS_EXHAUSTED",
    "message": "This limit has been reached.",
    "requestId": "…",
    "meta": { "limit": 20, "used": 20, "plan": "free", "resetsAt": "…" }
  }
}
```

Limits themselves live in `subscription_plans`, not in application constants, so "why was my child cut off?" has one answer a support engineer can read. See [DATA_MODEL.md](DATA_MODEL.md) for the entitlement resolution and the `usage_daily` ledger.

---

## 2. Resources and methods

Plural nouns. No verbs in paths.

```
✗ POST /v1/getChildProfile
✗ POST /v1/child/create
✓ GET  /v1/children/{childId}
✓ POST /v1/children
```

| Method   | Meaning                                         | Idempotent |
| -------- | ----------------------------------------------- | ---------- |
| `GET`    | Read. Never has side effects, never has a body. | Yes        |
| `POST`   | Create, or a genuine action                     | No         |
| `PATCH`  | Partial update. Absent field = unchanged.       | Yes        |
| `PUT`    | Full replacement. Rare — prefer PATCH.          | Yes        |
| `DELETE` | Remove                                          | Yes        |

`PATCH` semantics matter here because of `exactOptionalPropertyTypes`: an **absent** field means "leave it alone", an **explicit `null`** means "clear it". Conflating them means a parent editing a nickname silently wipes a language preference.

### 2.1 Actions that are not CRUD

Some operations genuinely are not resources. Use a sub-resource with a verb noun, and keep it rare:

```
POST /v1/children/{childId}/conversations/{id}/turns
POST /v1/auth/refresh
POST /v1/parents/me/data-exports
```

---

## 3. Requests

- `Content-Type: application/json`, except audio upload (`multipart/form-data` or a direct binary body).
- Every request carries `X-Request-Id` (client-generated UUIDv4) or the server mints one. It appears in every log line and every error response — it is how a parent's support email becomes a trace.
- `Idempotency-Key` is **required** on every non-idempotent, side-effectful POST: turn creation, subscription changes, payment operations. On a flaky Pakistani mobile connection, retries are not an edge case — they are Tuesday. A duplicate key returns the original result without re-executing.

### 3.1 Validation

Every body, query, param, and header is validated by a Zod schema from `@kids/validation`, converted to JSON Schema and attached to the route. Fastify rejects a malformed request before a handler runs.

**One schema, three jobs**: runtime validation at the edge, static types in the handler, and the OpenAPI document. There is no second definition to drift.

**Reject, do not coerce.** `"age": "5"` is a client bug and gets a 400. Silent coercion hides bugs and, across parsers, creates real vulnerabilities.

### 3.2 Response serialisation

Every route declares a response schema, and Fastify serialises through it. This is a **security control, not a performance trick**: a field not in the schema cannot be emitted, so a stray `password_hash` or `internal_notes` on an entity cannot leak by accident. Given this system's data classes, that guarantee is worth more than the speed it also happens to deliver.

---

## 4. Responses

### 4.1 Success

Return the resource directly. No envelope — HTTP already carries status and metadata.

```json
{
  "id": "chp_01J8X2K9",
  "displayName": "Ayesha",
  "ageBand": "emerging",
  "languages": ["ur", "en"],
  "createdAt": "2026-08-17T09:31:00.000Z"
}
```

`camelCase` in JSON, `snake_case` in the database. The mapping happens in one place, in the repository layer.

Timestamps are RFC 3339 UTC with milliseconds. Durations are integers with a unit suffix in the field name (`ttlSeconds`). Money is an integer minor unit plus a currency code — never a float:

```json
{ "amount": 49900, "currency": "PKR" }
```

### 4.2 Collections

```json
{
  "items": [...],
  "nextCursor": "eyJpZCI6ImN2XzAxSjhY"
}
```

Cursor pagination, not offset. Offset pagination skips and duplicates rows when the underlying data changes between pages — which it constantly does for a live conversation list. `nextCursor` is `null` on the last page. Default limit 20, maximum 100.

### 4.3 Status codes

| Code    | Use                                    |
| ------- | -------------------------------------- |
| 200     | OK                                     |
| 201     | Created — with a `Location` header     |
| 204     | No content (DELETE)                    |
| 400     | Malformed or schema-invalid            |
| 401     | Missing or invalid credentials         |
| 403     | Authenticated, not permitted           |
| **404** | Not found **or not yours** — see below |
| 409     | Conflict                               |
| 422     | Well-formed but semantically invalid   |
| 429     | Rate limited — with `Retry-After`      |
| 500     | Our fault                              |
| 503     | Dependency unavailable                 |

**404, not 403, for another tenant's resource.** A 403 confirms the resource exists. Given that the resources here are children, confirming existence to an unauthorised caller is itself a disclosure. Parent A asking for parent B's child gets a 404, always.

---

## 5. Errors

One shape, everywhere. Full taxonomy in [ERROR_HANDLING.md](ERROR_HANDLING.md).

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "The request could not be processed.",
    "requestId": "01J8X2K9Q4",
    "details": [{ "field": "birthYear", "issue": "must be between 2015 and 2023" }]
  }
}
```

- `code` is a stable SCREAMING_SNAKE string clients may branch on. `message` is human-readable and may change; clients must not parse it.
- **Never leak internals**: no stack traces, no SQL, no vendor error text, no internal IDs.
- `details` appears only for validation errors, and never echoes a sensitive value back.
- `requestId` is always present — it is the entire support workflow.

### 5.1 Errors a child might see

An error reaching child mode is translated into character behaviour by the client. The API's job is to make that possible: every error carries a `code` the app can map to a scripted, age-appropriate line. A child never sees a message the API wrote.

---

## 6. Authentication

```
Authorization: Bearer <access-token>
```

- Access token: JWT, 15 minutes, verified locally.
- Refresh token: opaque, rotating, sent to `POST /v1/auth/refresh` only. Never in a URL, never in a query string, never logged.
- Child-mode requests carry a **child session token** obtained from `POST /v1/child-sessions`. It is scoped to conversation endpoints; presenting it anywhere else is a 403, and that attempt is a security event worth logging.

A `401` includes `WWW-Authenticate` so the client knows to refresh rather than to prompt for a password.

---

## 7. Rate limiting

Every response on a limited route carries:

```
RateLimit-Limit: 30
RateLimit-Remaining: 27
RateLimit-Reset: 42
```

Limits are layered — global, per-IP, per-account, per-endpoint-class — with the strictest on auth and upload. A 429 includes `Retry-After`.

Rate limiting has a child-safety dimension as well as an abuse one: an unbounded conversation loop is both a runaway bill (C3) and a child who has been talking to a screen for four hours. Session-length limits are a product feature, not just a quota.

---

## 8. Long-running work

Anything that cannot finish inside the request budget — data export, report generation, batch transcript processing — returns `202 Accepted` with a job resource:

```json
{ "jobId": "job_01J8X2", "status": "pending", "pollAfterSeconds": 5 }
```

The client polls `GET /v1/jobs/{jobId}`. Results are delivered over an authenticated, expiring link — never as a public URL, and never emailed as an attachment.

---

## 9. Documentation

OpenAPI 3.1 is generated from the route schemas, never hand-written — a hand-written spec is wrong within a month. It is published at `/v1/openapi.json` and served as a browsable page in non-production environments only.

Every endpoint documents: purpose, auth requirement, rate limit class, error codes, and — where it touches personal data — the data classes involved and their retention. That last field is unusual, and it is there so a privacy reviewer can read the API surface and see the data flows without reading the implementation.

---

## 10. Health endpoints

| Route             | Purpose                                               | Auth |
| ----------------- | ----------------------------------------------------- | ---- |
| `GET /health`     | Process is alive. Never touches a dependency.         | None |
| `GET /ready`      | Dependencies reachable. Drives load-balancer routing. | None |
| `GET /v1/version` | Build SHA and version                                 | None |

`/health` must not check the database. A liveness probe that fails on a slow query restarts a healthy process during exactly the incident where restarts hurt most.
