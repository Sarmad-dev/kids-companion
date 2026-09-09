import type { Queryable } from '@kids/db';
import type { Clock } from '@kids/shared';

/**
 * The parental-control gate.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THIS IS THE ONLY THING THAT MAKES PARENTAL CONTROLS REAL.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every path a child can reach calls `evaluateParentalGate` before doing
 * anything: starting a conversation, sending a message, a voice turn, a practice
 * attempt. Not one of them trusts a client to have checked first, because a
 * client is a thing an adult can replace with `curl`.
 *
 * The controls existed in the schema from the first migration and NONE OF THEM
 * WERE ENFORCED. A parent could set a twenty-minute daily limit, see it saved,
 * and their child could talk for four hours. That is worse than having no
 * setting: it is a promise the product does not keep, and the parent has no way
 * to find out.
 *
 * THE DECISION LIVES HERE, IN ONE FUNCTION, so that a new route cannot enforce
 * three of the five rules by accident — and so it can be unit-tested against a
 * fixed clock rather than by waiting for a Tuesday.
 */

export type GateDenial =
  | 'paused'
  | 'daily_limit_reached'
  | 'session_limit_reached'
  | 'outside_allowed_days'
  | 'quiet_hours'
  | 'character_not_allowed'
  | 'language_not_allowed';

export interface ParentalControls {
  readonly isPaused: boolean;
  readonly dailyMinuteLimit: number;
  readonly sessionMinuteLimit: number;
  readonly quietHoursStart: string | null;
  readonly quietHoursEnd: string | null;
  readonly allowedDays: readonly number[];
  readonly allowedCharacterIds: readonly string[];
  readonly blockedTopics: readonly string[];
  readonly languageLock: string | null;
  readonly contentFilterLevel: 'standard' | 'strict';
  readonly secondsUsedToday: number;
}

export interface GateRequest {
  readonly controls: ParentalControls;
  readonly clock: Clock;
  /** Set when a specific character is being requested. */
  readonly characterId?: string;
  /** Set when a specific language is being requested. */
  readonly language?: string;
  /** Seconds the current session has been running, for the session limit. */
  readonly sessionSeconds?: number;
}

export interface GateResult {
  readonly allowed: boolean;
  readonly denial?: GateDenial;
  /** Minutes left today. Zero when the limit is reached, `null` when unlimited. */
  readonly minutesRemaining: number | null;
}

/**
 * What a CHILD hears when a control stops them.
 *
 * Never "your parent has blocked this". A child told that learns the rule is a
 * person to argue with rather than how the world is, and it puts the companion
 * in the middle of a family (docs/ERROR_HANDLING.md §10). The parent sees the
 * real reason on their own dashboard, where it belongs.
 */
export const CHILD_FACING_MESSAGE: Readonly<Record<GateDenial, string>> = Object.freeze({
  paused: "Let's play again a bit later!",
  daily_limit_reached: "That was so much fun! Let's talk again tomorrow.",
  session_limit_reached: "That was a lovely long chat! Let's have a rest now.",
  outside_allowed_days: "Let's play again another day!",
  quiet_hours: "It's rest time now. See you soon!",
  character_not_allowed: "Let's pick someone else to play with!",
  language_not_allowed: "Let's chat in our usual language!",
});

/** Parses `HH:MM:SS` into minutes since midnight. `null` for an absent bound. */
const minutesOfDay = (time: string | null): number | null => {
  if (time === null) return null;
  const [hours, minutes] = time.split(':');
  const h = Number(hours);
  const m = Number(minutes);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h * 60 + m;
};

/**
 * Whether `now` falls inside quiet hours.
 *
 * Handles a window that CROSSES MIDNIGHT, which is the normal case — "quiet from
 * 19:00 to 07:00" is what a parent actually sets, and a naive `start <= now <=
 * end` comparison silently permits the entire night.
 */
export const inQuietHours = (
  nowMinutes: number,
  startTime: string | null,
  endTime: string | null,
): boolean => {
  const start = minutesOfDay(startTime);
  const end = minutesOfDay(endTime);
  if (start === null || end === null) return false;
  if (start === end) return false;

  return start < end
    ? nowMinutes >= start && nowMinutes < end
    : nowMinutes >= start || nowMinutes < end;
};

