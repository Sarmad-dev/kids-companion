import NetInfo from '@react-native-community/netinfo';
import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { createApiClient, type ApiClient, type AuthSession } from '../api/client';
import type { FriendlyFailure } from '../api/errors';
import { createExpoUploadTransport } from '../api/expo-upload';
import type { AudioPort } from '../hooks/audio-port';
import { createExpoAudioPort } from '../hooks/expo-audio-port';
import { createSessionStore, type SessionStore } from '../state/session';
import { DEFAULT_CHARACTER } from '../theme/child-theme';

/**
 * Everything a screen needs that is not its own.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS IS CONTEXT AND NOT PROP DRILLING
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The app used to be one component that switched on a route and passed a
 * `ScreenProps` bundle down to each screen. Under Expo Router a screen is a
 * FILE — the router constructs it, and there is no parent left holding those
 * props. The API client, the audio port and the current child now live here, so
 * `app/(child)/conversation.tsx` can be a route rather than a function someone
 * has to remember to pass eleven things to.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT IS NOT IN THIS BINARY, STILL
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * No API key, no database credential, no admin capability, no provider name.
 * The app holds exactly one secret — the parent's own session token — and it
 * lives in the platform keystore, not here. See `state/session.ts`.
 */

const DEV_API_PORT = 8080;

/**
 * The dev machine, learned from the Metro server that served this bundle.
 *
 * A hardcoded LAN address is wrong the first time the router hands out a
 * different lease, and the symptom is not a wrong host — it is every request
 * timing out, which the screens report as a sign-in failure. The host Metro was
 * reached on is by construction one this device can reach.
 */
const hostFromMetro = (): string | undefined => {
  const hostUri: unknown = Constants.expoConfig?.hostUri;
  if (typeof hostUri !== 'string') return undefined;
  const host = hostUri.split(':')[0];
  return host === undefined || host === '' ? undefined : `http://${host}:${String(DEV_API_PORT)}`;
};

const envBaseUrl: unknown = process.env.EXPO_PUBLIC_API_BASE_URL;
const overrideBaseUrl =
  typeof envBaseUrl === 'string' && envBaseUrl !== '' ? envBaseUrl : undefined;

export const API_BASE_URL: string = overrideBaseUrl ?? hostFromMetro() ?? 'http://localhost:8080';

/** Keychain on iOS, Keystore on Android — never AsyncStorage, which is a file. */
const keystore = {
  get: async (key: string) => (await SecureStore.getItemAsync(key)) ?? undefined,
  set: async (key: string, value: string) => {
    await SecureStore.setItemAsync(key, value);
  },
  remove: async (key: string) => {
    await SecureStore.deleteItemAsync(key);
  },
};

/** Which child is playing, and with whom. Cleared on "different player". */
export interface ChildSelection {
  readonly childId?: string;
  readonly childName?: string;
  readonly characterSlug?: string;
  /**
   * The character's database id, kept alongside the slug.
   *
   * The slug is what the app draws with; the id is what
   * `POST /api/conversations/start` needs in order to honour the choice. Without
   * it the server picks a default and a child who chose Lily gets whoever the
   * catalogue lists first — the choice screen becomes decorative.
   */
  readonly characterId?: string;
}

export interface AppState {
  readonly api: ApiClient;
  readonly audio: AudioPort;
  readonly session: SessionStore;
  readonly online: boolean;
  /** `undefined` until the launch check has answered. */
  readonly signedIn: boolean | undefined;
  readonly child: ChildSelection;
  readonly setChild: (patch: ChildSelection) => void;
  readonly clearChild: () => void;
  readonly signIn: (auth: AuthSession) => Promise<void>;
  readonly signOut: () => Promise<void>;
  /**
   * Whether the arithmetic gate has been answered in this app session.
   *
   * Deliberately NOT persisted. The gate exists to stop a child wandering into
   * the parent area, and a child who picks the phone up an hour later is the
   * exact case it is for — so it resets when the app does.
   */
  readonly gatePassed: boolean;
  readonly passGate: () => void;
  /** The last failure the API reported, for the parent's support screen only. */
  readonly lastFailure: FriendlyFailure | undefined;
}

