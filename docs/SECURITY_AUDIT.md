# Security audit

**Date:** 2026-08-21 · **Build:** `main` at the analytics phase · **Auditor:**
engineering, self-assessed

---

## Read this before the findings

> **This application is not certified secure, and this document does not claim
> it is.**

What follows is an internal review by the people who wrote the code, plus 49
automated tests that attempt specific attacks. Both have a known and serious
weakness: **we can only test for the flaws we thought of.** The vulnerability
that matters is usually the one nobody modelled.

Specifically, a passing suite here is _evidence_, not assurance:

- It proves twelve named attacks failed against this build, in this environment.
- It proves nothing about attacks nobody wrote.
- No independent party has reviewed this. No penetration test has been
  commissioned. No third-party code review has taken place.

**A product handling children's conversations should have an external security
assessment before it handles a real child's conversation.** That has not
happened, and nothing in this document substitutes for it.

---

## 1. Findings

| #    | Issue                                              | Severity                       | Component                                  | Status       |
| ---- | -------------------------------------------------- | ------------------------------ | ------------------------------------------ | ------------ |
| F-01 | Staff endpoints exposed at two paths               | Low                            | `apps/api/src/routes/observability.ts`     | **Fixed**    |
| F-02 | Audit suite could pass against non-existent routes | Medium _(in the audit itself)_ | `tests/integration/security-audit.test.ts` | **Fixed**    |
| F-03 | `/metrics` unauthenticated on the main listener    | Low — accepted, documented     | `apps/api/src/routes/observability.ts`     | Accepted     |
| F-04 | Dependency advisories in Expo build tooling        | Low                            | `apps/mobile` dev dependencies             | Accepted     |
| F-05 | Reflected input returned in JSON replies           | Informational                  | `apps/api/src/routes/conversations.ts`     | Not a defect |

### F-01 — Staff endpoints exposed at two paths

**Severity:** Low. Not a privilege bypass; both copies carried identical
authorisation.

**Component:** `apps/api/src/routes/observability.ts`, `apps/api/src/app.ts`

**Issue.** `observabilityRoutes` was registered twice — once at the root to
serve `/metrics`, once under `/api` for the staff endpoints. Only the scrape
route sat behind a flag, so the staff routes were created by _both_
registrations:

```
/admin/metrics/product        ← unintended, undocumented
/api/admin/metrics/product    ← intended
```

Why it still matters despite the identical auth: an endpoint nobody knows exists
is in no threat model, no WAF policy, no rate-limit review, and no next
engineer's mental map. Undocumented surface is how a later change loosens
something nobody realised was reachable.

This was introduced by the observability phase, three days before this audit —
a useful reminder that the most recent code is the least reviewed.

**Remediation.** Split into two plugins — `metricsScrapeRoutes` (root) and
`observabilityRoutes` (`/api`) — each registered exactly once. Structural, so
the shape cannot drift back behind a flag.

**Test proving remediation.** `security-audit.test.ts` →
_"exposes the staff endpoints at exactly one path each"_: asserts the canonical
path returns 200 for staff and the duplicate returns **404**.

---

### F-02 — The audit suite could have passed against nothing

**Severity:** Medium, **in the audit rather than the application.** No user was
ever at risk; the risk was of reporting a clean audit that proved nothing.

**Component:** `tests/integration/security-audit.test.ts`

**Issue.** Every authorisation test accepted `403` **or** `404` as "attack
refused" — which is right, because the two must be indistinguishable to prevent
enumeration (see §2.2). But a route that does not exist _also_ returns 404. A
typo, a changed prefix, or an unregistered route therefore makes an attack
appear to fail and the suite appear green.

This was not hypothetical. The first run attacked
`/v1/voice/audio/:key`; the route is actually mounted at `/api/voice/audio/:key`.
The 404 was a missing route, not a refusal, and a slightly looser assertion would
have swallowed it.

**Remediation.** A positive-control block (`0. the endpoints under attack
actually exist`) runs first and proves every attacked endpoint is reachable by
its legitimate owner — 200 for the data's owner, 401 rather than 404 for the
unauthenticated audio route, non-404 for the voice upload, 200 for staff
endpoints as staff. Only then does refusing everyone else mean anything.

**Test proving remediation.** The positive-control block itself. It fails loudly
if any attacked route stops existing.

---

### F-03 — `/metrics` is unauthenticated on the main listener

**Severity:** Low. **Accepted with documented mitigations.**

**Component:** `apps/api/src/routes/observability.ts`

**Issue.** The Prometheus endpoint has no authentication — standard for metrics
endpoints, since a scraper has no session — but it is served on the same
listener as the public API. It discloses route patterns, request volumes, error
counts, process memory, and uptime.

