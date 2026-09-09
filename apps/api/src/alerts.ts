import { TECHNICAL_METRICS, type MetricsRegistry } from '@kids/analytics';
import type { Clock, Logger } from '@kids/shared';

/**
 * Alerts for critical backend failures.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * FIVE CONDITIONS. NOT FIFTY.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * An alert that fires often is an alert nobody reads, and a paging system
 * nobody reads is worse than none — it converts a real outage into one more
 * notification somebody swipes away at 2 a.m.
 *
 * So the list is short, and every entry answers the same question: **would a
 * person have to get out of bed for this?** Anything that would not is a
 * dashboard line, not an alert.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE SAFETY ALERT IS DIFFERENT, AND IT IS THE ONE THAT MATTERS MOST.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every other condition here is about the product being down. `safety_pipeline`
 * is about the product being UP and unsafe, which is worse: children are
 * talking and the layer that checks what reaches them is not working. It fires
 * on the first occurrence rather than on a rate, because one is enough.
 */

export const ALERT_CONDITIONS = [
  'safety_pipeline',
  'error_rate',
  'latency',
  'database',
  'ai_provider',
] as const;
export type AlertCondition = (typeof ALERT_CONDITIONS)[number];

export type AlertSeverity = 'critical' | 'warning';

export interface Alert {
  readonly condition: AlertCondition;
  readonly severity: AlertSeverity;
  /** What is wrong, in a sentence somebody woken up can act on. */
  readonly summary: string;
  /** The measurement that tripped it, so nobody has to go and find it. */
  readonly observed: Readonly<Record<string, number | string>>;
  readonly firstSeenAt: string;
}

/**
 * An alert that stopped being true.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * A PAGE WITHOUT AN ALL-CLEAR IS HALF AN ALERT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Conditions used to clear in silence, so somebody woken at 2 a.m. had no way
 * to learn it had recovered except by going and looking. That was survivable
 * while the only destination was a log file nobody read. It is not survivable
 * now that one reaches a person.
 */
export interface AlertResolution {
  readonly condition: AlertCondition;
  readonly summary: string;
  readonly firstSeenAt: string;
  readonly resolvedAt: string;
}

export interface AlertThresholds {
  /** Fraction of requests returning 5xx, over the sample window. */
  readonly errorRate: number;
  /** p99 request latency, milliseconds. */
  readonly latencyP99Ms: number;
  /** Minimum requests before a rate means anything. */
  readonly minimumSample: number;
  /** Consecutive AI provider failures. */
  readonly aiFailures: number;
  /**
   * How long a condition with no positive recovery signal stays firing after it
   * was last reported.
   *
   * `safety_pipeline` and `database` have nothing that says "it is working
   * again" — they are only ever told about failures. Without this they fire
   * once and then suppress themselves for the life of the process, which is
   * how the most important alert in the system silently stops working after its
   * first firing.
   */
  readonly reArmAfterMs: number;
}

export const DEFAULT_THRESHOLDS: AlertThresholds = Object.freeze({
  // 5% of requests failing is well past "a bad deploy" and into "customers
  // cannot use the product".
  errorRate: 0.05,
  // Ten seconds at p99. A child asked a question and the character went silent.
  latencyP99Ms: 10_000,
  // Below this, a rate is noise: two errors out of three requests at 4 a.m. is
  // not an outage, it is a health check and a crawler.
  minimumSample: 50,
  aiFailures: 5,
  // Long enough that a flapping dependency does not page repeatedly, short
  // enough that a second incident an hour later is not swallowed by the first.
  reArmAfterMs: 15 * 60_000,
});

export interface AlertSink {
  /**
   * Delivers an alert.
   *
   * Never throws, and never blocks the caller — an alerting system that can
   * fail the request it is alerting about has made the outage worse.
   */
  deliver(alert: Alert): void;
  /** Says it recovered. Same rules: never throws, never blocks. */
  resolve(resolution: AlertResolution): void;
}

/**
 * The default sink: a structured log line at `fatal`.
 *
 * Deliberately not an HTTP call to a pager by default. Every deployment already
 * ships logs somewhere, `fatal` is already routed, and adding an outbound
 * dependency to the alerting path means the alert fails when the network does —
 * which is exactly when it is needed.
 *
 * A webhook sink is available for deployments that want one, and it wraps this
 * rather than replacing it.
 */
