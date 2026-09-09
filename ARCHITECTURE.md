# Architecture

**Status:** Foundation phase (v0.1). No application code has been written yet — this document defines the target the code will be built against.
**Audience:** Engineers, technical reviewers, and any future security/privacy assessor.
**Companions:** [SECURITY.md](SECURITY.md) · [PRIVACY.md](PRIVACY.md) · [docs/CHILD_SAFETY.md](docs/CHILD_SAFETY.md) · [DEVELOPMENT_PLAN.md](DEVELOPMENT_PLAN.md) · [docs/adr/](docs/adr/)

---

## 1. What we are building

A voice-first AI conversation companion for children roughly 3–10 years old. A child talks to an animated character; the character listens, understands, and talks back — in English or Urdu — while a parent retains full visibility and control from a separate dashboard.

Initial market is Pakistan, then international expansion.

### 1.1 The forces that actually shape this architecture

Most design choices below trace back to one of six constraints. They are stated up front because they explain decisions that would otherwise look over-engineered.

| #   | Constraint                                                                                                                                                                 | Architectural consequence                                                                                                                                               |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | **The user is a child who cannot consent, cannot read a privacy policy, and cannot assess risk.**                                                                          | The parent is the account holder and the only authenticated principal. Children never hold long-lived credentials. Every default is the conservative one.               |
| C2  | **Latency is the product.** A 5-second pause and a 3-year-old has walked away.                                                                                             | The voice loop is the critical path and gets an explicit end-to-end budget (§7). Everything else can be slow.                                                           |
| C3  | **Unit economics are brutal in the launch market.** Pakistani consumer subscription price points are a fraction of US/EU ones, while per-minute AI+STT+TTS cost is global. | Aggressive caching, tight token ceilings, cheap models for classification, hard per-child spend guards, and cost-per-conversation as a first-class metric from day one. |
| C4  | **An unsafe model output is a product-ending event, not a bug.**                                                                                                           | Safety is a pipeline with independent layers, not a prompt instruction. It fails closed.                                                                                |
| C5  | **Low-end Android on intermittent mobile data is the median device.**                                                                                                      | Small bundles, aggressive audio compression, resumable uploads, graceful offline degradation, no assumption of a stable socket.                                         |
| C6  | **Providers will change.** Model pricing, Urdu STT quality, and payment rails are all volatile.                                                                            | AI, STT, TTS, storage, and payments each sit behind a port we own. No vendor SDK type ever leaks into domain code.                                                      |

---

## 2. System context

```
                       ┌──────────────────────────┐
                       │        Child             │
                       │  (speaks, listens)       │
                       └────────────┬─────────────┘
                                    │ voice
                       ┌────────────▼─────────────┐
   ┌───────────────┐   │   apps/mobile  (React    │
   │    Parent     │──▶│   Native, child mode +   │
   │ (dashboard,   │   │   parent mode)           │
   │  billing)     │   └────────────┬─────────────┘
   └───────┬───────┘                │ HTTPS / WS
           │                        │
           │  ┌─────────────────────▼──────────────────────┐
           └─▶│              apps/api (Fastify)            │
              │  auth · conversation orchestrator · safety │
              │  quota · billing · dashboard read models   │
              └──┬────────┬────────┬─────────┬─────────┬───┘
                 │        │        │         │         │
        ┌────────▼──┐ ┌───▼────┐ ┌─▼──────┐ ┌▼───────┐ ┌▼──────────┐
        │ Supabase  │ │ Redis  │ │services│ │services│ │ services  │
        │ Postgres  │ │ cache  │ │  /ai   │ │ /voice │ │ /payments │
        │ + RLS     │ │ queues │ │        │ │STT/TTS │ │           │
        │ + Storage │ │ limits │ └───┬────┘ └───┬────┘ └────┬──────┘
        └───────────┘ └────────┘     │          │           │
                                     ▼          ▼           ▼
                              LLM vendor   STT/TTS     Stripe · JazzCash
                                                       Easypaisa · IAP
```

