# Development Plan

**Status:** Phase 0 complete. Phase 1 not started, and will not start until explicitly authorised.
**Companion documents:** [ARCHITECTURE.md](ARCHITECTURE.md) · [docs/OPEN_QUESTIONS.md](docs/OPEN_QUESTIONS.md) · [docs/CHILD_SAFETY.md](docs/CHILD_SAFETY.md)

---

## 1. How this plan is sequenced

Two principles drive the ordering, and they occasionally override "what's most fun to build":

**Retire the biggest unknown first.** The plan front-loads the two things most likely to invalidate the product: whether speech recognition works on Pakistani children's voices ([R-01](#risk-register)), and whether the unit economics survive Pakistani price points ([R-02](#risk-register)). Both are answered by cheap spikes before the expensive work that depends on them.

**Safety is never a later phase.** The safety pipeline lands in Phase 2, with the very first model call, not after the conversation feature "works". A conversation engine without safety is not a milestone — it is a liability we would then be tempted to demo.

### 1.1 What "done" means

A phase is complete only when all of the following hold. No exceptions, no "we'll add tests next sprint":

- [ ] `pnpm check` passes (format, lint, typecheck, unit tests)
- [ ] Tests meet the tier requirements in [docs/TESTING_STANDARDS.md](docs/TESTING_STANDARDS.md), including the elevated coverage gate on safety-critical modules
- [ ] New or changed environment variables are in `.env.example` **and** the `@kids/config` schema **and** [docs/ENVIRONMENT.md](docs/ENVIRONMENT.md)
- [ ] Any new personal-data field is classified in [PRIVACY.md](PRIVACY.md) with a retention rule
- [ ] Any new external call is behind a port with a contract test and a mock adapter
- [ ] Runbook entry exists for anything that can page someone
- [ ] ADR written for any decision that would be expensive to reverse

---

## 2. Phases

### Phase 0 — Foundation ✅ _complete_

Repository architecture, conventions, and documentation. No application code.

**Delivered:** monorepo skeleton, dependency-boundary enforcement, TypeScript/ESLint/Prettier/Vitest configuration, environment-variable specification, this plan, [ARCHITECTURE.md](ARCHITECTURE.md), [SECURITY.md](SECURITY.md), [PRIVACY.md](PRIVACY.md), the convention set in `docs/`, and seven ADRs.

---

### Phase 1 — Backend spine and identity

**Partially delivered.** The domain data model, RLS policies, and their tests are complete (see [docs/DATA_MODEL.md](docs/DATA_MODEL.md)). Authentication, the auth tables (`devices`, `sessions`, `refresh_tokens`), and the HTTP surface are not.

**Goal:** A running API that a parent can authenticate against and create a child profile in — with authorization enforced twice (application + RLS) and proven by tests.

| Deliverable                        | Detail                                                                               |
| ---------------------------------- | ------------------------------------------------------------------------------------ |
| `apps/api` bootstrapped            | Fastify, plugin structure, graceful shutdown, `/health` + `/ready`                   |
| `@kids/config`                     | Fail-fast env validation; boot aborts on a missing or malformed variable             |
| `@kids/shared`                     | `AppError` taxonomy, `Result`, redacting logger, `Clock`, ID generation              |
| `@kids/types` + `@kids/validation` | Domain vocabulary and the Zod → JSON Schema pipeline                                 |
| Data model v1                      | `parents`, `child_profiles`, `devices`, `sessions`, `refresh_tokens`, `audit_log`    |
| RLS policies                       | Every table, parent-scoped, with tests that assert cross-tenant reads **fail**       |
| Auth                               | Registration, login, refresh with rotation + reuse detection, logout, password reset |
| Child sessions                     | Device-bound, derived, revocable; parent gate                                        |
| Baseline hardening                 | Rate limits, security headers, CORS allowlist, request-ID propagation, audit log     |
| CI                                 | Lint, typecheck, unit, integration, secret scan, dependency audit                    |

**Exit criteria:** an integration test proves parent A cannot read parent B's child profile _through the API_, and a second test proves the same request fails _at the database_ even with the application check removed.

**Explicitly out of scope:** any AI call, any audio, any payment.

---

### Phase 2 — Conversation engine and the safety pipeline _(text-first)_

**Goal:** A safe, age-adaptive, character-driven conversation over **text**. Deliberately no voice — it removes STT/TTS variables while the hardest logic is built.

