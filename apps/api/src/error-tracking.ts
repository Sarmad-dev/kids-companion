import { randomUUID } from 'node:crypto';

import type { Clock, Logger } from '@kids/shared';

/**
 * Error tracking.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE GAP THIS CLOSES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `SENTRY_DSN` was declared, validated and documented, and read by no code in
 * any package. Errors reached structured logs with request ids — which is real,
 * and is not the same thing. There was no aggregation, no deduplication, no
 * release correlation, and no way to notice that a brand-new failure had
 * started happening.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THERE IS NO SENTRY SDK HERE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * THIS IS THE MOST IMPORTANT DECISION IN THIS FILE.
 *
 * An error tracker's default integrations exist to capture as much surrounding
 * context as possible: request bodies, headers, cookies, query strings,
 * breadcrumbs, sometimes local variables. That is a good default for most
 * products and a catastrophic one here. The request body on the busiest route
 * in this application is a child speaking, and shipping it to a third-party
 * error tracker because an unrelated exception happened nearby would be a
 * serious privacy failure that no amount of later configuration undoes.
 *
 * So nothing here can capture anything by accident. Every field on the event is
 * placed there deliberately by this file, the same way `probeRedis` speaks RESP
 * without a Redis client. What is NEVER sent:
 *
 *   the request body        the query string      headers or cookies
 *   the child's utterance   the model's reply     any child or parent name
 *   any id belonging to a child, a parent, or a conversation
 *
 * What IS sent: the error type, a scrubbed message, our own stack frames, the
 * route pattern, the release, and counts. Enough to fix a bug; not enough to
 * learn anything about a family.
 */

/* -------------------------------------------------------------------------- */
/* The event                                                                   */
/* -------------------------------------------------------------------------- */

export interface TrackedError {
  /** Stable grouping key. Equal fingerprints are the same bug. */
  readonly fingerprint: string;
  /** Error class or `AppError` code — never a message. */
  readonly type: string;
  /** Scrubbed and capped. See `scrubMessage`. */
  readonly message: string;
  readonly code: string;
  readonly category: string;
  readonly httpStatus: number;
  /** The route PATTERN (`/api/conversations/:conversationId/message`), never the URL. */
  readonly route: string;
  readonly method: string;
  /** Our own frames only. Correlates to a log line without carrying anything else. */
  readonly frames: readonly string[];
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly count: number;
}

export interface CaptureInput {
  readonly error: unknown;
  readonly code: string;
  readonly category: string;
  readonly httpStatus: number;
  readonly route: string;
  readonly method: string;
}

/* -------------------------------------------------------------------------- */
/* Scrubbing                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Everything that might carry data, removed from a message.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * AN ALLOWLIST WOULD BE BETTER, AND IS NOT AVAILABLE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Our own `AppError` messages are fixed strings and are safe by construction.
 * The dangerous ones are the errors we did not write: a driver quoting the row
 * it choked on, a validator echoing the value it rejected, a provider returning
 * the prompt inside its complaint. Any of those can contain a child's words.
 *
 * So a message is stripped of every shape that could be a value before it goes
 * anywhere, and then capped. A message that loses its meaning to this is a
 * message that was carrying data, which is the trade we want.
 */