**Why accepted.** The disclosure is bounded and contains no personal data by
construction: `assertLabelsAreDimensions` throws on any identifier-shaped label,
and the audit suite asserts no UUID appears anywhere in a scrape. What remains
is operational shape — useful to an attacker for timing, not for reaching data.

**Mitigations in place.** No personal data in labels (enforced, tested);
`METRICS_ENABLED=false` disables it entirely; `METRICS_PORT` exists in
configuration for a separate listener.

**Remaining work, not done.** The separate listener is configured but not
implemented — `/metrics` is still on the main port. Deployments must restrict it
by network policy. **This is the one finding a production deployment must
address before launch.**

---

### F-04 — Dependency advisories

**Severity:** Low.

**Component:** `apps/mobile` transitive dev dependencies.

**Issue.** `pnpm audit` reports 3 advisories (2 high, 1 moderate):
`image-size` (denial of service via infinite loops in ICNS/JXL/HEIF parsers) and
`uuid` (missing buffer bounds check).

**Assessment.** All three arrive through `expo > @expo/cli` — build tooling that
runs on a developer machine. `pnpm why image-size` returns **zero** paths from
`apps/api`. Neither package is on any request path, in any server bundle, or in
any shipped artefact.

**Remediation.** No fix available without an Expo upgrade that pulls patched
transitives. Documented and tracked rather than silently ignored; re-check on
each Expo bump.

---

### F-05 — Reflected input in JSON replies

**Severity:** Informational. **Not a defect.**

**Issue.** A conversation reply can quote the child's own message, so markup a
child typed comes back in a JSON string field.

**Assessment.** Not XSS, and HTML-escaping it would be the _wrong_ fix —
escaping inside a JSON API produces double-escaped text at every render site.
The escaping belongs where rendering happens. Three defences apply:
`Content-Type: application/json`, `X-Content-Type-Options: nosniff`, and clients
that render through React and React Native `<Text>`, neither of which interprets
HTML.

**Test.** _"returns echoed markup as inert JSON data"_ and _"never serves an API
response as HTML"_.

---

## 2. The twelve attacks

All executed in `tests/integration/security-audit.test.ts`. **49 tests, all
passing.**

| #   | Attack                      | Result  | Defence that stopped it                                       |
| --- | --------------------------- | ------- | ------------------------------------------------------------- |
| 1   | Parent A → Parent B's child | Refused | Ownership check in handler **and** RLS                        |
| 2   | Child enumeration           | Refused | Own-children-only list; identical 403/404; UUIDv7 random tail |
| 3   | Conversation enumeration    | Refused | Ownership on read, message, and end                           |
| 4   | Unauthorised audio download | Refused | Session + RLS ledger check + expiry; traversal keys rejected  |
| 5   | Forged subscription         | Refused | `.strict()` schemas; only a verified webhook grants           |
| 6   | Forged payment webhook      | Refused | HMAC verified before parsing; nothing recorded                |
| 7   | Webhook replay              | Refused | Signed timestamp window + event-id idempotency                |
| 8   | Prompt injection            | Refused | No prompt material in any response                            |
| 9   | AI safety bypass            | Refused | Five-layer pipeline, output checked regardless of input       |
| 10  | File upload abuse           | Refused | Byte sniffing, size ceiling, nothing stored                   |
| 11  | Rate-limit bypass           | Refused | `trustProxy=false`; per-parent keys from the session          |
| 12  | Privilege escalation        | Refused | Role not writable via profile; staff routes refuse parents    |

### 2.2 Why 403 and 404 must be identical

Attack 2 asserts that a _real_ foreign child and an _imaginary_ one produce the
same status **and** the same error code. Different responses are an oracle: an
attacker learns which identifiers exist by watching which error comes back.

This is also what made F-02 possible, and the two are in genuine tension —
resolved by the positive controls rather than by weakening the indistinguishability.

---

## 3. Review by area

