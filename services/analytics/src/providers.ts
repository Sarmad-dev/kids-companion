import type { AnalyticsDestination, AnalyticsEvent, AnalyticsProvider } from './ports.js';
import { sanitiseEvent, type SanitiseOutcome } from './sanitiser.js';

/**
 * Analytics providers.
 *
 * Three, and the default is the one that does nothing.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ANALYTICS IS OFF UNTIL SOMEBODY TURNS IT ON.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `ANALYTICS_ENABLED` defaults to false, and with it off the no-op provider is
 * what runs. That is the right default for a children's product: the burden is
 * on the person who wants the data to justify collecting it, not on the person
 * who would rather not.
 */

/** Every provider runs its events through the gate. No exceptions, no bypass. */
const guarded = (
  destination: AnalyticsDestination,
  deliver: (event: AnalyticsEvent) => void,
  onRejected?: (outcome: Extract<SanitiseOutcome, { ok: false }>) => void,
) => ({
  record: (event: AnalyticsEvent): void => {
    const outcome = sanitiseEvent(event, destination);
    if (!outcome.ok) {
      onRejected?.(outcome);
      return;
    }
    deliver(outcome.event);
  },
});

/**
 * The default. Records nothing, and says nothing.
 *
 * Not a stub to be replaced — the shipped behaviour when analytics is disabled,
 * which is most of the time and all of local development.
 */
export const createNoopAnalytics = (): AnalyticsProvider => ({
  name: 'noop',
  destination: 'internal',
  record: () => {
    // Deliberately empty.
  },
  flush: () => Promise.resolve(),
});

/**
 * Writes to our own `analytics_events` table.
 *
 * Internal by construction, so child-scoped events are permitted — and they
 * stay here, inside a database covered by our own retention sweep and deleted
 * with the account.
 */
export const createInternalAnalytics = (options: {
  readonly write: (event: AnalyticsEvent) => void;
  readonly onRejected?: (outcome: Extract<SanitiseOutcome, { ok: false }>) => void;
}): AnalyticsProvider => {
  const gate = guarded('internal', options.write, options.onRejected);

  return {
    name: 'internal',
    destination: 'internal',
    record: gate.record,
    flush: () => Promise.resolve(),
  };
};

/**
 * Holds events in memory. For tests, and for a developer who wants to see what
 * would have been sent without sending it.
 */
export const createMemoryAnalytics = (
  destination: AnalyticsDestination = 'internal',
): AnalyticsProvider & {
  readonly events: readonly AnalyticsEvent[];
  readonly rejected: readonly Extract<SanitiseOutcome, { ok: false }>[];
} => {
  const events: AnalyticsEvent[] = [];
  const rejected: Extract<SanitiseOutcome, { ok: false }>[] = [];

  const gate = guarded(
    destination,
    (event) => events.push(event),
    (outcome) => rejected.push(outcome),
  );

  return {
    name: 'memory',
    destination,
    record: gate.record,
    flush: () => Promise.resolve(),
    get events() {
      return events;
    },
    get rejected() {
      return rejected;
    },
  };
};

/**
 * Fans one event out to several providers.
 *
 * Each destination re-runs the gate independently, which is the point: the same
 * `conversation.completed` is accepted by the internal provider and refused by
 * an external one, from a single call at the call site. The caller does not
 * have to know the rule, and cannot get it wrong.
 */
export const createFanOutAnalytics = (
  providers: readonly AnalyticsProvider[],
): AnalyticsProvider => ({
  name: `fanout(${providers.map((provider) => provider.name).join(',')})`,
  destination: 'internal',
  record: (event) => {
    for (const provider of providers) {
      try {
        provider.record(event);
      } catch {
        // A provider that throws must not take down the request that produced
        // the event, nor stop the other providers. Analytics is never load
        // bearing.
      }
    }
  },
  flush: async () => {
    await Promise.allSettled(providers.map(async (provider) => await provider.flush()));
  },
});
