# Claude Design prompt — Kids Companion mobile app

> Paste everything below the line into Claude Design.

---

## 1. What you are designing

Design the complete **mobile app UI** for **Kids Companion** — a voice-first AI conversation
companion for children aged 3–10. A child talks out loud to an animated 3D character; the
character listens, understands, and speaks back, in English or Urdu. A parent keeps full
visibility and control from a separate, password-gated area of the same app.

- Platform: **React Native (Expo)**, iOS + Android, **portrait only**, light appearance only.
- Primary target device: **low-end Android on intermittent mobile data**. The design must
  survive a 360×640 screen and a slow first paint.
- Initial market: **Pakistan**, then international. English and Urdu (Urdu is **RTL** — every
  screen needs an RTL-safe layout).
- Deliver artboards at **390 × 844** (iPhone 14) and a **360 × 800** Android variant for any
  screen whose layout meaningfully changes.

The app is **two products in one binary**, and they must look and feel like two different
things:

| | **Child mode** | **Parent mode** |
|---|---|---|
| Audience | Pre-readers, 3–10 | Adults |
| Vocabulary | Character, colour, shape, voice, big round buttons | Labels, forms, tables, charts, inline validation |
| Text | Never the only channel of meaning | Primary channel, information-dense |
| Touch target | **72 pt minimum** | **44 pt minimum** |
| Corners | Round / pill. Nothing a child taps has a sharp corner | 6 pt radius, conventional |
| Tone | Warm, saturated, cream background | Calm, neutral, grey-white background |

---

## 2. Non-negotiable design rules

These are product invariants, not preferences. A design that breaks one is wrong.

1. **Pre-readers must be able to use child mode.** Meaning is carried by character animation,
   colour, and voice. Every child-mode control has **three channels at once**: a face/icon, a
   colour, and a label. Never rely on the label alone.
2. **A child never sees an error message.** No status codes, no request IDs, no "error", no
   stack, no provider name. A failure becomes **one warm sentence in the character's voice**,
   plus a "Try again" button only when retrying could plausibly help.
3. **No dark patterns anywhere.** No streaks, no loss framing, no "your friend misses you", no
   artificial urgency, no variable rewards, no engagement-maximising design aimed at a child.
   **Session limits exist to end sessions**, and must be designed as a gentle, satisfying stop
   — not as a wall or a nag.
4. **No advertising, no upsell, no price and no plan name ever appears in child mode.**
   Monetisation is a parent-mode surface only.
5. **Latency cover is a design requirement.** The moment a child stops talking, the character
   must visibly acknowledge — a nod, an ear twitch, a thinking pose — *before* the network
   answers. 1.8 seconds of stillness reads as "broken" to a four-year-old.
6. **Nothing in child mode is on a timer the child can see.** No countdowns, no progress
   percentages, no "3 of 20". A child who wanders off mid-sentence comes back to a screen that
   waited for them.
7. **Progress shown to a child has no numbers and no comparisons** — only bars that fill up.
   Real figures exist only in parent mode.
8. **Unearned things are dimmed, never hidden.** A child seeing what is still to come is
   encouraged; a child seeing an empty screen is not.
9. **Motion is calm.** Nothing flashes, nothing competes for attention, nothing bounces to
   demand a tap. Animation exists to show the app is alive and that something is happening.
10. **Respect Reduce Motion.** Every animated state needs a still equivalent that loses no
    meaning (colour, face and label already change — stillness must cost nothing).
11. **A parent can always see everything and delete everything.** Nothing about a child is
    hidden from their parent.

---

## 3. Design tokens (use these exact values)

### Shared

```
spacing     xs 4 · sm 8 · md 16 · lg 24 · xl 40 · xxl 64
radii       sm 6 · md 12 · pill 999
touch       parent 44 · child 72 · talk button 168
```

### Child mode palette

