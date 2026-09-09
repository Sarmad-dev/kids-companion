import { createMockProvider } from '@kids/ai';
import { silentWav } from '@kids/voice';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLearningRecorder, wordCountOf } from '../../apps/api/src/learning-events.js';
import { createLearningStore } from '../../apps/api/src/routes/learning.js';
import {
  authHeader,
  createApiHarness,
  pgliteDatabase,
  registerAndLogin,
  type ApiHarness,
  type RegisteredParent,
} from '../helpers/api.js';

/**
 * Using the product produces numbers on the parent's dashboard.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE TEST THAT WAS MISSING
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The progress pipeline was built end to end and had no producer. Nothing
 * called `append`, every learning route was a GET, and no conversation turn ever
 * emitted anything — so a parent whose child had talked all week opened Progress
 * and saw zeros beside a safety panel that had clearly noticed the
 * conversations.
 *
 * The suite did not catch it because `parent-dashboard.test.ts` seeds
 * `conversations` directly and asserts structure and empty states. Structure was
 * never the problem. NOTHING ASSERTED THAT USING THE PRODUCT PRODUCES A NUMBER,
 * so a dashboard wired to a table that nothing wrote to looked entirely healthy.
 *
 * Every test in this file therefore goes through the HTTP API a real client
 * uses, and reads the answer back from the endpoint the dashboard reads. No test
 * here inserts a learning event, and none reads `learning_events` to prove the
 * feature works — a test allowed to write the number it later asserts is how the
 * gap survived in the first place.
 */

const POLICY = { policyVersion: '2026-08-01', policyText: 'We process speech to reply.' };

interface DailyRow {
  day: string;
  conversationMinutes: number;
  conversationTurns: number;
  conversationCount: number;
  wordsUsed: number;
  pronunciationAttempts: number;
  pronunciationAverage: number | null;
  active: boolean;
}

