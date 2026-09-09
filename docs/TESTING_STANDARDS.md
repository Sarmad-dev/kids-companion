# Testing Standards

## 1. What tests are for here

Standard reasons apply — regression safety, refactor confidence, executable documentation. Two reasons specific to this product outrank them:

1. **Some failures cannot be caught in production**, because "caught in production" means a child was exposed to something harmful or a family's conversations leaked. Those paths must be proven before deployment.
2. **Model behaviour is non-deterministic.** The mechanism _around_ the model — classification, fail-closed handling, redaction, quota — must be deterministic and thoroughly tested, precisely because the model is not.

---

## 2. The three tiers

| Tier            | Scope                             | Dependencies                                                                                                                          | Budget       | Runs                     |
| --------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ------------------------ |
| **Unit**        | One module                        | None. No network, no container, no clock.                                                                                             | < 5 s/file   | Every save, every commit |
| **Integration** | Module + real infrastructure      | Real PostgreSQL in-process via PGlite — no Docker daemon. Vendors mocked at the HTTP boundary. See [DATA_MODEL.md §9](DATA_MODEL.md). | < 60 s/file  | Every PR                 |
| **E2E**         | Full user journey through the API | Everything real except vendors                                                                                                        | < 120 s/file | Every PR, and pre-deploy |

Run: `pnpm test:unit`, `pnpm test:integration`, `pnpm test:e2e`.

### 2.1 Never call a live vendor from a test

Not in CI, not locally, not "just this once to check". Live calls make suites flaky, slow, expensive, and — because a real STT call means real audio — a privacy question. Vendors are faked at the HTTP boundary, from recorded fixtures.

---

## 3. Structure

### 3.1 Arrange–Act–Assert, visibly

```ts
it('blocks the turn when the output classifier times out', async () => {
  // Arrange
  const classifier = stubClassifier({ behaviour: 'timeout' });
  const engine = createConversationEngine({ classifier, clock: fixedClock() });

  // Act
  const result = await engine.respond(childTurn('tell me a story'));

  // Assert
  expect(result.status).toBe('blocked');
  expect(result.layer).toBe('L3');
});
```

### 3.2 Test names state behaviour, not implementation

```
✗ it('works')
✗ it('calls the classifier')
✓ it('blocks the turn when the output classifier times out')
✓ it('returns not-found when a parent requests another parent's child profile')
```

The name should tell you what broke without opening the file.

### 3.3 Test behaviour, not internals

Assert on what a caller can observe. A test that asserts a private method was called breaks on every refactor while catching nothing — it tests that the code is the code.

### 3.4 One reason to fail

Multiple assertions are fine when they describe one behaviour. Multiple _behaviours_ per test means a failure tells you less than it should.

---

## 4. Coverage policy

Global floor: **70 % lines / 70 % functions / 65 % branches**, enforced in `vitest.config.ts`.

Coverage is a floor, not a goal. 100 % coverage of code that asserts nothing meaningful is worthless. But some modules carry a higher gate because their failure mode is severe:

| Module                                       | Gate                         | Because a bug means                  |
| -------------------------------------------- | ---------------------------- | ------------------------------------ |
| Safety pipeline (`services/ai` safety chain) | **95 %**, all branches       | A child sees harmful content         |
| Authentication and authorization             | **95 %**                     | A family's data leaks                |
| RLS policies                                 | **100 % of policies tested** | The backstop is not a backstop       |
| Log redaction                                | **100 %**                    | Child data lands in a log aggregator |
| Retention and deletion                       | **95 %**                     | We keep data we promised to delete   |
| Entitlement and quota                        | **90 %**                     | Revenue loss or a runaway bill       |
| Payment webhooks                             | **90 %**                     | Billing state diverges from reality  |

These are enforced per-package, not by lowering the global number to match.

---

## 5. Tests that are mandatory in this product

### 5.1 Tenant isolation — every endpoint touching child data

Two tests, not one:

```ts
it('returns not-found when parent A requests parent B\'s child profile', ...);
it('is refused by RLS even when the application check is bypassed', ...);
```