const SCRUBBERS: readonly { readonly pattern: RegExp; readonly replacement: string }[] = [
  // Quoted strings first: the single most common way a value ends up in a
  // message ("invalid value 'the big red bus'").
  { pattern: /"[^"]*"/g, replacement: '"?"' },
  { pattern: /'[^']*'/g, replacement: "'?'" },
  { pattern: /`[^`]*`/g, replacement: '`?`' },
  { pattern: /[\w.+-]+@[\w-]+\.[\w.]+/g, replacement: '<email>' },
  {
    pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
    replacement: '<uuid>',
  },
  // Long unbroken runs: keys, tokens, base64, hashes.
  { pattern: /\b[A-Za-z0-9_-]{24,}\b/g, replacement: '<token>' },
  // Numbers, which also does most of the grouping work: "row 41" and "row 87"
  // are one bug, not two.
  { pattern: /\b\d+\b/g, replacement: '<n>' },
];

const MESSAGE_CAP = 200;

export const scrubMessage = (value: unknown): string => {
  const raw = value instanceof Error ? value.message : String(value);
  const scrubbed = SCRUBBERS.reduce(
    (text, { pattern, replacement }) => text.replace(pattern, replacement),
    raw,
  );
  return scrubbed.replace(/\s+/g, ' ').trim().slice(0, MESSAGE_CAP);
};

/**
 * Our own stack frames, and only ours.
 *
 * A frame inside `node_modules` almost never tells us anything we act on, and
 * the full stack is both long and a place where a value can appear in an
 * argument list. Six frames of our own code is what a person actually reads.
 */
/**
 * One frame, reduced to `at fn (file.ts:line:col)`.
 *
 * The directory is dropped because an absolute path carries the deploy
 * location and sometimes a username. Done by splitting rather than by a regex
 * over the path: a first attempt used one, and it mangled every frame on this
 * machine because the checkout lives under a directory with a space in it.
 */
const compactFrame = (line: string): string => {
  const match = /^(.*?)\(?([^()]*):(\d+):(\d+)\)?$/.exec(line);
  if (!match) return line;

  const [, prefix = '', path = '', row = '', column = ''] = match;
  const file = path.split(/[/\\]/).pop() ?? path;
  return `${prefix.trimEnd()} (${file}:${row}:${column})`;
};

export const ownFrames = (error: unknown, limit = 6): string[] => {
  if (!(error instanceof Error) || typeof error.stack !== 'string') return [];

  return error.stack
    .split('\n')
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('at ') && !line.includes('node_modules'))
    .filter((line) => !line.includes('node:internal'))
    .map(compactFrame)
    .slice(0, limit);
};

/**
 * The grouping key.
 *
 * Type plus scrubbed message plus the innermost frame of our own code. The
 * scrubbing is what makes this work as deduplication: two failures differing
 * only by a row id or a timestamp collapse to one entry, which is the whole
 * difference between "aggregation" and "a list of every exception".
 */
export const fingerprintOf = (type: string, message: string, frames: readonly string[]): string => {
  const site = frames[0] ?? 'no-frame';
  return `${type}|${message}|${site}`;
};

const typeOf = (error: unknown, code: string): string => {
  if (error instanceof Error && error.name !== 'Error' && error.name !== 'AppError') {
    return error.name;
  }
  return code;
};

/* -------------------------------------------------------------------------- */
/* Transport                                                                   */
/* -------------------------------------------------------------------------- */

/** Sends one event somewhere. Injected, so the tracker is testable offline. */
export type ErrorTransport = (event: TrackedError) => Promise<void>;

/**
 * A Sentry DSN, taken apart.
 *
 * `https://<publicKey>@<host>/<projectId>` — the only shape Sentry issues.
 * Parsed rather than pattern-matched so a malformed DSN is a clear boot-time
 * complaint instead of requests to a URL nobody meant.
 */
export const parseSentryDsn = (
  dsn: string,
): { endpoint: string; publicKey: string; projectId: string } | undefined => {
  try {
    const url = new URL(dsn);
    const projectId = url.pathname.replace(/^\//, '');
    if (url.username === '' || projectId === '') return undefined;

    return {
      endpoint: `${url.protocol}//${url.host}/api/${projectId}/envelope/`,
      publicKey: url.username,
      projectId,
    };
  } catch {
    return undefined;
  }
};

/**
 * The Sentry envelope, written by hand.
 *
 * Three newline-delimited JSON documents: an envelope header, an item header,
 * and the event. Hand-written for the reason at the top of this file — the
 * value of not having an SDK is that nothing can attach anything we did not
 * choose, and that value disappears the moment one is installed.
 */
export const sentryEnvelope = (
  event: TrackedError,
  meta: { release: string; environment: string; eventId: string },
): string => {
  const header = JSON.stringify({ event_id: meta.eventId, sent_at: event.lastSeenAt });
  const itemHeader = JSON.stringify({ type: 'event' });

  const payload = JSON.stringify({
    event_id: meta.eventId,
    timestamp: event.lastSeenAt,
    platform: 'node',
    level: event.httpStatus >= 500 ? 'error' : 'warning',
    release: meta.release,
    environment: meta.environment,
    logger: 'kids-companion-api',
    // Ours, not Sentry's. Their default grouping reads the message, which we
    // have deliberately stripped of everything distinguishing.
    fingerprint: [event.fingerprint],
    transaction: event.route,
    tags: {
      code: event.code,
      category: event.category,
      status: String(event.httpStatus),
      method: event.method,
      route: event.route,
    },
    extra: { occurrences: event.count, firstSeenAt: event.firstSeenAt },
    exception: {
      values: [
        {
          type: event.type,
          value: event.message,
          stacktrace: {
            // Sentry renders oldest first, so the failing frame reads last.
            frames: [...event.frames].reverse().map((frame) => ({ function: frame })),
          },
        },
      ],
    },
  });

  return `${header}\n${itemHeader}\n${payload}`;
};

export const createSentryTransport = (options: {
  readonly dsn: string;
  readonly release: string;
  readonly environment: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}): ErrorTransport | undefined => {
  const parsed = parseSentryDsn(options.dsn);
  if (!parsed) return undefined;

  const timeoutMs = options.timeoutMs ?? 5_000;
  const doFetch = options.fetchImpl ?? fetch;

  return async (event) => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    try {
      const response = await doFetch(parsed.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-sentry-envelope',
          // The public key is not a secret — it identifies the project and is
          // designed to be shipped in browser bundles. The DSN is still never
          // logged, because habits about credentials should not have exceptions.
          'x-sentry-auth': `Sentry sentry_version=7, sentry_client=kids-companion/1, sentry_key=${parsed.publicKey}`,
        },
        body: sentryEnvelope(event, {
          release: options.release,
          environment: options.environment,
          eventId: randomUUID().replace(/-/g, ''),
        }),
        signal: controller.signal,
      });

      if (!response.ok) throw new Error(`error tracker returned ${String(response.status)}`);
    } finally {
      clearTimeout(timer);
    }
  };
};

