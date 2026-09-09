# ADR-0008: Drop Turborepo; hoist node_modules for React Native

**Status:** Accepted — supersedes the task-orchestration and linking decisions in [ADR-0001](0001-monorepo-tooling.md)
**Date:** 2026-08-17
**Deciders:** Engineering

## Context

[ADR-0001](0001-monorepo-tooling.md) chose pnpm workspaces with `node-linker=isolated` plus Turborepo. Standing up the actual applications surfaced two problems it did not anticipate.

**Turborepo is a native binary.** `turbo.exe` fails on a developer machine without the Microsoft Visual C++ Redistributable, exiting `3221225781` (`STATUS_DLL_NOT_FOUND`) with no actionable message. Every task in the repo ran through it, so a missing system runtime took out `build`, `dev`, `typecheck`, and `test` at once.

**React Native does not tolerate isolated linking.** This was recorded as the known risk [Q-05](../OPEN_QUESTIONS.md). Metro's resolver does not reliably follow pnpm's symlinked layout, and Expo's own guidance for pnpm monorepos is to hoist.

## Decision

1. **Remove Turborepo.** Task orchestration uses `pnpm --recursive`, which already runs `build` in topological order. Type checking runs `tsc -b` against the solution file at the root — TypeScript project references give correct ordering and incremental builds without a task runner.
2. **Set `node-linker=hoisted`.**

## Options considered

### For orchestration

**Keep Turborepo, document the runtime prerequisite.** Caching is genuinely useful and the fix is a one-click install. But it makes a clean checkout fail on a stock Windows machine with a cryptic error, and the value of remote caching is speculative at nine small packages.

**Nx.** Same native-binary class of problem, more configuration.

**`pnpm --recursive` (chosen).** No native binary, no configuration, topological ordering built in. What is lost is task-level caching — measurable only once the repo is much larger.

### For linking

**Keep `isolated`, hoist inside `apps/mobile` only.** Preferred on paper, and what [Q-05](../OPEN_QUESTIONS.md) proposed. `node-linker` is an install-wide setting in pnpm, not per-project, so this is not actually available.

**`hoisted` (chosen).** Matches Expo's documented guidance for pnpm monorepos.

### Why

Both decisions come down to the same requirement: **a clean checkout must install and build without prior machine setup or platform-specific workarounds.** Caching and install-time strictness are optimisations; a repository that does not boot is not.

The strictness loss is smaller than it first appears. `node-linker=isolated` made an undeclared import fail at _resolution_. `import-x/no-extraneous-dependencies` makes it fail at _lint_, which every pre-commit hook and CI run executes. The failure moves from install time to commit time — later, but still before merge, and with a clearer error message.

## Consequences

**Positive.** No native binary in the critical path. Expo and Metro work without special handling. `tsc -b` is faster than a task runner shelling out per package. One fewer tool to learn.

**Negative.** No task-level caching, so a full `pnpm build` always rebuilds — acceptable at this size, less so at thirty packages. Hoisting means an undeclared import _resolves_ at runtime and is caught by lint rather than immediately, so the feedback loop is slower and the guarantee now depends on lint actually running.

**Risks.** Hoisting can produce version-conflict surprises when two packages need different majors of the same dependency; pnpm's `overrides` and the `catalog` are the mitigation. If lint is ever bypassed, phantom dependencies can reach `main` — which is why `import-x/no-extraneous-dependencies` is `error`, not `warn`, and runs in the pre-commit hook.

## Revisit when

The workspace grows past roughly twenty packages and full builds become the bottleneck — then reintroduce a task runner, with the native-binary prerequisite documented in the setup instructions rather than discovered on first run.
