# Open Questions

Decisions deliberately **not** made in Phase 0. Recorded openly because an unresolved question that is written down gets answered, and one that is quietly assumed becomes an incident.

**Convention:** every question has an owner, a decision deadline expressed as a phase gate, and a stated consequence of getting it wrong. A question is closed by an ADR, and this row then links to it.

| Status          | Meaning                                               |
| --------------- | ----------------------------------------------------- |
| 🔴 **Blocking** | Work cannot proceed past a named gate                 |
| 🟠 **Open**     | Needs an answer before the phase that consumes it     |
| 🟡 **Deferred** | Deliberately postponed; revisit at the stated trigger |

---

## 🔴 Blocking

### Q-01 — Which STT provider works on Pakistani children's speech?

**Owner:** Engineering · **Gate:** before Phase 3 · **Via:** spike S-1

Child speech recognition is materially worse than adult speech recognition — higher pitch, developing articulation, unpredictable pacing. Urdu has far less training data than English, and Pakistani families code-switch mid-sentence. Vendor benchmarks are published on adult, monolingual, studio audio and tell us nothing useful here.

**Resolve by:** collecting a consented, purpose-built evaluation sample of 3–10-year-olds speaking Urdu, English, and mixed; measuring WER per vendor per age band; and setting a usability floor before seeing the results, so the floor is not retrofitted to whichever vendor wins.

**If accuracy caps out below usable:** the interaction model changes — shorter constrained utterances, richer visual affordances, tap-plus-speak — or Urdu voice ships later than Urdu text. It does not mean shipping a companion that misunderstands children, which trains them that it does not work.

**Cost of getting it wrong:** the core interaction fails and no other quality matters.

---

### Q-02 — App-store billing versus Pakistani payment rails

**Owner:** Business + Legal · **Gate:** before Phase 6

Apple and Google require digital subscriptions sold inside a mobile app to use their billing, at roughly 15–30 %. JazzCash and Easypaisa are how the launch market actually pays; card penetration is low. These two facts are in direct conflict, and store policies on steering users to external payment differ by jurisdiction and keep changing.

**Candidate resolutions:** store billing everywhere and absorb the margin; web-first checkout with the app as a pure client (constrained by steering rules); store billing internationally with local rails on web for Pakistan; or a non-subscription model.

**This is a business and legal decision, not an engineering one.** The `PaymentRailAdapter` port means engineering is not blocked on building — but pricing, unit economics, and the entire funnel are.

**What engineering has done anyway (2026-08-19):** four adapters — JazzCash, Easypaisa, carrier billing, cards — behind one interface, each with a working sandbox and a verification checklist. **None is production-ready**, and `PAYMENTS_VERIFIED_RAILS` makes a deployed environment refuse to boot with an unverified rail enabled. See [PAYMENT_RAILS.md](PAYMENT_RAILS.md).

Two findings that feed back into this decision rather than out of it:

- **Carrier billing probably cannot refund**, and anyone holding the family's phone can authorise a charge. In a children's product that is a safety consideration, not only a billing one.
- **Wallet transaction ceilings are unknown and may be low enough** that the yearly plan is simply unpayable on the domestic rails. That constrains the plan catalogue, not just the adapter.

**Cost of getting it wrong:** margin destroyed, or app rejected at review.

---

### Q-07 — The disclosure and escalation protocol

**Owner:** Legal + child-protection expertise · **Gate:** before launch

Children will disclose abuse, neglect, or self-harm to this companion. At scale this is a certainty. [CHILD_SAFETY.md §6](CHILD_SAFETY.md) settles what happens technically; it does not settle what happens humanly or legally.

**Unresolved:** who is notified and when — noting that **the obvious answer, notify the parent, is unsafe when the disclosure concerns the parent**; whether any mandatory-reporting duty attaches to us in Pakistan and in each expansion market; what is retained, for how long, and who may read it, against a privacy posture that otherwise minimises hard; what qualifications a human reviewer needs; and whether operating in a jurisdiction where we cannot route a disclosure responsibly is defensible at all.

**Cost of getting it wrong:** a child is harmed and we handled the moment badly. This is the most serious question in the document, and it is not one engineering can answer alone.

---

### Q-08 — Verifiable parental consent

**Owner:** Legal · **Gate:** before launch

Several regimes require _verifiable_ parental consent for processing a young child's data, and an email-plus-checkbox may not satisfy it. Some accepted methods (a nominal card charge, government ID) are hostile to the launch market or collect more data than we want to hold — which sits badly against [PRIVACY.md §2](../PRIVACY.md).

**Cost of getting it wrong:** regulatory exposure and a mandated re-consent of the entire user base.

---

## 🟠 Open

### Q-03 — Fastify plugin boundaries versus a service layer

**Owner:** Engineering · **Gate:** early Phase 1

Fastify's encapsulation can carry a lot of structure. The risk is business logic accreting inside plugins, coupling the domain to HTTP and making it untestable without a server. Leaning toward thin plugins over a framework-free service layer, but the boundary should be settled before it is set by accident in the first ten routes.

---

### Q-04 — Hosting region and data residency

**Owner:** Engineering + Legal · **Gate:** before production infrastructure

