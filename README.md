# kids-companion

A voice-first AI conversation companion for children aged approximately 3–10. A child speaks to an animated character; the character listens, understands, and speaks back — in English or Urdu — while a parent keeps full visibility and control from a separate dashboard.

Initial market: Pakistan. Then international.

> ### ⚠️ Project status: **Phase 0 — foundation only**
>
> This repository currently contains **architecture and documentation. There is no application code.**
> Nothing here is deployable, and nothing here has been assessed for regulatory compliance.
> See [DEVELOPMENT_PLAN.md](DEVELOPMENT_PLAN.md) for what is built and what is not.

---

## Start here

Read in this order. The first four are prerequisites for writing any code in this repository.

| #   | Document                                             | What it answers                                                           |
| --- | ---------------------------------------------------- | ------------------------------------------------------------------------- |
| 1   | [ARCHITECTURE.md](ARCHITECTURE.md)                   | How the system is shaped, and why                                         |
| 2   | [docs/CHILD_SAFETY.md](docs/CHILD_SAFETY.md)         | The safety requirements every feature must satisfy                        |
| 2a  | [docs/SAFETY_SUBSYSTEM.md](docs/SAFETY_SUBSYSTEM.md) | How those requirements are enforced — and what that enforcement cannot do |
| 3   | [PRIVACY.md](PRIVACY.md)                             | What data we collect, why, and for how long                               |
| 4   | [SECURITY.md](SECURITY.md)                           | Threat model and security requirements                                    |
| 5   | [docs/DATA_MODEL.md](docs/DATA_MODEL.md)             | The schema, and what it refuses to do                                     |
| 5   | [DEVELOPMENT_PLAN.md](DEVELOPMENT_PLAN.md)           | Phases, gates, and the risk register                                      |
| 6   | [docs/OPEN_QUESTIONS.md](docs/OPEN_QUESTIONS.md)     | What is deliberately not decided yet                                      |
| 7   | [CONTRIBUTING.md](CONTRIBUTING.md)                   | How to work in this repo                                                  |

Conventions: [coding](docs/CODING_STANDARDS.md) · [testing](docs/TESTING_STANDARDS.md) · [API](docs/API_CONVENTIONS.md) · [database](docs/DATABASE_CONVENTIONS.md) · [errors](docs/ERROR_HANDLING.md) · [logging](docs/LOGGING.md) · [environment](docs/ENVIRONMENT.md) · [ADRs](docs/adr/)

---

## The three rules

Everything else in this repository is elaboration on these.

1. **The child is not the customer, the user, or the account holder — they are the person we are responsible for.** Every default is the conservative one. When product convenience and child safety conflict, safety wins and the product changes.
2. **Data we never collect cannot be breached.** Minimisation outranks feature convenience. Raw child audio is transcribed and discarded by default.
3. **Safety fails closed.** If a safety check errors, times out, or is unavailable, the turn is blocked. There is no configuration that makes it fail open.

---

## Getting started

### Prerequisites

- **Node.js 24** (`.nvmrc` — `nvm use`)
- **pnpm 11** via corepack
- **Docker** (for local Postgres and Redis in later phases)

### Setup

```bash
corepack enable
```

```bash
pnpm install
```

```bash
cp .env.example .env
```

```bash
pnpm check
```

`pnpm check` runs format check, typecheck, lint, and unit tests — the same gate CI enforces. It is verified to pass from a clean checkout with no other setup.

**No API keys are needed to work in this repository.** Every external provider defaults to a `mock` adapter in `local` and `ci`, so a fresh clone runs end to end with an unedited `.env`. Real keys are only needed to exercise a real provider deliberately.

Local Postgres and Redis, when you need them:

```bash
pnpm docker:up
```

### Running an app

```bash
pnpm --filter @kids/api run dev
```

```bash
pnpm --filter @kids/web run dev
```

```bash
pnpm --filter @kids/mobile run dev
```

`pnpm dev` runs all three in parallel.

### Environments

`APP_ENV` — not `NODE_ENV` — decides how the application behaves. `NODE_ENV` is for frameworks; `APP_ENV` selects secrets, safety thresholds, and validation rules. Conflating them means either staging behaves unlike production or staging writes to production analytics.

| `APP_ENV`     | Where                                     | Template                   |
| ------------- | ----------------------------------------- | -------------------------- |
| `local`       | Your machine                              | `.env.example`             |
| `ci`          | CI runners                                | (env vars only)            |
| `development` | Shared dev deployment                     | `.env.development.example` |
| `staging`     | Production-shaped, synthetic data         | `.env.staging.example`     |
| `production`  | The only environment with real child data | `.env.production.example`  |

Validation is enforced at boot by `@kids/config`, including cross-field rules. Most importantly: **a production deploy cannot start with the safety classifiers disabled** — it fails to boot rather than serving children unprotected.

### Troubleshooting (Windows)

**`corepack enable` fails with `EPERM`.** It writes shims into the Node install directory, which needs an elevated shell. Either run it once from an admin terminal, or prefix commands with `corepack` (`corepack pnpm install`). Note that the root scripts call `pnpm` recursively, so `pnpm` must be on `PATH` for `pnpm dev`, `pnpm build`, and `pnpm check` to work.