```
background     #fff6e5   warm cream — every child screen sits on this
accent         #ff8a3d   the default child button
card           #ffffff
text           #1a1c1f
textMuted      #5b6069
shadow         rgba(58, 42, 20, 0.14)

Buddy          #f2a03d   warm orange
Lily           #a978d8   violet
Captain Sky    #3d8ce0   blue
Professor Owl  #3fa37a   green

listening      #2f9e6e   the talk button while recording — deliberately NOT red, red means stop
thinking       #8f9aa8   the talk button while waiting
warning        #a86800   the offline banner
```

Character colours must be **distinguishable without relying on hue alone** — vary lightness,
and pair every colour with its own face and shape.

### Child mode type

```
hero      40 / 800   "Hello!"
title     28 / 800   screen headings
body      20 / 400   sentences, speech bubbles
caption   16 / 700   button sub-labels
line height 1.4×
```

### Parent mode palette + type

```
background   #f4f5f7      surface #ffffff      border #dcdfe4
text         #1a1c1f      textMuted #5b6069
primary      #1a4fa0      danger #b3261e      success #1f7a4d      warning #a86800

display 32 / 700 · title 22 / 700 · body 16 / 400 · caption 12 / 600
```

---

## 4. The cast

Four characters, each a **full 3D diorama** — the character rig *plus* its own set, its own
hero camera angle, and a warm three-point lighting rig.

| Slug | Name | Set | Colour | Personality | Ages |
|---|---|---|---|---|---|
| `buddy-the-dog` | **Buddy the Dog** | a sunny back yard | `#f2a03d` | cheerful, simple, endlessly encouraging. Quadruped: ears + tail | 3–5, 6–8 |
| `lily-the-fairy` | **Lily the Fairy** | a woodland glade | `#a978d8` | gentle, calm, imaginative, notices small wonders. Biped: wings + arms | 3–5, 6–8, 9–10 |
| `captain-sky` | **Captain Sky** | a space platform | `#3d8ce0` | adventurous explorer, gentle problem-and-resolution stories. Biped: arms | 6–8, 9–10 |
| `professor-owl` | **Professor Owl** | a book-lined study | `#3fa37a` | patient, curious, loves "how does it work" questions. Wings, hinged beak | 6–8, 9–10 |

Fallback flat representation (used in grids, loading states, and if 3D fails): a **filled
circle in the character's colour carrying its face** — 🐶 Buddy, 🧚 Lily, 🚀 Sky, 🦉 Owl.
Design a properly illustrated version of this circular avatar as part of the deliverable, at
72 / 110 / 120 / 140 / 180 / 200 pt.

---

## 5. Existing screen inventory — redesign all of these

Child mode has **no back button, no tabs, no deep links and no history stack**. Every screen
below Home returns Home in one tap via a muted "🏠 Go home" pill at the bottom. Design the
navigation as that flat graph, not as a stack.

### Child mode

1. **Welcome** — full-bleed hero: character avatar (180 pt), "Hello!" in hero type, one line of
   body text. Two stacked pill buttons: **"Let's play!" 👋** in accent, and **"For grown-ups"
   🔒** in muted grey. This is the only door into parent mode.
2. **Who's playing? (child select)** — a grid of child cards, each an avatar and a first name on
   a white card, plus **"Add another child" ➕** in muted. Design the **empty state** too: a
   parent with no children yet gets a parent-mode "Add your first child" screen instead.
3. **Who shall we play with? (character select)** — a grid of four character cards, each filled
   with that character's own colour, its face large, its name in white. Design a locked variant
   (not allowed by parental controls, or needs a paid plan) that reads as "not today" rather
   than as an upsell.
4. **Home** — the character's avatar (120 pt) and "Hello, {name}!", then a **fixed** six-card
   grid whose icons **never reorder** (a child learns "the star one is my badges" long before
   they can read "Badges"):
   `💬 Chat` (orange) · `🎤 Talk` (green) · `📖 Story` (violet) · `🗣️ Say it` (blue) ·
   `🔤 Words` (green) · `⭐ Stars` (accent). Below the grid, a muted **"My progress" 🌱** pill.
   *(Add a Settings entry point here — see §7.)*
