# apps/api

**Not yet implemented. Phase 1.**

The Fastify backend, and the only trusted tier in the system ([SECURITY.md §1.3](../../SECURITY.md)).

## Responsibilities

- Parent authentication, refresh-token rotation with reuse detection, child session minting
- Authorization — the primary layer, with RLS as the backstop
- The conversation orchestrator: the voice loop in [ARCHITECTURE.md §7](../../ARCHITECTURE.md)
- The safety pipeline's enforcement points
- Quota and entitlement resolution
- Payment webhook verification and reconciliation
- Parent dashboard read models
- Data export and deletion

## Structure (planned)

```
src/
├── server.ts          composition root; wires plugins and shuts down gracefully
├── plugins/           auth, rate limiting, error boundary, request context, db, redis
├── routes/            thin HTTP adapters — one folder per resource, schema per route
├── domain/            business logic, framework-free and testable without a server
├── repositories/      data access; the only place SQL lives
└── jobs/              retention sweeps, reconciliation, report generation
```

The `domain/` and `routes/` split is deliberate and is the subject of [Q-03](../../docs/OPEN_QUESTIONS.md): business logic that accretes inside Fastify plugins becomes coupled to HTTP and untestable without a server. Settle the boundary before the first ten routes set it by accident.

## Notes

- The **only** package permitted to load `SUPABASE_SERVICE_ROLE_KEY` ([SECURITY.md §3.2](../../SECURITY.md)).
- Every route declares request **and** response schemas. Response serialisation through the schema is a privacy control ([ADR-0002](../../docs/adr/0002-http-framework-fastify.md)).
- Conventions: [API_CONVENTIONS.md](../../docs/API_CONVENTIONS.md), [ERROR_HANDLING.md](../../docs/ERROR_HANDLING.md), [LOGGING.md](../../docs/LOGGING.md).
