# The child–AI safety subsystem

**Status:** implemented · **Package:** `@kids/safety` (`services/safety`) · **Policy:** `safety_policies` · **Events:** `content_flags`

[CHILD_SAFETY.md](CHILD_SAFETY.md) states the policy — what must never happen, and what must happen when a child discloses something. This document describes the machinery that enforces it, and, in [§9](#9-known-limitations-), the specific things that machinery cannot do.

Read §9 before quoting any number from this system.

---

## 1. Why it is a separate package

`@kids/safety` imports nothing from `@kids/ai`. The dependency runs one way: the conversation engine depends on safety, and safety depends on a narrow classifier interface that somebody else implements.

That boundary is doing real work.

- **The safety layer is not a feature of the conversation feature.** When the two live in one module, every change to conversation behaviour is a change to the safety surface, and safety rules end up being reasoned about in terms of conversation flow rather than on their own terms.
- **The engine cannot weaken a decision, even accidentally.** It receives a verdict and acts on it. There is no code path in `engine.ts` that can turn a `block` into an `allow`.
- **It is reusable.** `guardedTurn()` wraps any generator. The conversation engine today; a story generator, a speech-practice prompt, or a parent-facing summariser tomorrow — all three stages, same rules, no new safety code.
- **It is testable without a model.** The adversarial corpus runs in milliseconds against a three-line fake classifier, which is why it can run on every commit rather than nightly.

```
apps/api ──────► @kids/ai ──────► @kids/safety
   │                 │                  ▲
   │                 └── providerAsClassifier() ─┘   the only meeting point
   │
   └── safety-store.ts ─► safety_policies (policy)
                        └► app.recent_safety_blocks() (attempt counts)
```

---

## 2. The three stages

```
                    ┌──────────────────────┐
child utterance ───►│  INPUT_SAFETY_CHECK  │
                    └──────────┬───────────┘
                               │ stopped ──────────► safe response, event, no provider call
                               │ allowed
                    ┌──────────▼───────────┐
                    │     AI_GENERATION    │   caller-supplied; safety knows nothing about it
                    └──────────┬───────────┘
                    ┌──────────▼───────────┐
                    │ OUTPUT_SAFETY_CHECK  │
                    └──────────┬───────────┘
                               │ stopped ──────────► safe response, event
                               │ allowed
                          reply to child
```

Mapped onto the five-layer model in [CHILD_SAFETY.md §3](CHILD_SAFETY.md#3-the-safety-pipeline): `INPUT_SAFETY_CHECK` is L1 plus deterministic input rules, `AI_GENERATION` is L2, `OUTPUT_SAFETY_CHECK` is L3 and L4 together, and the event it writes feeds L5.

A verdict reports which individual layers cleared, not just whether the stage passed. **L4 catching what L3 passed is the single most valuable signal this system produces** — it is direct evidence that the classifier missed something — and collapsing both into "the output stage said no" would throw it away.

### Two ordering decisions worth knowing

**On input, deterministic rules run first and a stop skips the classifier.** This is a privacy property before it is a latency one: a message the local layer has already judged unsafe is never transmitted to a third party at all.

**On output, both layers always run.** A model that has produced one problem has often produced two, and the two layers answer different questions.

---

## 3. The taxonomy

One list, in `categories.ts`, used by the classifier port, the detectors, the policy table, and the event log — so a category cannot mean one thing in a policy row and something else in a detector. Grouped by what the product must **do**, because that is the distinction that gets lost.

| Group          | Categories                                                                                                                    | Default treatment                                   |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| **Prohibited** | `sexual_content` `violence` `weapons` `dangerous_activities` `drugs` `hate` `harassment` `abuse` `exploitation` `frightening` | Blocked both directions                             |
| **Boundary**   | `personal_data_request` `secret_keeping` `inappropriate_relationship` `impersonation`                                         | Blocked; three of the four escalate                 |
| **Advice**     | `unsafe_medical_advice` `unsafe_psychological_advice`                                                                         | Blocked on output                                   |
| **Signal**     | `self_harm` `disclosure_of_harm` `distress_signal`                                                                            | **Redirected warmly and escalated — never refused** |
| **Attack**     | `prompt_injection`                                                                                                            | Redirected, treated as a game a child is playing    |

The Signal row is the one that is easy to get wrong. A child saying one of those things is **disclosing**, not producing prohibited content, and the correct response is a warm reply that names a trusted adult plus a human in the loop. Blocking it and moving on teaches a child that telling someone produces nothing ([CHILD_SAFETY.md §6.1](CHILD_SAFETY.md#6-distress-and-disclosure-)).

`unsafe_medical_advice` explicitly covers diagnosis of speech and developmental conditions. That is the boundary this product could most plausibly drift across, because it listens to children talk for a living.

---

## 4. Policy is data

Thresholds, actions, and escalation rules live in `safety_policies`, not in code, so tightening a rule after a real-world miss is an `UPDATE` rather than a release. A safety fix that needs a deploy is a safety fix that ships on Monday.

| Column           | Meaning                                                                                       |
| ---------------- | --------------------------------------------------------------------------------------------- |
| `category`       | From the taxonomy above. Free text, not a CHECK — adding a category must not need a migration |
| `age_group`      | `*` or a specific band. **Most specific wins**                                                |
| `applies_to`     | `child_input` / `model_output` / `both`                                                       |
| `action`         | `allow` · `observe` · `redirect` · `block` · `end_session`                                    |
| `min_confidence` | Classifier confidence floor. Deterministic detectors report 1.0 and are unaffected            |
| `escalates`      | Whether this routes to a human                                                                |
| `rationale`      | **Required.** A threshold with no stated reason is one nobody can safely change later         |

Four guarantees hold regardless of what is in the table:

1. **An unknown category blocks.** A category with no rule is not a category to wave through.
2. **The compiled-in escalation set is a floor.** A policy row that forgets to escalate a disclosure does not stop it escalating.
3. **An unusable table falls back to `DEFAULT_POLICY`**, which is at least as strict as the seeded rows. A database problem must never widen what a child can be shown.
4. **A parent can read the policy and cannot write it.** Parents narrow what their own child sees, via their own content settings; they never widen the product-level floor.

The API serves the policy through a cached synchronous getter refreshed in the background, so a check never waits on a query and a policy lookup can never be the thing that fails a safety check.

---

## 5. Deterministic detection

Regex rules that fail **differently** from the model classifiers, which share a failure mode with each other. Cheap, fast, explainable, not persuadable.

They are narrow on purpose. A filter that fires on "a secret ingredient" and every treasure-hunt story trains the team to ignore its findings, which is worse than not having it. Two rules encode that:

- A lone low- or medium-severity finding is **recorded but does not stop the turn**. It becomes blocking when it arrives with something else, or when it was reached through obfuscation.
- Parent-configured blocked topics are recorded under their own detector name, so a parent's preference is never conflated with a product-level harm finding in the metrics.

### Obfuscation

Detection runs against several **variants** of each message. Variants exist for the length of one function call, are never persisted, and are never transmitted.

| Variant      | Defeats                              | When generated                                                                |
| ------------ | ------------------------------------ | ----------------------------------------------------------------------------- |
| `normalised` | diacritics, homoglyphs, in-word leet | always                                                                        |
| `dense`      | `k i l l`, `k.i.l.l`                 | only when the text looks obfuscated                                           |
| `leet`       | `h0w t0 m4k3 4 b0mb`                 | only when in-word leet is present                                             |
| `reversed`   | reversed text                        | always (scanning reversed text for `kill` = scanning the original for `llik`) |
| `rot13`      | ROT13                                | always                                                                        |
| `decoded`    | base64                               | when a token decodes to prose                                                 |

The gating matters. Stripping every separator turns "task illustration" into a string containing "kill", so the dense variant only exists when the message shows an actual obfuscation signal.

Reaching a **critical** rule through a derived variant escalates. That is not curiosity — the child understood there was a boundary and went looking for a way past it.

---

## 6. Escalation

Exactly three rules, all in `escalation.ts`. Both failure directions are real: escalate too readily and the review queue fills with noise until nobody reads it, which is the same as having no queue; escalate too rarely and a child who told us something gets a change of subject.

| Rule                | Trigger                                                     | Effect                          |
| ------------------- | ----------------------------------------------------------- | ------------------------------- |
| `signal_category`   | A category whose policy row escalates                       | Human review; session continues |
| `evasion_of_safety` | A critical rule reached only through obfuscation            | Human review; session continues |
| `repeated_attempts` | Stopped turns in the window reach the threshold (default 5) | Human review; **session ends**  |

A session ended this way records `end_reason = 'safety_ended'`, because "why did sessions end?" has to stay answerable — it is the metric that reveals a pipeline ending sessions it should not be.

The child is never told what tripped any of this. A child who learns which words end the session has learned the wrong lesson and will go looking for them again.

---

## 7. The safety event

`content_flags` is the event log. It records **that** something happened, never **what was said**.

It carries categories, detector _names_, a layer, a severity, a decision, the policy version, and an attempt index. It does not carry the utterance, an excerpt, a hash, or a "just the matching phrase" field — every one of which has been proposed on some product at some point, and every one of which reconstructs a child's words in a log.

`assertNoContent()` runs on every event the pipeline emits and throws if three consecutive words from the source appear anywhere in it. It is blunt, and it is there because the failure it guards against is silent: nobody notices a leak in a log until it is already in a log aggregator.

The repeated-attempt counter reads through `app.recent_safety_blocks()`, which returns an integer and cannot be asked for more. The rule needs to know a child has tried five times; it does not need the five utterances.

Parents can read flags for their own children and cannot create, edit, or delete them — a parent who could delete a flag could delete the record of a safeguarding concern.

---

## 8. Fail-closed

Every safety component treats its own failure as a stop, and this is not configurable ([CHILD_SAFETY.md](CHILD_SAFETY.md) rule S-1).

| Failure                                           | Result                                                                                                             |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Classifier errors, times out, or returns nonsense | Turn stopped, `failedClosed` set, warm reply to the child                                                          |
| Policy store unreachable                          | Compiled-in policy, which is stricter                                                                              |
| Attempt counter fails                             | Treated as zero — the counter can only make a decision stricter, so losing it must not weaken one or fail the turn |
| Assembled payload contains prohibited data        | Request refused before transmission; one turn degrades                                                             |
| Prompt missing a safety invariant                 | Turn degrades rather than generating                                                                               |

A stop caused by a component failing is reported as _both_ a content decision and an operational fault, so the metrics do not conflate "we blocked something" with "our classifier was down".

The child never sees an error, a stack trace, or a spinner that does not resolve. Every path returns something the character can say.

---

## 9. Known limitations ⚠️

**This system is not safe. It is safer than it would be without these layers, and that is a different claim.**

Nothing below is a bug to be closed. They are properties of the approach, and they are why [§10](#10-continuous-evaluation) is not optional.

1. **The deterministic rules only catch what someone thought of in advance.** Every pattern in `detectors.ts` encodes a phrasing a person imagined. A novel phrasing walks straight past. The adversarial corpus measures whether we still catch the attacks we already knew about — it is a regression suite, and a green run means "no worse than before", not "safe".

2. **The classifiers can be fooled, and both can be fooled at once.** L1 and L3 are the same kind of artefact. An input crafted to defeat one frequently defeats the other. L4 exists precisely because of this, and L4 is limited by point 1.

3. **Non-English coverage is weaker, and this is a safety gap rather than a localisation gap.** Every deterministic rule in this subsystem is written against English. Urdu, Arabic, and code-switched utterances are covered only by the model classifiers, whose quality outside English is materially lower. Pakistani households code-switch mid-sentence. **Urdu conversation must not launch on English-grade rules with Urdu-grade classification** ([CHILD_SAFETY.md §9.1](CHILD_SAFETY.md#91-the-multilingual-point-stated-bluntly)).

4. **Obfuscation handling is a sample, not a solution.** The confusable table covers common Cyrillic and Greek lookalikes; Unicode confusables are a long tail. Nested encodings, unusual encodings, and combinations are not handled. Gating the aggressive variants — necessary to keep false positives survivable — is itself a bypass surface.

5. **Context and accumulation are not modelled.** Every turn is judged on its own. A conversation that becomes inappropriate gradually, where no single message trips a rule, is not something this design detects. The repeated-attempt counter is the nearest thing, and it only counts turns that were already stopped.

6. **Severity gating is a deliberate, quantified risk.** A lone medium-severity finding does not stop the turn. That is the right trade for false-positive rates, and it means a single-signal true positive is allowed through.

7. **The safe responses are fixed English strings.** They are not adapted to context, not translated, and not written by a clinician. §6.1 wording carries an expert-review gate that has not yet been satisfied (Q-07).

8. **Escalation currently ends at an audit record and a log line.** The human protocol behind it is unresolved (Q-07). Until it is defined, staffed, and rehearsed, "escalated" means "written down", not "acted on". **This is the most serious open gap in the subsystem.**

9. **Nothing here verifies a child's age**, or that the account holder is their parent, or protects a child from a hostile adult in their own household.

10. **The Anthropic classifier adapter has not been exercised against the live API.** Everything measured so far was measured against the mock.

---

## 10. Continuous evaluation

A safety system evaluated once is a safety system that was safe once. Model behaviour drifts with every provider update, children invent phrasings nobody anticipated, and every rule above ages.

**Required before launch** — these are gates, not aspirations:

- Adversarial corpus in CI, failing the build on regression.
- External red-teaming, adversarial, **including Urdu and code-switched inputs**.
- Child-development and child-protection review of the prompts, personas, and §6.1 wording.
- Q-07 resolved: the disclosure protocol defined, staffed, and rehearsed.

**Required continuously** — see [CHILD_SAFETY.md §10](CHILD_SAFETY.md#10-operating-after-launch):

- **Every real miss becomes a corpus entry in the same PR as the fix.** The corpus grows from production, not from imagination, which is the only mechanism that addresses limitation 1.
- **Human review** of flagged and randomly sampled turns, by trained people, under access control, with audited access.
- **Metric watch**, per layer and per language: block rate, escalation rate, queue latency, parent-report rate. A block rate that suddenly _drops_ is as alarming as one that spikes — it usually means a classifier stopped working.
- **Policy review** on a schedule, not only after incidents. Every `rationale` should still be true.
- **Re-evaluation on every model or prompt change.** A provider version bump is a safety change.

---

## 11. Where to look

| Concern                     | File                                                   |
| --------------------------- | ------------------------------------------------------ |
| Taxonomy and action ranking | `services/safety/src/categories.ts`                    |
| Policy resolution           | `services/safety/src/policy.ts`                        |
| Regex rules                 | `services/safety/src/detectors.ts`                     |
| Obfuscation variants        | `services/safety/src/normalise.ts`                     |
| The three stages            | `services/safety/src/pipeline.ts`                      |
| Escalation rules            | `services/safety/src/escalation.ts`                    |
| Event shape and leak guard  | `services/safety/src/events.ts`                        |
| What the child hears        | `services/safety/src/responses.ts`                     |
| Adversarial corpus          | `services/safety/src/adversarial.test.ts`              |
| Fail-closed proofs          | `services/safety/src/policy.test.ts`                   |
| End-to-end with RLS         | `tests/integration/safety.test.ts`                     |
| Policy and event schema     | `infra/migrations/20260817170000_safety_subsystem.sql` |
| Classifier adapter          | `services/ai/src/safety-classifier.ts`                 |
| Policy store, attempt count | `apps/api/src/safety-store.ts`                         |
