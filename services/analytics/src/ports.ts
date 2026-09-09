import type { IsoTimestamp } from '@kids/types';

/**
 * Analytics.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * PRIVACY OVERRIDES ANALYTICS. THAT IS NOT A SLOGAN HERE — IT IS THE TYPE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The single design decision in this file is that there are TWO destinations,
 * and they are not equally trusted:
 *
 *   INTERNAL   our own `analytics_events` table. Pseudonymous, retained for a
 *              bounded period, covered by our own privacy policy, deletable
 *              when a parent deletes their account.
 *
 *   EXTERNAL   a third-party product-analytics vendor. Covered by THEIR policy,
 *              retained on THEIR schedule, and not something a parent agreed to
 *              when they signed their child up to talk to a cartoon dog.
 *
 * **No event with a child dimension may ever go to an external destination.**
 * Not pseudonymously, not aggregated per child, not at all. That is enforced by
 * `sanitiseEvent` rejecting it, and it is the rule that makes "do not implement
 * invasive tracking of children" structural rather than aspirational.
 *
 * What a third party may receive is the parent-facing commercial funnel: an
 * account was created, a plan was viewed, a subscription started. Those are
 * facts about a customer, and they are what product analytics is actually for.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT IS DELIBERATELY IMPOSSIBLE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * No session replay. No device fingerprinting. No advertising identifier. No
 * cross-application identity graph. No per-message event stream. No event
 * carrying anything a child said, how well they said it, or when they were
 * awake.
 *
 * Product questions about children are answered from aggregates we already
 * compute for the parent dashboard — counts and durations over `learning_daily`
 * — and never by streaming a behavioural record of a five-year-old to a vendor.
 */

/* -------------------------------------------------------------------------- */
/* Destinations                                                                */
/* -------------------------------------------------------------------------- */

export const ANALYTICS_DESTINATIONS = ['internal', 'external'] as const;
export type AnalyticsDestination = (typeof ANALYTICS_DESTINATIONS)[number];

/* -------------------------------------------------------------------------- */
/* The event catalogue                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Every event this product may record, and where it may go.
 *
 * An allow-list, not a convention. An event not named here is refused, so
 * shipping a new one is a decision somebody makes on purpose with this comment
 * in front of them.
 *
 * `scope` is the load-bearing field:
 *
 *   `account` — about a parent and their commercial relationship with us.
 *   `child`   — about a child's use of the product. **Internal only, always.**
 *   `system`  — about the software, with no person attached.
 */
export interface EventDefinition {
  readonly name: string;
  readonly scope: 'account' | 'child' | 'system';
  readonly destinations: readonly AnalyticsDestination[];
  /** Why this is collected. An event nobody can justify should not exist. */
  readonly purpose: string;
  /** Property names this event may carry. Anything else is dropped. */
  readonly properties: readonly string[];
}

const account = (
  name: string,
  purpose: string,
  properties: readonly string[],
): EventDefinition => ({
  name,
  scope: 'account',
  // The commercial funnel. A parent is a customer, and these are facts about
  // the customer relationship rather than about their child.
  destinations: ['internal', 'external'],
  purpose,
  properties,
});

const child = (name: string, purpose: string, properties: readonly string[]): EventDefinition => ({
  name,
  scope: 'child',
  // INTERNAL ONLY. Never negotiable, and the sanitiser enforces it.
  destinations: ['internal'],
  purpose,
  properties,
});

const system = (name: string, purpose: string, properties: readonly string[]): EventDefinition => ({
  name,
  scope: 'system',
  destinations: ['internal'],
  purpose,
  properties,
});

export const EVENT_CATALOGUE: readonly EventDefinition[] = Object.freeze([
  /* ---- Activation, the parent's first ten minutes ---- */
  account('account.registered', 'Activation funnel: how many sign-ups become families.', [
    'platform',
    'country',
  ]),
  account('account.child_added', 'Activation: adding a child is the first real step.', [
    'child_count',
  ]),
  account('account.activated', 'Activation completed: a child has had a first conversation.', [
    'minutes_since_registration',
  ]),

  /* ---- Subscription, conversion, churn ---- */
  account('subscription.plans_viewed', 'Conversion funnel: did they reach the plans at all?', [
    'source',
  ]),
  account('subscription.checkout_started', 'Conversion: intent to subscribe.', ['plan', 'rail']),
  account('subscription.started', 'Conversion completed.', ['plan', 'rail', 'trial']),
  account('subscription.cancelled', 'Churn, with the parent’s own stated reason where given.', [
    'plan',
    'reason',
    'days_subscribed',
  ]),
  account('subscription.expired', 'Involuntary churn — payment failed rather than a decision.', [
    'plan',
    'days_subscribed',
  ]),

  /* ---- Feature adoption, at the account level ---- */
  account('feature.used', 'Which parts of the product a family actually reaches.', [
    'feature',
    'surface',
  ]),
  account('dashboard.viewed', 'Whether parents look at the dashboard we built for them.', ['area']),

  /* ---- Child scope. INTERNAL ONLY, and counts rather than content. ---- */
  child('conversation.completed', 'Conversation completion rate and typical length.', [
    'turn_count',
    'duration_seconds',
    'ended_by',
    'age_group',
  ]),
  child('conversation.abandoned', 'The other half of completion. A short chat is not a failure.', [
    'turn_count',
    'duration_seconds',
    'age_group',
  ]),
  child('practice.completed', 'Whether speech practice is finished or given up on.', [
    'attempt_count',
    'age_group',
  ]),

  /* ---- System ---- */
  system('provider.degraded', 'A dependency failing, for correlating with user-visible errors.', [
    'provider',
    'reason',
  ]),
  system('safety.intervened', 'How often the safety layer acts. COUNTS ONLY — never content.', [
    'layer',
    'category_group',
  ]),
]);

const CATALOGUE_BY_NAME = new Map(EVENT_CATALOGUE.map((event) => [event.name, event]));

export const findEvent = (name: string): EventDefinition | undefined => CATALOGUE_BY_NAME.get(name);

/* -------------------------------------------------------------------------- */
/* Events                                                                      */
/* -------------------------------------------------------------------------- */

export interface AnalyticsEvent {
  readonly name: string;
  /**
   * A pseudonym, never a raw id.
   *
   * Rotating salt, so the corpus stops being linkable after the salt turns
   * over. `undefined` for system events, which have no subject.
   */
  readonly subjectRef?: string | undefined;
  /** Counts, durations, enums, flags. Nothing free-text, nothing identifying. */
  readonly properties: Readonly<Record<string, string | number | boolean>>;
  readonly occurredAt: IsoTimestamp;
  readonly platform?: 'ios' | 'android' | 'web' | undefined;
  readonly appVersion?: string | undefined;
}

/* -------------------------------------------------------------------------- */
/* The provider                                                                */
/* -------------------------------------------------------------------------- */

export interface AnalyticsProvider {
  readonly name: string;
  readonly destination: AnalyticsDestination;

  /**
   * Records an event.
   *
   * Never throws and never blocks the caller's work. Analytics failing is not a
   * reason a child cannot talk, and an await on a vendor's endpoint in a request
   * path is a vendor outage becoming our outage.
   */
  record(event: AnalyticsEvent): void;

  /** Flushes anything buffered. Called on shutdown, not per request. */
  flush(): Promise<void>;
}
