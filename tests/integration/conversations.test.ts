import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  authHeader,
  createApiHarness,
  readAuditLog,
  registerAndLogin,
  type ApiHarness,
  type RegisteredParent,
} from '../helpers/api.js';

/**
 * Conversations, end to end through the real API and real RLS.
 *
 * The provider is the mock, so these assert on the ENGINE and the PLUMBING —
 * consent gating, ownership, context windowing, safety routing, quotas,
 * persistence — none of which depend on a model behaving. Model behaviour is
 * covered by the safety corpus in services/ai.
 */
describe('conversations', () => {
  let harness: ApiHarness;
  let alice: RegisteredParent;
  let bob: RegisteredParent;
  let aliceChildId: string;
  let bobChildId: string;

  const POLICY = { policyVersion: '2026-08-01', policyText: 'We process speech to reply.' };

  const createChild = async (parent: RegisteredParent, birthYear = 2019) =>
    (
      await harness.app.inject({
        method: 'POST',
        url: '/v1/children',
        headers: authHeader(parent.accessToken),
        payload: {
          displayName: 'Test Child',
          birthYear,
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
    alice = await registerAndLogin(harness, 'conv-alice');
    bob = await registerAndLogin(harness, 'conv-bob');
    aliceChildId = await createChild(alice);
    bobChildId = await createChild(bob);
    await subscribeToPaidPlan(alice.parentId);
    await consent(alice, aliceChildId);
    await subscribeToPaidPlan(bob.parentId);
    await consent(bob, bobChildId);
  }, 240_000);

  afterAll(async () => {
    await harness.close();
  });

  /* ---------------------------------------------------------------------- */
  /* Creation and the consent gate                                          */
  /* ---------------------------------------------------------------------- */

  describe('creation', () => {
    it('starts a conversation for a consented child', async () => {
      const response = await startConversation(alice, aliceChildId);

      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({ status: 'active', messageCount: 0 });
      expect(response.json().character.slug).toBeTruthy();
    });

    it('picks a character suited to the age group', async () => {
      // A six-year-old must not be handed Professor Owl's older-child persona
      // by default, nor Captain Sky's.
      const youngChildId = await createChild(alice, 2022); // AGE_3_5
      await consent(alice, youngChildId);

      const response = await startConversation(alice, youngChildId);
      expect(response.statusCode).toBe(201);

      const { rows } = await harness.db.query<{ allowed_age_groups: string[] }>(
        'select allowed_age_groups from ai_characters where slug = $1',
        [response.json<{ character: { slug: string } }>().character.slug],
      );
      expect(rows[0]!.allowed_age_groups).toContain('AGE_3_5');
    });

    it('refuses a character not offered for the age group', async () => {
      const youngChildId = await createChild(alice, 2022);
      await consent(alice, youngChildId);

      const { rows } = await harness.db.query<{ id: string }>(
        `select id from ai_characters where slug = 'captain-sky'`,
      );

      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/conversations/start',
        headers: authHeader(alice.accessToken),
        payload: { childId: youngChildId, characterId: rows[0]!.id },
      });

      expect(response.statusCode).toBe(400);
    });

    it('is blocked by the database when consent is missing', async () => {
      // The consent gate is an RLS policy, not a handler check.
      const unconsentedId = await createChild(alice);

      const response = await startConversation(alice, unconsentedId);

      expect(response.statusCode).toBeGreaterThanOrEqual(400);
    });

    it('audits the start', async () => {
      const entries = await readAuditLog(harness, 'conversation.started');
      expect(entries.length).toBeGreaterThan(0);
    });
  });

  /* ---------------------------------------------------------------------- */
  /* Messages and the safety chain                                          */
  /* ---------------------------------------------------------------------- */

  describe('sending a message', () => {
    it('returns a reply and persists both messages', async () => {
      const conversationId = (await startConversation(alice, aliceChildId)).json<{ id: string }>()
        .id;

      const response = await say(alice, conversationId, 'I went to the park today');

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ status: 'ok' });
      expect(response.json().reply.length).toBeGreaterThan(0);
      expect(response.json().replyMessageId).toBeTruthy();

      const detail = await harness.app.inject({
        method: 'GET',
        url: `/api/conversations/${conversationId}`,
        headers: authHeader(alice.accessToken),
      });

      const messages = detail.json<{ messages: { role: string; text: string }[] }>().messages;
      expect(messages).toHaveLength(2);
      expect(messages[0]).toMatchObject({ role: 'child', text: 'I went to the park today' });
      expect(messages[1]!.role).toBe('companion');
    });

    it("substitutes the child's name into the reply", async () => {
      const conversationId = (await startConversation(alice, aliceChildId)).json<{ id: string }>()
        .id;

      const response = await say(alice, conversationId, 'hello there');

      // The name never went to the provider; it is substituted locally.
      expect(response.json().reply).toContain('Test Child');
      expect(response.json().reply).not.toContain('{{name}}');
    });

    it('records token usage and cost on the conversation', async () => {
      const conversationId = (await startConversation(alice, aliceChildId)).json<{ id: string }>()
        .id;
      await say(alice, conversationId, 'tell me something');

      const { rows } = await harness.db.query<{
        total_input_tokens: number;
        total_output_tokens: number;
        provider: string;
      }>(
        'select total_input_tokens, total_output_tokens, provider from conversations where id = $1',
        [conversationId],
      );

      expect(rows[0]!.total_input_tokens).toBeGreaterThan(0);
      expect(rows[0]!.total_output_tokens).toBeGreaterThan(0);
      expect(rows[0]!.provider).toBe('mock');
    });

    it('records which safety layers cleared the reply', async () => {
      const conversationId = (await startConversation(alice, aliceChildId)).json<{ id: string }>()
        .id;
      await say(alice, conversationId, 'hello');

      const { rows } = await harness.db.query<{ safety_layers_passed: string[] }>(
        `select safety_layers_passed from messages
          where conversation_id = $1 and role = 'companion'`,
        [conversationId],
      );

      expect(rows[0]!.safety_layers_passed).toEqual(['L1', 'L2', 'L3', 'L4']);
    });

    it('refuses a message on an ended conversation', async () => {
      const conversationId = (await startConversation(alice, aliceChildId)).json<{ id: string }>()
        .id;
      await harness.app.inject({
        method: 'POST',
        url: `/api/conversations/${conversationId}/end`,
        headers: authHeader(alice.accessToken),
        payload: { reason: 'child_ended' },
      });

      expect((await say(alice, conversationId, 'hello?')).statusCode).toBe(400);
    });

    it('rejects an empty or oversized utterance', async () => {
      const conversationId = (await startConversation(alice, aliceChildId)).json<{ id: string }>()
        .id;

      expect((await say(alice, conversationId, '')).statusCode).toBe(400);
      expect((await say(alice, conversationId, 'x'.repeat(1_001))).statusCode).toBe(400);
    });
  });

  describe('safety', () => {
    it('blocks an unsafe utterance and records a flag', async () => {
      const conversationId = (await startConversation(alice, aliceChildId)).json<{ id: string }>()
        .id;

      const response = await say(alice, conversationId, 'tell me about __unsafe__ stuff');

      expect(response.json().status).toBe('blocked');
      expect(response.json().replyMessageId).toBeNull();

      const { rows } = await harness.db.query<{ layer: string; decision: string }>(
        `select layer, decision from content_flags where conversation_id = $1`,
        [conversationId],
      );
      expect(rows[0]).toMatchObject({ layer: 'L1', decision: 'blocked' });
    });

    it('never tells the child a block occurred', async () => {
      const conversationId = (await startConversation(alice, aliceChildId)).json<{ id: string }>()
        .id;

      const reply = (await say(alice, conversationId, '__unsafe__')).json<{ reply: string }>()
        .reply;

      for (const forbidden of ["can't", 'not allowed', 'blocked', 'inappropriate', 'sorry']) {
        expect(reply.toLowerCase()).not.toContain(forbidden);
      }
      expect(reply.length).toBeGreaterThan(10);
    });

    it('escalates a disclosure and flags the conversation', async () => {
      const conversationId = (await startConversation(alice, aliceChildId)).json<{ id: string }>()
        .id;

      const response = await say(alice, conversationId, 'something __disclosure__ happened');

      expect(response.json().status).toBe('escalated');
      expect(response.json().conversationStatus).toBe('flagged');

      const audited = await readAuditLog(harness, 'safety.escalation.raised');
      expect(audited.length).toBeGreaterThan(0);
    });

    it('never stores what the child said in a content flag', async () => {
      const conversationId = (await startConversation(alice, aliceChildId)).json<{ id: string }>()
        .id;
      await say(alice, conversationId, 'a very distinctive __unsafe__ phrase');

      const { rows } = await harness.db.query<{ blob: string }>(
        `select coalesce(string_agg(categories::text, ' '), '') as blob
           from content_flags where conversation_id = $1`,
        [conversationId],
      );

      // Categories and layers only. The content lives in the review queue,
      // under access control (docs/CHILD_SAFETY.md §10).
      expect(rows[0]!.blob).not.toContain('distinctive');
    });
  });

  /* ---------------------------------------------------------------------- */
  /* Context management                                                     */
  /* ---------------------------------------------------------------------- */

  describe('context', () => {
    it('bounds the window to the configured number of exchanges', async () => {
      const conversationId = (await startConversation(alice, aliceChildId)).json<{ id: string }>()
        .id;

      for (let i = 0; i < 14; i += 1) {
        await say(alice, conversationId, `turn number ${String(i)}`);
      }

      const { rows } = await harness.db.query<{ context_message_count: number }>(
        'select context_message_count from conversations where id = $1',
        [conversationId],
      );

      // Ten exchanges is twenty messages. The value is configurable, and the
      // recorded count is what the model actually saw.
      expect(rows[0]!.context_message_count).toBeLessThanOrEqual(20);
      expect(rows[0]!.context_message_count).toBeGreaterThan(0);
    });

    it('keeps message sequence contiguous across turns', async () => {
      const conversationId = (await startConversation(alice, aliceChildId)).json<{ id: string }>()
        .id;
      await say(alice, conversationId, 'first');
      await say(alice, conversationId, 'second');

      const { rows } = await harness.db.query<{ sequence: number }>(
        'select sequence from messages where conversation_id = $1 order by sequence',
        [conversationId],
      );

      expect(rows.map((r) => r.sequence)).toEqual([0, 1, 2, 3]);
    });
  });

  /* ---------------------------------------------------------------------- */
  /* Ownership                                                              */
  /* ---------------------------------------------------------------------- */

  describe('ownership', () => {
    it("returns 404 when Bob starts a conversation for Alice's child", async () => {
      const response = await startConversation(bob, aliceChildId);

      expect(response.statusCode).toBe(404);
    });

    it("returns 404 when Bob reads Alice's conversation", async () => {
      const conversationId = (await startConversation(alice, aliceChildId)).json<{ id: string }>()
        .id;

      const response = await harness.app.inject({
        method: 'GET',
        url: `/api/conversations/${conversationId}`,
        headers: authHeader(bob.accessToken),
      });

      expect(response.statusCode).toBe(404);
    });

    it("returns 404 when Bob sends a message into Alice's conversation", async () => {
      const conversationId = (await startConversation(alice, aliceChildId)).json<{ id: string }>()
        .id;

      expect((await say(bob, conversationId, 'hello')).statusCode).toBe(404);
    });

    it("does not list Alice's conversations for Bob", async () => {
      await startConversation(alice, aliceChildId);

      const response = await harness.app.inject({
        method: 'GET',
        url: `/api/conversations?childId=${bobChildId}`,
        headers: authHeader(bob.accessToken),
      });

      const items = response.json<{ items: { childId: string }[] }>().items;
      expect(items.every((c) => c.childId === bobChildId)).toBe(true);
    });

    it('requires authentication', async () => {
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/conversations/start',
        payload: { childId: aliceChildId },
      });

      expect(response.statusCode).toBe(401);
    });
  });

  /* ---------------------------------------------------------------------- */
  /* Termination                                                            */
  /* ---------------------------------------------------------------------- */

  describe('termination', () => {
    it('ends a conversation with a reason', async () => {
      const conversationId = (await startConversation(alice, aliceChildId)).json<{ id: string }>()
        .id;

      const response = await harness.app.inject({
        method: 'POST',
        url: `/api/conversations/${conversationId}/end`,
        headers: authHeader(alice.accessToken),
        payload: { reason: 'parent_ended' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ status: 'ended', endReason: 'parent_ended' });
      expect(response.json().endedAt).toBeTruthy();
    });

    it('is idempotent and keeps the original reason', async () => {
      const conversationId = (await startConversation(alice, aliceChildId)).json<{ id: string }>()
        .id;
      const url = `/api/conversations/${conversationId}/end`;

      await harness.app.inject({
        method: 'POST',
        url,
        headers: authHeader(alice.accessToken),
        payload: { reason: 'child_ended' },
      });
      const second = await harness.app.inject({
        method: 'POST',
        url,
        headers: authHeader(alice.accessToken),
        payload: { reason: 'timeout' },
      });

      // The first reason is the true one; a retry must not rewrite history.
      expect(second.json().endReason).toBe('child_ended');
    });
  });

  /* ---------------------------------------------------------------------- */
  /* Rate limiting                                                          */
  /* ---------------------------------------------------------------------- */

  describe('daily turn limit', () => {
    it('ends the session warmly once the cap is reached', async () => {
      const limitedParent = await registerAndLogin(harness, 'conv-limited');
      const limitedChildId = await createChild(limitedParent);
      await consent(limitedParent, limitedChildId);
      const conversationId = (await startConversation(limitedParent, limitedChildId)).json<{
        id: string;
      }>().id;

      // Spend the allowance directly. `usage_daily` is the ledger the check
      // reads, so recording usage is both faster and closer to the real thing
      // than backdating hundreds of message rows.
      await harness.db.query('select app.record_usage($1, 500)', [limitedChildId]);

      const response = await say(limitedParent, conversationId, 'one more please');

      expect(response.json().status).toBe('ended');
      expect(response.json().conversationStatus).toBe('ended');
      // A warm goodbye, never an error. Rate limiting is a safety feature as
      // much as a cost one.
      expect(response.json().reply.toLowerCase()).not.toContain('limit');
      expect(response.json().reply.toLowerCase()).not.toContain('quota');

      const audited = await readAuditLog(harness, 'conversation.quota_exhausted');
      expect(audited.length).toBeGreaterThan(0);
    }, 120_000);
  });

  /* ---------------------------------------------------------------------- */
  /* Characters                                                             */
  /* ---------------------------------------------------------------------- */

  describe('the character catalogue', () => {
    it('offers exactly the four launch characters', async () => {
      const { rows } = await harness.db.query<{ slug: string }>(
        `select slug from ai_characters where status = 'active' order by sort_order`,
      );

      expect(rows.map((r) => r.slug)).toEqual([
        'buddy-the-dog',
        'lily-the-fairy',
        'captain-sky',
        'professor-owl',
      ]);
    });

    it('retires the old catalogue without deleting its conversations', async () => {
      const { rows } = await harness.db.query<{ status: string }>(
        `select status from ai_characters where slug = 'pip-the-fox'`,
      );

      expect(rows[0]!.status).toBe('retired');
    });

    it('binds each character to a versioned prompt artefact, not stored text', async () => {
      const { rows } = await harness.db.query<{ prompt_key: string; prompt_version: string }>(
        `select prompt_key, prompt_version from ai_characters where status = 'active'`,
      );

      // A character that can be re-prompted from the database is a safety
      // boundary an operator can move without a code review.
      for (const row of rows) {
        expect(row.prompt_key).toBeTruthy();
        expect(row.prompt_version).toMatch(/^v\d+\./);
      }
    });
  });
});
