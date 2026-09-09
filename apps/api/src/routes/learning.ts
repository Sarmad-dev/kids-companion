import { asSystem, type Database, type Queryable } from '@kids/db';
import {
  calculateConsistencyIndicators,
  calculateMilestones,
  calculateSkillLevels,
  INDICATORS_PREAMBLE,
  longestActiveStreak,
  weekStartFor,
  type DailyProgress,
  type LearningEvent,
  type LearningStore,
  type SkillLevel,
  type WeeklyProgress,
} from '@kids/learning';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { requireChildOwnership } from '../plugins/auth.js';

/**
 * The learning dashboard.
 *
 *   GET /api/learning/progress?childId=…&period=daily|weekly
 *   GET /api/learning/levels?childId=…
 *   GET /api/learning/milestones?childId=…
 *   GET /api/learning/indicators?childId=…
 *
 * EVERY ROUTE IS READ-ONLY AND SCOPED TO ONE CHILD. Events are recorded by the
 * subsystems that produce them — a conversation turn, a practice attempt — not
 * by a client posting whatever it likes into a parent's dashboard.
 *
 * Ownership is enforced twice: `requireChildOwnership` in the handler, and RLS
 * on every table underneath. The second is the one that holds, because the first
 * is application code that a new route can forget.
 */

export interface LearningRoutesOptions {
  readonly db: Database;
}

/* -------------------------------------------------------------------------- */
/* Response schemas                                                            */
/* -------------------------------------------------------------------------- */
/* Note the absence of `successCount`, of any percentage against a benchmark,   */
/* and of any field named for a rate of progress. This subsystem reports        */
/* activity, and there is no shape here a parent could read as a comparison.    */

const dailySchema = z.object({
  day: z.string(),
  conversationMinutes: z.number(),
  conversationTurns: z.number().int(),
  conversationCount: z.number().int(),
  wordsUsed: z.number().int(),
  newVocabulary: z.number().int(),
  storiesCompleted: z.number().int(),
  exercisesCompleted: z.number().int(),
  pronunciationAttempts: z.number().int(),
  pronunciationAverage: z.number().nullable(),
  active: z.boolean(),
});

const weeklySchema = dailySchema
  .omit({ day: true, active: true })
  .extend({ weekStart: z.string(), activeDays: z.number().int() });

const levelSchema = z.enum(['getting_started', 'growing', 'confident']);

interface DailyRow {
  day: string;
  conversation_seconds: number;
  conversation_turns: number;
  conversation_count: number;
  words_used: number;
  new_vocabulary: number;
  stories_completed: number;
  exercises_completed: number;
  pronunciation_score_sum: number;
  pronunciation_score_count: number;
}

const toDaily = (row: DailyRow): DailyProgress => ({
  day: typeof row.day === 'string' ? row.day : new Date(row.day).toISOString().slice(0, 10),
  conversationSeconds: row.conversation_seconds,
  conversationMinutes: Math.round((row.conversation_seconds / 60) * 10) / 10,
  conversationTurns: row.conversation_turns,
  conversationCount: row.conversation_count,
  wordsUsed: row.words_used,
  newVocabulary: row.new_vocabulary,
  storiesCompleted: row.stories_completed,
  exercisesCompleted: row.exercises_completed,
  pronunciationScoreSum: row.pronunciation_score_sum,
  pronunciationScoreCount: row.pronunciation_score_count,
  pronunciationAverage:
    row.pronunciation_score_count === 0
      ? null
      : row.pronunciation_score_sum / row.pronunciation_score_count,
  active:
    row.conversation_turns +
      row.words_used +
      row.stories_completed +
      row.exercises_completed +
      row.pronunciation_score_count >
    0,
});

