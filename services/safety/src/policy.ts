import type { AgeGroup } from '@kids/types';

import {
  ALWAYS_ESCALATE,
  isSafetyCategory,
  type SafetyAction,
  type SafetyCategory,
} from './categories.js';

/**
 * Safety policy resolution.
 *
 * The policy store is a table (`safety_policies`), so tightening a rule after a
 * real-world miss is an UPDATE rather than a release. This module turns rows
 * into a resolved decision for one category, one age group, and one direction.
 *
 * `DEFAULT_POLICY` is a compiled-in fallback used when the store is unreachable.
 * It is deliberately at least as strict as the seeded table: a database problem
 * must never widen what a child can be shown.
 */

export type PolicyScope = 'child_input' | 'model_output';

export interface PolicyRule {
  readonly category: SafetyCategory;
  readonly ageGroup: AgeGroup | '*';
  readonly appliesTo: PolicyScope | 'both';
  readonly action: SafetyAction;
  readonly minConfidence: number;
  readonly escalates: boolean;
  readonly policyVersion: string;
}

export interface ParentalSafetySettings {
  /** Parent-configured topics, on top of the universal categories. */
  readonly blockedTopics: readonly string[];
  /** When false, the companion must not tell stories. */
  readonly storytellingEnabled: boolean;
  readonly roleplayEnabled: boolean;
}

export interface SafetyPolicy {
  readonly version: string;
  readonly rules: readonly PolicyRule[];
  /**
   * Blocked turns within the window before the session is ended.
   *
   * Repeated probing is a signal in itself: a child testing a boundary five
   * times in ten minutes is having a different experience from one who
   * stumbled into a redirect once. Ending the session warmly is kinder than
   * letting them keep hitting a wall, and it surfaces the pattern to a parent.
   */
  readonly repeatedAttemptThreshold: number;
  readonly repeatedAttemptWindowMinutes: number;
}

/**
 * The compiled-in fallback.
 *
 * Every category present, and every action at least as strict as the seeded
 * table. Used when `safety_policies` cannot be read — which must degrade toward
 * caution, never away from it.
 */
export const DEFAULT_POLICY: SafetyPolicy = Object.freeze({
  version: 'builtin-2026-08-01',
  repeatedAttemptThreshold: 5,
  repeatedAttemptWindowMinutes: 15,
  rules: Object.freeze([
    rule('sexual_content', 'both', 'block', 0.3),
    rule('violence', 'both', 'block', 0.5),
    rule('weapons', 'both', 'block', 0.5),
    rule('dangerous_activities', 'both', 'block', 0.4),
    rule('drugs', 'both', 'block', 0.5),
    rule('hate', 'both', 'block', 0.4),
    rule('harassment', 'both', 'block', 0.5),
    rule('abuse', 'model_output', 'block', 0.3),
    rule('exploitation', 'both', 'block', 0.2, true),
    rule('frightening', 'model_output', 'block', 0.3),
    rule('personal_data_request', 'both', 'block', 0.4),
    rule('secret_keeping', 'both', 'block', 0.2, true),
    rule('inappropriate_relationship', 'both', 'block', 0.3, true),
    rule('impersonation', 'model_output', 'block', 0.3),
    rule('unsafe_medical_advice', 'model_output', 'block', 0.4),
    rule('unsafe_psychological_advice', 'model_output', 'block', 0.4),
    rule('self_harm', 'both', 'redirect', 0.3, true),
    rule('disclosure_of_harm', 'child_input', 'redirect', 0.2, true),
    rule('distress_signal', 'child_input', 'redirect', 0.4, true),
    rule('prompt_injection', 'child_input', 'redirect', 0.5),
  ] as const),
});

function rule(
  category: SafetyCategory,
  appliesTo: PolicyScope | 'both',
  action: SafetyAction,
  minConfidence: number,
  escalates = false,
): PolicyRule {
  return {
    category,
    ageGroup: '*',
    appliesTo,
    action,
    minConfidence,
    escalates,
    policyVersion: 'builtin-2026-08-01',
  };
}

/** Builds a policy from database rows, discarding anything unrecognised. */
export const policyFromRows = (
  rows: readonly {
    category: string;
    age_group: string;
    applies_to: string;
    action: string;
    min_confidence: number;
    escalates: boolean;
    policy_version: string;
  }[],
  overrides: Partial<
    Pick<SafetyPolicy, 'repeatedAttemptThreshold' | 'repeatedAttemptWindowMinutes'>
  > = {},
): SafetyPolicy => {
  const rules = rows
    .filter((r) => isSafetyCategory(r.category))
    .map((r): PolicyRule => ({
      category: r.category as SafetyCategory,
      ageGroup: (r.age_group === '*' ? '*' : r.age_group) as AgeGroup | '*',
      appliesTo: r.applies_to as PolicyScope | 'both',
      action: r.action as SafetyAction,
      minConfidence: r.min_confidence,
      escalates: r.escalates,
      policyVersion: r.policy_version,
    }));

  // An empty or unusable policy store falls back rather than allowing
  // everything. This is the single most important line in the module.
  if (rules.length === 0) return DEFAULT_POLICY;

  return {
    version: rules[0]?.policyVersion ?? DEFAULT_POLICY.version,
    rules,
    repeatedAttemptThreshold:
      overrides.repeatedAttemptThreshold ?? DEFAULT_POLICY.repeatedAttemptThreshold,
    repeatedAttemptWindowMinutes:
      overrides.repeatedAttemptWindowMinutes ?? DEFAULT_POLICY.repeatedAttemptWindowMinutes,
  };
};

export interface ResolvedRule {
  readonly action: SafetyAction;
  readonly minConfidence: number;
  readonly escalates: boolean;
  readonly policyVersion: string;
}

/**
 * The rule in force for one category, age group, and direction.
 *
 * Most specific wins: an age-specific rule overrides the `'*'` rule, and a
 * direction-specific rule overrides `'both'`. An unknown category falls back to
 * `block`, because a category the policy has not heard of is not a category to
 * wave through.
 */
export const resolveRule = (
  policy: SafetyPolicy,
  category: SafetyCategory,
  ageGroup: AgeGroup,
  scope: PolicyScope,
): ResolvedRule => {
  const candidates = policy.rules.filter(
    (r) =>
      r.category === category &&
      (r.ageGroup === '*' || r.ageGroup === ageGroup) &&
      (r.appliesTo === 'both' || r.appliesTo === scope),
  );

  if (candidates.length === 0) {
    return {
      action: 'block',
      minConfidence: 0,
      escalates: ALWAYS_ESCALATE.has(category),
      policyVersion: policy.version,
    };
  }

  const best = candidates.reduce((chosen, candidate) => {
    const chosenScore = (chosen.ageGroup === '*' ? 0 : 2) + (chosen.appliesTo === 'both' ? 0 : 1);
    const candidateScore =
      (candidate.ageGroup === '*' ? 0 : 2) + (candidate.appliesTo === 'both' ? 0 : 1);
    return candidateScore > chosenScore ? candidate : chosen;
  });

  return {
    action: best.action,
    minConfidence: best.minConfidence,
    // The compiled-in escalation set is a floor, not a default: a policy row
    // that forgets to escalate a disclosure does not stop it escalating.
    escalates: best.escalates || ALWAYS_ESCALATE.has(category),
    policyVersion: best.policyVersion,
  };
};
