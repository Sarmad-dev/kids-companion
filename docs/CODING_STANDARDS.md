# Coding Standards

Formatting is Prettier's problem and is not discussed here. This document covers the decisions a formatter cannot make.

---

## 1. TypeScript

### 1.1 Strictness is not negotiable

`tsconfig.base.json` enables `strict` plus several flags people commonly turn off. Each is there for a reason:

| Flag                         | Why                                                                                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `noUncheckedIndexedAccess`   | `arr[0]` is `T \| undefined`. Most array-index crashes are this flag turned off.                                                           |
| `exactOptionalPropertyTypes` | Distinguishes "absent" from "explicitly undefined" — which matters when a PATCH must not clear a field it did not mention.                 |
| `erasableSyntaxOnly`         | No TS-only runtime constructs, so Node's native type stripping works. Practically: **no `enum`, no `namespace`, no parameter properties.** |
| `verbatimModuleSyntax`       | Type imports are explicit and erased predictably.                                                                                          |
| `noEmitOnError`              | We never ship a build that did not typecheck.                                                                                              |

### 1.2 Banned constructs

**`any`.** Use `unknown` and narrow. `any` does not silence a type error, it relocates it to runtime — in a product where the runtime is a conversation with a child.

**`as` for anything but narrowing you have proven.** A type assertion is a claim the compiler cannot check. Validate with Zod instead and let inference do the work.

**`enum`** — banned by `erasableSyntaxOnly`, and the replacement is better anyway:

```ts
// ✗
enum AgeBand {
  Early = 'early',
  Emerging = 'emerging',
}

// ✓
export const AGE_BANDS = ['early', 'emerging', 'developing', 'fluent'] as const;
export type AgeBand = (typeof AGE_BANDS)[number];
```

The union is iterable, JSON-serialisable, exhaustively checkable in a `switch`, and has no runtime object.

**`@ts-ignore`.** Use `@ts-expect-error` with a comment explaining why, so it fails loudly once the underlying problem is fixed.

### 1.3 Branded IDs

Every entity ID is branded. `ChildId` and `ParentId` are both strings at runtime, and mixing them is exactly the bug that leaks one family's data to another.

```ts
declare const brand: unique symbol;
type Brand<T, B> = T & { readonly [brand]: B };

export type ParentId = Brand<string, 'ParentId'>;
export type ChildId = Brand<string, 'ChildId'>;
export type ConversationId = Brand<string, 'ConversationId'>;
```

A function taking `ChildId` cannot silently accept a `ParentId`. In a system whose worst failure mode is cross-tenant data exposure, this costs nothing and closes a whole class of bug at compile time.

### 1.4 Make illegal states unrepresentable

Prefer a discriminated union over a bag of optional fields whose valid combinations live only in a developer's head:

```ts
// ✗ — what does { status: 'blocked', text: 'hello' } mean?
type TurnResult = { status: string; text?: string; reason?: string };

// ✓
type TurnResult =
  | { status: 'ok'; text: string; audioUrl: string }
  | { status: 'blocked'; layer: SafetyLayer; redirect: string }
  | { status: 'degraded'; reason: DegradationReason; fallback: string };
```

`switch` over the discriminant, and `switch-exhaustiveness-check` fails the build when a new variant is added and a handler is missed.

### 1.5 Immutability by default

`readonly` on parameters and fields. Never mutate a function argument — `no-param-reassign` enforces it.

---

## 2. Naming

| Thing                | Convention                          | Example                         |
| -------------------- | ----------------------------------- | ------------------------------- |
| Files                | kebab-case                          | `child-profile-service.ts`      |
| Test files           | mirror + `.test.ts`                 | `child-profile-service.test.ts` |
| Types, interfaces    | PascalCase, **no `I` prefix**       | `ChildProfile`                  |
| Functions, variables | camelCase                           | `resolveAgeBand`                |
| Constants            | SCREAMING_SNAKE                     | `MAX_TURN_LENGTH`               |
| Env vars             | SCREAMING_SNAKE, prefixed by domain | `STT_TIMEOUT_MS`                |
| Database             | snake_case, plural tables           | `child_profiles`                |
| Booleans             | `is` / `has` / `should` / `can`     | `isRetentionEnabled`            |
| Ports                | `<Capability>Provider`              | `SpeechToTextProvider`          |
| Adapters             | `<Vendor><Capability>Adapter`       | `DeepgramSpeechToTextAdapter`   |