Latency argues for a region near Pakistan (Middle East or South Asia). Availability of managed Supabase and Redis regions, AI provider latency from that region, cost, and any residency requirement all pull differently. Child data crossing borders has legal consequences we have not resolved ([PRIVACY.md §9](../PRIVACY.md)).

---

### Q-06 — Does pronunciation practice need a specialised model?

**Owner:** Engineering · **Gate:** Phase 7

General STT returns a transcript, not phoneme-level accuracy. Useful pronunciation feedback needs forced alignment or a dedicated assessment API. Options: a specialised vendor, a coarser word-level heuristic, or narrowing the feature.

**Whatever the answer:** **pronunciation audio is not retained.** The score is kept; the recording is not ([PRIVACY.md §3.2](../PRIVACY.md)).

---

### Q-09 — Realtime transport

**Owner:** Engineering · **Gate:** Phase 3 measurement, decide in Phase 4

Phase 1–3 use HTTP request/response per turn — simplest to make correct and to retry on a flaky connection. WebSocket or WebRTC could cut several hundred milliseconds by streaming STT and TTS.

**Decide with evidence, not preference.** If the measured p95 meets the budget in [ARCHITECTURE.md §7.1](../ARCHITECTURE.md), the added complexity — connection state, reconnection, mid-turn resumption on a mobile network that drops constantly — is not obviously worth it.

---

### Q-10 — Character voices, and who owns them

**Owner:** Product + Legal · **Gate:** Phase 3

Synthesised, licensed, or commissioned? Each has different cost, quality, and licensing consequences. A distinctive voice is a real brand asset; a voice we do not own is a dependency that can be withdrawn or repriced.

**Constraint:** no character voice may be a clone of a real identifiable person, and no voice model may ever be built from a child's voice.

---

### Q-11 — Should transcript retention default to 0 rather than 90 days?

**Owner:** Product + Engineering · **Gate:** Phase 2

90 days is proposed because conversation continuity ("remember the story we started?") and parental oversight both depend on retained transcripts. But it is the weakest link in the minimisation story in [PRIVACY.md §2](../PRIVACY.md), and it deserves to be argued rather than inherited.

**Middle grounds:** retain a short rolling window for continuity plus a longer-lived non-verbatim summary; or make the default 0 with retention as an explicit parent opt-in, matching how audio is treated.

---

### Q-17 — TypeScript 6 versus 7

**Owner:** Engineering · **Gate:** revisit each quarter

TypeScript 7.0 (the native compiler) is the current `latest` and is dramatically faster. The workspace is pinned to **TypeScript 6.0.3** anyway, because `typescript-eslint` 8.x does not support the TS 7 API — attempting it fails at config load, taking the entire lint layer with it. Upstream tracks support for TS ≥ 7.1.

Lint is not optional here: it enforces the dependency-direction rules, the `@kids/types` purity rule, `no-console`, and the `Clock` injection rule. A faster compiler is not worth losing the layer that enforces the architecture.

**Revisit when** `typescript-eslint` ships TS 7 support. The migration should be a version bump — the compiler options in `tsconfig.base.json` are all supported on both lines.

---

### Q-12 — What "learning progress" actually measures

**Owner:** Product + education expertise · **Gate:** Phase 7

Vocabulary exposure and turn counts are easy to measure and mostly meaningless as learning outcomes. A dashboard implying educational progress it cannot evidence misleads parents — and parents are the buyers, which makes the temptation to overstate it structural.

**Constraint:** we do not claim a learning outcome we cannot support. Reporting engagement honestly is better than reporting education dishonestly.

---

## 🟡 Deferred

### Q-13 — Offline mode scope

**Trigger:** post-launch usage data. Connectivity in the launch market is intermittent ([R-12](../DEVELOPMENT_PLAN.md)). Cached stories and pre-synthesised content are plausible; on-device inference for a full conversation is not, on the target hardware.

### Q-14 — Additional languages beyond Urdu and English

**Trigger:** post-launch demand. Punjabi, Sindhi, Pashto, Arabic. Each needs STT quality, TTS quality, **and safety-classifier parity** — the third is the one that gets forgotten, and it is the one that matters ([CHILD_SAFETY.md §9.1](CHILD_SAFETY.md)).

### Q-15 — Multi-parent and guardian accounts

**Trigger:** Phase 5 feedback. Two parents, separated parents, grandparents, a caregiver. Genuinely complex where custody arrangements are contested — and the answer interacts directly with Q-07.

### Q-16 — Web child experience

**Trigger:** post-launch. Currently mobile-only for child mode; `apps/web` is parent-facing. A browser child experience needs its own safety review of a very different platform surface.

---

## Closed

Each closure adds a row here with a link to the ADR that made it.

| ID   | Question                            | Resolved by                                                                                                                                                                                                                                                                                         | Date       |
| ---- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| Q-05 | pnpm `node-linker` and React Native | [ADR-0008](adr/0008-build-orchestration-and-module-linking.md) — `hoisted` workspace-wide. The per-project fallback this question proposed turned out not to exist: `node-linker` is an install-wide pnpm setting. The phantom-dependency guarantee moved to `import-x/no-extraneous-dependencies`. | 2026-08-17 |
