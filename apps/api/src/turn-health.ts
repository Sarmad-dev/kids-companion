import type { AlertMonitor } from './alerts.js';

/**
 * Turning what happened in a turn into what an operator needs to know.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE GAP THIS CLOSES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Five alert conditions existed, correct and tested. Three of them —
 * `ai_provider`, `database`, and the real `safety_pipeline` — WERE CALLED BY
 * NOTHING. `reportSafetyFailure` had exactly one caller, the escalation
 * delivery failure path, so the alert named after the safety pipeline could not
 * fire when the safety pipeline failed.
 *
 * A destination with nothing to send is not alerting. This is the producer.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT COUNTS AS A SAFETY FAILURE, AND WHAT DOES NOT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A blocked turn is the pipeline WORKING. A child said something that tripped a
 * rule, the rule fired, the reply was stopped — that is the product behaving
 * correctly and must never page anybody, or the alert becomes noise the moment
 * the product is used by real children.
 *
 * The failure is `safety_unavailable`: the classifier could not be reached, so
 * the pipeline failed closed. Children are hitting a wall mid-conversation and
 * the layer that decides what reaches them is not answering. That is the one
 * condition in the system that pages on a single occurrence.
 */

/** Just enough of a turn to judge it. Deliberately not the turn itself. */
export interface TurnOutcome {
  readonly status: 'ok' | 'blocked' | 'escalated' | 'degraded' | 'ended';
  readonly degradedReason?: string | undefined;
}

export interface TurnHealthReporter {
  /** Called once per turn, whatever happened. Never throws. */
  record(outcome: TurnOutcome): void;
}

/** Provider failures, as opposed to the model simply declining to be useful. */
const PROVIDER_FAILURES = new Set(['provider_unavailable', 'provider_timeout']);

export const createTurnHealthReporter = (alerts: AlertMonitor): TurnHealthReporter => ({
  record: (outcome) => {
    const reason = outcome.degradedReason;

    if (reason === 'safety_unavailable') {
      alerts.reportSafetyFailure(
        'the safety classifier could not be reached; turns are failing closed',
      );
    } else if (outcome.status !== 'degraded') {
      /* A turn that reached a verdict — allowed, blocked or escalated — is
       * proof the pipeline is answering. It is the only positive signal this
       * condition has, and without one the alert fires once and then suppresses
       * itself for the life of the process. */
      alerts.reportSafetySuccess();
    }

    if (reason !== undefined && PROVIDER_FAILURES.has(reason)) {
      alerts.reportAiFailure();
    } else if (outcome.status === 'ok') {
      alerts.reportAiSuccess();
    }

    /* `internal_error` is deliberately neither. It is not evidence the provider
     * is down and not evidence the safety pipeline is healthy, and counting it
     * as either would make both alerts mean less. It is carried by the error
     * rate, which is what that condition is for. */
  },
});
