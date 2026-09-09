import { createHash } from 'node:crypto';

/**
 * The text-to-speech cache, shared by every TTS adapter.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS IS NOT INSIDE ONE VENDOR'S FILE ANY MORE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Cost is per character and children repeat themselves — "tell me a story"
 * produces the same opening line hundreds of times a day. That makes this the
 * single largest cost lever in the product, and it is a property of TTS rather
 * than of any one vendor: the second an operator can pick a different one, a
 * cache living in the first vendor's file means switching silently turns the
 * lever off and multiplies the bill.
 *
 * The key still carries the model and voice, so two vendors sharing a cache
 * cannot serve each other's audio.
 */

export interface TtsCache {
  get(
    key: string,
  ): Promise<{ audio: Uint8Array; mimeType: string; durationMs: number } | undefined>;
  set(
    key: string,
    value: { audio: Uint8Array; mimeType: string; durationMs: number },
  ): Promise<void>;
}

/**
 * The separator between key fields.
 *
 * NUL, not a space, and this is load-bearing rather than stylistic: a separator
 * that can occur INSIDE a field lets two different inputs hash to one key. With
 * a space, a voice literally named `x` speaking `y z` collides with a voice
 * named `x y` speaking `z`. NUL cannot appear in any of these fields, so the
 * concatenation is unambiguous. Carried over verbatim from the original key.
 */
const SEP = '\0';

/**
 * The cache key.
 *
 * Everything that changes the audio goes in: vendor, text, voice, model, and
 * format. A key missing the voice id serves one character's line in another's
 * voice, which is the kind of bug a child notices immediately and an adult never
 * reproduces. `provider` joined that list when a second TTS vendor did — without
 * it, two vendors whose voice ids happen to collide would serve each other's
 * audio out of a shared cache.
 *
 * The text is hashed rather than stored. A cache key is a place data gets
 * inspected, and the companion's line is still part of a child's conversation.
 */
export const ttsCacheKey = (parts: {
  text: string;
  voiceId: string;
  model: string;
  format: string;
  /**
   * Omitted keeps the original single-vendor key shape byte for byte, so an
   * existing cache is not invalidated by this field merely existing.
   */
  provider?: string;
}): string =>
  createHash('sha256')
    .update(
      [
        ...(parts.provider === undefined ? [] : [parts.provider]),
        parts.model,
        parts.voiceId,
        parts.format,
        parts.text,
      ].join(SEP),
    )
    .digest('base64url');

/**
 * An in-memory TTS cache.
 *
 * Bounded and LRU-ish by insertion order, because an unbounded cache of every
 * line the companion has ever spoken is a memory leak that grows with usage. The
 * Redis-backed one lands with the cache work; the interface is what matters.
 */
export const createMemoryTtsCache = (maxEntries = 500): TtsCache => {
  const entries = new Map<string, { audio: Uint8Array; mimeType: string; durationMs: number }>();

  return {
    get: async (key) => {
      const hit = entries.get(key);
      if (hit) {
        // Re-insert so recently used keys survive eviction.
        entries.delete(key);
        entries.set(key, hit);
      }
      return await Promise.resolve(hit);
    },
    set: async (key, value) => {
      if (entries.size >= maxEntries) {
        const oldest = entries.keys().next();
        if (!oldest.done) entries.delete(oldest.value);
      }
      entries.set(key, value);
      await Promise.resolve();
    },
  };
};
