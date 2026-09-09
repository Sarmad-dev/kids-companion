import { readSession } from './session';

/**
 * The API client.
 *
 * SERVER-SIDE ONLY. Every function here runs in a Server Component or a Server
 * Action, attaches the session token there, and returns plain data to the render
 * — so the token is never in a client bundle and never in `document`.
 *
 * A NOTE ON AUTHORISATION. Nothing in this file authorises anything. It sends a
 * parent's token and reports what came back; the API decides what that parent
 * may see, and RLS decides it again in the database. If this file had a bug that
 * requested another family's child, the answer would still be a 404 — which is
 * the property that makes "do not trust frontend authorization" true rather than
 * a comment.
 */

/**
 * Where the API is.
 *
 * Server-side only, and deliberately NOT `NEXT_PUBLIC_` — a public variable is
 * compiled into the browser bundle, and nothing in the browser calls the API
 * directly. Defaults to the API's own port (`API_PORT=8080`), not the port this
 * app serves on.
 */
export const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:8080';

export type ApiOutcome<T> =
  | { readonly state: 'ok'; readonly data: T }
  | { readonly state: 'empty' }
  | { readonly state: 'unauthorised' }
  | { readonly state: 'error'; readonly message: string; readonly retryable: boolean };

/**
 * What a parent is told when something fails.
 *
 * More detail than the child app gives — an adult can act on "we could not
 * reach the server" — but still never a status code, a stack, or a vendor name.
 */
const MESSAGES = {
  offline: 'We could not reach the server. Check your connection and try again.',
  server: 'Something went wrong at our end. Please try again in a moment.',
  notFound: 'We could not find that.',
  invalid: 'That did not look right. Please check and try again.',
} as const;

