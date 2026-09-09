# Security

**Status:** Requirements document for a system not yet built. Nothing described here is implemented, and this document does not assert that any control is in place.
**Scope:** All code, infrastructure, and operational practice in this repository.
**Companions:** [PRIVACY.md](PRIVACY.md) · [docs/CHILD_SAFETY.md](docs/CHILD_SAFETY.md) · [ARCHITECTURE.md](ARCHITECTURE.md)

---

## 1. Threat model

We are not defending a generic SaaS product. The specific reason this system is a target is that it holds recordings and transcripts of children, tied to identifiable families, in a market where that data has real coercive value.

### 1.1 What we are protecting

Ranked by consequence of loss, worst first:

1. **Child voice recordings and conversation transcripts** — irreplaceable, deeply personal, directly identifying, and impossible to rotate.
2. **The link between a child and a family** — name, age, location signal, routine.
3. **Parent account credentials** — the key to everything above.
4. **The safety pipeline's integrity** — an attacker who can degrade safety can reach a child through our own product.
5. **Payment and subscription data.**
6. **Service availability.**

Note the ordering: **availability is last.** We would rather be down than leak.

### 1.2 Adversaries we design against

| Adversary                     | Goal                                                                                      | Primary defences                                                                                                      |
| ----------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Opportunistic attacker        | Any breach, any data, for resale                                                          | Baseline hardening, patching, no exposed surface                                                                      |
| Targeted attacker             | Child data specifically                                                                   | Encryption, minimisation, least privilege, retention limits                                                           |
| **Malicious insider**         | Browse conversations out of curiosity or malice                                           | No standing production data access, break-glass with approval, full audit, encryption keys separated from data access |
| **Adversarial "parent"**      | Create an account to reach a child who is not theirs, or to harvest another family's data | Strict tenant isolation, RLS backstop, no cross-account discovery, no child-to-child surface at all                   |
| **The child's own household** | A hostile family member reading a child's conversations                                   | Acknowledged and unresolved — see [§10](#10-what-we-cannot-defend-against)                                            |
| Prompt-injection attacker     | Subvert the model into unsafe output                                                      | Layered safety, deterministic filters, no tool access from child conversation context                                 |
| Compromised vendor            | Data exfiltration via a provider                                                          | Minimisation before sending, no raw audio retention, contractual controls, port abstraction enabling fast exit        |

### 1.3 Trust boundaries

```
UNTRUSTED  │ mobile app, web client, all client-supplied input
───────────┼──────────────────────────────────────────────────
 SEMI      │ vendor responses (LLM output, STT text, webhooks)   ◀── treated as
           │                                                          hostile input
───────────┼──────────────────────────────────────────────────
 TRUSTED   │ apps/api after authn+authz · database · secret store
```

**Two boundary rules that are easy to get wrong:**

- **The client is never trusted.** Not the app we wrote, not the signed build. Every quota, entitlement, age band, and safety decision is server-side. A client that says "this child is 9 and has a paid plan" is making a request, not a statement of fact.
- **Model and vendor output is input, not truth.** LLM output, STT transcripts, and webhook bodies are all parsed, validated, and constrained exactly like user input. An LLM response is never rendered as HTML, never used to build a query, and never granted tool access from a child conversation context.

---

## 2. Authentication

### 2.1 Parent accounts

| Control          | Requirement                                                                                                                                                 |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Password storage | Argon2id, parameters from `.env.example`, never lowered. Never MD5/SHA/bcrypt-with-low-cost.                                                                |
| Password policy  | Minimum 12 characters, checked against a breached-password corpus. No composition rules, no forced rotation — both are known to produce weaker passwords.   |
| Enumeration      | Registration, login, and reset return indistinguishable responses and timing for existing vs non-existing accounts.                                         |
| Brute force      | Per-account and per-IP rate limits, exponential backoff, lockout with a parent-recoverable path.                                                            |
| MFA              | TOTP, optional at launch, required before any account-wide data export.                                                                                     |
| Sessions         | Access token 15 min. Refresh token 30 d, opaque, hashed at rest, single-use with rotation.                                                                  |
| Refresh reuse    | Reuse of a consumed refresh token **revokes the whole token family** and raises a security event. This is the primary detection for a stolen refresh token. |
| Logout           | Revokes server-side. A token invalidated on the client but live on the server is not a logout.                                                              |

### 2.2 Children do not authenticate

A child has no password, no email, no recovery path, and no independent session. This is a security decision, not a UX simplification: an account for a child creates a recovery flow, and every recovery flow for a child requires collecting more identifying data about that child.

Child mode runs on a **derived session token**: minted by an already-authenticated parent, bound to the device, 60-minute lifetime, instantly revocable, and scoped to conversation endpoints only. Possession of a child session token must not permit reading billing, changing controls, listing other profiles, exporting data, or deleting anything.

### 2.3 The parent gate

The challenge protecting the child→parent mode transition is a **child barrier, not an authentication control**. It stops a 6-year-old, not an adult. Security-relevant actions — billing, data export, deletion, changing safety settings — require the parent's actual session, and destructive ones require re-authentication regardless of the gate.

---

## 3. Authorization

### 3.1 Two independent layers

1. **Application layer (primary).** Every request resolves a principal, and every resource access passes an explicit ownership check. There is no implicit authorization by route shape.
2. **Row Level Security (backstop).** Every table holding parent or child data has RLS enabled, with parent-scoped policies. A missed application check still fails at the database.

These are deliberately redundant. The second layer exists precisely for the day someone forgets the first.

### 3.2 Service-role key discipline

The Supabase service-role key bypasses RLS entirely — it is the single most dangerous credential in the system.

- Normal request traffic uses a **request-scoped connection carrying the parent's identity**, never the service role.
- Service-role use is confined to a short, explicitly enumerated list of system operations that run outside any user request: migrations, retention sweeps, webhook reconciliation, and scheduled reports.
- Every service-role operation is audit-logged with its justification.
- Any new use requires review by someone other than the author.
- The key must never be loadable in any package other than `apps/api`. Introducing it into `packages/`, `services/`, or any client bundle is a build-blocking defect.

### 3.3 Tenant isolation tests are mandatory

Every endpoint touching child data ships with a test asserting that parent A receives a not-found response for parent B's resource — at the API **and** with the application check bypassed, at the database. Isolation that is not tested is isolation that is assumed.

---

## 4. Input handling

- **Validate at the edge, once, with Zod.** Every request body, query, param, and header is schema-validated before a handler runs. Unvalidated input never reaches domain code.
- **Reject, do not coerce.** Silent coercion hides bugs and creates parser-differential vulnerabilities.
- **Parameterised queries only.** String-built SQL is a build-blocking defect.
- **Audio uploads** are constrained on content type, magic bytes, duration, and size, and are re-encoded to a normalised format before any processing.
- **File paths and storage keys** are always server-derived, never client-supplied.
- **Prompt-injection resistance** is not achieved by asking a model nicely. Child input is bounded in length, classified before generation, and the model has no tool access, no network access, and no ability to reveal system prompt content in a child conversation context.

---

## 5. Secrets

**Non-negotiable rules:**

1. No credential, key, token, or connection string is ever committed. Not in a comment, a test fixture, a migration, a screenshot, or a "temporary" branch.
2. `.env` is gitignored permanently. `.env.example` contains placeholders only.
3. Staging and production secrets live in a managed secret store, injected at runtime. They never appear in a file, a CI log, an image layer, or a Slack message.
4. **No fake production credentials.** Realistic-looking dummy keys teach people to ignore secret scanners.
5. Secret scanning runs pre-commit and in CI on the full history.

**If a secret is exposed, it is compromised** — regardless of how briefly, or whether the repository was private. Rotate first, investigate second. Removing the commit is not remediation.

### 5.1 Rotation

| Secret                      | Cadence             | On exposure                                            |
| --------------------------- | ------------------- | ------------------------------------------------------ |
| `AUTH_JWT_SECRET`           | 90 days             | Immediate, all sessions invalidated                    |
| `SUPABASE_SERVICE_ROLE_KEY` | 90 days             | Immediate, incident opened automatically               |
| Provider API keys           | 180 days            | Immediate                                              |
| `ENCRYPTION_KEY_*`          | 365 days, versioned | Immediate re-encryption; old key retained decrypt-only |
| Payment webhook secrets     | 180 days            | Immediate                                              |

Envelope encryption with key IDs (`ENCRYPTION_ACTIVE_KEY_ID`) exists so rotation never requires downtime or a big-bang re-encryption.

---

## 6. Data protection

| Layer             | Control                                                                                                                                                                    |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| In transit        | TLS 1.3 minimum, HSTS with preload, certificate pinning on mobile for the API origin                                                                                       |
| At rest           | Full-disk/database encryption, plus **application-layer encryption** for S3-class data (transcripts, retained audio pointers) so a database dump alone is insufficient     |
| In logs           | Structured redaction, enforced by the logger. Transcript text and child identifiers are never logged at any level — see [docs/LOGGING.md](docs/LOGGING.md)                 |
| In backups        | Encrypted, access-controlled, retention-bounded, restore tested                                                                                                            |
| In non-production | **No production data, ever.** Staging and local use synthetic data only. There is no approved anonymisation path for child voice — it cannot be meaningfully de-identified |

---

## 7. Application hardening

- Security headers on every response: HSTS, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, a restrictive CSP on web, `Referrer-Policy: strict-origin-when-cross-origin`, and a minimal `Permissions-Policy`.
- CORS is an explicit origin allowlist. No wildcard, no origin reflection, in any deployed environment.
- Rate limits are layered: global, per-IP, per-account, and per-endpoint-class, with the strictest limits on auth and upload.
- Responses are minimal by default — no stack traces, no internal identifiers, no vendor error text reaching a client. See [docs/ERROR_HANDLING.md](docs/ERROR_HANDLING.md).
- Dependencies: lockfile committed, `pnpm audit` in CI, automated update PRs, and a minimum release age (`.npmrc`) so a compromised publish has a window to be caught.
- Containers: non-root, minimal base image, no build tooling in the runtime layer, pinned digests, image scanning in CI.

---

## 8. Audit logging

Every security-relevant event is recorded to an **append-only** audit log: authentication outcomes, authorization denials, permission and control changes, data export and deletion, service-role operations, safety escalations, and payment state changes.

Each entry carries actor, action, target, timestamp, request ID, and source context — and **never** the content of what was accessed. An audit log that records the transcript an admin read is a second copy of the transcript.

Retention: 730 days (`RETENTION_AUDIT_LOG_DAYS`). Personnel who can trigger audited actions cannot modify or delete audit records.

---

## 9. Vulnerability reporting

Until a public channel exists, report suspected vulnerabilities privately to the repository owner. Please do not open a public issue.

We commit to: acknowledgement within 3 business days, an assessment within 10, and no legal action against good-faith research that respects user privacy and avoids service degradation. **Do not test against production, and never attempt to access real child data** — ask for a staging account instead.

**Severity and response targets**

| Severity     | Definition                                                         | Target                   |
| ------------ | ------------------------------------------------------------------ | ------------------------ |
| **Critical** | Child data exposure, safety-pipeline bypass, authentication bypass | Immediate; patch in 24 h |
| **High**     | Cross-tenant access, privilege escalation, RCE                     | 72 h                     |
| **Medium**   | Limited-scope disclosure, CSRF, stored XSS                         | 14 days                  |
| **Low**      | Best-practice gaps, defence-in-depth improvements                  | Next cycle               |

---

## 10. What we cannot defend against

Stated explicitly, because a threat model that lists only solved problems is marketing.

- **A hostile adult inside the household.** A parent account holder can read their child's conversations. That is the intended design — parental oversight is a core requirement — and it means the product cannot protect a child from a controlling or abusive parent. This is a genuine, unresolved tension between the safety requirement and the oversight requirement, and it needs a policy answer, not a technical one. Tracked as [Q-07](docs/OPEN_QUESTIONS.md).
- **A determined child bypassing the parent gate.** A 10-year-old who watches a parent type a PIN will get past it. The gate limits blast radius; it does not authenticate.
- **Age misrepresentation.** We cannot verify a child's age, or that the account holder is the parent. Every age-based control rests on a self-declared value.
- **Model non-determinism.** The safety pipeline reduces the probability of an unsafe output. It cannot make it zero. Any claim otherwise is false, and the operational response (review queue, parent visibility, rapid prompt/blocklist iteration) exists precisely because residual risk is permanent.

---

## 11. Compliance status — stated plainly

This document describes **security requirements**. It does not certify compliance with COPPA, GDPR, GDPR-K, Pakistan's data protection regime, SOC 2, ISO 27001, or any other framework.

Compliance requires independent assessment, executed vendor agreements, documented risk analysis, and evidence of operating effectiveness over time. **None of that is produced by writing code**, and no artefact in this repository should be read as achieving it. If a future document, README, or marketing page claims otherwise, treat the claim as a defect and remove it.
