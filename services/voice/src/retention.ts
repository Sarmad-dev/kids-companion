import type { Clock } from '@kids/shared';

/**
 * Audio retention policy.
 *
 * The governing decision is docs/adr/0006: **raw child audio is transcribed and
 * discarded**. Retention is not a setting with a sensible non-zero default that
 * someone tunes — it is off, and turning it on for a particular child requires
 * that child's parent to have opted in specifically.
 *
 * This module exists because "discard immediately" still has to be *expressed*
 * somewhere, and expressing it as a policy object rather than as a hard-coded
 * `delete()` call is what makes the alternative auditable. A reviewer can read
 * `resolveRetention` and see every input that could make audio survive a turn.
 *
 * Three inputs, all of which must permit it:
 *
 *   1. `RETENTION_RAW_AUDIO_DAYS > 0`   — configuration, gated in production by
 *                                          an explicit acknowledgement variable
 *   2. the parent has granted `audio_retention` consent for THIS child
 *   3. the audio is a child upload rather than a synthesised reply
 *
 * If any of the three says no, the answer is the transient window: long enough
 * to transcribe and hand back, never longer.
 */

export type RetentionDecision = 'transient' | 'retained';

export interface RetentionPolicy {
  /** From `RETENTION_RAW_AUDIO_DAYS`. Zero means discard at transcription. */
  readonly rawAudioDays: number;
  /**
   * How long an artefact may live while the turn that produced it is in flight.
   *
   * Not a retention period — a timeout. It exists because the pipeline writes
   * the reply audio before the client fetches it, and a crash between those two
   * points must not leave an object behind forever.
   */
  readonly transientSeconds: number;
}

export const DEFAULT_RETENTION_POLICY: RetentionPolicy = Object.freeze({
  rawAudioDays: 0,
  transientSeconds: 300,
});

export interface RetentionInput {
  readonly policy: RetentionPolicy;
  readonly kind: 'child_upload' | 'companion_reply';
  /** Whether this child's parent has a live, specific `audio_retention` consent. */
  readonly parentOptedIn: boolean;
  readonly clock: Clock;
}

export interface ResolvedRetention {
  readonly decision: RetentionDecision;
  readonly expiresAt: Date;
  /** Why, in one word, for the audit record. Never free text. */
  readonly basis: 'policy_zero' | 'no_consent' | 'synthesis' | 'parent_opt_in';
}

export const resolveRetention = (input: RetentionInput): ResolvedRetention => {
  const nowMs = input.clock.now();
  const transient = new Date(nowMs + input.policy.transientSeconds * 1000);

  // A synthesised reply is our output, not the child's voice — but it is still
  // read aloud from their conversation, so it is transient rather than kept. No
  // configuration makes a reply persist; there is no reason for one to.
  if (input.kind === 'companion_reply') {
    return { decision: 'transient', expiresAt: transient, basis: 'synthesis' };
  }

  if (input.policy.rawAudioDays <= 0) {
    return { decision: 'transient', expiresAt: transient, basis: 'policy_zero' };
  }

  // Configuration permitting retention is not the same as this parent wanting
  // it. Both are required, and the consent is the one that can be revoked.
  if (!input.parentOptedIn) {
    return { decision: 'transient', expiresAt: transient, basis: 'no_consent' };
  }

  return {
    decision: 'retained',
    expiresAt: new Date(nowMs + input.policy.rawAudioDays * 86_400_000),
    basis: 'parent_opt_in',
  };
};

/**
 * Whether a stored object is still readable.
 *
 * Expiry is enforced on READ, not only by the sweep. A sweep that has not run
 * yet, or that failed last night, must not be the reason a child's audio is
 * still served — so an expired object is treated as absent the moment it
 * expires, and the sweep is the thing that reclaims the bytes.
 */
export const isReadable = (expiresAt: Date, clock: Clock): boolean =>
  expiresAt.getTime() > clock.now();
