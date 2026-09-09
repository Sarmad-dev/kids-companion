import type { Clock, Logger } from '@kids/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createErrorTracker,
  createSentryTransport,
  fingerprintOf,
  ownFrames,
  parseSentryDsn,
  scrubMessage,
  sentryEnvelope,
  type TrackedError,
} from './error-tracking.js';

/**
 * Error tracking.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE TESTS THAT MATTER HERE ARE THE PRIVACY ONES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Aggregation and deduplication are ordinary engineering and are covered below.
 * The reason this file is careful is different: an error tracker is an outbound
 * channel to a third party, and the request body on the busiest route in this
 * application is a CHILD SPEAKING.
 *
 * Getting that wrong does not produce a bug report. It produces a transcript of
 * a five-year-old sitting in somebody else's database, and no later
 * configuration change takes it back out.
 */

const movingClock = (): Clock & { advance: (ms: number) => void } => {
  let ms = new Date('2026-09-01T12:00:00.000Z').getTime();
  return {
    now: () => ms,
    nowIso: () => new Date(ms).toISOString() as never,
    advance: (by) => {
      ms += by;
    },
  };
};

const silentLogger = (): Logger =>
  ({
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(),
  }) as unknown as Logger;

/**
 * Builds every test error at ONE source line.
 *
 * The fingerprint includes the innermost frame of our own code, because the
 * same message thrown from two different places is two different bugs. A test
 * that calls `new Error()` on separate lines therefore gets separate
 * fingerprints — correct behaviour, and it silently broke the first draft of
 * the grouping tests here.
 */
const thrown = (message: string, kind: 'error' | 'type' = 'error'): Error =>
  kind === 'type' ? new TypeError(message) : new Error(message);

const capture = (error: unknown, overrides: Record<string, unknown> = {}) => ({
  error,
  code: 'INTERNAL_ERROR',
  category: 'internal',
  httpStatus: 500,
  route: '/api/conversations/:conversationId/message',
  method: 'POST',
  ...overrides,
});

/* ========================================================================== */
/* Scrubbing                                                                  */
/* ========================================================================== */

describe('what leaves the process', () => {
  it('strips a quoted value out of a message', () => {
    /* ═══════════════════════════════════════════════════════════════════════
     * THE MOST LIKELY WAY A CHILD'S WORDS ESCAPE.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Not our own errors — those are fixed strings. The dangerous ones are the
     * errors we did not write: a driver quoting the row it choked on, a
     * validator echoing the value it rejected, a provider returning the prompt
     * inside its complaint.
     */
    const scrubbed = scrubMessage(new Error(`invalid value "the big red bus" for column`));

    expect(scrubbed).not.toContain('big red bus');
    expect(scrubbed).toContain('invalid value');
  });

  it('strips single quotes and backticks too, not just double', () => {
    // A Postgres error uses single quotes; a template literal uses backticks.
    expect(scrubMessage(new Error("could not parse 'I like lions'"))).not.toContain('lions');
    expect(scrubMessage(new Error('column `Rumi` does not exist'))).not.toContain('Rumi');
  });

  it('strips emails, uuids and long tokens', () => {
    const scrubbed = scrubMessage(
      new Error(
        'failed for parent@example.com id 6f9619ff-8b86-d011-b42d-00c04fc964ff key NOTAREALCREDENTIALjustalongrun0123',
      ),
    );

    expect(scrubbed).not.toContain('parent@example.com');
    expect(scrubbed).not.toContain('6f9619ff');
    expect(scrubbed).not.toContain('NOTAREALCREDENTIALjustalongrun0123');
  });

  it('caps a message that is trying to be a payload', () => {
    // An error carrying a whole request body back is exactly the case where a
    // transcript arrives by accident.
    expect(scrubMessage(new Error('x'.repeat(5_000))).length).toBeLessThanOrEqual(200);
  });

  it('keeps enough of a message to be worth reading', () => {
    // Scrubbing that leaves nothing behind produces a tracker full of
    // indistinguishable entries, which is its own kind of useless.
    expect(scrubMessage(new Error('connection terminated unexpectedly'))).toBe(
      'connection terminated unexpectedly',
    );
  });

  it('keeps only our own stack frames, with no absolute paths', () => {
    /* A frame inside node_modules almost never tells us anything we act on, and
     * an absolute path carries the deploy directory and sometimes a username. */
    const error = new Error('boom');
    error.stack = [
      'Error: boom',
      '    at handler (D:\\Web Development\\kids-companion\\apps\\api\\src\\routes\\voice.ts:412:9)',
      '    at run (/srv/app/node_modules/fastify/lib/handleRequest.js:18:2)',
      '    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)',
    ].join('\n');

    const frames = ownFrames(error);

    expect(frames).toHaveLength(1);
    expect(frames[0]).toContain('voice.ts:412:9');
    expect(frames[0]).not.toContain('Web Development');
    expect(frames[0]).not.toContain('D:');
  });
});