`apps/web` (parent dashboard + marketing + web checkout) talks to the same API and is omitted above for clarity.

---

## 3. Monorepo layout and dependency rules

```
kids-companion/
├── apps/          deployable units. May depend on packages/ and services/.
├── packages/      shared libraries. May depend on other packages/. Never on apps/.
├── services/      domain modules with side effects, each fronting an external
│                  capability behind a port we own. May depend on packages/.
├── infra/         docker, migrations, operational scripts. No app imports.
├── tests/         cross-cutting contract and end-to-end suites.
└── docs/          conventions, ADRs, runbooks.
```

**The one rule: dependencies point inward.**

```
apps ──▶ services ──▶ packages/{shared,validation,config} ──▶ packages/types
  └────────────────────────────────────────────────────────────────┘
```

`packages/types` is the innermost ring and has **zero runtime imports** — it is types only. This is what lets React Native, the Fastify API, and the Next.js dashboard all share a domain vocabulary without dragging Node-only or React-only code across boundaries. Both rules are enforced by ESLint (`eslint.config.mjs`), not by convention alone.

### 3.1 Why `services/` is a sibling of `packages/` rather than nested inside it

`packages/*` are pure, side-effect-free libraries — you can call them in a unit test with no setup. `services/*` are the opposite by definition: they hold network calls, API keys, retries, and vendor quirks. Keeping them in a separate top-level directory makes the distinction visible in every import path and lets CI apply different rules (services require contract tests against a recorded fixture; packages do not).

### 3.2 Package inventory

| Path                  | Package            | Responsibility                                                                                                                                                     | Notably does **not** contain                 |
| --------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------- |
| `packages/types`      | `@kids/types`      | Domain types: `ChildProfile`, `Conversation`, `Turn`, `SafetyVerdict`, `Subscription`, branded IDs.                                                                | Any runtime code, any Zod import             |
| `packages/validation` | `@kids/validation` | Zod schemas — the single source of truth for every API request/response, plus JSON Schema emission for Fastify.                                                    | Business rules                               |
| `packages/config`     | `@kids/config`     | Environment loading and validation. Fails fast at boot on a bad/missing var. Typed config object per app.                                                          | Secrets, defaults that mask misconfiguration |
| `packages/shared`     | `@kids/shared`     | Errors (`AppError` taxonomy), `Result`, logger factory with redaction, `Clock`, ID generation, retry/backoff, redaction utilities.                                 | Domain logic                                 |
| `packages/ui`         | `@kids/ui`         | Design tokens and cross-platform primitives shared by mobile and web.                                                                                              | Screens, navigation                          |
| `services/ai`         | `@kids/ai`         | `ConversationProvider` port, vendor adapters, prompt registry (versioned), the safety chain, token/cost accounting.                                                | HTTP handlers                                |
| `services/voice`      | `@kids/voice`      | `SpeechToTextProvider` and `TextToSpeechProvider` ports, adapters, audio format normalisation, TTS cache keys.                                                     | Storage decisions                            |
| `services/payments`   | `@kids/payments`   | `PaymentProvider` + `SubscriptionStore` ports, adapters for Stripe / JazzCash / Easypaisa / Apple IAP / Google Play, webhook verification, entitlement resolution. | Pricing copy                                 |

---

## 4. Runtime topology

| Environment  | Compute                                  | Postgres                    | Redis                         | Notes                                                      |
| ------------ | ---------------------------------------- | --------------------------- | ----------------------------- | ---------------------------------------------------------- |
| `local`      | `pnpm dev` + Docker Compose              | Supabase CLI (local)        | Docker                        | All external providers default to `mock`                   |
| `ci`         | GitHub Actions                           | Testcontainers              | Testcontainers                | No live vendor calls, ever                                 |
| `staging`    | Container host, 1–2 instances            | Supabase project (separate) | Managed Redis                 | Synthetic child data only                                  |
| `production` | Container host, autoscaled, ≥2 instances | Supabase project            | Managed Redis, persistence on | Region choice is open — see [Q-04](docs/OPEN_QUESTIONS.md) |

