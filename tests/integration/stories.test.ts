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
 * Stories, as a feature rather than a label.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT WAS ACTUALLY THERE BEFORE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `StoryScreen` was `<ConversationScreen mode="story" />`, and `mode` changed a
 * testID and one line of body text. It did not change the prompt, it did not
 * tell the API anything, and it did not record a story.
 *
 * So `weekly_story_limit` — 3 on the free plan, seeded on day one — was a column
 * nothing read, and `story_completed` was a catalogued event type nothing
 * emitted. The plan table advertised a limit that was never enforced, beside a
 * progress counter that could never move.
 *
 * These tests go through the HTTP API, because "the client sends the mode and
 * the server acts on it" is the entire substance of the fix and a unit test
 * cannot see it.
 */

const POLICY = { policyVersion: '2026-08-01', policyText: 'We process speech to reply.' };

describe('stories', () => {
  let harness: ApiHarness;
  let parent: RegisteredParent;
  let childId: string;

  /**
   * The mock provider, wrapped so a test can read the system prompt it was
   * handed. Unit tests prove `buildSystemPrompt` produces a story section; only
   * this proves the section survives the route, the loader and the context
   * builder and reaches the model.
   */
  let lastPrompt = '';
  const recording = (): AIProvider => {
    const inner = createMockProvider();
    return {
      ...inner,
      generateResponse: async (request) => {
        lastPrompt = request.context.systemPrompt;
        return await inner.generateResponse(request);
      },
    };
  };

  const createChild = async (displayName: string): Promise<string> =>
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

  const consent = async (id: string) => {
    for (const [type, scoped] of [
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
          ...(scoped === undefined ? {} : { childId: scoped }),
        },
      });
    }
  };

  const start = async (id: string, mode?: 'chat' | 'story') =>
    await harness.app.inject({
      method: 'POST',
      url: '/api/conversations/start',
      headers: authHeader(parent.accessToken),
      payload: { childId: id, ...(mode === undefined ? {} : { mode }) },
    });

  const say = async (conversationId: string, text: string) =>
    await harness.app.inject({
      method: 'POST',
      url: `/api/conversations/${conversationId}/message`,
      headers: authHeader(parent.accessToken),
      payload: { text },
    });

  const end = async (conversationId: string) =>
    await harness.app.inject({
      method: 'POST',
      url: `/api/conversations/${conversationId}/end`,
      headers: authHeader(parent.accessToken),
      payload: {},
    });

  /** A whole story: start it, build it over several turns, finish it. */
  const tellAStory = async (id: string, turns = 3): Promise<string> => {
    const conversationId = (await start(id, 'story')).json<{ id: string }>().id;
    for (let i = 0; i < turns; i += 1) {
      await say(conversationId, `and then the fox found a ${String(i)} door`);
    }
    await end(conversationId);
    return conversationId;
  };

  const storiesOnDashboard = async (id: string): Promise<number> => {
    const response = await harness.app.inject({
      method: 'GET',
      url: `/api/learning/progress?childId=${id}&period=daily&limit=7`,
      headers: authHeader(parent.accessToken),
    });
    expect(response.statusCode).toBe(200);
    return response
      .json<{ days: { storiesCompleted: number }[] }>()
      .days.reduce((sum, day) => sum + day.storiesCompleted, 0);
  };

  beforeAll(async () => {
    harness = await createApiHarness({ aiProvider: recording() });
    parent = await registerAndLogin(harness, 'stories');
    childId = await createChild('Rumi');
    await consent(childId);
  }, 180_000);

  afterAll(async () => {
    await harness.close();
  });

  /* ======================================================================== */
  /* The mode reaches the server                                              */
  /* ======================================================================== */

  describe('the mode', () => {
    it('defaults to a chat, so an older client behaves exactly as before', async () => {
      const body = (await start(childId)).json<{ id: string; mode: string }>();
      expect(body.mode).toBe('chat');
      await end(body.id);
    });

    it('is recorded on the conversation when a story is asked for', async () => {
      // The thing that was missing. Without this the server cannot tell the two
      // apart, and nothing downstream can either.
      const started = (await start(childId, 'story')).json<{ id: string; mode: string }>();
      expect(started.mode).toBe('story');

      const { rows } = await harness.db.query<{ mode: string }>(
        'select mode from conversations where id = $1',
        [started.id],
      );
      expect(rows[0]?.mode).toBe('story');
      await end(started.id);
    });

    it('refuses anything that is not a mode we know', async () => {
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/conversations/start',
        headers: authHeader(parent.accessToken),
        payload: { childId, mode: 'interrogation' },
      });
      expect(response.statusCode).toBe(400);
    });
  });

  /* ======================================================================== */
  /* The prompt                                                               */
  /* ======================================================================== */

  describe('what the model is actually told', () => {
    it('gets the story instructions in a story, and not in a chat', async () => {
      /* ═══════════════════════════════════════════════════════════════════
       * THE WIRING, END TO END.
       * ═══════════════════════════════════════════════════════════════════
       *
       * "Story mode changes the prompt" is the substance of this feature, and
       * every piece of it can be individually correct while the mode never
       * reaches the model — which is precisely the state this was in before.
       * So the provider is wrapped and the prompt is read off the wire.
       */
      const child = await createChild('Idris');
      await consent(child);

      const chat = (await start(child, 'chat')).json<{ id: string }>().id;
      await say(chat, 'hello there');
      expect(lastPrompt).not.toContain('Making a story together');
      await end(chat);

      const story = (await start(child, 'story')).json<{ id: string }>().id;
      await say(story, 'once upon a time');
      expect(lastPrompt).toContain('Making a story together');
      expect(lastPrompt).toContain('Never tell the whole story at once');
      await end(story);
    });

    it('drops the story instructions the moment a parent turns stories off', async () => {
      /* The one window in which the mode and the control can disagree: a parent
       * changes the setting while a story is open. The control must win on the
       * child's NEXT turn, not at the end of a session nobody is obliged to
       * end. */
      const child = await createChild('Amina');
      await consent(child);

      const story = (await start(child, 'story')).json<{ id: string }>().id;
      await say(story, 'once upon a time');
      expect(lastPrompt).toContain('Making a story together');

      await harness.db.query(
        'update child_learning_preferences set storytelling_enabled = false where child_id = $1',
        [child],
      );

      await say(story, 'and then what happened');
      expect(lastPrompt).not.toContain('Making a story together');
      expect(lastPrompt).toContain('Do not tell stories.');

      await end(story);
    });
  });

  /* ======================================================================== */
  /* The parental control                                                     */
  /* ======================================================================== */

  describe('when a parent has turned storytelling off', () => {
    it('refuses to start a story at all', async () => {
      /* ═══════════════════════════════════════════════════════════════════
       * A PARENTAL CONTROL IS NOT A REQUEST TO THE MODEL.
       * ═══════════════════════════════════════════════════════════════════
       *
       * `storytelling_enabled` reached the model as a line of prompt text —
       * "Do not tell stories." — and nothing else. A prompt line is layer L2 of
       * five and does not enforce anything on its own; a parent who turns
       * stories off is entitled to more than a polite request.
       */
      const quiet = await createChild('Zoya');
      await consent(quiet);
      await harness.db.query(
        'update child_learning_preferences set storytelling_enabled = false where child_id = $1',
        [quiet],
      );

      const refused = await start(quiet, 'story');
      expect(refused.statusCode).toBe(400);
      expect(refused.body).toContain('turned off');

      // And a plain chat is still perfectly fine — the control is about stories,
      // not about talking.
      const chat = await start(quiet, 'chat');
      expect(chat.statusCode).toBe(201);
      await end(chat.json<{ id: string }>().id);
    });

    it('says nothing a child should not read', async () => {
      // The refusal is rendered by the app, never shown raw, but the envelope
      // must still not carry an internal detail or a database word.
      const quiet = await createChild('Ayla');
      await consent(quiet);
      await harness.db.query(
        'update child_learning_preferences set storytelling_enabled = false where child_id = $1',
        [quiet],
      );

      const refused = await start(quiet, 'story');
      for (const forbidden of ['child_learning_preferences', 'storytelling_enabled', 'select']) {
        expect(refused.body.toLowerCase()).not.toContain(forbidden);
      }
    });
  });

  /* ======================================================================== */
  /* The weekly limit                                                         */
  /* ======================================================================== */

  describe('the weekly story limit', () => {
    it('is enforced on the free plan, and only against stories', async () => {
      /* ═══════════════════════════════════════════════════════════════════
       * THE FREE PLAN HAS ALWAYS SAID THREE STORIES A WEEK.
       * ═══════════════════════════════════════════════════════════════════
       *
       * `subscription_plans.weekly_story_limit` was seeded on day one and read
       * by nothing, so every free account had unlimited stories. A plan table
       * that advertises a limit the server does not apply is a false claim
       * about the product.
       */
      const child = await createChild('Sana');
      await consent(child);

      for (let i = 0; i < 3; i += 1) {
        const story = await start(child, 'story');
        expect(story.statusCode, `story ${String(i + 1)} of 3`).toBe(201);
        await say(story.json<{ id: string }>().id, 'once upon a time');
        await end(story.json<{ id: string }>().id);
      }

      const fourth = await start(child, 'story');
      expect(fourth.statusCode).toBe(429);
      const error = fourth.json<{ error: { code: string; meta: Record<string, unknown> } }>().error;
      expect(error.code).toBe('QUOTA_WEEKLY_STORIES_EXHAUSTED');
      expect(error.meta.limit).toBe(3);
      expect(error.meta.used).toBe(3);
      // The client needs to be able to say WHEN, not just no.
      expect(typeof error.meta.resetsAt).toBe('string');

      // Chatting is untouched. Running out of stories must not end the product
      // for the rest of the week.
      const chat = await start(child, 'chat');
      expect(chat.statusCode).toBe(201);
      await end(chat.json<{ id: string }>().id);
    });

    it('does not spend a story the child never said anything in', async () => {
      /* ═══════════════════════════════════════════════════════════════════
       * A FIVE-YEAR-OLD OPENS THE SCREEN AND THE TABLET GETS TAKEN AWAY.
       * ═══════════════════════════════════════════════════════════════════
       *
       * Counting every start would be simpler and would be wrong: one of their
       * three stories for the week would be gone, and they can neither
       * understand that nor undo it. A session with nothing in it is not a
       * story by any reading a parent would accept.
       */
      const child = await createChild('Bilal');
      await consent(child);

      for (let i = 0; i < 4; i += 1) {
        const opened = await start(child, 'story');
        expect(opened.statusCode, `open ${String(i + 1)}`).toBe(201);
        // Not a word said. Ended only to free the single live-session slot.
        await end(opened.json<{ id: string }>().id);
      }

      const real = await start(child, 'story');
      expect(real.statusCode).toBe(201);
      await end(real.json<{ id: string }>().id);
    });

    it('is unlimited on a paid plan, because null means unlimited', async () => {
      /* The paid plans are seeded with a NULL limit. Treating null as zero
       * would take stories away from exactly the people who paid for them —
       * the most expensive possible reading of that column. */
      const payer = await registerAndLogin(harness, 'stories-paid');
      const before = parent;
      parent = payer;

      await harness.db.query(
        `insert into subscriptions (parent_id, plan_id, rail, status, current_period_start, current_period_end)
         select $1, id, 'mock', 'active', now(), now() + interval '30 days'
           from subscription_plans where code = 'family_monthly'`,
        [payer.parentId],
      );

      const child = await createChild('Noor');
      await consent(child);

      for (let i = 0; i < 5; i += 1) {
        const story = await start(child, 'story');
        expect(story.statusCode, `paid story ${String(i + 1)}`).toBe(201);
        await say(story.json<{ id: string }>().id, 'once upon a time');
        await end(story.json<{ id: string }>().id);
      }

      parent = before;
    });
  });

  /* ======================================================================== */
  /* The dashboard number                                                     */
  /* ======================================================================== */

  describe('the progress counter', () => {
    it('moves when a child finishes a story', async () => {
      /* ═══════════════════════════════════════════════════════════════════
       * THE COUNTER THAT COULD NEVER MOVE.
       * ═══════════════════════════════════════════════════════════════════
       *
       * `story_completed` was a catalogued event type that nothing emitted, so
       * "Stories" on the parent dashboard was structurally always zero.
       */
      const child = await createChild('Hina');
      await consent(child);

      expect(await storiesOnDashboard(child)).toBe(0);
      await tellAStory(child);
      expect(await storiesOnDashboard(child)).toBe(1);
    });

    it('does not count a story the child abandoned halfway', async () => {
      /* The parent dashboard says, in as many words, "a story your child
       * abandoned halfway is not counted, and that is fine". This is that
       * sentence, enforced. */
      const child = await createChild('Yusuf');
      await consent(child);

      const opened = (await start(child, 'story')).json<{ id: string }>().id;
      await say(opened, 'once there was a bear');
      // Ended, but nowhere near a finished story.
      await end(opened);

      expect(await storiesOnDashboard(child)).toBe(0);
    });

    it('does not count a chat as a story, however long it runs', async () => {
      const child = await createChild('Maya');
      await consent(child);

      const chat = (await start(child, 'chat')).json<{ id: string }>().id;
      for (let i = 0; i < 4; i += 1) await say(chat, `tell me about number ${String(i)}`);
      await end(chat);

      expect(await storiesOnDashboard(child)).toBe(0);
    });

    it('counts a story once, however many times it is ended', async () => {
      // Ending is idempotent by design. Two "finished" toasts for one story
      // would be the kind of number a parent notices and stops trusting.
      const child = await createChild('Omar');
      await consent(child);

      const conversationId = await tellAStory(child);
      await end(conversationId);
      await end(conversationId);

      expect(await storiesOnDashboard(child)).toBe(1);
    });
  });
});
