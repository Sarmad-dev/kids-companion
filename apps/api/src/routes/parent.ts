import type { Database, Queryable } from '@kids/db';
import { INDICATORS_PREAMBLE } from '@kids/learning';
import { PRACTICE_DISCLAIMER } from '@kids/practice';
import { notFound, validationFailed } from '@kids/shared';
import type { Clock } from '@kids/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { auditOrFail, type AuditLogger } from '../audit.js';
import { evaluateParentalGate, loadParentalControls } from '../parental-gate.js';
import { requireChildOwnership } from '../plugins/auth.js';

/**
 * The parent dashboard.
 *
 *   GET /api/parent/dashboard/:childId   today, this week, and what is set
 *   GET /api/parent/progress/:childId    the longer view
 *   GET /api/parent/controls/:childId    what is set, on its own
 *   PUT /api/parent/controls/:childId    change the settings
 *
 * Two things worth knowing before reading further.
 *
 * **The controls this endpoint writes are enforced in `parental-gate.ts`**, on
 * every path a child can reach. Saving a setting here that nothing enforced
 * would be worse than having no setting: a promise the product does not keep,
 * with no way for a parent to discover it.
 *
 * **Safety events are shown as counts and categories, never as content.** A
 * parent seeing "three moments were redirected this week, one about secrets" has
 * what they need to start a conversation with their child. Showing them the
 * transcript would mean this product stores one, and it does not
 * (docs/CHILD_SAFETY.md §10).
 */

export interface ParentRoutesOptions {
  readonly db: Database;
  readonly audit: AuditLogger;
  readonly clock: Clock;
  /**
   * The operator retention ceiling, in days.
   *
   * Needed here so a parent is shown the retention that APPLIES rather than the
   * one they asked for. The two differ whenever the operator policy is shorter.
   */
  readonly transcriptRetentionCeilingDays: number;
}

/* -------------------------------------------------------------------------- */
/* Schemas                                                                     */
/* -------------------------------------------------------------------------- */

const TIME = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

const controlsSchema = z.object({
  dailyMinuteLimit: z.number().int().min(0).max(240),
  sessionMinuteLimit: z.number().int().min(0).max(120),
  quietHoursStart: z.string().nullable(),
  quietHoursEnd: z.string().nullable(),
  allowedDays: z.array(z.number().int().min(1).max(7)),
  allowedCharacterIds: z.array(z.string()),
  blockedTopics: z.array(z.string()),
  languageLock: z.string().nullable(),
  contentFilterLevel: z.enum(['standard', 'strict']),
  transcriptRetentionDays: z.number().int(),
  /**
   * What retention is doing, rather than what was asked for.
   *
   * `effectiveDays` is the number that APPLIES — the shorter of this setting
   * and the operator ceiling. A parent who asks for 365 where the operator
   * policy is 90 should be told 90, not shown their own request back and
   * quietly given something else.
   *
   * The counts are how a parent checks the promise was kept. Counts only: an
   * answer to "what do you still have?" must not itself be a copy of it.
   */
  transcriptRetention: z.object({
    effectiveDays: z.number().int(),
    heldMessages: z.number().int(),
    deletedMessages: z.number().int(),
    oldestHeldAt: z.string().nullable(),
  }),
  isPaused: z.boolean(),
  notifications: z.object({
    onSafetyFlag: z.boolean(),
    onDailySummary: z.boolean(),
    onWeeklySummary: z.boolean(),
    onTimeLimit: z.boolean(),
  }),
});

const activitySchema = z.object({
  conversationMinutes: z.number(),
  conversationCount: z.number().int(),
  conversationTurns: z.number().int(),
  wordsUsed: z.number().int(),
  newVocabulary: z.number().int(),
  storiesCompleted: z.number().int(),
  exercisesCompleted: z.number().int(),
  pronunciationAttempts: z.number().int(),
  pronunciationAverage: z.number().nullable(),
});

const safetySummarySchema = z.object({
  /** Counts and categories only. Never what was said. */
  total: z.number().int(),
  escalated: z.number().int(),
  byCategory: z.array(z.object({ category: z.string(), count: z.number().int() })),
  note: z.string(),
});

