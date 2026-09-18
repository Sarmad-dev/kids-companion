import { toFriendlyFailure, type FriendlyFailure } from './errors';

/**
 * The API client.
 *
 * WHAT IS NOT IN THIS FILE, DELIBERATELY: no API key, no database credential, no
 * provider name, no admin endpoint. The app talks to our API and nothing else,
 * and the only secret it ever holds is the parent's own session token — which is
 * theirs, is short-lived, and is kept in the platform keystore rather than in
 * JavaScript memory or AsyncStorage.
 *
 * A mobile binary is a file an attacker can decompile at their leisure. Anything
 * embedded in it is public, so nothing is embedded in it.
 */

export interface ApiResult<T> {
  readonly ok: boolean;
  readonly data?: T;
  readonly failure?: FriendlyFailure;
}

export interface ApiClientOptions {
  readonly baseUrl: string;
  /** Returns the current access token, or undefined when signed out. */
  readonly getToken: () => Promise<string | undefined>;
  /** Whether the device believes it has a connection. Checked BEFORE a request. */
  readonly isOnline: () => boolean;
  readonly fetchImpl?: typeof fetch;
  /** Injected so the timeout is testable without waiting. */
  readonly timeoutMs?: number;
  /** Called with the request id of every failure, for the support log. */
  readonly onFailure?: (failure: FriendlyFailure, route: string) => void;
  /** Returns the stored refresh token. Absent means "cannot refresh". */
  readonly getRefreshToken?: () => Promise<string | undefined>;
  /** Stores a rotated pair. Must persist BOTH tokens. */
  readonly onRefreshed?: (session: AuthSession) => Promise<void>;
  /** The refresh token is gone or rejected: only a grown-up signing in fixes this. */
  readonly onSignedOut?: () => void;
  /** Performs a multipart file upload. Injected, because it is platform code. */
  readonly uploadTransport?: UploadTransport;
}

/** A local recording, and the multipart shape the server expects around it. */
export interface FileUpload {
  /** A `file://` uri on this device. */
  readonly uri: string;
  /** The multipart field the file goes in. `audio`, for a voice turn. */
  readonly fieldName: string;
  readonly mimeType: string;
  /** Ordinary form fields sent alongside it. */
  readonly fields: Readonly<Record<string, string>>;
}

/**
 * Uploading a file off the device.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS IS INJECTED RATHER THAN `fetch` WITH A `FormData`
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The obvious implementation — append `{uri, name, type}` to a FormData and
 * hand it to `fetch` — is React Native's documented idiom and it does not work
 * in every runtime this app has to run in. In Expo Go it fails inside the
 * native networking module with "Unsupported FormDataPart implementation",
 * having been given a part that is provably well formed: the JS class really is
 * React Native's FormData, and `getParts()` really does return a part carrying
 * the uri. There is nothing to fix on this side of the boundary.
 *
 * So the bytes are moved by whatever the platform is willing to move them with,
 * behind this interface, and everything that is NOT platform-specific — the
 * base url, the token, renewing an expired one, turning a status code into
 * something a child can hear — stays in the client where it is testable.
 */
export type UploadTransport = (
  url: string,
  headers: Readonly<Record<string, string>>,
  file: FileUpload,
) => Promise<{ status: number; body: string }>;

const ok = <T>(data: T): ApiResult<T> => ({ ok: true, data });
const fail = <T>(failure: FriendlyFailure): ApiResult<T> => ({ ok: false, failure });