The second matters most. It proves the backstop in [ARCHITECTURE.md §9](../ARCHITECTURE.md) actually works — which is unknowable if only the layer in front of it is ever exercised.

### 5.2 Fail-closed safety

For every safety layer, prove that an error, a timeout, and a malformed response each **block** the turn:

```ts
it.each(['error', 'timeout', 'malformed'])(
  'blocks the turn when the input classifier responds with %s',
  ...
);
```

A safety pipeline whose failure modes are untested is a safety pipeline whose failure modes are unknown.

### 5.3 The safety corpus

A curated corpus of adversarial and sensitive inputs — prompt injection, distress signals, unsafe topic probes, PII disclosure, age-inappropriate requests, and the multilingual and code-switched variants of each — runs in CI against the full pipeline. A regression fails the build.

This corpus is a **living asset**: every real-world safety miss becomes a corpus entry in the fix's PR. It contains only synthetic, hand-written inputs. Real child utterances never enter it.

### 5.4 Redaction

Prove the logger _cannot_ emit sensitive data, rather than proving one call site remembered to redact:

```ts
it('emits no transcript text even when a transcript is passed at debug level', ...);
it('redacts child identifiers from a nested error cause chain', ...);
```

### 5.5 Contract tests, one suite per port

Every adapter of a port — including the mock — passes the identical suite. This is what makes the mock a trustworthy stand-in and what makes swapping a vendor a configuration change instead of a rewrite.

```
tests/contract/
├── speech-to-text.contract.ts     ← the suite
├── text-to-speech.contract.ts
├── conversation-provider.contract.ts
└── payment-provider.contract.ts
```

The suite includes the unhappy paths that vendors differ on: timeout, rate limit, malformed response, partial stream, and a network failure mid-request.

### 5.6 Age-band behaviour

Anything age-adaptive is tested across all four bands. The `early` (3–4) band is the one most often forgotten and the one where a too-long, too-complex response does the most damage to the experience.

### 5.7 Degradation

Every row in the failure table ([ARCHITECTURE.md §13](../ARCHITECTURE.md)) has a test proving the child sees a character-appropriate response — never an error, never an unresolving spinner.

---

## 6. Test data

**Synthetic only. Always.** No real child data enters a test, a fixture, a snapshot, or a bug report — see [PRIVACY.md](../PRIVACY.md).

Fixtures live in `tests/fixtures/` and are obviously fake: `"Test Child A"`, birth year `2019`. Never a real-looking name with a real-looking birthday, because plausible fake data eventually gets mistaken for real data — or worse, real data gets pasted in beside it and nobody notices.

Prefer builders over literals so a test states only what it cares about:

```ts
const child = aChildProfile({ ageBand: 'early', language: 'ur' });
```

---

## 7. Determinism

A flaky test is worse than no test: it trains people to re-run CI instead of reading failures.

- **Time** is injected via `Clock`. Never `new Date()` in logic under test — enforced by lint.
- **Randomness** is seeded or injected.
- **IDs** come from an injected generator.
- **No `sleep`.** Wait on a condition or advance a fake clock.
- **Order independence.** Tests must pass in any order and in parallel.

A test that cannot be made deterministic gets fixed or deleted. Quarantining it just moves the rot.

---

## 8. What not to test

- Third-party library behaviour — that is their test suite's job.
- Getters, setters, and pass-through wrappers.
- Exact prompt wording. Test the _properties_ of a generated prompt (contains the age band, respects the length ceiling, excludes the child's name) — not its literal text, which will change weekly.
- Model output text. Test the pipeline around it: that unsafe output is blocked, that length is bounded, that cost is recorded.

---

## 9. CI

Pull request: format check → lint → typecheck → unit → integration → e2e → safety corpus → secret scan → dependency audit.

Fast, cheap checks run first so a formatting mistake fails in seconds, not after a twelve-minute container spin-up.

**No merge on red. No skipping a test to unblock a release.** A `.skip` in the safety suite is a merge blocker, not a workaround.