Duration variables carry their unit: `ttlSeconds`, `timeoutMs`. A bare `timeout` invites a 1000× mistake.

---

## 3. Module structure

### 3.1 Every package looks the same

```
packages/<name>/
├── src/
│   ├── index.ts        public API — the only entry point
│   └── ...
├── package.json
├── tsconfig.json
└── README.md
```

`index.ts` is the contract. Deep imports into another package's internals are forbidden; if something needs exporting, export it deliberately.

### 3.2 Named exports only

Default exports rename themselves at each import site, which defeats search and makes refactors unreliable. The exception is where a framework demands one (a React Native screen, a Next.js page).

### 3.3 Import order

Enforced by `import-x/order`: builtin → external → internal → parent → sibling → index, with blank lines between groups and alphabetised within them.

---

## 4. Functions

- **One reason to exist.** If you need "and" to describe it, split it.
- **Under ~50 lines.** Not a hard rule, but a reliable smell.
- **Options object beyond three parameters.** `createProfile(name, 2019, 'ur', true, false)` is unreadable at the call site and easy to get wrong.
- **No boolean parameters.** `synthesize(text, true)` tells the reader nothing. Use a named option or two functions.
- **Return early.** Guard clauses beat nesting.

### 4.1 Async

- `await` everything. `no-floating-promises` fails the build on an unawaited promise, because an unhandled rejection in the voice loop means a child gets silence.
- Every external call has an explicit timeout. There is no acceptable default of "wait forever" on a path a child is standing in front of.
- Prefer `Promise.all` where independent work can overlap — the input-safety/prompt-assembly overlap in the voice loop is worth real milliseconds.

### 4.2 Dependency injection over module singletons

Pass dependencies in. A module that reaches out to a global database client cannot be tested without one, and every test that needs a container is a test nobody runs.

`Clock` is the concrete case, and the ESLint rule about `new Date()` enforces it: time-dependent logic — quotas, token expiry, retention, session limits — must be testable without waiting.

---

## 5. Comments

Comment **why**, never what. The code says what.

```ts
// ✗
// increment the counter
counter += 1;

// ✓
// Count the whole utterance as one turn even when STT splits it, so a child
// pausing mid-sentence is not billed twice against their daily quota.
counter += 1;
```

Mark unfinished work as `TODO(#issue): description` — a TODO without an issue number is a note to nobody.

Anything involving safety, privacy, or a legal constraint gets a comment explaining the constraint. The next person must not be able to "simplify" it away without seeing why it exists.

---

## 6. Domain rules

These are specific to this product and are checked in review:

1. **Never log transcript text or a child identifier.** Use the redacting logger. `no-console` is an error for exactly this reason. See [LOGGING.md](LOGGING.md).
2. **Never trust a client-supplied age, quota, entitlement, or safety verdict.** All are resolved server-side.
3. **Never call a vendor SDK from domain code.** Go through the port.
4. **Never let a safety check fail open.** An error or timeout in a classifier blocks the turn.
5. **Never surface a raw error to a child.** Every failure path produces something the character can say.
6. **Never use `Math.random()` for anything security-relevant.** `node:crypto` — enforced by lint.
7. **Never store a personal-data field without a purpose, classification, and retention rule** in [PRIVACY.md §3](../PRIVACY.md).

---

## 7. React and React Native

- Function components with hooks. No class components.
- Component files under ~200 lines; extract when they grow.
- Business logic lives in hooks or services, not in JSX.
- Every child-facing interactive element has an accessible label. **Pre-readers cannot read an error message** — child-mode states are conveyed by character animation and voice, with text as a secondary channel only.
- Performance is a correctness concern on the target device. Memoise deliberately, virtualise lists, and profile on low-end Android — not on a simulator.

---

## 8. When to break a rule

Any of these can be broken with a comment explaining why, and a reviewer who agrees — **except** the seven in §6. Those are product-safety invariants, and changing one is a decision that belongs in an ADR, not in a pull request.
