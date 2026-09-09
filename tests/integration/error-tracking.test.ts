import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createMockProvider } from '@kids/ai';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  authHeader,
  createApiHarness,
  registerAndLogin,
  type ApiHarness,
  type RegisteredParent,
} from '../helpers/api.js';

/**
 * Error tracking, through the real error boundary.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT WAS THERE BEFORE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `SENTRY_DSN`: declared, validated, documented, and read by no code in any
 * package. Errors reached structured logs with request ids — real, and not the
 * same thing. Nothing aggregated them, nothing deduplicated them, nothing
 * correlated them to a release.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS FILE DRIVES A REAL FAILURE THROUGH A REAL ROUTE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The unit tests prove the event carries nothing it should not, given an error.
 * They cannot prove what the ERROR BOUNDARY hands over, and that is where a
 * request body, a header, or a child's utterance would enter if it ever did.
 *
 * So: a child speaks, the database throws mid-turn with the child's sentence
 * inside its message, the boundary returns a 500, and a real HTTP server
 * receives the captured event. Then the test reads every byte of it looking for
 * the child.
 */

const POLICY = { policyVersion: '2026-08-01', policyText: 'We process speech to reply.' };

/** The distinctive thing the child says. It must appear in NOTHING below. */
const CHILD_SAID = 'my rabbit is called strawberry';