The API is **stateless**. All session state lives in Postgres or Redis, so an instance can be killed mid-conversation and the child's next turn lands on a different instance without noticing.

---

## 5. Identity model

This is the part most likely to be got wrong, so it is spelled out precisely.

### 5.1 Three principals

| Principal         | Authenticates? | Credential                                                                                | Lifetime                                          |
| ----------------- | -------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------- |
| **Parent**        | Yes            | Email + password (Argon2id) or email OTP                                                  | Access token 15 min, refresh token 30 d, rotating |
| **Child profile** | **No**         | None. A child is _data owned by a parent_, not a login.                                   | n/a                                               |
| **Child session** | Derived        | Opaque, device-bound token minted by an authenticated parent when handing over the device | 60 min, revocable instantly                       |

A child profile has no password, no email, and no independent recovery path — because giving a 5-year-old a credential creates an account-recovery problem that can only be solved by collecting more data about a child. The child session token is scoped to exactly the conversation endpoints and carries no ability to read billing, change settings, view other profiles, or export data.

### 5.2 The parent gate

Any transition from child mode to parent mode (settings, dashboard, billing, deletion) passes a **parent gate**: a challenge a young child cannot casually pass, and — critically — a re-authentication for anything destructive or financial. The gate is a speed bump, not a security control; it is layered _on top of_ the parent's real session, never instead of it.

### 5.3 Token handling

- Access tokens: short-lived JWTs, verified locally by the API. Carry `sub` (parent), `sid` (session), and, in child mode, `cid` (child profile) + `mode: "child"`.
- Refresh tokens: opaque, hashed at rest, single-use with rotation. Reuse of a consumed refresh token revokes the entire token family and raises a security event — the standard detection for a stolen refresh token.
- Mobile stores tokens in the OS keystore (iOS Keychain / Android Keystore), never `AsyncStorage`.
- Web uses `HttpOnly; Secure; SameSite=Strict` cookies for the refresh token.

See [ADR-0005](docs/adr/0005-auth-and-session-model.md).

---

## 6. The conversation domain

```
Parent ──1:N──▶ ChildProfile ──1:N──▶ Conversation ──1:N──▶ Turn
                     │                                        │
                     ├──1:N──▶ LearningEvent                  ├──▶ SafetyVerdict
                     ├──1:1──▶ AgeBand (derived)              └──▶ AudioArtifact (usually absent)
                     └──1:N──▶ ParentalControlPolicy
```

**Age bands** drive vocabulary ceiling, sentence length, turn duration, and content policy. They are derived, never free-typed:

| Band         | Ages | Character of the conversation                                                    |
| ------------ | ---- | -------------------------------------------------------------------------------- |
| `early`      | 3–4  | Very short turns, heavy repetition, naming and sounds, near-constant affirmation |
| `emerging`   | 5–6  | Simple narrative, simple questions back, early phonics                           |
| `developing` | 7–8  | Multi-turn stories, "why" questions, light reasoning                             |
| `fluent`     | 9–10 | Longer role-play, richer vocabulary, hobby/interest depth                        |

The band is an input to prompt construction, safety thresholds, _and_ quota policy. It is never inferred from the child's speech — only from the parent-declared birth year, which is itself minimised (year and month only; see [PRIVACY.md](PRIVACY.md)).

---

## 7. The voice loop — the critical path

This is the only latency-sensitive path in the system, and the only one with a hard budget.

