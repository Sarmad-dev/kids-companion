import { createMockProvider } from '@kids/ai';
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
 * The conversation API, end to end.
 *
 *   POST /api/conversations/start
 *   POST /api/conversations/:id/message
 *   GET  /api/conversations/:id
 *   POST /api/conversations/:id/end
 *
 * Everything here is genuine except the network and the model: real routes, real
 * Zod validation, real response serialisation, real SQL, real RLS. The provider
 * is the mock, which is the point — a test that needs a live model to prove
 * cross-tenant isolation is a test that will not run in CI.
 */
describe('the conversation API', () => {
  let harness: ApiHarness;
  let alice: RegisteredParent;
  let bob: RegisteredParent;
  let aliceChildId: string;
  let bobChildId: string;

  const POLICY = { policyVersion: '2026-08-01', policyText: 'We process speech to reply.' };

  const createChild = async (
    parent: RegisteredParent,
    displayName = 'Test Child',
    birthYear = 2019,
  ) =>
    (
      await harness.app.inject({
        method: 'POST',
        url: '/v1/children',
        headers: authHeader(parent.accessToken),
        payload: {
          displayName,
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

  const start = async (
    parent: RegisteredParent,
    childId: string,
    body: Record<string, unknown> = {},
  ) =>
    await harness.app.inject({
      method: 'POST',
      url: '/api/conversations/start',
      headers: authHeader(parent.accessToken),
      payload: { childId, ...body },
    });

  const message = async (parent: RegisteredParent, conversationId: string, text: string) =>
    await harness.app.inject({
      method: 'POST',
      url: `/api/conversations/${conversationId}/message`,
      headers: authHeader(parent.accessToken),
      payload: { text },
    });

  const get = async (parent: RegisteredParent, conversationId: string) =>
    await harness.app.inject({
      method: 'GET',
      url: `/api/conversations/${conversationId}`,
      headers: authHeader(parent.accessToken),
    });

  const end = async (
    parent: RegisteredParent,
    conversationId: string,
    body: Record<string, unknown> = {},
  ) =>
    await harness.app.inject({
      method: 'POST',
      url: `/api/conversations/${conversationId}/end`,
      headers: authHeader(parent.accessToken),
      payload: body,
    });

  /** A live paid subscription, so the plan-gated paths can be exercised. */
  const subscribe = async (parentId: string, planCode = 'family_monthly') => {
    await harness.db.query(
      `insert into subscriptions (parent_id, plan_id, rail, status, current_period_start, current_period_end)
       select $1, id, 'mock', 'active', now(), now() + interval '30 days'
         from subscription_plans where code = $2`,
      [parentId, planCode],
    );
  };

  const startedId = async (parent: RegisteredParent, childId: string) =>
    (await start(parent, childId)).json<{ id: string }>().id;

  beforeAll(async () => {
    harness = await createApiHarness();
    alice = await registerAndLogin(harness, 'convapi-alice');
    bob = await registerAndLogin(harness, 'convapi-bob');
    aliceChildId = await createChild(alice, 'Alice Child');
    bobChildId = await createChild(bob, 'Bob Child');
    await consent(alice, aliceChildId);
    await consent(bob, bobChildId);
  });

  afterAll(async () => {
    await harness.close();
  });

  /* ====================================================================== */
  /* POST /api/conversations/start                                          */
  /* ====================================================================== */

  describe('POST /api/conversations/start', () => {
    it('creates a conversation and returns the plan limits', async () => {
      const response = await start(alice, aliceChildId);

      expect(response.statusCode).toBe(201);
      const body = response.json<Record<string, unknown>>();
      expect(body).toMatchObject({
        childId: aliceChildId,
        status: 'active',
        messageCount: 0,
        turnsUsed: 0,
        endedAt: null,
        endReason: null,
        limits: { plan: 'free', dailyTurnLimit: 20, conversationTurnLimit: 20 },
      });
      expect(body.character).toMatchObject({ slug: expect.any(String) });
      expect(body.id).toMatch(/^[0-9a-f-]{36}$/);

      await end(alice, body.id);
    });

    it('returns no database internals', async () => {
      const response = await start(alice, aliceChildId);
      const body = response.json<Record<string, unknown>>();

      // Snake_case anywhere in the payload means a row leaked through instead of
      // being presented. So does anything naming a vendor, a model, or a cost.
      const serialised = JSON.stringify(body);
      for (const forbidden of [
        'child_id',
        'character_id',
        'prompt_key',
        'prompt_version',
        'content_ciphertext',
        'content_key_id',
        'total_cost_usd',
        'anthropic',
        'api_key',
        'apiKey',
      ]) {
        expect(serialised, forbidden).not.toContain(forbidden);
      }

      await end(alice, body.id);
    });

    it('honours an explicit character and language', async () => {
      const { rows } = await harness.db.query<{ id: string }>(
        `select id from ai_characters where slug = 'lily-the-fairy'`,
      );

      const response = await start(alice, aliceChildId, {
        characterId: rows[0]!.id,
        language: 'en',
      });

      expect(response.statusCode).toBe(201);
      expect(response.json().character.slug).toBe('lily-the-fairy');
      await end(alice, response.json<{ id: string }>().id);
    });

    it('rejects a malformed body', async () => {
      for (const payload of [
        {},
        { childId: 'not-a-uuid' },
        { childId: aliceChildId, characterId: 'nope' },
        { childId: aliceChildId, language: 'x' },
      ]) {
        const response = await harness.app.inject({
          method: 'POST',
          url: '/api/conversations/start',
          headers: authHeader(alice.accessToken),
          payload,
        });
        expect(response.statusCode, JSON.stringify(payload)).toBe(400);
        expect(response.json().error.code).toBe('VALIDATION_FAILED');
      }
    });

    it('rejects an unauthenticated request', async () => {
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/conversations/start',
        payload: { childId: aliceChildId },
      });

      expect(response.statusCode).toBe(401);
      expect(response.json().error.code).toMatch(/^AUTH_/);
    });

    it('rejects a forged token', async () => {
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/conversations/start',
        headers: { authorization: 'Bearer not.a.real.token' },
        payload: { childId: aliceChildId },
      });

      expect(response.statusCode).toBe(401);
    });

    it("refuses another parent's child with a 404, not a 403", async () => {
      const response = await start(alice, bobChildId);

      // A 403 would confirm the child exists. The resource here IS a child, so
      // confirming existence to an unauthorised caller is itself a disclosure
      // (docs/API_CONVENTIONS.md §4.3).
      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe('RESOURCE_NOT_FOUND');
    });

    it('refuses a child whose consent gate is unsatisfied', async () => {
      const childId = await createChild(alice, 'No Consent');
      const response = await start(alice, childId);

      // No consent row, so RLS refuses the INSERT — whatever the handler thinks.
      expect(response.statusCode).toBeGreaterThanOrEqual(400);
    });

    it('refuses a paused child', async () => {
      const childId = await createChild(alice, 'Paused Child');
      await consent(alice, childId);
      await harness.db.query('update parental_controls set is_paused = true where child_id = $1', [
        childId,
      ]);

      const response = await start(alice, childId);
      expect(response.statusCode).toBe(400);
      expect(response.json().error.details[0].field).toBe('childId');
    });

    it('carries the request id back on the response and in the error body', async () => {
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/conversations/start',
        headers: { ...authHeader(alice.accessToken), 'x-request-id': 'test-request-id-1' },
        payload: { childId: 'not-a-uuid' },
      });

      expect(response.headers['x-request-id']).toBe('test-request-id-1');
      expect(response.json().error.requestId).toBe('test-request-id-1');
    });
  });

  /* ====================================================================== */
  /* Subscription and free-tier                                             */
  /* ====================================================================== */

  describe('subscription and free-tier limits', () => {
    it('refuses a paid-only character on the free plan with 402', async () => {
      const { rows } = await harness.db.query<{ id: string }>(
        `select id from ai_characters where slug = 'professor-owl'`,
      );
      const childId = await createChild(alice, 'Older Child', 2016);
      await consent(alice, childId);

      const response = await start(alice, childId, { characterId: rows[0]!.id });

      // 402, not 429: waiting does not help, and a client should say so rather
      // than showing a countdown.
      expect(response.statusCode).toBe(402);
      expect(response.json().error.code).toBe('SUBSCRIPTION_REQUIRED');
    });

    it('allows the same character once a subscription is live', async () => {
      const paying = await registerAndLogin(harness, 'convapi-payer');
      const childId = await createChild(paying, 'Paid Child', 2016);
      await consent(paying, childId);
      await subscribe(paying.parentId);

      const { rows } = await harness.db.query<{ id: string }>(
        `select id from ai_characters where slug = 'professor-owl'`,
      );

      const response = await start(paying, childId, { characterId: rows[0]!.id });

      expect(response.statusCode).toBe(201);
      expect(response.json().character.slug).toBe('professor-owl');
      expect(response.json().limits).toMatchObject({
        plan: 'family_monthly',
        conversationTurnLimit: 200,
      });
      await end(paying, response.json<{ id: string }>().id);
    });

    it('keeps access while a subscription is past due', async () => {
      const dunning = await registerAndLogin(harness, 'convapi-dunning');
      const childId = await createChild(dunning, 'Dunning Child');
      await consent(dunning, childId);
      await subscribe(dunning.parentId);
      await harness.db.query(`update subscriptions set status = 'past_due' where parent_id = $1`, [
        dunning.parentId,
      ]);

      const response = await start(dunning, childId);

      // A failed card is a billing conversation with the parent, not a
      // punishment for the child.
      expect(response.statusCode).toBe(201);
      expect(response.json().limits.plan).toBe('family_monthly');
      await end(dunning, response.json<{ id: string }>().id);
    });

    it('falls back to free once a subscription has expired', async () => {
      const lapsed = await registerAndLogin(harness, 'convapi-lapsed');
      const childId = await createChild(lapsed, 'Lapsed Child');
      await consent(lapsed, childId);
      await subscribe(lapsed.parentId);
      await harness.db.query(`update subscriptions set status = 'expired' where parent_id = $1`, [
        lapsed.parentId,
      ]);

      const response = await start(lapsed, childId);
      expect(response.json().limits.plan).toBe('free');
      await end(lapsed, response.json<{ id: string }>().id);
    });

    it('enforces the concurrent-conversation limit on the free plan', async () => {
      const solo = await registerAndLogin(harness, 'convapi-concurrent');
      const childId = await createChild(solo, 'Concurrent Child');
      await consent(solo, childId);

      const first = await start(solo, childId);
      expect(first.statusCode).toBe(201);

      const second = await start(solo, childId);
      expect(second.statusCode).toBe(429);
      expect(second.json().error.code).toBe('QUOTA_CONCURRENT_CONVERSATIONS');

      // Ending the first frees the slot rather than the limit being permanent.
      await end(solo, first.json<{ id: string }>().id);
      const third = await start(solo, childId);
      expect(third.statusCode).toBe(201);
      await end(solo, third.json<{ id: string }>().id);
    });

    it('refuses to start once the daily turn allowance is spent', async () => {
      const spent = await registerAndLogin(harness, 'convapi-spent');
      const childId = await createChild(spent, 'Spent Child');
      await consent(spent, childId);

      await harness.db.query('select app.record_usage($1, 20)', [childId]);

      const response = await start(spent, childId);

      expect(response.statusCode).toBe(429);
      expect(response.json().error.code).toBe('QUOTA_DAILY_TURNS_EXHAUSTED');
      // The parent's own numbers, so the client can explain rather than just
      // refuse. Being cut off with no explanation is what generates tickets.
      expect(response.json().error.meta).toMatchObject({ limit: 20, used: 20, plan: 'free' });
      expect(response.json().error.meta.resetsAt).toBeTruthy();
    });

    it('ends the session warmly, not with an error, when a child hits the limit mid-chat', async () => {
      const midChat = await registerAndLogin(harness, 'convapi-midchat');
      const childId = await createChild(midChat, 'Midchat Child');
      await consent(midChat, childId);

      const conversationId = await startedId(midChat, childId);
      await harness.db.query('select app.record_usage($1, 20)', [childId]);

      const response = await message(midChat, conversationId, 'hello again');

      // A CHILD IS WAITING on this response. A raw 429 would surface to a
      // five-year-old as a broken app (docs/ERROR_HANDLING.md §10).
      expect(response.statusCode).toBe(200);
      const body = response.json<Record<string, unknown>>();
      expect(body.status).toBe('ended');
      expect(body.conversationStatus).toBe('ended');
      expect(body.reply).toMatch(/tomorrow/i);
      expect(body.reply.toLowerCase()).not.toMatch(/limit|quota|error|denied|upgrade/);
      // The machine-readable facts are still there for the parent-facing UI.
      expect(body.limits).toMatchObject({ dailyTurnLimit: 20, plan: 'free' });

      const { rows } = await harness.db.query<{ status: string; end_reason: string }>(
        'select status, end_reason from conversations where id = $1',
        [conversationId],
      );
      expect(rows[0]).toMatchObject({ status: 'ended', end_reason: 'quota_exhausted' });
    });

    it('ends the session when one conversation runs past its turn cap', async () => {
      const long = await registerAndLogin(harness, 'convapi-long');
      const childId = await createChild(long, 'Long Child');
      await consent(long, childId);
      // A generous daily allowance so the SESSION cap is what fires, not the day.
      await subscribe(long.parentId);
      await harness.db.query(
        `update subscription_plans set max_conversation_turns = 2 where code = 'family_monthly'`,
      );

      const conversationId = await startedId(long, childId);
      await message(long, conversationId, 'one');
      await message(long, conversationId, 'two');
      const third = await message(long, conversationId, 'three');

      expect(third.json().status).toBe('ended');
      expect(third.json().reply).toMatch(/fresh chat/i);

      await harness.db.query(
        `update subscription_plans set max_conversation_turns = 200 where code = 'family_monthly'`,
      );
    });
  });

  /* ====================================================================== */
  /* POST /api/conversations/:id/message                                    */
  /* ====================================================================== */

  describe('POST /api/conversations/:id/message', () => {
    it('returns a reply and persists both messages', async () => {
      const conversationId = await startedId(alice, aliceChildId);

      const response = await message(alice, conversationId, 'I saw a butterfly today');

      expect(response.statusCode).toBe(200);
      const body = response.json<Record<string, unknown>>();
      expect(body.status).toBe('ok');
      expect(body.conversationStatus).toBe('active');
      expect(body.reply.length).toBeGreaterThan(0);
      expect(body.messageId).toMatch(/^[0-9a-f-]{36}$/);
      expect(body.replyMessageId).toMatch(/^[0-9a-f-]{36}$/);
      expect(body.limits.dailyTurnsUsed).toBe(1);

      const { rows } = await harness.db.query<{ n: number }>(
        'select count(*)::int as n from messages where conversation_id = $1',
        [conversationId],
      );
      expect(rows[0]!.n).toBe(2);

      await end(alice, conversationId);
    });

    it('substitutes the child name locally and never stores it', async () => {
      const named = await registerAndLogin(harness, 'convapi-named');
      const childId = await createChild(named, 'Zainab');
      await consent(named, childId);
      const conversationId = await startedId(named, childId);

      const body = (await message(named, conversationId, 'hello')).json();
      expect(body.reply).toContain('Zainab');

      // The transcript keeps the placeholder, so the name never replays into a
      // provider call on the next turn.
      const { rows } = await harness.db.query<{ blob: string }>(
        `select string_agg(convert_from(content_ciphertext, 'UTF8'), ' ') as blob
           from messages where conversation_id = $1`,
        [conversationId],
      );
      expect(rows[0]!.blob).not.toContain('Zainab');
      expect(rows[0]!.blob).toContain('{{name}}');

      await end(named, conversationId);
    });

    it('rejects an empty or oversized utterance', async () => {
      const conversationId = await startedId(alice, aliceChildId);

      for (const text of ['', 'x'.repeat(1_001)]) {
        const response = await message(alice, conversationId, text);
        expect(response.statusCode).toBe(400);
        expect(response.json().error.code).toBe('VALIDATION_FAILED');
      }

      await end(alice, conversationId);
    });

    it('rejects a non-uuid conversation id', async () => {
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/conversations/nope/message',
        headers: authHeader(alice.accessToken),
        payload: { text: 'hi' },
      });
      expect(response.statusCode).toBe(400);
    });

    it('rejects an unauthenticated request', async () => {
      const conversationId = await startedId(alice, aliceChildId);

      const response = await harness.app.inject({
        method: 'POST',
        url: `/api/conversations/${conversationId}/message`,
        payload: { text: 'hi' },
      });
      expect(response.statusCode).toBe(401);

      await end(alice, conversationId);
    });

    it("refuses another parent's conversation", async () => {
      const conversationId = await startedId(alice, aliceChildId);

      const response = await message(bob, conversationId, 'let me in');

      expect(response.statusCode).toBe(404);
      // And nothing was written to someone else's conversation.
      const { rows } = await harness.db.query<{ n: number }>(
        'select count(*)::int as n from messages where conversation_id = $1',
        [conversationId],
      );
      expect(rows[0]!.n).toBe(0);

      await end(alice, conversationId);
    });

    it('refuses a conversation that has already ended', async () => {
      const conversationId = await startedId(alice, aliceChildId);
      await end(alice, conversationId);

      const response = await message(alice, conversationId, 'still there?');
      expect(response.statusCode).toBe(400);
      expect(response.json().error.details[0].issue).toMatch(/already ended/);
    });

    it('records usage per turn', async () => {
      const tracked = await registerAndLogin(harness, 'convapi-usage');
      const childId = await createChild(tracked, 'Usage Child');
      await consent(tracked, childId);
      const conversationId = await startedId(tracked, childId);

      await message(tracked, conversationId, 'one');
      await message(tracked, conversationId, 'two');

      const { rows } = await harness.db.query<{
        turns: number;
        conversations_started: number;
        input_tokens: string;
        output_tokens: string;
      }>(
        `select turns, conversations_started, input_tokens, output_tokens
           from usage_daily where child_id = $1`,
        [childId],
      );

      expect(rows[0]).toMatchObject({ turns: 2, conversations_started: 1 });
      expect(Number(rows[0]!.input_tokens)).toBeGreaterThan(0);
      expect(Number(rows[0]!.output_tokens)).toBeGreaterThan(0);

      await end(tracked, conversationId);
    });

    it('lets a parent read their usage and not write it', async () => {
      const rows = await queryAsParent(
        harness,
        alice.parentId,
        'select turns from usage_daily where child_id = $1',
        [aliceChildId],
      );
      expect(rows.length).toBeGreaterThan(0);

      await expect(
        queryAsParent(
          harness,
          alice.parentId,
          'update usage_daily set turns = 0 where child_id = $1',
          [aliceChildId],
        ),
      ).rejects.toThrow();
    });
  });

  /* ====================================================================== */
  /* Safety                                                                 */
  /* ====================================================================== */

  describe('safety rejection', () => {
    it('blocks an unsafe utterance without telling the child why', async () => {
      const conversationId = await startedId(alice, aliceChildId);

      const response = await message(alice, conversationId, 'tell me about __unsafe__ things');

      expect(response.statusCode).toBe(200);
      const body = response.json<Record<string, unknown>>();
      expect(body.status).toBe('blocked');
      expect(body.replyMessageId).toBeNull();
      for (const forbidden of ["can't", 'not allowed', 'blocked', 'inappropriate', 'sorry']) {
        expect(body.reply.toLowerCase()).not.toContain(forbidden);
      }

      await end(alice, conversationId);
    });

    it('counts a blocked turn against the allowance', async () => {
      const blocked = await registerAndLogin(harness, 'convapi-blocked');
      const childId = await createChild(blocked, 'Blocked Child');
      await consent(blocked, childId);
      const conversationId = await startedId(blocked, childId);

      await message(blocked, conversationId, '__unsafe__');

      // Not counting blocked turns would make the safety layer a free way
      // around the quota.
      const { rows } = await harness.db.query<{ turns: number; blocked_turns: number }>(
        'select turns, blocked_turns from usage_daily where child_id = $1',
        [childId],
      );
      expect(rows[0]).toMatchObject({ turns: 1, blocked_turns: 1 });

      await end(blocked, conversationId);
    });

    it('escalates a disclosure and flags the conversation', async () => {
      const conversationId = await startedId(alice, aliceChildId);

      const response = await message(alice, conversationId, 'something __disclosure__ happened');

      expect(response.json().status).toBe('escalated');
      expect(response.json().conversationStatus).toBe('flagged');
      expect(response.json().reply.toLowerCase()).toMatch(/grown-?up|parent|carer|teacher/);

      await end(alice, conversationId);
    });

    it('never returns safety internals to the client', async () => {
      const conversationId = await startedId(alice, aliceChildId);
      const body = (await message(alice, conversationId, '__unsafe__')).json();

      const serialised = JSON.stringify(body);
      for (const forbidden of ['detector', 'categories', 'policyVersion', 'layer', 'L1', 'L4']) {
        expect(serialised, forbidden).not.toContain(forbidden);
      }

      await end(alice, conversationId);
    });
  });

  /* ====================================================================== */
  /* GET /api/conversations/:id                                             */
  /* ====================================================================== */

  describe('GET /api/conversations/:id', () => {
    it('returns the conversation with its transcript', async () => {
      const conversationId = await startedId(alice, aliceChildId);
      await message(alice, conversationId, 'tell me about rockets');

      const response = await get(alice, conversationId);

      expect(response.statusCode).toBe(200);
      const body = response.json<Record<string, unknown>>();
      expect(body.id).toBe(conversationId);
      expect(body.messages).toHaveLength(2);
      expect(body.messages[0]).toMatchObject({ role: 'child', sequence: 0, status: 'delivered' });
      expect(body.messages[0].text).toBe('tell me about rockets');
      expect(body.messages[1].role).toBe('companion');
      expect(body.turnsUsed).toBe(1);

      await end(alice, conversationId);
    });

    it('returns no ciphertext, key ids, or provider details', async () => {
      const conversationId = await startedId(alice, aliceChildId);
      await message(alice, conversationId, 'hello');

      const serialised = JSON.stringify((await get(alice, conversationId)).json());
      for (const forbidden of [
        'ciphertext',
        'content_key_id',
        'keyId',
        'placeholder',
        'provider',
        'model',
        'inputTokens',
        'costUsd',
        'safety_layers_passed',
      ]) {
        expect(serialised, forbidden).not.toContain(forbidden);
      }

      await end(alice, conversationId);
    });

    it("returns 404 for another parent's conversation", async () => {
      const conversationId = await startedId(alice, aliceChildId);

      const response = await get(bob, conversationId);
      expect(response.statusCode).toBe(404);

      await end(alice, conversationId);
    });

    it('returns 404 for a conversation that does not exist', async () => {
      const response = await get(alice, '00000000-0000-7000-8000-000000000000');
      expect(response.statusCode).toBe(404);
    });

    it('rejects an unauthenticated request', async () => {
      const conversationId = await startedId(alice, aliceChildId);

      const response = await harness.app.inject({
        method: 'GET',
        url: `/api/conversations/${conversationId}`,
      });
      expect(response.statusCode).toBe(401);

      await end(alice, conversationId);
    });
  });

  /* ====================================================================== */
  /* POST /api/conversations/:id/end                                        */
  /* ====================================================================== */

  describe('POST /api/conversations/:id/end', () => {
    it('ends a conversation and is idempotent', async () => {
      const conversationId = await startedId(alice, aliceChildId);

      const first = await end(alice, conversationId, { reason: 'parent_ended' });
      expect(first.statusCode).toBe(200);
      expect(first.json()).toMatchObject({ status: 'ended', endReason: 'parent_ended' });
      const endedAt = first.json().endedAt;
      expect(endedAt).not.toBeNull();

      const second = await end(alice, conversationId, { reason: 'child_ended' });
      expect(second.statusCode).toBe(200);
      // Ending twice must not rewrite when or why it ended.
      expect(second.json().endReason).toBe('parent_ended');
      expect(second.json().endedAt).toBe(endedAt);
    });

    it('defaults the reason', async () => {
      const conversationId = await startedId(alice, aliceChildId);
      const response = await end(alice, conversationId);
      expect(response.json().endReason).toBe('child_ended');
    });

    it('rejects an unknown reason', async () => {
      const conversationId = await startedId(alice, aliceChildId);

      const response = await end(alice, conversationId, { reason: 'because-i-said-so' });
      expect(response.statusCode).toBe(400);

      await end(alice, conversationId);
    });

    it("refuses another parent's conversation", async () => {
      const conversationId = await startedId(alice, aliceChildId);

      expect((await end(bob, conversationId)).statusCode).toBe(404);

      const { rows } = await harness.db.query<{ status: string }>(
        'select status from conversations where id = $1',
        [conversationId],
      );
      expect(rows[0]!.status).toBe('active');

      await end(alice, conversationId);
    });

    it('rejects an unauthenticated request', async () => {
      const conversationId = await startedId(alice, aliceChildId);

      const response = await harness.app.inject({
        method: 'POST',
        url: `/api/conversations/${conversationId}/end`,
        payload: {},
      });
      expect(response.statusCode).toBe(401);

      await end(alice, conversationId);
    });

    it('keeps a flagged conversation flagged', async () => {
      const flagged = await registerAndLogin(harness, 'convapi-flagged');
      const childId = await createChild(flagged, 'Flagged Child');
      await consent(flagged, childId);
      const conversationId = await startedId(flagged, childId);

      await message(flagged, conversationId, '__disclosure__ happened');
      await end(flagged, conversationId);

      // Ending a session must not clear a safeguarding flag on it.
      const { rows } = await harness.db.query<{ status: string }>(
        'select status from conversations where id = $1',
        [conversationId],
      );
      expect(rows[0]!.status).toBe('flagged');
    });
  });

  /* ====================================================================== */
  /* Authorization                                                          */
  /* ====================================================================== */

  describe('authorization', () => {
    it('refuses a role without the conversation permission', async () => {
      const support = await registerAndLogin(harness, 'convapi-support');
      await harness.db.query(`update parents set role = 'support' where id = $1`, [
        support.parentId,
      ]);

      const response = await start(support, aliceChildId);

      // A support role can read audit surfaces; it cannot open a child's
      // conversation. 403 here, because the caller is authenticated and the
      // failure is about their role, not about the resource existing.
      expect([403, 404]).toContain(response.statusCode);
    });
  });
});