export const createApiClient = (options: ApiClientOptions) => {
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;

  /**
   * A refresh in flight, shared by everyone who needs one.
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * WHY THIS IS SINGLE-FLIGHT AND NOT ONE REFRESH PER CALLER
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * AUTH_REFRESH_TOKEN_ROTATION is on, and presenting a rotated token a second
   * time revokes the entire family — that is the point of rotation, and it is
   * how a stolen token gets caught. A screen that fires three requests at once
   * would meet three 401s at once; three independent refreshes would spend the
   * same token three times and revoke the session they were trying to save.
   * Sharing one promise means the token is spent exactly once.
   */
  let refreshing: Promise<boolean> | undefined;

  const refreshSession = async (hadAccessToken: boolean): Promise<boolean> => {
    refreshing ??= (async (): Promise<boolean> => {
      try {
        const refreshToken = await options.getRefreshToken?.();
        if (refreshToken === undefined) {
          // An access token with no refresh token beside it is a session that
          // cannot be renewed and cannot be used — a session stored before
          // refresh tokens were kept, or a keystore that lost one. Left alone
          // the app stays "signed in" while every request fails, with nothing
          // on screen offering a way out. Clearing it puts a parent in front of
          // the sign-in form, which is the only thing that fixes it.
          //
          // A 401 with NO access token at all is just an unauthenticated
          // request, and must not throw anyone out of anything.
          if (hadAccessToken) options.onSignedOut?.();
          return false;
        }

        const response = await doFetch(`${options.baseUrl}/v1/auth/refresh`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ refreshToken }),
        });

        if (!response.ok) {
          // The refresh token itself is expired, revoked, or already spent.
          // Nothing this client can do; a parent has to sign in again.
          options.onSignedOut?.();
          return false;
        }

        const parsed = safeJson(await response.text()) as Partial<AuthSession> | undefined;
        if (typeof parsed?.accessToken !== 'string' || typeof parsed.refreshToken !== 'string') {
          options.onSignedOut?.();
          return false;
        }

        await options.onRefreshed?.(parsed as AuthSession);
        return true;
      } catch {
        // A transport failure is not a revoked session. Say nothing, change
        // nothing, and let the caller report it as the network problem it is.
        return false;
      } finally {
        refreshing = undefined;
      }
    })();

    return await refreshing;
  };

  const request = async <T>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    route: string,
    init: { json?: unknown; body?: BodyInit; headers?: Record<string, string> } = {},
    isRetry = false,
  ): Promise<ApiResult<T>> => {
    // Checked BEFORE the request, so a child on a train gets the friendly line
    // immediately rather than after a fifteen-second timeout.
    if (!options.isOnline()) {
      const failure = toFriendlyFailure({ offline: true });
      options.onFailure?.(failure, route);
      return fail<T>(failure);
    }

    const token = await options.getToken();
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    try {
      const response = await doFetch(`${options.baseUrl}${route}`, {
        method,
        headers: {
          ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
          ...(init.json === undefined ? {} : { 'content-type': 'application/json' }),
          ...init.headers,
        },
        ...(init.json === undefined ? {} : { body: JSON.stringify(init.json) }),
        ...(init.body === undefined ? {} : { body: init.body }),
        signal: controller.signal,
      });

      const text = await response.text();
      const parsed: unknown = text === '' ? {} : safeJson(text);

      if (response.status === 401 && !isRetry) {
        const refreshed = await refreshSession(token !== undefined);
        // A multipart body is a stream fetch has already consumed, so it cannot
        // be replayed here. The refresh still happened, so the NEXT attempt
        // carries a valid token — the cost is one retry the child has to make,
        // not a session that stays broken.
        if (refreshed && init.body === undefined) {
          return await request<T>(method, route, init, true);
        }
      }

      if (!response.ok) {
        const failure = toFriendlyFailure({ status: response.status, body: parsed });
        options.onFailure?.(failure, route);
        return fail<T>(failure);
      }

      return ok(parsed as T);
    } catch (cause) {
      // An abort is our timeout; anything else is a transport problem, which on
      // a phone is almost always the network rather than the server.
      const timedOut = controller.signal.aborted;
      const failure = toFriendlyFailure({ timedOut, offline: !timedOut, cause });
      options.onFailure?.(failure, route);
      return fail<T>(failure);
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    get: async <T>(route: string) => await request<T>('GET', route),
    post: async <T>(route: string, json?: unknown) => await request<T>('POST', route, { json }),
    put: async <T>(route: string, json?: unknown) => await request<T>('PUT', route, { json }),
    /** Partial update. The parent surface's edit forms; never used by a child screen. */
    patch: async <T>(route: string, json?: unknown) => await request<T>('PATCH', route, { json }),
    /**
     * Deletion.
     *
     * Takes a body, unusually for a DELETE, because both things this app deletes
     * re-authenticate: `/v1/parents/me` wants the password again, and a request
     * carrying that in the query string would put it in every access log between
     * here and the database.
     */
    delete: async <T>(route: string, json?: unknown) => await request<T>('DELETE', route, { json }),
    /**
     * Multipart, for a voice turn or a practice attempt.
     *
     * Retried after a renewal, unlike the FormData version it replaces: the
     * transport reads the file from disk each time, so there is no consumed
     * stream to worry about and a child does not lose a turn to a timer.
     */
    uploadFile: async <T>(route: string, file: FileUpload): Promise<ApiResult<T>> => {
      const send = async (isRetry: boolean): Promise<ApiResult<T>> => {
        if (!options.isOnline()) {
          const failure = toFriendlyFailure({ offline: true });
          options.onFailure?.(failure, route);
          return fail<T>(failure);
        }

        const transport = options.uploadTransport;
        if (transport === undefined) {
          const failure = toFriendlyFailure({});
          options.onFailure?.(failure, route);
          return fail<T>(failure);
        }

        const token = await options.getToken();

        try {
          const { status, body } = await transport(
            `${options.baseUrl}${route}`,
            token === undefined ? {} : { authorization: `Bearer ${token}` },
            file,
          );
          const parsed: unknown = body === '' ? {} : safeJson(body);

          if (status === 401 && !isRetry) {
            if (await refreshSession(token !== undefined)) return await send(true);
          }

          if (status >= 400) {
            const failure = toFriendlyFailure({ status, body: parsed });
            options.onFailure?.(failure, route);
            return fail<T>(failure);
          }

          return ok(parsed as T);
        } catch (cause) {
          const failure = toFriendlyFailure({ offline: true, cause });
          options.onFailure?.(failure, route);
          return fail<T>(failure);
        }
      };

      return await send(false);
    },

    /**
     * An absolute, authorised source for media the audio player fetches itself.
     *
     * ═══════════════════════════════════════════════════════════════════════
     * WHY THIS EXISTS RATHER THAN THE SCREEN BUILDING A URL
     * ═══════════════════════════════════════════════════════════════════════
     *
     * The player does its own network request, outside `request()` above, so it
     * gets none of what that function adds. It was being handed a bare
     * `/api/voice/audio/<key>` and nothing else, which fails twice over:
     *
     *   NO ORIGIN    a relative path has nothing to resolve against on a native
     *                platform — there is no page the app was served from.
     *   NO TOKEN     that endpoint is authenticated and scoped to the child's
     *                own conversations, so it answers 401 without one.
     *
     * The effect was that the character's SPOKEN reply never played. For a
     * voice-first product whose users are too young to read the transcript, that
     * is the whole interaction.
     *
     * Returning both parts together keeps the token inside this client, which is
     * the rule this file opens with: the screen never handles it.
     */
    mediaSource: async (
      route: string,
    ): Promise<{ uri: string; headers: Record<string, string> }> => {
      const token = await options.getToken();
      return {
        uri: `${options.baseUrl}${route}`,
        headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
      };
    },
  };
};

