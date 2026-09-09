# Privacy and Data Protection

**Status:** Engineering requirements for a system not yet built. This is an internal specification, **not** a user-facing privacy policy, and **not** a compliance certification.
**Companions:** [SECURITY.md](SECURITY.md) · [docs/CHILD_SAFETY.md](docs/CHILD_SAFETY.md) · [ARCHITECTURE.md](ARCHITECTURE.md)

---

## 1. Compliance status — read this first

This document sets out how the system is **designed to handle personal data**, with the intent of supporting a future assessment against COPPA, the GDPR (including provisions specific to children), and Pakistan's data protection regime.

**It does not claim compliance with any of them.** Compliance is established by legal assessment, executed data processing agreements, documented impact assessments, verified consent mechanisms, and demonstrated operating practice over time. Writing code — including code that implements every requirement below — does not produce any of that.

Two consequences follow, and both are binding:

1. No document, README, marketing page, app-store listing, or investor material produced from this repository may state or imply that the product is "COPPA compliant", "GDPR compliant", or equivalent, until counsel has assessed it and said so in writing.
2. Legal review is a **launch blocker**, listed in [DEVELOPMENT_PLAN.md](DEVELOPMENT_PLAN.md) Phase 9, not an optional late step.

---

## 2. The principle everything else follows from

> **Data about a child that we never collect cannot be breached, subpoenaed, sold in a bankruptcy, misused by an employee, or leaked by a vendor.**

Minimisation is not one control among many here. It is the primary control, and it outranks product convenience. When a feature and this principle conflict, the default resolution is that the feature changes.

The sharpest expression of this: **raw child audio is transcribed and discarded immediately by default** (`RETENTION_RAW_AUDIO_DAYS=0`). A child's voice is biometric-adjacent, permanently identifying, unchangeable, and increasingly sufficient to clone that child's speech. Retaining it is the highest-risk data decision available to us, so the default is not to. See [ADR-0006](docs/adr/0006-voice-pipeline-and-audio-retention.md).

---

## 3. Data inventory

Every field below must have a purpose, a lawful basis, a classification, and a retention rule. A field with no stated purpose does not get collected. This table is the authoritative inventory and must be updated in the same pull request that adds a field.

### 3.1 Parent (the account holder and data subject we contract with)

