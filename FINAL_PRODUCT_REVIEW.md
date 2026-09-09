# Final product review

**Date:** 2026-08-23
**Lenses:** product engineering, UX, security, QA.
**Scope:** nineteen review areas, nine removal categories.
**Changes made:** three fixes, two dependencies removed, eleven tests added.
Complete suite run after each. **1,461 passing, 5 skipped, 0 failing.**

---

## The headline

One serious defect was found, in the interaction the whole product exists for.

> **The character never spoke.**
>
> After every voice turn the app called
> `audio.play({ uri: '/api/voice/audio/<key>' })` — a **relative path**, to an
> **authenticated** endpoint, from a native audio player that receives neither
> the base URL nor the session token the API client adds to every other request.
>
> It fails twice over: a relative path has no origin to resolve against on a
> phone, and that route answers 401 without a bearer token. The reply _text_
> still arrived, so the screen looked like it worked — to anyone who could read.
> The users are three to ten years old and the product is voice-first.

Fixed, with four regression tests. Details in F-01.

---

## Review

| Area                    | Verdict   | Note                                                                     |
| ----------------------- | --------- | ------------------------------------------------------------------------ |
| Child experience        | **Fixed** | Voice playback was broken (F-01). Otherwise strong                       |
| Parent experience       | Good      | Consistent, explained, no dark patterns                                  |
| Navigation              | Good      | One nav, same shape on every page                                        |
| Accessibility           | **Fixed** | Field hints unannounced (F-02); Reduce Motion ignored on mobile (F-04)   |
| Loading states          | Good      | Every page has one, shaped like its content                              |
| Empty states            | Good      | Say _why_ it is empty and what fills it                                  |
| Error states            | Good      | Never render the error object                                            |
| Animations              | **Fixed** | Looped regardless of the Reduce Motion setting (F-04)                    |
| Voice interaction       | **Fixed** | See F-01                                                                 |
| AI responses            | Good      | Safety-gated, name-substituted at read time                              |
| Character experience    | Good      | Faces and colour for pre-readers                                         |
| Speech practice         | Good      | Scored, banded, never punitive                                           |
| Progress visualisation  | Good      | Every metric carries what it is _not_                                    |
| Subscription experience | Good      | Cancel is as easy as subscribe                                           |
| Onboarding              | Adequate  | Works; the child list refetch is per-page (O-01)                         |
| Consent flow            | Good      | Versioned, per-child, enforced by RLS                                    |
| Privacy controls        | Caveat    | Real controls; transcript retention deletes nothing (see readiness F-05) |
| Performance             | Good      | Measured; see `docs/PERFORMANCE_REPORT.md`                               |
| Security                | Good      | Audited; see `docs/SECURITY_AUDIT.md`                                    |

## Removal pass

| Asked to remove         | Found           | Action                                                |
| ----------------------- | --------------- | ----------------------------------------------------- |
| Placeholder UI          | **none**        | Every "placeholder" hit is a documented backend one   |
| Dummy text              | **none**        | One "dummy" — the anti-enumeration password hash      |
| Development-only UI     | **none**        | No `__DEV__`, no debug panels, no test buttons        |
| Console debugging       | **none**        | Zero `console.*` in `apps`, `packages`, `services`    |
| Exposed internal errors | **none**        | Error boundaries deliberately do not render the error |
| Unused dependencies     | **2 removed**   | A third, `pino`, was restored — see F-03              |
| Dead code               | 2 known, no new | Not actionable as measured — see O-02                 |
| Unnecessary API calls   | 1 pattern       | Per-page child refetch (O-01), not a defect           |
| Inconsistent components | **none**        | Zero pages bypass the shared components               |

No TODO, FIXME, XXX, HACK, "lorem ipsum", "coming soon", or "TBD" anywhere in
`apps`, `packages`, or `services`.

---

## Fixes

### F-01 · Voice replies could not play · **serious**

**Area:** child experience, voice interaction.

`ConversationScreen` handed the audio player a bare route:

```ts
await audio.play({ uri: `/api/voice/audio/${turn.audio.key}` });
```

The player performs its own request, outside the API client, so it gets none of
what the client adds:

| Missing                | Consequence                                                                    |
| ---------------------- | ------------------------------------------------------------------------------ |
| Base URL               | A relative path has no origin on a native platform. Nothing to resolve against |
| `authorization` header | The route is authenticated and scoped to the child's own conversations — 401   |

The `play` port already accepted `headers`; none were passed.

**Why nothing caught it.** The screens have no tests, and the failure is silent:
the turn succeeds, the transcript renders, and only the _sound_ is missing. A
test asserting "the turn returned 200" passes. So does a human demo, if the
person watching can read.

**Fix.** A `mediaSource(route)` method on the API client returning an absolute
URL and the auth header together. Deliberately on the client rather than in the
screen, so the token stays where that file's opening comment says it stays — the
screen never handles it.

Four regression tests: absolute URL, token present, header **absent** rather
than `Bearer undefined` when signed out, and no doubled slash. The old value,
`/api/voice/audio/abc`, fails the first assertion.

### F-02 · Form hints were never announced · **accessibility**