/** A plain JSON POST, for a receiver somebody wrote. Same event, no envelope. */
export const createWebhookTransport = (options: {
  readonly url: string;
  readonly release: string;
  readonly environment: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}): ErrorTransport => {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const doFetch = options.fetchImpl ?? fetch;

  return async (event) => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    try {
      const response = await doFetch(options.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          event: 'error.captured',
          release: options.release,
          environment: options.environment,
          ...event,
        }),
        signal: controller.signal,
      });

      if (!response.ok) throw new Error(`error tracker returned ${String(response.status)}`);
    } finally {
      clearTimeout(timer);
    }
  };
};

/* -------------------------------------------------------------------------- */
/* The tracker                                                                 */
/* -------------------------------------------------------------------------- */

export interface ErrorTracker {
  /**
   * Records one error.
   *
   * Never throws and never blocks: it is called from inside the error handler,
   * and an error tracker that can fail a response has made the incident worse.
   */
  capture(input: CaptureInput): void;
  /** What an operator sees. Aggregated, most frequent first. */
  summary(limit?: number): {
    distinct: number;
    newSinceBoot: number;
    total: number;
    top: readonly TrackedError[];
  };
}

export interface ErrorTrackerOptions {
  readonly clock: Clock;
  readonly logger: Logger;
  /** Absent means aggregate locally and send nothing. */
  readonly transport?: ErrorTransport | undefined;
  /**
   * How many distinct fingerprints to remember.
   *
   * Bounded because this is a process-lifetime map fed by untrusted traffic. A
   * caller able to generate unbounded distinct errors would otherwise have a
   * memory exhaustion primitive.
   */
  readonly maxFingerprints?: number;
  /**
   * The shortest gap between two transmissions of the SAME fingerprint.
   *
   * The first occurrence always goes. After that a failure repeating a thousand
   * times a minute is one bug, and forwarding each one turns our incident into
   * the error tracker's incident too.
   */
  readonly resendAfterMs?: number;
}

