import { silentWav } from '@kids/voice';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  authHeader,
  createApiHarness,
  registerAndLogin,
  type ApiHarness,
  type RegisteredParent,
} from '../helpers/api.js';

/**
 * The parent dashboard, and the enforcement behind it.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE SECOND HALF OF THIS FILE IS THE POINT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every parental control is attacked from a direct API call — the shape an adult
 * takes when they have opened the network tab, or a child who has been shown how
 * by an older sibling. A control that only a well-behaved client honours is not
 * a control, and the only way to know the difference is to misbehave on purpose.
 */

const POLICY = { policyVersion: '2026-08-01', policyText: 'We process speech to reply.' };

const multipart = (
  fields: Record<string, string>,
  file: { field: string; filename: string; contentType: string; bytes: Uint8Array },
): { payload: Buffer; headers: Record<string, string> } => {
  const boundary = '----kidsParentBoundary9d2e';
  const chunks: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ),
    );
  }
  chunks.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\n` +
        `Content-Type: ${file.contentType}\r\n\r\n`,
    ),
    Buffer.from(file.bytes),
    Buffer.from('\r\n'),
    Buffer.from(`--${boundary}--\r\n`),
  );
  return {
    payload: Buffer.concat(chunks),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
};

describe('the parent dashboard', () => {
  let harness: ApiHarness;
  let alice: RegisteredParent;
  let bob: RegisteredParent;
  let childId: string;
  let bobChildId: string;

  const createChild = async (parent: RegisteredParent, displayName = 'Rumi') =>
    (
      await harness.app.inject({
        method: 'POST',
        url: '/v1/children',
        headers: authHeader(parent.accessToken),
        payload: {
          displayName,
          birthYear: 2018,
          birthMonth: 6,
          languages: [{ languageCode: 'en', isPrimary: true }],
        },
      })
    ).json<{ id: string }>().id;

  const consent = async (parent: RegisteredParent, id: string) => {
    for (const [type, child] of [
      ['terms_of_service', undefined],
      ['privacy_policy', undefined],
      ['child_data_processing', id],
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

  /** Sets controls directly, so a test does not have to go through the API to set up. */
  const setControls = async (id: string, fields: Record<string, unknown>) => {
    const entries = Object.entries(fields);
    const assignments = entries.map(([key], i) => `${key} = $${String(i + 2)}`).join(', ');
    await harness.db.query(`update parental_controls set ${assignments} where child_id = $1`, [
      id,
      ...entries.map(([, value]) => value),
    ]);
  };

  const resetControls = async (id: string) => {
    await setControls(id, {
      is_paused: false,
      daily_minute_limit: 20,
      session_minute_limit: 15,
      quiet_hours_start: null,
      quiet_hours_end: null,
      allowed_days: [],
      allowed_character_ids: [],
      language_lock: null,
    });
    // Time used today is DERIVED from `conversations`, so clearing the
    // settings is not enough: a session this suite backdated to trip a limit
    // would otherwise make every later test look like the day was spent.
    await harness.db.query(`delete from conversations where child_id = $1`, [id]);
  };

  const startConversation = async (parent: RegisteredParent, id: string) => {
    // The free plan allows one open session at a time, which is exercised
    // directly in conversation-api.test.ts and would only obscure what these
    // tests are about.
    await harness.db.query(
      `update conversations set status = 'ended', ended_at = now(),
              end_reason = coalesce(end_reason, 'parent_ended')
        where child_id = $1 and status = 'active'`,
      [id],
    );

    return await harness.app.inject({
      method: 'POST',
      url: '/api/conversations/start',
      headers: authHeader(parent.accessToken),
      payload: { childId: id },
    });
  };

  const say = async (parent: RegisteredParent, conversationId: string, text = 'hello') =>
    await harness.app.inject({
      method: 'POST',
      url: `/api/conversations/${conversationId}/message`,
      headers: authHeader(parent.accessToken),
      payload: { text },
    });

  beforeAll(async () => {
    harness = await createApiHarness();
    alice = await registerAndLogin(harness, 'dash-alice');
    bob = await registerAndLogin(harness, 'dash-bob');
    childId = await createChild(alice);
    bobChildId = await createChild(bob, 'Sana');
    await consent(alice, childId);
    await consent(bob, bobChildId);
  });

  afterAll(async () => {
    await harness.close();
  });

  /* ====================================================================== */
  /* GET /api/parent/dashboard/:childId                                     */
  /* ====================================================================== */

  describe('GET /api/parent/dashboard/:childId', () => {
    beforeAll(async () => {
      await resetControls(childId);
      const conversationId = (await startConversation(alice, childId)).json<{ id: string }>().id;
      await say(alice, conversationId);
    });

    it('returns everything the dashboard needs', async () => {
      const response = await harness.app.inject({
        method: 'GET',
        url: `/api/parent/dashboard/${childId}`,
        headers: authHeader(alice.accessToken),
      });

      expect(response.statusCode).toBe(200);
      const body = response.json<Record<string, unknown>>();

      for (const field of [
        'today',
        'thisWeek',
        'usage',
        'levels',
        'milestones',
        'safety',
        'controls',
      ]) {
        expect(body, field).toHaveProperty(field);
      }
      expect(body.displayName).toBe('Rumi');
    });

    it('reports usage time and what is left', async () => {
      const usage = (
        await harness.app.inject({
          method: 'GET',
          url: `/api/parent/dashboard/${childId}`,
          headers: authHeader(alice.accessToken),
        })
      ).json<{ usage: { dailyMinuteLimit: number; minutesRemainingToday: number | null } }>().usage;

      expect(usage.dailyMinuteLimit).toBe(20);
      expect(usage.minutesRemainingToday).toBeLessThanOrEqual(20);
    });

    it('summarises safety events as counts and categories, never content', async () => {
      const conversationId = (await startConversation(alice, childId)).json<{ id: string }>().id;
      await say(alice, conversationId, 'tell me about __unsafe__ things');

      const safety = (
        await harness.app.inject({
          method: 'GET',
          url: `/api/parent/dashboard/${childId}`,
          headers: authHeader(alice.accessToken),
        })
      ).json<{ safety: { total: number; byCategory: { category: string }[]; note: string } }>()
        .safety;

      expect(safety.total).toBeGreaterThan(0);
      expect(safety.byCategory.length).toBeGreaterThan(0);
      // What the child actually said is not here, because it is nowhere.
      expect(JSON.stringify(safety)).not.toContain('__unsafe__');
      expect(safety.note.toLowerCase()).toContain('never what was said');
    });

    it('says what the levels are not', async () => {
      const levels = (
        await harness.app.inject({
          method: 'GET',
          url: `/api/parent/dashboard/${childId}`,
          headers: authHeader(alice.accessToken),
        })
      ).json<{ levels: { note: string } }>().levels;

      expect(levels.note.toLowerCase()).toContain('not a comparison with other children');
    });

    it("refuses another parent's child with a 404", async () => {
      const response = await harness.app.inject({
        method: 'GET',
        url: `/api/parent/dashboard/${childId}`,
        headers: authHeader(bob.accessToken),
      });
      expect(response.statusCode).toBe(404);
    });

    it('requires authentication', async () => {
      const response = await harness.app.inject({
        method: 'GET',
        url: `/api/parent/dashboard/${childId}`,
      });
      expect(response.statusCode).toBe(401);
    });
  });

  /* ====================================================================== */
  /* GET /api/parent/progress/:childId                                      */
  /* ====================================================================== */

  describe('GET /api/parent/progress/:childId', () => {
    it('returns the longer view with its disclaimers', async () => {
      const response = await harness.app.inject({
        method: 'GET',
        url: `/api/parent/progress/${childId}?days=30`,
        headers: authHeader(alice.accessToken),
      });

      expect(response.statusCode).toBe(200);
      const body = response.json<{
        daily: unknown[];
        weekly: unknown[];
        vocabulary: { distinctWords: number };
        pronunciation: { disclaimer: string };
        indicatorsPreamble: string;
      }>();

      expect(Array.isArray(body.daily)).toBe(true);
      expect(Array.isArray(body.weekly)).toBe(true);
      expect(body.vocabulary.distinctWords).toBeGreaterThanOrEqual(0);
      // Travels with every score a parent sees, here as everywhere else.
      expect(body.pronunciation.disclaimer.toLowerCase()).toContain('not a speech assessment');
      expect(body.indicatorsPreamble.toLowerCase()).toContain('not a screening tool');
    });

    it("refuses another parent's child", async () => {
      const response = await harness.app.inject({
        method: 'GET',
        url: `/api/parent/progress/${childId}`,
        headers: authHeader(bob.accessToken),
      });
      expect(response.statusCode).toBe(404);
    });
  });

  /* ====================================================================== */
  /* PUT /api/parent/controls/:childId                                      */
  /* ====================================================================== */

  describe('PUT /api/parent/controls/:childId', () => {
    it('updates only what was sent', async () => {
      await resetControls(childId);

      const response = await harness.app.inject({
        method: 'PUT',
        url: `/api/parent/controls/${childId}`,
        headers: authHeader(alice.accessToken),
        payload: { dailyMinuteLimit: 45, blockedTopics: ['spiders'] },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json<{
        dailyMinuteLimit: number;
        sessionMinuteLimit: number;
        blockedTopics: string[];
      }>();
      expect(body.dailyMinuteLimit).toBe(45);
      expect(body.blockedTopics).toEqual(['spiders']);
      // Untouched fields keep their value rather than reverting to a default.
      expect(body.sessionMinuteLimit).toBe(15);
    });

    it('sets every control the brief names', async () => {
      const response = await harness.app.inject({
        method: 'PUT',
        url: `/api/parent/controls/${childId}`,
        headers: authHeader(alice.accessToken),
        payload: {
          dailyMinuteLimit: 60,
          contentFilterLevel: 'strict',
          blockedTopics: ['spiders', 'thunder'],
          allowedDays: [1, 2, 3, 4, 5],
          quietHoursStart: '19:00',
          quietHoursEnd: '07:00',
          notifications: { onWeeklySummary: true },
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        dailyMinuteLimit: 60,
        contentFilterLevel: 'strict',
        blockedTopics: ['spiders', 'thunder'],
        allowedDays: [1, 2, 3, 4, 5],
        notifications: { onWeeklySummary: true, onSafetyFlag: true },
      });
    });

    it('rejects a session limit longer than the daily one', async () => {
      const response = await harness.app.inject({
        method: 'PUT',
        url: `/api/parent/controls/${childId}`,
        headers: authHeader(alice.accessToken),
        payload: { dailyMinuteLimit: 10, sessionMinuteLimit: 60 },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error.details[0].field).toBe('sessionMinuteLimit');
    });

    it('rejects half a quiet-hours window', async () => {
      const response = await harness.app.inject({
        method: 'PUT',
        url: `/api/parent/controls/${childId}`,
        headers: authHeader(alice.accessToken),
        payload: { quietHoursStart: '19:00', quietHoursEnd: null },
      });
      expect(response.statusCode).toBe(400);
    });

    it.each([
      { dailyMinuteLimit: 9_999 },
      { dailyMinuteLimit: -1 },
      { allowedDays: [0] },
      { allowedDays: [8] },
      { quietHoursStart: '25:00', quietHoursEnd: '07:00' },
      { contentFilterLevel: 'off' },
      { unknownField: true },
    ])('rejects %j', async (payload) => {
      const response = await harness.app.inject({
        method: 'PUT',
        url: `/api/parent/controls/${childId}`,
        headers: authHeader(alice.accessToken),
        payload,
      });
      expect(response.statusCode).toBe(400);
    });

    it("refuses to change another parent's child", async () => {
      const response = await harness.app.inject({
        method: 'PUT',
        url: `/api/parent/controls/${childId}`,
        headers: authHeader(bob.accessToken),
        payload: { dailyMinuteLimit: 240 },
      });

      expect(response.statusCode).toBe(404);
      const { rows } = await harness.db.query<{ daily_minute_limit: number }>(
        'select daily_minute_limit from parental_controls where child_id = $1',
        [childId],
      );
      expect(rows[0]!.daily_minute_limit).not.toBe(240);
    });

    it('requires authentication', async () => {
      const response = await harness.app.inject({
        method: 'PUT',
        url: `/api/parent/controls/${childId}`,
        payload: { dailyMinuteLimit: 240 },
      });
      expect(response.statusCode).toBe(401);
    });

    it('audits the change', async () => {
      await harness.app.inject({
        method: 'PUT',
        url: `/api/parent/controls/${childId}`,
        headers: authHeader(alice.accessToken),
        payload: { dailyMinuteLimit: 30 },
      });

      const { rows } = await harness.db.query<{ metadata: Record<string, unknown> }>(
        `select metadata from audit_logs where action = 'parental_controls.updated'
          order by created_at desc limit 1`,
      );
      // "Who loosened this, and when?" has to be answerable.
      expect(rows[0]!.metadata).toMatchObject({ fields: ['dailyMinuteLimit'] });
    });
  });

  /* ====================================================================== */
  /* THE BYPASS ATTEMPTS                                                    */
  /* ====================================================================== */

  describe('controls cannot be bypassed by calling the API directly', () => {
    beforeAll(async () => {
      await resetControls(childId);
    });

    it('a paused child cannot start a conversation', async () => {
      await resetControls(childId);
      await setControls(childId, { is_paused: true });

      expect((await startConversation(alice, childId)).statusCode).toBe(400);
      await resetControls(childId);
    });

    it('a paused child cannot continue an already-open conversation', async () => {
      // The interesting attack: open a session, then have it paused, then keep
      // going. Checking only at start would let this through.
      await resetControls(childId);
      const conversationId = (await startConversation(alice, childId)).json<{ id: string }>().id;
      expect((await say(alice, conversationId)).json<{ status: string }>().status).toBe('ok');

      await setControls(childId, { is_paused: true });

      const blocked = (await say(alice, conversationId)).json<{ status: string; reply: string }>();
      expect(blocked.status).toBe('ended');
      expect(blocked.reply.toLowerCase()).not.toMatch(/parent|blocked|limit/);

      await resetControls(childId);
    });

    it('a child past the daily limit cannot start a conversation', async () => {
      await resetControls(childId);
      // Backdate a session so today's used time exceeds the limit.
      await setControls(childId, { daily_minute_limit: 20 });
      await harness.db.query(
        `insert into conversations (child_id, character_id, language_code, status, started_at, ended_at, end_reason)
         select $1, id, 'en', 'ended', now() - interval '40 minutes', now() - interval '5 minutes', 'child_ended'
           from ai_characters where slug = 'buddy-the-dog'`,
        [childId],
      );

      const response = await startConversation(alice, childId);
      expect(response.statusCode).toBe(400);
      expect(response.json().error.details[0].issue).toContain('daily_limit_reached');

      await resetControls(childId);
    });

    it('a child past the daily limit cannot keep an open conversation going', async () => {
      // The bypass this closes: never end the session.
      await resetControls(childId);
      const conversationId = (await startConversation(alice, childId)).json<{ id: string }>().id;

      await harness.db.query(
        `update conversations set started_at = now() - interval '60 minutes' where id = $1`,
        [conversationId],
      );

      const blocked = (await say(alice, conversationId)).json<{ status: string }>();
      expect(blocked.status).toBe('ended');

      const { rows } = await harness.db.query<{ status: string }>(
        'select status from conversations where id = $1',
        [conversationId],
      );
      expect(rows[0]!.status).toBe('ended');

      await resetControls(childId);
    });

    it('a session past its own limit ends even when the day has time left', async () => {
      await resetControls(childId);
      await setControls(childId, { daily_minute_limit: 240, session_minute_limit: 10 });

      const conversationId = (await startConversation(alice, childId)).json<{ id: string }>().id;
      await harness.db.query(
        `update conversations set started_at = now() - interval '15 minutes' where id = $1`,
        [conversationId],
      );

      expect((await say(alice, conversationId)).json<{ status: string }>().status).toBe('ended');
      await resetControls(childId);
    });

    it('a child cannot use the app outside the allowed days', async () => {
      await resetControls(childId);
      // Every day except today.
      const today = new Date().getUTCDay() === 0 ? 7 : new Date().getUTCDay();
      const others = [1, 2, 3, 4, 5, 6, 7].filter((d) => d !== today);
      await setControls(childId, { allowed_days: others });

      const response = await startConversation(alice, childId);
      expect(response.statusCode).toBe(400);
      expect(response.json().error.details[0].issue).toContain('outside_allowed_days');

      await resetControls(childId);
    });

    it('a child cannot use the app during quiet hours', async () => {
      await resetControls(childId);
      // A window that certainly contains now.
      await setControls(childId, { quiet_hours_start: '00:00', quiet_hours_end: '23:59' });

      const response = await startConversation(alice, childId);
      expect(response.statusCode).toBe(400);
      expect(response.json().error.details[0].issue).toContain('quiet_hours');

      await resetControls(childId);
    });

    it('a child cannot request a character outside the allowlist', async () => {
      await resetControls(childId);
      const { rows } = await harness.db.query<{ id: string; slug: string }>(
        `select id, slug from ai_characters where slug in ('buddy-the-dog', 'lily-the-fairy')
          order by slug`,
      );
      const [buddy, lily] = rows as [{ id: string }, { id: string }];

      await setControls(childId, { allowed_character_ids: [buddy.id] });

      // Directly requesting the excluded character, which is exactly what a
      // client-side allowlist would not stop.
      const refused = await harness.app.inject({
        method: 'POST',
        url: '/api/conversations/start',
        headers: authHeader(alice.accessToken),
        payload: { childId, characterId: lily.id },
      });
      expect(refused.statusCode).toBe(400);
      expect(refused.json().error.details[0].issue).toContain('character_not_allowed');

      const allowed = await harness.app.inject({
        method: 'POST',
        url: '/api/conversations/start',
        headers: authHeader(alice.accessToken),
        payload: { childId, characterId: buddy.id },
      });
      expect(allowed.statusCode).toBe(201);

      await resetControls(childId);
    });

    it('a child cannot request a language the lock forbids', async () => {
      await resetControls(childId);
      await setControls(childId, { language_lock: 'ur' });

      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/conversations/start',
        headers: authHeader(alice.accessToken),
        payload: { childId, language: 'en' },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error.details[0].issue).toContain('language_not_allowed');
      await resetControls(childId);
    });

    it('voice is not a way around the controls', async () => {
      await resetControls(childId);
      const conversationId = (await startConversation(alice, childId)).json<{ id: string }>().id;
      await setControls(childId, { is_paused: true });

      const body = multipart(
        { conversationId },
        { field: 'audio', filename: 'turn.wav', contentType: 'audio/wav', bytes: silentWav(1_000) },
      );
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/voice/turns',
        headers: { ...authHeader(alice.accessToken), ...body.headers },
        payload: body.payload,
      });

      expect(response.json<{ status: string }>().status).toBe('ended');

      const { rows } = await harness.db.query<{ n: number }>(
        'select count(*)::int as n from messages where conversation_id = $1',
        [conversationId],
      );
      expect(rows[0]!.n).toBe(0);

      await resetControls(childId);
    });

    it('practice is not a way around the controls', async () => {
      await resetControls(childId);
      await setControls(childId, { is_paused: true });

      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/practice/sessions',
        headers: authHeader(alice.accessToken),
        payload: { childId, exerciseKey: 'phonics.th_sounds' },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error.details[0].issue).toContain('paused');
      await resetControls(childId);
    });

    it('a practice session opened before a pause cannot be continued', async () => {
      await resetControls(childId);
      const sessionId = (
        await harness.app.inject({
          method: 'POST',
          url: '/api/practice/sessions',
          headers: authHeader(alice.accessToken),
          payload: { childId, exerciseKey: 'phonics.th_sounds' },
        })
      ).json<{ id: string }>().id;

      await setControls(childId, { is_paused: true });

      const body = multipart(
        { sequence: '0' },
        { field: 'audio', filename: 'try.wav', contentType: 'audio/wav', bytes: silentWav(1_000) },
      );
      const response = await harness.app.inject({
        method: 'POST',
        url: `/api/practice/sessions/${sessionId}/attempts`,
        headers: { ...authHeader(alice.accessToken), ...body.headers },
        payload: body.payload,
      });

      expect(response.statusCode).toBe(400);
      await resetControls(childId);
    });

    it('a parent cannot loosen the controls by writing the table directly', async () => {
      // The last line: even with a valid session, the write path is the API and
      // the API validates. RLS permits a parent to update their own child's row,
      // so this asserts the CHECK constraints hold rather than the policy.
      await expect(
        harness.db.query(
          'update parental_controls set daily_minute_limit = 9999 where child_id = $1',
          [childId],
        ),
      ).rejects.toThrow();
    });

    it('leaves the controls unchanged after every attempt above', async () => {
      const { rows } = await harness.db.query<{
        is_paused: boolean;
        daily_minute_limit: number;
      }>('select is_paused, daily_minute_limit from parental_controls where child_id = $1', [
        childId,
      ]);

      expect(rows[0]).toMatchObject({ is_paused: false, daily_minute_limit: 20 });
    });
  });
});