**Area:** accessibility, parent experience.

`Field` renders a hint with `id="{htmlFor}-hint"` and takes the control as
`children` — leaving the association to each caller. Across **19** usages,
callers did it **zero** times. The only two `aria-describedby` in the dashboard
belong to `CheckboxRow` (which owns its own input) and the login error.

A screen reader announced _"Minutes a day, number"_ and never _"0 means no daily
limit"_ — the half that tells you what to type.

**Fix.** `Field` now clones its child and injects `aria-describedby`, merging
with any the caller set rather than replacing it (the attribute is a
space-separated **list**; overwriting silently drops half of what would be read).
Fixing 19 call sites individually would have worked today and rotted by the
twentieth.

The merge logic is a pure function in `lib/aria.ts` with 7 tests, because there
is no DOM test environment in this workspace and logic that only exists inside a
component is logic nothing verifies.

_This fix initially broke the web build_ — `exactOptionalPropertyTypes` rejects
passing `string | undefined` to an optional prop. Worth recording because
`tsc -b` passed and only `next build` caught it: the solution build does not
typecheck `apps/web`. CI runs `pnpm build`, so CI would have caught it.

### F-03 · Removed two unused dependencies — and put a third back

`apps/api` declared `@fastify/under-pressure` and `openapi-types` and imported
neither. Removed; the runtime image is smaller and the manifest is honest.

**`pino` was removed and restored, because the removal was wrong.** No file
imports it — the logger comes from `@kids/shared` — but `buildApp`'s _inferred
return type_ references pino's `Logger`. Without the direct dependency,
TypeScript can only reach that type through
`packages/shared/node_modules/pino`, which is not a portable path:

```
apps/api/src/app.ts(164,14): error TS2883: The inferred type of 'buildApp'
cannot be named without a reference to 'Logger' from
'../../../packages/shared/node_modules/pino/pino.js'.
```

It is a genuine dependency at the type level, and a scanner looking for
`from 'pino'` cannot see that. Caught by the pre-push hook, which is the
last gate before this leaves the machine — not by `tsc -b`, whose incremental
cache had not invalidated `apps/api` at the moment it was run.

**The lesson for the scan, not just this package:** "no import statement" is
not the same as "unused". Two of the three candidates were genuinely dead; the
third was load-bearing and invisible. `react-dom` in `apps/web` was kept for the
same class of reason — Next requires it at runtime with no explicit import — so
the scan's false-positive rate here was one in four.

### F-04 · The child's app ignored "Reduce Motion" · **accessibility**

**Area:** accessibility, animations, child experience.

Found on a second pass, going back over the areas the first pass had judged
structurally rather than by reading.

The dashboard honours `prefers-reduced-motion` in `globals.css`. **The mobile
app honoured nothing.** It runs two continuous loops:

| Loop              | When               | What it does                                    |
| ----------------- | ------------------ | ----------------------------------------------- |
| Talk button pulse | while listening    | scales a 168pt button, 1.4 s per cycle, forever |
| Character bob     | **always visible** | translates the avatar, faster while speaking    |

Constant motion is a problem for vestibular sensitivity, and it is a problem for
autistic children — who are a real part of the audience for a patient,
repetitive conversation partner, not an edge case to handle later. Both
platforms expose the setting and expect an app to honour it.

**Fix.** A `useReducedMotion()` hook reading `AccessibilityInfo`, subscribed to
changes because someone turning the setting on mid-session is usually someone
who has just been made uncomfortable. Both loops hold still when it is on.

**Nothing is lost by stopping.** Every state the motion reinforced is carried
elsewhere: the talk button changes colour, emoji **and** label; the character's
speaking state is in its accessibility label and, more to the point, in the
audio that is playing. The motion was decoration on top of signals that already
existed — which is exactly the test for whether it is safe to remove.

Defaults to motion-on, because the read is asynchronous: briefly animating for
someone who asked for stillness is a smaller wrong than permanently freezing the
interface for everyone if the query fails.

---

## Second pass: the areas judged structurally, read properly

The first pass marked several areas "Good" on structural evidence — shared
component usage, presence of loading and error files, state coverage. That is
weak evidence about a _flow_. Re-reading them end to end found F-04 and
confirmed the rest.

| Area              | What the closer read found                                                                                                                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Subscription      | Cancel is **one click, no confirmation, and reversible** — with copy that says what keeps working and until when. No retention offer, no guilt, no maze. Correct.                                             |
| Account deletion  | Requires the password again, because "a session is not enough to start something irreversible". Failure copy says _"Nothing has been deleted."_                                                               |
| Friction symmetry | Cancelling is easy and undoable; deleting is hard and permanent. The friction matches the consequence in both directions, which is design rather than accident.                                               |
| Progress charts   | Inline SVG, and **every chart ships a visually hidden table with the real numbers** — the chart is decoration, the table is the content. Bars are zero-baselined, so no truncated axis flatters a quiet week. |
| Onboarding        | The parent area is a **deliberate dead end** in child mode: no password field exists there at all. A child who wanders in cannot do anything and is not made to feel they did something wrong.                |
| Consent           | Versioned, per-child, enforced by RLS rather than by a checkbox.                                                                                                                                              |