5. **Conversation / Talk / Story** — the hero screen. Full spec in **§6**.
6. **Say it (speech practice)** — a grid of exercise cards, `👏` for syllable drills and `🗣️`
   for word drills, plus the exercise title. *(The practice session itself does not exist yet —
   design it, see §7.)*
7. **Words (vocabulary)** — "Words I've used!" and a wrapping grid of white word chips.
   Empty state: *"Chat with your friend and your words will appear here."*
8. **Stars (achievements)** — a badge grid. Earned badges are full colour; unearned use the
   same layout at 35% opacity with a blank tile, never hidden. Badges:
   `⭐ first try` · `🏅 ten tries` · `🏆 fifty tries` · `🚩 first chat` · `🚀 five chats` ·
   `☀️ three days` · `🧭 explorer`.
9. **My progress (child)** — "Look how you're growing!", the character avatar, then three rows:
   `🔤 Words` · `💬 Chats` · `🗣️ Practice`, each a label above a **20 pt pill-shaped fill bar**
   in that category's colour. **No numbers, no totals, no percentages, no comparison.**
10. **Change things (child settings)** — deliberately tiny: **"Different friend" 🔄** and
    **"Different player" 🙂**, plus one line: *"Grown-ups can change everything else in the
    parent app."* Nothing a child can touch may weaken a parental control.

### Parent mode (already in the app)

11. **Sign in** — email and password, "Sign in" primary, "New here? Create an account", "Back to
    playing". One generic failure sentence: the API deliberately cannot distinguish a wrong
    password from an unknown account, and the design must not imply it can.
12. **Create an account** — email, password (minimum 12 characters), confirm. Plus a separate
    **"Check your email"** screen shown when the account exists but the address is unverified.
13. **Add a child** — first name or nickname, birth **year**, birth **month** (1–12), and a
    language segmented control (English / Urdu). Deliberately minimal: no surname, no photo, no
    school, no address — and the design must not imply there could be.
14. **Consent gate** — shown before a child's first conversation, while the parent is still
    holding the phone. Each required consent is its own bordered card with its own heading, its
    own plain-language body, and a small grey rationale line. One primary button, **"I agree,
    and I am the parent"**, and a quiet "Not now". Optional consents are never bundled in here.

### Shared states already in the app

- **Offline banner** — a persistent warning-coloured strip at the very top (not a toast):
  *"📡 No internet right now — some things are resting."*
- **Thinking / loading (child)** — never a bare spinner: the character avatar stays on screen,
  with a spinner and "Thinking…" beneath it.
- **Friendly error (child)** — character avatar, a white speech bubble carrying one warm
  sentence, and an optional "Try again 🔄" pill. Copy to design with:
  - offline: *"I can't hear you from here! Let's try again when the internet is back."*
  - slow: *"Hmm, that took a while. Shall we try once more?"*
  - server: *"Oh! I got a bit muddled. Let's try again in a moment."*
  - signed out: *"Let's go and find a grown-up to help!"*
  - blocked or limited: *"Let's play again a bit later!"*
  - stories used up: *"We've made all our stories for this week! Shall we just talk instead?"*
  - not heard: *"Ooh, I didn't quite catch that! Can you say it again?"*
  - microphone blocked: *"I need to be able to hear you! A grown-up can help with that."*

---

## 6. The conversation screen — the heart of the product

This screen renders a **live 3D character**, and it is the one screen that has to be beautiful.
Design it as a **full-bleed 3D diorama with a floating UI layer on top of it** — the diorama
*is* the background, not a picture inside a card.

### Layout

- **Layer 1 — the stage.** The character's whole diorama, edge to edge, top to bottom, behind
  everything including the status-bar area. Where the set does not reach, the character's own
  flat colour washes through.
- **Layer 2 — the overlay**, `space-between`, 24 pt padding, and **transparent to drags** so a
  child can spin the character by dragging anywhere the buttons are not.
  - **Top:** the speech bubble, or the prompt pill.
  - **Bottom:** the talk button, then the muted "🏠 Go home" pill.