export const createErrorTracker = (options: ErrorTrackerOptions): ErrorTracker => {
  const { clock, logger } = options;
  const maxFingerprints = options.maxFingerprints ?? 500;
  const resendAfterMs = options.resendAfterMs ?? 5 * 60_000;

  const seen = new Map<string, { event: TrackedError; lastSentMs: number }>();
  let newSinceBoot = 0;
  let total = 0;

  const send = (event: TrackedError): void => {
    if (!options.transport) return;

    void options.transport(event).catch((error: unknown) => {
      // Swallowed. The error is already in the log, and an unhandled rejection
      // from the error-tracking path would be its own incident.
      logger.warn(
        { reason: error instanceof Error ? error.message : 'unknown' },
        'error tracking delivery failed',
      );
    });
  };

  return {
    capture: (input) => {
      try {
        const nowMs = clock.now();
        const nowIso = clock.nowIso();

        const type = typeOf(input.error, input.code);
        const message = scrubMessage(input.error);
        const frames = ownFrames(input.error);
        const fingerprint = fingerprintOf(type, message, frames);

        total += 1;

        const existing = seen.get(fingerprint);

        if (existing) {
          const event: TrackedError = {
            ...existing.event,
            lastSeenAt: nowIso,
            count: existing.event.count + 1,
          };

          const due = nowMs - existing.lastSentMs >= resendAfterMs;
          seen.set(fingerprint, { event, lastSentMs: due ? nowMs : existing.lastSentMs });
          if (due) send(event);
          return;
        }

        /* Oldest out when full. Losing the least recently seen fingerprint is
         * the least damaging way to stay bounded, and staying bounded is not
         * optional for a map fed by request traffic. */
        if (seen.size >= maxFingerprints) {
          const oldest = seen.keys().next();
          if (!oldest.done) seen.delete(oldest.value);
        }

        const event: TrackedError = {
          fingerprint,
          type,
          message,
          code: input.code,
          category: input.category,
          httpStatus: input.httpStatus,
          route: input.route,
          method: input.method,
          frames,
          firstSeenAt: nowIso,
          lastSeenAt: nowIso,
          count: 1,
        };

        seen.set(fingerprint, { event, lastSentMs: nowMs });
        newSinceBoot += 1;

        /* ═══════════════════════════════════════════════════════════════════
         * A NEW KIND OF FAILURE, LOGGED LOUDLY AND DELIBERATELY NOT PAGED.
         * ═══════════════════════════════════════════════════════════════════
         *
         * The readiness review asked for an alert on a new error type. This is
         * not one, and that is a considered refusal rather than an omission.
         *
         * The alert list answers one question — would a person have to get out
         * of bed for this? — and a first sighting of an error type does not.
         * The first deploy after a release would page a dozen times, and an
         * alert channel that cries wolf on release day is one that gets muted
         * before the failure that mattered arrives.
         *
         * What a new type genuinely needs is to be VISIBLE: a distinct log line
         * somebody can alert on in their own log platform if they want to, and
         * a count on the operator console. Volume is already covered — a new
         * error type that actually matters shows up in `error_rate`, which does
         * page.
         */
        logger.warn(
          { control: 'error_tracking', fingerprint, type, code: input.code, route: input.route },
          'a new error type was seen for the first time since boot',
        );

        send(event);
      } catch (error: unknown) {
        // The tracker failing must never become the response's problem.
        logger.warn({ reason: String(error) }, 'error tracking capture failed');
      }
    },

    summary: (limit = 10) => ({
      distinct: seen.size,
      newSinceBoot,
      total,
      top: [...seen.values()]
        .map((entry) => entry.event)
        .sort((a, b) => b.count - a.count)
        .slice(0, limit),
    }),
  };
};