export const apiFetch = async <T>(
  route: string,
  init: { method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; json?: unknown } = {},
): Promise<ApiOutcome<T>> => {
  const session = await readSession();
  if (!session) return { state: 'unauthorised' };

  try {
    const response = await fetch(`${API_BASE_URL}${route}`, {
      method: init.method ?? 'GET',
      headers: {
        authorization: `Bearer ${session.accessToken}`,
        ...(init.json === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(init.json === undefined ? {} : { body: JSON.stringify(init.json) }),
      // A dashboard showing yesterday's numbers is worse than one that takes a
      // moment. Nothing here is cacheable across parents anyway.
      cache: 'no-store',
    });

    if (response.status === 401 || response.status === 403) return { state: 'unauthorised' };
    if (response.status === 404) {
      return { state: 'error', message: MESSAGES.notFound, retryable: false };
    }
    if (response.status === 400) {
      return { state: 'error', message: MESSAGES.invalid, retryable: false };
    }
    if (!response.ok) {
      return { state: 'error', message: MESSAGES.server, retryable: true };
    }

    return { state: 'ok', data: (await response.json()) as T };
  } catch {
    // A transport failure. The cause is deliberately discarded rather than
    // surfaced: a fetch error message can carry the internal hostname.
    return { state: 'error', message: MESSAGES.offline, retryable: true };
  }
};

/* -------------------------------------------------------------------------- */
/* The shapes this dashboard reads                                             */
/* -------------------------------------------------------------------------- */

export interface Child {
  readonly id: string;
  readonly displayName: string;
  readonly ageGroup?: string;
}

export interface Activity {
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

export interface Dashboard {
  readonly childId: string;
  readonly displayName: string;
  readonly ageGroup: string;
  readonly today: Activity;
  readonly thisWeek: Activity & { activeDays: number };
  readonly usage: {
    readonly minutesUsedToday: number;
    readonly minutesRemainingToday: number | null;
    readonly dailyMinuteLimit: number;
    readonly currentlyBlockedBy: string | null;
  };
  readonly levels: {
    readonly vocabularyLevel: string;
    readonly pronunciationLevel: string;
    readonly conversationSkillLevel: string;
    readonly note: string;
  };
  readonly milestones: readonly { key: string; title: string; achievedAt: string }[];
  readonly safety: {
    readonly total: number;
    readonly escalated: number;
    readonly byCategory: readonly { category: string; count: number }[];
    readonly note: string;
  };
  readonly controls: ParentalControls;
}

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
  readonly isPaused: boolean;
  readonly notifications: {
    readonly onSafetyFlag: boolean;
    readonly onDailySummary: boolean;
    readonly onWeeklySummary: boolean;
    readonly onTimeLimit: boolean;
  };
}

export interface Progress {
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
    readonly disclaimer: string;
  };
  readonly indicatorsPreamble: string;
}

export interface ConversationSummary {
  readonly id: string;
  readonly character: { slug: string; displayName: string };
  readonly status: 'active' | 'ended' | 'flagged';
  readonly messageCount: number;
  readonly turnsUsed: number;
  readonly startedAt: string;
  readonly endedAt: string | null;
}

export interface Message {
  readonly id: string;
  readonly role: 'child' | 'companion';
  readonly sequence: number;
  readonly text: string;
  readonly status: 'delivered' | 'blocked' | 'redacted';
  readonly createdAt: string;
}

export interface PracticeProgress {
  readonly sessions: readonly {
    id: string;
    exerciseKey: string;
    status: string;
    attemptCount: number;
    averageScore: number | null;
    startedAt: string;
  }[];
  readonly skills: readonly { skillKey: string; exposureCount: number; lastPractisedAt: string }[];
  readonly achievements: readonly { key: string; title: string; awardedAt: string }[];
  readonly disclaimer: string;
}

export interface CharacterSummary {
  readonly id: string;
  readonly slug: string;
  readonly displayName: string;
  readonly tagline: string;
  readonly requiresPaidPlan: boolean;
}

export interface Indicators {
  readonly preamble: string;
  readonly indicators: readonly {
    key: string;
    observation: string;
    suggestion: string;
    notAClaim: string;
  }[];
}

export interface Plan {
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

/**
 * The resolved subscription state.
 *
 * `status` has already had elapsed deadlines applied by the API, so a grace
 * window that closed a minute ago reads as `expired` here — the dashboard never
 * has to do date arithmetic to decide what to show.
 */
export interface SubscriptionStatus {
  readonly status: 'free' | 'trialing' | 'active' | 'grace' | 'past_due' | 'cancelled' | 'expired';
  readonly entitled: boolean;
  readonly plan: Plan;
  readonly rail: string | null;
  readonly trialEndsAt: string | null;
  readonly currentPeriodEnd: string | null;
  readonly graceEndsAt: string | null;
  readonly cancelAt: string | null;
  readonly cancelledAt: string | null;
  readonly trialAvailable: boolean;
  readonly childProfilesUsed: number;
  /** A brand and four digits. There is no card number to return. */
  readonly paymentMethod: { readonly brand: string | null; readonly last4: string | null };
  readonly explanation: string;
}

export interface ParentProfile {
  readonly id: string;
  readonly email: string;
  readonly displayName: string | null;
  readonly countryCode: string;
  readonly locale: string;
  readonly timezone: string;
  readonly role: string;
  readonly emailVerified: boolean;
  readonly status: string;
  readonly createdAt: string;
}

export interface SignedInDevice {
  readonly id: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
  readonly current: boolean;
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                       */
/* -------------------------------------------------------------------------- */

export const getChildren = async () => await apiFetch<{ items: Child[] }>('/v1/children');

export const getDashboard = async (childId: string) =>
  await apiFetch<Dashboard>(`/api/parent/dashboard/${childId}`);

export const getProgress = async (childId: string, days = 30) =>
  await apiFetch<Progress>(`/api/parent/progress/${childId}?days=${String(days)}`);

export const getConversations = async (childId: string) =>
  await apiFetch<{ items: ConversationSummary[] }>(
    `/api/conversations?childId=${childId}&limit=50`,
  );

export const getConversation = async (conversationId: string) =>
  await apiFetch<ConversationSummary & { messages: Message[] }>(
    `/api/conversations/${conversationId}`,
  );

export const getPractice = async (childId: string) =>
  await apiFetch<PracticeProgress>(`/api/practice/progress?childId=${childId}`);

export const getIndicators = async (childId: string) =>
  await apiFetch<Indicators>(`/api/learning/indicators?childId=${childId}`);

export const updateControls = async (childId: string, body: unknown) =>
  await apiFetch<ParentalControls>(`/api/parent/controls/${childId}`, {
    method: 'PUT',
    json: body,
  });

export const getSubscriptionStatus = async () =>
  await apiFetch<SubscriptionStatus>('/api/subscriptions/status');

export const getPlans = async () =>
  await apiFetch<{ items: Plan[]; currency: string }>('/api/subscriptions/plans');

/**
 * Cancel and resume.
 *
 * Neither takes a subscription id: the API resolves it from the session, so
 * there is no parameter through which one parent could name another's plan.
 */
export const cancelSubscription = async () =>
  await apiFetch<{ status: string; accessUntil: string | null; explanation: string }>(
    '/api/subscriptions/cancel',
    { method: 'POST', json: {} },
  );

export const resumeSubscription = async () =>
  await apiFetch<{ status: string; renewsAt: string | null; explanation: string }>(
    '/api/subscriptions/resume',
    { method: 'POST', json: {} },
  );

export const getParentProfile = async () => await apiFetch<ParentProfile>('/v1/parents/me');

export const getSignedInDevices = async () =>
  await apiFetch<{ items: SignedInDevice[] }>('/v1/parents/me/sessions');

/**
 * Sign out everywhere.
 *
 * Includes the session making the call, which is the point — a parent who thinks
 * someone else has their password needs one action that ends every session, not
 * a list to work through.
 */
export const revokeAllSessions = async () =>
  await apiFetch<{ revoked: number }>('/v1/parents/me/sessions/revoke-all', { method: 'POST' });

export const getCharacters = async (childId: string) =>
  await apiFetch<{ items: CharacterSummary[] }>(`/v1/characters?childId=${childId}`);

export const updateProfile = async (body: unknown) =>
  await apiFetch<{ id: string; displayName: string | null }>('/v1/parents/me', {
    method: 'PATCH',
    json: body,
  });

export const changePassword = async (currentPassword: string, newPassword: string) =>
  await apiFetch<{ changed: boolean }>('/v1/parents/me/password', {
    method: 'POST',
    json: { currentPassword, newPassword },
  });

/**
 * Ask for the account to be deleted.
 *
 * Re-authenticated on the API with the parent's password, because an active
 * session is not enough for something irreversible. Returns after entering a
 * 30-day grace window — this call schedules a deletion, it does not perform one.
 */
export const requestAccountDeletion = async (confirmPassword: string) =>
  await apiFetch<{ status: string; graceDays: number }>('/v1/parents/me', {
    method: 'DELETE',
    json: { confirmPassword },
  });
