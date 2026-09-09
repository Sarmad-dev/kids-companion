import type { FriendlyFailure } from '../api/errors';

/**
 * The session.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE CHILD APP NEVER HOLDS A CREDENTIAL OF ITS OWN.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * There is no child login (that decision predates this app: children are
 * profiles owned by a parent, not accounts). What the app holds is the PARENT's
 * access token, obtained by a grown-up on the handoff screen and kept in the
 * platform keystore — Keychain on iOS, Keystore on Android — rather than in
 * AsyncStorage, which is a plaintext file any backup or rooted device can read.
 *
 * No API key, no database credential, and no admin capability is present in this
 * binary at all. A mobile app is a file an attacker can decompile at leisure, so
 * anything embedded in it is public.
 */

export interface SecureStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

const ACCESS_TOKEN = 'kc.access_token';
/**
 * The refresh token, kept beside the access token in the SAME keystore.
 *
 * It was previously discarded at sign-in, which made the 15-minute access
 * token the whole session: everything a parent had done stopped working a
 * quarter of an hour later, with no signal except requests beginning to fail.
 * A refresh token is longer-lived and therefore worth more to an attacker, so
 * it goes to the platform keystore and nowhere else — never AsyncStorage.
 */
const REFRESH_TOKEN = 'kc.refresh_token';

export interface Session {
  readonly signedIn: boolean;
  readonly failure?: FriendlyFailure;
}

export const createSessionStore = (store: SecureStore) => {
  // Cached in memory so the hot path does not hit the keystore on every request,
  // and cleared on sign-out so a switched-away token cannot be reused.
  let cached: string | undefined;

  return {
    token: async (): Promise<string | undefined> => {
      if (cached !== undefined) return cached;
      cached = await store.get(ACCESS_TOKEN);
      return cached;
    },

    refreshToken: async (): Promise<string | undefined> => await store.get(REFRESH_TOKEN),

    /**
     * Stores a session. Also the way a ROTATED pair is written back, which is
     * why the refresh token is overwritten rather than kept: the server
     * invalidates the old one, and presenting it again revokes the family.
     */
    signIn: async (accessToken: string, refreshToken?: string): Promise<void> => {
      cached = accessToken;
      await store.set(ACCESS_TOKEN, accessToken);
      if (refreshToken !== undefined) await store.set(REFRESH_TOKEN, refreshToken);
    },

    signOut: async (): Promise<void> => {
      cached = undefined;
      await store.remove(ACCESS_TOKEN);
      await store.remove(REFRESH_TOKEN);
    },

    isSignedIn: async (): Promise<boolean> => (await store.get(ACCESS_TOKEN)) !== undefined,
  };
};

export type SessionStore = ReturnType<typeof createSessionStore>;

/** An in-memory store, for tests. Never used on a device. */
export const createMemoryStore = (): SecureStore => {
  const map = new Map<string, string>();
  return {
    get: async (key) => await Promise.resolve(map.get(key)),
    set: async (key, value) => {
      map.set(key, value);
      await Promise.resolve();
    },
    remove: async (key) => {
      map.delete(key);
      await Promise.resolve();
    },
  };
};
