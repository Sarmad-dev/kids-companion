/**
 * Turning a failure into something a child can hear.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * NO RAW ERROR EVER REACHES THIS SCREEN.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Not a provider message, not a status code, not a stack, not a request id. A
 * four-year-old cannot act on "503 Service Unavailable", and showing it teaches
 * them the thing is broken and they broke it. Every failure below becomes one
 * warm sentence in the character's voice plus, sometimes, a way to try again.
 *
 * The request id IS captured — but into the log buffer a parent can send to
 * support, never onto the screen.
 */

export type FailureKind =
  | 'offline'
  | 'slow'
  | 'server'
  | 'unauthorised'
  | 'not_allowed_now'
  | 'no_stories_left'
  | 'nothing_heard'
  | 'microphone_blocked'
  | 'unknown';

export interface FriendlyFailure {
  readonly kind: FailureKind;
  /** What the child sees and hears. Always in the character's voice. */
  readonly message: string;
  /** Whether a retry could plausibly help. Drives whether a button appears. */
  readonly retryable: boolean;
  /** For the support log. NEVER rendered. */
  readonly requestId?: string;
  /**
   * The server's error code. NEVER rendered either — it is here so a screen can
   * DECIDE something, which is different from displaying something. The one
   * current use is recognising a quota a previous session leaked and repairing
   * it, rather than showing a child a sentence that will never stop being true.
   */
  readonly code?: string;
}

const MESSAGES: Readonly<Record<FailureKind, string>> = Object.freeze({
  offline: "I can't hear you from here! Let's try again when the internet is back.",
  slow: 'Hmm, that took a while. Shall we try once more?',
  server: "Oh! I got a bit muddled. Let's try again in a moment.",
  // Deliberately not "you are logged out". A child does not have an account and
  // cannot fix one; this is a grown-up's job and the wording sends them to find one.
  unauthorised: "Let's go and find a grown-up to help!",
  not_allowed_now: "Let's play again a bit later!",
  // The weekly story allowance, which deserves better than the generic "later":
  // the child can still CHAT right now, and the sentence points at that instead
  // of leaving them at a door that will not open until Monday.
  no_stories_left: "We've made all our stories for this week! Shall we just talk instead?",
  nothing_heard: "Ooh, I didn't quite catch that! Can you say it again?",
  microphone_blocked: 'I need to be able to hear you! A grown-up can help with that.',
  unknown: "Something went a bit wobbly. Let's try again!",
});

const RETRYABLE: ReadonlySet<FailureKind> = new Set<FailureKind>([
  'offline',
  'slow',
  'server',
  'nothing_heard',
  'unknown',
]);

/** The API's error envelope, as far as this app is willing to look at it. */
interface ServerErrorBody {
  error?: { code?: unknown; requestId?: unknown };
}

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

/**
 * Maps anything that went wrong onto one of a handful of kinds.
 *
 * The mapping is deliberately coarse. A child does not benefit from the
 * difference between a 500 and a 502, and pretending otherwise produces a dozen
 * near-identical strings that all mean "it didn't work".
 */
export const toFriendlyFailure = (input: {
  status?: number;
  body?: unknown;
  cause?: unknown;
  offline?: boolean;
  timedOut?: boolean;
}): FriendlyFailure => {
  const body = (input.body ?? {}) as ServerErrorBody;
  const requestId = asString(body.error?.requestId);
  const code = asString(body.error?.code);

  const kind: FailureKind =
    input.offline === true
      ? 'offline'
      : input.timedOut === true
        ? 'slow'
        : input.status === 401 || input.status === 403
          ? 'unauthorised'
          : code === 'QUOTA_WEEKLY_STORIES_EXHAUSTED'
            ? 'no_stories_left'
            : code === 'SUBSCRIPTION_REQUIRED' || input.status === 402
              ? 'not_allowed_now'
              : input.status === 429
                ? 'not_allowed_now'
                : input.status !== undefined && input.status >= 500
                  ? 'server'
                  : input.status === 400
                    ? 'not_allowed_now'
                    : 'unknown';

  return {
    kind,
    message: MESSAGES[kind],
    retryable: RETRYABLE.has(kind),
    ...(requestId === undefined ? {} : { requestId }),
    ...(code === undefined ? {} : { code }),
  };
};

export const failureFor = (kind: FailureKind): FriendlyFailure => ({
  kind,
  message: MESSAGES[kind],
  retryable: RETRYABLE.has(kind),
});