const createDestination = async (): Promise<{
  url: string;
  received: string[];
  close: () => Promise<void>;
}> => {
  const received: string[] = [];

  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      received.push(Buffer.concat(chunks).toString('utf8'));
      response.writeHead(200).end('ok');
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${String(port)}/errors`,
    received,
    close: async () =>
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
};

const waitFor = async (received: string[], within = 3_000): Promise<void> => {
  const deadline = Date.now() + within;
  while (received.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/**
 * The error a failing database throws, with the child's words inside it.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS SHAPE AND NOT A PROVIDER FAILURE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A provider failure never reaches the error boundary: the engine catches it
 * and returns a degraded reply, because a child must hear "I'm feeling a bit
 * sleepy" rather than see an error. That is correct, and it means a provider
 * outage is the wrong thing to test capture with — a first draft of this file
 * used one and captured nothing, which is the engine working.
 *
 * A driver quoting the row it choked on is the real case: an unexpected throw,
 * from code we did not write, carrying the value it was handling. That value is
 * a child's sentence.
 */
const DRIVER_ERROR = `insert failed: value "${CHILD_SAID}" is too long for column`;

describe('error tracking', () => {
  let destination: Awaited<ReturnType<typeof createDestination>>;
  let harness: ApiHarness;
  let parent: RegisteredParent;
  let childId: string;

  beforeAll(async () => {
    destination = await createDestination();

    harness = await createApiHarness({
      aiProvider: createMockProvider(),
      env: {
        ERROR_TRACKING_PROVIDER: 'webhook',
        ERROR_TRACKING_WEBHOOK_URL: destination.url,
      },
    });

    parent = await registerAndLogin(harness, 'error-tracking');

    const child = await harness.app.inject({
      method: 'POST',
      url: '/v1/children',
      headers: authHeader(parent.accessToken),
      payload: {
        displayName: 'Rumi',
        birthYear: 2018,
        birthMonth: 6,
        languages: [{ languageCode: 'en', isPrimary: true }],
      },
    });
    childId = child.json<{ id: string }>().id;

    for (const [type, scoped] of [
      ['terms_of_service', undefined],
      ['privacy_policy', undefined],
      ['child_data_processing', childId],
    ] as const) {
      await harness.app.inject({
        method: 'POST',
        url: '/v1/consent',
        headers: authHeader(parent.accessToken),
        payload: {
          consentType: type,
          granted: true,
          ...POLICY,
          ...(scoped === undefined ? {} : { childId: scoped }),
        },
      });
    }
  }, 180_000);

  afterAll(async () => {
    await harness.close();
    await destination.close();
  });

  /**
   * Provokes a genuine 500 on a route a child is standing in front of.
   *
   * The conversation is started while the database is healthy, so the failure
   * lands mid-turn — which is where an unexpected throw actually happens.
   */
  const provokeFailure = async (): Promise<number> => {
    const started = await harness.app.inject({
      method: 'POST',
      url: '/api/conversations/start',
      headers: authHeader(parent.accessToken),
      payload: { childId },
    });
    const conversationId = started.json<{ id: string }>().id;

    harness.database.fail(DRIVER_ERROR);
    try {
      const response = await harness.app.inject({
        method: 'POST',
        url: `/api/conversations/${conversationId}/message`,
        headers: authHeader(parent.accessToken),
        payload: { text: CHILD_SAID },
      });
      return response.statusCode;
    } finally {
      harness.database.heal();
    }
  };

  it('captures a real 500 and sends it somewhere', async () => {
    /* The whole chain: a route fails, the single error boundary catches it, the
     * tracker fingerprints it, and a server receives it. Every piece of that
     * existed except the last two. */
    const status = await provokeFailure();
    expect(status).toBeGreaterThanOrEqual(500);

    await waitFor(destination.received);

    expect(destination.received.length).toBeGreaterThanOrEqual(1);
    const event = JSON.parse(destination.received[0]!) as Record<string, unknown>;

    expect(event.event).toBe('error.captured');
    expect(event.code).toBe('INTERNAL_ERROR');
    expect(event.httpStatus).toBe(500);
    // The message survived, scrubbed: enough to recognise the bug, with the
    // quoted value gone.
    expect(String(event.message)).toContain('insert failed');
    expect(String(event.message)).not.toContain('strawberry');
    // Release correlation — one of the four things the review said was absent.
    expect(typeof event.release).toBe('string');
    expect(event.environment).toBe('ci');
    // The route PATTERN, not the URL. The URL carries a conversation id.
    expect(String(event.route)).toContain(':conversationId');
    expect(String(event.route)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  it('does not carry one word the child said', async () => {
    /* ═══════════════════════════════════════════════════════════════════════
     * THE ASSERTION THIS FILE EXISTS FOR.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * The provider's error quoted the child's sentence straight back — which is
     * exactly how a third-party error reaches us in production. It gets as far
     * as the error boundary. It must not get past it.
     *
     * This is also the reason there is no Sentry SDK in this repository: its
     * default integrations attach request bodies and headers, and no test here
     * would ever see them being attached.
     */
    expect(destination.received.length).toBeGreaterThanOrEqual(1);

    for (const body of destination.received) {
      const lower = body.toLowerCase();

      for (const word of ['strawberry', 'rabbit', CHILD_SAID, 'rumi']) {
        expect(lower, word).not.toContain(word.toLowerCase());
      }
      // Nor the identifiers that would let somebody join it back to a family.
      expect(lower).not.toContain(childId.toLowerCase());
      expect(lower).not.toContain(parent.parentId.toLowerCase());
      // Nor the credential the request carried.
      expect(lower).not.toContain('bearer');
      expect(lower).not.toContain(parent.accessToken.slice(0, 20).toLowerCase());
    }
  });

  it('deduplicates a repeated failure instead of forwarding each one', async () => {
    /* Our outage must not become the error tracker's outage. The first
     * occurrence went; the rest are counted. */
    const before = destination.received.length;

    for (let i = 0; i < 3; i += 1) {
      await provokeFailure();
      // The free plan allows one live conversation, and each attempt opens one.
      await harness.db.query(
        "update conversations set status = 'ended', ended_at = now(), end_reason = 'error' where child_id = $1 and ended_at is null",
        [childId],
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(destination.received.length).toBe(before);
  });

  it('shows the aggregate to an operator', async () => {
    // The console somebody opens after a page. Counts, not a list of every
    // exception — and it works whether or not anything is configured to receive.
    await harness.db.query("update parents set role = 'admin' where id = $1", [parent.parentId]);

    const admin = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: parent.email, password: parent.password },
    });

    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/admin/health/detailed',
      headers: authHeader(admin.json<{ accessToken: string }>().accessToken),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{
      errors: {
        distinct: number;
        newSinceBoot: number;
        total: number;
        top: { type: string; message: string; count: number }[];
      };
    }>();

    expect(body.errors.distinct).toBeGreaterThanOrEqual(1);
    expect(body.errors.newSinceBoot).toBeGreaterThanOrEqual(1);
    expect(body.errors.total).toBeGreaterThanOrEqual(4);
    expect(body.errors.top[0]?.count).toBeGreaterThanOrEqual(4);

    // Even here, on a staff-only endpoint, the message is the scrubbed one.
    for (const entry of body.errors.top) {
      expect(entry.message.toLowerCase()).not.toContain('strawberry');
    }
  });

  it('does not capture a client mistake', async () => {
    /* ═══════════════════════════════════════════════════════════════════════
     * A 400 IS NOT A BUG IN THIS APPLICATION.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Neither is a 429 or a 404. A tracker full of other people's mistakes is
     * one nobody reads, and anyone who can send a malformed body could
     * otherwise fill it on demand.
     */
    const before = destination.received.length;

    const bad = await harness.app.inject({
      method: 'POST',
      url: '/api/conversations/start',
      headers: authHeader(parent.accessToken),
      payload: { childId: 'not-a-uuid' },
    });
    expect(bad.statusCode).toBe(400);

    const missing = await harness.app.inject({
      method: 'GET',
      url: '/api/nothing-here',
      headers: authHeader(parent.accessToken),
    });
    expect(missing.statusCode).toBe(404);

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(destination.received.length).toBe(before);
  });
});
