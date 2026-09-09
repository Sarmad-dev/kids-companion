# ADR-0002: Fastify over Express for the API

**Status:** Accepted
**Date:** 2026-08-17
**Deciders:** Engineering

## Context

The specification requires choosing Fastify or Express and documenting why.

The API is the sole trusted tier ([SECURITY.md §1.3](../../SECURITY.md)). It handles unauthenticated traffic, personal data belonging to children, payment webhooks, and a latency-budgeted voice loop. Two properties matter more here than in a typical CRUD service:

1. **Every input must be validated, and every output must be constrained.** Given the data classes involved, a response accidentally emitting a field it should not is a privacy incident, not a cosmetic bug.
2. **Latency is a product requirement**, with a per-stage budget ([ARCHITECTURE.md §7.1](../../ARCHITECTURE.md)).

Both frameworks are mature and would work. The question is which makes the safe thing the default.

## Decision

**Fastify 5** for `apps/api`.

## Options considered

### Option A — Express 5

**Pros:** the largest middleware ecosystem in Node; nearly every engineer already knows it; almost any integration problem has a published answer.

**Cons:** no built-in validation or serialisation — both are bolted on per project, which means each route can be secured differently, and some route will eventually be secured not at all. TypeScript support is community typings over a JavaScript-first API, so handler types are frequently `any` in practice. Middleware is a flat global chain, so "this plugin applies only to authenticated routes" is a convention rather than a structure. Error handling in async handlers still requires care to avoid swallowed rejections.

### Option B — Fastify 5

**Pros:**

- **Schema-first by design.** Each route declares JSON Schema for body, query, params, headers, and response. Validation runs before the handler; a schema-less route is visibly anomalous rather than invisibly normal.
- **Response serialisation through the schema is a security control.** Fastify serialises the response _through_ the declared schema, so a field not in the schema cannot be emitted. A `password_hash` or an internal note added to an entity later cannot leak through an endpoint that forgot to strip it. For this product, that guarantee is worth more than the serialisation speed it also delivers.
- **Encapsulated plugins.** Scope is structural: an auth plugin registered in a context applies to that context and nothing else. It becomes hard to accidentally expose a route by forgetting a middleware line.
- **First-class TypeScript**, with type providers that infer handler types from the schema — so the schema types the handler rather than being restated.
- **Pino built in**, which is the logger our redaction requirements ([LOGGING.md](../LOGGING.md)) are designed around. One logger, one request-ID mechanism, no adapter layer.
- **Async-native error handling** and a single error boundary, matching [ERROR_HANDLING.md §11](../ERROR_HANDLING.md).
- **OpenAPI generated from the schemas**, so documentation cannot drift from implementation.
- Measurably higher throughput and lower per-request overhead, which is a modest but free contribution to the latency budget.

**Cons:** a smaller ecosystem than Express; more engineers need a short ramp-up; the plugin encapsulation model takes a day to internalise and is genuinely confusing until it clicks.

### Why Fastify won

The decisive argument is not performance — it is that **Fastify's defaults are the behaviours we would otherwise have to enforce by review**.

With Express we would build schema validation, response filtering, and scoped middleware ourselves, then rely on reviewers to notice when a route skipped them. With Fastify, a route without a schema is an obvious omission, and a response cannot carry a field the schema does not declare. In a system where the failure mode is a child's data leaving through an endpoint, moving that guarantee from process into structure is worth the smaller ecosystem.

The performance advantage is real but secondary. The Zod → JSON Schema pipeline ([API_CONVENTIONS.md §3.1](../API_CONVENTIONS.md)) fits Fastify natively: one schema does runtime validation, static typing, and OpenAPI, with no second definition to drift.

## Consequences

**Positive.** Validation and response filtering are default-on. Auth scoping is structural. Logging and request IDs come from one place. OpenAPI stays accurate for free.

**Negative.** Some Express middleware has no direct Fastify equivalent and needs a wrapper or a rewrite. Onboarding costs a little more. The plugin encapsulation model produces a genuinely confusing class of bug — "my decorator isn't available here" — until the mental model lands.

**Risks.** A niche integration may lack a Fastify plugin; the mitigation is Fastify's Express-middleware compatibility layer, used sparingly and deliberately. Fastify's smaller maintainer base is a lower but non-zero bus-factor risk than Express's.

## Revisit when

Fastify's maintenance slows materially, or an unavoidable integration exists only for Express and the compatibility layer proves inadequate. Neither is likely; migration would be substantial and should not be undertaken for preference.