### Framing rules (already implemented — design to them)

- 50° vertical field of view. The character occupies **~36% of the screen height** and at most
  **~52% of its width**, on a tall phone and a wide tablet alike.
- The child can **drag to orbit** and **pinch to zoom** between **0.45× and 3×** the fitted
  distance. The camera **cannot drop below the horizon**, and a pan that wanders too far is
  eased back — a four-year-old must not be able to lose the character.
- Lighting is warm three-point: key `#fff3d6`, fill `#cfe3ff`, rim `#e8f1ff`, over a soft
  hemisphere. Keep the mood warm, friendly and consistent across all four sets.

### Text over artwork

Any text on this screen carries **its own background** — never rely on what happens to be
behind it that frame.

- **Speech bubble** — white, 24 pt radius, max 90% width, 20 pt centred text. This is the
  caption channel for children who can read; it is never the only channel.
- **Prompt pill** (idle, nothing said yet) — 92% white, fully rounded:
  *"What shall we talk about?"* in chat mode, *"Shall we make a story?"* in story mode.

### The talk button — the single most important control in the app

**168 pt circle**, always in the same place on every screen that has one. It carries a large
face, a short label beneath it, and a colour. It has six states, and **all of them change
colour, face and label together** so the state survives Reduce Motion:

| State | Fill | Face | Label | Motion |
|---|---|---|---|---|
| idle | character colour | 🎤 | "Talk to me!" | still |
| requesting permission | character colour | 🎤 | "One moment…" | still, not tappable |
| **recording** | **`#2f9e6e` green** | 👂 | "I'm listening!" | **one slow breath per 1.4 s, scale 1 → 1.08** |
| thinking | `#8f9aa8` grey | 💭 | "Thinking…" | still, not tappable |
| speaking | character colour | 🎤 | "Tap to talk" | **stays tappable — interrupting is normal and children do it constantly** |
| failed | character colour | 🎤 | "Talk to me!" | still |

Design all six, plus the **disabled / offline** variant.

### Character moods (the 3D rig's five states)

Show a key frame for each. These are driven by head tilt and turn, chest breathing, brow
position, blink rate, and limb swing:

- **Resting** — slow head sway (~3.6 s), gentle breath, a blink every ~4 s. Idle, alive,
  patient.
- **Listening** — head tilted noticeably toward the child (~9°), brows lifted, faster breath,
  ears/wings/arms more active. Visibly *attending*.
- **Thinking** — the biggest head tilt and turn, brows slightly up, fastest blink. This is the
  latency cover, and it must read instantly.
- **Talking** — mouth or beak hinging, quick head bob (~0.85 s), strongest limb motion, deepest
  breath.
- **Sad** — failure only. Brows droop (−6°), almost no motion, slow blink. Sympathetic, never
  alarming, never scary.

### Additional states for this screen

- **Diorama loading** — the flat character avatar (72 pt) centred over the character's colour
  wash while the model loads. First launch only.
- **3D unavailable / model failed** — falls back to the flat animated avatar at 160 pt on the
  colour wash. This must look intentional, not broken.
- **Story mode** — the same loop with a different frame. Give it its own visual treatment (see
  §7 for the story screens that do not exist yet).

---

## 7. Screens that do not exist yet — design these too

These are required by the product but have never been built. Design them from scratch, in the
right mode's visual language.

### Child mode

- **Splash / launch screen** and **app icon**.
- **Handoff screen** — "Please give the phone to a grown-up", shown when a child taps something
  that needs an adult. Warm, not a rejection.
- **Microphone permission priming** — a friendly screen *before* the OS dialog, explaining in
  the character's voice that they need to be able to hear you. A child will not understand the
  system dialog; this is what a nearby adult reads.
- **Time's up** — the daily or per-session limit is reached. This must feel like a **satisfying
  ending**, not a wall: the character says goodbye warmly and the screen offers nothing to tap
  that would extend the session. No countdown leading up to it, and no "come back tomorrow!"
  hook.
