import { randomBytes } from 'node:crypto';

import type { Clock } from '@kids/shared';

import type { AudioStorage, PutAudioRequest, StoredAudio } from './ports.js';
import { isReadable } from './retention.js';

/**
 * Transient audio storage.
 *
 * The in-memory implementation is the default in `local` and `ci`, and it is a
 * real implementation rather than a stub: it enforces expiry on read, deletes on
 * sweep, and bounds its own size. A test that proves expired audio is
 * unreachable should not need a bucket.
 *
 * The object-store adapter lands with the Supabase Storage work. What matters
 * for either is stated on the port: THE CLIENT NEVER TALKS TO STORAGE DIRECTLY.
 * No presigned upload URL, no bucket credential on a device. A credential scoped
 * to a bucket of children's voices, shipped inside a mobile app, is a credential
 * in a decompiled APK — and there is no key rotation that un-leaks a child's
 * voice (docs/adr/0006).
 */

/**
 * An unguessable key.
 *
 * 192 bits from a CSPRNG, not a UUID and not a sequence. The key is the only
 * thing between a URL and a recording of a child, and the fact that every read
 * is also authorised does not make a guessable key acceptable — defence in
 * depth means the second control assumes the first has failed.
 */
export const newAudioKey = (): string => randomBytes(24).toString('base64url');

export interface MemoryAudioStorageOptions {
  readonly clock: Clock;
  /**
   * A ceiling on total bytes held.
   *
   * Transient storage with no ceiling is a memory leak with a retention policy.
   * When it is reached the oldest-expiring objects go first, which is the same
   * order the sweep would have taken them in.
   */
  readonly maxBytes?: number;
}

interface Entry {
  readonly meta: StoredAudio;
  readonly bytes: Uint8Array;
}

export const createMemoryAudioStorage = (options: MemoryAudioStorageOptions): AudioStorage => {
  const maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
  const entries = new Map<string, Entry>();
  let heldBytes = 0;

  const drop = (key: string): void => {
    const entry = entries.get(key);
    if (!entry) return;
    heldBytes -= entry.bytes.length;
    entries.delete(key);
  };

  const evictUntilRoom = (incoming: number): void => {
    if (heldBytes + incoming <= maxBytes) return;

    const byExpiry = [...entries.entries()].sort(
      (a, b) => a[1].meta.expiresAt.getTime() - b[1].meta.expiresAt.getTime(),
    );
    for (const [key] of byExpiry) {
      if (heldBytes + incoming <= maxBytes) break;
      drop(key);
    }
  };

  return {
    name: 'memory',

    put: async (request: PutAudioRequest): Promise<StoredAudio> => {
      evictUntilRoom(request.bytes.length);

      const meta: StoredAudio = {
        key: newAudioKey(),
        kind: request.kind,
        mimeType: request.mimeType,
        byteSize: request.bytes.length,
        ...(request.durationMs === undefined ? {} : { durationMs: request.durationMs }),
        expiresAt: request.expiresAt,
      };

      // Copied, not referenced. The caller's buffer is a request body that will
      // be reused or freed, and storage holding a view into it is a bug that
      // presents as one child hearing another child's audio.
      entries.set(meta.key, { meta, bytes: Uint8Array.from(request.bytes) });
      heldBytes += request.bytes.length;
      return await Promise.resolve(meta);
    },

    get: async (key: string) => {
      const entry = entries.get(key);
      if (!entry) return await Promise.resolve(undefined);

      // Expiry is enforced HERE, not only by the sweep. A sweep that has not run
      // yet must never be the reason a child's audio is still served.
      if (!isReadable(entry.meta.expiresAt, options.clock)) {
        drop(key);
        return await Promise.resolve(undefined);
      }

      return await Promise.resolve({ meta: entry.meta, bytes: entry.bytes });
    },

    delete: async (key: string): Promise<void> => {
      drop(key);
      await Promise.resolve();
    },

    sweep: async (): Promise<number> => {
      let removed = 0;
      for (const [key, entry] of [...entries.entries()]) {
        if (isReadable(entry.meta.expiresAt, options.clock)) continue;
        drop(key);
        removed += 1;
      }
      return await Promise.resolve(removed);
    },
  };
};