---

## Observations, not changed

### O-01 · Every page refetches the child list

All eight child-scoped dashboard pages call `getChildren()` independently. The
layout fetches nothing, so each navigation costs one extra request.

**Not a defect, and not fixed here.** The within-page waterfalls are _necessary_
— you cannot fetch a child's dashboard before you know which child — and the
pages parallelise correctly once they can (`Promise.all([getDashboard, getProgress])`).
Sharing the list would mean restructuring data flow from layout to page, which is
the architectural change this phase was told to avoid.

### O-02 · The dead-code scan was not actionable

A scan for exported symbols referenced nowhere else reported **308 across 64
files** — and it is mostly noise. The bulk are exported option-bag types
(`SessionServiceOptions`, `MockStoreOptions`) used as parameter types _within
their own file_: public API surface, not dead code. Spot-checking the one that
looked real, `verifyMockWebhook`, showed it used on line 254 of the file that
declares it.

Deleting exported types wholesale would be an API change dressed up as a
cleanup. The two genuinely dead exports in this codebase were found in earlier
phases by reading rather than scanning — `guardedTurn` and `paymentSummary` —
and both are already documented in `docs/TEST_REPORT.md`.

**Reported rather than acted on**, because a cleanup driven by a scanner with
this false-positive rate would do more harm than the cruft it removes.

### O-03 · Six workspace dependencies are unused

`@kids/types` in `packages/validation`, `services/auth`, `services/learning` and
`apps/mobile`; `@kids/validation` in `apps/mobile`; `@kids/shared` in
`packages/db`. Verified: zero references in each package's `src`.

**Not removed.** Each also needs its paired `tsconfig` reference removed —
`verify:references` enforces both directions — which means editing five packages
in a phase told not to restructure. They cost nothing at runtime; they are
workspace symlinks, not shipped bytes. A one-line follow-up, listed here so it
is not lost.

### O-04 · A finding from the readiness review, re-checked

While scanning for dead code I found `services/safety/src/escalation.ts`, which
I had not accounted for when writing `PRODUCTION_READINESS.md` F-01.

It implements the escalation **decision** — three rules, tested, genuinely used.
It does not change the finding: what is missing is **delivery**, and F-01 says
exactly that ("detection works, delivery does not"). Re-checked and it holds.

---

## What is genuinely good

Worth recording, because a review that only lists faults misrepresents the thing.

**The four states are first-class.** `LoadingCards`, `EmptyState`, `ErrorState`
and the banners live in the component library, not in each page. Loading
skeletons are shaped like the content so the page does not jump. Empty states
say _why_ — "nothing yet, this fills in after your child's first chat" rather
than "No data", which reads like a fault. Errors never render the error object,
deliberately and with the reason written down.

**A metric cannot render without its caveat.** `MetricCard` takes a `MetricKey`,
not a label, so the explanation _and_ what the number is **not** measuring come
along automatically. Rendered as visible text, not a tooltip — invisible on a
touchscreen, in print, and to anyone who does not know to hover. For a product
that shows parents numbers about their child, this is the right instinct.

**The child theme is designed for the actual user.** 72pt touch targets against
the 44pt adult floor, because a missed tap does not read as "I missed" to a
four-year-old — it reads as "it's broken", and they stop trying. Characters have
faces as well as names. The listening colour is deliberately _not_ red, because
red means stop.

**Audio is discarded in a `finally`.** On every path, including every failure.
A child's voice sitting in a cache directory is exactly the data the server
refuses to keep, and a phone is a device that gets lost.

**Component consistency is real, not aspirational.** Zero pages bypass `Card`
with a raw `className="card"`. Every page uses `PageHeader`. That does not happen
by accident across ten pages.

---

## After the changes

|                                                                                                    |                                       |
| -------------------------------------------------------------------------------------------------- | ------------------------------------- |
| Test suite                                                                                         | **1,461 passed**, 5 skipped, 0 failed |
| `tsc -b` · `eslint` · `prettier`                                                                   | pass                                  |
| `pnpm build` (api + web)                                                                           | pass                                  |
| `verify:no-secrets` · `verify:deploy` · `verify:audit` · `verify:references` · `verify:migrations` | pass                                  |

Tests added this phase: 7 (`aria`) + 4 (`mediaSource`) = **11**.

---

## Does it feel like one product?

Mostly yes, with one caveat that is not about polish.

**Coherent:** the dashboard reads as one application — one navigation, one
component vocabulary, one voice in the copy, four states everywhere. The child
app has its own deliberate visual language and stays inside it. The two are
recognisably the same product without pretending a four-year-old and their
parent want the same interface.

**The caveat:** several things a user would experience as features are
configured but not implemented — transcript retention a parent can set that
deletes nothing, an escalation path that reaches no human, an AI spend ceiling
that does not cap. Those are in `PRODUCTION_READINESS.md`, not repeated here,
and no amount of UI polish addresses them.

This phase found the product's _surface_ in good shape and one hole straight
through the middle of it. The hole is fixed. The gaps behind the surface are
documented, unresolved, and the reason the readiness review says **not ready**.
