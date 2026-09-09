# Payment rails

Four ways to take money in the launch market, behind one interface. **None of
them is production-ready, and none of them claims to be.**

Read [SUBSCRIPTIONS.md](SUBSCRIPTIONS.md) first — that is entitlement. This is
money.

---

## 1. What is actually built

| Rail            | Sandbox    | Live               | Refunds                | Recurring      |
| --------------- | ---------- | ------------------ | ---------------------- | -------------- |
| JazzCash        | ✅ working | ❌ not implemented | assumed none           | assumed none   |
| Easypaisa       | ✅ working | ❌ not implemented | assumed none           | assumed none   |
| Carrier billing | ✅ working | ❌ not implemented | expected none          | expected none  |
| Card            | ✅ working | ❌ not implemented | assumed full + partial | assumed native |

Every "assumed" in that table is a guess made in the safe direction, not an
observation. See §4.

### What "not implemented" means here

It means the live adapter **refuses**, loudly, with a message naming what has
not been verified. It does not return a plausible success, and it does not fall
back to sandbox.

That is deliberate. A stub that pretends to work is the most dangerous thing
this package could contain: it produces a subscription nobody paid for, and the
discovery happens weeks later during reconciliation, with a family's money
involved.

---

## 2. Why no endpoints appear in this code

> **Not one endpoint URL, field name, or signature construction for any of these
> four providers appears anywhere in this repository.**

None has been read from the provider's own integration documentation. Writing a
plausible one would produce code that passes review, passes every test written
against our own guess, and fails on the first real transaction.

The specific things that cannot be inferred, and what each one costs if wrong:

| Unknown                  | Cost of guessing                                            |
| ------------------------ | ----------------------------------------------------------- |
| Signature construction   | Every callback rejected — or worse, every callback accepted |
| Amount units             | A bill 100× too large                                       |
| Status code mapping      | A paying customer treated as unpaid                         |
| Callback retry semantics | Double-charging on redelivery                               |
| Refund window and rules  | A refund promised that cannot be made                       |

Each is a line in `VerificationChecklist`, and every rail currently reports all
eight as outstanding.

---

## 3. The verification gate

`PAYMENTS_VERIFIED_RAILS` is a human attestation, deliberately separate from
`PAYMENTS_ENABLED_RAILS`.

A rail can be **enabled** in sandbox for development without anyone claiming it
is finished. A **deployed** environment refuses to boot with a rail that is
enabled but not on the verified list:

```
PAYMENTS_ENABLED_RAILS: "jazzcash" is enabled but not listed in
PAYMENTS_VERIFIED_RAILS — its wire format has not been verified against the
provider's own documentation and sandbox, and it must not take real money
```

That is what makes "do not claim production-ready until verified" a boot failure
rather than a comment somebody can overlook.

**Before adding a rail to that list**, tick every box in its `RailVerification`
in code, having actually: read the current integration documentation, run the
sandbox, observed a success, a decline, a duplicate callback, and a refund (or
confirmed refunds do not exist).

---

## 4. Capabilities are assumptions, and they fail safe

Each rail declares what it can do. Every value is set to whatever is survivable
if the guess is wrong:

- **`refunds: 'none'`** on the wallets, so no refund button is offered for
  something that might be impossible. An unoffered refund that turns out to work
  is a feature; a promised one that cannot be made is a support crisis.
- **`recurring: 'none'`**, so the subscription layer prompts each period rather
  than assuming a standing arrangement that may not exist. A product that
  assumed otherwise would quietly stop billing.
- **Amount ceilings `undefined`** — which means _unknown_, not _unlimited_.
  Wallets and carrier billing both impose them, and the yearly plan may simply
  be unpayable on some rails. `subscription_plans.available_rails` will need
  reconciling against real ceilings once they are known.

---

## 5. Carrier billing deserves its own paragraph

Three consequences that are product decisions, not technical ones:

**Refunds almost certainly do not exist.** Money off a prepaid balance generally
does not come back through the same channel.

**Whoever holds the phone can spend money.** In a product used by children, on a
family's phone, that is a child-safety consideration. "My seven-year-old bought
a year's subscription" is foreseeable, not an edge case, and the parental gate
in front of purchase is doing more work on this rail than any other.

**Revenue share is heavy** — materially worse than card processing, possibly
enough to make some plans uneconomic. That belongs with
[Q-02](OPEN_QUESTIONS.md).

---

## 6. Payment state is not subscription state

Two tables, two vocabularies, joined by a nullable foreign key and nothing else.

```
payments.status        initiated → pending → authorized → captured
                                          ↘ failed / cancelled / refunded / unresolved

subscriptions.status   free → trialing → active → grace → cancelled → expired
```

No word appears in both, on purpose. They come apart routinely:

- a payment succeeds against no subscription (a duplicate, a retry of something
  already credited),
- a subscription sits in grace while three payments fail,
- carrier billing has no recurring, so one period is one fresh payment.

Collapsing them gives a single status column that is wrong in both directions,
and makes "the payment succeeded but the child still cannot talk"
unreproducible.

`unresolved` is a real payment state, not an error: a callback that never
arrived leaves a payment neither succeeded nor failed, and pretending otherwise
is how a customer gets charged without being credited.

---

## 7. Idempotency, reconciliation, failures

**Idempotency** — `uq_payments_idempotency` on `(parent_id, idempotency_key)`.
The record is claimed _before_ the rail is called, so a client retrying after a
timeout cannot become a second charge. Callbacks are separately idempotent on
`(rail, external_event_id)`.

**Reconciliation** — `reconcile()` asks each rail what actually happened for
every payment it has not given a final answer about. This is the only thing that
can find a customer who paid and was never credited. A rail that cannot answer
(`statusQuery: false`) is skipped rather than guessed at.

**Failures** — mapped into our own vocabulary, split into retryable and
terminal. Retrying a decline annoys a customer; retrying a network failure is
exactly right. `unknown` is deliberately **not** retryable: an unrecognised code
might mean "already charged", and retrying on that guess risks double-charging.

**An unverified callback is never written to `payment_events`** — same reasoning
as the subscription webhook. The table is keyed on `(rail, external_event_id)`,
so a forgery posted under a real event id would make the genuine delivery look
like a duplicate.

---

## 8. Card data

There is no parameter for a card number anywhere in this package. The processor
collects card details on the customer's device; this application receives a
token.

- No column in the schema can hold a PAN.
- `redactPayload` strips card-shaped values by field name **and** by Luhn check
  before anything is stored.
- `assertNoCardData` refuses an initiation carrying something card-shaped, and
  is wired into the card rail rather than merely exported.

---

## 9. Known limitations

- **Nothing is verified.** Every rail is sandbox-only. This is the headline.
- **Two payment abstractions coexist.** `SubscriptionProvider` (subscription
  checkout) and `PaymentRailAdapter` (payments) are separate ports, and
  subscription checkout still goes through the former. Unifying them is
  deliberate follow-up work once [Q-02](OPEN_QUESTIONS.md) picks a rail —
  wiring them together now would bake in an answer nobody has chosen.
- **Reconciliation is not scheduled.** `reconcile()` exists and is tested;
  nothing calls it on a timer yet.
- **No partial-refund accounting on the subscription side.** A partial refund is
  recorded in `payment_refunds` and the ledger, but the subscription layer
  treats any refund as ending entitlement.
- **`available_rails` is not enforced against rail ceilings**, because the
  ceilings are unknown. A plan may be offered on a rail that cannot take its
  price.
- **No dunning schedule.** Failure codes are classified as retryable or not;
  nothing yet acts on that classification to schedule retries.