/* ========================================================================== */
/* Aggregation                                                                */
/* ========================================================================== */

describe('aggregation', () => {
  let clock: ReturnType<typeof movingClock>;

  beforeEach(() => {
    clock = movingClock();
  });

  it('counts the same failure once, however often it happens', () => {
    // The difference between aggregation and a list of every exception.
    const tracker = createErrorTracker({ clock, logger: silentLogger() });

    for (let i = 0; i < 50; i += 1) tracker.capture(capture(thrown('connection refused')));

    const summary = tracker.summary();
    expect(summary.distinct).toBe(1);
    expect(summary.total).toBe(50);
    expect(summary.top[0]?.count).toBe(50);
  });

  it('groups failures that differ only by a value', () => {
    /* "row 41" and "row 87" are one bug. Grouping on the raw message would
     * produce a tracker with a thousand entries and no signal, which is what
     * makes scrubbing load-bearing rather than only a privacy control. */
    const tracker = createErrorTracker({ clock, logger: silentLogger() });

    tracker.capture(capture(thrown('failed to insert row 41')));
    tracker.capture(capture(thrown('failed to insert row 87')));

    expect(tracker.summary().distinct).toBe(1);
  });

  it('keeps genuinely different failures apart', () => {
    const tracker = createErrorTracker({ clock, logger: silentLogger() });

    tracker.capture(capture(thrown('connection refused')));
    tracker.capture(capture(thrown('cannot read properties of undefined', 'type')));

    expect(tracker.summary().distinct).toBe(2);
  });

  it('counts a first sighting since boot', () => {
    // The figure worth reading after a deploy.
    const tracker = createErrorTracker({ clock, logger: silentLogger() });

    tracker.capture(capture(thrown('one')));
    tracker.capture(capture(thrown('one')));
    tracker.capture(capture(thrown('two')));

    expect(tracker.summary().newSinceBoot).toBe(2);
  });

  it('stays bounded against a caller generating distinct errors', () => {
    /* This map is fed by request traffic. Unbounded, it is a memory exhaustion
     * primitive handed to anyone who can make the server throw. */
    const tracker = createErrorTracker({ clock, logger: silentLogger(), maxFingerprints: 10 });

    for (let i = 0; i < 200; i += 1) {
      tracker.capture(capture(thrown(`distinct failure kind ${'x'.repeat(i)}`)));
    }

    expect(tracker.summary().distinct).toBeLessThanOrEqual(10);
  });
});

/* ========================================================================== */
/* Delivery                                                                   */
/* ========================================================================== */

describe('delivery', () => {
  let clock: ReturnType<typeof movingClock>;

  beforeEach(() => {
    clock = movingClock();
  });

  it('sends the first occurrence immediately', async () => {
    const sent: TrackedError[] = [];
    const tracker = createErrorTracker({
      clock,
      logger: silentLogger(),
      transport: async (event) => {
        sent.push(event);
        await Promise.resolve();
      },
    });

    tracker.capture(capture(thrown('connection refused')));
    await new Promise((resolve) => setImmediate(resolve));

    expect(sent).toHaveLength(1);
    expect(sent[0]?.message).toBe('connection refused');
  });

  it('does not forward every occurrence of the same failure', async () => {
    /* ═══════════════════════════════════════════════════════════════════════
     * OUR INCIDENT MUST NOT BECOME THE ERROR TRACKER'S INCIDENT.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * A failure repeating a thousand times a minute is still one bug. Sending
     * each occurrence is how an outage takes down the thing meant to report it.
     */
    const sent: TrackedError[] = [];
    const tracker = createErrorTracker({
      clock,
      logger: silentLogger(),
      resendAfterMs: 60_000,
      transport: async (event) => {
        sent.push(event);
        await Promise.resolve();
      },
    });

    for (let i = 0; i < 100; i += 1) tracker.capture(capture(thrown('connection refused')));
    await new Promise((resolve) => setImmediate(resolve));
    expect(sent).toHaveLength(1);

    // Once the window passes, an ongoing failure is worth saying again — with
    // the count, so the scale is visible.
    clock.advance(61_000);
    tracker.capture(capture(thrown('connection refused')));
    await new Promise((resolve) => setImmediate(resolve));

    expect(sent).toHaveLength(2);
    expect(sent[1]?.count).toBe(101);
  });

  it('never lets a failing transport reach the caller', async () => {
    /* Called from inside the error handler. An unhandled rejection here would
     * crash the process during the incident it was reporting. */
    const tracker = createErrorTracker({
      clock,
      logger: silentLogger(),
      transport: async () => await Promise.reject(new Error('tracker is down')),
    });

    expect(() => {
      tracker.capture(capture(thrown('boom')));
    }).not.toThrow();

    await new Promise((resolve) => setImmediate(resolve));
    expect(tracker.summary().distinct).toBe(1);
  });

  it('aggregates locally even with nowhere to send', () => {
    // `none` is the default and must still be useful: the operator console
    // reads the same summary either way.
    const tracker = createErrorTracker({ clock, logger: silentLogger() });

    tracker.capture(capture(thrown('boom')));

    expect(tracker.summary().distinct).toBe(1);
  });
});

