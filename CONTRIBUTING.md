# Contributing

## Before your first change

Read [ARCHITECTURE.md](ARCHITECTURE.md), [docs/CHILD_SAFETY.md](docs/CHILD_SAFETY.md) (and [docs/SAFETY_SUBSYSTEM.md](docs/SAFETY_SUBSYSTEM.md) before touching anything under `services/safety`), [PRIVACY.md](PRIVACY.md), and [SECURITY.md](SECURITY.md). These are not background reading — they contain constraints that will fail your pull request in review.

---

## Workflow

### Branches

```
<type>/<short-kebab-description>
```

Types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `security`.

### Commits — Conventional Commits

```
<type>(<scope>): <subject>

<body: why, not what>

<footer: BREAKING CHANGE, refs>
```

Scopes match workspace packages: `api`, `mobile`, `web`, `shared`, `types`, `config`, `validation`, `ui`, `ai`, `voice`, `payments`, `infra`, `docs`.

```
feat(ai): add streamed output safety classification

The output classifier previously ran on the complete response, which meant
an unsafe response was fully generated and billed before being discarded.
Classifying per chunk halts generation at the first unsafe token.

Refs: #142
```

Write the body to explain **why**. The diff already shows what.

---

## Pull requests

Small, single-purpose, and green before review. A PR that changes the data model _and_ refactors the logger is two PRs.

### Checklist

**Always**

- [ ] `pnpm check` passes
- [ ] Tests added at the right tier ([docs/TESTING_STANDARDS.md](docs/TESTING_STANDARDS.md))
- [ ] No secrets, keys, tokens, or connection strings — including in tests and fixtures
- [ ] No real child data anywhere, including screenshots

**If it touches personal data**

- [ ] [PRIVACY.md §3](PRIVACY.md) inventory updated **in this PR**
- [ ] Retention rule defined and enforced
- [ ] Field classified S0–S3
- [ ] Confirmed the field cannot reach logs or analytics

**If it touches child-facing behaviour**

- [ ] Age-band behaviour considered for all four bands
- [ ] Safety implications stated in the description
- [ ] Failure path produces a child-appropriate response, never an error message
- [ ] Safety corpus updated if a new class of input is now reachable

**If it touches auth or authorization**

- [ ] Tenant isolation test added (parent A cannot reach parent B's data)
- [ ] Tested at both layers: application **and** RLS
- [ ] No new use of the service-role key without explicit review

**If it adds an external call**

- [ ] Behind a port in `services/`
- [ ] Mock adapter added
- [ ] Contract test passes for every adapter of that port
- [ ] Timeout, retry, and failure behaviour defined
- [ ] Vendor errors mapped into the `AppError` taxonomy

**If it adds configuration**

- [ ] In `.env.example`, the `@kids/config` schema, and [docs/ENVIRONMENT.md](docs/ENVIRONMENT.md)
- [ ] Safe default, or a fail-fast boot error

### Review

At least one approval. Two, from different people, for anything touching authentication, authorization, the safety pipeline, payments, or personal data.

Reviewers should ask: _What happens when this fails? Can a child see the failure? Does this collect data we do not need? Can parent A reach parent B's data?_

---

## Things that will get a PR rejected

- A secret, or a realistic-looking fake credential
- Real or plausible child data in a fixture
- `console.log` instead of the redacting logger
- `any`, or a `@ts-expect-error` without an explanatory comment
- A new external call not behind a port
- A safety check that fails open
- A personal-data field with no purpose, classification, or retention rule
- A compliance claim ("this makes us COPPA compliant")
- Disabling a lint rule to avoid fixing the underlying problem

---

## Architecture Decision Records

Write an ADR for anything expensive to reverse: a vendor choice, a data-model shape, an auth mechanism, a transport, a safety-policy change.

Copy [docs/adr/TEMPLATE.md](docs/adr/TEMPLATE.md), take the next number, and open it as its own PR when the decision is contentious — the discussion belongs in the record, not in a thread that disappears.

An ADR is never edited once accepted. It is **superseded** by a new one, and the old one is marked as such. The history of what we believed and why is the point.

---

## Getting help

Genuinely stuck on a safety or privacy question? **Ask before implementing.** Guessing at a safety requirement and building the wrong thing is far more expensive than a question. Nobody will mind the interruption.