export type ApiClient = ReturnType<typeof createApiClient>;

const safeJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    // A body we cannot parse is not a body worth surfacing. The caller will map
    // this to a friendly failure like any other.
    return {};
  }
};

/* -------------------------------------------------------------------------- */
/* The shapes this app actually uses                                           */
/* -------------------------------------------------------------------------- */
/* Only what a CHILD's screens need. No usage figures, no cost, no safety       */
/* internals, no plan details — all of that is the parent app's business.      */

export interface ChildSummary {
  readonly id: string;
  readonly displayName: string;
  readonly avatarKey?: string;
}

/** The response from `/v1/auth/login` and `/v1/auth/register` + login. */
export interface AuthSession {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresIn: number;
  readonly tokenType: 'Bearer';
}

/** One row of `GET /v1/consent/requirements`. */
export interface ConsentRequirement {
  readonly consentType: string;
  readonly scope: 'account' | 'child';
  readonly minPolicyVersion: string;
  /** Whether refusing this one stops conversation. The screen asks only for those. */
  readonly blocksConversation: boolean;
  /** Why this is being asked. A required column server-side, so always present. */
  readonly rationale: string;
}

/** The response from `GET /v1/children/:childId/consent-status`. */
export interface ConsentStatus {
  readonly conversationAllowed: boolean;
  readonly missingConsents: readonly string[];
  readonly blockedReason: 'consent' | 'archived' | 'deleted' | null;
}

