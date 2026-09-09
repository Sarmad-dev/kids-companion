# Child Safety Requirements

**Status:** Requirements for a system not yet built. Sections marked ⚠️ require expert and legal input that has not been obtained.
**This document outranks product requirements.** Where a feature and a rule here conflict, the feature changes.

---

## 1. Why this document exists separately

Safety here is not a content-filtering feature. The user is a 3–10-year-old who trusts a character that talks back, cannot evaluate what it says, cannot recognise manipulation, and may treat it as a friend. That trust is the product's value and its central risk at the same time.

Three consequences run through everything below:

1. **A single unsafe interaction is a product-ending event**, not a bug with a severity rating.
2. **The child cannot report a problem.** They will not tell anyone the character said something strange. Detection must be automatic.
3. **We are not neutral infrastructure.** We designed a system to be trusted by children. The obligations follow from that.

---

## 2. Non-negotiable rules

These are invariants. Changing one requires an ADR and sign-off from whoever owns safety, not a pull request.

| #    | Rule                                                                                                                                                                                                          |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S-1  | **Safety fails closed.** A classifier that errors, times out, or is unavailable blocks the turn. No configuration makes it fail open.                                                                         |
| S-2  | **The companion never claims to be human.** If asked, it says plainly that it is not a person. It never denies being an AI, and never role-plays being a real person the child knows.                         |
| S-3  | **The companion never elicits personal information.** Not name, school, address, family details, location, or photos. It changes the subject if a child volunteers them.                                      |
| S-4  | **The companion never asks a child to keep a secret from a parent.** Not in a game, not in a story, not in role-play. This is the single strongest correlate of grooming behaviour and has no legitimate use. |
| S-5  | **The companion never facilitates contact with anyone.** No links, no external content, no messaging, no user-to-user surface. **There is no child-to-child interaction anywhere in this product.**           |
| S-6  | **The companion never gives medical, legal, or crisis advice**, and never diagnoses. It routes to a trusted adult.                                                                                            |
| S-7  | **The companion never discourages a child from talking to a parent or trusted adult.** It actively encourages it in any sensitive context.                                                                    |
| S-8  | **No advertising, no commercial content, no upsell reaches child mode.** Monetisation is a parent-mode surface.                                                                                               |
| S-9  | **No dark patterns.** No streaks, no loss framing, no artificial urgency, no engagement-maximising design aimed at a child. Session limits exist to _end_ sessions.                                           |
| S-10 | **A parent can always see everything and delete everything.** Nothing about a child is hidden from their parent by the product.                                                                               |

### 2.1 On S-9

Standard engagement mechanics — streaks, variable rewards, "your friend misses you" notifications — work on children far better than on adults, which is exactly why they are prohibited here. A companion that maximises session length is a companion optimising against the child's interest. Success is measured by whether parents find it valuable, not by minutes per day.

---

## 3. The safety pipeline

Five layers, each able to independently stop a turn. Mechanism is in [ARCHITECTURE.md §10](../ARCHITECTURE.md); this section covers policy.

```
child utterance
   │
 ┌─▼── L1  INPUT CLASSIFICATION ─────────────────────────────┐
 │ distress · disclosure · unsafe topic · PII · injection    │
 └─┬─────────────────────────────────────────────────────────┘
   │
 ┌─▼── L2  CONSTRAINED GENERATION ───────────────────────────┐
 │ versioned prompt + age band + persona + refusal list      │
 └─┬─────────────────────────────────────────────────────────┘
   │
 ┌─▼── L3  OUTPUT CLASSIFICATION (streamed, halts mid-stream)┐
 └─┬─────────────────────────────────────────────────────────┘
   │
 ┌─▼── L4  DETERMINISTIC FILTERS ────────────────────────────┐
 │ blocklists · URL/contact stripping · PII-elicitation      │
 └─┬─────────────────────────────────────────────────────────┘
   │
 ┌─▼── L5  ASYNCHRONOUS REVIEW ──────────────────────────────┐
 │ flagged + sampled turns · parent visibility · iteration   │
 └───────────────────────────────────────────────────────────┘
```