| Deliverable                   | Detail                                                                                                    |
| ----------------------------- | --------------------------------------------------------------------------------------------------------- |
| `services/ai`                 | `ConversationProvider` port + one real adapter + mock; contract suite                                     |
| Versioned prompt registry     | Prompts are versioned artefacts under review, not string literals in handlers                             |
| Age-band adaptation           | Vocabulary ceiling, turn length, topic policy per band                                                    |
| Character system              | 3–4 personas; persona affects voice and manner, never safety policy                                       |
| **Safety pipeline L1–L5**     | Input classifier, constrained generation, streamed output classifier, deterministic filters, review queue |
| Escalation path               | Distress/disclosure detection routed per [docs/CHILD_SAFETY.md](docs/CHILD_SAFETY.md)                     |
| Cost accounting               | Per-turn token and cost recording; per-child and global ceilings enforced                                 |
| Conversation persistence      | `conversations`, `turns`, `safety_verdicts` with retention rules applied from day one                     |
| **Safety evaluation harness** | A red-team corpus run in CI. A regression here fails the build.                                           |

**Exit criteria:** the safety corpus passes at the agreed threshold, fail-closed behaviour is proven by a test that makes the classifier error, and cost-per-conversation is measured and reported.

---

### Phase 3 — Voice pipeline

**Gated on the Q-01 spike (below). Do not begin before it reports.**

| Deliverable                | Detail                                                                                                                         |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `services/voice`           | STT and TTS ports, chosen adapters, mocks, contract suites                                                                     |
| Audio ingestion            | Resumable chunked upload, format normalisation, size and duration limits                                                       |
| **Transcribe-and-discard** | Raw audio deleted immediately after transcription by default ([ADR-0006](docs/adr/0006-voice-pipeline-and-audio-retention.md)) |
| TTS cache                  | Content-hash keyed; the primary cost lever                                                                                     |
| Latency instrumentation    | A span per stage of [ARCHITECTURE.md §7](ARCHITECTURE.md), plus a synthetic probe                                              |
| Degradation paths          | Every failure in [ARCHITECTURE.md §13](ARCHITECTURE.md) has a child-appropriate exit                                           |

**Exit criteria:** p50 ≤ 1.8 s and p95 ≤ 3.0 s measured on a representative low-end Android device on Pakistani mobile data — not on office wifi with an iPhone.

---

### Phase 4 — Mobile child experience

`apps/mobile` (React Native). Child mode: character, tap-to-talk, the immediate acknowledgement fillers that cover the loop latency, offline behaviour, accessibility for pre-readers, session time limits, and the parent gate. Built and profiled against a low-end Android target throughout, not at the end.

---

### Phase 5 — Parent dashboard and parental controls

`apps/web` plus parent mode in mobile. Conversation history and safety flags, time and topic limits, character and language selection, learning progress, data export and deletion (the [PRIVACY.md](PRIVACY.md) rights, actually implemented — not a support-ticket process), and the notification path for escalations.

---

### Phase 6 — Subscriptions and payments

**Gated on the Q-02 decision. This is a business decision that blocks engineering.**

`services/payments`, free-tier quotas, entitlement resolution independent of vendor availability, webhook verification and reconciliation, dunning, and the rails chosen in Q-02.

---

### Phase 7 — Learning features

Pronunciation practice, stories and role-play, progress tracking, and the parent-facing progress view. Sequenced here because each depends on a working, safe, measured voice loop.

---

### Phase 8 — Urdu and multilingual

Full Urdu conversation, code-switching, RTL layout, localised characters and content, and — the part usually underestimated — a safety pipeline that is genuinely as strong in Urdu as in English. A classifier that only works in English is a safety gap, not a localisation gap.

---

### Phase 9 — Hardening and closed beta

Load testing, chaos cases (Redis loss, provider outage), external security review, penetration test, privacy assessment with counsel, incident runbooks, on-call rotation, and a supervised beta with real families under explicit consent.

---

### Phase 10 — Launch

Store submission (both stores review kids-category apps against additional criteria — budget weeks, not days), staged rollout, and the post-launch watch on safety flag rate, cost per conversation, and voice-loop p95.

---

## 3. Pre-phase spikes

Two time-boxed investigations run **before** the phases that depend on them. Each produces a written recommendation, not a prototype we are tempted to ship.