| Data                          | Purpose                                       | Class | Retention                                                                   |
| ----------------------------- | --------------------------------------------- | ----- | --------------------------------------------------------------------------- |
| Email                         | Authentication, security notices, escalations | S1    | Life of account + 30 d                                                      |
| Password hash                 | Authentication                                | S1    | Life of account                                                             |
| Display name (optional)       | Personalisation                               | S1    | Life of account                                                             |
| Country / locale              | Pricing, language, legal routing              | S1    | Life of account                                                             |
| Device identifiers            | Session binding, fraud prevention             | S1    | 90 d after last use                                                         |
| Subscription + payment status | Billing                                       | S1    | 7 years where tax law requires — see [§7](#7-when-deletion-is-not-absolute) |
| Full card numbers             | —                                             | —     | **Never collected.** Payment vendors hold these; we store a token           |

### 3.2 Child (the data subject who cannot consent)

| Data                      | Purpose                                                  | Class  | Retention                                                                           |
| ------------------------- | -------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------- |
| First name or nickname    | The character addresses the child by name                | S2     | Life of profile                                                                     |
| Birth **year and month**  | Age-band derivation                                      | S2     | Life of profile                                                                     |
| Language preference       | STT hints, generation language                           | S2     | Life of profile                                                                     |
| Interests (parent-set)    | Conversation relevance                                   | S2     | Life of profile                                                                     |
| Avatar / character choice | Personalisation                                          | S2     | Life of profile                                                                     |
| **Raw voice audio**       | Transcription only                                       | **S3** | **0 days — discarded immediately post-transcription**                               |
| Conversation transcripts  | Conversation continuity, parent oversight, safety review | **S3** | 90 d default, parent-configurable down to 0                                         |
| Pronunciation attempts    | Practice scoring                                         | **S3** | Score retained; **audio not retained**                                              |
| Learning progress         | Progress tracking                                        | S2     | Life of profile                                                                     |
| Safety flags              | Parent oversight, safety improvement                     | S2     | 365 d                                                                               |
| Full legal name, surname  | —                                                        | —      | **Never collected**                                                                 |
| Date of birth (day)       | —                                                        | —      | **Never collected** — month/year is sufficient for age bands                        |
| Photographs, video        | —                                                        | —      | **Never collected**                                                                 |
| Precise location          | —                                                        | —      | **Never collected**. Country-level only, derived from the parent                    |
| School, address, contacts | —                                                        | —      | **Never collected**, and actively filtered out if a child volunteers them in speech |

That last row is a real requirement, not a formality. Children volunteer their address, school, and full name unprompted. The L4 deterministic filter ([ARCHITECTURE.md §10](ARCHITECTURE.md)) detects and redacts such disclosures **before** the transcript is persisted — so the identifying detail never enters storage in the first place, rather than being stored and then filtered on display.

### 3.3 Operational (S0 — must contain no identifiers)

Aggregate counts, latency histograms, error rates, cost metrics, and pseudonymous product-analytics events. Analytics events carry a rotating pseudonymous profile reference — never a child's name, never transcript text, never audio.

---

## 4. Consent

### 4.1 Who consents

The **parent** consents on the child's behalf. The child is a data subject but not a contracting party.

### 4.2 What consent must be

- **Specific and unbundled.** Separate, independent toggles for: core service, transcript retention, audio retention (default off), product analytics (default off), and any future model-improvement use (default off, see [§5](#5-model-training-and-vendor-use)).
- **Informed.** Plain language a non-technical parent actually reads. Legalese is a dark pattern here.
- **Freely given.** The core product must work with every optional consent refused. Consent that is a precondition for the service is not consent.
- **Withdrawable at any time**, in one place, in the dashboard, with the same number of taps it took to grant. Withdrawal is prospective, and triggers deletion of data collected under it.
- **Recorded**, with version, timestamp, and the exact text shown at the time.

### 4.3 What we cannot do

We cannot verify that the account holder is a parent, or that a stated age is real. Verifiable parental consent as some regimes define it may require mechanisms we have not built — this gap is real and is a question for counsel, tracked as [Q-08](docs/OPEN_QUESTIONS.md). It must not be quietly closed by adding a checkbox that says "I am a parent".

---

## 5. Model training and vendor use

**Child data is never used to train a model.** Not ours, not a vendor's. This is an absolute, not a default.

Concretely, this requires:

1. Provider agreements that contractually exclude our data from training, with the relevant no-training API settings enabled and verified — not merely assumed from a marketing page.
2. Zero-retention or minimum-retention vendor configurations wherever offered.
3. Minimisation _before_ transmission: the model receives the current turn plus bounded context, never a full history, never a child's name where a placeholder works.
4. A vendor with no acceptable data terms is not usable, whatever its quality. This is a hard constraint on vendor selection, and one reason the port abstraction in [ARCHITECTURE.md §8](ARCHITECTURE.md) matters commercially.

If model improvement using conversation data is ever wanted, it requires separate, explicit, opt-in, revocable consent — and its own assessment. It is off by default and out of scope for launch.

---

## 6. Data subject rights

Each right below is a **feature with an owner and tests**, delivered in Phase 5 — not a support-inbox process.

| Right                       | Implementation                                                                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **Access**                  | Parent sees all data for themselves and each child in the dashboard, in readable form                                                      |
| **Portability**             | Self-service export as machine-readable JSON, generated asynchronously, delivered over an authenticated, expiring link                     |
| **Rectification**           | Directly editable in the dashboard                                                                                                         |
| **Erasure — child profile** | Deletes profile, transcripts, learning data, and analytics events. Hard-deleted within 30 days                                             |
| **Erasure — account**       | Deletes everything except the narrow legal-retention set in [§7](#7-when-deletion-is-not-absolute). 30-day grace window, then irreversible |
| **Restriction**             | Pause processing while keeping the account                                                                                                 |
| **Objection**               | Opt out of analytics and any optional processing without losing the service                                                                |

**Deletion means deletion.** Removed from primary storage, from replicas, from caches, from search indices, from backups within the backup rotation window (documented and bounded), and from vendors where they hold anything. A soft-delete flag that hides a row from the UI is not erasure, and calling it erasure in a user-facing document is a misrepresentation.

Target: acknowledgement immediately, completion within 30 days.

---

## 7. When deletion is not absolute

Three narrow exceptions, each with a bounded scope. Being upfront about these is more honest than promising total erasure and quietly retaining records:

1. **Financial records** — transaction records where tax or accounting law requires retention (commonly up to 7 years). Scope: amount, date, and a pseudonymous account reference. **Not** conversations, **not** child data.
2. **Audit and security logs** — 730 days, retaining actor/action/target for breach investigation. **Never content.**
3. **Safety escalation records** — where a legal obligation to retain arises. Governed by [Q-07](docs/OPEN_QUESTIONS.md); scope must be set by counsel, minimised, and access-controlled to a named few.

Anything outside these three is deleted. Any proposal to add a fourth needs a documented legal basis and review.

---

## 8. Retention schedule

Enforced by an automated sweep, not by anyone remembering. Every value is driven by a `RETENTION_*` variable ([docs/ENVIRONMENT.md](docs/ENVIRONMENT.md)) so it is auditable and environment-specific.

| Data                  | Default                      | Configurable by parent                                 |
| --------------------- | ---------------------------- | ------------------------------------------------------ |
| Raw audio             | **0 days (immediate)**       | May opt **in** to retention; never opted in by default |
| Transcripts           | 90 days                      | Yes — down to 0, up to the operator ceiling            |
| Learning progress     | Life of profile              | Deletable                                              |
| Safety flags          | 365 days                     | No (parent can view; deletion would defeat oversight)  |
| Analytics events      | 395 days                     | Opt-out entirely                                       |
| Audit logs            | 730 days                     | No                                                     |
| Deleted-account grace | 30 days                      | No                                                     |
| Backups               | Documented rotation, bounded | No                                                     |

**`RETENTION_TRANSCRIPT_DAYS` is a ceiling, not a target.** Where the operator
policy and the parent's setting differ, the SHORTER one applies. A parent asking
for seven days gets seven; a parent asking for 365 where the policy is 90 gets
90, and is shown 90 rather than their own request read back to them.

The words are **overwritten**, not flagged. The message row survives carrying
only what was never content — role, position, timestamps, token counts — because
safety flags cascade from it, and a retention setting must never become a way to
erase the record that something was flagged. Every sweep writes one audit entry
per child, carrying a count and nothing else, so the promise can be checked
without the check itself holding anything.

The retention sweep is monitored. A sweep that silently stops running is a
privacy incident, and it alerts as one.

---

## 9. Cross-border transfers

The launch market is Pakistan; likely infrastructure and AI vendors are not Pakistan-based. This means child data crosses borders, which has legal consequences we have not yet resolved.

Required before launch: a documented transfer map (what data, to which vendor, in which country, under what agreement), a lawful transfer mechanism per destination, plain-language disclosure to parents, and a hosting-region decision. Tracked as [Q-04](docs/OPEN_QUESTIONS.md).

---

## 10. Breach response

If child data is exposed:

1. **Contain** — revoke, rotate, isolate.
2. **Assess** — exactly which children, exactly what data, over exactly what window.
3. **Notify** — regulators per the applicable deadline (72 hours under several regimes), and affected parents **directly, in plain language, without minimisation**. Parents of affected children are notified even where a regulator does not strictly require it. If a family's child's voice or conversations were exposed, they are told.
4. **Remediate and publish** — fix, then a public post-mortem where it does not compromise ongoing security.

The instinct in this scenario will be to soften the language. The standing instruction is: do not.

---

## 11. Privacy by design in the development process

- Every PR adding a personal-data field updates [§3](#3-data-inventory) in the same PR. A reviewer blocks on this.
- Every new field answers: _do we actually need it?_ The default answer is no.
- New categories of processing get a written assessment before implementation.
- **No production data in non-production environments.** There is no approved anonymisation path for child voice or transcripts — they cannot be meaningfully de-identified, so they are never copied out of production.
- Logging is redacted by construction: the logger cannot emit transcript text or child identifiers ([docs/LOGGING.md](docs/LOGGING.md)).
- Any vendor touching child data gets a data-protection review before integration, not after.

---

## 12. Open privacy questions

| ID                             | Question                                                             | Blocks                    |
| ------------------------------ | -------------------------------------------------------------------- | ------------------------- |
| [Q-04](docs/OPEN_QUESTIONS.md) | Hosting region and data residency                                    | Production infrastructure |
| [Q-07](docs/OPEN_QUESTIONS.md) | Disclosure/escalation protocol and its legal shape in Pakistan       | Launch                    |
| [Q-08](docs/OPEN_QUESTIONS.md) | Verifiable parental consent mechanism                                | Launch                    |
| [Q-11](docs/OPEN_QUESTIONS.md) | Whether transcript retention should default to 0 rather than 90 days | Phase 2                   |

Q-11 deserves a note: 90 days is proposed because conversation continuity and parental oversight both depend on it, but it is the weakest link in the minimisation story above, and it should be argued rather than inherited.
