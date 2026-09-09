# ADR-0009: Authentication behind a provider port, with a local adapter

**Status:** Accepted
**Date:** 2026-08-17
**Deciders:** Engineering

## Context

The specification says to use Supabase Auth "where appropriate". Supabase Auth (GoTrue) is genuinely the right thing in production: it owns credential storage, sends verification and password-reset mail, and its `auth.users.id` is already what every RLS policy resolves against.

It is also, on its own, untestable here. No Supabase project exists. Even once one does, a test suite that needs a live GoTrue and a real inbox to check "does a duplicate registration leak that the address exists?" is a suite that runs rarely and is trusted less than it should be — and those are exactly the properties that must not regress.

## Decision

Authentication sits behind an `AuthProvider` port, consistent with [ADR-0004](0004-provider-abstraction.md), with two adapters:

- **`SupabaseAuthAdapter`** — production. GoTrue holds the credential; `parents.password_hash` stays NULL.
- **`LocalAuthAdapter`** — `local` and `ci`. Self-managed Argon2id against our own tables.

Session management is ours in both cases: access tokens are short-lived JWTs, refresh tokens are opaque, hashed at rest, and rotate on every use with reuse detection.

## Options considered

### Supabase Auth only

Fewest moving parts and no credential handling of our own. But the entire auth surface — enumeration resistance, lockout, token rotation, reuse detection — would be either untested or tested against a shared live project, where one developer's test run affects another's.

### Self-managed only

Fully testable, and wrong. Rolling credential storage, verification mail, and reset mail is a large surface with well-understood failure modes, and GoTrue has had far more scrutiny than we would give it.

### Port with both adapters _(chosen)_

Production gets the scrutinised implementation. The tests get a real, complete implementation they can drive offline. Both satisfy one interface expressed in our domain types, so no GoTrue response shape reaches a route handler.

### Why

The deciding argument is that **the security properties worth testing are ours, not the provider's**. Whether a duplicate registration leaks, whether a rotated refresh token revokes its family, whether a reset kills every session — none of that is GoTrue's behaviour, it is ours, and it sits in the routes and the session service which both adapters share. The local adapter exists so those can be exercised on every commit.

Keeping session management ours in both cases follows from the same reasoning: **logout must actually revoke.** A JWT is valid until it expires, so `authenticate` checks the session store on every request. One indexed lookup is the price of revocation meaning something.

## Consequences

**Positive.** The full auth surface is covered by tests that run with no network, no Docker, and no inbox. Swapping provider is configuration. The enumeration and rotation guarantees are asserted rather than assumed.

**Negative.** Two implementations to keep behaviourally aligned, and only one of them runs in production — a genuine risk of drift. The local adapter is real credential-handling code that must be reviewed as such, even though it never runs in a deployed environment.

**Risks.** The Supabase adapter is **currently unverified against a live project**: it is written to the GoTrue REST shape but nothing has exercised it. It must not be deployed before the contract suite runs against a real project. This is flagged in the file itself, not only here.

A second risk is the local adapter's `exposeTokens` option, which returns emailed tokens in API responses so tests can complete the flows. In production that would be a complete authentication bypass. It is derived from `APP_ENV` and cannot be set independently, and the deployed value is `false` by construction.

## Revisit when

A Supabase project exists. At that point the contract suite runs against both adapters, and this ADR is amended with the result — or superseded, if GoTrue's behaviour turns out to differ from the port in a way the port cannot absorb.
