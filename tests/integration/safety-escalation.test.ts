import { createMockProvider } from '@kids/ai';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createEscalationDelivery } from '../../apps/api/src/safety-escalation.js';
import {
  authHeader,
  createApiHarness,
  pgliteDatabase,
  queryAsParent,
  registerAndLogin,
  type ApiHarness,
  type RegisteredParent,
} from '../helpers/api.js';

/**
 * Routing a safety escalation to a human.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THE FAILURE PATHS DOMINATE THIS FILE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The happy path — endpoint up, delivery succeeds — is the least interesting
 * case, because it is the one that was never going to hurt anybody. What this
 * subsystem exists to survive is the endpoint being down when a child discloses
 * something, and the property that matters is that the escalation is still
 * there afterwards.
 *
 * docs/CHILD_SAFETY.md §6.1 item 1: never silently swallow a disclosure.
 * "Nobody was told, and no record of the attempt survived" is a way of
 * swallowing it, so it gets the most tests.
 */

const POLICY = { policyVersion: '2026-08-01', policyText: 'We process speech to reply.' };

describe('safety escalation delivery', () => {
  let harness: ApiHarness;
  let parent: RegisteredParent;
  let childId: string;
  let conversationId: string;

  beforeAll(async () => {
    harness = await createApiHarness({ aiProvider: createMockProvider() });
    parent = await registerAndLogin(harness, 'escalation');

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

    const started = await harness.app.inject({
      method: 'POST',
      url: '/api/conversations/start',
      headers: authHeader(parent.accessToken),
      payload: { childId },
    });
    conversationId = started.json<{ id: string }>().id;
  }, 180_000);

  afterAll(async () => {
    await harness.close();
  });

  /** A delivery service over the harness database, with a controllable endpoint. */
  const deliveryWith = (
    transport: (url: string, body: string) => Promise<{ ok: boolean; status: number }>,
    onFailure?: (detail: string) => void,
  ) =>
    createEscalationDelivery({
      db: pgliteDatabase(harness.db),
      clock: { now: () => Date.now(), nowIso: () => new Date().toISOString() as never },
      logger: harness.app.log,
      webhookUrl: 'https://safeguarding.example/escalations',
      transport: async (url, body) => await transport(url, body),
      ...(onFailure ? { onDeliveryFailure: onFailure } : {}),
    });

  const escalationRow = {
    childId: '',
    conversationId: '', // replaced per call
    reason: 'signal_category' as const,
    categories: ['disclosure_of_harm'],
    severity: 'critical' as const,
  };

  /* ======================================================================== */
  /* The payload                                                              */
  /* ======================================================================== */

  describe('what leaves the building', () => {
    it('never contains the disclosure itself', async () => {
      /* ═══════════════════════════════════════════════════════════════════
       * THE ASSERTION THAT MATTERS MOST IN THIS FILE.
       * ═══════════════════════════════════════════════════════════════════
       *
       * A webhook body ends up in whatever receives it — a ticketing system, a
       * chat channel, someone's inbox. The disclosure must never travel that
       * way. A reviewer gets a POINTER and opens the case in a system with
       * real access control.
       */
      let sent = '';
      const delivery = deliveryWith(async (_url, body) => {
        sent = body;
        return { ok: true, status: 200 };
      });

      await delivery.record({ ...escalationRow, childId, conversationId });
      await new Promise((resolve) => setImmediate(resolve));

      expect(sent).not.toBe('');
      for (const forbidden of [
        'someone at home hurts me',
        '__disclosure__',
        'Rumi',
        'transcript',
        'utterance',
        'reply',
      ]) {
        expect(sent.toLowerCase(), forbidden).not.toContain(forbidden.toLowerCase());
      }
    });

    it('carries what a reviewer needs to act', async () => {
      // A path that cannot identify the case is not a "defined human path".
      let sent = '';
      const delivery = deliveryWith(async (_url, body) => {
        sent = body;
        return { ok: true, status: 200 };
      });

      await delivery.record({ ...escalationRow, childId, conversationId });
      await new Promise((resolve) => setImmediate(resolve));

      const payload = JSON.parse(sent) as Record<string, unknown>;
      expect(payload.event).toBe('safety.escalation');
      expect(payload.reason).toBe('signal_category');
      expect(payload.categories).toEqual(['disclosure_of_harm']);
      expect(payload.severity).toBe('critical');
      expect(payload.childId).toBe(childId);
      expect(typeof payload.escalationId).toBe('string');
      // Survives being forwarded into a chat channel by whatever receives it.
      expect(String(payload.handling)).toContain('Do not question the child');
    });
  });

  /* ======================================================================== */
  /* Failure                                                                  */
  /* ======================================================================== */

  describe('when the endpoint is down', () => {
    it('keeps the escalation pending rather than losing it', async () => {
      const delivery = deliveryWith(async () => {
        throw new Error('connect ECONNREFUSED');
      });

      const id = await delivery.record({ ...escalationRow, childId, conversationId });
      await new Promise((resolve) => setImmediate(resolve));

      const { rows } = await harness.db.query<{
        delivery_status: string;
        attempts: number;
        last_error: string | null;
      }>('select delivery_status, attempts, last_error from safety_escalations where id = $1', [
        id,
      ]);

      expect(rows[0]?.delivery_status).toBe('pending');
      expect(rows[0]?.attempts).toBeGreaterThanOrEqual(1);
      expect(rows[0]?.last_error).toContain('ECONNREFUSED');
    });

    it('raises a safety alert, because a failed escalation is a safety failure', async () => {
      /* Not merely a networking footnote. `reportSafetyFailure` is the one
       * alert condition that fires on the FIRST occurrence rather than a rate,
       * which is correct here: one undelivered disclosure is enough. */
      const failures: string[] = [];
      const delivery = deliveryWith(
        async () => ({ ok: false, status: 503 }),
        (detail) => failures.push(detail),
      );

      await delivery.record({ ...escalationRow, childId, conversationId });
      await new Promise((resolve) => setImmediate(resolve));

      expect(failures).toHaveLength(1);
      expect(failures[0]).toContain('could not be routed');
    });

    it('never lets a delivery failure reach the caller', async () => {
      // A child mid-conversation must not see an error because a webhook is
      // down. `record` resolves once the row is durable, whatever happens next.
      const delivery = deliveryWith(async () => {
        throw new Error('the endpoint exploded');
      });

      await expect(
        delivery.record({ ...escalationRow, childId, conversationId }),
      ).resolves.toBeDefined();
    });

    it('never lets a REJECTED WRITE reach the caller either', async () => {
      /* The stricter half, and the one that was broken. A value the column
       * refuses used to throw straight out of `record` and into the child's
       * turn — a recording problem becoming an error the child sees. */
      const delivery = deliveryWith(async () => ({ ok: true, status: 200 }));

      await expect(
        delivery.record({ ...escalationRow, childId: 'not-a-uuid', conversationId }),
      ).resolves.toBeUndefined();
    });

    it('records the escalation even with no endpoint configured at all', async () => {
      /* Local and CI run without a webhook. The row must still exist and must
       * still be `pending` — marking it delivered would turn a missing
       * configuration into a silent success. */
      const delivery = createEscalationDelivery({
        db: pgliteDatabase(harness.db),
        clock: { now: () => Date.now(), nowIso: () => new Date().toISOString() as never },
        logger: harness.app.log,
        webhookUrl: undefined,
      });

      const id = await delivery.record({ ...escalationRow, childId, conversationId });
      await new Promise((resolve) => setImmediate(resolve));

      const { rows } = await harness.db.query<{ delivery_status: string }>(
        'select delivery_status from safety_escalations where id = $1',
        [id],
      );
      expect(rows[0]?.delivery_status).toBe('pending');
    });
  });

  /* ======================================================================== */
  /* The retry sweep                                                          */
  /* ======================================================================== */

  describe('the retry sweep', () => {
    it('delivers what the request path could not, and stops retrying it', async () => {
      // The whole reason the ledger is durable.
      let up = false;
      const delivery = deliveryWith(async () => {
        if (!up) throw new Error('still down');
        return { ok: true, status: 200 };
      });

      const id = await delivery.record({ ...escalationRow, childId, conversationId });
      await new Promise((resolve) => setImmediate(resolve));

      up = true;
      const first = await delivery.retryPending();
      expect(first.delivered).toBeGreaterThanOrEqual(1);

      const { rows } = await harness.db.query<{ delivery_status: string }>(
        'select delivery_status from safety_escalations where id = $1',
        [id],
      );
      expect(rows[0]?.delivery_status).toBe('delivered');

      // A delivered escalation must not be delivered again — a reviewer opening
      // the same case twice is how a queue stops being trusted.
      const second = await delivery.retryPending();
      const ids = second.attempted;
      expect(ids).toBe(0);
    });
  });

  /* ======================================================================== */
  /* Reachability                                                             */
  /* ======================================================================== */

  it('is unreachable from a parent session', async () => {
    /* ═══════════════════════════════════════════════════════════════════════
     * THE DISCLOSURE MAY CONCERN THE PARENT HOLDING THE SESSION.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * docs/CHILD_SAFETY.md §6.2 lists "who may read it" as unresolved, and the
     * only safe default while that is true is nobody. The table is FORCE RLS
     * with no policy granted to `authenticated`, exactly like `payment_events`.
     *
     * Rows exist by this point — earlier tests wrote them — so an empty result
     * here is RLS working, not an empty table.
     */
    const { rows: all } = await harness.db.query<{ n: number }>(
      'select count(*)::int as n from safety_escalations',
    );
    expect(all[0]?.n ?? 0).toBeGreaterThan(0);

    const visible = await queryAsParent<{ n: number }>(
      harness,
      parent.parentId,
      'select count(*)::int as n from safety_escalations',
    ).catch(() => 'denied' as const);

    expect(visible === 'denied' || visible[0]?.n === 0).toBe(true);
  });
});
