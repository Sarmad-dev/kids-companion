import type { SafetyCategory } from './categories.js';
import type { Detection } from './detectors.js';
import type { EscalationReason } from './events.js';

/**
 * When a human gets involved.
 *
 * The brief for this subsystem says escalation happens "only according to
 * clearly defined rules", and the reason that matters is that both failure
 * directions are real. Escalate too readily and the review queue fills with
 * noise until nobody reads it, which is the same as having no queue. Escalate
 * too rarely and a child who told us something gets a change of subject.
 *
 * So there are exactly three rules, and they are all here.
 */

export interface EscalationInput {
  /** Categories whose resolved policy rule has `escalates` set. */
  readonly escalatingCategories: readonly SafetyCategory[];
  readonly detections: readonly Detection[];
  readonly recentBlocks: number;
  readonly repeatedAttemptThreshold: number;
}

export interface EscalationOutcome {
  readonly escalate: boolean;
  readonly reason?: EscalationReason;
  /** True when the session should end rather than merely redirect. */
  readonly endSession: boolean;
}

export const decideEscalation = (input: EscalationInput): EscalationOutcome => {
  // Rule 1 — a signal category. A child disclosing harm, expressing self-harm,
  // in distress, being asked to keep secrets, or describing grooming-adjacent
  // contact. This is the rule the other two exist to support.
  if (input.escalatingCategories.length > 0) {
    return { escalate: true, reason: 'signal_category', endSession: false };
  }

  // Rule 2 — deliberate evasion of the safety layer for prohibited content.
  // Reaching a critical rule through base64, reversal, or letter-spacing is not
  // curiosity; a child who does that has understood there is a boundary and gone
  // looking for a way past it, and a parent should know.
  const deliberateEvasion = input.detections.some((d) => d.evasion && d.severity === 'critical');
  if (deliberateEvasion) {
    return { escalate: true, reason: 'evasion_of_safety', endSession: false };
  }

  // Rule 3 — repeated stopped turns. Not because repetition is itself harmful,
  // but because a child hitting the wall five times in a quarter of an hour is
  // having an experience worth a parent seeing. The session ends warmly; letting
  // them keep going produces nothing good.
  if (input.recentBlocks + 1 >= input.repeatedAttemptThreshold) {
    return { escalate: true, reason: 'repeated_attempts', endSession: true };
  }

  return { escalate: false, endSession: false };
};
