# ADR-0005: Parent-only authentication with derived child sessions

**Status:** Accepted
**Date:** 2026-08-17
**Deciders:** Engineering, Product

## Context

Two people use this product: a parent who manages the account, and a child who talks to the companion. The obvious design — an account per user — is wrong here, and the reason is worth stating precisely.

**Any credential implies a recovery path.** A recovery path for a child requires collecting more identifying data about that child: a second email, a security question, a phone number, a verification step. Every one of those is data we would rather not hold ([PRIVACY.md §2](../../PRIVACY.md)), protecting an account whose contents the parent is entitled to see anyway.

## Decision

- **The parent is the only authenticated principal.** Email + password (Argon2id) or email OTP, with an access/refresh token pair.
- **A child profile is data owned by a parent**, not an account. No password, no email, no recovery path.
- **Child mode runs on a derived session token**: minted by an authenticated parent, device-bound, 60-minute lifetime, instantly revocable, scoped to conversation endpoints only.
- **The parent gate** guards the child→parent transition and is explicitly _not_ an authentication control.

## Options considered

### Option A — An account per child

Standard, and lets a child log in on any device. Requires credential recovery for a 5-year-old, which requires more child data, for an account the parent can read regardless. It also creates a child-identified authentication surface — precisely the thing worth not having in a children's product.

### Option B — No child identity at all; everything under the parent session

Simplest. But then a device left with a child holds a full parent session: billing, settings, other profiles, data export. Unacceptable blast radius for a device that will be dropped, shared, and handed around.

### Option C — Derived child session _(chosen)_

The child gets a real, bounded, revocable identity for the conversation surface, with none of the credential machinery.

### Why this won

It gets the security property of Option A — a compromised child-mode device does not expose billing, settings, or other children — without the data cost. The 60-minute lifetime doubles as a natural session-length ceiling, which is a child-safety feature ([CHILD_SAFETY.md §2](../CHILD_SAFETY.md)), not just a token setting.

**On the parent gate:** it is a child barrier, and calling it anything stronger would be self-deception. A 10-year-old watching a parent type a PIN gets past it. It limits blast radius; the parent's real session, plus re-authentication for destructive and financial actions, is the actual control.

## Consequences

**Positive.** No child credentials to store, breach, or recover. Minimal blast radius on a shared or lost device. Instant revocation — a parent can end a session remotely. The session TTL enforces a natural time limit.

**Negative.** A child cannot use the product without a parent starting a session on that device, which is a real friction point and needs to be made pleasant rather than laborious. Multi-device is more involved. A parent handing a device to a child does mean a device-bound token exists on that device.

**Risks.** Refresh-token theft is the main one, mitigated by rotation with reuse detection: a reused token revokes the whole family and raises a security event. Q-15 (multi-parent and guardian accounts) will complicate the ownership model, and interacts with [Q-07](../OPEN_QUESTIONS.md).

## Revisit when

[Q-15](../OPEN_QUESTIONS.md) is answered, or product evidence shows the parent-starts-the-session friction is materially hurting usage. Note that the fix would be a better handover flow, not child credentials.