export interface CharacterSummary {
  readonly id: string;
  readonly slug: string;
  readonly displayName: string;
  readonly tagline: string;
  /**
   * Whether this child may choose this character right now.
   *
   * `false` when a parent's allow-list excludes it, or the plan does not
   * include it. Absent on an older server, and absent means allowed — the
   * server is the gate either way, and dimming a character we could not ask
   * about would take a friend away for no reason.
   *
   * The child is shown a dimmed card saying "Not today". Never a price, never a
   * plan name, and never who decided.
   */
  readonly available?: boolean;
}

export interface Conversation {
  readonly id: string;
  readonly character: CharacterSummary;
  readonly status: 'active' | 'ended' | 'flagged';
}

export interface Turn {
  readonly status:
    'ok' | 'blocked' | 'escalated' | 'degraded' | 'ended' | 'unintelligible' | 'rejected';
  readonly reply: string;
  readonly audio?: { key: string; mimeType: string; durationMs: number } | null;
}

export interface PracticeTarget {
  readonly sequence: number;
  readonly text: string;
  readonly syllables: readonly string[];
  readonly hint: string | null;
}

export interface PracticeExercise {
  readonly exerciseKey: string;
  readonly title: string;
  readonly kind: 'word' | 'syllable';
  readonly targets: readonly PracticeTarget[];
}

export interface PracticeAttempt {
  readonly score: number;
  readonly feedback: { band: string; message: string; focus?: string; tryAgain: boolean };
  readonly newAchievements: readonly { key: string; title: string }[];
}

/** One row of `GET /v1/children`, and the whole of `GET /v1/children/:id`. */
export interface ChildDetail {
  readonly id: string;
  readonly displayName: string;
  readonly birthYear: number;
  readonly birthMonth: number;
  readonly ageGroup: string;
  readonly ageInSupportedRange: boolean;
  readonly status: 'active' | 'paused' | 'archived';
  readonly avatarKey: string | null;
  readonly preferredCharacterId: string | null;
  readonly languages: readonly {
    readonly languageCode: string;
    readonly isPrimary: boolean;
    readonly proficiency: 'learning' | 'conversational' | 'fluent' | 'native';
  }[];
  readonly archivedAt: string | null;
}

/** `GET`/`PUT /v1/children/:id/preferences`. Shapes the character; never bounds it. */
export interface ChildPreferences {
  readonly sessionLength: 'short' | 'medium' | 'long';
  readonly storytellingEnabled: boolean;
  readonly roleplayEnabled: boolean;
  readonly pronunciationPractice: boolean;
  readonly correctionStyle: 'none' | 'gentle' | 'active';
  /** Curated keys, never free text — the server rejects anything else. */
  readonly topicKeys: readonly string[];
}

/**
 * `GET`/`PUT /api/parent/controls/:childId`.
 *
 * Enforced server-side on every path a child can reach. The client's copy is a
 * form's worth of state, not an authority.
 */
export interface ParentalControls {
  readonly dailyMinuteLimit: number;
  readonly sessionMinuteLimit: number;
  readonly quietHoursStart: string | null;
  readonly quietHoursEnd: string | null;
  readonly allowedDays: readonly number[];
  readonly allowedCharacterIds: readonly string[];
  readonly blockedTopics: readonly string[];
  readonly languageLock: string | null;
  readonly contentFilterLevel: 'standard' | 'strict';
  readonly transcriptRetentionDays: number;
  /** What retention is DOING, as opposed to what was asked for. */
  readonly transcriptRetention: {
    readonly effectiveDays: number;
    readonly heldMessages: number;
    readonly deletedMessages: number;
    readonly oldestHeldAt: string | null;
  };
  readonly isPaused: boolean;
  readonly notifications: {
    readonly onSafetyFlag: boolean;
    readonly onDailySummary: boolean;
    readonly onWeeklySummary: boolean;
    readonly onTimeLimit: boolean;
  };
}