const presentDaily = (d: DailyProgress) => ({
  day: d.day,
  conversationMinutes: d.conversationMinutes,
  conversationTurns: d.conversationTurns,
  conversationCount: d.conversationCount,
  wordsUsed: d.wordsUsed,
  newVocabulary: d.newVocabulary,
  storiesCompleted: d.storiesCompleted,
  exercisesCompleted: d.exercisesCompleted,
  pronunciationAttempts: d.pronunciationScoreCount,
  pronunciationAverage: d.pronunciationAverage,
  active: d.active,
});

const presentWeekly = (w: WeeklyProgress) => ({
  weekStart: w.weekStart,
  conversationMinutes: w.conversationMinutes,
  conversationTurns: w.conversationTurns,
  conversationCount: w.conversationCount,
  wordsUsed: w.wordsUsed,
  newVocabulary: w.newVocabulary,
  storiesCompleted: w.storiesCompleted,
  exercisesCompleted: w.exercisesCompleted,
  pronunciationAttempts: w.pronunciationScoreCount,
  pronunciationAverage: w.pronunciationAverage,
  activeDays: w.activeDays,
});

const loadDays = async (
  tx: Queryable,
  childId: string,
  limit: number,
): Promise<DailyProgress[]> => {
  const { rows } = await tx.query<DailyRow>(
    `select day::text as day, conversation_seconds, conversation_turns, conversation_count,
            words_used, new_vocabulary, stories_completed, exercises_completed,
            pronunciation_score_sum, pronunciation_score_count
       from learning_daily
      where child_id = $1
      order by day desc
      limit $2`,
    [childId, limit],
  );
  return rows.map(toDaily);
};