**`Cannot find native binding`.** The ESLint import resolver ships a native binary that needs the [Microsoft Visual C++ Redistributable](https://learn.microsoft.com/cpp/windows/latest-supported-vc-redist). The workspace carries `@unrs/resolver-binding-wasm32-wasi` as a WASM fallback so linting works without it — installing the redistributable just makes it faster. No other part of the toolchain depends on a native binary; see [ADR-0008](docs/adr/0008-build-orchestration-and-module-linking.md).

---

## Repository layout

```
kids-companion/
├── apps/
│   ├── api/           Fastify backend — the only trusted tier
│   ├── mobile/        React Native app (child mode + parent mode)
│   └── web/           Parent dashboard, marketing, web checkout
├── packages/
│   ├── types/         Domain types. Zero runtime imports.
│   ├── validation/    Zod schemas — one source of truth for every boundary
│   ├── config/        Fail-fast environment validation
│   ├── db/            Migration loading and application
│   ├── shared/        Errors, Result, redacting logger, Clock, IDs
│   └── ui/            Design tokens and cross-platform primitives
├── services/
│   ├── ai/            Conversation + safety-classifier ports and adapters
│   ├── voice/         STT and TTS ports and adapters
│   └── payments/      Payment and subscription ports and adapters
├── infra/
│   ├── docker/        Local and deployment container definitions
│   ├── migrations/    Versioned, forward-only SQL
│   └── scripts/       Operational and CI scripts
├── tests/
│   ├── contract/      One suite per port; every adapter must pass it
│   ├── e2e/           API end-to-end, against a real server process
│   ├── e2e-web/       Browser end-to-end (Playwright)
│   └── fixtures/      Synthetic data only — never real child data
└── docs/              Conventions, ADRs, runbooks
```

**Dependencies point inward:** `apps → services → packages/{shared,validation,config} → packages/types`. Nothing in `packages/` or `services/` may import from `apps/`. This is enforced by ESLint, not by convention.

---

## Commands

| Command                        | Does                                                           |
| ------------------------------ | -------------------------------------------------------------- |
| `pnpm check`                   | Format check → typecheck → lint → unit tests. The CI gate.     |
| `pnpm dev`                     | Run all apps in watch mode                                     |
| `pnpm build`                   | Build every workspace package, in dependency order             |
| `pnpm typecheck`               | `tsc -b` across the solution, plus the bundler-driven apps     |
| `pnpm lint` / `pnpm lint:fix`  | ESLint                                                         |
| `pnpm format` / `format:check` | Prettier                                                       |
| `pnpm test`                    | Unit + integration                                             |
| `pnpm test:unit`               | Fast, in-memory, no containers                                 |
| `pnpm test:integration`        | The real app through `inject()`; Phase 1 adds Postgres + Redis |
| `pnpm test:e2e`                | A real API server process over a real socket                   |
| `pnpm test:e2e:web`            | Playwright. Needs `pnpm exec playwright install` first.        |
| `pnpm docker:up` / `:down`     | Local Postgres + Redis                                         |
| `pnpm db:migrate`              | Apply migrations to `$DATABASE_URL`                            |
| `pnpm db:status`               | List applied and pending migrations                            |
| `pnpm db:types` / `:check`     | Generate TS types from migrations; verify they are current     |
| `pnpm db:seed:dev`             | Development fixtures (refuses outside local/ci)                |
| `pnpm verify:no-secrets`       | Scan for committed credentials                                 |
| `pnpm env:check`               | Compare `.env` against `.env.example`                          |

Each of `lint`, `typecheck`, and the test scripts runs `tsc -b` first, so any of them works standalone on a fresh clone. It is incremental, so it is a no-op once built.

---

## Technology

| Layer                 | Choice                            | Rationale                                                                                                                                       |
| --------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Language              | TypeScript, strict                | One vocabulary from database row to mobile screen                                                                                               |
| Mobile                | React Native                      | Single codebase; Android-first for the launch market                                                                                            |
| Web                   | React                             | Parent dashboard and checkout                                                                                                                   |
| API                   | **Fastify**                       | Schema-first validation and serialisation per route ([ADR-0002](docs/adr/0002-http-framework-fastify.md))                                       |
| Database              | Supabase Postgres + RLS           | Managed Postgres with row-level authorization as a backstop ([ADR-0003](docs/adr/0003-supabase-postgres-rls.md))                                |
| Cache / queues        | Redis                             | Rate limits, TTS cache, background jobs — never a system of record                                                                              |
| Storage               | Supabase Storage or S3-compatible | Behind an `ObjectStorage` port                                                                                                                  |
| AI / Voice / Payments | Ports and adapters                | Vendor volatility is certain ([ADR-0004](docs/adr/0004-provider-abstraction.md))                                                                |
| Monorepo              | pnpm workspaces + `pnpm -r`       | Workspace protocol and shared catalog; no native binary in the build path ([ADR-0008](docs/adr/0008-build-orchestration-and-module-linking.md)) |
| Tests                 | Vitest                            | Unit, integration, e2e in one runner                                                                                                            |

---

## Security and privacy

- **Never commit a secret.** `.env` is gitignored; `.env.example` holds placeholders only. An exposed secret is a compromised secret — rotate first, investigate second.
- **Never put real child data in this repository**, in a fixture, a test, a screenshot, or a bug report.
- **Never copy production data into a non-production environment.** Child voice and transcripts cannot be meaningfully anonymised, so they are never copied out of production.
- Report vulnerabilities privately — see [SECURITY.md §9](SECURITY.md).

### On compliance

This project is **designed to support** a future assessment against COPPA, GDPR/GDPR-K, and Pakistan's data protection regime. **It is not certified against any of them, and the existence of this code does not make it compliant.** Compliance requires legal assessment, vendor agreements, and evidence of operating practice. Any claim of compliance in this repository or in material derived from it should be treated as a defect. See [PRIVACY.md §1](PRIVACY.md).

---

## License

UNLICENSED — proprietary. All rights reserved.
