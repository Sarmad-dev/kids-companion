# RevenueCat

How Apple and Google subscriptions are verified, and how to configure the
RevenueCat project this deployment depends on. Read [STORE_BILLING.md](STORE_BILLING.md)
first — the rules there (the client sends a token, never a status; the store
owns the subscription; a notification is a hint to go and ask) all still
apply. This document is about the ONE adapter that actually implements them
live: `services/payments/src/stores/revenuecat.ts`.

---

## 1. Why RevenueCat, and not a direct Apple/Google adapter

`services/payments/src/stores/adapters.ts` refuses to guess Apple's or
Google's own verification APIs, because neither has been read from current
documentation and both are known to change — a wrong guess here fails app
review, not a test. RevenueCat is different: it is **one** stable, versioned,
publicly documented REST API that already holds Apple's and Google's own
server credentials and re-verifies every purchase against them directly. Our
server's job shrinks to "ask RevenueCat what this subscriber has," which is
safe to write from documentation.

**RevenueCat does not replace the verification discipline in this codebase —
it is the thing that makes honouring it practical.** Our server still never
believes the device. It asks RevenueCat's server, every time, exactly as it
would ask Apple's or Google's.

---

## 2. Dashboard configuration

Do this once per environment (a sandbox/staging RevenueCat project and a
production one — never share a signing secret or API key between them).

### 2.1 Prerequisite: the store products already exist

RevenueCat does not create App Store or Play Store products for you. Before
touching the RevenueCat dashboard:

1. In **App Store Connect**, create the two auto-renewable subscription
   products this deployment sells (see `infra/migrations/20260817131300_seed_reference.sql`
   for the plan catalogue — currently `family_monthly` and `family_annual`).
   Note their exact **Product ID** strings.
2. In **Google Play Console**, create the matching subscription products
   (base plans), one per plan. Note their exact **Product ID** (and base plan
   ID) strings.

These are real store identifiers and this document cannot pick them for you —
see the warning at the top of `apps/mobile/src/iap/packages.ts`. Whatever you
create, write down both platforms' product IDs; you need them in §2.4 and §3.

### 2.2 Create the project and add both apps

1. [app.revenuecat.com](https://app.revenuecat.com) → **New project**.
2. **Project settings → Apps** → add an **App Store** app (paste the iOS
   bundle identifier from `apps/mobile/app.json`'s `expo.ios.bundleIdentifier`
   — replace the `app.kidscompanion.placeholder` value there with the real
   one first) and a **Play Store** app (the Android `package` from the same
   file, plus the Play service-account JSON RevenueCat needs to verify Play
   purchases server-side — Play Console → **Setup → API access**).

### 2.3 Create the entitlement

**Project settings → Entitlements → New**. One entitlement, identifier
`premium` (or your own choice — it must match `REVENUECAT_ENTITLEMENT_ID`
below, exactly, everywhere).

Entitlements are the thing RevenueCat resolves for you: several products
(monthly, annual) can all grant the same entitlement, so the app never has to
reason about which product a subscriber bought — only whether they have
`premium`.

### 2.4 Attach products, then build the offering

1. **Products → New** — add the App Store product and the Play Store product
   from §2.1, one at a time, and attach each to the `premium` entitlement.
2. **Offerings → New offering** (usually `default`). Add two **packages**:
   - Identifier `$rc_monthly` → the monthly product.
   - Identifier `$rc_annual` → the annual product.

   These exact identifiers matter: `apps/mobile/src/iap/packages.ts` maps our
   plan codes to RevenueCat's own predefined package keys (`monthly`,
   `annual`), which only resolve when the package identifier is `$rc_monthly`
   / `$rc_annual`. A custom identifier here means updating that file to match.

3. Mark the offering **Current**.

### 2.5 Webhook

**Project settings → Integrations → Webhooks → Add new configuration.**

| Field                | Value                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------- |
| URL                  | `https://<your-api-host>/api/store/notifications/apple_iap`                                 |
| Authorization header | leave off — this deployment uses signature auth, not a shared header                        |
| **Signing secret**   | generate one, paste it into `REVENUECAT_WEBHOOK_SIGNING_SECRET` (server-side only — see §3) |

The URL says `apple_iap` but receives events for **both** stores — see §4.2
for why that is correct rather than a typo. Every event type is fine to
enable; unsupported ones (transfers, aliasing) are safely rejected rather
than mis-applied — see §6.

Once saved, use the dashboard's **Send test event** button and confirm the
API logs a rejected-or-processed line for it (a `TEST` event has no matching
purchase, so `unknown_purchase` / `ignored` is the CORRECT outcome — see
STORE_BILLING.md §3).

### 2.6 API keys