export const learningRoutes =
  (options: LearningRoutesOptions): FastifyPluginAsyncZod =>
  async (app) => {
    /* ---------------------------------------------------------------------- */
    /* Progress                                                               */
    /* ---------------------------------------------------------------------- */

    app.get(
      '/learning/progress',
      {
        onRequest: [app.authenticate],
        preHandler: [app.authorize('conversations:read_own')],
        schema: {
          querystring: z.object({
            childId: z.uuid(),
            period: z.enum(['daily', 'weekly']).default('daily'),
            limit: z.coerce.number().int().min(1).max(90).default(30),
          }),
          response: {
            200: z.object({
              period: z.enum(['daily', 'weekly']),
              days: z.array(dailySchema),
              weeks: z.array(weeklySchema),
            }),
          },
        },
      },
      async (request, reply) => {
        const { childId, period, limit } = request.query;

        const data = await app.withParent(request, async (tx) => {
          await requireChildOwnership(tx, childId);

          if (period === 'daily') {
            return { days: await loadDays(tx, childId, limit), weeks: [] as WeeklyProgress[] };
          }

          const { rows } = await tx.query<DailyRow & { week_start: string; active_days: number }>(
            `select week_start::text as week_start, active_days, conversation_seconds,
                    conversation_turns, conversation_count, words_used, new_vocabulary,
                    stories_completed, exercises_completed,
                    pronunciation_score_sum, pronunciation_score_count
               from learning_weekly
              where child_id = $1
              order by week_start desc
              limit $2`,
            [childId, limit],
          );

          const weeks: WeeklyProgress[] = rows.map((row) => {
            const daily = toDaily({ ...row, day: row.week_start });
            return {
              ...daily,
              weekStart:
                typeof row.week_start === 'string'
                  ? row.week_start
                  : new Date(row.week_start).toISOString().slice(0, 10),
              activeDays: row.active_days,
              days: [],
            };
          });

          return { days: [] as DailyProgress[], weeks };
        });

        return await reply.status(200).send({
          period,
          days: data.days.map(presentDaily),
          weeks: data.weeks.map(presentWeekly),
        });
      },
    );

    /* ---------------------------------------------------------------------- */
    /* Levels                                                                 */
    /* ---------------------------------------------------------------------- */

    app.get(
      '/learning/levels',
      {
        onRequest: [app.authenticate],
        preHandler: [app.authorize('conversations:read_own')],
        schema: {
          querystring: z.object({ childId: z.uuid() }),
          response: {
            200: z.object({
              vocabularyLevel: levelSchema,
              pronunciationLevel: levelSchema,
              conversationSkillLevel: levelSchema,
              basis: z.record(z.string(), z.number()),
              /** Says what the bands are and are not. Shipped with the levels, always. */
              note: z.string(),
            }),
          },
        },
      },
      async (request, reply) => {
        const levels = await app.withParent(request, async (tx) => {
          await requireChildOwnership(tx, request.query.childId);
          return await computeLevels(tx, request.query.childId);
        });

        return await reply.status(200).send({
          ...levels,
          // Load-bearing. Three words with no scale behind them still invite the
          // question "compared to what?", and this is the answer.
          note:
            'These describe how your child has used the app so far. They are not a ' +
            'score, not a grade, and not a comparison with other children — we have ' +
            'no information about other children. Levels only ever go up.',
        });
      },
    );

    /* ---------------------------------------------------------------------- */
    /* Milestones                                                             */
    /* ---------------------------------------------------------------------- */

    app.get(
      '/learning/milestones',
      {
        onRequest: [app.authenticate],
        preHandler: [app.authorize('conversations:read_own')],
        schema: {
          querystring: z.object({ childId: z.uuid() }),
          response: {
            200: z.object({
              achieved: z.array(
                z.object({ key: z.string(), title: z.string(), achievedAt: z.string() }),
              ),
              note: z.string(),
            }),
          },
        },
      },
      async (request, reply) => {
        const achieved = await app.withParent(request, async (tx) => {
          await requireChildOwnership(tx, request.query.childId);

          const { rows } = await tx.query<{
            milestone_key: string;
            title: string;
            achieved_at: string;
          }>(
            `select milestone_key, title, achieved_at from learning_milestones
              where child_id = $1 order by achieved_at desc`,
            [request.query.childId],
          );
          return rows;
        });

        return await reply.status(200).send({
          achieved: achieved.map((m) => ({
            key: m.milestone_key,
            title: m.title,
            achievedAt: new Date(m.achieved_at).toISOString(),
          })),
          note: 'These are things your child has done. They are not stages children are expected to reach by a particular age.',
        });
      },
    );

    /* ---------------------------------------------------------------------- */
    /* Consistency indicators                                                 */
    /* ---------------------------------------------------------------------- */

    app.get(
      '/learning/indicators',
      {
        onRequest: [app.authenticate],
        preHandler: [app.authorize('conversations:read_own')],
        schema: {
          description: 'Observations about app usage. NOT a screening tool — see the preamble.',
          querystring: z.object({ childId: z.uuid() }),
          response: {
            200: z.object({
              preamble: z.string(),
              indicators: z.array(
                z.object({
                  key: z.string(),
                  observation: z.string(),
                  suggestion: z.string(),
                  notAClaim: z.string(),
                }),
              ),
            }),
          },
        },
      },
      async (request, reply) => {
        const indicators = await app.withParent(request, async (tx) => {
          await requireChildOwnership(tx, request.query.childId);

          const days = await loadDays(tx, request.query.childId, 28);

          const { rows: weekRows } = await tx.query<{ week_start: string; active_days: number }>(
            `select week_start::text as week_start, active_days from learning_weekly
              where child_id = $1 order by week_start desc limit 4`,
            [request.query.childId],
          );

          const weeks = weekRows.map((row): WeeklyProgress => ({
            weekStart:
              typeof row.week_start === 'string'
                ? row.week_start
                : new Date(row.week_start).toISOString().slice(0, 10),
            activeDays: row.active_days,
            conversationSeconds: 0,
            conversationMinutes: 0,
            conversationTurns: 0,
            conversationCount: 0,
            wordsUsed: 0,
            newVocabulary: 0,
            storiesCompleted: 0,
            exercisesCompleted: 0,
            pronunciationScoreSum: 0,
            pronunciationScoreCount: 0,
            pronunciationAverage: null,
            days: [],
          }));

          const lastActive = days.find((d) => d.active);
          const daysSinceLastActivity =
            lastActive === undefined
              ? null
              : Math.floor(
                  (Date.now() - new Date(`${lastActive.day}T00:00:00.000Z`).getTime()) / 86_400_000,
                );

          return calculateConsistencyIndicators({
            recentDays: days,
            recentWeeks: weeks,
            daysSinceLastActivity,
          });
        });

        return await reply.status(200).send({
          // Always first, and never optional. Without it, a list of observations
          // under a heading is read as a report about a child.
          preamble: INDICATORS_PREAMBLE,
          indicators: indicators.map((i) => ({
            key: i.key,
            observation: i.observation,
            suggestion: i.suggestion,
            notAClaim: i.notAClaim,
          })),
        });
      },
    );

    void options;
  };

