import type { TalkState } from '../hooks/recorder-machine';

/**
 * The five moods, and the exact numbers behind each one.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE WHOLE LATENCY STORY IS TOLD BY THE BODY, NOT BY A SPINNER
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A voice turn is one to three seconds of round trip. A child of four cannot
 * read "thinking…", cannot interpret a progress bar, and reads a spinner as the
 * app being broken. So the character carries the wait instead: it leans in when
 * the microphone opens, tilts and turns and blinks faster while the answer is
 * in flight, and bobs on the speech rhythm while talking. Nothing on the screen
 * has to say what is happening, because the character is visibly doing it.
 *
 * These are the design's own figures, transcribed rather than re-derived —
 * periods in seconds, amplitudes in radians or as a fraction of rest scale.
 * They are ONE table because the moods are only meaningful relative to each
 * other: "thinking" reads as thinking because its tilt is the largest and its
 * blink is the fastest, not because 0.28 is a special number.
 *
 * `sad` IS RESERVED FOR THE PRODUCT'S OWN FAILURES. A child's mistake never
 * produces a sad character — mispronouncing "elephant" is not something to be
 * disappointed about, and a four-year-old reads a drooping character as their
 * own fault long before they read it as ours.
 */

export type Mood = 'resting' | 'listening' | 'thinking' | 'talking' | 'sad';

export interface MoodTuning {
  /** Head roll: period in seconds, and swing. */
  readonly swayPeriod: number;
  readonly swayAmount: number;
  /** Chest breathing: period in seconds, and scale swing as a fraction of rest. */
  readonly breathPeriod: number;
  readonly breathAmount: number;
  /** Seconds between blinks, before jitter. */
  readonly blinkPeriod: number;
  /** Brow lift held for the duration of the mood. Negative droops. */
  readonly brow: number;
  /** Held head pitch (lean in / look up) and yaw (look away), in radians. */
  readonly tilt: number;
  readonly turn: number;
  /** Ears, tail, wings and arms — one generic limb swing. */
  readonly limb: number;
  readonly limbPeriod: number;
  /** Whether the mouth is working, and the head-bob period that goes with it. */
  readonly mouth: boolean;
  readonly bobPeriod: number;
  /**
   * How far the whole character drifts around its spot, in world units.
   *
   * ═══════════════════════════════════════════════════════════════════════
   * WHY A CHARACTER THAT ONLY BREATHES STILL READS AS A STATUE
   * ═══════════════════════════════════════════════════════════════════════
   *
   * Breath, sway and blink are all ON the body: they change its shape without
   * changing where it is. A four-year-old watching for thirty seconds reads
   * that as a very good statue, because nothing has ever moved past anything
   * else. A few centimetres of drift and a few degrees of turn — enough that
   * the character's relationship to the fence post behind it changes — is
   * what makes it a creature standing there rather than a model of one.
   *
   * It is deliberately smallest while LISTENING. A character that wanders off
   * while a child is talking to it has stopped paying attention, and that is
   * the one moment in the app where undivided attention is the message.
   */
  readonly wander: number;
  /** Seconds for one there-and-back of that drift. */
  readonly wanderPeriod: number;
}

export const MOODS: Readonly<Record<Mood, MoodTuning>> = {
  resting: {
    swayPeriod: 3.6,
    swayAmount: 0.1,
    breathPeriod: 3.2,
    breathAmount: 0.02,
    blinkPeriod: 4,
    brow: 0,
    tilt: 0.02,
    turn: 0,
    limb: 0.1,
    limbPeriod: 3,
    mouth: false,
    bobPeriod: 0,
    wander: 0.13,
    wanderPeriod: 7.5,
  },
  /* Leaning in IS the whole message. Nine degrees toward the child, brows up,
   * faster breath — a body language a pre-verbal child already reads. */
  listening: {
    swayPeriod: 4.2,
    swayAmount: 0.05,
    breathPeriod: 2.2,
    breathAmount: 0.032,
    blinkPeriod: 3.2,
    brow: 0.035,
    tilt: 0.157,
    turn: 0.1,
    limb: 0.28,
    limbPeriod: 1.4,
    mouth: false,
    bobPeriod: 0,
    wander: 0.04,
    wanderPeriod: 6.0,
  },
  /* The biggest tilt and turn, and the fastest blink: visibly working on it. */
  thinking: {
    swayPeriod: 5,
    swayAmount: 0.04,
    breathPeriod: 2.8,
    breathAmount: 0.022,
    blinkPeriod: 1.6,
    brow: 0.022,
    tilt: 0.28,
    turn: 0.3,
    limb: 0.08,
    limbPeriod: 3.4,
    mouth: false,
    bobPeriod: 0,
    wander: 0.09,
    wanderPeriod: 5.0,
  },
  talking: {
    swayPeriod: 0.85,
    swayAmount: 0.06,
    breathPeriod: 2,
    breathAmount: 0.038,
    blinkPeriod: 3.5,
    brow: 0.012,
    tilt: 0.05,
    turn: 0.04,
    limb: 0.34,
    limbPeriod: 0.85,
    mouth: true,
    bobPeriod: 0.85,
    wander: 0.11,
    wanderPeriod: 3.4,
  },
  sad: {
    swayPeriod: 6,
    swayAmount: 0.02,
    breathPeriod: 4,
    breathAmount: 0.012,
    blinkPeriod: 6,
    brow: -0.105,
    tilt: -0.18,
    turn: 0,
    limb: 0.03,
    limbPeriod: 5,
    mouth: false,
    bobPeriod: 0,
    wander: 0.03,
    wanderPeriod: 9.0,
  },
};

/** How long one blink takes, top to bottom. */
export const BLINK_SECONDS = 0.16;

/** The mouth hinge, in hertz. Fast enough to read as speech, not as chewing. */
export const MOUTH_HZ = 7;

/**
 * The slower beat that decides how wide each of those openings gets.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY ONE SINE IS NOT A MOUTH
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `MOUTH_HZ` alone opens the mouth by the identical amount every time, which
 * is a metronome, and a metronome is what a child reads as "the toy is doing
 * its noise" rather than "she is telling me something". Real speech varies the
 * opening constantly — a stressed syllable is wide, an unstressed one barely
 * parts the lips.
 *
 * So the fast term is multiplied by a slow one at this rate, which is roughly
 * phrase speed. The product is still a pure function of `(mood, elapsed)` —
 * no audio analysis, no viseme track, nothing to keep in sync with a stream
 * that may not have started yet — and it costs one more `sin` per frame.
 */
export const MOUTH_ENVELOPE_HZ = 1.9;

export const moodFor = (state: TalkState): Mood => {
  switch (state) {
    case 'idle':
    case 'requesting_permission':
      return 'resting';
    case 'recording':
      return 'listening';
    case 'thinking':
      return 'thinking';
    case 'speaking':
      return 'talking';
    case 'failed':
      return 'sad';
  }
};
