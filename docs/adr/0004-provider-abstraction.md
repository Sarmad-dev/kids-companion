# ADR-0004: Ports and adapters for all external providers

**Status:** Accepted
**Date:** 2026-08-17
**Deciders:** Engineering

## Context

The product depends on external providers for conversation generation, safety classification, speech-to-text, text-to-speech, object storage, and payments. Every one of these is volatile:

- **AI**: model pricing and quality shift on a monthly cadence, and per-turn cost is an existential constraint ([R-02](../../DEVELOPMENT_PLAN.md)).
- **STT**: the vendor is genuinely undecided pending Urdu child-speech evaluation ([Q-01](../OPEN_QUESTIONS.md)). We must be able to build before knowing the answer.
- **Payments**: Pakistani rails, international rails, and app-store billing are three different worlds ([Q-02](../OPEN_QUESTIONS.md)).
- **All of them**: a vendor may restrict service for minors, or fail a data-protection review ([PRIVACY.md §5](../../PRIVACY.md)), and we would need to exit quickly.

## Decision

Every external capability sits behind a **port** — an interface we own, expressed in our domain types — with one or more **adapters**, plus a **mock adapter that is the default in `local` and `ci`**.

Ports committed to in Phase 1: `ConversationProvider`, `SafetyClassifier`, `SpeechToTextProvider`, `TextToSpeechProvider`, `PaymentProvider`, `ObjectStorage`.

## Options considered

### Option A — Call vendor SDKs directly

Fastest to write, and honest about the fact that abstractions leak. But it makes vendor types structural: swapping STT would touch every layer, and — given Q-01 — we do not know the vendor yet. It also makes testing require either live calls or SDK-shaped mocks that drift.

### Option B — A thin wrapper per vendor

Better, but a wrapper shaped by whichever vendor came first. The second vendor either does not fit or forces the interface to widen until it is a union of vendor capabilities, which is not an abstraction.

### Option C — Ports and adapters with shared contract tests _(chosen)_

Interfaces designed around **our domain needs**, not around any vendor's API, with one contract suite every adapter must pass identically.

### Why this won

The contract suite is what makes this real rather than architectural decoration. Every adapter — including the mock — passes the same tests, including the unhappy paths vendors differ on: timeout, rate limit, malformed response, partial stream, mid-request network failure. That is what turns "swap the vendor" into a configuration change with evidence behind it.

It also has a direct product consequence: because the mock is the default locally and in CI, **a fresh clone runs the full loop with no API keys**. Contributors are never handed credentials to do ordinary work, which removes a whole class of secret-handling risk from onboarding.

## Consequences

**Positive.** Vendor swaps are configuration plus one adapter. No keys needed for development. Contract tests make adapters comparable. Vendor errors map into our taxonomy at the boundary ([ERROR_HANDLING.md §6](../ERROR_HANDLING.md)) instead of leaking upward. Cost and latency are recorded under identical metric names regardless of vendor.

**Negative.** More code than calling an SDK. A genuinely vendor-specific capability either does not get used or forces a port revision — accepted deliberately, since the alternative is a port shaped like one vendor. The mock must be maintained or it drifts into a fiction that passes tests nothing else does.

**Risks.** The mock diverging from real behaviour is the main one; the contract suite is the mitigation, and any real-world behaviour the mock got wrong becomes a contract test in the same PR as the fix. A port designed too early around one vendor's model is the other; mitigated by designing each port from what the _domain_ needs, and revising once a second adapter exists.

## Revisit when

A port needs a third revision to fit a new adapter — that means it was modelled on a vendor rather than on the domain, and the port itself is wrong.
