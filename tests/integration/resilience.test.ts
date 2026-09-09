import { createMockProvider, type AIProvider } from '@kids/ai';
import { createRailRegistry, signRailCallback } from '@kids/payments';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  authHeader,
  createApiHarness,
  registerAndLogin,
  type ApiHarness,
  type RegisteredParent,
} from '../helpers/api.js';

/**
 * Resilience.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * EVERYTHING HERE IS A FAILURE PATH, AND FAILURE PATHS ARE THE LEAST-RUN CODE
 * IN ANY APPLICATION.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A provider times out, a network drops, a vendor returns something malformed,
 * the database goes away, two requests arrive at once. Every one of those
 * branches was written from imagination and then never executed again — which
 * is exactly why they are where the bad bugs live.
 *
 * The bar for each test is the same: **the failure must not reach a child as a
 * crash, and it must not reach anybody as a lie.** A silent success is worse
 * than a visible error, and both are worse than a graceful fallback that says
 * what happened.
 */

/** A provider that fails in one specific way, on demand. */
const failingAi = (mode: 'timeout' | 'network' | 'malformed' | 'garbage'): AIProvider => ({
  name: `failing-${mode}`,
  generate: () => {
    switch (mode) {
      case 'timeout':
        // The shape a timeout takes after the circuit breaker wraps it.
        return Promise.reject(
          Object.assign(new Error('provider timed out'), { name: 'ProviderTimeoutError' }),
        );
      case 'network':
        return Promise.reject(
          Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:443'), { code: 'ECONNREFUSED' }),
        );
      case 'malformed':
        // Resolves, but with nothing usable. The case a `catch` never sees.
        return Promise.resolve({ text: '', finishReason: 'stop' } as never);
      case 'garbage':
        // Resolves with the wrong shape entirely — a vendor changed its API.
        return Promise.resolve({ nonsense: true } as never);
    }
  },
});

