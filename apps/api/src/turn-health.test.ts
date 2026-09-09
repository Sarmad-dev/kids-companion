import { describe, expect, it } from 'vitest';

import type { AlertMonitor } from './alerts.js';
import { createTurnHealthReporter, type TurnOutcome } from './turn-health.js';

/**
 * What a turn tells an operator.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE DISTINCTION THIS FILE EXISTS TO PROTECT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A BLOCKED TURN IS THE PIPELINE WORKING. A child said something that tripped
 * a rule, the rule fired, the reply was stopped. That is the product behaving
 * exactly as designed, and if it paged anybody the alert would become noise the
 * first day real children used it — and then it would be muted, and then the
 * real failure would arrive to a muted channel.
 *
 * The failure is `safety_unavailable`: the classifier could not be reached and
 * the pipeline failed closed. Children are hitting a wall mid-conversation and
 * the layer deciding what reaches them is not answering.
 *
 * Getting these two the wrong way round is the single most expensive mistake
 * available in this file, in both directions.
 */

const spyMonitor = (): {
  monitor: AlertMonitor;
  calls: string[];
} => {
  const calls: string[] = [];
  const monitor: AlertMonitor = {
    evaluate: () => [],
    active: () => [],
    reportSafetyFailure: (detail) => calls.push(`safety:fail:${detail}`),
    reportSafetySuccess: () => calls.push('safety:ok'),
    reportAiFailure: () => calls.push('ai:fail'),
    reportAiSuccess: () => calls.push('ai:ok'),
    reportDatabaseFailure: (detail) => calls.push(`db:fail:${detail}`),
    reportDatabaseSuccess: () => calls.push('db:ok'),
  };
  return { monitor, calls };
};

const report = (outcome: TurnOutcome): string[] => {
  const { monitor, calls } = spyMonitor();
  createTurnHealthReporter(monitor).record(outcome);
  return calls;
};

describe('what a turn reports', () => {
  describe('the safety pipeline', () => {
    it('pages when the classifier could not be reached', () => {
      // The one condition in the system that fires on a single occurrence.
      const calls = report({ status: 'degraded', degradedReason: 'safety_unavailable' });

      expect(calls.some((call) => call.startsWith('safety:fail'))).toBe(true);
      expect(calls).not.toContain('safety:ok');
    });

    it('does NOT page when a turn was blocked', () => {
      /* ═══════════════════════════════════════════════════════════════════
       * THE MOST IMPORTANT ASSERTION IN THIS FILE.
       * ═══════════════════════════════════════════════════════════════════
       *
       * Blocking is the product working. An alert that fires every time the
       * safety layer does its job is an alert that gets muted, and a muted
       * channel is where the real failure will arrive.
       */
      expect(report({ status: 'blocked' })).toContain('safety:ok');
      expect(report({ status: 'blocked' }).some((c) => c.startsWith('safety:fail'))).toBe(false);
    });

    it('does not page for an escalation either', () => {
      // An escalation is the pipeline noticing something serious — the most
      // successful it ever gets. Its own delivery has a separate alert path.
      expect(report({ status: 'escalated' })).toContain('safety:ok');
    });

    it('treats a completed turn as proof the pipeline is answering', () => {
      // The only positive signal this condition has. Without it the alert fires
      // once and then suppresses itself for the life of the process.
      expect(report({ status: 'ok' })).toContain('safety:ok');
    });

    it('says nothing either way about an internal error', () => {
      /* Not evidence the pipeline is healthy and not evidence it is broken.
       * Counting it as either makes both alerts mean less; it is carried by the
       * error-rate condition, which is what that one is for. */
      const calls = report({ status: 'degraded', degradedReason: 'internal_error' });

      expect(calls).not.toContain('safety:ok');
      expect(calls.some((call) => call.startsWith('safety:fail'))).toBe(false);
    });
  });

  describe('the AI provider', () => {
    it('reports a failure when the provider was unavailable or timed out', () => {
      for (const reason of ['provider_unavailable', 'provider_timeout']) {
        expect(report({ status: 'degraded', degradedReason: reason }), reason).toContain('ai:fail');
      }
    });

    it('reports a success on a completed turn, which clears it', () => {
      // The provider alert fires on consecutive failures, so a single good turn
      // resetting the count is what stops one blip from creeping towards a page.
      expect(report({ status: 'ok' })).toContain('ai:ok');
    });

    it('does not blame the provider for a quota or a safety block', () => {
      /* Running out of turns for the day is the product working, and a blocked
       * turn is the safety layer working. Neither says anything about whether
       * the provider is up. */
      expect(report({ status: 'ended', degradedReason: 'quota_exhausted' })).not.toContain(
        'ai:fail',
      );
      expect(report({ status: 'blocked' })).not.toContain('ai:fail');
    });
  });

  it('carries no conversation content into an alert', () => {
    /* An alert body reaches whatever the operator configured — a chat channel,
     * a ticketing system. The detail must describe the fault, never the turn. */
    const calls = report({ status: 'degraded', degradedReason: 'safety_unavailable' });
    const detail = calls.find((call) => call.startsWith('safety:fail')) ?? '';

    for (const forbidden of ['transcript', 'utterance', 'child', 'said']) {
      expect(detail.toLowerCase(), forbidden).not.toContain(forbidden);
    }
  });
});
