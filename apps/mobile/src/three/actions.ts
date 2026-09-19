/**
 * The moves a child can ask a character to make.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THESE ARE PURE FUNCTIONS OF PROGRESS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Same rule as `moods.ts`: every pose is a function of `(action, progress)`
 * and nothing else. There is no timeline to build or tear down, so pressing
 * "Jump" twice in a row restarts the move on the next frame instead of
 * queueing a second one, and a move can never leave a bone somewhere the mood
 * pose does not expect — every offset is zero at both ends.
 *
 * The offsets are ADDED to the mood pose by `useResolvedRigMood`, which is
 * what lets a character wave while it is still breathing and blinking.
 */

export type CharacterAction = 'wave' | 'jump' | 'dance' | 'clap' | 'spin' | 'peek';

export const CHARACTER_ACTIONS: readonly CharacterAction[] = [
  'wave',
  'jump',
  'dance',
  'clap',
  'spin',
  'peek',
];

/** The moves a tap on the character itself picks from — the cheerful ones. */
export const POKE_ACTIONS: readonly CharacterAction[] = ['jump', 'spin', 'peek', 'wave'];

/** A move, and a counter that makes the same move restartable. */
export interface ActionRequest {
  readonly kind: CharacterAction;
  readonly nonce: number;
}

/** Seconds each move takes, start to finish. */
export const ACTION_SECONDS: Readonly<Record<CharacterAction, number>> = {
  wave: 2.2,
  jump: 1.4,
  dance: 3.2,
  clap: 2,
  spin: 1.6,
  peek: 2.4,
};

export interface ActionPose {
  /** World-unit lift of the whole character. */
  readonly rootY: number;
  /** Extra yaw of the whole character, radians. */
  readonly rootRotY: number;
  /** Multiplier on the root's scale; below 1 squashes, above 1 stretches. */
  readonly rootScale: number;
  readonly headRoll: number;
  readonly headPitch: number;
  /** Added to every limb's swing (arms, ears, legs). */
  readonly limbLift: number;
  /** Added to every wing, mirrored by the caller. */
  readonly wingLift: number;
}

export const REST_POSE: ActionPose = {
  rootY: 0,
  rootRotY: 0,
  rootScale: 1,
  headRoll: 0,
  headPitch: 0,
  limbLift: 0,
  wingLift: 0,
};

const TWO_PI = Math.PI * 2;

/** 0 at both ends, 1 in the middle. */
const bell = (p: number): number => Math.sin(Math.PI * p);

/** Smooth 0 → 1. */
const smooth = (p: number): number => p * p * (3 - 2 * p);

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

export const actionPose = (action: CharacterAction, rawProgress: number): ActionPose => {
  const p = clamp01(rawProgress);
  if (p <= 0 || p >= 1) return REST_POSE;
  const e = bell(p);

  switch (action) {
    case 'wave': {
      const flap = 0.6 + 0.4 * Math.sin(p * TWO_PI * 4);
      return {
        ...REST_POSE,
        limbLift: e * 0.9 * flap,
        wingLift: e * 0.7 * flap,
        headRoll: e * 0.14,
      };
    }
    case 'jump': {
      // Two hops. |sin| is zero at p = 0, 0.5 and 1, so it lands between them.
      const hop = Math.abs(Math.sin(p * TWO_PI));
      return {
        ...REST_POSE,
        rootY: hop * 0.32,
        // Stretch on the way up, squash as it lands.
        rootScale: 1 + (hop - 0.5) * 0.08 * e,
        limbLift: hop * 0.9,
        wingLift: hop * 0.9,
      };
    }
    case 'dance': {
      const beat = Math.sin(p * TWO_PI * 3);
      return {
        ...REST_POSE,
        rootY: Math.abs(beat) * 0.1 * e,
        rootRotY: Math.sin(p * TWO_PI * 2) * 0.6 * e,
        headRoll: beat * 0.22 * e,
        limbLift: beat * 0.8 * e,
        wingLift: Math.abs(beat) * 0.8 * e,
      };
    }
    case 'clap': {
      const hit = Math.abs(Math.sin(p * TWO_PI * 4));
      return {
        ...REST_POSE,
        rootY: hit * 0.04 * e,
        headPitch: e * 0.1,
        limbLift: hit * 0.55 * e,
        wingLift: hit * 0.4 * e,
      };
    }
    case 'spin':
      return {
        ...REST_POSE,
        // A whole turn, so it ends facing the way it started.
        rootRotY: smooth(p) * TWO_PI,
        rootY: e * 0.14,
        limbLift: e * 0.6,
        wingLift: e * 0.8,
      };
    case 'peek': {
      // Duck out of sight, hold, pop back with a little overshoot.
      const hide = p < 0.55 ? smooth(p / 0.55) : 1 - smooth((p - 0.55) / 0.2);
      const overshoot = p > 0.75 ? Math.sin(((p - 0.75) / 0.25) * Math.PI) * 0.1 : 0;
      return {
        ...REST_POSE,
        rootScale: 1 - 0.5 * clamp01(hide) + overshoot,
        headRoll: e * 0.18,
        headPitch: -clamp01(hide) * 0.3,
      };
    }
  }
};

/**
 * How long a reply with no audio keeps the mouth moving, in milliseconds.
 *
 * A text-only reply has no playback to end the "speaking" state, so the mouth
 * is timed from the words instead: roughly a child's reading pace, floored so
 * a two-word reply still visibly talks and capped so a long story does not
 * leave the character chattering long after the caption has been read.
 */
export const talkingMsFor = (reply: string): number =>
  Math.min(6_000, Math.max(1_200, reply.length * 60));