**Project settings → API keys.**

| Key                                         | Where it goes                            | Never goes                            |
| ------------------------------------------- | ---------------------------------------- | ------------------------------------- |
| **Secret key** (`sk_...`)                   | `REVENUECAT_SECRET_API_KEY`, server only | the mobile app, a repo, a log         |
| **Public app-specific key**, App Store app  | `EXPO_PUBLIC_REVENUECAT_IOS_API_KEY`     | — it's designed to ship in the binary |
| **Public app-specific key**, Play Store app | `EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY` | — same                                |

A RevenueCat public key can only start a purchase for the app it was issued
to — it is not the same kind of secret as the server key, which is why it is
the one credential in this whole integration that IS meant to be embedded.
See the file banner in `apps/mobile/src/state/app-context.tsx`.

---

## 3. Server configuration

Set in the API's environment (`.env.example` has the full list):

```bash
STORE_BILLING_ENABLED_STORES=apple_iap,google_play
STORE_BILLING_PROVIDER=live
STORE_BILLING_ENVIRONMENT=sandbox        # production, once you are ready — see §5

REVENUECAT_SECRET_API_KEY=sk_...
REVENUECAT_WEBHOOK_SIGNING_SECRET=...    # from §2.5
REVENUECAT_ENTITLEMENT_ID=premium        # from §2.3
```

`apps/api/src/app.ts` prefers RevenueCat over the raw `APPLE_IAP_*` /
`GOOGLE_PLAY_*` adapters automatically whenever `REVENUECAT_SECRET_API_KEY` is
set — one `createRevenueCatProvider` instance is registered for **both**
`apple_iap` and `google_play`, because one RevenueCat account already covers
both stores.

### 3.1 `store_product_map` still needs the REAL store product IDs