/* ========================================================================== */
/* The Sentry envelope                                                        */
/* ========================================================================== */

describe('the sentry envelope', () => {
  const event: TrackedError = {
    fingerprint: 'Error|connection refused|at handler (voice.ts:1:1)',
    type: 'Error',
    message: 'connection refused',
    code: 'INTERNAL_ERROR',
    category: 'internal',
    httpStatus: 500,
    route: '/api/conversations/:conversationId/message',
    method: 'POST',
    frames: ['at handler (voice.ts:1:1)'],
    firstSeenAt: '2026-09-01T12:00:00.000Z',
    lastSeenAt: '2026-09-01T12:05:00.000Z',
    count: 3,
  };

  it('parses a dsn into the endpoint sentry actually accepts', () => {
    const parsed = parseSentryDsn('https://abc123@o1.ingest.sentry.io/4505');

    expect(parsed?.endpoint).toBe('https://o1.ingest.sentry.io/api/4505/envelope/');
    expect(parsed?.publicKey).toBe('abc123');
    expect(parsed?.projectId).toBe('4505');
  });

  it('refuses a dsn that is not one', () => {
    // A malformed DSN must be a visible non-start, not requests to a URL
    // nobody meant.
    expect(parseSentryDsn('not a url')).toBeUndefined();
    expect(parseSentryDsn('https://o1.ingest.sentry.io/4505')).toBeUndefined();
    expect(parseSentryDsn('https://abc123@o1.ingest.sentry.io/')).toBeUndefined();
    expect(
      createSentryTransport({ dsn: 'nonsense', release: '1', environment: 'ci' }),
    ).toBeUndefined();
  });

  it('is three newline-delimited documents, as the format requires', () => {
    const lines = sentryEnvelope(event, {
      release: '1.2.3',
      environment: 'production',
      eventId: 'a'.repeat(32),
    }).split('\n');

    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0]!)).toMatchObject({ event_id: 'a'.repeat(32) });
    expect(JSON.parse(lines[1]!)).toEqual({ type: 'event' });
  });

  it('correlates to a release and carries our own grouping', () => {
    /* Release correlation was one of the four things the readiness review said
     * was missing. And the fingerprint is ours: Sentry's default grouping reads
     * the message, which we have deliberately stripped of everything
     * distinguishing. */
    const payload = JSON.parse(
      sentryEnvelope(event, {
        release: '1.2.3',
        environment: 'production',
        eventId: 'a'.repeat(32),
      }).split('\n')[2]!,
    ) as Record<string, unknown>;

    expect(payload.release).toBe('1.2.3');
    expect(payload.environment).toBe('production');
    expect(payload.fingerprint).toEqual([event.fingerprint]);
    expect(payload.transaction).toBe('/api/conversations/:conversationId/message');
  });

  it('contains nothing about the child, the request, or the family', () => {
    /* ═══════════════════════════════════════════════════════════════════════
     * THE ASSERTION THIS WHOLE FILE EXISTS FOR.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * The envelope is written by hand precisely so this can be asserted. With
     * an SDK it could not be: the default integrations attach request bodies,
     * headers and cookies, and no test here would see them being added.
     */
    const body = sentryEnvelope(event, {
      release: '1.2.3',
      environment: 'production',
      eventId: 'a'.repeat(32),
    }).toLowerCase();

    for (const forbidden of [
      'transcript',
      'utterance',
      'childname',
      'cookie',
      'authorization',
      'request_body',
      'req.body',
      'headers',
      'querystring',
    ]) {
      expect(body, forbidden).not.toContain(forbidden);
    }

    /* The route PATTERN is present and should be — `:conversationId` is a
     * template, not an id. What must never appear is a resolved one. */
    expect(body).toContain(':conversationid');
    expect(body).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  });
});

/* ========================================================================== */
/* Fingerprints                                                               */
/* ========================================================================== */

describe('fingerprints', () => {
  it('are stable for the same failure', () => {
    expect(fingerprintOf('Error', 'boom', ['at a (x.ts:1:1)'])).toBe(
      fingerprintOf('Error', 'boom', ['at a (x.ts:1:1)']),
    );
  });

  it('separate the same message thrown from different places', () => {
    // Two unrelated bugs that happen to say the same thing are two bugs.
    expect(fingerprintOf('Error', 'boom', ['at a (x.ts:1:1)'])).not.toBe(
      fingerprintOf('Error', 'boom', ['at b (y.ts:9:9)']),
    );
  });
});