```
 child speaks
      │
      ▼
 ┌─────────────────┐  on-device VAD detects end of utterance
 │ 1. capture      │  Opus @16 kHz mono, ~24 kbps
 └────────┬────────┘
          ▼
 ┌─────────────────┐  resumable, chunked; retries do not restart the turn
 │ 2. upload       │
 └────────┬────────┘
          ▼
 ┌─────────────────┐  services/voice → STT port
 │ 3. transcribe   │  language hint from profile, not autodetect (see §7.2)
 └────────┬────────┘
          ▼
 ┌─────────────────┐  LAYER 1: input safety classify  ──┐
 │ 4. safety in    │                                     │ runs concurrently
 └────────┬────────┘                                     │ with prompt assembly
          ▼                                              │
 ┌─────────────────┐  services/ai → conversation port  ◀─┘
 │ 5. generate     │  streamed; system prompt pinned by version + age band
 └────────┬────────┘
          ▼
 ┌─────────────────┐  LAYER 3: output classify on streamed chunks
 │ 6. safety out   │  a failed chunk halts the stream before TTS
 └────────┬────────┘
          ▼
 ┌─────────────────┐  content-hash cache hit skips synthesis entirely
 │ 7. synthesise   │
 └────────┬────────┘
          ▼
 ┌─────────────────┐  first audio byte starts playback; rest streams
 │ 8. play         │
 └─────────────────┘
```

### 7.1 Latency budget

Target: **p50 ≤ 1.8 s, p95 ≤ 3.0 s** from end-of-child-utterance to first audio byte.

| Stage                        | p50 target     | p95 ceiling |
| ---------------------------- | -------------- | ----------- |
| VAD endpointing              | 250 ms         | 400 ms      |
| Upload (PK mobile data)      | 200 ms         | 600 ms      |
| STT                          | 400 ms         | 800 ms      |
| Input safety (overlapped)    | 0 ms effective | 150 ms      |
| LLM time-to-first-token      | 500 ms         | 900 ms      |
| Output safety on first chunk | 80 ms          | 150 ms      |
| TTS time-to-first-byte       | 350 ms         | 700 ms      |
| **Total**                    | **~1.8 s**     | **~3.0 s**  |

These are commitments, not aspirations: a synthetic probe runs the full loop on a schedule per region and alerts on budget breach. If the budget cannot be met, the product changes (shorter responses, more caching, on-device wake phrases) — we do not quietly ship a 6-second loop.

**Cover for the gap.** Even 1.8 s of silence reads as "broken" to a small child. The character therefore emits an immediate, locally-generated acknowledgement (a nod, a "hmm!", an ear-twitch) the moment upload starts. This is a UX requirement with an architectural consequence: those fillers ship in the app bundle and never round-trip.

### 7.2 Why language is a hint, not an autodetect