export const createLogAlertSink = (logger: Logger): AlertSink => ({
  deliver: (alert) => {
    logger.fatal(
      {
        alert: alert.condition,
        severity: alert.severity,
        observed: alert.observed,
        firstSeenAt: alert.firstSeenAt,
      },
      alert.summary,
    );
  },
  // `warn`, not `fatal`. A recovery that pages at the same level as an outage
  // teaches people that the level means nothing.
  resolve: (resolution) => {
    logger.warn(
      {
        alert: resolution.condition,
        firstSeenAt: resolution.firstSeenAt,
        resolvedAt: resolution.resolvedAt,
      },
      `RESOLVED: ${resolution.summary}`,
    );
  },
});

/**
 * How the body is shaped.
 *
 * `generic` is a plain JSON object and is what an Alertmanager receiver, an
 * Opsgenie custom webhook, or anything written in-house should be pointed at.
 *
 * `slack` is the incoming-webhook shape — a `text` field — which is also what
 * Mattermost and several others accept. It exists because the difference
 * between "alerts have a destination" and "a person sees an alert" is usually
 * one field, and requiring somebody to build a receiver first is how a
 * destination stays unconfigured.
 */
export type AlertWebhookFormat = 'generic' | 'slack';

const SEVERITY_ICON: Readonly<Record<AlertSeverity, string>> = Object.freeze({
  critical: '🚨',
  warning: '⚠️',
});

/** The line a person reads on their phone. Facts first, no preamble. */
const slackText = (alert: Alert): string => {
  const observed = Object.entries(alert.observed)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(' ');
  return [
    `${SEVERITY_ICON[alert.severity]} *${alert.condition}* (${alert.severity})`,
    alert.summary,
    observed,
  ].join('\n');
};

export const alertWebhookBody = (alert: Alert, format: AlertWebhookFormat): string =>
  format === 'slack'
    ? JSON.stringify({ text: slackText(alert) })
    : JSON.stringify({
        event: 'alert.firing',
        condition: alert.condition,
        severity: alert.severity,
        summary: alert.summary,
        observed: alert.observed,
        firstSeenAt: alert.firstSeenAt,
      });

export const alertResolutionBody = (
  resolution: AlertResolution,
  format: AlertWebhookFormat,
): string =>
  format === 'slack'
    ? JSON.stringify({
        text: `✅ *${resolution.condition}* recovered
${resolution.summary}
firing since ${resolution.firstSeenAt}`,
      })
    : JSON.stringify({
        event: 'alert.resolved',
        condition: resolution.condition,
        summary: resolution.summary,
        firstSeenAt: resolution.firstSeenAt,
        resolvedAt: resolution.resolvedAt,
      });

/** Posts a body somewhere. Injected so the sink is testable without a network. */
export type AlertPoster = (body: string) => Promise<void>;

/**
 * The real transport.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE URL IS A SECRET AND MUST NEVER BE LOGGED
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A Slack incoming-webhook URL is a bearer credential in path form: anyone
 * holding it can post into the channel. So it is captured in this closure and
 * never appears in a log line, an error message, or an alert body. Errors are
 * reduced to a short reason before they go anywhere near the logger, because a
 * fetch failure can carry the host — and sometimes the whole request — in its
 * message.
 *
 * Three attempts, briefly spaced. Not more: the log line is the reliable record
 * and an alerting path that retries for a minute is one that delays the next
 * alert behind it.
 */
export const createAlertWebhookTransport = (options: {
  readonly url: string;
  readonly timeoutMs?: number;
  readonly attempts?: number;
  readonly fetchImpl?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
}): AlertPoster => {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const attempts = options.attempts ?? 3;
  const doFetch = options.fetchImpl ?? fetch;
  const sleep =
    options.sleep ??
    (async (ms: number) =>
      await new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }));

  return async (body: string): Promise<void> => {
    let lastReason = 'unknown';

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort();
      }, timeoutMs);

      try {
        const response = await doFetch(options.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
          signal: controller.signal,
        });
        if (response.ok) return;
        lastReason = `endpoint returned ${String(response.status)}`;
        // 4xx other than 429 will not become true by trying again.
        if (response.status < 500 && response.status !== 429) break;
      } catch {
        // Deliberately not reading the error: it can carry the URL.
        lastReason = 'request failed or timed out';
      } finally {
        clearTimeout(timer);
      }

      if (attempt < attempts) await sleep(250 * attempt);
    }

    throw new Error(`alert webhook: ${lastReason}`);
  };
};