| Area                    | Assessment                                                                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Authentication          | Argon2id, no plaintext, identical failure for wrong password and unknown address, lockout, sessions revocable                         |
| Authorization           | Permission per route + ownership check + RLS. Three layers, tested                                                                    |
| Supabase RLS            | `ENABLE` **and** `FORCE` on every table; policies tested under `SET ROLE` in `rls-tenant-isolation.test.ts`                           |
| API validation          | Zod on every route; `.strict()` on bodies that must not accept extras                                                                 |
| Rate limiting           | Global per-IP + per-parent per-route. **In-memory — see §4**                                                                          |
| File uploads            | Byte sniffing over declared MIME, streamed size ceiling, duration bounds                                                              |
| Audio storage           | Random 24-byte keys, RLS ledger check, expiry, retention default 0 days                                                               |
| AI prompts              | Server-side only; no row can supply prompt text; `assertNoProhibitedData` blocks child identifiers reaching a provider                |
| Prompt injection        | Output safety runs regardless of what input asked for                                                                                 |
| Secrets                 | None committed; `verify:no-secrets` in CI; a scan asserts no credential in `apps/mobile`                                              |
| Environment variables   | One schema, validated at boot, fails hard                                                                                             |
| Payment webhooks        | Signature before parse, raw bytes, idempotent, replay-safe, transaction-safe                                                          |
| Subscription authz      | No client-supplied status field exists anywhere                                                                                       |
| Admin authz             | `audit:read` / staff roles only; no staff role holds `billing:manage_own`                                                             |
| Logging                 | Structured, request id, `redactObject` on sensitive paths, no content in audit metadata                                               |
| Database access         | Parameterised throughout — a grep for interpolated request data returns nothing                                                       |
| Storage access          | No filesystem path is built from user input                                                                                           |
| CORS                    | Explicit allowlist, no wildcard, no origin reflection; wildcard refused in deployed envs                                              |
| CSRF                    | Not applicable to the API (bearer tokens, no cookie auth). The dashboard uses Server Actions with a `SameSite=Strict` httpOnly cookie |
| XSS                     | No `dangerouslySetInnerHTML` anywhere; JSON + `nosniff`; React escaping                                                               |
| SQL injection           | Parameterised; PGlite integration tests exercise real SQL                                                                             |
| NoSQL injection         | Not applicable — no document store                                                                                                    |
| SSRF                    | No user input becomes an outbound URL. Webhook and provider URLs come from configuration                                              |
| Path traversal          | Storage is key-value, not filesystem; traversal keys tested                                                                           |
| Dependencies            | See F-04                                                                                                                              |
| Sensitive data exposure | Response schemas allow-list fields; no internal id, token, or vendor payload leaves                                                   |
| Error messages          | No stack, path, hostname, or connection string — tested                                                                               |
| Audit logging           | Append-only, service-role actions require a justification                                                                             |

---

## 4. Known weaknesses, not fixed

Stated plainly rather than buried.

1. **Rate limiting is per-instance and in-memory.** Behind a load balancer with
   _N_ instances, the effective limit is _N_ × the configured value. Moving to
   Redis is designed and not built.
2. **`/metrics` is on the main listener** (F-03). Network policy is currently
   the only control.
3. **Message encryption uses a `placeholder` codec.** The column and key-id
   plumbing exist; real AES-GCM does not. Conversation content is protected by
   RLS and database access control, **not** by encryption at rest in the
   application layer.
4. **No penetration test, no external review, no bug bounty.**
5. **Integration tests run against PGlite**, not the production Postgres
   version. RLS semantics are exercised faithfully; server configuration,
   connection limits, and extensions are not.
6. **e2e tests are skipped** in this environment (no `DATABASE_URL`, no Docker),
   so nothing here exercised a real server process over a real socket.
7. **No automated dependency scanning in CI.** `pnpm audit` was run by hand for
   this document.
8. **Auth spine tables** (`devices`, refresh-token rotation records) remain
   deferred from an earlier phase.

---

## 5. What this audit does not cover

- Infrastructure: host hardening, network segmentation, TLS termination, secret
  storage at rest, backup encryption.
- The production database configuration.
- Timing attacks and concurrency under load.
- Anything requiring a browser: real CSP behaviour, clickjacking in practice,
  the Playwright suite (not run — needs browser binaries).
- Social engineering, physical access, insider threat.
- Supply-chain compromise of a dependency.
- The mobile applications as built artefacts — only their source was scanned.
- Every unknown vulnerability, which is the category that matters most.

---

## 6. Recommended before launch

1. Commission an **independent penetration test**. Nothing in this document
   replaces it.
2. Move `/metrics` to its own listener, or restrict it by network policy (F-03).
3. Implement the real encryption codec (§4.3).
4. Move rate limiting to Redis (§4.1).
5. Add dependency scanning to CI.
6. Run the e2e and Playwright suites against a real deployment.
7. Establish a security contact and disclosure process. A product for children
   should be easy to report a vulnerability to.

---

## 7. How to re-run

```bash
pnpm vitest run --project integration tests/integration/security-audit.test.ts
```

Related suites: `rls-tenant-isolation.test.ts`, `authorization.test.ts`,
`safety.test.ts`, `subscriptions.test.ts`, `payment-rails.test.ts`,
`store-billing.test.ts`, `observability.test.ts`.