const AppContext = createContext<AppState | undefined>(undefined);

export const AppProvider = ({ children }: { children: ReactNode }) => {
  // Optimistic: a device that has not reported yet is assumed online, because
  // showing "no internet" to a child whose connection is fine is worse than a
  // request that fails and retries.
  const [online, setOnline] = useState(true);
  const [signedIn, setSignedIn] = useState<boolean | undefined>(undefined);
  const [child, setChildState] = useState<ChildSelection>({});
  const [gatePassed, setGatePassed] = useState(false);
  const [lastFailure, setLastFailure] = useState<FriendlyFailure | undefined>(undefined);

  useEffect(
    () =>
      NetInfo.addEventListener((state) => {
        setOnline(state.isConnected !== false);
      }),
    [],
  );

  const session = useMemo(() => createSessionStore(keystore), []);
  const audio = useMemo((): AudioPort => createExpoAudioPort(), []);

  // A device that still holds a valid parent session skips straight past
  // sign-in. Checked once, at launch, rather than assumed: `signedIn` otherwise
  // starts undefined and every parent-gated route would bounce to sign-in even
  // when the keystore already has a token.
  useEffect(() => {
    void session.isSignedIn().then(setSignedIn);
  }, [session]);

  const api = useMemo(
    () =>
      createApiClient({
        baseUrl: API_BASE_URL,
        getToken: session.token,
        // The bytes move natively; see src/api/expo-upload.ts for why not fetch.
        uploadTransport: createExpoUploadTransport(),
        isOnline: () => online,
        // A failure's request id goes to the support log a PARENT can send, and
        // never to a screen a child can see. See src/api/errors.ts.
        onFailure: (failure) => {
          setLastFailure(failure);
        },

        // Renewing the session without anyone noticing is the whole point: a
        // child mid-conversation must not meet a sign-in screen because a
        // fifteen-minute timer elapsed.
        getRefreshToken: session.refreshToken,
        onRefreshed: async (renewed) => {
          await session.signIn(renewed.accessToken, renewed.refreshToken);
        },
        onSignedOut: () => {
          // The refresh token is spent or revoked. Clear the keystore so a
          // relaunch does not assume a session that no longer exists.
          void session.signOut();
          setSignedIn(false);
          setGatePassed(false);
        },
      }),
    [session, online],
  );

  const setChild = useCallback((patch: ChildSelection) => {
    setChildState((current) => ({ ...current, ...patch }));
  }, []);

  const clearChild = useCallback(() => {
    setChildState({});
  }, []);

  const signIn = useCallback(
    async (auth: AuthSession) => {
      // BOTH tokens. The access token lasts fifteen minutes, so keeping only
      // that one made every session expire mid-use.
      await session.signIn(auth.accessToken, auth.refreshToken);
      setSignedIn(true);
    },
    [session],
  );

  const signOut = useCallback(async () => {
    await session.signOut();
    setSignedIn(false);
    setGatePassed(false);
    setChildState({});
  }, [session]);

  const passGate = useCallback(() => {
    setGatePassed(true);
  }, []);

  const value = useMemo(
    (): AppState => ({
      api,
      audio,
      session,
      online,
      signedIn,
      child,
      setChild,
      clearChild,
      signIn,
      signOut,
      gatePassed,
      passGate,
      lastFailure,
    }),
    [
      api,
      audio,
      session,
      online,
      signedIn,
      child,
      setChild,
      clearChild,
      signIn,
      signOut,
      gatePassed,
      passGate,
      lastFailure,
    ],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
};

export const useApp = (): AppState => {
  const value = useContext(AppContext);
  if (value === undefined) {
    throw new Error('useApp must be used inside <AppProvider>');
  }
  return value;
};

export const useApi = (): ApiClient => useApp().api;
export const useOnline = (): boolean => useApp().online;

/**
 * The character currently in play.
 *
 * Falls back to Buddy rather than to `undefined`, because every child screen
 * draws a character and none of them has a sensible empty state — a screen with
 * no friend on it is not a screen this product has.
 */
export const useCharacter = (): string => useApp().child.characterSlug ?? DEFAULT_CHARACTER;