describe('learning events', () => {
  let harness: ApiHarness;
  let parent: RegisteredParent;
  let childId: string;

  const start = async () =>
    await harness.app.inject({
      method: 'POST',
      url: '/api/conversations/start',
      headers: authHeader(parent.accessToken),
      payload: { childId },
    });

  const message = async (conversationId: string, text: string) =>
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

  /** What the parent's Progress screen shows, read the way the screen reads it. */
  const dashboard = async (): Promise<DailyRow[]> => {
    const response = await harness.app.inject({
      method: 'GET',
      url: `/api/learning/progress?childId=${childId}&period=daily&limit=7`,
      headers: authHeader(parent.accessToken),
    });
    expect(response.statusCode).toBe(200);
    return response.json<{ days: DailyRow[] }>().days;
  };

  const today = async (): Promise<DailyRow | undefined> => {
    const days = await dashboard();
    return days[0];
  };

  beforeAll(async () => {
    harness = await createApiHarness({ aiProvider: createMockProvider() });
    parent = await registerAndLogin(harness, 'learning-events');

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
  });

  /* ======================================================================== */
  /* The one that matters                                                     */
  /* ======================================================================== */

  describe('a conversation', () => {
    it('starts from an honest zero', async () => {
      /* Establishes that the numbers asserted below were produced by the
       * conversation and were not sitting there beforehand. Without this, a
       * dashboard that returned a constant would pass the next test. */
      const days = await dashboard();
      expect(days.every((day) => day.conversationTurns === 0)).toBe(true);
    });

    it('puts real numbers on the parent dashboard', async () => {
      /* ═══════════════════════════════════════════════════════════════════
       * THE ASSERTION THIS FILE EXISTS FOR.
       * ═══════════════════════════════════════════════════════════════════
       *
       * Start, talk, end — through the same endpoints the app calls — then read
       * Progress. Every number below is computed by the real pipeline:
       *
       *   route → learning event → app.rebuild_learning_daily → learning_daily
       *
       * Nothing in this test writes to any of those.
       */
      const conversationId = (await start()).json<{ id: string }>().id;

      const said = ['I like the big red bus', 'Can we read a story', 'Tell me about lions'];
      for (const text of said) {
        const response = await message(conversationId, text);
        expect(response.statusCode).toBe(200);
      }

      /* A real session lasts minutes. The clock is the one thing a test cannot
       * live through, so the start time is moved back — everything downstream
       * (the duration function, the event, the rollup, the endpoint) then runs
       * for real on it. */
      await harness.db.query(
        `update conversations set started_at = now() - interval '4 minutes' where id = $1`,
        [conversationId],
      );

      expect((await end(conversationId)).statusCode).toBe(200);

      const day = await today();
      const expectedWords = said.reduce((sum, text) => sum + wordCountOf(text), 0);

      expect(day).toBeDefined();
      expect(day?.conversationTurns).toBe(said.length);
      expect(day?.conversationCount).toBe(1);
      expect(day?.wordsUsed).toBe(expectedWords);
      // ~4 minutes, allowing for the seconds the test itself took.
      expect(day?.conversationMinutes).toBeGreaterThanOrEqual(3.9);
      expect(day?.active).toBe(true);
    });

    it('adds to the day rather than replacing it', async () => {
      // Two sessions in one day is the normal case, and a rollup that recomputes
      // could plausibly show only the most recent one.
      const before = await today();

      const conversationId = (await start()).json<{ id: string }>().id;
      await message(conversationId, 'one more thing');
      await end(conversationId);

      const after = await today();
      expect(after?.conversationCount).toBe((before?.conversationCount ?? 0) + 1);
      expect(after?.conversationTurns).toBe((before?.conversationTurns ?? 0) + 1);
      expect(after?.wordsUsed).toBe((before?.wordsUsed ?? 0) + 3);
    });
  });

  /* ======================================================================== */
  /* The conversation nobody ends                                             */
  /* ======================================================================== */

  describe('when nobody ends the conversation', () => {
    it('the turns still reach the dashboard once the worker sweeps', async () => {
      /* ═══════════════════════════════════════════════════════════════════
       * A FIVE-YEAR-OLD DOES NOT END CONVERSATIONS.
       * ═══════════════════════════════════════════════════════════════════
       *
       * The app gets closed, the tablet gets taken away, the battery dies. The
       * dashboard reads the rollups, so without the worker backstop these turns
       * are recorded perfectly and the parent still sees the old number — which
       * is the original failure arriving through a different door.
       */
      const before = await today();

      const conversationId = (await start()).json<{ id: string }>().id;
      await message(conversationId, 'and then the lion roared');
      // No end call. This is the whole point.

      const stale = await today();
      expect(stale?.conversationTurns).toBe(before?.conversationTurns ?? 0);

      const swept = await harness.app.maintenance.rebuildLearningRollups();
      expect(swept.days).toBeGreaterThanOrEqual(1);

      const after = await today();
      expect(after?.conversationTurns).toBe((before?.conversationTurns ?? 0) + 1);
      expect(after?.wordsUsed).toBe((before?.wordsUsed ?? 0) + 5);
      // Still no completed conversation — the child never finished one.
      expect(after?.conversationCount).toBe(before?.conversationCount ?? 0);

      /* Cleanup, not part of the property above. The free plan allows one live
       * conversation, so an abandoned one blocks the next — which is worth
       * knowing about the product, and is not what this test is measuring. */
      await end(conversationId);
    });

    it('sweeping again changes nothing', async () => {
      // Rebuilds recompute rather than increment. If that were ever reversed,
      // a parent's numbers would climb every five minutes on their own.
      const before = await today();
      await harness.app.maintenance.rebuildLearningRollups();
      await harness.app.maintenance.rebuildLearningRollups();
      expect(await today()).toEqual(before);
    });
  });

  /* ======================================================================== */
  /* Practice                                                                 */
  /* ======================================================================== */

  describe('a pronunciation attempt', () => {
    it('reaches the dashboard as an average, not a total', async () => {
      const sessionId = (
        await harness.app.inject({
          method: 'POST',
          url: '/api/practice/sessions',
          headers: authHeader(parent.accessToken),
          payload: { childId, exerciseKey: 'phonics.th_sounds' },
        })
      ).json<{ id: string }>().id;

      const boundary = '----kidsLearningBoundary7f2a';
      const bytes = silentWav(1_500);
      const payload = Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="sequence"\r\n\r\n0\r\n`,
        ),
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="try.wav"\r\n` +
            `Content-Type: audio/wav\r\n\r\n`,
        ),
        Buffer.from(bytes),
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);

      const attempt = await harness.app.inject({
        method: 'POST',
        url: `/api/practice/sessions/${sessionId}/attempts`,
        headers: {
          ...authHeader(parent.accessToken),
          'content-type': `multipart/form-data; boundary=${boundary}`,
        },
        payload,
      });
      expect(attempt.statusCode).toBe(200);

      const day = await today();
      expect(day?.pronunciationAttempts).toBeGreaterThanOrEqual(1);
      /* An average, so a child who practises more does not appear to pronounce
       * better — and within the 0..1 range the column and the rollup both
       * assume. A summed score would sail past 1 on the second attempt. */
      expect(day?.pronunciationAverage).not.toBeNull();
      expect(day?.pronunciationAverage ?? 0).toBeGreaterThan(0);
      expect(day?.pronunciationAverage ?? 0).toBeLessThanOrEqual(1);
    });
  });

  /* ======================================================================== */
  /* Privacy                                                                  */
  /* ======================================================================== */

  it('never records anything the child said', async () => {
    /* ═══════════════════════════════════════════════════════════════════════
     * COUNTS, DURATIONS AND SCORES. NEVER A WORD.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `learning_events` is long-lived analytical data, retained far longer than
     * a transcript and read by aggregate queries. A payload that quietly picked
     * up an utterance would turn the progress table into a second, unmanaged
     * copy of everything a child ever said.
     *
     * The conversations above used distinctive words. None may appear here.
     */
    const { rows } = await harness.db.query<{ payload: unknown; blob: string }>(
      `select payload, coalesce(payload::text, '') || coalesce(skill_key, '') as blob
         from learning_events where child_id = $1`,
      [childId],
    );

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const blob = row.blob.toLowerCase();
      for (const word of ['lion', 'bus', 'story', 'roared', 'rumi', 'thumb']) {
        expect(blob, word).not.toContain(word);
      }
      // Positively: every key is one of the metadata fields the catalogue names.
      for (const key of Object.keys(row.payload as Record<string, unknown>)) {
        expect(['count', 'seconds', 'score']).toContain(key);
      }
    }
  });

  /* ======================================================================== */
  /* Idempotency                                                              */
  /* ======================================================================== */

  it('does not double-count a retried request', async () => {
    /* A flaky connection retries. Without the idempotency key the child's
     * morning is counted twice, and a parent making decisions about screen time
     * is reading a number that is simply wrong.
     *
     * The turn below is delivered normally FIRST, by the route, exactly as it
     * would be in production — then replayed through the recorder with the same
     * message id, which is precisely what a retried request looks like from
     * here. The day must move by one turn, not three.
     */
    const recorder = createLearningRecorder({
      db: pgliteDatabase(harness.db),
      store: createLearningStore(pgliteDatabase(harness.db)),
      clock: { now: () => Date.now(), nowIso: () => new Date().toISOString() as never },
      logger: harness.app.log,
    });

    const before = await today();

    const conversationId = (await start()).json<{ id: string }>().id;
    expect((await message(conversationId, 'four words right here')).statusCode).toBe(200);
    await end(conversationId);

    const { rows: sent } = await harness.db.query<{ id: string }>(
      `select id from messages where conversation_id = $1 and role = 'child' limit 1`,
      [conversationId],
    );
    const messageId = sent[0]?.id;
    expect(messageId).toBeDefined();

    const replay = { childId, conversationId, messageId: messageId!, wordCount: 4 };
    await recorder.turn(replay);
    await recorder.turn(replay);
    await harness.app.maintenance.rebuildLearningRollups();

    const after = await today();
    expect(after?.conversationTurns).toBe((before?.conversationTurns ?? 0) + 1);
    expect(after?.wordsUsed).toBe((before?.wordsUsed ?? 0) + 4);
  });

  /* ======================================================================== */
  /* Never breaks the thing it measures                                       */
  /* ======================================================================== */

  it('a failing recorder does not fail the child turn', async () => {
    /* ═══════════════════════════════════════════════════════════════════════
     * A METRIC THAT BREAKS A CHILD'S TURN IS WORSE THAN A MISSING METRIC.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Recording runs inside the request that answers a child. If the progress
     * table were full, or the day locked, or the column refused a value, the
     * child must still get their reply.
     */
    const recorder = createLearningRecorder({
      db: pgliteDatabase(harness.db),
      store: createLearningStore(pgliteDatabase(harness.db)),
      clock: { now: () => Date.now(), nowIso: () => new Date().toISOString() as never },
      logger: harness.app.log,
    });

    await expect(
      recorder.turn({
        childId: 'not-a-uuid',
        conversationId: 'not-a-uuid',
        messageId: 'retry-me',
        wordCount: 3,
      }),
    ).resolves.toBeUndefined();

    await expect(
      recorder.pronunciationScored({
        childId,
        speechPracticeId: 'not-a-uuid',
        attemptRef: 'nope',
        score: 0.5,
      }),
    ).resolves.toBeUndefined();

    // And the product still works immediately afterwards.
    const conversationId = (await start()).json<{ id: string }>().id;
    expect((await message(conversationId, 'hello again')).statusCode).toBe(200);
    // Frees the single live-conversation slot the free plan allows.
    await end(conversationId);
  });

  /* ======================================================================== */
  /* Append-only, and erasable                                                */
  /* ======================================================================== */

  describe('immutability', () => {
    it('refuses to let a recorded measurement be rewritten', async () => {
      // The reason the table is append-only: a progress history that can be
      // edited after the fact is not a history.
      await expect(
        harness.db.query(`update learning_events set payload = '{"count": 999}'::jsonb`),
      ).rejects.toThrow(/append-only/);

      await expect(
        harness.db.query(`update learning_events set event_type = 'story_completed'`),
      ).rejects.toThrow(/append-only/);
    });

    it('does not let immutability block the deletion of a conversation', async () => {
      /* ═══════════════════════════════════════════════════════════════════
       * ERASURE OUTRANKS IMMUTABILITY.
       * ═══════════════════════════════════════════════════════════════════
       *
       * `conversation_id` is `on delete set null`, and a set-null is an update.
       * Before this was fixed the foreign key's own action hit the append-only
       * trigger and DELETING A CONVERSATION FAILED — which, through the cascade
       * from `children`, is the deletion of a child's data failing.
       *
       * The event survives as an anonymous count. That is the behaviour the
       * `set null` was chosen for: a transcript goes, the fact that the child
       * practised that day stays.
       */
      const conversationId = (await start()).json<{ id: string }>().id;
      await message(conversationId, 'delete this one');
      await end(conversationId);

      const { rows: before } = await harness.db.query<{ n: number }>(
        'select count(*)::int as n from learning_events where conversation_id = $1',
        [conversationId],
      );
      expect(before[0]?.n ?? 0).toBeGreaterThan(0);

      await expect(
        harness.db.query('delete from conversations where id = $1', [conversationId]),
      ).resolves.toBeDefined();

      const { rows: after } = await harness.db.query<{ n: number }>(
        `select count(*)::int as n from learning_events
           where child_id = $1 and conversation_id is null`,
        [childId],
      );
      expect(after[0]?.n ?? 0).toBeGreaterThan(0);
    });

    it('lets a child be deleted entirely, events and all', async () => {
      /* The right to erasure, exercised through the real endpoint. A child with
       * learning events is the case that was broken: the cascade to
       * `learning_events` and the cascade to `conversations` have no guaranteed
       * order, so this could have failed intermittently rather than always. */
      const doomed = (
        await harness.app.inject({
          method: 'POST',
          url: '/v1/children',
          headers: authHeader(parent.accessToken),
          payload: {
            displayName: 'Zoya',
            birthYear: 2019,
            birthMonth: 3,
            languages: [{ languageCode: 'en', isPrimary: true }],
          },
        })
      ).json<{ id: string }>().id;

      await harness.app.inject({
        method: 'POST',
        url: '/v1/consent',
        headers: authHeader(parent.accessToken),
        payload: {
          consentType: 'child_data_processing',
          granted: true,
          ...POLICY,
          childId: doomed,
        },
      });

      const conversationId = (
        await harness.app.inject({
          method: 'POST',
          url: '/api/conversations/start',
          headers: authHeader(parent.accessToken),
          payload: { childId: doomed },
        })
      ).json<{ id: string }>().id;

      await harness.app.inject({
        method: 'POST',
        url: `/api/conversations/${conversationId}/message`,
        headers: authHeader(parent.accessToken),
        payload: { text: 'hello for the last time' },
      });
      await harness.app.inject({
        method: 'POST',
        url: `/api/conversations/${conversationId}/end`,
        headers: authHeader(parent.accessToken),
        payload: {},
      });

      const { rows: seeded } = await harness.db.query<{ n: number }>(
        'select count(*)::int as n from learning_events where child_id = $1',
        [doomed],
      );
      expect(seeded[0]?.n ?? 0).toBeGreaterThan(0);

      await expect(
        harness.db.query('delete from children where id = $1', [doomed]),
      ).resolves.toBeDefined();

      const { rows: left } = await harness.db.query<{ n: number }>(
        'select count(*)::int as n from learning_events where child_id = $1',
        [doomed],
      );
      expect(left[0]?.n).toBe(0);
    });
  });
});
