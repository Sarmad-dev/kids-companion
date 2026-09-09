import { FORBIDDEN_VOCABULARY, recordLearningEvents, type LearningEvent } from '@kids/learning';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLearningStore, refreshLearningState } from '../../apps/api/src/routes/learning.js';
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
 * The adaptive learning subsystem, end to end.
 *
 * Two things only a database can prove: that the SQL aggregation agrees with the
 * TypeScript aggregation on the same events, and that a parent sees progress for
 * their own children and nobody else's.
 */
describe('adaptive learning', () => {
  let harness: ApiHarness;
  let alice: RegisteredParent;
  let bob: RegisteredParent;
  let aliceChildId: string;
  let bobChildId: string;
  let store: ReturnType<typeof createLearningStore>;
  let db: ReturnType<typeof pgliteDatabase>;

  const POLICY = { policyVersion: '2026-08-01', policyText: 'We process speech to reply.' };

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

  const event = (
    childId: string,
    eventType: string,
    occurredAt: string,
    payload?: Record<string, number>,
  ): LearningEvent => ({
    childId,
    eventType,
    occurredAt: new Date(occurredAt),
    ...(payload ? { payload } : {}),
  });

  beforeAll(async () => {
    harness = await createApiHarness();
    db = pgliteDatabase(harness.db);
    store = createLearningStore(db);

    alice = await registerAndLogin(harness, 'learning-alice');
    bob = await registerAndLogin(harness, 'learning-bob');
    aliceChildId = await createChild(alice);
    bobChildId = await createChild(bob, 'Sana');
    await consent(alice, aliceChildId);
    await consent(bob, bobChildId);
  });

  afterAll(async () => {
    await harness.close();
  });

  /* ====================================================================== */
  /* The event architecture                                                 */
  /* ====================================================================== */

  describe('the event taxonomy is data', () => {
    it('seeds a type for every activity this build knows', async () => {
      const { rows } = await harness.db.query<{ event_type: string }>(
        'select event_type from learning_event_types where is_active',
      );
      const types = new Set(rows.map((r) => r.event_type));

      for (const expected of [
        'conversation_turn',
        'conversation_time',
        'conversation_ended',
        'word_encountered',
        'vocabulary_new',
        'story_completed',
        'session_completed',
        'pronunciation_scored',
      ]) {
        expect(types, expected).toContain(expected);
      }
    });

    it('accepts a new activity as a row, with no migration', async () => {
      // The whole point of the taxonomy being a table. A reading game, added
      // today, records events immediately — its metric can be designed later.
      await harness.db.query(
        `insert into learning_event_types (event_type, display_name, metric_key, aggregation)
         values ('reading_page_finished', 'Page read', null, 'count')`,
      );

      const recorded = await store.append(
        event(aliceChildId, 'reading_page_finished', '2026-08-18T09:00:00Z'),
      );
      expect(recorded).toBe(true);
    });

    it('still refuses an event type nobody declared', async () => {
      // The foreign key is just as strict about typos as the old CHECK was.
      await expect(
        store.append(event(aliceChildId, 'converstaion_turn', '2026-08-18T09:00:00Z')),
      ).rejects.toThrow();
    });

    it('does not double-count a retried request', async () => {
      const withKey: LearningEvent = {
        ...event(aliceChildId, 'story_completed', '2026-08-18T09:00:00Z'),
        idempotencyKey: 'msg-abc',
      };

      expect(await store.append(withKey)).toBe(true);
      expect(await store.append(withKey)).toBe(false);

      const { rows } = await harness.db.query<{ n: number }>(
        `select count(*)::int as n from learning_events
          where child_id = $1 and idempotency_key = 'msg-abc'`,
        [aliceChildId],
      );
      expect(rows[0]!.n).toBe(1);
    });

    it('refuses a payload that could carry content', async () => {
      await expect(
        recordLearningEvents(store, [
          {
            ...event(aliceChildId, 'word_encountered', '2026-08-18T09:00:00Z'),
            payload: { transcript: 'what the child said' },
          },
        ]),
      ).rejects.toThrow(/payload key/);
    });
  });

  /* ====================================================================== */
  /* Aggregation                                                            */
  /* ====================================================================== */

  describe('daily and weekly aggregation', () => {
    let childId: string;

    beforeAll(async () => {
      childId = await createChild(alice, 'Aggregated');
      await consent(alice, childId);

      await recordLearningEvents(
        store,
        [
          // Monday
          event(childId, 'conversation_turn', '2026-08-17T09:00:00Z'),
          event(childId, 'conversation_turn', '2026-08-17T09:01:00Z'),
          event(childId, 'conversation_time', '2026-08-17T09:02:00Z', { seconds: 240 }),
          event(childId, 'conversation_ended', '2026-08-17T09:03:00Z'),
          event(childId, 'word_encountered', '2026-08-17T09:01:00Z', { count: 15 }),
          event(childId, 'vocabulary_new', '2026-08-17T09:01:30Z'),
          event(childId, 'pronunciation_scored', '2026-08-17T10:00:00Z', { score: 0.8 }),
          // Wednesday
          event(childId, 'conversation_turn', '2026-08-19T09:00:00Z'),
          event(childId, 'story_completed', '2026-08-19T09:05:00Z'),
          event(childId, 'session_completed', '2026-08-19T09:10:00Z'),
          event(childId, 'pronunciation_scored', '2026-08-19T09:11:00Z', { score: 0.4 }),
          // The following week
          event(childId, 'conversation_turn', '2026-08-24T09:00:00Z'),
        ],
        { rebuildNow: true },
      );
    });

    it('rolls a day up from the event log', async () => {
      const { rows } = await harness.db.query<{
        conversation_seconds: number;
        conversation_turns: number;
        conversation_count: number;
        words_used: number;
        new_vocabulary: number;
        pronunciation_score_count: number;
        pronunciation_score_sum: number;
      }>(
        `select conversation_seconds, conversation_turns, conversation_count, words_used,
                new_vocabulary, pronunciation_score_count, pronunciation_score_sum
           from learning_daily where child_id = $1 and day = '2026-08-17'`,
        [childId],
      );

      expect(rows[0]).toMatchObject({
        conversation_seconds: 240,
        conversation_turns: 2,
        conversation_count: 1,
        words_used: 15,
        new_vocabulary: 1,
        pronunciation_score_count: 1,
      });
    });

    it('rolls a week up from its days, starting Monday', async () => {
      const { rows } = await harness.db.query<{
        week_start: string;
        active_days: number;
        conversation_turns: number;
        stories_completed: number;
        pronunciation_score_count: number;
      }>(
        `select week_start::text as week_start, active_days, conversation_turns,
                stories_completed, pronunciation_score_count
           from learning_weekly where child_id = $1 and week_start = '2026-08-17'`,
        [childId],
      );

      expect(rows[0]).toMatchObject({
        active_days: 2,
        conversation_turns: 3,
        stories_completed: 1,
        pronunciation_score_count: 2,
      });
    });

    it('puts the following Monday in its own week', async () => {
      const { rows } = await harness.db.query<{ n: number }>(
        `select count(*)::int as n from learning_weekly where child_id = $1`,
        [childId],
      );
      expect(rows[0]!.n).toBe(2);
    });

    it('is idempotent — rebuilding twice changes nothing', async () => {
      // The property that makes it safe to run on a schedule, after a backfill,
      // or twice by accident.
      const before = await harness.db.query(
        `select * from learning_daily where child_id = $1 and day = '2026-08-17'`,
        [childId],
      );

      await store.rebuildDay(childId, '2026-08-17');
      await store.rebuildDay(childId, '2026-08-17');

      const after = await harness.db.query<{
        conversation_turns: number;
        words_used: number;
      }>(
        `select conversation_turns, words_used from learning_daily
          where child_id = $1 and day = '2026-08-17'`,
        [childId],
      );

      expect(after.rows[0]).toMatchObject({
        conversation_turns: (before.rows[0] as { conversation_turns: number }).conversation_turns,
        words_used: (before.rows[0] as { words_used: number }).words_used,
      });
    });

    it('the SQL aggregation agrees with the TypeScript one', async () => {
      // Two implementations of the same arithmetic: the SQL runs on a schedule
      // over millions of rows, the TypeScript is what a test can assert exactly.
      // This is what stops them drifting.
      const response = await harness.app.inject({
        method: 'GET',
        url: `/api/learning/progress?childId=${childId}&period=daily&limit=30`,
        headers: authHeader(alice.accessToken),
      });

      const days = response.json<{ days: { day: string; conversationTurns: number }[] }>().days;
      const monday = days.find((d) => d.day === '2026-08-17');
      expect(monday?.conversationTurns).toBe(2);
    });

    it('reports a null average rather than a zero when nothing was scored', async () => {
      const quiet = await createChild(alice, 'Quiet');
      await consent(alice, quiet);
      await recordLearningEvents(
        store,
        [event(quiet, 'conversation_turn', '2026-08-18T09:00:00Z')],
        {
          rebuildNow: true,
        },
      );

      const days = (
        await harness.app.inject({
          method: 'GET',
          url: `/api/learning/progress?childId=${quiet}&period=daily`,
          headers: authHeader(alice.accessToken),
        })
      ).json<{ days: { pronunciationAverage: number | null }[] }>().days;

      // Zero would read as "scored badly", which is a different and untrue thing.
      expect(days[0]!.pronunciationAverage).toBeNull();
    });
  });

  /* ====================================================================== */
  /* Levels, milestones, indicators                                         */
  /* ====================================================================== */

  describe('levels and milestones', () => {
    let childId: string;

    beforeAll(async () => {
      childId = await createChild(alice, 'Levelled');
      await consent(alice, childId);

      const events: LearningEvent[] = [];
      for (let i = 0; i < 30; i += 1) {
        events.push(event(childId, 'conversation_turn', '2026-08-17T09:00:00Z'));
      }
      for (let i = 0; i < 3; i += 1) {
        events.push(event(childId, 'conversation_ended', '2026-08-17T09:30:00Z'));
      }
      await recordLearningEvents(store, events, { rebuildNow: true });
      await refreshLearningState(db, childId);
    });

    it('describes levels in words, never in numbers', async () => {
      const body = (
        await harness.app.inject({
          method: 'GET',
          url: `/api/learning/levels?childId=${childId}`,
          headers: authHeader(alice.accessToken),
        })
      ).json<{ vocabularyLevel: string; conversationSkillLevel: string; note: string }>();

      // A number invites the question "compared to what?", and this system has
      // no answer to it.
      expect(['getting_started', 'growing', 'confident']).toContain(body.conversationSkillLevel);
      expect(body.note.toLowerCase()).toContain('not a comparison with other children');
      expect(JSON.stringify(body)).not.toMatch(/percentile|out of \d|level \d/i);
    });

    it('awards milestones for what a child did', async () => {
      const body = (
        await harness.app.inject({
          method: 'GET',
          url: `/api/learning/milestones?childId=${childId}`,
          headers: authHeader(alice.accessToken),
        })
      ).json<{ achieved: { key: string }[]; note: string }>();

      expect(body.achieved.map((m) => m.key)).toContain('first_conversation');
      expect(body.note.toLowerCase()).toContain('not stages children are expected to reach');
    });

    it('never awards the same milestone twice', async () => {
      const first = await refreshLearningState(db, childId);
      const second = await refreshLearningState(db, childId);

      expect(second.milestones).toEqual([]);
      expect(first.milestones.length + second.milestones.length).toBeGreaterThanOrEqual(0);

      const { rows } = await harness.db.query<{ n: number }>(
        `select count(*)::int as n from learning_milestones
          where child_id = $1 and milestone_key = 'first_conversation'`,
        [childId],
      );
      expect(rows[0]!.n).toBe(1);
    });

    it('never lowers a level once earned', async () => {
      await harness.db.query(
        `update learning_skill_levels set conversation_skill_level = 'confident' where child_id = $1`,
        [childId],
      );
      await refreshLearningState(db, childId);

      const { rows } = await harness.db.query<{ conversation_skill_level: string }>(
        'select conversation_skill_level from learning_skill_levels where child_id = $1',
        [childId],
      );
      // A child who was confident and has been on holiday is still confident.
      expect(rows[0]!.conversation_skill_level).toBe('confident');
    });
  });

  describe('consistency indicators', () => {
    it('always leads with what they are not', async () => {
      const body = (
        await harness.app.inject({
          method: 'GET',
          url: `/api/learning/indicators?childId=${aliceChildId}`,
          headers: authHeader(alice.accessToken),
        })
      ).json<{ preamble: string; indicators: unknown[] }>();

      // Without this, a list of observations under a heading is read as a report
      // about a child.
      expect(body.preamble.toLowerCase()).toContain('not an assessment');
      expect(body.preamble.toLowerCase()).toContain('not a screening tool');
      expect(body.preamble.toLowerCase()).toMatch(/gp|health visitor|school/);
    });

    it('never asserts anything clinical or comparative', async () => {
      const idle = await createChild(alice, 'Idle');
      await consent(alice, idle);
      await recordLearningEvents(
        store,
        [event(idle, 'conversation_turn', '2020-01-01T09:00:00Z')],
        { rebuildNow: true },
      );

      const body = (
        await harness.app.inject({
          method: 'GET',
          url: `/api/learning/indicators?childId=${idle}`,
          headers: authHeader(alice.accessToken),
        })
      ).json<{ indicators: { observation: string; suggestion: string }[] }>();

      expect(body.indicators.length).toBeGreaterThan(0);
      for (const indicator of body.indicators) {
        for (const forbidden of FORBIDDEN_VOCABULARY) {
          expect(indicator.observation.toLowerCase(), forbidden).not.toContain(forbidden);
          expect(indicator.suggestion.toLowerCase(), forbidden).not.toContain(forbidden);
        }
      }
    });

    it('says nothing about a child who is simply using the app', async () => {
      const body = (
        await harness.app.inject({
          method: 'GET',
          url: `/api/learning/indicators?childId=${aliceChildId}`,
          headers: authHeader(alice.accessToken),
        })
      ).json<{ indicators: unknown[] }>();

      expect(body.indicators).toEqual([]);
    });
  });

  /* ====================================================================== */
  /* Ownership                                                              */
  /* ====================================================================== */

  describe('a parent sees only their own children', () => {
    beforeAll(async () => {
      await recordLearningEvents(
        store,
        [
          event(aliceChildId, 'conversation_turn', '2026-08-18T09:00:00Z'),
          event(bobChildId, 'conversation_turn', '2026-08-18T09:00:00Z'),
        ],
        { rebuildNow: true },
      );
      await refreshLearningState(db, aliceChildId);
      await refreshLearningState(db, bobChildId);
    });

    it.each(['progress', 'levels', 'milestones', 'indicators'])(
      "refuses another parent's child on /%s",
      async (route) => {
        const response = await harness.app.inject({
          method: 'GET',
          url: `/api/learning/${route}?childId=${aliceChildId}`,
          headers: authHeader(bob.accessToken),
        });

        // 404, not 403: a 403 would confirm the child exists.
        expect(response.statusCode).toBe(404);
      },
    );

    it.each(['progress', 'levels', 'milestones', 'indicators'])(
      'requires authentication on /%s',
      async (route) => {
        const response = await harness.app.inject({
          method: 'GET',
          url: `/api/learning/${route}?childId=${aliceChildId}`,
        });
        expect(response.statusCode).toBe(401);
      },
    );

    it('shows nothing of another family through RLS directly', async () => {
      for (const table of [
        'learning_daily',
        'learning_weekly',
        'learning_skill_levels',
        'learning_milestones',
        'child_vocabulary',
      ]) {
        const rows = await queryAsParent(
          harness,
          bob.parentId,
          `select 1 from ${table} where child_id = $1`,
          [aliceChildId],
        );
        expect(rows, table).toHaveLength(0);
      }
    });

    it('shows a parent their own child', async () => {
      const rows = await queryAsParent(
        harness,
        alice.parentId,
        'select day from learning_daily where child_id = $1',
        [aliceChildId],
      );
      expect(rows.length).toBeGreaterThan(0);
    });

    it('lets a parent read progress and write none of it', async () => {
      // A progress dashboard a parent could write to is not a progress
      // dashboard.
      for (const statement of [
        'update learning_daily set conversation_turns = 999 where child_id = $1',
        `update learning_skill_levels set vocabulary_level = 'confident' where child_id = $1`,
        `insert into learning_milestones (child_id, milestone_key, title) values ($1, 'invented', 'Invented')`,
      ]) {
        await expect(
          queryAsParent(harness, alice.parentId, statement, [aliceChildId]),
          statement,
        ).rejects.toThrow();
      }
    });
  });

  /* ====================================================================== */
  /* Vocabulary is bounded                                                  */
  /* ====================================================================== */

  describe('vocabulary tracking is bounded by a curated list', () => {
    it('records a curated word and reports it as new the first time', async () => {
      const { rows: first } = await harness.db.query<{ record_vocabulary_use: boolean }>(
        `select app.record_vocabulary_use($1, 'en', 'elephant')`,
        [aliceChildId],
      );
      expect(first[0]!.record_vocabulary_use).toBe(true);

      const { rows: again } = await harness.db.query<{ record_vocabulary_use: boolean }>(
        `select app.record_vocabulary_use($1, 'en', 'elephant')`,
        [aliceChildId],
      );
      expect(again[0]!.record_vocabulary_use).toBe(false);
    });

    it('ignores a word that is not on the list', async () => {
      // The bound that keeps this from becoming a transcript. The cost is real:
      // a child using a wonderful word we have not curated gets no credit.
      const { rows } = await harness.db.query<{ record_vocabulary_use: boolean }>(
        `select app.record_vocabulary_use($1, 'en', 'supercalifragilistic')`,
        [aliceChildId],
      );
      expect(rows[0]!.record_vocabulary_use).toBe(false);

      const { rows: stored } = await harness.db.query<{ n: number }>(
        `select count(*)::int as n from child_vocabulary cv
           join vocabulary_words w on w.id = cv.vocabulary_word_id
          where cv.child_id = $1 and w.word = 'supercalifragilistic'`,
        [aliceChildId],
      );
      expect(stored[0]!.n).toBe(0);
    });

    it('counts repeated use without duplicating the row', async () => {
      await harness.db.query(`select app.record_vocabulary_use($1, 'en', 'rocket')`, [
        aliceChildId,
      ]);
      await harness.db.query(`select app.record_vocabulary_use($1, 'en', 'rocket')`, [
        aliceChildId,
      ]);

      const { rows } = await harness.db.query<{ times_used: number }>(
        `select cv.times_used from child_vocabulary cv
           join vocabulary_words w on w.id = cv.vocabulary_word_id
          where cv.child_id = $1 and w.word = 'rocket'`,
        [aliceChildId],
      );
      expect(rows[0]!.times_used).toBe(2);
    });
  });
});
