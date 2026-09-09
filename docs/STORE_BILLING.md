# Mobile store billing

Apple App Store and Google Play subscriptions, verified server-side.

**Nothing has been submitted to either store, and neither adapter is
implemented.** What exists is the architecture, a working mock, and the
configuration checklist below.

---

## 1. The one rule

> **The client sends a token. It never sends a status.**

A device can prove it _attempted_ a purchase — it holds a purchase token from
Play or a transaction identifier from StoreKit. It cannot prove that purchase is
valid, paid for, unrefunded, or still active. Only the store knows, and the only
way to find out is to ask the store from a server.

This is enforced by the shape of the types, not by a review habit:

- `PurchaseReceipt` has three fields: store, token, and an untrusted diagnostic
  hint. There is no `isActive`, no `expiresAt`, no `price`.
- `POST /api/store/verify` validates with a `.strict()` schema, so a client
  sending `entitled: true` gets a **400**, not a silently ignored field that
  some later refactor starts reading.
- Everything written to `store_purchases` comes back from the store.

The shortcut is genuinely tempting — the SDK already told the device it is
subscribed, and forwarding that is one line. It is also a free subscription for
anyone who can modify an app or replay a request, and on Android in a
price-sensitive market that is not an exotic threat model.

---

## 2. The store owns the subscription; we mirror it

Renewals, billing retries, grace periods, cancellations, and expiry all happen
at the store, on its schedule, whether or not we are listening.

`store_purchases` is a **cache of what the store said**. When ours and theirs
disagree, theirs is right. Code that "fixes" a subscription locally gets undone
by the next notification.

| Store state    | Our status  | Entitled?                                                |
| -------------- | ----------- | -------------------------------------------------------- |
| `active`       | `active`    | yes                                                      |
| `trial`        | `trialing`  | yes                                                      |
| `grace_period` | `grace`     | **yes** — the store is retrying; nothing is switched off |
| `on_hold`      | `expired`   | no — recoverable, but access stops meanwhile             |
| `paused`       | `expired`   | no — the subscriber asked for this                       |
| `cancelled`    | `cancelled` | **yes, to the end of the paid period**                   |
| `expired`      | `expired`   | no                                                       |
| `refunded`     | `expired`   | no — immediately, not at period end                      |

Two of those rows carry the product decisions. **Grace entitles** because the
person who would lose access is a child whose parent's card expired. **Cancelled
entitles until the period ends** because they paid for the month.

### Deadlines are applied on read

Both stores eventually tell us an expiry happened. Neither tells us promptly.
`app.store_entitlement` applies elapsed deadlines in SQL, so the gap between a
subscription ending and a notification arriving is never free service.

---

## 3. A notification is a hint to go and ask

The notification handler **records the payload and then ignores it**. It
re-verifies with the store and writes down that answer.

That costs a round trip and buys three things:

- **Out-of-order delivery is harmless.** Both stores deliver at-least-once and
  unordered. A delayed "expired" landing after a renewal cannot kill a live
  subscription, because we ask rather than apply.
- **A forged notification is harmless.** The worst it achieves is making us ask
  a question we already knew the answer to.
- **Replays are idempotent** on `(store, notification_id)`, and an unverified
  notification is never written to that table — otherwise a forgery posted under
  a real id would make the genuine delivery look like a duplicate.

---

## 4. One purchase belongs to one parent

`uq_store_purchases_transaction` on `(store, original_transaction_id)`.

A store account is not our account. One person can sign into a store on several
devices, Family Sharing spreads a purchase further, and nothing stops a token
being pasted to somebody else or lifted from a modified app.

Without that constraint, one subscription silently becomes many. With it, the
second parent's attempt is refused **and recorded** with both account ids —
because one purchase attempted by a dozen accounts is a very different thing
from a family reinstalling on a second device.

The refusal message to the client is deliberately vague. Telling somebody the
purchase belongs to another account confirms the token they hold is a real, live
subscription.

---

## 5. Restore is verification, again

The temptation is to make restore lenient: they already paid, they are only
reinstalling, be generous.