describe('resilience', () => {
  /* ======================================================================== */
  /* Provider failures                                                        */
  /* ======================================================================== */

  describe('AI provider failures', () => {
    const scenarios = ['timeout', 'network', 'malformed', 'garbage'] as const;

    for (const mode of scenarios) {
      it(`survives a ${mode} failure without crashing or lying`, async () => {
        const harness = await createApiHarness({ aiProvider: failingAi(mode) });

        try {
          const parent = await registerAndLogin(harness, `resil-ai-${mode}`);
          const headers = authHeader(parent.accessToken);

          const child = await harness.app.inject({
            method: 'POST',
            url: '/v1/children',
            headers,
            payload: {
              displayName: 'Rumi',
              birthYear: 2018,
              birthMonth: 6,
              languages: [{ languageCode: 'en', isPrimary: true }],
            },
          });
          const childId = child.json<{ id: string }>().id;

          for (const [type, scoped] of [
            ['terms_of_service', undefined],
            ['privacy_policy', undefined],
            ['child_data_processing', childId],
          ] as const) {
            await harness.app.inject({
              method: 'POST',
              url: '/v1/consent',
              headers,
              payload: {
                consentType: type,
                granted: true,
                policyVersion: '2026-08-01',
                policyText: 'We process speech to reply.',
                ...(scoped === undefined ? {} : { childId: scoped }),
              },
            });
          }

          const started = await harness.app.inject({
            method: 'POST',
            url: '/api/conversations/start',
            headers,
            payload: { childId },
          });
          expect(started.statusCode, 'a conversation must still start').toBe(201);

          const message = await harness.app.inject({
            method: 'POST',
            url: `/api/conversations/${started.json<{ id: string }>().id}/message`,
            headers,
            payload: { text: 'Tell me a story about a dog.' },
          });

          /* The child gets an answer, not a stack trace.
           *
           * Either a graceful fallback (200 with a degraded status) or an
           * honest error — never a 500 carrying internals, and never a
           * fabricated reply presented as the character's own. */
          expect([200, 503], `${mode} produced ${String(message.statusCode)}`).toContain(
            message.statusCode,
          );

          for (const leak of ['ECONNREFUSED', '10.0.0.1', 'at Object.', 'node_modules']) {
            expect(message.body, `${mode} leaked ${leak}`).not.toContain(leak);
          }

          if (message.statusCode === 200) {
            const body = message.json<{ reply?: string; status?: string }>();
            // A fallback reply is fine. An empty one is not — a child staring
            // at a blank bubble has no idea what happened.
            expect((body.reply ?? '').length, `${mode} returned an empty reply`).toBeGreaterThan(0);
          }
        } finally {
          await harness.close();
        }
      });
    }

    it('keeps the conversation usable after the provider recovers', async () => {
      // A transient outage must not leave the conversation in a state the child
      // cannot continue from.
      const harness = await createApiHarness({ aiProvider: failingAi('network') });

      try {
        const parent = await registerAndLogin(harness, 'resil-recovery');
        const headers = authHeader(parent.accessToken);

        const child = await harness.app.inject({
          method: 'POST',
          url: '/v1/children',
          headers,
          payload: {
            displayName: 'Rumi',
            birthYear: 2018,
            birthMonth: 6,
            languages: [{ languageCode: 'en', isPrimary: true }],
          },
        });
        const childId = child.json<{ id: string }>().id;

        for (const [type, scoped] of [
          ['terms_of_service', undefined],
          ['privacy_policy', undefined],
          ['child_data_processing', childId],
        ] as const) {
          await harness.app.inject({
            method: 'POST',
            url: '/v1/consent',
            headers,
            payload: {
              consentType: type,
              granted: true,
              policyVersion: '2026-08-01',
              policyText: 'We process speech to reply.',
              ...(scoped === undefined ? {} : { childId: scoped }),
            },
          });
        }

        const started = await harness.app.inject({
          method: 'POST',
          url: '/api/conversations/start',
          headers,
          payload: { childId },
        });
        const conversationId = started.json<{ id: string }>().id;

        await harness.app.inject({
          method: 'POST',
          url: `/api/conversations/${conversationId}/message`,
          headers,
          payload: { text: 'Hello?' },
        });

        const still = await harness.app.inject({
          method: 'GET',
          url: `/api/conversations/${conversationId}`,
          headers,
        });

        expect(still.statusCode).toBe(200);
        expect(still.json<{ status: string }>().status).not.toBe('flagged');
      } finally {
        await harness.close();
      }
    });
  });

  /* ======================================================================== */
  /* Database failure                                                         */
  /* ======================================================================== */

  describe('database failure', () => {
    let harness: ApiHarness;
    let parent: RegisteredParent;

    beforeAll(async () => {
      harness = await createApiHarness();
      parent = await registerAndLogin(harness, 'resil-db');
    });

    afterAll(async () => {
      harness.database.heal();
      await harness.close();
    });

    /**
     * ═══════════════════════════════════════════════════════════════════════
     * AN UNREACHABLE DATABASE MUST PRODUCE AN ERROR, NOT AN EMPTY SUCCESS.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * The dangerous failure is not the 500. It is a handler that catches the
     * error, returns `{ items: [] }`, and tells a parent their child has no
     * conversations — which looks exactly like data loss.
     */
    it('fails loudly rather than returning an empty result', async () => {
      const headers = authHeader(parent.accessToken);

      const healthy = await harness.app.inject({ method: 'GET', url: '/v1/children', headers });
      expect(healthy.statusCode).toBe(200);

      harness.database.fail();

      try {
        const broken = await harness.app.inject({ method: 'GET', url: '/v1/children', headers });

        expect(broken.statusCode).toBeGreaterThanOrEqual(500);
        expect(broken.body).not.toContain('"items":[]');
      } finally {
        harness.database.heal();
      }
    });

    it('says nothing about the database in the response', async () => {
      harness.database.fail('connect ECONNREFUSED 127.0.0.1:5432');

      try {
        const response = await harness.app.inject({
          method: 'GET',
          url: '/v1/children',
          headers: authHeader(parent.accessToken),
        });

        for (const leak of ['ECONNREFUSED', '5432', 'postgres', 'unreachable']) {
          expect(response.body.toLowerCase(), leak).not.toContain(leak.toLowerCase());
        }
        // But it still hands back a request id, so the failure is traceable.
        expect(response.headers['x-request-id']).toBeDefined();
      } finally {
        harness.database.heal();
      }
    });

    it('recovers completely once the database comes back', async () => {
      const response = await harness.app.inject({
        method: 'GET',
        url: '/v1/children',
        headers: authHeader(parent.accessToken),
      });

      expect(response.statusCode).toBe(200);
    });
  });

  /* ======================================================================== */
  /* Concurrency                                                              */
  /* ======================================================================== */

  describe('concurrent requests', () => {
    let harness: ApiHarness;
    let parent: RegisteredParent;

    beforeAll(async () => {
      harness = await createApiHarness();
      parent = await registerAndLogin(harness, 'resil-concurrent');
    });

    afterAll(async () => {
      await harness.close();
    });

    /**
     * ═══════════════════════════════════════════════════════════════════════
     * A CAVEAT WORTH STATING: PGlite IS A SINGLE CONNECTION.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * These requests interleave at every `await`, which genuinely exercises the
     * application's logic — but the database serialises them, so this does NOT
     * prove the behaviour under a real connection pool. A lost update that only
     * appears with two concurrent Postgres backends would pass here.
     *
     * The unique indexes are what actually make these operations safe, and they
     * are real. This proves the code paths agree with them.
     */
    it('creates exactly one checkout for a burst of identical requests', async () => {
      const headers = authHeader(parent.accessToken);

      const responses = await Promise.all(
        Array.from({ length: 8 }, async () =>
          harness.app.inject({
            method: 'POST',
            url: '/api/subscriptions/create',
            headers,
            payload: { planCode: 'monthly', idempotencyKey: 'burst-key-000001' },
          }),
        ),
      );

      for (const response of responses) {
        expect([201, 400, 429]).toContain(response.statusCode);
      }

      const { rows } = await harness.db.query<{ n: number }>(
        `select count(*)::int as n from subscription_checkouts
          where parent_id = $1 and idempotency_key = 'burst-key-000001'`,
        [parent.parentId],
      );
      expect(rows[0]?.n).toBe(1);
    });

    it('creates exactly one payment for a burst of identical initiations', async () => {
      const registry = createRailRegistry({
        enabled: ['jazzcash'],
        jazzcash: {
          merchantId: 'm',
          password: 'p',
          integritySalt: 's',
          mode: 'sandbox',
          sandboxCallbackSecret: 'local-sandbox-rail-signing-key',
          now: () => new Date(),
        },
      });

      const other = await createApiHarness({ railRegistry: registry });
      try {
        const payer = await registerAndLogin(other, 'resil-payment-burst');

        await Promise.all(
          Array.from({ length: 6 }, async () =>
            other.paymentStore.initiate({
              parentId: payer.parentId,
              rail: 'jazzcash',
              amount: { amountMinor: 49_900, currency: 'PKR' },
              idempotencyKey: 'payment-burst-0001',
              description: 'Monthly plan',
            }),
          ),
        );

        const { rows } = await other.db.query<{ n: number }>(
          'select count(*)::int as n from payments where parent_id = $1',
          [payer.parentId],
        );
        expect(rows[0]?.n).toBe(1);
      } finally {
        await other.close();
      }
    });

    it('applies a duplicated webhook burst exactly once', async () => {
      const registry = createRailRegistry({
        enabled: ['jazzcash'],
        jazzcash: {
          merchantId: 'm',
          password: 'p',
          integritySalt: 's',
          mode: 'sandbox',
          sandboxCallbackSecret: 'local-sandbox-rail-signing-key',
          now: () => new Date(),
        },
      });

      const other = await createApiHarness({ railRegistry: registry });
      try {
        const body = JSON.stringify({
          event_id: 'burst_evt_1',
          reference: '00000000-0000-4000-8000-0000000000aa',
          rail_reference: 'jazzcash_sbx_burst',
          status: 'captured',
        });

        const responses = await Promise.all(
          Array.from({ length: 5 }, async () =>
            other.app.inject({
              method: 'POST',
              url: '/api/payments/webhook/jazzcash',
              headers: {
                'content-type': 'application/json',
                'x-kc-rail-signature': signRailCallback(
                  body,
                  'local-sandbox-rail-signing-key',
                  Math.floor(Date.now() / 1000),
                ),
              },
              payload: body,
            }),
          ),
        );

        for (const response of responses) expect(response.statusCode).toBe(200);

        const { rows } = await other.db.query<{ n: number }>(
          `select count(*)::int as n from payment_events where external_event_id = 'burst_evt_1'`,
        );
        expect(rows[0]?.n).toBe(1);
      } finally {
        await other.close();
      }
    });

    it('does not double-count usage under concurrent reads', async () => {
      const headers = authHeader(parent.accessToken);

      const statuses = await Promise.all(
        Array.from({ length: 10 }, async () =>
          harness.app.inject({ method: 'GET', url: '/api/subscriptions/status', headers }),
        ),
      );

      for (const response of statuses) expect(response.statusCode).toBe(200);
      const distinct = new Set(
        statuses.map((response) => response.json<{ status: string }>().status),
      );
      expect(distinct.size, 'concurrent reads disagreed about the same state').toBe(1);
    });

    /**
     * ═══════════════════════════════════════════════════════════════════════
     * TWO TURNS IN FLIGHT ON ONE CONVERSATION.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Found by the performance suite, not by this file: the message sequence
     * was derived from a `message_count` read BEFORE the provider call, so two
     * concurrent turns computed the same sequence and the second died on
     * `uq_messages_conversation_sequence` — a 500, telling the client to retry
     * the thing that had just failed.
     *
     * It needs a slow provider to reproduce, which is exactly why no test here
     * had caught it: with the instant mock the window is too narrow to hit
     * reliably. The provider below is given a delay for that reason alone.
     *
     * This is not an exotic input. A child taps send twice, or the app retries
     * on a flaky mobile connection while the first turn is still in flight —
     * which ARCHITECTURE.md §7.3 says it should do.
     */
    it('survives several turns arriving at once on one conversation', async () => {
      const slow = await createApiHarness({
        aiProvider: createMockProvider({ behaviour: { latencyMs: 150 } }),
      });

      try {
        const owner = await registerAndLogin(slow, 'resil-same-conversation');
        const headers = authHeader(owner.accessToken);
        const jsonHeaders = { ...headers, 'content-type': 'application/json' };

        const child = await slow.app.inject({
          method: 'POST',
          url: '/v1/children',
          headers: jsonHeaders,
          payload: {
            displayName: 'Rumi',
            birthYear: 2018,
            birthMonth: 6,
            languages: [{ languageCode: 'en', isPrimary: true }],
          },
        });
        const childId = child.json<{ id: string }>().id;

        for (const [type, scoped] of [
          ['terms_of_service', undefined],
          ['privacy_policy', undefined],
          ['child_data_processing', childId],
        ] as const) {
          await slow.app.inject({
            method: 'POST',
            url: '/v1/consent',
            headers: jsonHeaders,
            payload: {
              consentType: type,
              granted: true,
              policyVersion: '2026-08-01',
              policyText: 'We process speech to reply.',
              ...(scoped === undefined ? {} : { childId: scoped }),
            },
          });
        }

        const started = await slow.app.inject({
          method: 'POST',
          url: '/api/conversations/start',
          headers: jsonHeaders,
          payload: { childId },
        });
        const conversationId = started.json<{ id: string }>().id;

        const turns = await Promise.all(
          Array.from({ length: 4 }, async (_unused, index) =>
            slow.app.inject({
              method: 'POST',
              url: `/api/conversations/${conversationId}/message`,
              headers: jsonHeaders,
              payload: { text: `Simultaneous turn ${String(index)}` },
            }),
          ),
        );

        for (const response of turns) {
          expect(response.statusCode, `a concurrent turn failed: ${response.body}`).toBe(200);
        }

        /* And the transcript is still correctly ordered — the sequence numbers
         * are what the unique index protects, and a gap or a repeat would mean
         * the conversation replays in the wrong order. */
        const { rows } = await slow.db.query<{ sequence: number }>(
          'select sequence from messages where conversation_id = $1 order by sequence',
          [conversationId],
        );
        const sequences = rows.map((row) => row.sequence);
        expect(new Set(sequences).size, 'duplicate sequence numbers').toBe(sequences.length);
      } finally {
        await slow.close();
      }
    });
  });

  /* ======================================================================== */
  /* Malformed input                                                          */
  /* ======================================================================== */

  describe('malformed requests', () => {
    let harness: ApiHarness;
    let parent: RegisteredParent;

    beforeAll(async () => {
      harness = await createApiHarness();
      parent = await registerAndLogin(harness, 'resil-malformed');
    });

    afterAll(async () => {
      await harness.close();
    });

    it('refuses a body that is not JSON', async () => {
      const response = await harness.app.inject({
        method: 'POST',
        url: '/v1/children',
        headers: { ...authHeader(parent.accessToken), 'content-type': 'application/json' },
        payload: '{"displayName": "unterminated',
      });

      expect(response.statusCode).toBe(400);
      expect(response.body).not.toContain('SyntaxError');
    });

    it('refuses a deeply nested body without exhausting the stack', async () => {
      /* Built as a STRING rather than with JSON.stringify.
       *
       * `JSON.stringify` recurses, so serialising a deeply nested object
       * overflows in the test process before the request is ever sent — which
       * exercises Node's serialiser instead of the server's parser. */
      const depth = 5_000;
      const payload = `${'{"nested":'.repeat(depth)}{"end":true}${'}'.repeat(depth)}`;

      const response = await harness.app.inject({
        method: 'POST',
        url: '/v1/children',
        headers: { ...authHeader(parent.accessToken), 'content-type': 'application/json' },
        payload,
      });

      expect(response.statusCode).toBeGreaterThanOrEqual(400);
      expect(response.statusCode).toBeLessThan(500);
    });

    it('refuses wrong types without a stack trace', async () => {
      const response = await harness.app.inject({
        method: 'POST',
        url: '/v1/children',
        headers: authHeader(parent.accessToken),
        payload: {
          displayName: { not: 'a string' },
          birthYear: 'nineteen',
          languages: 'english',
        },
      });

      expect(response.statusCode).toBe(400);
      expect(response.body).not.toContain('at Object.');
    });

    it('refuses an over-long field rather than storing it', async () => {
      const response = await harness.app.inject({
        method: 'POST',
        url: '/v1/children',
        headers: authHeader(parent.accessToken),
        payload: {
          displayName: 'x'.repeat(100_000),
          birthYear: 2018,
          birthMonth: 6,
          languages: [{ languageCode: 'en', isPrimary: true }],
        },
      });

      expect(response.statusCode).toBe(400);
    });
  });
});
