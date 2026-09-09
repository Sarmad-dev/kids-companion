/**
 * The harm taxonomy.
 *
 * One list, used by the classifier port, the deterministic detectors, the policy
 * table, and the event log — so a category cannot mean one thing in a policy row
 * and something else in a detector.
 *
 * Grouped by what the product must DO about them, because that distinction is
 * the one that gets lost: three of these are not "bad content to block", they
 * are a child telling us something.
 */

/** Prohibited content. Blocked on both sides, at every age. */
export const PROHIBITED_CATEGORIES = [
  'sexual_content',
  'violence',
  'weapons',
  'dangerous_activities',
  'drugs',
  'hate',
  'harassment',
  'abuse',
  'exploitation',
  'frightening',
] as const;

/** Boundary violations — the companion behaving in a way it must never behave. */
export const BOUNDARY_CATEGORIES = [
  'personal_data_request',
  'secret_keeping',
  'inappropriate_relationship',
  'impersonation',
] as const;

/** Advice this product is not qualified to give and must never give. */
export const ADVICE_CATEGORIES = ['unsafe_medical_advice', 'unsafe_psychological_advice'] as const;

/**
 * Signals that a child needs a human.
 *
 * NOT prohibited content. A child saying one of these is disclosing, and the
 * correct response is a warm reply plus a human in the loop — never a refusal
 * (docs/CHILD_SAFETY.md §6.1).
 */
export const SIGNAL_CATEGORIES = ['self_harm', 'disclosure_of_harm', 'distress_signal'] as const;

/** Attacks on the system. Treated as a game a child is playing, not as an attack. */
export const ATTACK_CATEGORIES = ['prompt_injection'] as const;

export const SAFETY_CATEGORIES = [
  ...PROHIBITED_CATEGORIES,
  ...BOUNDARY_CATEGORIES,
  ...ADVICE_CATEGORIES,
  ...SIGNAL_CATEGORIES,
  ...ATTACK_CATEGORIES,
] as const;

export type SafetyCategory = (typeof SAFETY_CATEGORIES)[number];

export const isSafetyCategory = (value: string): value is SafetyCategory =>
  (SAFETY_CATEGORIES as readonly string[]).includes(value);

/**
 * Categories that route to a human rather than merely stopping a turn.
 *
 * Kept as data here AND as `escalates` in `safety_policies`. The table is
 * authoritative at runtime; this is the fallback when the policy store is
 * unreachable, because failing to escalate a disclosure because a database was
 * slow is not an acceptable failure mode.
 */
export const ALWAYS_ESCALATE: ReadonlySet<SafetyCategory> = new Set([
  'self_harm',
  'disclosure_of_harm',
  'distress_signal',
  'exploitation',
  'secret_keeping',
  'inappropriate_relationship',
]);

export type SafetyAction = 'allow' | 'observe' | 'redirect' | 'block' | 'end_session';

/** Ordered by severity, so the most restrictive action across findings wins. */
const ACTION_RANK: Readonly<Record<SafetyAction, number>> = Object.freeze({
  allow: 0,
  observe: 1,
  redirect: 2,
  block: 3,
  end_session: 4,
});

export const mostRestrictive = (actions: readonly SafetyAction[]): SafetyAction =>
  actions.reduce<SafetyAction>(
    (worst, action) => (ACTION_RANK[action] > ACTION_RANK[worst] ? action : worst),
    'allow',
  );

export const stopsTheTurn = (action: SafetyAction): boolean =>
  action === 'redirect' || action === 'block' || action === 'end_session';