**L4 is not redundant with L1 and L3.** Those are both models and share a failure mode: an input crafted to fool one often fools the other. A deterministic filter fails differently, which is the entire point of having it.

### 3.1 As implemented

The layers above are delivered as three named stages — `INPUT_SAFETY_CHECK`, `AI_GENERATION`, `OUTPUT_SAFETY_CHECK` — in `@kids/safety`, a package that is independent of the conversation logic it guards and imports nothing from it.

**[SAFETY_SUBSYSTEM.md](SAFETY_SUBSYSTEM.md) is the implementation reference**, including the harm taxonomy, the configurable policy table, the escalation rules, and — in its §9 — the specific things this machinery cannot do. Read that §9 before quoting any number from this system.

---

## 4. Content policy by age band

| Band         | Ages | Turn length         | Notable constraints                                                                      |
| ------------ | ---- | ------------------- | ---------------------------------------------------------------------------------------- |
| `early`      | 3–4  | ≤ 2 short sentences | Concrete only. No abstraction. No conflict in stories. Heavy affirmation and repetition. |
| `emerging`   | 5–6  | ≤ 3 sentences       | Simple narrative. Gentle problems with immediate resolution.                             |
| `developing` | 7–8  | ≤ 4 sentences       | Mild story tension permitted, always resolved within the session.                        |
| `fluent`     | 9–10 | ≤ 6 sentences       | Broader topics, richer vocabulary. Same hard boundaries.                                 |

**Age bands narrow what is permitted; they never widen it.** A topic prohibited at 3 is not permitted at 10 by default — the prohibited list in §5 applies to every band.

Age comes from the parent-declared birth month and year. We cannot verify it, and a system whose safety depends on an unverifiable self-declaration is a system whose baseline must be safe for the youngest user.

---

## 5. Prohibited content

Always refused, at every age band, in every language, in every mode including story and role-play:

- Violence, gore, weapons, death as spectacle
- Sexual content of any kind, in any framing
- Substances, self-harm methods, dangerous activities presented as achievable
- Hate, slurs, demeaning content about any group
- Frightening or horror content, threats, or content designed to distress
- Political persuasion, religious proselytising or disparagement
- Instructions for anything unsafe to attempt
- Personal-information elicitation of any kind
- Anything sexualising, objectifying, or isolating a child
- Real-world contact facilitation

### 5.1 Handled with care rather than refused

Children ask about hard things because they are experiencing them, and a flat refusal teaches a child that this companion is not a place to bring a real question. These topics are answered briefly, honestly, age-appropriately, and always with redirection to a trusted adult:

Death and loss · illness · family conflict, separation, divorce · fear and anxiety · bullying · loneliness · big feelings.

The response pattern: acknowledge the feeling, one honest simple sentence, then point to a trusted adult. Never a lecture, never a diagnosis, never advice.

---

## 6. Distress and disclosure ⚠️

**This section is incomplete and blocks launch. It requires child-protection expertise and Pakistani legal counsel — it is not an engineering decision.** Tracked as [Q-07](OPEN_QUESTIONS.md).

Some children will tell this companion things they have told no one. Given a large enough user base, this is a certainty, not a possibility. A child may disclose abuse, neglect, self-harm, or someone hurting them.

### 6.1 What is already settled

Regardless of how Q-07 resolves, these hold:

1. **Never silently swallow a disclosure.** Blocking the turn and moving on is the worst possible response — it teaches a child that disclosure produces nothing.
2. **The companion never investigates.** No follow-up questions, no probing for detail, no "tell me more". Questioning a child about suspected abuse without training can harm the child and damage any subsequent investigation.
3. **The companion responds warmly, validates, and points to a trusted adult** — with wording written by child-protection professionals, not by engineers, and not generated by a model.
4. **The companion never promises confidentiality**, and never implies the conversation is private from the child's parent.
5. **Escalation is recorded and routed** to a defined human path — never handled ad hoc by whoever is on call.
6. **A trained human is in the loop.** An automated pipeline does not decide what happens after a disclosure.
7. **Detection is high-recall by design.** A false positive costs a reviewer's time. A false negative costs something we do not get to fix.

### 6.2 What is unresolved ⚠️