interface Activity {
  readonly conversationMinutes: number;
  readonly conversationCount: number;
  readonly conversationTurns: number;
  readonly wordsUsed: number;
  readonly newVocabulary: number;
  readonly storiesCompleted: number;
  readonly exercisesCompleted: number;
  readonly pronunciationAttempts: number;
  readonly pronunciationAverage: number | null;
}

/** `GET /api/parent/dashboard/:childId`. */
export interface ParentDashboard {
  readonly childId: string;
  readonly displayName: string;
  readonly ageGroup: string;
  readonly today: Activity;
  readonly thisWeek: Activity & { readonly activeDays: number };
  readonly usage: {
    readonly minutesUsedToday: number;
    readonly minutesRemainingToday: number | null;
    readonly dailyMinuteLimit: number;
    /** Why a child is currently stopped, if they are. The PARENT-facing reason. */
    readonly currentlyBlockedBy: string | null;
  };
  readonly levels: {
    readonly vocabularyLevel: string;
    readonly pronunciationLevel: string;
    readonly conversationSkillLevel: string;
    readonly note: string;
  };
  readonly milestones: readonly { key: string; title: string; achievedAt: string }[];
  /** Counts and categories only. The product never stores what was said. */
  readonly safety: {
    readonly total: number;
    readonly escalated: number;
    readonly byCategory: readonly { category: string; count: number }[];
    readonly note: string;
  };
  readonly controls: ParentalControls;
}

/** One row of `GET /api/learning/indicators`. Never a screening result. */
export interface LearningIndicator {
  readonly key: string;
  readonly observation: string;
  readonly suggestion: string;
  readonly notAClaim: string;
}

/** `GET /api/learning/indicators`. */
export interface LearningIndicators {
  readonly preamble: string;
  readonly indicators: readonly LearningIndicator[];
}

/** `GET /api/parent/progress/:childId`. */
export interface ParentProgress {
  readonly daily: readonly (Activity & { day: string; active: boolean })[];
  readonly weekly: readonly (Activity & { weekStart: string; activeDays: number })[];
  readonly vocabulary: {
    readonly distinctWords: number;
    readonly recent: readonly { word: string; firstUsedAt: string }[];
  };
  readonly pronunciation: {
    readonly attempts: number;
    readonly average: number | null;
    readonly recentByDay: readonly { day: string; average: number }[];
    /** Travels with every score a parent sees. Never dropped. */
    readonly disclaimer: string;
  };
  readonly indicatorsPreamble: string;
}

/** One row of `GET /api/conversations`. */
export interface ConversationRow {
  readonly id: string;
  readonly childId: string;
  readonly character: CharacterSummary;
  readonly language: string;
  readonly status: 'active' | 'ended' | 'flagged';
  readonly mode: 'chat' | 'story';
  readonly messageCount: number;
  readonly turnsUsed: number;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly endReason: string | null;
}

/** `GET /api/conversations/:id`. A redacted message returns "" plus a date. */
export interface ConversationDetail extends ConversationRow {
  readonly messages: readonly {
    readonly id: string;
    readonly role: 'child' | 'companion';
    readonly sequence: number;
    readonly text: string;
    readonly status: 'delivered' | 'blocked' | 'redacted';
    readonly redactedAt: string | null;
    readonly createdAt: string;
  }[];
}

/** `POST /api/practice/sessions`. */
export interface PracticeSession {
  readonly id: string;
  readonly childId: string;
  readonly exerciseKey: string;
  readonly language: string;
  readonly status: 'in_progress' | 'completed' | 'abandoned';
  readonly attemptCount: number;
  readonly averageScore: number | null;
  readonly startedAt: string;
  readonly completedAt: string | null;
}

