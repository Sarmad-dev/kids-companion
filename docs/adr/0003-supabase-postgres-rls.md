# ADR-0003: Supabase Postgres with Row Level Security

**Status:** Accepted
**Date:** 2026-08-17
**Deciders:** Engineering

## Context

The database holds the most sensitive data in the system: child profiles, conversation transcripts, learning records, safety flags. The worst realistic failure is **cross-tenant exposure** — one family's data reaching another — which in this product means a stranger reading a child's conversations.

A small team also cannot responsibly operate Postgres, connection pooling, backups, PITR, and storage as infrastructure work.

## Decision

**Supabase Postgres**, with **Row Level Security enabled and forced on every table holding parent or child data**, as a backstop to application-layer authorization — not as a replacement for it.

## Options considered

### Option A — Self-hosted Postgres

Maximum control over region and configuration. Requires us to own backups, failover, upgrades, and pooling. Wrong trade for a pre-launch team.

### Option B — Managed Postgres without RLS (RDS, Cloud SQL, Neon)

Solid managed Postgres, authorization entirely in application code. The problem is that it makes authorization a single-layer property: one missed ownership check on one endpoint is a cross-tenant leak with nothing behind it.

### Option C — Supabase Postgres with RLS _(chosen)_

Real Postgres, managed, with auth and storage in the same platform, plus row-level policies enforced by the database engine.

### Why this won

Two layers, failing independently. The API is the primary trust boundary and decides authorization with full request context. RLS is the backstop that catches the day someone forgets. Redundancy is normally a smell; where the failure mode is a child's data reaching a stranger, it is the correct design.

Supabase also collapses managed Postgres, auth primitives, and object storage into one platform, which is a meaningful reduction in moving parts at this stage. Because it is standard Postgres, exiting to any managed Postgres later is a migration, not a rewrite — the RLS policies are plain SQL.

## Consequences

**Positive.** Two independent authorization layers. Cascade deletes make the erasure right structural rather than a deletion loop that misses rows. Managed backups and PITR. One vendor instead of three.

**Negative.** RLS carries a real performance cost when policy predicates are unindexed — this is the most common way RLS "makes Postgres slow", and [DATABASE_CONVENTIONS.md §8](../DATABASE_CONVENTIONS.md) makes indexing every policy predicate mandatory. Policies are a second place authorization lives, so a rule change means changing two things. Debugging "why did this row not appear?" is harder than debugging a `WHERE` clause.

**Risks.** The service-role key bypasses RLS entirely and would nullify the backstop if it became the default connection — hence the hard confinement in [SECURITY.md §3.2](../../SECURITY.md). Supabase region availability may conflict with the residency answer in [Q-04](../OPEN_QUESTIONS.md).

## Revisit when

[Q-04](../OPEN_QUESTIONS.md) resolves in a way Supabase cannot serve, or scale exceeds what the platform supports. The escape route is standard: a Postgres dump and the same policies applied on managed Postgres elsewhere.