- Who is notified, and when. **The default assumption — notify the parent — is unsafe when the disclosure concerns the parent.**
- Whether any mandatory-reporting duty applies to us under Pakistani law, and how it interacts with the international markets that follow.
- What is retained, for how long, and who may read it — against a privacy posture that otherwise minimises aggressively.
- What a trained human reviewer sees, and what qualifications that role requires.
- Whether operating at all in a jurisdiction where we cannot route a disclosure responsibly is defensible.

**We do not launch without answers.** Shipping a product that children will disclose to, without a protocol for what happens next, is not an acceptable risk to carry into production.

---

## 7. Prompt and persona discipline

- Prompts are **versioned artefacts** under review, stored in `services/ai`, never string literals in a handler. A prompt change is a safety change and reviewed as one.
- Characters differ in **voice and manner only**. A persona never alters safety policy. "Playful Pirate" is not permitted more violence.
- **Role-play boundaries are enforced outside the model.** A child cannot instruct the companion out of its constraints by framing it as a game, and the boundary check does not itself depend on the model that is being asked to break character.
- The system prompt is never revealed to a child, and never treated as a security boundary. It is a behavioural instruction; L1/L3/L4 are the enforcement.

---

## 8. Parental oversight

The parent must be able to, at any time: read every conversation, see every safety flag with what happened, set time/topic/character/language limits, end a session remotely, export everything, and delete everything.

**Safety flags are shown to parents even when the block worked.** A parent finding out that their child asked about something concerning is the entire point of oversight. Hiding successful blocks to keep a dashboard looking clean would be a betrayal of the reason parents installed this.

---

## 9. Verification before launch

| Requirement           | Gate                                                                                                                    |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Safety corpus in CI   | Regression fails the build ([TESTING_STANDARDS.md §5.3](TESTING_STANDARDS.md))                                          |
| Fail-closed proven    | Every layer: error, timeout, malformed → blocked                                                                        |
| Red-teaming           | External, adversarial, **including Urdu and code-switched inputs**                                                      |
| Age-band verification | All four bands, every adaptive behaviour                                                                                |
| Multilingual parity   | **A classifier weaker in Urdu than English is a safety gap, not a localisation gap** — and is a launch blocker for Urdu |
| Expert review         | Child-development and child-protection review of prompts, personas, and §6 wording                                      |
| Q-07 resolved         | Disclosure protocol defined, staffed, and rehearsed                                                                     |

### 9.1 The multilingual point, stated bluntly

Safety classification quality drops sharply outside English, and Pakistani households code-switch mid-sentence. Shipping Urdu conversation with English-grade safety and Urdu-grade classification would mean the children in our launch market get the weaker protection. That is backwards, and it is not shippable.

---

## 10. Operating after launch

- **Review queue**: every flagged turn plus a random sample, reviewed by trained people under access control, with the strictest retention. Reviewers see the minimum necessary and their access is audited.
- **Feedback loop**: every real miss becomes a safety-corpus entry in the same PR as the fix.
- **Parent reports**: a one-tap "this was wrong" on any turn, triaged within one business day.
- **Incident response**: unsafe output reaching a child is a **Critical** incident — same severity as a data breach. Contain, assess scope, notify affected parents directly, remediate, publish.
- **Monitoring**: block rate by layer and language, escalation rate, review queue latency, parent report rate. A block rate that suddenly _drops_ is as alarming as one that spikes — it usually means a classifier stopped working.

---

## 11. What we cannot promise

- **We cannot guarantee an unsafe output never reaches a child.** The pipeline reduces probability; it does not eliminate it. Anyone who claims otherwise about an LLM product is wrong, and the entire operational apparatus in §10 exists because the residual risk is permanent. The implemented limitations are enumerated individually in [SAFETY_SUBSYSTEM.md §9](SAFETY_SUBSYSTEM.md#9-known-limitations-).
- **We cannot verify a child's age**, or that the account holder is their parent.
- **We cannot protect a child from a hostile adult in their own household** ([SECURITY.md §10](../SECURITY.md)).
- **We cannot replace human relationships**, and must not be designed to. A product a child prefers to their parents has failed, however good its engagement metrics look.
