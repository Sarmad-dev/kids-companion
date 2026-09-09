# apps/mobile

**Not yet implemented. Phase 4 (child mode) and Phase 5 (parent mode).**

The React Native app. Two modes in one binary, separated by the parent gate.

## Child mode

The product. Character, tap-to-talk, playback, session limits.

**Design constraints that are not negotiable:**

- **Pre-readers.** Meaning is carried by character animation, colour, and voice. Text is never the only channel, and a child never sees an error message ([ERROR_HANDLING.md §10](../../docs/ERROR_HANDLING.md)).
- **Latency cover.** The character acknowledges immediately — a nod, a "hmm!", an ear-twitch — the moment upload begins. These fillers ship in the bundle and never round-trip; without them, even 1.8 s of silence reads as broken to a 4-year-old.
- **No dark patterns.** No streaks, no loss framing, no engagement-maximising notifications ([CHILD_SAFETY.md](../../docs/CHILD_SAFETY.md) rule S-9). Session limits exist to _end_ sessions.
- **Low-end Android is the target device**, on intermittent mobile data. Profile on real hardware from the start, not on a simulator at the end.

## Parent mode

Reached only through the parent gate. Profiles, controls, history, safety flags, progress, billing, export and deletion.

## Notes

- Tokens live in the OS keystore (iOS Keychain / Android Keystore), never `AsyncStorage`.
- Certificate pinning on the API origin.
- Child sessions are device-bound and 60 minutes ([ADR-0005](../../docs/adr/0005-auth-and-session-model.md)).
- pnpm's isolated linking may conflict with Metro — [Q-05](../../docs/OPEN_QUESTIONS.md). If so, `node-linker=hoisted` goes in `apps/mobile/.npmrc` only.