/** `GET /api/practice/progress`. Exposure counts only — never a success rate. */
export interface PracticeProgress {
  readonly sessions: readonly PracticeSession[];
  readonly skills: readonly {
    readonly skillKey: string;
    readonly exposureCount: number;
    readonly lastPractisedAt: string;
  }[];
  readonly achievements: readonly { key: string; title: string; awardedAt: string }[];
  readonly disclaimer: string;
}

/**
 * Which vendor answers this family's children.
 *
 * Mirrors `AI_PROVIDER_NAMES` in `@kids/types`. Restated rather than imported
 * because the mobile app does not build against the workspace packages — the
 * same reason `ParentProfile` itself is restated here rather than shared.
 */
export type AiProviderName = 'anthropic' | 'openai' | 'google' | 'mock';

/** `GET /v1/parents/me`. */
export interface ParentProfile {
  readonly id: string;
  readonly email: string;
  readonly displayName: string | null;
  readonly countryCode: string;
  readonly locale: string;
  readonly timezone: string;
  readonly role: 'parent' | 'admin' | 'support';
  readonly emailVerified: boolean;
  readonly status: string;
  readonly permissions: readonly string[];
  readonly createdAt: string;
  /** The chosen vendor, or null to follow whatever the server is configured for. */
  readonly aiProvider: AiProviderName | null;
  /** What this deployment can actually reach — the only names worth offering. */
  readonly aiProvidersAvailable: readonly AiProviderName[];
  /** Which vendor a null preference resolves to right now. */
  readonly aiProviderEffective: AiProviderName;
}

/**
 * One row of `GET /v1/parents/me/sessions`.
 *
 * No device model and no location: the session store keeps neither, so there is
 * no field for either. See `app/(parent)/sessions.tsx` for why that trade is
 * made deliberately.
 */
export interface ParentSession {
  readonly id: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
  readonly current: boolean;
}

/**
 * One row of `GET /v1/consent/history`, newest first.
 *
 * `policyTextHash` rather than the text: what a parent agreed to is PROVEN by
 * the hash of the wording that was on screen, and storing the wording again per
 * decision would be a copy of a policy document per family.
 */
export interface ConsentRecord {
  readonly consentType: string;
  readonly granted: boolean;
  readonly policyVersion: string;
  readonly policyTextHash: string;
  readonly childId: string | null;
  readonly recordedAt: string;
}

/** One row of `GET /api/subscriptions/plans`. Public — a price list is not personal. */
export interface SubscriptionPlan {
  readonly code: string;
  readonly displayName: string;
  readonly description: string;
  readonly tier: 'free' | 'paid';
  readonly priceMinor: number;
  readonly currency: string;
  readonly billingInterval: 'week' | 'month' | 'year' | 'once' | 'none';
  readonly trialDays: number;
  readonly graceDays: number;
  readonly limits: {
    readonly dailyMinuteLimit: number;
    readonly childProfileLimit: number;
    readonly dailyTurnLimit: number;
    readonly maxConversationTurns: number;
    readonly concurrentConversationLimit: number;
    readonly voiceEnabled: boolean;
    readonly dailyVoiceTurnLimit: number;
  };
  readonly availableRails: readonly string[];
}

/** `GET /api/subscriptions/status`. `explanation` is written server-side, once. */
export interface SubscriptionStatus {
  readonly status: 'free' | 'trialing' | 'active' | 'grace' | 'past_due' | 'cancelled' | 'expired';
  readonly entitled: boolean;
  readonly plan: SubscriptionPlan;
  readonly rail: string | null;
  readonly currentPeriodEnd: string | null;
  readonly cancelAt: string | null;
  readonly childProfilesUsed: number;
  readonly paymentMethod: { readonly brand: string | null; readonly last4: string | null };
  readonly explanation: string;
}

/** One row of `GET /api/payments/rails`. `verified` is reported honestly. */
export interface PaymentRail {
  readonly rail: string;
  readonly mode: string;
  readonly verified: boolean;
  readonly supportsRefunds: boolean;
  readonly supportsRecurring: boolean;
  readonly currencies: readonly string[];
}