/**
 * Adds an outbound webhook, keeping the log line.
 *
 * The log is the reliable path; the webhook is the fast one. If the webhook
 * fails the alert is still recorded, which is the whole reason it is layered
 * this way rather than substituted.
 */
export const createWebhookAlertSink = (
  base: AlertSink,
  options: {
    readonly post: AlertPoster;
    readonly logger: Logger;
    readonly format?: AlertWebhookFormat;
  },
): AlertSink => {
  const format = options.format ?? 'generic';

  const send = (body: string, what: string): void => {
    void options.post(body).catch((error: unknown) => {
      // Swallowed on purpose. The alert is already in the log, and an unhandled
      // rejection from the alerting path would be its own incident. The message
      // is the transport's own short reason, which never contains the URL.
      options.logger.error(
        { reason: error instanceof Error ? error.message : 'unknown', delivering: what },
        'alert webhook failed — the alert is in the log only',
      );
    });
  };

  return {
    deliver: (alert) => {
      base.deliver(alert);
      send(alertWebhookBody(alert, format), alert.condition);
    },
    resolve: (resolution) => {
      base.resolve(resolution);
      send(alertResolutionBody(resolution, format), `${resolution.condition}:resolved`);
    },
  };
};

/* -------------------------------------------------------------------------- */
/* Evaluation                                                                  */
/* -------------------------------------------------------------------------- */

export interface AlertMonitor {
  /** Checks every condition. Called on a timer, and by the health endpoint. */
  evaluate(): readonly Alert[];
  /** Reports a safety-pipeline failure. Fires on the first one. */
  reportSafetyFailure(detail: string): void;
  /** Reports a turn that went through the safety pipeline intact. */
  reportSafetySuccess(): void;
  /** Reports an AI provider failure. Fires after several in a row. */
  reportAiFailure(): void;
  reportAiSuccess(): void;
  /** Reports a database connectivity failure. */
  reportDatabaseFailure(detail: string): void;
  /** Reports that the database answered. Clears the database alert. */
  reportDatabaseSuccess(): void;
  /** Alerts currently firing, for the health endpoint. */
  active(): readonly Alert[];
}

