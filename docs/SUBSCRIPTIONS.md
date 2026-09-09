# Subscriptions

How a family gets a plan, keeps it, loses it, and gets it back — and why the code
is shaped the way it is.

This is the operational companion to [ADR-0007](adr/0007-payments-and-app-store-billing.md),
which decided the structure. Rail selection remains open ([Q-02](OPEN_QUESTIONS.md)).

---

## 1. The one property everything protects

> **A client cannot grant itself a subscription.**

Not "the client is not supposed to". Not "we check a flag". There is no code path
from a request body to `subscriptions.status = 'active'`.

The mechanism is a type. `applyLifecycleEvent` — the only function that decides a
subscription's next state — takes a `VerifiedWebhookEvent`, and the only way to
construct one is `SubscriptionProvider.verifyAndParseWebhook`, which takes raw
bytes and a signature. A handler that wanted to mark something paid would have
to forge an HMAC to do it.

`POST /api/subscriptions/create` writes one row, in a different table
(`subscription_checkouts`), which grants nothing. A parent who starts a checkout
and closes the tab is on the free tier, which is correct.

---

## 2. States

| State       | Entitled?                      | What it means                                              |
| ----------- | ------------------------------ | ---------------------------------------------------------- |
| `free`      | no                             | No subscription. The free plan's limits apply.             |
| `trialing`  | yes                            | A trial is running. Nothing has been charged.              |
| `active`    | yes                            | Paid and renewing.                                         |
| `grace`     | **yes**                        | A renewal failed. Access continues for `plan.grace_days`.  |
| `past_due`  | yes                            | Legacy vendor state. The reconciler no longer produces it. |
| `cancelled` | **yes, until the period ends** | Will not renew. The paid period is honoured.               |
| `expired`   | no                             | Over. Back to the free plan; nothing is deleted.           |

Two of those rows carry the product decisions worth arguing about.

**`grace` is entitled.** A card expires, a wallet empties, a bank declines a
foreign transaction — and the person who would lose access is a five-year-old
mid-story who did none of those things. Access continues while the payment is
sorted out.

**`cancelled` is entitled until the period ends.** A parent who cancels on day 2
of a month they paid for keeps it until day 30. Revoking immediately is taking
back a purchased period, and it generates exactly the refund request it was
trying to avoid.

### Deadlines are applied on read

A grace window closes whether or not a background job notices. Between a
deadline passing and a sweep running lies a window in which a stored status is a
lie — and that window is where free service hides.

So every read resolves through `app.subscription_state`, which applies elapsed
deadlines in SQL, and through `effectiveStatus` in TypeScript for the same
reason. `sweepExpired` exists to make stored rows match reality for an
operator's ad-hoc query; correctness does not depend on it having run.

Both take the evaluation instant as an argument rather than reading the database
clock, so the decision belongs to the application's injected `Clock` — which is
what makes "what does this account look like the moment the window closes?" a
test rather than a wait.

---

## 3. Plans

`FREE`, `WEEKLY`, `MONTHLY`, `YEARLY`, `FAMILY`. All five live in
`subscription_plans`, and so does every number attached to them: price, currency,
billing interval, trial days, grace days, and every limit the product enforces.

Adding a plan is an `INSERT`. Changing a price is an `UPDATE`.

There is no price literal anywhere in the application, and
`services/payments/src/pricing-source.test.ts` scans the source to keep it that
way — it fails on a plan price appearing in `apps/`, `services/`, or
`packages/`, and on a branch over a plan code inside a file that also mentions
money. A price in two places is a parent charged one amount and shown another.

---

## 4. Webhooks

The endpoint is `POST /api/subscriptions/webhook/:rail`. It has no session,
because a payment rail does not have one — the signature **is** the
authentication.

### Authenticated

HMAC-SHA-256 over `timestamp.body`, compared in constant time, verified **before
the body is parsed**. Parsing first means running a JSON parser and then our own
field handling over bytes from an unauthenticated source.

The route reads the raw bytes through a scoped content-type parser. A body that
has been through `JSON.parse` and re-serialised no longer hashes to what the
vendor signed, and "we verify signatures" quietly becomes "we verify our own
re-encoding".