That leniency is the hole. **A restore endpoint that trusts the client is a
purchase endpoint that trusts the client, reached by a different name.** Restore
runs the same verification, the same environment gate, and the same
one-purchase-one-parent rule. What makes it a restore is that the purchase
usually already exists.

---

## 6. Production configuration requirements

### Server-side only — never in the app bundle

> **No credential below is ever shipped in the mobile application.** The app
> receives a token from the store SDK and posts it to our server; the server
> holds the keys. A key in a bundle is a key an attacker has, which is why both
> stores' verification APIs are server-to-server in the first place.

| Variable                                                                                  | Purpose                                                                                |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `STORE_BILLING_ENABLED_STORES`                                                            | Which stores are on. **Empty is valid** — the app works normally without them          |
| `STORE_BILLING_VERIFIED_STORES`                                                           | Human attestation. A deployed env refuses to boot with an enabled-but-unverified store |
| `STORE_BILLING_PROVIDER`                                                                  | `live` or `mock`. `mock` is refused in a deployed environment                          |
| `STORE_BILLING_ENVIRONMENT`                                                               | `sandbox` or `production`. Must be `production` when deployed                          |
| `STORE_BILLING_MOCK_SECRET`                                                               | Signs mock notifications. Local and CI only                                            |
| `STORE_BILLING_SYNC_AFTER_HOURS`                                                          | How stale a purchase may get before we re-ask regardless                               |
| `APPLE_IAP_ISSUER_ID`, `APPLE_IAP_KEY_ID`, `APPLE_IAP_PRIVATE_KEY`, `APPLE_IAP_BUNDLE_ID` | App Store server credentials                                                           |
| `APPLE_IAP_SHARED_SECRET`                                                                 | Legacy receipt verification, where still needed                                        |
| `GOOGLE_PLAY_PACKAGE_NAME`, `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON`                            | Play Developer API credentials                                                         |
| `GOOGLE_PLAY_NOTIFICATION_TOPIC`                                                          | Where Real-time Developer Notifications arrive                                         |

### Before enabling either store in production

1. **Complete the verification checklist** in `APPLE_VERIFICATION` /
   `GOOGLE_VERIFICATION` — having actually read each store's _current_
   documentation and run its sandbox. Then add the store to
   `STORE_BILLING_VERIFIED_STORES`.
2. **Populate `store_product_map`.** A verified purchase of an unmapped product
   grants nothing. That is deliberate: silently falling back to free would take
   away something a family paid for, and silently granting the best plan would
   give away something they did not.
3. **Confirm `STORE_BILLING_ENVIRONMENT=production`.** A sandbox purchase
   honoured in production is a free subscription for anyone with a test account,
   and both stores make sandbox and production receipts easy to confuse.
4. **Wire notification delivery** — Apple's server notification endpoint and a
   Google Pub/Sub subscription — to `POST /api/store/notifications/:store`.
5. **Schedule `synchronise()`.** Notifications are unreliable, not absent.
   Nothing calls it on a timer yet.
6. **Acknowledge Google purchases inside its window.** An unacknowledged
   purchase is automatically refunded — one of the few places where doing
   nothing actively loses money. This is on the Google checklist and is not
   implemented.

---

## 7. Not done, and deliberately

- **Neither live adapter is implemented.** Both refuse with a message naming
  what is outstanding. Returning a fabricated `active` would be the worst
  failure available to this codebase: subscriptions granted to real families
  that nobody paid for, from an integration that looks finished.
- **Nothing has been submitted to any store.** A store adapter that misbehaves
  does not merely fail a payment, it fails app review — and review is not a
  retry loop.
- **No purchase UI in the child app.** Payments stay out of the child
  experience.
- **`synchronise()` is not scheduled**, and Google acknowledgement is not
  implemented (§6.6).
- **Family Sharing is unhandled.** One Apple purchase can cover several people;
  whether that maps to several parent accounts is a product decision, not an
  adapter one, and today the one-purchase-one-parent rule simply refuses the
  second.
- **Upgrades and downgrades are unhandled.** Google's linked purchase token
  needs following, or one subscription looks like two.
- **Store billing and `SubscriptionProvider` are still separate paths**, as with
  the payment rails. Unifying them waits on [Q-02](OPEN_QUESTIONS.md).
