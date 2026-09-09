import { fixedClock } from '@kids/shared';
import { describe, expect, it } from 'vitest';

import { silentWav } from './mock-providers.js';
import { DEFAULT_RETENTION_POLICY, isReadable, resolveRetention } from './retention.js';
import { createMemoryAudioStorage, newAudioKey } from './storage.js';

/**
 * Retention and expiry.
 *
 * The subject here is the one decision in the product with no acceptable
 * failure direction: a child's voice surviving longer than it should
 * (docs/adr/0006). Every gate is asserted independently, and then asserted again
 * in combination, because "we thought the other check would catch it" is exactly
 * how a corpus of children's voices accumulates.
 */

const CLOCK = fixedClock(Date.parse('2026-08-18T10:00:00.000Z'));

describe('resolveRetention', () => {
  it('discards a child upload under the default policy', () => {
    const result = resolveRetention({
      policy: DEFAULT_RETENTION_POLICY,
      kind: 'child_upload',
      parentOptedIn: true,
      clock: CLOCK,
    });

    // Zero days is the default in EVERY environment. Even with consent, the
    // configuration has to permit it.
    expect(result.decision).toBe('transient');
    expect(result.basis).toBe('policy_zero');
  });

  it('discards a child upload when configuration allows but consent is absent', () => {
    const result = resolveRetention({
      policy: { rawAudioDays: 30, transientSeconds: 300 },
      kind: 'child_upload',
      parentOptedIn: false,
      clock: CLOCK,
    });

    expect(result.decision).toBe('transient');
    expect(result.basis).toBe('no_consent');
  });

  it('retains only when both gates open', () => {
    const result = resolveRetention({
      policy: { rawAudioDays: 30, transientSeconds: 300 },
      kind: 'child_upload',
      parentOptedIn: true,
      clock: CLOCK,
    });

    expect(result.decision).toBe('retained');
    expect(result.basis).toBe('parent_opt_in');
    expect(result.expiresAt.getTime()).toBe(CLOCK.now() + 30 * 86_400_000);
  });

  it('never retains a synthesised reply, whatever the configuration', () => {
    for (const days of [0, 1, 30, 3_650]) {
      const result = resolveRetention({
        policy: { rawAudioDays: days, transientSeconds: 300 },
        kind: 'companion_reply',
        parentOptedIn: true,
        clock: CLOCK,
      });

      // There is no configuration that makes a reply persist, because there is
      // no reason for one to.
      expect(result.decision, `rawAudioDays=${String(days)}`).toBe('transient');
      expect(result.basis).toBe('synthesis');
    }
  });

  it('gives every transient artefact an expiry inside the window', () => {
    const result = resolveRetention({
      policy: { rawAudioDays: 0, transientSeconds: 120 },
      kind: 'child_upload',
      parentOptedIn: false,
      clock: CLOCK,
    });

    expect(result.expiresAt.getTime()).toBe(CLOCK.now() + 120_000);
  });
});

describe('isReadable', () => {
  it('is false the instant the expiry passes', () => {
    const at = new Date(CLOCK.now());
    expect(isReadable(at, CLOCK)).toBe(false);
    expect(isReadable(new Date(CLOCK.now() + 1), CLOCK)).toBe(true);
  });
});

describe('transient storage', () => {
  it('serves an object before expiry and refuses it after', async () => {
    let nowMs = Date.parse('2026-08-18T10:00:00.000Z');
    const clock = { now: () => nowMs, nowIso: () => new Date(nowMs).toISOString() as never };
    const storage = createMemoryAudioStorage({ clock });

    const stored = await storage.put({
      kind: 'companion_reply',
      bytes: silentWav(500),
      mimeType: 'audio/wav',
      expiresAt: new Date(nowMs + 60_000),
    });

    expect(await storage.get(stored.key)).toBeTruthy();

    nowMs += 61_000;

    // Enforced on READ, not only by the sweep. A sweep that has not run yet must
    // never be the reason a child's audio is still served.
    expect(await storage.get(stored.key)).toBeUndefined();
  });

  it('cannot distinguish expired from absent', async () => {
    const storage = createMemoryAudioStorage({ clock: CLOCK });

    const stored = await storage.put({
      kind: 'companion_reply',
      bytes: silentWav(500),
      mimeType: 'audio/wav',
      expiresAt: new Date(CLOCK.now() - 1),
    });

    // Both are `undefined`, deliberately: telling a caller that a key once
    // existed is telling them something about a child.
    expect(await storage.get(stored.key)).toBeUndefined();
    expect(await storage.get(newAudioKey())).toBeUndefined();
  });

  it('sweeps expired objects and leaves live ones', async () => {
    const storage = createMemoryAudioStorage({ clock: CLOCK });

    const live = await storage.put({
      kind: 'companion_reply',
      bytes: silentWav(300),
      mimeType: 'audio/wav',
      expiresAt: new Date(CLOCK.now() + 60_000),
    });
    await storage.put({
      kind: 'child_upload',
      bytes: silentWav(300),
      mimeType: 'audio/wav',
      expiresAt: new Date(CLOCK.now() - 1),
    });

    expect(await storage.sweep()).toBe(1);
    expect(await storage.get(live.key)).toBeTruthy();
    expect(await storage.sweep()).toBe(0);
  });

  it('deletes on request', async () => {
    const storage = createMemoryAudioStorage({ clock: CLOCK });
    const stored = await storage.put({
      kind: 'child_upload',
      bytes: silentWav(300),
      mimeType: 'audio/wav',
      expiresAt: new Date(CLOCK.now() + 60_000),
    });

    await storage.delete(stored.key);
    expect(await storage.get(stored.key)).toBeUndefined();
  });

  it('copies the caller’s buffer rather than holding a view into it', async () => {
    const storage = createMemoryAudioStorage({ clock: CLOCK });
    const source = silentWav(300);

    const stored = await storage.put({
      kind: 'companion_reply',
      bytes: source,
      mimeType: 'audio/wav',
      expiresAt: new Date(CLOCK.now() + 60_000),
    });

    // A request body gets reused or freed. Storage holding a view into it is a
    // bug that presents as one child hearing another child's audio.
    source.fill(0xff);

    const read = await storage.get(stored.key);
    expect(read?.bytes[0]).toBe(0x52); // 'R' of RIFF
  });

  it('produces unguessable keys', () => {
    const keys = new Set(Array.from({ length: 200 }, newAudioKey));

    expect(keys.size).toBe(200);
    // 192 bits of CSPRNG output. The key is the only thing between a URL and a
    // recording of a child, and every read is authorised as well — defence in
    // depth assumes the other control has already failed.
    for (const key of keys) expect(key.length).toBeGreaterThanOrEqual(32);
  });

  it('evicts rather than growing without bound', async () => {
    const storage = createMemoryAudioStorage({ clock: CLOCK, maxBytes: 8_000 });

    const keys: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      const stored = await storage.put({
        kind: 'companion_reply',
        bytes: silentWav(100),
        mimeType: 'audio/wav',
        expiresAt: new Date(CLOCK.now() + (i + 1) * 60_000),
      });
      keys.push(stored.key);
    }

    // Transient storage with no ceiling is a memory leak with a retention
    // policy. The earliest-expiring go first, which is the sweep's own order.
    const survivors = await Promise.all(keys.map(async (k) => await storage.get(k)));
    expect(survivors.filter(Boolean).length).toBeLessThan(12);
    expect(await storage.get(keys.at(-1)!)).toBeTruthy();
  });
});
