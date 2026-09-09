# ADR-0001: pnpm workspaces with Turborepo

**Status:** Accepted — the **task-orchestration** and **module-linking** decisions here are superseded by [ADR-0008](0008-build-orchestration-and-module-linking.md). The choice of pnpm workspaces still stands.
**Date:** 2026-08-17
**Deciders:** Engineering

## Context

The product needs a React Native app, a web dashboard, and a Node API sharing domain types, validation schemas, and provider abstractions. Keeping those in separate repositories would mean versioning and publishing internal packages before there is a single user — a large tax for no benefit at this stage.

A monorepo also lets us enforce something we care about structurally: [dependency direction](../../ARCHITECTURE.md), so `packages/` can never import from `apps/`.

## Decision

**pnpm workspaces** for dependency management, **Turborepo** for task orchestration.

## Options considered

### Option A — npm or Yarn workspaces

Adequate, and one fewer tool to install. But both hoist by default, which permits **phantom dependencies**: a package importing something it never declared, working only because a sibling installed it. That breaks silently later, and the failure surfaces far from its cause.

### Option B — Nx

More capable than Turborepo — generators, dependency graph analysis, richer plugins. Also a much larger conceptual surface and a stronger opinion about project structure than a three-app repo needs.

### Option C — pnpm + Turborepo _(chosen)_

pnpm's isolated `node_modules` makes an undeclared import fail immediately, at the boundary we want enforced. Its content-addressed store keeps disk and install time low, which matters with React Native in the tree. Turborepo adds a cached task graph with minimal configuration and no opinion about how code is organised.

### Why this won

pnpm's strictness is doing real work here, not just saving disk. Our architecture rests on explicit dependency direction, and a package manager that makes undeclared imports fail at install time enforces that continuously — rather than at code review, sometimes.

Turborepo over Nx is a deliberate choice of less capability for less complexity. If the repo grows to a size where Nx's graph tooling earns its overhead, migrating is straightforward.

## Consequences

**Positive.** Undeclared imports fail immediately. Cached task graphs keep CI fast. Shared types and schemas are used directly, with no publish step. The catalog in `pnpm-workspace.yaml` keeps shared dependency versions in one place.

**Negative.** pnpm's symlinked layout breaks tools that assume a flat `node_modules` — React Native's Metro bundler is the known risk, tracked as [Q-05](../OPEN_QUESTIONS.md). Everyone needs pnpm via corepack rather than the npm they already have.

**Risks.** If Metro forces `node-linker=hoisted` workspace-wide, we lose the phantom-dependency guarantee that motivated pnpm. Mitigation: set it in `apps/mobile/.npmrc` only, keeping strictness everywhere else.

## Revisit when

Metro proves incompatible with isolated linking even scoped to the mobile app, or the repo outgrows Turborepo's task model.