export const createAlertMonitor = (options: {
  readonly registry: MetricsRegistry;
  readonly sink: AlertSink;
  readonly clock: Clock;
  readonly thresholds?: AlertThresholds;
}): AlertMonitor => {
  const thresholds = options.thresholds ?? DEFAULT_THRESHOLDS;
  const { registry, sink, clock } = options;

  const firing = new Map<AlertCondition, Alert>();
  /** When each firing condition was last actually observed to be true. */
  const lastSeen = new Map<AlertCondition, number>();
  let consecutiveAiFailures = 0;

  /**
   * Raises an alert, once.
   *
   * ═══════════════════════════════════════════════════════════════════════
   * AN ALERT THAT REPEATS EVERY MINUTE IS AN ALERT THAT GETS MUTED.
   * ═══════════════════════════════════════════════════════════════════════
   *
   * A condition that is already firing is not re-delivered. It clears when the
   * measurement recovers, and only then can it fire again.
   */
  const raise = (
    condition: AlertCondition,
    severity: AlertSeverity,
    summary: string,
    observed: Readonly<Record<string, number | string>>,
  ): Alert | undefined => {
    lastSeen.set(condition, clock.now());

    const existing = firing.get(condition);
    if (existing) return undefined;

    const alert: Alert = {
      condition,
      severity,
      summary,
      observed,
      firstSeenAt: clock.nowIso(),
    };
    firing.set(condition, alert);
    sink.deliver(alert);
    return alert;
  };

  /** Stops a condition firing, and says so. */
  const clear = (condition: AlertCondition): void => {
    const alert = firing.get(condition);
    firing.delete(condition);
    lastSeen.delete(condition);
    if (!alert) return;

    sink.resolve({
      condition,
      summary: alert.summary,
      firstSeenAt: alert.firstSeenAt,
      resolvedAt: clock.nowIso(),
    });
  };

  /**
   * Clears conditions that have gone quiet.
   *
   * ═══════════════════════════════════════════════════════════════════════
   * WITHOUT THIS, THE SAFETY ALERT WORKS EXACTLY ONCE PER PROCESS.
   * ═══════════════════════════════════════════════════════════════════════
   *
   * `safety_pipeline` and `database` are only ever told about failures, so
   * nothing was able to clear them — and a condition that is already firing is
   * not re-delivered, by design, so that a real outage does not page every
   * minute. The two rules together meant the most important alert in the system
   * went permanently silent after its first firing.
   */
  const expireQuiet = (): void => {
    const now = clock.now();
    for (const [condition, at] of [...lastSeen.entries()]) {
      if (now - at >= thresholds.reArmAfterMs) clear(condition);
    }
  };

  /** Totals a counter across every label combination. */
  const counterTotal = (name: string): number => {
    const snapshot = registry.snapshot()[name];
    if (!Array.isArray(snapshot)) return 0;
    return snapshot.reduce<number>(
      (sum, entry) =>
        sum +
        (typeof (entry as { value?: number }).value === 'number'
          ? (entry as { value: number }).value
          : 0),
      0,
    );
  };

  /** The worst p99 across every route. */
  const worstP99 = (): number => {
    const snapshot = registry.snapshot()[TECHNICAL_METRICS.requestDuration];
    if (!Array.isArray(snapshot)) return 0;
    return snapshot.reduce<number>(
      (worst, entry) => Math.max(worst, (entry as { p99?: number }).p99 ?? 0),
      0,
    );
  };

  return {
    evaluate: () => {
      const raised: Alert[] = [];

      // Before anything else: a condition nobody has reported for a while is
      // over, and somebody who was paged deserves to hear so.
      expireQuiet();

      /* ---- Error rate ---- */
      const requests = counterTotal(TECHNICAL_METRICS.requestsTotal);
      const errors = counterTotal(TECHNICAL_METRICS.errorsTotal);

      if (requests >= thresholds.minimumSample) {
        const rate = errors / requests;
        if (rate >= thresholds.errorRate) {
          const alert = raise(
            'error_rate',
            'critical',
            `${String(Math.round(rate * 100))}% of requests are failing.`,
            { rate: Math.round(rate * 1_000) / 1_000, requests, errors },
          );
          if (alert) raised.push(alert);
        } else {
          clear('error_rate');
        }
      }

      /* ---- Latency ---- */
      const p99 = worstP99();
      if (p99 >= thresholds.latencyP99Ms) {
        const alert = raise(
          'latency',
          'warning',
          `p99 request latency is ${String(Math.round(p99))} ms — a child is waiting and the character is silent.`,
          { p99Ms: Math.round(p99) },
        );
        if (alert) raised.push(alert);
      } else if (p99 > 0) {
        clear('latency');
      }

      return raised;
    },

    /* ------------------------------------------------------------------ */
    /* Safety                                                              */
    /* ------------------------------------------------------------------ */
    /* The one condition with no threshold and no rate. The safety pipeline
     * fails closed, so a failure means turns are being refused — but it can
     * also mean the classifier is unavailable and children are hitting a wall
     * mid-conversation. Either way somebody needs to know now, not after five
     * more occurrences. */
    reportSafetyFailure: (detail) => {
      raise('safety_pipeline', 'critical', 'The safety pipeline is failing.', { detail });
    },

    /* A turn that completed with the safety layers intact. Not a threshold and
     * not a rate — one clean turn is proof the pipeline is answering, which is
     * the only positive signal this condition has. */
    reportSafetySuccess: () => {
      clear('safety_pipeline');
    },

    reportAiFailure: () => {
      consecutiveAiFailures += 1;
      if (consecutiveAiFailures >= thresholds.aiFailures) {
        raise(
          'ai_provider',
          'critical',
          'The AI provider is failing repeatedly. Children are seeing the fallback reply.',
          { consecutiveFailures: consecutiveAiFailures },
        );
      }
    },

    reportAiSuccess: () => {
      consecutiveAiFailures = 0;
      clear('ai_provider');
    },

    reportDatabaseFailure: (detail) => {
      raise('database', 'critical', 'The database is unreachable.', { detail });
    },

    reportDatabaseSuccess: () => {
      clear('database');
    },

    active: () => [...firing.values()],
  };
};
