/**
 * `@kids/safety` — the child-AI safety subsystem.
 *
 * Independent of the conversation logic it guards: this package imports nothing
 * from `@kids/ai`, holds no conversation state, and receives generation as a
 * callback. See docs/SAFETY_SUBSYSTEM.md, and its §9 in particular for what
 * this subsystem does NOT do.
 */
export {
  ADVICE_CATEGORIES,
  ALWAYS_ESCALATE,
  ATTACK_CATEGORIES,
  BOUNDARY_CATEGORIES,
  isSafetyCategory,
  mostRestrictive,
  PROHIBITED_CATEGORIES,
  SAFETY_CATEGORIES,
  SIGNAL_CATEGORIES,
  stopsTheTurn,
  type SafetyAction,
  type SafetyCategory,
} from './categories.js';

export {
  detectBlockedTopics,
  detectInChildInput,
  detectInModelOutput,
  enforceLength,
  type Detection,
  type Severity,
} from './detectors.js';

export { decideEscalation, type EscalationInput, type EscalationOutcome } from './escalation.js';

export {
  assertNoContent,
  decisionFor,
  type EscalationReason,
  type SafetyDecision,
  type SafetyEvent,
} from './events.js';

export {
  looksObfuscated,
  normalise,
  variantsOf,
  type TextVariant,
  type VariantKind,
} from './normalise.js';

export {
  createSafetyPipeline,
  guardedTurn,
  SAFETY_STAGES,
  type CheckStage,
  type GuardedOutcome,
  type PipelineOptions,
  type SafetyPipeline,
  type SafetyStage,
  type SafetySubject,
  type SafetyVerdict,
} from './pipeline.js';

export {
  DEFAULT_POLICY,
  policyFromRows,
  resolveRule,
  type ParentalSafetySettings,
  type PolicyRule,
  type PolicyScope,
  type ResolvedRule,
  type SafetyPolicy,
} from './policy.js';

export {
  NULL_ATTEMPT_COUNTER,
  type AttemptCounter,
  type ClassificationRequest,
  type ClassificationResult,
  type SafetyClassifier,
} from './ports.js';

export {
  DEGRADED_RESPONSES,
  safeResponseFor,
  SESSION_END_RESPONSES,
  type DegradedReason,
} from './responses.js';