export const evaluateParentalGate = (request: GateRequest): GateResult => {
  const { controls, clock } = request;
  const now = new Date(clock.now());

  const dailySeconds = controls.dailyMinuteLimit * 60;
  const minutesRemaining =
    controls.dailyMinuteLimit === 0
      ? null
      : Math.max(0, Math.ceil((dailySeconds - controls.secondsUsedToday) / 60));

  const deny = (denial: GateDenial): GateResult => ({ allowed: false, denial, minutesRemaining });

  // Order matters only for which reason a parent sees first, and this is the
  // order a parent would rank them in: an explicit pause, then the schedule,
  // then time, then scope.
  if (controls.isPaused) return deny('paused');

  // ISO weekday: getUTCDay is 0 for Sunday, ISO calls that 7.
  const isoDay = now.getUTCDay() === 0 ? 7 : now.getUTCDay();
  if (controls.allowedDays.length > 0 && !controls.allowedDays.includes(isoDay)) {
    return deny('outside_allowed_days');
  }

  const nowMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  if (inQuietHours(nowMinutes, controls.quietHoursStart, controls.quietHoursEnd)) {
    return deny('quiet_hours');
  }

  // A daily limit of zero means UNLIMITED, matching the "empty means all"
  // convention the array columns use. The schema's lower bound is 0 and a
  // parent who wants to stop access entirely uses the pause.
  if (controls.dailyMinuteLimit > 0 && controls.secondsUsedToday >= dailySeconds) {
    return deny('daily_limit_reached');
  }

  if (
    controls.sessionMinuteLimit > 0 &&
    request.sessionSeconds !== undefined &&
    request.sessionSeconds >= controls.sessionMinuteLimit * 60
  ) {
    return deny('session_limit_reached');
  }

  if (
    request.characterId !== undefined &&
    controls.allowedCharacterIds.length > 0 &&
    !controls.allowedCharacterIds.includes(request.characterId)
  ) {
    return deny('character_not_allowed');
  }

  if (
    request.language !== undefined &&
    controls.languageLock !== null &&
    controls.languageLock !== request.language
  ) {
    return deny('language_not_allowed');
  }

  return { allowed: true, minutesRemaining };
};

/* -------------------------------------------------------------------------- */
/* Loading                                                                     */
/* -------------------------------------------------------------------------- */

interface GateRow {
  is_paused: boolean;
  daily_minute_limit: number;
  session_minute_limit: number;
  quiet_hours_start: string | null;
  quiet_hours_end: string | null;
  allowed_days: number[];
  allowed_character_ids: string[];
  blocked_topics: string[];
  language_lock: string | null;
  content_filter_level: 'standard' | 'strict';
  seconds_used_today: number;
}

/**
 * The controls in force for a child.
 *
 * Runs inside the caller's RLS-scoped transaction, so a parent cannot read
 * another family's settings even by calling this directly.
 *
 * A child with NO ROW gets the conservative defaults rather than an error. A
 * missing row is our bug, and the failure direction for our bug must not be "the
 * child gets unlimited access".
 */
export const loadParentalControls = async (
  tx: Queryable,
  childId: string,
): Promise<ParentalControls> => {
  const { rows } = await tx.query<GateRow>(
    `select is_paused, daily_minute_limit, session_minute_limit, quiet_hours_start,
            quiet_hours_end, allowed_days, allowed_character_ids, blocked_topics,
            language_lock, content_filter_level, seconds_used_today
       from app.parental_gate_inputs($1)`,
    [childId],
  );

  const row = rows[0];
  if (!row) {
    return {
      isPaused: false,
      dailyMinuteLimit: 20,
      sessionMinuteLimit: 15,
      quietHoursStart: null,
      quietHoursEnd: null,
      allowedDays: [],
      allowedCharacterIds: [],
      blockedTopics: [],
      languageLock: null,
      contentFilterLevel: 'standard',
      secondsUsedToday: 0,
    };
  }

  return {
    isPaused: row.is_paused,
    dailyMinuteLimit: row.daily_minute_limit,
    sessionMinuteLimit: row.session_minute_limit,
    quietHoursStart: row.quiet_hours_start,
    quietHoursEnd: row.quiet_hours_end,
    allowedDays: row.allowed_days,
    allowedCharacterIds: row.allowed_character_ids,
    blockedTopics: row.blocked_topics,
    languageLock: row.language_lock,
    contentFilterLevel: row.content_filter_level,
    secondsUsedToday: row.seconds_used_today,
  };
};

/**
 * Loads and evaluates in one step.
 *
 * The shape every child-facing route uses, so that "did you check the parental
 * controls?" has one answer rather than five slightly different ones.
 */
export const checkParentalGate = async (
  tx: Queryable,
  childId: string,
  clock: Clock,
  request: Omit<GateRequest, 'controls' | 'clock'> = {},
): Promise<{ controls: ParentalControls; result: GateResult }> => {
  const controls = await loadParentalControls(tx, childId);
  return { controls, result: evaluateParentalGate({ controls, clock, ...request }) };
};