This is the part people expect RevenueCat to remove, and it does not.
`store_product_map` (`infra/migrations/20260817260000_store_billing.sql`)
maps a **store product identifier** — the one you created in App Store
Connect / Play Console in §2.1 — to a `subscription_plans` row. RevenueCat's
package identifiers (`$rc_monthly`) never appear in this table; only the
underlying SKUs do, because that is what `VerifiedPurchase.productId` carries
(see `revenuecat.ts`'s `buildVerifiedPurchase`).

```sql
insert into store_product_map (store, product_id, plan_id, is_active)
values
  ('apple_iap',   '<your App Store product id>', (select id from subscription_plans where code = 'family_monthly'), true),
  ('google_play', '<your Play product id>',       (select id from subscription_plans where code = 'family_monthly'), true),
  ('apple_iap',   '<your App Store annual id>',    (select id from subscription_plans where code = 'family_annual'),  true),
  ('google_play', '<your Play annual id>',          (select id from subscription_plans where code = 'family_annual'),  true);
```

A verified purchase of an unmapped product grants nothing — deliberately, see
STORE_BILLING.md §6 step 2.

---

## 4. Mobile configuration

Set per build (EAS environment variables, or a local `.env` for `expo start`
— these are `EXPO_PUBLIC_*`, so they ARE embedded in the bundle; that is
correct, see §2.6):

```bash
EXPO_PUBLIC_REVENUECAT_IOS_API_KEY=appl_...
EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY=goog_...
```

Neither is read anywhere except `apps/mobile/src/state/app-context.tsx`,
which calls `Purchases.configure({ apiKey })` once, anonymously, at app
launch. Nothing purchases anything at that point — it only opens the SDK's
connection to RevenueCat.

### 4.1 The two files that matter

- **`apps/mobile/src/iap/packages.ts`** — our plan codes (`family_monthly`,
  `family_annual`) → RevenueCat's package keys (`monthly`, `annual`). This is
  the ONLY place a store SKU-adjacent concept lives on the device, and it
  isn't even a SKU — see the file's own banner.
- **`apps/mobile/src/iap/use-store-billing.ts`** — the `useStoreBilling(api)`
  hook every purchase-capable screen calls. It owns:
  - Correlating the device to a subscriber: `Purchases.logIn(parentId)`,
    lazily, the first time a purchase or restore is attempted (not at
    `configure()` time — the app doesn't know who is signed in yet then).
  - `purchase(planCode)` — resolves the current offering, purchases the
    matching package, then calls `/api/store/verify` and trusts **that**
    answer, not RevenueCat's local `CustomerInfo`. Read the file banner; this
    is the one rule that survives the whole swap from raw StoreKit/Billing
    calls to RevenueCat.
  - `restore()` — `Purchases.restorePurchases()`, then one `/api/store/restore`
    call carrying the subscriber id as the receipt token (RevenueCat's
    subscriber record already has everything the store account owns; there is
    no per-purchase receipt to iterate the way there was with a direct native
    SDK).

---

## 5. How a purchase actually flows

1. Parent taps a plan → `app/(parent)/pay-rail.tsx` shows Apple/Google as a
   rail alongside JazzCash/Easypaisa/card **only when** `storeBilling.available`
   (this platform has a store) **and** the plan's `availableRails` includes
   `apple_iap` / `google_play` (see `subscription_plans.available_rails`).
2. Tapping **Continue** on that rail calls `storeBilling.purchase(planCode)` —
   never `POST /api/subscriptions/create`, which is the OTHER rails' checkout
   path and has no meaning for a native store purchase (see the comment above
   `CheckoutResponse` in `pay-rail.tsx`).
3. `use-store-billing.ts` identifies the subscriber, fetches the offering,
   purchases the package. The store's own payment sheet is what the parent
   actually sees and confirms — nothing here is custom UI.
4. On success, the app calls `POST /api/store/verify` with
   `{ store, token: parentId }`. The server:
   - Asks RevenueCat's REST API for that subscriber (`GET /v1/subscribers/{parentId}`).
   - Resolves the `premium` entitlement to a product, then to a
     `store_product_map` row, then to a plan.
   - Writes `store_purchases` and `subscriptions`, exactly as it would for a
     purchase verified any other way.
   - Answers `{ entitled, state, planCode, explanation }`.
5. The app trusts **that** answer, not the SDK's local one, and only then
   shows the plan as active.

A `POST /api/store/notifications/apple_iap` webhook later keeps this in sync
on renewal, cancellation, billing issues, and refunds — re-verified with
RevenueCat the same way, never applied from the webhook payload directly (see
STORE_BILLING.md §3).

---

## 6. What is NOT verified yet — read before flipping the production switch

`REVENUECAT_VERIFICATION` in `revenuecat.ts` is the executable version of this
section; keep them in sync if either changes.

- **No real sandbox purchase has been run through this adapter.** Everything
  in `revenuecat.ts` is written from RevenueCat's REST API v1 and Webhooks
  documentation (fetched 2026-09-18) — the same "written from documentation,
  not yet exercised against the live API" status as `services/voice/src/deepgram-provider.ts`,
  and it carries the same warning banner. Before adding `apple_iap` /
  `google_play` to `STORE_BILLING_VERIFIED_STORES` in a deployed environment:
  1. Create a **sandbox tester** account in App Store Connect and a **license
     tester** in Play Console.
  2. Build the app with EAS (`developmentClient` or `preview` profile —
     Expo Go cannot load native modules like this one).
  3. Buy each plan as each tester, on each platform.
  4. Confirm `/api/store/verify` returns `entitled: true` with the right
     `planCode`.
  5. Confirm the RevenueCat webhook test event round-trips (§2.5), then
     confirm a REAL renewal/cancellation (sandbox subscriptions renew every
     few minutes, which makes this fast to observe) updates `subscriptions`.
  6. Confirm **Restore purchases** on a second, freshly-installed build
     recovers the same entitlement.
- **Whether an unseen `app_user_id` 404s or auto-creates** (200, empty
  `entitlements`) is unconfirmed. Both are handled in `fetchSubscriber`, but
  only one path has ever actually been hit.
- **`period_type` casing** differs between the subscriber API (documented
  lower-case) and webhook events (documented upper-case). Compared
  case-insensitively — a defensive guess, not a confirmed contract.
- **TRANSFER and PRODUCT_CHANGE webhook events are refused, not applied.** An
  upgrade/downgrade or a transfer between `app_user_id`s will not be
  followed — the same open gap Google's linked-token upgrades already are
  (STORE_BILLING.md §7). A family who upgrades mid-cycle needs a manual
  `synchronise()` or support intervention until this is built.
- **Family Sharing and multi-entitlement subscribers are unhandled** — the
  adapter reads exactly one entitlement id, configured once per deployment.
- **`synchronise()` is still not scheduled anywhere** (STORE_BILLING.md §7)
  — this is unchanged by adding RevenueCat.

None of this blocks development or a sandbox trial. It blocks `STORE_BILLING_VERIFIED_STORES`
containing `apple_iap` / `google_play` in a deployed environment, which
`packages/config/src/env.ts` refuses without it.

---

## 7. Local development without any of this

Leave `STORE_BILLING_PROVIDER=mock` (the default) and
`STORE_BILLING_ENABLED_STORES` empty. The mock provider
(`services/payments/src/stores/mock-store.ts`) is a real, self-contained
verification service — tokens like `sometoken.grace` or `sometoken.refunded`
drive it through every state without RevenueCat, an App Store account, or a
network connection. See STORE_BILLING.md §1.
