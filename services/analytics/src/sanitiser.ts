import { findEvent, type AnalyticsDestination, type AnalyticsEvent } from './ports.js';

/**
 * The privacy gate.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * EVERY EVENT PASSES THROUGH HERE. THERE IS NO OTHER WAY IN.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The brief this was written against says privacy requirements override
 * analytics requirements. This file is where that is decided, once, rather than
 * argued about per call site — because the call sites are written in a hurry by
 * someone instrumenting a feature, and "just add the child id so we can debug
 * it" is a completely reasonable thought to have at that moment.
 *
 * Five rules, in the order they are applied. Each one refuses rather than
 * redacts, because a silently redacted event is an event nobody notices is
 * wrong until they build a dashboard on it.
 */

export type SanitiseOutcome =
  | { readonly ok: true; readonly event: AnalyticsEvent }
  | { readonly ok: false; readonly reason: RejectionReason; readonly detail: string };

export type RejectionReason =
  | 'unknown_event'
  | 'child_scope_external'
  | 'identifier_in_properties'
  | 'free_text_in_properties'
  | 'undeclared_property'
  | 'subject_looks_raw';

/**
 * Property values that are identifiers rather than measurements.
 *
 * Analytics properties should be countable: a number, an enum, a flag. Anything
 * that identifies a person or carries what they said belongs nowhere near a
 * product-analytics pipeline.
 */
const looksLikeIdentifier = (value: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ||
  /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value) ||
  // A phone number, loosely. Wallet rails make these common in this codebase.
  /^\+?\d[\d\s-]{8,}$/.test(value);

/**
 * Free text, which is where a transcript ends up.
 *
 * The test is deliberately blunt: an analytics property is a dimension, and a
 * dimension is short and from a small set. Anything long enough to be a
 * sentence is refused whatever it is called, because the field that eventually
 * carries a child's words will be called something innocuous like `context`.
 */
const looksLikeFreeText = (value: string): boolean =>
  value.length > 64 || /\s\S+\s\S+\s/.test(value);

/**
 * Sanitises one event for one destination.
 *
 * Returns a rejection rather than throwing: analytics must never break the
 * request that produced it, and a caller that ignores the outcome still emits
 * nothing.
 */
export const sanitiseEvent = (
  event: AnalyticsEvent,
  destination: AnalyticsDestination,
): SanitiseOutcome => {
  /* ---------------------------------------------------------------------- */
  /* 1. The event must be in the catalogue                                   */
  /* ---------------------------------------------------------------------- */
  /* An allow-list, so shipping a new event is a decision somebody makes on
   * purpose rather than a line that appeared in a pull request about something
   * else. */
  const definition = findEvent(event.name);
  if (!definition) {
    return {
      ok: false,
      reason: 'unknown_event',
      detail: `"${event.name}" is not in the event catalogue. Add it there, with a stated purpose.`,
    };
  }

  /* ---------------------------------------------------------------------- */
  /* 2. NO CHILD-SCOPED EVENT LEAVES THIS SYSTEM                             */
  /* ---------------------------------------------------------------------- */
  /* The rule this whole file exists for.
   *
   * A parent consented to their child talking to a character in our product.
   * They did not consent to a behavioural record of that child — even a
   * pseudonymous one — being accumulated by a third-party analytics vendor
   * under that vendor's retention policy.
   *
   * Aggregates about children are computed in our own database, from data we
   * already hold for the parent dashboard. Nothing per-child goes out. */
  if (!definition.destinations.includes(destination)) {
    return {
      ok: false,
      reason: definition.scope === 'child' ? 'child_scope_external' : 'unknown_event',
      detail:
        definition.scope === 'child'
          ? `"${event.name}" is child-scoped and may never be sent to an external provider.`
          : `"${event.name}" is not permitted for the ${destination} destination.`,
    };
  }

  /* ---------------------------------------------------------------------- */
  /* 3. The subject must already be a pseudonym                              */
  /* ---------------------------------------------------------------------- */
  if (event.subjectRef !== undefined && looksLikeIdentifier(event.subjectRef)) {
    return {
      ok: false,
      reason: 'subject_looks_raw',
      detail:
        'The subject is a raw identifier. Analytics subjects are salted pseudonyms — see pseudonymize() in @kids/shared.',
    };
  }

  /* ---------------------------------------------------------------------- */
  /* 4. Properties must be declared                                          */
  /* ---------------------------------------------------------------------- */
  /* Undeclared properties are refused rather than dropped. Dropping means the
   * caller believes they are measuring something they are not, and finds out
   * when a dashboard is empty. */
  for (const key of Object.keys(event.properties)) {
    if (!definition.properties.includes(key)) {
      return {
        ok: false,
        reason: 'undeclared_property',
        detail: `"${event.name}" does not declare the property "${key}".`,
      };
    }
  }

  /* ---------------------------------------------------------------------- */
  /* 5. Property VALUES must be measurements, not content                    */
  /* ---------------------------------------------------------------------- */
  /* The declaration in step 4 constrains names. This constrains what actually
   * arrives — because `reason` is a perfectly reasonable declared property, and
   * the day somebody passes a child's sentence into it is the day this catches
   * it. */
  for (const [key, value] of Object.entries(event.properties)) {
    if (typeof value !== 'string') continue;

    if (looksLikeIdentifier(value)) {
      return {
        ok: false,
        reason: 'identifier_in_properties',
        detail: `Property "${key}" holds an identifier. Analytics properties are counts, durations, and enums.`,
      };
    }

    if (looksLikeFreeText(value)) {
      return {
        ok: false,
        reason: 'free_text_in_properties',
        detail: `Property "${key}" holds free text. Free text is where a transcript ends up.`,
      };
    }
  }

  return { ok: true, event };
};

/* -------------------------------------------------------------------------- */
/* What is never collected, stated positively                                  */
/* -------------------------------------------------------------------------- */

/**
 * Practices this product does not implement.
 *
 * Written down as an exported constant rather than left implicit, so it appears
 * in the privacy documentation from one source and so a test can assert the
 * codebase does not contain them.
 *
 * Each of these is a normal, unremarkable thing to do in a consumer app, and
 * each of them is inappropriate in a product used by five-year-olds.
 */
export const NOT_COLLECTED: readonly string[] = Object.freeze([
  'Session replay or screen recording of any kind.',
  'Device fingerprinting, and no advertising identifier.',
  'Any cross-application or cross-site identity graph.',
  'A per-message or per-utterance event stream.',
  'Anything a child said, or how well they said it.',
  'Precise location. Country, at most, and only for the account.',
  'A child-scoped event sent to any third party, pseudonymous or otherwise.',
]);