const dashboardSchema = z.object({
  childId: z.string(),
  displayName: z.string(),
  ageGroup: z.string(),
  today: activitySchema,
  thisWeek: activitySchema.extend({ activeDays: z.number().int() }),
  usage: z.object({
    minutesUsedToday: z.number().int(),
    minutesRemainingToday: z.number().int().nullable(),
    dailyMinuteLimit: z.number().int(),
    /** Why a child is currently stopped, if they are. The PARENT-facing reason. */
    currentlyBlockedBy: z.string().nullable(),
  }),
  levels: z.object({
    vocabularyLevel: z.string(),
    pronunciationLevel: z.string(),
    conversationSkillLevel: z.string(),
    note: z.string(),
  }),
  milestones: z.array(z.object({ key: z.string(), title: z.string(), achievedAt: z.string() })),
  safety: safetySummarySchema,
  controls: controlsSchema,
});

interface ActivityRow {
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

const EMPTY_ACTIVITY: ActivityRow = {
  conversation_seconds: 0,
  conversation_turns: 0,
  conversation_count: 0,
  words_used: 0,
  new_vocabulary: 0,
  stories_completed: 0,
  exercises_completed: 0,
  pronunciation_score_sum: 0,
  pronunciation_score_count: 0,
};

const presentActivity = (row: ActivityRow) => ({
  conversationMinutes: Math.round((row.conversation_seconds / 60) * 10) / 10,
  conversationCount: row.conversation_count,
  conversationTurns: row.conversation_turns,
  wordsUsed: row.words_used,
  newVocabulary: row.new_vocabulary,
  storiesCompleted: row.stories_completed,
  exercisesCompleted: row.exercises_completed,
  pronunciationAttempts: row.pronunciation_score_count,
  pronunciationAverage:
    row.pronunciation_score_count === 0
      ? null
      : row.pronunciation_score_sum / row.pronunciation_score_count,
});

const ACTIVITY_COLUMNS = `conversation_seconds, conversation_turns, conversation_count,
        words_used, new_vocabulary, stories_completed, exercises_completed,
        pronunciation_score_sum, pronunciation_score_count`;

const loadControlsRow = async (tx: Queryable, childId: string, ceilingDays: number) => {
  const { rows } = await tx.query<{
    daily_minute_limit: number;
    session_minute_limit: number;
    quiet_hours_start: string | null;
    quiet_hours_end: string | null;
    allowed_days: number[];
    allowed_character_ids: string[];
    blocked_topics: string[];
    language_lock: string | null;
    content_filter_level: 'standard' | 'strict';
    transcript_retention_days: number;
    is_paused: boolean;
    notify_on_safety_flag: boolean;
    notify_on_daily_summary: boolean;
    notify_on_weekly_summary: boolean;
    notify_on_time_limit: boolean;
  }>(
    `select daily_minute_limit, session_minute_limit, quiet_hours_start, quiet_hours_end,
            allowed_days, allowed_character_ids, blocked_topics, language_lock,
            content_filter_level, transcript_retention_days, is_paused,
            notify_on_safety_flag, notify_on_daily_summary, notify_on_weekly_summary,
            notify_on_time_limit
       from parental_controls where child_id = $1`,
    [childId],
  );

  const row = rows[0];
  if (!row) throw notFound();

  /* Both come from the database rather than being computed here, so the number
   * a parent is shown is the same one the sweep acts on. Two implementations of
   * "the shorter of the two" would eventually disagree, and the one the parent
   * could see would be the wrong one. */
  const { rows: retention } = await tx.query<{
    effective_days: number;
    held: number;
    redacted: number;
    oldest_held: string | null;
  }>(
    `select app.effective_transcript_retention_days($1, $2) as effective_days,
            s.held, s.redacted, s.oldest_held
       from app.transcript_retention_status($1) s`,
    [childId, ceilingDays],
  );

  const status = retention[0];

  return {
    transcriptRetention: {
      effectiveDays: status?.effective_days ?? row.transcript_retention_days,
      heldMessages: status?.held ?? 0,
      deletedMessages: status?.redacted ?? 0,
      oldestHeldAt: status?.oldest_held == null ? null : new Date(status.oldest_held).toISOString(),
    },
    dailyMinuteLimit: row.daily_minute_limit,
    sessionMinuteLimit: row.session_minute_limit,
    quietHoursStart: row.quiet_hours_start,
    quietHoursEnd: row.quiet_hours_end,
    allowedDays: row.allowed_days,
    allowedCharacterIds: row.allowed_character_ids,
    blockedTopics: row.blocked_topics,
    languageLock: row.language_lock,
    contentFilterLevel: row.content_filter_level,
    transcriptRetentionDays: row.transcript_retention_days,
    isPaused: row.is_paused,
    notifications: {
      onSafetyFlag: row.notify_on_safety_flag,
      onDailySummary: row.notify_on_daily_summary,
      onWeeklySummary: row.notify_on_weekly_summary,
      onTimeLimit: row.notify_on_time_limit,
    },
  };
};

export const parentRoutes =
  (options: ParentRoutesOptions): FastifyPluginAsyncZod =>
  async (app) => {
    /* ---------------------------------------------------------------------- */
    /* GET /api/parent/dashboard/:childId                                     */
    /* ---------------------------------------------------------------------- */

    app.get(
      '/parent/dashboard/:childId',
      {
        onRequest: [app.authenticate],
        preHandler: [app.authorize('conversations:read_own')],
        schema: {
          params: z.object({ childId: z.uuid() }),
          response: { 200: dashboardSchema },
        },
      },
      async (request, reply) => {
        const { childId } = request.params;

        const data = await app.withParent(request, async (tx) => {
          await requireChildOwnership(tx, childId);

          const { rows: child } = await tx.query<{ display_name: string; age_group: string }>(
            `select display_name, app.age_group(birth_year, birth_month) as age_group
               from children where id = $1 and deleted_at is null`,
            [childId],
          );
          if (!child[0]) throw notFound();

          const { rows: today } = await tx.query<ActivityRow>(
            `select ${ACTIVITY_COLUMNS} from learning_daily
              where child_id = $1 and day = (now() at time zone 'utc')::date`,
            [childId],
          );

          const { rows: week } = await tx.query<ActivityRow & { active_days: number }>(
            `select ${ACTIVITY_COLUMNS}, active_days from learning_weekly
              where child_id = $1
                and week_start = (now() at time zone 'utc')::date
                                 - (extract(isodow from (now() at time zone 'utc')::date)::int - 1)`,
            [childId],
          );

          const { rows: levels } = await tx.query<{
            vocabulary_level: string;
            pronunciation_level: string;
            conversation_skill_level: string;
          }>(
            `select vocabulary_level, pronunciation_level, conversation_skill_level
               from learning_skill_levels where child_id = $1`,
            [childId],
          );

          const { rows: milestones } = await tx.query<{
            milestone_key: string;
            title: string;
            achieved_at: string;
          }>(
            `select milestone_key, title, achieved_at from learning_milestones
              where child_id = $1 order by achieved_at desc limit 20`,
            [childId],
          );

          // COUNTS AND CATEGORIES ONLY. `content_flags` has never stored what was
          // said, and this query could not show it if it wanted to.
          const { rows: safetyTotals } = await tx.query<{ total: number; escalated: number }>(
            `select count(*)::int as total,
                    count(*) filter (where decision = 'escalated')::int as escalated
               from content_flags
              where child_id = $1 and created_at >= now() - interval '30 days'`,
            [childId],
          );

          const { rows: byCategory } = await tx.query<{ category: string; count: number }>(
            `select unnest(categories) as category, count(*)::int as count
               from content_flags
              where child_id = $1 and created_at >= now() - interval '30 days'
              group by 1 order by 2 desc limit 10`,
            [childId],
          );

          const controls = await loadControlsRow(
            tx,
            childId,
            options.transcriptRetentionCeilingDays,
          );
          const gateInputs = await loadParentalControls(tx, childId);
          const gate = evaluateParentalGate({ controls: gateInputs, clock: options.clock });

          return {
            child: child[0],
            today: today[0] ?? EMPTY_ACTIVITY,
            week: week[0] ?? { ...EMPTY_ACTIVITY, active_days: 0 },
            levels: levels[0],
            milestones,
            safety: {
              total: safetyTotals[0]?.total ?? 0,
              escalated: safetyTotals[0]?.escalated ?? 0,
              byCategory,
            },
            controls,
            usage: {
              secondsUsedToday: gateInputs.secondsUsedToday,
              minutesRemaining: gate.minutesRemaining,
              dailyMinuteLimit: gateInputs.dailyMinuteLimit,
              blockedBy: gate.allowed ? null : (gate.denial ?? null),
            },
          };
        });

        return await reply.status(200).send({
          childId,
          displayName: data.child.display_name,
          ageGroup: data.child.age_group,
          today: presentActivity(data.today),
          thisWeek: { ...presentActivity(data.week), activeDays: data.week.active_days },
          usage: {
            minutesUsedToday: Math.floor(data.usage.secondsUsedToday / 60),
            minutesRemainingToday: data.usage.minutesRemaining,
            dailyMinuteLimit: data.usage.dailyMinuteLimit,
            currentlyBlockedBy: data.usage.blockedBy,
          },
          levels: {
            vocabularyLevel: data.levels?.vocabulary_level ?? 'getting_started',
            pronunciationLevel: data.levels?.pronunciation_level ?? 'getting_started',
            conversationSkillLevel: data.levels?.conversation_skill_level ?? 'getting_started',
            note:
              'These describe how your child has used the app so far. They are not a ' +
              'score, not a grade, and not a comparison with other children.',
          },
          milestones: data.milestones.map((m) => ({
            key: m.milestone_key,
            title: m.title,
            achievedAt: new Date(m.achieved_at).toISOString(),
          })),
          safety: {
            total: data.safety.total,
            escalated: data.safety.escalated,
            byCategory: data.safety.byCategory,
            note:
              'These are moments the app steered away from a topic. We record that it ' +
              'happened and what kind of topic it was — never what was said. A count ' +
              'here is not a worry in itself; children ask about everything.',
          },
          controls: data.controls,
        });
      },
    );

    /* ---------------------------------------------------------------------- */
    /* GET /api/parent/progress/:childId                                      */
    /* ---------------------------------------------------------------------- */

    app.get(
      '/parent/progress/:childId',
      {
        onRequest: [app.authenticate],
        preHandler: [app.authorize('conversations:read_own')],
        schema: {
          params: z.object({ childId: z.uuid() }),
          querystring: z.object({ days: z.coerce.number().int().min(1).max(90).default(30) }),
          response: {
            200: z.object({
              daily: z.array(activitySchema.extend({ day: z.string(), active: z.boolean() })),
              weekly: z.array(
                activitySchema.extend({ weekStart: z.string(), activeDays: z.number().int() }),
              ),
              vocabulary: z.object({
                distinctWords: z.number().int(),
                recent: z.array(z.object({ word: z.string(), firstUsedAt: z.string() })),
              }),
              pronunciation: z.object({
                attempts: z.number().int(),
                average: z.number().nullable(),
                recentByDay: z.array(z.object({ day: z.string(), average: z.number() })),
                disclaimer: z.string(),
              }),
              indicatorsPreamble: z.string(),
            }),
          },
        },
      },
      async (request, reply) => {
        const { childId } = request.params;
        const { days } = request.query;

        const data = await app.withParent(request, async (tx) => {
          await requireChildOwnership(tx, childId);

          const { rows: daily } = await tx.query<ActivityRow & { day: string }>(
            `select day::text as day, ${ACTIVITY_COLUMNS} from learning_daily
              where child_id = $1 order by day desc limit $2`,
            [childId, days],
          );

          const { rows: weekly } = await tx.query<
            ActivityRow & { week_start: string; active_days: number }
          >(
            `select week_start::text as week_start, active_days, ${ACTIVITY_COLUMNS}
               from learning_weekly where child_id = $1 order by week_start desc limit 13`,
            [childId],
          );

          const { rows: vocabTotal } = await tx.query<{ n: number }>(
            'select count(*)::int as n from child_vocabulary where child_id = $1',
            [childId],
          );

          const { rows: vocabRecent } = await tx.query<{ word: string; first_used_at: string }>(
            `select w.word, cv.first_used_at
               from child_vocabulary cv join vocabulary_words w on w.id = cv.vocabulary_word_id
              where cv.child_id = $1 order by cv.first_used_at desc limit 20`,
            [childId],
          );

          return { daily, weekly, vocabTotal: vocabTotal[0]?.n ?? 0, vocabRecent };
        });

        const attempts = data.daily.reduce((sum, d) => sum + d.pronunciation_score_count, 0);
        const scoreSum = data.daily.reduce((sum, d) => sum + d.pronunciation_score_sum, 0);

        return await reply.status(200).send({
          daily: data.daily.map((d) => ({
            ...presentActivity(d),
            day: d.day,
            active:
              d.conversation_turns +
                d.words_used +
                d.stories_completed +
                d.exercises_completed +
                d.pronunciation_score_count >
              0,
          })),
          weekly: data.weekly.map((w) => ({
            ...presentActivity(w),
            weekStart: w.week_start,
            activeDays: w.active_days,
          })),
          vocabulary: {
            distinctWords: data.vocabTotal,
            recent: data.vocabRecent.map((v) => ({
              word: v.word,
              firstUsedAt: new Date(v.first_used_at).toISOString(),
            })),
          },
          pronunciation: {
            attempts,
            average: attempts === 0 ? null : scoreSum / attempts,
            recentByDay: data.daily
              .filter((d) => d.pronunciation_score_count > 0)
              .map((d) => ({
                day: d.day,
                average: d.pronunciation_score_sum / d.pronunciation_score_count,
              })),
            // Travels with every score a parent sees, here as everywhere else.
            disclaimer: PRACTICE_DISCLAIMER,
          },
          indicatorsPreamble: INDICATORS_PREAMBLE,
        });
      },
    );

    /* ---------------------------------------------------------------------- */
    /* GET /api/parent/controls/:childId                                      */
    /* ---------------------------------------------------------------------- */

    /**
     * The controls, on their own.
     *
     * ═══════════════════════════════════════════════════════════════════════
     * WHY THIS EXISTS WHEN THE DASHBOARD ALREADY EMBEDS THEM
     * ═══════════════════════════════════════════════════════════════════════
     *
     * The controls SCREEN needs exactly this and nothing else, and the
     * dashboard is four aggregate queries and a thirty-day activity roll-up.
     * Making a parent wait for a chart in order to see a switch is the wrong
     * trade, and it gets worse every time the dashboard grows.
     *
     * It also has a second caller with a genuinely different need: the CHILD
     * app reads `languageLock` to decide whether to show its one language
     * control. That is a read of a setting, not a change to one, so it takes
     * the read permission — `conversations:read_own` — rather than the manage
     * permission the PUT below requires. A child's device must never hold a
     * capability that can loosen a limit.
     */
    app.get(
      '/parent/controls/:childId',
      {
        onRequest: [app.authenticate],
        preHandler: [app.authorize('conversations:read_own')],
        schema: {
          description: 'The parental controls in force for one child.',
          params: z.object({ childId: z.uuid() }),
          response: { 200: controlsSchema },
        },
      },
      async (request, reply) => {
        const controls = await app.withParent(request, async (tx) => {
          await requireChildOwnership(tx, request.params.childId);
          return await loadControlsRow(
            tx,
            request.params.childId,
            options.transcriptRetentionCeilingDays,
          );
        });

        return await reply.status(200).send(controls);
      },
    );

    /* ---------------------------------------------------------------------- */
    /* PUT /api/parent/controls/:childId                                      */
    /* ---------------------------------------------------------------------- */

    app.put(
      '/parent/controls/:childId',
      {
        onRequest: [app.authenticate],
        // A stricter permission than reading: changing what a child may do is a
        // different act from looking at what they did.
        preHandler: [app.authorize('children:manage_own')],
        schema: {
          description: 'Update parental controls. Every field is enforced server-side.',
          params: z.object({ childId: z.uuid() }),
          body: z
            .object({
              dailyMinuteLimit: z.number().int().min(0).max(240).optional(),
              sessionMinuteLimit: z.number().int().min(0).max(120).optional(),
              quietHoursStart: z.string().regex(TIME).nullable().optional(),
              quietHoursEnd: z.string().regex(TIME).nullable().optional(),
              allowedDays: z.array(z.number().int().min(1).max(7)).max(7).optional(),
              allowedCharacterIds: z.array(z.uuid()).max(20).optional(),
              blockedTopics: z.array(z.string().min(2).max(40)).max(50).optional(),
              languageLock: z.string().min(2).max(5).nullable().optional(),
              contentFilterLevel: z.enum(['standard', 'strict']).optional(),
              transcriptRetentionDays: z.number().int().min(0).max(365).optional(),
              isPaused: z.boolean().optional(),
              notifications: z
                .object({
                  onSafetyFlag: z.boolean().optional(),
                  onDailySummary: z.boolean().optional(),
                  onWeeklySummary: z.boolean().optional(),
                  onTimeLimit: z.boolean().optional(),
                })
                .optional(),
            })
            .strict(),
          response: { 200: controlsSchema },
        },
      },
      async (request, reply) => {
        const { childId } = request.params;
        const body = request.body;

        const updated = await app.withParent(request, async (tx) => {
          await requireChildOwnership(tx, childId);

          const current = await loadControlsRow(
            tx,
            childId,
            options.transcriptRetentionCeilingDays,
          );

          const next = {
            dailyMinuteLimit: body.dailyMinuteLimit ?? current.dailyMinuteLimit,
            sessionMinuteLimit: body.sessionMinuteLimit ?? current.sessionMinuteLimit,
            quietHoursStart:
              body.quietHoursStart === undefined ? current.quietHoursStart : body.quietHoursStart,
            quietHoursEnd:
              body.quietHoursEnd === undefined ? current.quietHoursEnd : body.quietHoursEnd,
            allowedDays: body.allowedDays ?? current.allowedDays,
            allowedCharacterIds: body.allowedCharacterIds ?? current.allowedCharacterIds,
            blockedTopics: body.blockedTopics ?? current.blockedTopics,
            languageLock:
              body.languageLock === undefined ? current.languageLock : body.languageLock,
            contentFilterLevel: body.contentFilterLevel ?? current.contentFilterLevel,
            transcriptRetentionDays:
              body.transcriptRetentionDays ?? current.transcriptRetentionDays,
            isPaused: body.isPaused ?? current.isPaused,
            notifications: { ...current.notifications, ...body.notifications },
          };

          // Checked here as well as by the CHECK constraint, so the parent gets a
          // field-level message rather than a 500 from a constraint name.
          if (next.sessionMinuteLimit > next.dailyMinuteLimit) {
            throw validationFailed([
              { field: 'sessionMinuteLimit', issue: 'cannot exceed the daily limit' },
            ]);
          }
          if ((next.quietHoursStart === null) !== (next.quietHoursEnd === null)) {
            throw validationFailed([
              { field: 'quietHoursStart', issue: 'must be set together with quietHoursEnd' },
            ]);
          }

          await tx.query(
            `update parental_controls
                set daily_minute_limit = $2, session_minute_limit = $3,
                    quiet_hours_start = $4::time, quiet_hours_end = $5::time,
                    allowed_days = $6, allowed_character_ids = $7, blocked_topics = $8,
                    language_lock = $9, content_filter_level = $10,
                    transcript_retention_days = $11, is_paused = $12,
                    notify_on_safety_flag = $13, notify_on_daily_summary = $14,
                    notify_on_weekly_summary = $15, notify_on_time_limit = $16
              where child_id = $1`,
            [
              childId,
              next.dailyMinuteLimit,
              next.sessionMinuteLimit,
              next.quietHoursStart,
              next.quietHoursEnd,
              next.allowedDays,
              next.allowedCharacterIds,
              next.blockedTopics,
              next.languageLock,
              next.contentFilterLevel,
              next.transcriptRetentionDays,
              next.isPaused,
              next.notifications.onSafetyFlag,
              next.notifications.onDailySummary,
              next.notifications.onWeeklySummary,
              next.notifications.onTimeLimit,
            ],
          );

          return await loadControlsRow(tx, childId, options.transcriptRetentionCeilingDays);
        });

        // Changing what a child may do is a sensitive administrative action, and
        // "who loosened this, and when?" has to be answerable.
        await auditOrFail(
          options.audit,
          {
            actorId: request.principal?.parentId,
            actorType: 'parent',
            action: 'parental_controls.updated',
            resourceType: 'child',
            resourceId: childId,
            subjectChildId: childId,
            outcome: 'success',
            metadata: { fields: Object.keys(body) },
          },
          request,
        );

        return await reply.status(200).send(updated);
      },
    );
  };