- **Quiet hours / paused by a parent** — the child is told *"Let's play again a bit later!"*.
  They are never told they were blocked, or by whom.
- **Character detail / preview** — tap a character on the select screen to meet them first: the
  3D character in their own set, their tagline, and a "Let's play with {name}!" button.
- **Practice session flow** (today the exercise cards are a dead end):
  - **Exercise intro** — the word or syllable to say, big, with the character demonstrating.
  - **Recording an attempt** — the talk button in its listening state, the target above it.
  - **Feedback** — four bands, all of them kind: **excellent / good / nearly / keep going**.
    Design each as a character reaction plus a colour plus a face. "Keep going" must be
    indistinguishable in warmth from "excellent" — no red, no cross, no score number.
  - **Session complete** — what was practised, and a gentle stop.
- **Story mode screens** — a story seed ("what shall the story be about?") picker, the story in
  progress (the conversation loop framed as storytelling), and a **story finished** screen.
- **Achievement earned** — a brief, calm celebration when a badge unlocks, which gets out of the
  way on its own after ~1.8 s. No confetti spam, no share sheet, no streak.
- **Word detail** — tap a chip in Words to hear the character say that word again.
- **Full-screen offline** — for when the app opens with no connection at all.
- **Child settings, expanded** — still only things a child may safely touch: change character,
  change player, and (if the parent allows it) language. Plus a quiet **"For grown-ups 🔒"**
  route out.

### Parent mode — bring the whole dashboard into the app

The parent dashboard currently exists only as a separate web app. Design **mobile-native
versions of all of it**, reachable behind the parent sign-in:

- **Parent gate** — a small adult-only challenge (an arithmetic or written-number question)
  shown before parent mode opens, so a child who taps "For grown-ups" cannot get in. Design it
  to be uninteresting to a child and trivial for an adult.
- **Parent home / dashboard** — for the selected child: minutes chatting today and this week, a
  30-day bar chart of minutes per day, conversation count, words used, new vocabulary, stories
  completed, practice attempts, active days. Plus **Levels** (vocabulary, pronunciation,
  conversation skill — worded as descriptive bands such as "getting started", never as a score)
  and **Milestones**. Every one of these carries the caption: *"These describe how the app was
  used. None of it is an assessment of your child."*
- **Safety moments** — counts and categories only, over 30 days, with an escalated count. The
  product never stores what was said in a flag, so the design must not imply a drill-down that
  cannot exist. Include the explanatory note.
- **Children** — the list of child profiles, with add / edit / pause / archive / **delete**.
  Design the irreversible-delete confirmation carefully.
- **Child profile (parent view)** — name, birth month and year, age band (3–5 / 6–8 / 9–10),
  avatar picker, languages (English / Urdu, one primary), preferred character.
- **Child preferences** — session length (short / medium / long), storytelling on/off,
  role-play on/off, pronunciation practice on/off, correction style (none / gentle / active),
  and topics of interest.
- **Parental controls** — the densest screen in the app. Design it as grouped cards:
  - *Access*: a **Pause the app** switch, with the hint that the child sees a friendly "let's
    play later" and is never told they were blocked.
  - *Time*: minutes a day (0–240), minutes in one sitting (0–120, and it cannot exceed the daily
    limit), quiet hours from/until (may cross midnight), and allowed days of the week.
  - *Content*: safety filter **Standard / Strict** (with the note that safety runs either way
    and cannot be turned off), topics to steer away from (free text, one per line), and a
    language lock (Either / English only / Urdu only).
  - *Characters*: tick none to allow every character, tick some to allow only those.
  - *Retention*: days to keep transcripts (0–365), plus a read-back of what is **actually**
    applied — the operator ceiling may be shorter than what was asked for — and counts of held
    and deleted messages. Include the banner that voice recordings are deleted within hours
    regardless of this setting.
  - Design the inline error states: "choose at least one day", "set both quiet-hours times or
    neither", "per-session cannot exceed daily", "we could not save your changes".
  - Header note: *"These are enforced on our servers. The app on your child's device cannot be
    persuaded to ignore them."*
