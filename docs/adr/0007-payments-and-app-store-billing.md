# ADR-0007: Multi-rail payments behind one port

**Status:** Accepted (partial — rail selection is deferred to [Q-02](../OPEN_QUESTIONS.md))
**Date:** 2026-08-17
**Deciders:** Engineering, Business

## Context

The launch market is Pakistan, where card penetration is low and mobile wallets — JazzCash and Easypaisa — are how people actually pay. International expansion needs cards, which means Stripe or an equivalent.

Cutting across both: **Apple and Google require digital subscriptions sold inside a mobile app to use their billing**, at roughly 15–30 %. Since the child experience is a mobile app, this collides directly with the local rails the launch market needs. Store rules on steering users to external payment vary by jurisdiction and change frequently.

That collision is a business and legal decision, not an engineering one, and it is unresolved.

## Decision

Engineering commits to the **structure** now and defers **rail selection** to [Q-02](../OPEN_QUESTIONS.md).

Three concerns are separated, deliberately, because they are commonly conflated:

1. **Payment collection** — vendor-specific, per rail, behind a `PaymentProvider` port.
2. **Subscription state** — our own record, reconciled from verified webhooks. Never inferred from a client claim.
3. **Entitlement** — the runtime question "may this child take another turn?", answered from our own state, in one place.

**Entitlement checks never call a payment vendor synchronously.** A webhook outage, a vendor incident, or a reconciliation backlog must never stop a paying child from talking.

## Options considered

### Option A — App-store billing only

Simplest, fully compliant, works everywhere. Surrenders 15–30 % of revenue in a market with thin margins, and excludes people who have a mobile wallet but no card or store payment method — which in Pakistan is a large share of the addressable market.

### Option B — Local rails only, web checkout, app as a pure client

Preserves margin and matches how the market pays. Constrained by store steering rules, adds funnel friction (the parent must leave the app to subscribe), and carries real app-review risk.

### Option C — Both, chosen per platform and market

Highest revenue potential, highest complexity: multiple webhook formats, multiple refund and dunning flows, multiple failure modes, and reconciliation across all of them.

### Why the structure is decided now and the rails are not

Every one of these options needs the same three-way separation. Building it now costs nothing extra and keeps the decision genuinely open, so engineering is not blocked on a business answer — while pricing, unit economics, and the whole funnel legitimately are.

The separation earns its keep independently of Q-02. Entitlement resolved from our own state is what makes the system resilient to a vendor incident; a design that asks Stripe whether a child may speak has coupled a child's experience to a third party's uptime.

## Consequences

**Positive.** Engineering proceeds without the business answer. Adding a rail is one adapter plus a webhook handler. Entitlement is one code path regardless of how the parent paid. Vendor outages do not interrupt paying users.

**Negative.** More structure than a single-rail integration needs. Reconciliation across rails is genuinely complex. Refunds, proration, and dunning differ per rail and cannot be fully abstracted — some of that difference will surface in product behaviour.

**Risks.** A store rejects the app over payment handling — the reason Q-02 must be answered before Phase 6, not during review. Local rail APIs are less mature than Stripe's, with weaker sandboxes and thinner documentation; budget more integration time than the Stripe experience suggests.

**Security note.** Every webhook is signature-verified before processing. An unverified webhook endpoint is a free-subscription vulnerability, and it is the single most common flaw in payment integrations.

## Revisit when

[Q-02](../OPEN_QUESTIONS.md) is answered — at which point this ADR is superseded by one recording the chosen rails and why. Also revisit if store policy changes materially, which it does with some regularity.