### Idempotent

A unique index on `(rail, external_event_id)`. The insert is the **first**
statement in the transaction, so a redelivery is detected before any other work
happens. `delivery_count` records how many times an id arrived — a retrying rail
is normal; a flood is not.

### Replay-safe

Two independent layers, because they catch different things.

The signed **timestamp** bounds how long a captured request stays postable
(`PAYMENTS_WEBHOOK_TOLERANCE_SECONDS`, default 300). It is inside the signed
material, so it cannot be moved forward without breaking the signature.

**Event ordering** (`subscriptions.last_event_at`, taken from the vendor's
`occurred_at`) stops a genuinely old event from applying even when it arrives
with a fresh signature. A replayed `subscription.renewed` from last month is a
real message that has already had its effect.

### Transaction-safe

One transaction covers the event row, the subscription, the ledger entry, and
the checkout. Any failure rolls all of it back and returns a 5xx so the rail
retries against a clean slate. A partial application — entitlement granted, no
record of the charge — is the one outcome a retry could not repair.

Failures are recorded in a _separate_ transaction afterwards, or the record of
the failure would roll back with the failure it records.

### Logged

`payment_events` keeps what we were told. `audit_logs` keeps what we did about
it. They answer different questions, and both are needed on the day they
disagree.

### An unverified event is never written to `payment_events`

This looks like lost forensic data and is actually a closed vulnerability.

The table's idempotency key is `(rail, external_event_id)`. An attacker who
observes or guesses a real event id could post a forgery **first**; the genuine
delivery would then hit the unique index and be discarded as a duplicate. A
forged webhook must not be able to suppress a real one.

Unverified events go to the audit log, which has no such key, and change
nothing.

---

## 5. Adding a rail

Implement `SubscriptionProvider`: four methods, one of them the signature check.
Map the vendor's event names onto the eight canonical types in
`WEBHOOK_EVENT_TYPES`.

Nothing else changes. The lifecycle state machine, the reconciler, the endpoints,
and the dashboard never learn a vendor's spelling.

`services/payments/src/mock-provider.ts` is the reference implementation, and it
is not a stub — it implements Stripe's signature scheme properly, because a mock
that always verifies would make every webhook test pass while proving nothing.

---

## 6. What is deliberately absent

- **No card data.** No table has a column that could hold a PAN. Payloads pass
  through `redactPayload`, which strips card-shaped fields by name _and_ by Luhn
  check — the second is what catches a PAN a vendor put in `metadata.note`.
- **No checkout on the web dashboard.** Payment happens through the store or
  wallet the parent signed up with. Taking card details here would put this
  application in PCI scope it is designed to stay out of.
- **No staff access to billing.** `billing:manage_own` is granted to `parent`
  and to no staff role. A support agent who can cancel a family's plan is a
  social engineering target.
- **No deletion for non-payment.** An expired subscription drops a family to the
  free tier. Conversations, progress, and profiles are untouched.

---

## 7. Known limitations

- **The sweep is not scheduled.** `sweepExpired` exists and is tested; nothing
  calls it on a timer yet. Correctness does not depend on it (§2), but stored
  statuses will lag until a scheduler runs it.
- **Cancel and resume write locally before the rail confirms.** A parent needs
  to see their own click take effect. Cancel records the intent even if the rail
  is unreachable — losing a cancellation because a vendor was down means charging
  someone who asked not to be charged. Resume does the opposite and fails loudly,
  because showing "active" for a plan the rail will not bill means the family
  loses access later with no warning. Both diverge from the vendor until
  reconciliation; nothing yet reconciles them automatically.
- **Proration is not implemented.** There is no plan-change flow. A parent moving
  between plans starts a new checkout.
- **Refunds end entitlement immediately** and are not partial-aware. A partial
  refund is currently treated as a full one.
- **One live subscription per parent**, enforced by a partial unique index. A
  family cannot hold two plans at once, which is right for today's catalogue and
  would need revisiting for add-ons.
