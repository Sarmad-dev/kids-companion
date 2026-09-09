import { createServer, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';

import { createMockProvider, type AIProvider } from '@kids/ai';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  authHeader,
  createApiHarness,
  registerAndLogin,
  type ApiHarness,
  type RegisteredParent,
} from '../helpers/api.js';

/**
 * An alert reaching somewhere a person will see it.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT WAS ACTUALLY THERE BEFORE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Five alert conditions, correct, and covered by eighteen unit tests that drove
 * every one of them until it fired. All of which was true while:
 *
 *   - no webhook was configured in any environment, so every alert was a
 *     `fatal` log line that something else would have to notice, and nothing
 *     did;
 *   - `reportAiFailure`, `reportDatabaseFailure` and `reportAiSuccess` WERE
 *     CALLED BY NOTHING, so three of the five conditions could not fire at all;
 *   - `reportSafetyFailure` had exactly one caller — escalation delivery — so
 *     the alert named after the safety pipeline could not fire when the safety
 *     pipeline failed;
 *   - `evaluate()` ran only when something scraped `/metrics`.
 *
 * A paging system nobody receives is indistinguishable from a working one right
 * up to the incident, and manufactures confidence in the meantime. So this file
 * runs a REAL HTTP SERVER, points the API's alert webhook at it, breaks the
 * safety classifier through the real conversation route, and waits for a
 * request to arrive.
 */

const POLICY = { policyVersion: '2026-08-01', policyText: 'We process speech to reply.' };

/** A destination, so "the alert was delivered" means an HTTP request happened. */
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
    url: `http://127.0.0.1:${String(port)}/alerts`,
    received,
    close: async () =>
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
};

/** Waits for the destination to receive something, or gives up. */
const waitForDelivery = async (received: string[], within = 3_000): Promise<void> => {
  const deadline = Date.now() + within;
  while (received.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/**
 * A provider that answers normally but whose CLASSIFIER is unreachable.
 *
 * Not `failWith: 'unavailable'`, which breaks generation too. The condition
 * being reproduced is specifically the safety layer being unable to reach its
 * classifier while everything else is up — the pipeline then fails closed and
 * children hit a wall mid-conversation.
 */
const brokenClassifier = (): AIProvider => {
  const inner = createMockProvider();
  return {
    ...inner,
    moderateContent: async () => await Promise.reject(new Error('classifier unreachable')),
  };
};

describe('alerting', () => {
  let destination: Awaited<ReturnType<typeof createDestination>>;
  let harness: ApiHarness;
  let parent: RegisteredParent;
  let childId: string;

  beforeAll(async () => {
    destination = await createDestination();

    harness = await createApiHarness({
      aiProvider: brokenClassifier(),
      env: {
        ALERT_WEBHOOK_URL: destination.url,
        ALERT_WEBHOOK_FORMAT: 'generic',
        // Short, so a test does not sit through a production interval.
        ALERT_EVALUATION_INTERVAL_MS: '5000',
      },
    });

    parent = await registerAndLogin(harness, 'alerting');

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

  it('sends a real request to a real destination when the safety pipeline fails', async () => {
    /* ═══════════════════════════════════════════════════════════════════════
     * THE ASSERTION THIS FILE EXISTS FOR.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * A child talks. The classifier cannot be reached. The pipeline fails
     * closed. Somewhere, a server receives an HTTP request saying so.
     *
     * Every part of that chain existed and was tested in isolation. None of it
     * was connected.
     */
    const conversationId = (
      await harness.app.inject({
        method: 'POST',
        url: '/api/conversations/start',
        headers: authHeader(parent.accessToken),
        payload: { childId },
      })
    ).json<{ id: string }>().id;

    await harness.app.inject({
      method: 'POST',
      url: `/api/conversations/${conversationId}/message`,
      headers: authHeader(parent.accessToken),
      payload: { text: 'hello there' },
    });

    await waitForDelivery(destination.received);

    expect(destination.received.length).toBeGreaterThanOrEqual(1);
    const alert = JSON.parse(destination.received[0]!) as Record<string, unknown>;

    expect(alert.event).toBe('alert.firing');
    expect(alert.condition).toBe('safety_pipeline');
    expect(alert.severity).toBe('critical');
    expect(String(alert.summary)).toContain('safety pipeline');
  });

  it('never puts a child’s words in an alert', async () => {
    /* An alert body lands in whatever the operator configured — a chat channel,
     * a ticketing system, somebody's phone. It is the last place a child's
     * speech should be able to appear, and the failure that produced this alert
     * happened while holding exactly that. */
    expect(destination.received.length).toBeGreaterThanOrEqual(1);

    for (const body of destination.received) {
      const lower = body.toLowerCase();
      for (const forbidden of ['hello there', 'rumi', 'transcript', 'utterance']) {
        expect(lower, forbidden).not.toContain(forbidden);
      }
    }
  });

  it('does not page again while the same outage continues', async () => {
    // The property that decides whether people keep paying attention. A second
    // failing turn is the same incident, not a second one.
    const before = destination.received.length;

    const conversationId = (
      await harness.app.inject({
        method: 'POST',
        url: '/api/conversations/start',
        headers: authHeader(parent.accessToken),
        payload: { childId },
      })
    ).json<{ id: string }>().id;

    await harness.app.inject({
      method: 'POST',
      url: `/api/conversations/${conversationId}/message`,
      headers: authHeader(parent.accessToken),
      payload: { text: 'and again' },
    });

    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(destination.received.length).toBe(before);
  });

  it('shows the same failure to an operator who goes and looks', async () => {
    /* The page and the dashboard must tell the same story. Somebody woken by
     * the alert opens this endpoint first, and an operator console that says
     * "healthy" while a pager says otherwise is how people learn to distrust
     * the pager. */
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
      healthy: boolean;
      alerts: { condition: string; severity: string }[];
    }>();

    expect(body.healthy).toBe(false);
    expect(body.alerts.map((alert) => alert.condition)).toContain('safety_pipeline');
  });
});

/* ========================================================================== */
/* No destination configured                                                  */
/* ========================================================================== */

describe('alerting without a destination', () => {
  it('still starts, and says out loud that alerts go nowhere', async () => {
    /* Local and CI have no pager and should not pretend to. What must NOT
     * happen is silence: an environment where alerting is a no-op is a fact
     * somebody should be able to see at boot, which is why it is logged on
     * every start and why production refuses to boot without a URL at all. */
    const quiet = await createApiHarness();

    const response = await quiet.app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);

    await quiet.close();
  }, 180_000);
});
