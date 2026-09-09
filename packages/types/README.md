# @kids/types

Domain types for the whole system. **Zero runtime footprint.**

## Rules

1. **No imports.** Not Zod, not Node builtins, not another workspace package. ESLint enforces this.
2. **Types, interfaces, and `const` arrays only.** No functions, no classes, no side effects.
3. **No `enum`.** `erasableSyntaxOnly` bans it, and `const` array + derived union is better anyway — iterable, JSON-safe, exhaustively checkable, no runtime object.

## Why the constraint

This package is the shared vocabulary between a React Native app, a Node API, and a React dashboard. The moment it gains a runtime import, that import ships to all three — and one of them will be a platform where it does not belong.

Validation logic belongs in `@kids/validation`. Behaviour belongs in `@kids/shared` or a service.