Pakistani households code-switch constantly — a single sentence may mix Urdu and English. Autodetect on a 4-year-old's 2-second utterance is unreliable and, when wrong, produces a nonsense transcript that then goes to the LLM. We instead take the profile's declared language(s) as a constrained hypothesis set. **Child-speech ASR accuracy, especially for Urdu, is the single largest technical risk in this product** and is tracked as [R-01](DEVELOPMENT_PLAN.md#risk-register).

### 7.3 Transport

Phase 1 uses plain HTTP request/response per turn — simplest to make correct, easiest to retry on a flaky connection, and adequate for the budget above. A streaming transport (WebSocket or WebRTC) is a Phase 4 optimisation, gated on measured evidence that the request/response loop cannot hit p95. Deciding this later is cheap because the client talks to a `ConversationTransport` interface from the start.

---

## 8. Provider abstraction (ports and adapters)

Every external capability is a **port** — an interface owned by us, expressed in our domain types — with one or more **adapters** behind it.

```
       domain code (never imports a vendor SDK)
                     │
                     ▼
        ┌────────────────────────┐
        │   ConversationProvider │   ◀── port, in services/ai
        └────────────────────────┘
              ▲            ▲
     ┌────────┘            └────────┐
┌──────────────┐            ┌──────────────┐
│ Anthropic    │            │ Mock         │  ◀── adapters
│ adapter      │            │ adapter      │
└──────────────┘            └──────────────┘
```

Ports we commit to in Phase 1:

| Port                   | Package             | Why it must be swappable                                                              |
| ---------------------- | ------------------- | ------------------------------------------------------------------------------------- |
| `ConversationProvider` | `services/ai`       | Model pricing and quality shift monthly; cost is an existential constraint (C3)       |
| `SafetyClassifier`     | `services/ai`       | We may move to a self-hosted or specialised classifier                                |
| `SpeechToTextProvider` | `services/voice`    | Urdu child-speech accuracy will decide the vendor, and we do not know the winner yet  |
| `TextToSpeechProvider` | `services/voice`    | Voice character quality and per-character pricing vary enormously                     |
| `PaymentProvider`      | `services/payments` | Pakistan rails, international rails, and app-store billing are three different worlds |
| `ObjectStorage`        | `packages/shared`   | Supabase Storage now; S3-compatible later without a rewrite                           |

**Rules for every adapter:**

1. It maps vendor errors into our `AppError` taxonomy. A vendor's 429 becomes `ProviderRateLimited`, never leaks upward as-is.
2. It never widens the port's interface for one vendor's convenience. If a capability is vendor-specific, it does not belong in the port.
3. It ships with a contract test suite (`tests/contract/`) that every adapter of that port must pass identically, including the mock.
4. It records cost and latency per call into the same metric names regardless of vendor.

The `mock` adapter is not a testing afterthought — it is the default in `local` and `ci` so that a fresh clone runs end to end with **no API keys at all**.

---

## 9. Data architecture

### 9.1 Supabase Postgres with Row Level Security

Two enforcement layers, deliberately redundant:

1. **The API is the primary trust boundary.** Authorization is decided in application code, in one place, with the full request context.
2. **RLS is the backstop.** Every table carrying child or parent data has RLS enabled with policies scoped to the owning parent. If an authorization check is ever missed in application code, the database still refuses the read.

The API uses a **request-scoped connection carrying the parent's identity**, not a blanket service-role connection, for all normal traffic. The service-role key — which bypasses RLS entirely — is confined to a small, explicitly listed set of system operations (migrations, retention jobs, webhook reconciliation) that run outside a user request. Any new use of it requires review. See [SECURITY.md](SECURITY.md).

### 9.2 Data classification

Everything about a child is sensitive. The classification below drives encryption, retention, logging, and export rules — the details are in [PRIVACY.md](PRIVACY.md).

| Class                | Examples                                                                   | Handling                                                                                                                                                                 |
| -------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **S3 — Highest**     | Raw child audio, conversation transcripts, pronunciation recordings        | Not retained by default. When retained under explicit parent opt-in: application-layer encryption, never logged, never in analytics, excluded from non-prod environments |
| **S2 — High**        | Child first name, birth year/month, language, learning progress, interests | Encrypted at rest, redacted from logs, parent-scoped RLS, exportable and deletable on request                                                                            |
| **S1 — Moderate**    | Parent email, device identifiers, subscription status                      | Standard protection, redacted in logs, deletable                                                                                                                         |
| **S0 — Operational** | Aggregate counts, latency, error rates, cost                               | Freely usable, must contain no identifiers                                                                                                                               |

### 9.3 Conventions

Table naming, key strategy, migration discipline, soft-delete policy, and the audit-log design live in [docs/DATABASE_CONVENTIONS.md](docs/DATABASE_CONVENTIONS.md).

### 9.4 Redis

| Use                    | Key shape                           | Notes                                                                                 |
| ---------------------- | ----------------------------------- | ------------------------------------------------------------------------------------- |
| Rate limiting          | `rl:{scope}:{subject}`              | Sliding window; the only hard dependency on Redis in the request path                 |
| TTS cache              | `tts:{voice}:{lang}:{sha256(text)}` | The single biggest cost lever (C3) — greetings and stock phrases repeat constantly    |
| Session/quota counters | `quota:{childId}:{yyyy-mm-dd}`      | Written through to Postgres asynchronously                                            |
| Job queues             | `q:{name}`                          | Transcript summarisation, retention sweeps, webhook reconciliation, report generation |

**Redis is a cache and a rate limiter, never a system of record.** If Redis is lost entirely, the product must continue to serve conversations — degraded (quotas fall back to conservative Postgres reads, TTS cache misses) but functional. This is an explicit design requirement, tested with a chaos case.

---

## 10. Safety architecture

Safety is defence in depth, and every layer can independently stop a turn. Full policy, escalation protocol, and the disclosure-handling procedure are in [docs/CHILD_SAFETY.md](docs/CHILD_SAFETY.md); this section covers only the mechanism.

```
child utterance
   │
   ├─▶ L1  INPUT CLASSIFIER      distress, disclosure, unsafe topic, PII in speech
   │        └─▶ escalate / redirect / block before the model ever sees it
   │
   ├─▶ L2  CONSTRAINED GENERATION
   │        versioned system prompt + age band + character persona
   │        + hard refusal list + output length ceiling
   │
   ├─▶ L3  OUTPUT CLASSIFIER     runs on streamed chunks, halts mid-stream
   │
   ├─▶ L4  DETERMINISTIC FILTERS non-model checks: blocklists, URL/contact-info
   │        stripping, no-PII-elicitation rules. Cheap, fast, and not fooled by
   │        the same things a model is.
   │
   └─▶ L5  ASYNCHRONOUS REVIEW   sampled + all flagged turns to a review queue;
            parent-visible flags; feeds prompt and blocklist iteration
```

**Fail closed.** If a classifier errors or times out, the turn is blocked and the character says something benign. `SAFETY_FAIL_MODE` exists as a variable but `open` is not a supported value in any deployed environment.

**Independence.** L4 exists because L1/L3 share a failure mode: they are both models. A deterministic filter catches the class of failure where a clever input makes every model in the chain agree.

**Escalation, not silence.** Some inputs — a child disclosing harm, or expressing distress — must not merely be blocked. They route to a defined protocol involving the parent. Getting this right is a policy and legal question as much as an engineering one, and it is unresolved: see [Q-07](docs/OPEN_QUESTIONS.md).

---

## 11. Payments and entitlements

The architecture separates three concerns that are commonly conflated:

1. **Payment collection** — vendor-specific, per-rail (Stripe, JazzCash, Easypaisa, Apple IAP, Google Play).
2. **Subscription state** — our own record, reconciled from webhooks, never inferred from a client claim.
3. **Entitlement** — the runtime question "may this child take another turn right now?", answered from our own state in a single place.

Entitlement checks never call a payment vendor synchronously. A webhook outage must not stop a paying child from talking.

**The unresolved constraint that shapes everything here:** Apple and Google require digital subscriptions sold within a mobile app to use their billing, at ~15–30 %. Pakistan's local rails (JazzCash, Easypaisa) are how the launch market actually pays. These two facts are in direct tension and the resolution is a business/legal decision, not an engineering one. See [Q-02](docs/OPEN_QUESTIONS.md) — it is the highest-impact open question in this document.

---

## 12. Observability

Three signals, one correlation ID (`requestId`, propagated to `traceId`).

- **Logs** — structured JSON via Pino, with mandatory redaction. Transcript text and child identifiers never enter a log line. See [docs/LOGGING.md](docs/LOGGING.md).
- **Metrics** — RED on every endpoint, plus product-critical gauges: voice-loop stage latencies, safety block rate by layer, STT confidence distribution, **cost per conversation** (C3), quota exhaustion rate.
- **Traces** — OpenTelemetry across the voice loop, with a span per stage in §7 so a latency regression is attributable to a stage in one glance.

Alerting priorities, in order: (1) safety pipeline degradation, (2) auth/authorization anomalies, (3) voice-loop p95 breach, (4) cost ceiling approach, (5) everything else.

---

## 13. Failure modes and degradation

| Failure                 | Behaviour                                                        | Child sees                                                         |
| ----------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------ |
| LLM provider down       | Fail over to secondary adapter; if none, degrade                 | Character says it needs a rest, suggests a cached story            |
| STT down                | No fallback — the turn cannot proceed                            | "I couldn't hear that, can you say it again?" then a graceful exit |
| TTS down                | Serve cached audio; else fall back to on-screen text for readers | Character mimes / text bubble                                      |
| Safety classifier down  | **Block the turn** (fail closed)                                 | Benign redirect                                                    |
| Redis down              | Conservative quota from Postgres, TTS cache bypassed             | Slightly slower, still works                                       |
| Postgres down           | Reject writes, serve nothing from cache that implies persistence | Honest "let's try later" screen                                    |
| Payment webhook backlog | Entitlement served from last known state; grace window           | Nothing                                                            |

The rule: **a child never sees an error message, a stack trace, or a spinner that does not resolve.** Every failure has a character-appropriate exit.

---

## 14. Technology decisions

| Area           | Choice                                   | One-line rationale                                                                                            | ADR                                                                                                        |
| -------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Monorepo       | pnpm workspaces + `pnpm -r`              | Workspace protocol and a shared catalog; no native binary in the build path. Boundaries enforced by lint.     | [0001](docs/adr/0001-monorepo-tooling.md), [0008](docs/adr/0008-build-orchestration-and-module-linking.md) |
| HTTP framework | **Fastify**                              | Schema-first validation and serialisation on every route, first-class TS, encapsulated plugins, Pino built in | [0002](docs/adr/0002-http-framework-fastify.md)                                                            |
| Database       | Supabase Postgres + RLS                  | Managed Postgres with row-level authorization as a backstop, plus auth and storage in one platform            | [0003](docs/adr/0003-supabase-postgres-rls.md)                                                             |
| Providers      | Ports and adapters                       | Vendor volatility in AI, voice, and payments is certain (C6)                                                  | [0004](docs/adr/0004-provider-abstraction.md)                                                              |
| Identity       | Parent-only auth, derived child sessions | Children must not hold credentials (C1)                                                                       | [0005](docs/adr/0005-auth-and-session-model.md)                                                            |
| Audio          | Transcribe-and-discard by default        | Retaining child voice is the highest-risk data decision available to us                                       | [0006](docs/adr/0006-voice-pipeline-and-audio-retention.md)                                                |
| Payments       | Multi-rail behind one port               | Launch market and app stores demand different rails                                                           | [0007](docs/adr/0007-payments-and-app-store-billing.md)                                                    |
| Language       | TypeScript everywhere, strict            | One vocabulary from database row to React Native screen                                                       | —                                                                                                          |
| Validation     | Zod → JSON Schema                        | One schema definition validates at the edge and types the domain                                              | [0002](docs/adr/0002-http-framework-fastify.md)                                                            |

---

## 15. What this architecture explicitly does not yet decide

Recorded honestly rather than papered over. Full list with owners and deadlines: [docs/OPEN_QUESTIONS.md](docs/OPEN_QUESTIONS.md).

- Which STT vendor survives Urdu child-speech evaluation (Q-01) — **blocks Phase 3**
- App-store billing vs local Pakistani rails (Q-02) — **blocks Phase 6**
- Data residency and hosting region (Q-04)
- Whether pronunciation scoring needs a specialised model (Q-06)
- The disclosure/escalation protocol's legal shape in Pakistan (Q-07) — **blocks launch**
- Realtime transport upgrade (Q-09)

---

## 16. Compliance posture — stated plainly

This architecture is **designed to support** a future compliance assessment against COPPA, GDPR/GDPR-K, and Pakistan's data protection regime. It does not, by existing, achieve compliance with any of them. Compliance requires legal review, executed vendor agreements, documented assessments, and operational evidence — none of which is created by writing code. Any claim to the contrary in a future document, README, or marketing asset should be treated as a defect. See [PRIVACY.md §1](PRIVACY.md).
