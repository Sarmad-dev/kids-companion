# ADR-0006: Transcribe-and-discard as the audio default

**Status:** Accepted
**Date:** 2026-08-17
**Deciders:** Engineering, Product

## Context

A voice-first product for children necessarily processes children's voice recordings. Retaining them would be useful: debugging STT failures, improving accuracy, letting parents hear what their child said, scoring pronunciation.

It is also the highest-risk data decision available to us. A child's voice is:

- **Biometric-adjacent** and legally treated as sensitive in several regimes.
- **Permanently identifying and unchangeable.** A leaked password is rotated. A leaked voice is not.
- **Increasingly sufficient to clone that child's speech** with a few seconds of audio.
- **Impossible to meaningfully anonymise.** The identifying characteristic _is_ the signal.

A breach of a corpus of children's voice recordings, tied to families, is not a bad quarter. It is the end of the product and a lasting harm to real children.

## Decision

**Raw child audio is transcribed and discarded immediately.** `RETENTION_RAW_AUDIO_DAYS=0` is the default in every environment, and a non-zero value in production fails boot without an explicit acknowledgement variable ([ENVIRONMENT.md §3](../ENVIRONMENT.md)).

Retention is available only under **explicit, specific, revocable parent opt-in**, never bundled with other consent and never on by default.

**Pronunciation practice retains the score, never the recording.**

## Options considered

### Option A — Retain audio by default with a retention window

Best for debugging and quality improvement. Creates exactly the corpus described above. Rejected — the operational benefit does not come close to the risk.

### Option B — Retain audio only when a turn is flagged by safety

Superficially appealing: keep the evidence for the cases that matter. But it builds a corpus of recordings of children in their most sensitive moments — distress, disclosure, difficulty. That is the _worst_ possible subset to retain, not the safest.

### Option C — Transcribe and discard _(chosen)_

Audio exists in memory and transient storage only long enough to transcribe, then is deleted. A nightly sweep deletes any artefact that survived, as a backstop against a failed cleanup path.

### Why this won

It follows directly from the governing principle in [PRIVACY.md §2](../../PRIVACY.md): data we never hold cannot be breached, subpoenaed, sold in a bankruptcy, misused by an employee, or leaked by a vendor.

The lost debugging capability is real, and is replaced with things that carry far less risk: STT confidence scores, audio duration, transcript length, error rates, and — for accuracy work — a separately consented, purpose-collected evaluation corpus with its own lifecycle and deletion plan ([spike S-1](../../DEVELOPMENT_PLAN.md)). That corpus is a bounded research asset, not a byproduct of every child's daily use.

Option B deserves the explicit rejection: the instinct to "keep the flagged ones" is strong and it is exactly backwards.

## Consequences

**Positive.** No standing corpus of children's voices. A database breach exposes no audio. Vendor risk drops sharply. The strongest possible answer to a parent asking "do you keep recordings of my child?" — no, and it is verifiable in configuration.

**Negative.** Debugging a specific bad transcription is materially harder, and we will feel that. Parents cannot replay their child's audio. Any future model improvement using real audio requires a separate, consented programme rather than reaching for data we already have.

**Risks.** The main one is drift: pressure to retain "just for a week, just for debugging" will recur, and each time it will sound reasonable. The mitigations are structural rather than cultural — the production boot check, and the fact that changing this default requires superseding this ADR rather than editing an environment variable.

A second risk is incomplete deletion: audio surviving in a vendor's systems, a queue, or a temporary buffer. Mitigations: zero-retention vendor configurations verified rather than assumed, the nightly backstop sweep, and a test asserting the artefact is gone after transcription.

## As implemented

The decision above is enforced in three places rather than one, because a single check is a single thing to forget.

**`resolveRetention()`** (`services/voice/src/retention.ts`) is the only function that can decide audio survives a turn, and it requires all three of: `RETENTION_RAW_AUDIO_DAYS > 0`, a live `audio_retention` consent for that specific child, and the artefact being a child upload rather than a synthesised reply. A reader can see every input in one screen.

**`audio_artifacts`** is a ledger, not a store — there is no `bytea` column and there must never be one. `expires_at` is `NOT NULL` with no default, so an artefact that did not state its lifetime cannot be inserted. Parents hold `SELECT` and nothing else: a retention window a user can lengthen is not a retention window.

One correction worth recording: the table originally carried `check (expires_at > created_at)`, which made a lifetime impossible to **shorten**. Revoking consent, responding to an incident, and "delete my child’s recording now" are all "set `expires_at` to the past". The constraint protected nothing and forbade the operation that matters most; it was removed. A test that tried to expire audio early is what found it.

**Expiry is enforced on read**, not only by the sweep. A sweep that has not run yet, or that failed last night, must never be the reason a child’s audio is still served. The sweep reclaims bytes; the read is what enforces the policy.

The retention **decision** is written to the audit log on every voice turn, so "were recordings kept?" is answerable from the audit trail rather than by trusting that a configuration value was what someone said it was.

### What is still open

- The object-store adapter is not written; the in-memory implementation is real (it enforces expiry, sweeps, and bounds itself) but is per-process. Multi-instance deployment needs the durable one.
- **Vendor-side retention is asserted, not verified.** The Deepgram adapter sends `mip_opt_out` on every request rather than relying on an account setting, which is the right shape — but it is not evidence that no audio is retained anywhere in their infrastructure. That has to be established contractually and confirmed. Until it is, the adapter is not cleared for production traffic.
- Neither the STT nor the TTS adapter has been exercised against its live API.

---

## Revisit when

A regulator, or counsel, requires retention for a defined purpose — in which case the scope must be minimised, opt-in, and separately documented. Product convenience is not a trigger.