/* -------------------------------------------------------------------------- */
/* Level computation                                                           */
/* -------------------------------------------------------------------------- */

interface LevelRow {
  vocabulary_level: SkillLevel;
  pronunciation_level: SkillLevel;
  conversation_skill_level: SkillLevel;
  basis: Record<string, number>;
}

const computeLevels = async (tx: Queryable, childId: string) => {
  const { rows: totals } = await tx.query<{
    distinct_vocabulary: number;
    turns: number;
    conversations: number;
    attempts: number;
    score_sum: number;
    active_days: number;
  }>(
    `select
       (select count(*)::int from child_vocabulary where child_id = $1) as distinct_vocabulary,
       coalesce((select sum(conversation_turns)::int from learning_daily where child_id = $1), 0) as turns,
       coalesce((select sum(conversation_count)::int from learning_daily where child_id = $1), 0) as conversations,
       coalesce((select sum(pronunciation_score_count)::int from learning_daily where child_id = $1), 0) as attempts,
       coalesce((select sum(pronunciation_score_sum)::real from learning_daily where child_id = $1), 0) as score_sum,
       coalesce((select count(*)::int from learning_daily
                  where child_id = $1
                    and day >= (now() at time zone 'utc')::date - 28
                    and conversation_turns + words_used + stories_completed
                        + exercises_completed + pronunciation_score_count > 0), 0) as active_days`,
    [childId],
  );

  const t = totals[0] ?? {
    distinct_vocabulary: 0,
    turns: 0,
    conversations: 0,
    attempts: 0,
    score_sum: 0,
    active_days: 0,
  };

  const { rows: stored } = await tx.query<LevelRow>(
    `select vocabulary_level, pronunciation_level, conversation_skill_level, basis
       from learning_skill_levels where child_id = $1`,
    [childId],
  );

  const previous = stored[0];

  return calculateSkillLevels(
    {
      distinctVocabulary: t.distinct_vocabulary,
      totalConversationTurns: t.turns,
      totalConversations: t.conversations,
      pronunciationAttempts: t.attempts,
      pronunciationAverage: t.attempts === 0 ? null : t.score_sum / t.attempts,
      recentActiveDays: t.active_days,
    },
    previous
      ? {
          vocabularyLevel: previous.vocabulary_level,
          pronunciationLevel: previous.pronunciation_level,
          conversationSkillLevel: previous.conversation_skill_level,
          basis: previous.basis,
        }
      : undefined,
  );
};

/* -------------------------------------------------------------------------- */
/* The store                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The database behind `recordLearningEvent`.
 *
 * Runs under the SYSTEM context: events are produced by the conversation and
 * practice paths on behalf of a child, and the rollup tables are SELECT-only for
 * a parent by design. A progress dashboard a parent could write to is not a
 * progress dashboard.
 */