- **Conversations** — a list of a child's chats (date, duration, status) and a **transcript
  reader** for any one of them.
- **Speech practice (parent view)** — recent sessions, rewards earned, sounds practised, and a
  recognition-over-time chart.
- **Progress (parent view)** — 90 days: minutes chatting, new words per day, practice
  recognition per day, recent new words, and a "what these numbers mean" explainer.
- **Subscription** — the current plan, what it allows, all plans, and an "if a payment fails"
  explainer. Plans: **Free** (10 min/day, 1 child, 3 stories a week, limited characters, 7-day
  transcript history) · **Family Monthly** (PKR 499/month, 60 min/day, 4 children, unlimited
  stories, all characters, 90-day history) · **Family Annual** (PKR 4,990/year). Design the
  **payment rail picker for Pakistan first**: JazzCash, Easypaisa, card (Stripe), Apple IAP,
  Google Play. Plus **payment failed**, **cancel**, **resume**, and **restore purchases**.
- **Notifications** — per child, four switches: on a safety flag, daily summary, weekly summary,
  time limit reached.
- **Account** — your details, change password, **where you are signed in** (a device and session
  list with "sign out everywhere"), and **your data** (export, delete account).
- **Privacy centre** — what is stored about a child, voice recordings, what is sent to the AI
  provider, what the product does *not* do, what it cannot promise, and how to get data deleted.
  In plain language a non-technical parent actually reads — legalese is a dark pattern here.
- **Consent management** — view granted consents and their history, withdraw a consent, and opt
  in or out of the **optional** consents (transcript retention, product analytics), which are
  off by default and must never be bundled with the required ones.
- **Password reset** — request, "check your email", and set-a-new-password.
- **Email verification** — pending, and confirmed.
- **Support / help** — including "send a diagnostic report", the one place a request ID may
  surface: to a parent, never to a child.
- **App update required** and **maintenance** screens.

---

## 8. States every screen needs

For each screen, design: **default · loading · empty · error · offline · saved/success ·
disabled**. In child mode, loading is always the character thinking and an error is always the
warm sentence — never a spinner alone, and never an error string.

---

## 9. Accessibility

- Contrast ≥ 4.5:1 for text; ≥ 3:1 for interactive boundaries.
- Every child-mode control ≥ 72 pt; every parent-mode control ≥ 44 pt.
- Colour is never the only differentiator — always paired with a face or icon and a label.
- Reduce Motion: design the still equivalent of the breathing talk button, the bobbing avatar,
  and the idle character loop.
- Support text scaling to 200% without clipping; show the reflow for the densest screens.
- Urdu **RTL mirrors** for at least: Welcome, Home, Conversation, Consent, Parental controls.

---

## 10. Deliverables

1. A **design-system artboard**: both palettes, both type ramps, spacing, radii, elevation, and
   every component in every state — big button, talk button (6 states), character avatar (6
   sizes), speech bubble, prompt pill, card, badge (earned + locked), progress bar, offline
   banner, thinking state, friendly error, parent field, parent segmented control, parent card,
   primary button, link button, error text, switch, chart.
2. The **four characters**: circular flat avatars, a hero key frame of each 3D diorama, and the
   five mood key frames for at least Buddy.
3. **Every child-mode screen** from §5 and §7, laid out as one flow.
4. **Every parent-mode screen** from §5 and §7, laid out as a second, visually distinct flow.
5. The **conversation screen** at the highest fidelity in the set — it is the product.
6. Android 360 × 800 variants and Urdu RTL variants wherever the layout changes.

---

## 11. Do not design

- Any child-facing pricing, plan, advertisement or upsell surface.
- Any streak, leaderboard, countdown, daily-reward or "come back" mechanic.
- Any child-to-child, messaging, sharing or social surface — the product has none, anywhere, by
  design.
- Any child-facing error text, status code or request ID.
- A dark theme. The app is light-appearance only.