| Spike                    | Question                                                                                                                                                           | Box     | Blocks               |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- | -------------------- |
| **S-1 — Urdu child ASR** | Which STT vendor is usable on 3–10-year-old Pakistani speech, including code-switching? Measured on a purpose-collected, consented sample — not vendor benchmarks. | 2 weeks | Phase 3              |
| **S-2 — Unit economics** | What does one conversation-minute actually cost across AI + STT + TTS, and what does that imply at Pakistani price points?                                         | 1 week  | Phase 6, and pricing |

S-1 requires recordings of real children, which means consent, a lawful basis, and a deletion plan **before** the first recording is made. The spike does not get to skip [PRIVACY.md](PRIVACY.md) because it is "just research".

---

## 4. Risk register

| ID       | Risk                                                                            | Impact       | Likelihood  | Mitigation                                                                                                                                 |
| -------- | ------------------------------------------------------------------------------- | ------------ | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **R-01** | Child-speech ASR, especially Urdu, is too inaccurate for a usable product       | **Critical** | High        | Spike S-1 before Phase 3; STT behind a port; push-to-talk over open-mic; fall back to simpler interaction modes if accuracy caps out       |
| **R-02** | Per-minute AI cost exceeds sustainable Pakistani ARPU                           | **Critical** | High        | Spike S-2; TTS caching; small classifier models; token ceilings; hard spend guards; cost-per-conversation as a tracked metric from Phase 2 |
| **R-03** | Model produces unsafe output to a child                                         | **Critical** | Medium      | Five-layer pipeline, fail-closed, independent deterministic layer, CI safety corpus, review queue, parent visibility                       |
| **R-04** | App-store billing policy conflicts with local rails                             | High         | **Certain** | Q-02 decision before Phase 6; web-first checkout for local rails is one candidate resolution, itself constrained by store rules            |
| **R-05** | Voice-loop latency misses budget on low-end Android over mobile data            | High         | Medium      | Explicit budget, per-stage tracing, immediate acknowledgement fillers, testing on target hardware from Phase 4                             |
| **R-06** | A child discloses harm and we handle it wrongly                                 | **Critical** | Medium      | Q-07 with counsel before launch; defined protocol; never handled ad hoc by an engineer at 2 a.m.                                           |
| **R-07** | Data breach involving child voice or transcripts                                | **Critical** | Low         | Transcribe-and-discard default, encryption, minimisation, least privilege, retention automation, external review in Phase 9                |
| **R-08** | Regulatory change (Pakistan PDP regime, COPPA enforcement, store kids policies) | High         | Medium      | No compliance claims without assessment; retention and residency configurable; counsel engaged before launch                               |
| **R-09** | Parents do not trust an AI talking to their child                               | High         | Medium      | Radical transparency in the dashboard: full history, visible flags, one-tap deletion, plain-language explanation of what is stored         |
| **R-10** | Vendor withdraws or restricts service for minors                                | Medium       | Medium      | Ports; at least two viable adapters for AI and TTS before launch; terms reviewed for minor-user restrictions                               |
| **R-11** | Scope creep across 22 stated capabilities                                       | Medium       | High        | Phase gates, explicit out-of-scope statements, this document as the contract                                                               |
| **R-12** | Pakistani connectivity: intermittent data, low bandwidth                        | Medium       | High        | Resumable uploads, aggressive compression, offline story mode, honest degraded states                                                      |

---

## 5. Sequencing at a glance

```
Phase 0  ████ foundation                                   ✅ complete
         │
S-1 ─────┼───▶ Urdu ASR spike ──────────┐
S-2 ─────┼───▶ unit economics ──────┐   │
         ▼                          │   │
Phase 1  ████ backend + identity    │   │
         ▼                          │   │
Phase 2  ████ conversation + SAFETY │   │
         ▼                          │   │
Phase 3  ████ voice pipeline ◀──────┼───┘
         ▼                          │
Phase 4  ████ mobile child app      │
         ▼                          │
Phase 5  ████ parent dashboard      │
         ▼                          │
Phase 6  ████ payments ◀────────────┴── also gated on Q-02 (business decision)
         ▼
Phase 7  ████ learning features
         ▼
Phase 8  ████ Urdu + multilingual
         ▼
Phase 9  ████ hardening + closed beta
         ▼
Phase 10 ████ launch
```

Deliberately no calendar dates. Phase 3 cannot be estimated before S-1 reports, and Phase 6 cannot be estimated before Q-02 is answered. Dates attached now would be fiction, and fiction in a plan is worse than an admitted unknown.