/* ========================================================================== */
/* Provider failure, timeouts, and rate limiting                              */
/* ========================================================================== */
/* Their own harnesses: each needs a provider or a config the shared instance  */
/* must not have.                                                             */

describe('AI provider failure', () => {
  const POLICY = { policyVersion: '2026-08-01', policyText: 'We process speech to reply.' };

  const setUp = async (h: ApiHarness, label: string) => {
    const parent = await registerAndLogin(h, label);
    const childId = (
      await h.app.inject({
        method: 'POST',
        url: '/v1/children',
        headers: authHeader(parent.accessToken),
        payload: {
          displayName: 'Child',
          birthYear: 2019,
          birthMonth: 6,
          languages: [{ languageCode: 'en', isPrimary: true }],
        },
      })
    ).json<{ id: string }>().id;

    for (const [type, child] of [
      ['terms_of_service', undefined],
      ['privacy_policy', undefined],
      ['child_data_processing', childId],
    ] as const) {
      await h.app.inject({
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

    const conversationId = (
      await h.app.inject({
        method: 'POST',
        url: '/api/conversations/start',
        headers: authHeader(parent.accessToken),
        payload: { childId },
      })
    ).json<{ id: string }>().id;

    return { parent, childId, conversationId };
  };

  const say = async (h: ApiHarness, parent: RegisteredParent, conversationId: string) =>
    await h.app.inject({
      method: 'POST',
      url: `/api/conversations/${conversationId}/message`,
      headers: authHeader(parent.accessToken),
      payload: { text: 'hello there' },
    });

  it('degrades warmly when the provider is unavailable', async () => {
    const h = await createApiHarness({
      aiProvider: createMockProvider({ behaviour: { failWith: 'unavailable' } }),
    });
    try {
      const { parent, conversationId } = await setUp(h, 'fail-unavailable');
      const response = await say(h, parent, conversationId);

      // 200, not 503. A vendor outage is our problem; a child must not see an
      // error, a stack trace, or a spinner that never resolves.
      expect(response.statusCode).toBe(200);
      const body = response.json<Record<string, unknown>>();
      expect(['degraded', 'blocked']).toContain(body.status);
      expect(body.reply.length).toBeGreaterThan(10);
      expect(body.reply.toLowerCase()).not.toMatch(/error|unavailable|failed|try again later/);
      expect(body.replyMessageId).toBeNull();
    } finally {
      await h.close();
    }
  });

  it('degrades warmly when the provider times out', async () => {
    const h = await createApiHarness({
      aiProvider: createMockProvider({ behaviour: { failWith: 'timeout' } }),
    });
    try {
      const { parent, conversationId } = await setUp(h, 'fail-timeout');
      const response = await say(h, parent, conversationId);

      expect(response.statusCode).toBe(200);
      expect(response.json().reply.length).toBeGreaterThan(10);
      expect(response.json().replyMessageId).toBeNull();
    } finally {
      await h.close();
    }
  });

  it('does not leak provider details or credentials on failure', async () => {
    const h = await createApiHarness({
      aiProvider: createMockProvider({ behaviour: { failWith: 'unavailable' } }),
    });
    try {
      const { parent, conversationId } = await setUp(h, 'fail-nodetails');
      const serialised = JSON.stringify((await say(h, parent, conversationId)).json());

      for (const forbidden of ['anthropic', 'api_key', 'apiKey', 'sk-', 'Bearer', 'stack']) {
        expect(serialised.toLowerCase(), forbidden).not.toContain(forbidden.toLowerCase());
      }
    } finally {
      await h.close();
    }
  });

  it('still records the turn against usage when the provider fails', async () => {
    const h = await createApiHarness({
      aiProvider: createMockProvider({ behaviour: { failWith: 'unavailable' } }),
    });
    try {
      const { parent, childId, conversationId } = await setUp(h, 'fail-usage');
      await say(h, parent, conversationId);

      // A failed turn cost us a classifier call. Not recording it would make an
      // outage look like a quiet day in the cost metrics.
      const { rows } = await h.db.query<{ turns: number }>(
        'select turns from usage_daily where child_id = $1',
        [childId],
      );
      expect(rows[0]!.turns).toBe(1);
    } finally {
      await h.close();
    }
  });

  it('recovers on the next turn once the provider does', async () => {
    const h = await createApiHarness({
      // Fails exactly once. That one failure lands on the first turn's input
      // classification, which has no retry by design — a classifier that did not
      // answer is not a classifier that said yes.
      aiProvider: createMockProvider({ behaviour: { failWith: 'unavailable', failTimes: 1 } }),
    });
    try {
      const { parent, conversationId } = await setUp(h, 'fail-recover');
      await say(h, parent, conversationId);
      const second = await say(h, parent, conversationId);

      expect(second.json().status).toBe('ok');
      expect(second.json().replyMessageId).not.toBeNull();
    } finally {
      await h.close();
    }
  });
});

describe('rate limiting', () => {
  const POLICY = { policyVersion: '2026-08-01', policyText: 'We process speech to reply.' };

  it('limits messages per parent and reports when to retry', async () => {
    const h = await createApiHarness({ env: { RATE_LIMIT_CONVERSATION_PER_MINUTE: '3' } });
    try {
      const parent = await registerAndLogin(h, 'ratelimit-parent');
      const other = await registerAndLogin(h, 'ratelimit-other');

      const setUpChild = async (p: RegisteredParent) => {
        const childId = (
          await h.app.inject({
            method: 'POST',
            url: '/v1/children',
            headers: authHeader(p.accessToken),
            payload: {
              displayName: 'Child',
              birthYear: 2019,
              birthMonth: 6,
              languages: [{ languageCode: 'en', isPrimary: true }],
            },
          })
        ).json<{ id: string }>().id;

        for (const [type, child] of [
          ['terms_of_service', undefined],
          ['privacy_policy', undefined],
          ['child_data_processing', childId],
        ] as const) {
          await h.app.inject({
            method: 'POST',
            url: '/v1/consent',
            headers: authHeader(p.accessToken),
            payload: {
              consentType: type,
              granted: true,
              ...POLICY,
              ...(child ? { childId: child } : {}),
            },
          });
        }

        return (
          await h.app.inject({
            method: 'POST',
            url: '/api/conversations/start',
            headers: authHeader(p.accessToken),
            payload: { childId },
          })
        ).json<{ id: string }>().id;
      };

      const conversationId = await setUpChild(parent);
      const otherConversationId = await setUpChild(other);

      const send = async (p: RegisteredParent, id: string) =>
        await h.app.inject({
          method: 'POST',
          url: `/api/conversations/${id}/message`,
          headers: authHeader(p.accessToken),
          payload: { text: 'hello' },
        });

      const statuses: number[] = [];
      for (let i = 0; i < 5; i += 1) statuses.push((await send(parent, conversationId)).statusCode);

      expect(statuses.filter((s) => s === 200)).toHaveLength(3);
      expect(statuses.at(-1)).toBe(429);

      const limited = await send(parent, conversationId);
      expect(limited.headers['retry-after']).toBeTruthy();
      expect(limited.headers['x-ratelimit-limit']).toBe('3');

      // Keyed on the PARENT, not the IP. Every test here shares 127.0.0.1, and a
      // family behind a carrier NAT shares an IP with thousands of strangers —
      // an IP-keyed limit on this route would be a limit on the carrier.
      expect((await send(other, otherConversationId)).statusCode).toBe(200);
    } finally {
      await h.close();
    }
  });

  it('limits how often conversations can be started', async () => {
    const h = await createApiHarness({ env: { RATE_LIMIT_CONVERSATION_START_PER_HOUR: '2' } });
    try {
      const parent = await registerAndLogin(h, 'ratelimit-start');
      const childId = (
        await h.app.inject({
          method: 'POST',
          url: '/v1/children',
          headers: authHeader(parent.accessToken),
          payload: {
            displayName: 'Child',
            birthYear: 2019,
            birthMonth: 6,
            languages: [{ languageCode: 'en', isPrimary: true }],
          },
        })
      ).json<{ id: string }>().id;

      for (const [type, child] of [
        ['terms_of_service', undefined],
        ['privacy_policy', undefined],
        ['child_data_processing', childId],
      ] as const) {
        await h.app.inject({
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

      const startOne = async () =>
        await h.app.inject({
          method: 'POST',
          url: '/api/conversations/start',
          headers: authHeader(parent.accessToken),
          payload: { childId },
        });

      const first = await startOne();
      expect(first.statusCode).toBe(201);
      await h.app.inject({
        method: 'POST',
        url: `/api/conversations/${first.json<{ id: string }>().id}/end`,
        headers: authHeader(parent.accessToken),
        payload: {},
      });

      const second = await startOne();
      expect(second.statusCode).toBe(201);

      expect((await startOne()).statusCode).toBe(429);
    } finally {
      await h.close();
    }
  });
});
