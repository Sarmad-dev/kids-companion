import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  authHeader,
  createApiHarness,
  queryAsParent,
  registerAndLogin,
  type ApiHarness,
  type RegisteredParent,
} from '../helpers/api.js';

/**
 * The safety subsystem, end to end through the real API and real RLS.
 *
 * The unit corpus in `services/safety` proves the decisions. This file proves
 * the parts that only exist once a database is involved: that the policy table
 * is readable but not writable by a parent, that the event log records a
 * decision and not a transcript, and that the repeated-attempt rule actually
 * ends a session rather than merely claiming to.
 */
describe('the safety subsystem', () => {
  let harness: ApiHarness;
  let alice: RegisteredParent;
  let bob: RegisteredParent;
  let aliceChildId: string;

  const POLICY = { policyVersion: '2026-08-01', policyText: 'We process speech to reply.' };

  const createChild = async (parent: RegisteredParent) =>
    (
      await harness.app.inject({
        method: 'POST',
        url: '/v1/children',
        headers: authHeader(parent.accessToken),
        payload: {
          displayName: 'Test Child',
          birthYear: 2019,
          birthMonth: 6,
          languages: [{ languageCode: 'en', isPrimary: true }],
        },
      })
    ).json<{ id: string }>().id;

  const consent = async (parent: RegisteredParent, childId: string) => {
    for (const [type, child] of [
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
          ...(child ? { childId: child } : {}),
        },
      });
    }
  };

  /**
   * Ends whatever is already open for this child, then starts a session.
   *
   * The free plan allows one conversation at a time, which these suites
   * predate — they open a session per test and never close it. The concurrency
   * limit itself is exercised directly in conversation-api.test.ts; here it
   * would only obscure what each test is actually about.
   */
  const startConversation = async (parent: RegisteredParent, childId: string) => {
    await harness.db.query(
      `update conversations set status = 'ended', ended_at = now(),
              end_reason = coalesce(end_reason, 'parent_ended')
        where child_id = $1 and status = 'active'`,
      [childId],
    );

    return await harness.app.inject({
      method: 'POST',
      url: '/api/conversations/start',
      headers: authHeader(parent.accessToken),
      payload: { childId },
    });
  };

  const say = async (parent: RegisteredParent, conversationId: string, text: string) =>
    await harness.app.inject({
      method: 'POST',
      url: `/api/conversations/${conversationId}/message`,
      headers: authHeader(parent.accessToken),
      payload: { text },
    });

  /**
   * A paid plan for the suite.
   *
   * These tests are about conversation mechanics, not entitlements — the
   * free-tier limits are exercised directly in conversation-api.test.ts. On the
   * free plan the twentieth turn of this file would start failing tests that
   * have nothing to do with quotas.
   */
  const subscribeToPaidPlan = async (parentId: string) => {
    await harness.db.query(
      `insert into subscriptions (parent_id, plan_id, rail, status, current_period_start, current_period_end)
       select $1, id, 'mock', 'active', now(), now() + interval '30 days'
         from subscription_plans where code = 'family_monthly'`,
      [parentId],
    );
  };

  beforeAll(async () => {
    harness = await createApiHarness();
    alice = await registerAndLogin(harness, 'safety-alice');
    bob = await registerAndLogin(harness, 'safety-bob');
    aliceChildId = await createChild(alice);
    await subscribeToPaidPlan(alice.parentId);
    await consent(alice, aliceChildId);
  });

  afterAll(async () => {
    await harness.close();
  });

  /* ---------------------------------------------------------------------- */
  /* Policy is data                                                         */
  /* ---------------------------------------------------------------------- */

  describe('the policy table', () => {
    it('seeds a rule for every category the taxonomy names', async () => {
      const { rows } = await harness.db.query<{ category: string }>(
        `select distinct category from safety_policies where is_active`,
      );
      const seeded = new Set(rows.map((r) => r.category));

      // If a category exists in code with no policy row, `resolveRule` falls
      // back to `block` — safe, but it means nobody chose the behaviour. Every
      // category should have had a decision made about it on purpose.
      for (const category of [
        'sexual_content',
        'violence',
        'weapons',
        'dangerous_activities',
        'drugs',
        'hate',
        'harassment',
        'abuse',
        'exploitation',
        'personal_data_request',
        'secret_keeping',
        'inappropriate_relationship',
        'unsafe_medical_advice',
        'unsafe_psychological_advice',
        'self_harm',
        'disclosure_of_harm',
        'distress_signal',
        'prompt_injection',
        'frightening',
        'impersonation',
      ]) {
        expect(seeded, category).toContain(category);
      }
    });

    it('requires a written rationale for every rule', async () => {
      const { rows } = await harness.db.query<{ n: number }>(
        `select count(*)::int as n from safety_policies where coalesce(trim(rationale), '') = ''`,
      );
      // A threshold with no stated reason is a threshold nobody can safely
      // change later, because nobody knows what it was protecting.
      expect(rows[0]!.n).toBe(0);
    });

    it('escalates every signal category', async () => {
      const { rows } = await harness.db.query<{ category: string; escalates: boolean }>(
        `select category, escalates from safety_policies
          where category in ('self_harm', 'disclosure_of_harm', 'distress_signal')
            and is_active`,
      );

      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) expect(row.escalates, row.category).toBe(true);
    });

    it('lets a parent read what is enforced', async () => {
      const rows = await queryAsParent(
        harness,
        alice.parentId,
        `select category, action from safety_policies where category = 'self_harm'`,
      );
      expect(rows.length).toBeGreaterThan(0);
    });

    it('does not let a parent weaken it', async () => {
      // A parent can see the policy and cannot edit it. Content settings for
      // their own child are a different table, and deliberately so: a parent
      // narrows what their child sees, never widens it.
      //
      // The two verbs fail differently, and both are asserted. An UPDATE whose
      // USING clause excludes every row is not an error in Postgres — it
      // simply matches nothing — so "it threw" would be the wrong test and
      // would pass for the wrong reason if the policy were ever loosened.
      const updated = await queryAsParent(
        harness,
        alice.parentId,
        `update safety_policies set action = 'allow'
          where category = 'sexual_content' returning id`,
      );
      expect(updated).toHaveLength(0);

      await expect(
        queryAsParent(
          harness,
          alice.parentId,
          `insert into safety_policies
             (category, applies_to, action, policy_version, rationale)
           values ('sexual_content', 'both', 'allow', '2026-08-01', 'nope')`,
        ),
      ).rejects.toThrow();

      const { rows } = await harness.db.query<{ action: string }>(
        `select action from safety_policies where category = 'sexual_content' and is_active`,
      );
      expect(rows[0]!.action).toBe('block');
    });
  });

  /* ---------------------------------------------------------------------- */
  /* The event log                                                          */
  /* ---------------------------------------------------------------------- */

  describe('the safety event log', () => {
    it('records the detector, policy version, and action — and no content', async () => {
      const conversationId = (await startConversation(alice, aliceChildId)).json<{ id: string }>()
        .id;

      await say(alice, conversationId, 'a very distinctive __unsafe__ phrase about pineapples');

      const { rows } = await harness.db.query<{
        detector: string | null;
        policy_version: string | null;
        action_taken: string | null;
        attempt_index: number;
        categories: string[];
      }>(
        `select detector, policy_version, action_taken, attempt_index, categories
           from content_flags where conversation_id = $1`,
        [conversationId],
      );

      expect(rows.length).toBeGreaterThan(0);
      const flag = rows[0]!;
      expect(flag.policy_version).toBeTruthy();
      expect(flag.action_taken).toBeTruthy();
      expect(flag.attempt_index).toBeGreaterThanOrEqual(1);

      // The whole row, serialised. Nothing the child said may appear anywhere in
      // it — not in the detector name, not in the categories, nowhere.
      const serialised = JSON.stringify(flag).toLowerCase();
      expect(serialised).not.toContain('pineapples');
      expect(serialised).not.toContain('distinctive');
    });

    it('is readable by the owning parent and invisible to anyone else', async () => {
      const conversationId = (await startConversation(alice, aliceChildId)).json<{ id: string }>()
        .id;
      await say(alice, conversationId, '__unsafe__');

      const mine = await queryAsParent(
        harness,
        alice.parentId,
        `select id from content_flags where conversation_id = $1`,
        [conversationId],
      );
      expect(mine.length).toBeGreaterThan(0);

      const theirs = await queryAsParent(
        harness,
        bob.parentId,
        `select id from content_flags where conversation_id = $1`,
        [conversationId],
      );
      expect(theirs).toHaveLength(0);
    });

    it('cannot be erased by the parent it concerns', async () => {
      const conversationId = (await startConversation(alice, aliceChildId)).json<{ id: string }>()
        .id;
      await say(alice, conversationId, '__unsafe__');

      // A parent who could delete a flag could delete the record of a
      // safeguarding concern. SELECT-only is the whole point of the grant.
      await expect(
        queryAsParent(
          harness,
          alice.parentId,
          `delete from content_flags where conversation_id = $1`,
          [conversationId],
        ),
      ).rejects.toThrow();
    });
  });

  /* ---------------------------------------------------------------------- */
  /* Repeated attempts                                                      */
  /* ---------------------------------------------------------------------- */

  describe('the repeated-attempt rule', () => {
    it('counts only this child, and only stopped turns', async () => {
      const otherChildId = await createChild(alice);
      await consent(alice, otherChildId);

      const conversationId = (await startConversation(alice, aliceChildId)).json<{ id: string }>()
        .id;
      await say(alice, conversationId, '__unsafe__');

      const { rows: mine } = await harness.db.query<{ n: number }>(
        `select app.recent_safety_blocks($1::uuid, 15) as n`,
        [aliceChildId],
      );
      const { rows: other } = await harness.db.query<{ n: number }>(
        `select app.recent_safety_blocks($1::uuid, 15) as n`,
        [otherChildId],
      );

      expect(mine[0]!.n).toBeGreaterThan(0);
      expect(other[0]!.n).toBe(0);
    });

    it('ends the session after repeated stopped turns', async () => {
      const childId = await createChild(alice);
      await consent(alice, childId);
      const conversationId = (await startConversation(alice, childId)).json<{ id: string }>().id;

      const statuses: string[] = [];
      for (let i = 0; i < 6; i += 1) {
        statuses.push(
          (await say(alice, conversationId, '__unsafe__')).json<{ status: string }>().status,
        );
      }

      expect(statuses).toContain('ended');

      const { rows } = await harness.db.query<{
        status: string;
        ended_at: Date | null;
        end_reason: string | null;
      }>(`select status, ended_at, end_reason from conversations where id = $1`, [conversationId]);
      // Claiming the session ended and leaving it open would be worse than not
      // ending it: the child would keep talking to something that had stopped
      // listening.
      expect(rows[0]!.status).toBe('ended');
      expect(rows[0]!.ended_at).not.toBeNull();
      // "Why did sessions end?" has to stay answerable — it is the metric that
      // reveals a safety pipeline ending sessions it should not be.
      expect(rows[0]!.end_reason).toBe('safety_ended');
    });

    it('says goodbye warmly rather than explaining what tripped it', async () => {
      const childId = await createChild(alice);
      await consent(alice, childId);
      const conversationId = (await startConversation(alice, childId)).json<{ id: string }>().id;

      let farewell = '';
      for (let i = 0; i < 6; i += 1) {
        const body = (await say(alice, conversationId, '__unsafe__')).json<{
          status: string;
          reply: string;
        }>();
        if (body.status === 'ended') {
          farewell = body.reply;
          break;
        }
      }

      expect(farewell).toBeTruthy();
      // A child who learns which words end the session has learned the wrong
      // lesson, and will go looking for them again.
      for (const forbidden of ['blocked', 'unsafe', 'not allowed', 'too many', 'warning']) {
        expect(farewell.toLowerCase()).not.toContain(forbidden);
      }
    });
  });

  /* ---------------------------------------------------------------------- */
  /* Signals reach a human                                                  */
  /* ---------------------------------------------------------------------- */

  describe('escalation', () => {
    it('records why a turn escalated, so the queue can be triaged', async () => {
      const conversationId = (await startConversation(alice, aliceChildId)).json<{ id: string }>()
        .id;
      await say(alice, conversationId, 'something __disclosure__ happened');

      const { rows } = await harness.db.query<{ metadata: Record<string, unknown> }>(
        `select metadata from audit_logs
          where action = 'safety.escalation.raised'
          order by created_at desc limit 1`,
      );

      expect(rows[0]!.metadata).toMatchObject({
        reason: 'signal_category',
        requiresHumanReview: true,
      });
    });

    it('answers a disclosure by pointing at a grown-up', async () => {
      const conversationId = (await startConversation(alice, aliceChildId)).json<{ id: string }>()
        .id;

      const reply = (await say(alice, conversationId, 'something __disclosure__ happened')).json<{
        reply: string;
      }>().reply;

      // The single most important response in the product. A cheerful change of
      // subject here teaches a child that telling someone produces nothing.
      expect(reply.toLowerCase()).toMatch(/grown-?up|parent|carer|teacher/);
    });
  });
});