export const createLearningStore = (db: Database): LearningStore => ({
  append: async (event: LearningEvent): Promise<boolean> =>
    await asSystem(db, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `insert into learning_events
           (child_id, event_type, skill_key, conversation_id, speech_practice_id,
            payload, occurred_at, idempotency_key)
         values ($1, $2, $3, $4, $5, $6, $7, $8)
         -- The unique index is PARTIAL, so the inference has to repeat its
         -- predicate; without it Postgres cannot match the index at all.
         on conflict (child_id, idempotency_key) where idempotency_key is not null do nothing
         returning id`,
        [
          event.childId,
          event.eventType,
          event.skillKey ?? null,
          event.conversationId ?? null,
          event.speechPracticeId ?? null,
          JSON.stringify(event.payload ?? {}),
          event.occurredAt,
          event.idempotencyKey ?? null,
        ],
      );
      // No row means the idempotency key had already been used. Not an error —
      // a retried request must not double-count a child's morning.
      return rows.length > 0;
    }),

  rebuildDay: async (childId: string, day: string): Promise<void> => {
    await asSystem(db, async (tx) => {
      await tx.query('select app.rebuild_learning_daily($1, $2::date)', [childId, day]);
    });
  },

  rebuildWeek: async (childId: string, weekStart: string): Promise<void> => {
    await asSystem(db, async (tx) => {
      await tx.query('select app.rebuild_learning_weekly($1, $2::date)', [childId, weekStart]);
    });
  },
});

/**
 * Recomputes levels and awards milestones for one child.
 *
 * Separate from the event write, and idempotent, so it can run after a batch of
 * events, on a schedule, or after a backfill without producing a different
 * answer or a duplicate celebration.
 */
export const refreshLearningState = async (
  db: Database,
  childId: string,
): Promise<{ levels: Awaited<ReturnType<typeof computeLevels>>; milestones: readonly string[] }> =>
  await asSystem(db, async (tx) => {
    const levels = await computeLevels(tx, childId);

    await tx.query(
      `insert into learning_skill_levels
         (child_id, vocabulary_level, pronunciation_level, conversation_skill_level, basis, computed_at)
       values ($1, $2, $3, $4, $5, now())
       on conflict (child_id) do update
         set vocabulary_level         = excluded.vocabulary_level,
             pronunciation_level      = excluded.pronunciation_level,
             conversation_skill_level = excluded.conversation_skill_level,
             basis                    = excluded.basis,
             computed_at              = now(),
             updated_at               = now()`,
      [
        childId,
        levels.vocabularyLevel,
        levels.pronunciationLevel,
        levels.conversationSkillLevel,
        JSON.stringify(levels.basis),
      ],
    );

    const { rows: totals } = await tx.query<{
      vocabulary: number;
      conversations: number;
      stories: number;
      exercises: number;
      attempts: number;
    }>(
      `select
         (select count(*)::int from child_vocabulary where child_id = $1) as vocabulary,
         coalesce((select sum(conversation_count)::int from learning_daily where child_id = $1), 0) as conversations,
         coalesce((select sum(stories_completed)::int from learning_daily where child_id = $1), 0) as stories,
         coalesce((select sum(exercises_completed)::int from learning_daily where child_id = $1), 0) as exercises,
         coalesce((select sum(pronunciation_score_count)::int from learning_daily where child_id = $1), 0) as attempts`,
      [childId],
    );

    const days = await loadDays(tx, childId, 365);

    const { rows: held } = await tx.query<{ milestone_key: string }>(
      'select milestone_key from learning_milestones where child_id = $1',
      [childId],
    );

    const t = totals[0] ?? {
      vocabulary: 0,
      conversations: 0,
      stories: 0,
      exercises: 0,
      attempts: 0,
    };

    const earned = calculateMilestones({
      distinctVocabulary: t.vocabulary,
      totalConversations: t.conversations,
      totalStories: t.stories,
      totalExercises: t.exercises,
      pronunciationAttempts: t.attempts,
      longestActiveDayStreak: longestActiveStreak(days),
      alreadyAchieved: held.map((h) => h.milestone_key),
    });

    for (const milestone of earned) {
      await tx.query(
        `insert into learning_milestones (child_id, milestone_key, title)
         values ($1, $2, $3) on conflict do nothing`,
        [childId, milestone.key, milestone.title],
      );
    }

    return { levels, milestones: earned.map((m) => m.key) };
  });

export { weekStartFor };
