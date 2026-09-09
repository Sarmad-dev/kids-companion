import {
  isConversationStyle,
  isEncouragementStyle,
  isFarewellStyle,
  isGreetingStyle,
  isPersonalityTrait,
  isStoryStyle,
  isVocabularyStyle,
  resolveCharacter,
  substituteName,
  type CharacterConfig,
  type ConversationEngine,
  type HistoryMessage,
  type ProviderRegistry,
} from '@kids/ai';
import { asSystem, type Database, type Queryable } from '@kids/db';
import { notFound, quotaExhausted, subscriptionRequired, validationFailed } from '@kids/shared';
import type { Clock } from '@kids/shared';
import type { AgeGroup, SupportedLanguage } from '@kids/types';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { auditOrFail, type AuditLogger } from '../audit.js';
import { wordCountOf, type LearningRecorder } from '../learning-events.js';
import { CHILD_FACING_MESSAGE, checkParentalGate } from '../parental-gate.js';
import { requireChildOwnership } from '../plugins/auth.js';
import type { EscalationDelivery, EscalationReasonCode } from '../safety-escalation.js';
import type { TurnHealthReporter } from '../turn-health.js';

/**
 * The conversation API.
 *
 *   POST /api/conversations/start        begin a session for one child
 *   POST /api/conversations/:id/message  one turn
 *   GET  /api/conversations/:id          the session and its transcript
 *   POST /api/conversations/:id/end      close it
 *
 * Every request passes the same four gates before it touches anything, in this
 * order, stopping at the first "no": authenticated parent → role permission →
 * ownership of the child → RLS. The last one is the one that matters, because
 * the first three are application code that can be forgotten on a new route and
 * RLS cannot be (docs/DATA_MODEL.md §2).
 *
 * The consent gate is enforced by RLS on `conversations` and `messages`, so a
 * child whose consent state is unsatisfied cannot reach this path even if a
 * check here were forgotten (docs/DATA_MODEL.md §6).
 *
 * NOTHING FROM THE DATABASE IS RETURNED DIRECTLY. Every response is built from a
 * declared Zod schema, field by field, so a column added later cannot appear in
 * a response by accident — response serialisation is a privacy control here, not
 * a formatting convenience (docs/adr/0002).
 */

export interface ConversationRoutesOptions {
  /** Resolves the family's stored preference to an adapter. */
  readonly providers: ProviderRegistry;
  readonly engine: ConversationEngine;
  readonly db: Database;
  readonly audit: AuditLogger;
  readonly maxExchanges: number;
  /**
   * A hard ceiling applied on top of the plan, from configuration.
   *
   * The plan is the product answer; this is the operational one. Whichever is
   * lower wins, so a pricing mistake cannot uncap spend.
   */
  readonly dailyTurnLimit: number;
  readonly encryptionKeyId: string;
  readonly messageRateLimitPerMinute: number;
  readonly startRateLimitPerHour: number;
  readonly clock: Clock;
  /**
   * Routes an escalation to a human. See apps/api/src/safety-escalation.ts.
   *
   * Optional so a test harness that does not care about routing does not have
   * to supply one — but its absence is logged where the escalation is raised,
   * because an escalation nobody is told about is the failure this exists to
   * prevent.
   */
  readonly escalations?: EscalationDelivery;
  /**
   * Reports what a turn says about the backend's health, so the alert
   * conditions have a producer. See apps/api/src/turn-health.ts.
   */
  readonly health?: TurnHealthReporter;
  /**
   * Records what a child did, for the progress dashboard.
   *
   * Optional so a harness that does not care about progress need not supply
   * one — but without it the dashboard's activity numbers stay at zero, which
   * is the defect this exists to fix.
   */
  readonly learning?: LearningRecorder;
}

/**
 * Narrows the pipeline's optional reason to what the ledger accepts.
 *
 * The upstream type already matches; this exists for the case where it is
 * ABSENT. An escalation whose rule cannot be named still has to reach a human,
 * so it is recorded as `unspecified` rather than dropped or, worse, guessed at.
 */
const escalationReasonCode = (reason: string | undefined): EscalationReasonCode =>
  reason === 'signal_category' || reason === 'evasion_of_safety' || reason === 'repeated_attempts'
    ? reason
    : 'unspecified';

/**
 * PLACEHOLDER CODEC — NOT ENCRYPTION.
 *
 * The column is `bytea` and the shape is right, so the real AES-GCM envelope
 * codec drops in without a migration. Named `placeholder` rather than something
 * reassuring, and the key id is recorded as `placeholder` too, so a production
 * row encoded this way is obvious in a query rather than plausible.
 */
const encodeContent = (text: string): Buffer => Buffer.from(text, 'utf8');
const decodeContent = (data: Buffer | Uint8Array | string): string =>
  typeof data === 'string'
    ? Buffer.from(data.replace(/^\\x/, ''), 'hex').toString('utf8')
    : Buffer.from(data).toString('utf8');

/* -------------------------------------------------------------------------- */
/* Response schemas                                                            */
/* -------------------------------------------------------------------------- */
/* These are the API's contract. Note what is absent from every one of them:    */
/* ciphertext, key ids, provider names, model names, token counts, per-turn     */
/* cost, prompt keys, safety detector names. Those are ours. A parent gets      */
/* their child's words and the facts about the session, and nothing that        */
/* describes how the sausage is made or which vendor made it.                  */

const messageSchema = z.object({
  id: z.string(),
  role: z.enum(['child', 'companion']),
  sequence: z.number().int(),
  text: z.string(),
  status: z.enum(['delivered', 'blocked', 'redacted']),
  /** When retention deleted the words. Null while the transcript is still held. */
  redactedAt: z.string().nullable(),
  createdAt: z.string(),
});

const characterSchema = z.object({
  id: z.string(),
  slug: z.string(),
  displayName: z.string(),
});

const conversationSchema = z.object({
  id: z.string(),
  childId: z.string(),
  character: characterSchema,
  language: z.string(),
  status: z.enum(['active', 'ended', 'flagged']),
  mode: z.enum(['chat', 'story']),
  messageCount: z.number().int(),
  turnsUsed: z.number().int(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  endReason: z.string().nullable(),
});

/** What the client needs to render "3 of 20 turns left today" without guessing. */
const limitsSchema = z.object({
  plan: z.string(),
  dailyTurnLimit: z.number().int(),
  dailyTurnsUsed: z.number().int(),
  conversationTurnLimit: z.number().int(),
  resetsAt: z.string(),
});

const turnSchema = z.object({
  reply: z.string(),
  status: z.enum(['ok', 'blocked', 'escalated', 'degraded', 'ended']),
  conversationStatus: z.enum(['active', 'ended', 'flagged']),
  messageId: z.string().nullable(),
  replyMessageId: z.string().nullable(),
  limits: limitsSchema,
});

/* -------------------------------------------------------------------------- */
/* Entitlements                                                                */
/* -------------------------------------------------------------------------- */

interface EntitlementRow {
  plan_code: string;
  tier: 'free' | 'paid';
  subscription_status: string;
  daily_turn_limit: number;
  max_conversation_turns: number;
  concurrent_conversation_limit: number;
  /** NULL means unlimited, which is how the paid plans are seeded. */
  weekly_story_limit: number | null;
}

/**
 * What this parent is allowed, and what they have used.
 *
 * Resolved from our own tables — never from a client claim, and never by calling
 * a payment vendor on the request path (docs/adr/0007).
 */
const loadEntitlements = async (
  tx: Queryable,
  parentId: string,
  childId: string,
  configuredCeiling: number,
): Promise<{
  plan: EntitlementRow;
  dailyTurnLimit: number;
  used: number;
  active: number;
  storiesThisWeek: number;
  resetsAt: string;
}> => {
  const { rows } = await tx.query<EntitlementRow>(
    `select plan_code, tier, subscription_status, daily_turn_limit,
            max_conversation_turns, concurrent_conversation_limit, weekly_story_limit
       from app.parent_entitlements($1)`,
    [parentId],
  );

  // A parent whose plan cannot be resolved is treated as free. Failing open to
  // an unlimited plan because a join missed would be the expensive direction of
  // this mistake.
  const plan: EntitlementRow = rows[0] ?? {
    plan_code: 'free',
    tier: 'free',
    subscription_status: 'free',
    daily_turn_limit: 20,
    max_conversation_turns: 20,
    concurrent_conversation_limit: 1,
    // The free plan's seeded value. Failing open to unlimited stories because a
    // join missed is the expensive direction of this mistake.
    weekly_story_limit: 3,
  };

  const { rows: usage } = await tx.query<{ used: number; active: number; stories: number }>(
    `select app.child_turns_used_today($1) as used,
            app.child_active_conversations($1) as active,
            app.child_stories_this_week($1) as stories`,
    [childId],
  );

  return {
    plan,
    resetsAt: await nextDailyReset(tx),
    // The plan is the product answer, the configured ceiling is the operational
    // one, and the lower of the two wins. A pricing mistake must not uncap spend.
    dailyTurnLimit: Math.min(plan.daily_turn_limit, configuredCeiling),
    used: usage[0]?.used ?? 0,
    active: usage[0]?.active ?? 0,
    storiesThisWeek: usage[0]?.stories ?? 0,
  };
};

/**
 * Midnight UTC — when `app.record_usage` starts a new row.
 *
 * Read from Postgres rather than from the process clock, so the answer the API
 * gives a parent is the same boundary the ledger actually rolls over on. Two
 * clocks disagreeing by a few seconds would show "resets at midnight" while the
 * next turn was still refused.
 */
const nextDailyReset = async (tx: Queryable): Promise<string> => {
  const { rows } = await tx.query<{ resets_at: string | Date }>(
    `select (date_trunc('day', now() at time zone 'utc') + interval '1 day')
              at time zone 'utc' as resets_at`,
  );
  const value = rows[0]?.resets_at;
  return value === undefined ? '' : new Date(value).toISOString();
};

/**
 * How many turns a story needs before finishing it counts as finishing a story.
 *
 * The parent dashboard promises "stories your child finished" and says plainly
 * that "a story your child abandoned halfway is not counted". Something has to
 * decide where halfway is, and any number here is a judgement rather than a
 * measurement — this one is the smallest exchange that can hold a beginning, a
 * middle and an end.
 *
 * Erring low would inflate a number a parent is told means something. Erring
 * high would quietly refuse to credit a real, short story from a three-year-old
 * whose replies are two sentences long.
 */
const STORY_MINIMUM_TURNS = 3;

/**
 * Whether ending this conversation finished a story.
 *
 * Note what is NOT here: a story that is never explicitly ended never reaches
 * this function, so an abandoned story is not counted — which is exactly what
 * the dashboard tells the parent. The rollup backstop in the worker rebuilds
 * the day's turns and minutes for such a session, and records no story.
 */
const isCompletedStory = (row: ConversationRow): boolean =>
  row.mode === 'story' && Math.ceil(row.message_count / 2) >= STORY_MINIMUM_TURNS;

/**
 * Next Monday — when the weekly story allowance starts again.
 *
 * From Postgres for the same reason as `nextDailyReset`: the boundary the API
 * quotes to a parent must be the one `app.child_stories_this_week` counts from,
 * not a second clock that agrees with it most of the time.
 */
const nextWeeklyReset = async (tx: Queryable): Promise<string> => {
  const { rows } = await tx.query<{ resets_at: string | Date }>(
    `select (date_trunc('week', now() at time zone 'utc') + interval '1 week')
              at time zone 'utc' as resets_at`,
  );
  const value = rows[0]?.resets_at;
  return value === undefined ? '' : new Date(value).toISOString();
};

/* -------------------------------------------------------------------------- */
/* Child context                                                               */
/* -------------------------------------------------------------------------- */

interface ChildContextRow {
  child_id: string;
  display_name: string;
  age_group: AgeGroup;
  primary_language: SupportedLanguage;
  correction_style: 'none' | 'gentle' | 'active';
  blocked_topics: string[];
  storytelling_enabled: boolean;
  roleplay_enabled: boolean;
  is_paused: boolean;
  topic_keys: string[];
  /** The family's chosen conversation vendor. NULL = follow the deployment. */
  ai_provider: string | null;
}

/**
 * Everything the engine needs, in one query.
 *
 * One round trip rather than five, because this sits on the latency budget's
 * critical path (ARCHITECTURE.md §7.1) — and because a partially-loaded context
 * is a context missing a parental restriction.
 */
const loadChildContext = async (
  tx: Queryable,
  childId: string,
): Promise<ChildContextRow | undefined> => {
  const { rows } = await tx.query<ChildContextRow>(
    `select c.id as child_id,
            c.display_name,
            app.age_group(c.birth_year, c.birth_month) as age_group,
            coalesce(
              (select cl.language_code from child_languages cl
                where cl.child_id = c.id and cl.is_primary limit 1),
              'en'
            ) as primary_language,
            clp.correction_style,
            pc.blocked_topics,
            clp.storytelling_enabled,
            clp.roleplay_enabled,
            pc.is_paused,
            coalesce(
              array(select clt.topic_key from child_learning_topics clt where clt.child_id = c.id),
              array[]::text[]
            ) as topic_keys,
            p.ai_provider
       from children c
       join child_learning_preferences clp on clp.child_id = c.id
       join parental_controls pc on pc.child_id = c.id
       -- The provider preference rides along on the context read rather than
       -- costing a second round trip on the turn path (ARCHITECTURE.md §7.1).
       join parents p on p.id = c.parent_id
      where c.id = $1 and c.deleted_at is null`,
    [childId],
  );
  return rows[0];
};

interface ConversationRow {
  id: string;
  child_id: string;
  character_id: string;
  slug: string;
  display_name: string;
  language_code: string;
  status: 'active' | 'ended' | 'flagged';
  mode: 'chat' | 'story';
  message_count: number;
  started_at: string;
  ended_at: string | null;
  end_reason: string | null;
}

const CONVERSATION_COLUMNS = `cv.id, cv.child_id, cv.character_id, ch.slug, ch.display_name,
        cv.language_code, cv.status, cv.mode, cv.message_count, cv.started_at, cv.ended_at,
        cv.end_reason`;

/** The single place a conversation row becomes a response body. */
const presentConversation = (row: ConversationRow): z.infer<typeof conversationSchema> => ({
  id: row.id,
  childId: row.child_id,
  character: { id: row.character_id, slug: row.slug, displayName: row.display_name },
  language: row.language_code,
  status: row.status,
  mode: row.mode,
  messageCount: row.message_count,
  // A turn is the round trip, and it is what limits are expressed in. Exposing
  // only `messageCount` would make a client divide by two and get it wrong the
  // first time a turn is blocked and only one message is written.
  turnsUsed: Math.ceil(row.message_count / 2),
  startedAt: new Date(row.started_at).toISOString(),
  endedAt: row.ended_at === null ? null : new Date(row.ended_at).toISOString(),
  endReason: row.end_reason,
});

/**
 * Rate-limit key.
 *
 * The parent, not the IP. A family behind one mobile carrier NAT shares an IP
 * with thousands of strangers, so an IP-keyed limit on this route would be a
 * limit on the carrier. Pre-authentication requests fall back to the IP, which
 * is all there is to key on at that point.
 */
/**
 * Turns a character row into a config, when its traits are valid.
 *
 * Returns `undefined` for a row whose traits do not typecheck — a character
 * with a nonsense personality is refused rather than given a default one,
 * because a default would be a different companion arriving unannounced.
 */
const characterConfigFrom = (row: {
  slug: string;
  display_name: string;
  description: string;
  allowed_age_groups: AgeGroup[];
  personality_traits: string[];
  conversation_style: string;
  vocabulary_style: string;
  encouragement_style: string;
  story_style: string;
  greeting_style: string;
  farewell_style: string;
  educational_objectives: string[];
}): CharacterConfig | undefined => {
  const personality = row.personality_traits.filter(isPersonalityTrait);
  if (
    personality.length === 0 ||
    !isConversationStyle(row.conversation_style) ||
    !isVocabularyStyle(row.vocabulary_style) ||
    !isEncouragementStyle(row.encouragement_style) ||
    !isStoryStyle(row.story_style) ||
    !isGreetingStyle(row.greeting_style) ||
    !isFarewellStyle(row.farewell_style)
  ) {
    return undefined;
  }

  return {
    slug: row.slug,
    displayName: row.display_name,
    description: row.description,
    allowedAgeGroups: row.allowed_age_groups,
    personalityTraits: personality,
    conversationStyle: row.conversation_style,
    vocabularyStyle: row.vocabulary_style,
    encouragementStyle: row.encouragement_style,
    storyStyle: row.story_style,
    greetingStyle: row.greeting_style,
    farewellStyle: row.farewell_style,
    educationalObjectives: row.educational_objectives,
  };
};

const perParent = (request: FastifyRequest): string =>
  request.principal ? `parent:${request.principal.parentId}` : `ip:${request.ip}`;

/**
 * The authenticated parent id.
 *
 * `authenticate` has already run, so this cannot be missing — but asserting that
 * with `!` would mean a route wired without `authenticate` fails as a confusing
 * `undefined` deep inside a query instead of loudly, here.
 */
const parentIdOf = (request: FastifyRequest): string => {
  const principal = request.principal;
  if (!principal) throw new Error('route is missing the authenticate hook');
  return principal.parentId;
};

export const conversationRoutes =
  (options: ConversationRoutesOptions): FastifyPluginAsyncZod =>
    async (app) => {
      const { engine, audit, db } = options;

      /* ---------------------------------------------------------------------- */
      /* 1. POST /api/conversations/start                                       */
      /* ---------------------------------------------------------------------- */

      app.post(
        '/conversations/start',
        {
          onRequest: [app.authenticate],
          preHandler: [app.authorize('conversations:read_own')],
          schema: {
            description:
              'Begin a conversation. Refused unless consent is satisfied and the plan allows it.',
            body: z.object({
              childId: z.uuid(),
              characterId: z.uuid().optional(),
              /** Falls back to the child's primary language. */
              language: z.string().min(2).max(5).optional(),
              /**
               * What kind of session this is. Defaults to `chat`, so a client
               * that has never heard of stories behaves exactly as before.
               */
              mode: z.enum(['chat', 'story']).default('chat'),
            }),
            response: { 201: conversationSchema.extend({ limits: limitsSchema }) },
          },
          config: {
            rateLimit: {
              max: options.startRateLimitPerHour,
              timeWindow: '1 hour',
              keyGenerator: perParent,
            },
          },
        },
        async (request, reply) => {
          const { childId } = request.body;
          const parentId = parentIdOf(request);

          const created = await app.withParent(request, async (tx) => {
            await requireChildOwnership(tx, childId);

            const context = await loadChildContext(tx, childId);
            if (!context) throw notFound();

            // EVERY parental control, not just the pause. This used to check
            // `is_paused` alone, which meant a daily limit, a schedule, and a
            // character allowlist were all settings the server ignored.
            const gate = await checkParentalGate(tx, childId, options.clock, {
              ...(request.body.characterId === undefined
                ? {}
                : { characterId: request.body.characterId }),
              ...(request.body.language === undefined ? {} : { language: request.body.language }),
            });

            if (!gate.result.allowed) {
              throw validationFailed([
                {
                  field: 'childId',
                  issue: `is not permitted right now: ${gate.result.denial ?? 'blocked'}`,
                },
              ]);
            }

            const entitlements = await loadEntitlements(
              tx,
              parentId,
              childId,
              options.dailyTurnLimit,
            );

            if (entitlements.used >= entitlements.dailyTurnLimit) {
              throw quotaExhausted('QUOTA_DAILY_TURNS_EXHAUSTED', {
                limit: entitlements.dailyTurnLimit,
                used: entitlements.used,
                plan: entitlements.plan.plan_code,
                resetsAt: entitlements.resetsAt,
              });
            }

            if (entitlements.active >= entitlements.plan.concurrent_conversation_limit) {
              throw quotaExhausted('QUOTA_CONCURRENT_CONVERSATIONS', {
                limit: entitlements.plan.concurrent_conversation_limit,
                active: entitlements.active,
                plan: entitlements.plan.plan_code,
              });
            }

            if (request.body.mode === 'story') {
              /* ═══════════════════════════════════════════════════════════════
               * THE PARENTAL CONTROL DECIDES WHETHER STORIES EXIST AT ALL.
               * ═══════════════════════════════════════════════════════════════
               *
               * `storytelling_enabled` used to reach the model as a line of
               * prompt text — "Do not tell stories." — and nothing else. That
               * made a parental control into a request. Refusing the session is
               * the enforcement; the prompt line stays as the second layer for a
               * chat that drifts towards a story on its own.
               */
              if (!context.storytelling_enabled) {
                throw validationFailed([
                  { field: 'mode', issue: 'stories are turned off for this child' },
                ]);
              }

              /* NULL is unlimited, which is how the paid plans are seeded.
               * Treating null as zero would take stories away from the people who
               * paid for them. */
              const storyLimit = entitlements.plan.weekly_story_limit;
              if (storyLimit !== null && entitlements.storiesThisWeek >= storyLimit) {
                throw quotaExhausted('QUOTA_WEEKLY_STORIES_EXHAUSTED', {
                  limit: storyLimit,
                  used: entitlements.storiesThisWeek,
                  plan: entitlements.plan.plan_code,
                  resetsAt: await nextWeeklyReset(tx),
                });
              }
            }

            const characterId =
              request.body.characterId ??
              (
                await tx.query<{ id: string | null }>(
                  `select coalesce(
                   (select preferred_character_id from children where id = $1),
                   (select id from ai_characters
                     where status = 'active' and $2 = any(allowed_age_groups)
                       and (not requires_paid_plan or $3)
                     order by sort_order limit 1)
                 ) as id`,
                  [childId, context.age_group, entitlements.plan.tier === 'paid'],
                )
              ).rows[0]?.id;

            if (characterId === undefined || characterId === null) {
              throw validationFailed([
                { field: 'characterId', issue: 'no character is available for this age group' },
              ]);
            }

            // Age suitability is re-checked at creation. A stale
            // `preferred_character_id` survives a birthday that moved the child
            // into a group the character is not offered for.
            const { rows: candidate } = await tx.query<{
              slug: string;
              display_name: string;
              requires_paid_plan: boolean;
              age_ok: boolean;
            }>(
              `select slug, display_name, requires_paid_plan,
                    ($2 = any(allowed_age_groups)) as age_ok
               from ai_characters
              where id = $1 and status in ('active','beta')`,
              [characterId, context.age_group],
            );

            const character = candidate[0];
            if (character?.age_ok !== true) {
              throw validationFailed([
                { field: 'characterId', issue: 'is not available for this age group' },
              ]);
            }

            // A plan gate, never a safety gate. Personas differ in voice and
            // manner only — every one of them runs the identical safety pipeline.
            if (character.requires_paid_plan && entitlements.plan.tier !== 'paid') {
              throw subscriptionRequired({
                plan: entitlements.plan.plan_code,
                requires: 'paid',
                resource: 'character',
              });
            }

            const language = request.body.language ?? context.primary_language;
            const { rows: languageOk } = await tx.query<{ ok: boolean }>(
              `select exists(
               select 1 from character_languages
                where character_id = $1 and language_code = $2
             ) as ok`,
              [characterId, language],
            );
            if (languageOk[0]?.ok !== true) {
              throw validationFailed([
                { field: 'language', issue: 'is not supported by this character' },
              ]);
            }

            // This INSERT is what the consent RLS policy guards. If consent is
            // missing the database refuses it, whatever this handler believes.
            const { rows } = await tx.query<ConversationRow>(
              `with created as (
               insert into conversations (child_id, character_id, language_code, mode)
               values ($1, $2, $3, $4)
               returning *
             )
             select ${CONVERSATION_COLUMNS}
               from created cv join ai_characters ch on ch.id = cv.character_id`,
              [childId, characterId, language, request.body.mode],
            );

            const conversation = rows[0];
            if (!conversation) throw notFound();

            return { conversation, entitlements };
          });

          await asSystem(db, async (tx) => {
            await tx.query('select app.record_usage($1, 0, 0, 1)', [childId]);
          });

          await auditOrFail(
            audit,
            {
              actorId: parentId,
              actorType: 'parent',
              action: 'conversation.started',
              resourceType: 'conversation',
              resourceId: created.conversation.id,
              subjectChildId: childId,
              outcome: 'success',
              metadata: {
                character: created.conversation.slug,
                plan: created.entitlements.plan.plan_code,
                mode: created.conversation.mode,
              },
            },
            request,
          );

          request.log.info(
            {
              requestId: request.requestId,
              conversationId: created.conversation.id,
              plan: created.entitlements.plan.plan_code,
              dailyTurnsUsed: created.entitlements.used,
            },
            'conversation started',
          );

          return await reply.status(201).send({
            ...presentConversation(created.conversation),
            limits: {
              plan: created.entitlements.plan.plan_code,
              dailyTurnLimit: created.entitlements.dailyTurnLimit,
              dailyTurnsUsed: created.entitlements.used,
              conversationTurnLimit: created.entitlements.plan.max_conversation_turns,
              resetsAt: created.entitlements.resetsAt,
            },
          });
        },
      );

      /* ---------------------------------------------------------------------- */
      /* 2. POST /api/conversations/:id/message                                 */
      /* ---------------------------------------------------------------------- */

      app.post(
        '/conversations/:conversationId/message',
        {
          onRequest: [app.authenticate],
          preHandler: [app.authorize('conversations:read_own')],
          schema: {
            description: "Send a child's utterance and receive the companion's reply.",
            params: z.object({ conversationId: z.uuid() }),
            body: z.object({ text: z.string().min(1).max(1_000) }),
            response: { 200: turnSchema },
          },
          config: {
            rateLimit: {
              max: options.messageRateLimitPerMinute,
              timeWindow: '1 minute',
              keyGenerator: perParent,
            },
          },
        },
        async (request, reply) => {
          const conversationId = request.params.conversationId;
          const parentId = parentIdOf(request);

          /* --- Load, and resolve the quotas, inside one RLS-scoped read --- */
          const loaded = await app.withParent(request, async (tx) => {
            const { rows } = await tx.query<{
              id: string;
              child_id: string;
              status: 'active' | 'ended' | 'flagged';
              mode: 'chat' | 'story';
              language_code: SupportedLanguage;
              prompt_key: string | null;
              message_count: number;
              slug: string;
              display_name: string;
              description: string;
              allowed_age_groups: AgeGroup[];
              personality_traits: string[];
              conversation_style: string;
              vocabulary_style: string;
              encouragement_style: string;
              story_style: string;
              greeting_style: string;
              farewell_style: string;
              educational_objectives: string[];
            }>(
              `select cv.id, cv.child_id, cv.status, cv.mode, cv.language_code,
                    ch.prompt_key, cv.message_count,
                    ch.slug, ch.display_name, ch.description, ch.allowed_age_groups,
                    ch.personality_traits, ch.conversation_style, ch.vocabulary_style,
                    ch.encouragement_style, ch.story_style, ch.greeting_style,
                    ch.farewell_style, ch.educational_objectives
               from conversations cv
               join ai_characters ch on ch.id = cv.character_id
              where cv.id = $1`,
              [conversationId],
            );

            const conversation = rows[0];
            if (!conversation) throw notFound();
            if (conversation.status !== 'active') {
              throw validationFailed([{ field: 'conversationId', issue: 'has already ended' }]);
            }

            const context = await loadChildContext(tx, conversation.child_id);
            if (!context) throw notFound();

            // The gate runs on EVERY turn, not only at the start. A session opened
            // before the limit was reached must still stop when it is — otherwise
            // "never end the conversation" is the bypass.
            const { rows: elapsed } = await tx.query<{ seconds: number }>(
              'select app.conversation_seconds($1) as seconds',
              [conversationId],
            );
            const gate = await checkParentalGate(tx, conversation.child_id, options.clock, {
              sessionSeconds: elapsed[0]?.seconds ?? 0,
            });

            const entitlements = await loadEntitlements(
              tx,
              parentId,
              conversation.child_id,
              options.dailyTurnLimit,
            );

            // The context window: the last N exchanges, oldest first.
            const { rows: history } = await tx.query<{
              role: 'child' | 'companion';
              content_ciphertext: Buffer | string;
              sequence: number;
            }>(
              `select role, content_ciphertext, sequence
               from messages
              where conversation_id = $1 and status = 'delivered'
              order by sequence desc
              limit $2`,
              [conversationId, options.maxExchanges * 2],
            );

            return { conversation, context, entitlements, gate, history: history.reverse() };
          });

          const limits = {
            plan: loaded.entitlements.plan.plan_code,
            dailyTurnLimit: loaded.entitlements.dailyTurnLimit,
            dailyTurnsUsed: loaded.entitlements.used,
            conversationTurnLimit: loaded.entitlements.plan.max_conversation_turns,
            resetsAt: loaded.entitlements.resetsAt,
          };

          /* --- Quotas --------------------------------------------------------
           * A CHILD IS WAITING ON THIS RESPONSE, so a reached limit is a 200 with
           * a warm goodbye and `status: 'ended'`, not a 429. A raw error here
           * would surface to a five-year-old as a broken app, and the limit is not
           * their mistake to understand (docs/ERROR_HANDLING.md §10).
           *
           * `/start` does return 429 for the same conditions — no child is
           * listening at that point, and the client needs the machine-readable
           * form to decide between "upgrade" and "come back tomorrow". The
           * `limits` block below carries the same facts either way.
           */
          /* --- Parental controls ---------------------------------------------
           * A CHILD IS WAITING, so this ends the session warmly rather than
           * returning an error — the same reasoning as the quota path below. The
           * PARENT sees the real reason on their dashboard; a child told "your
           * parent blocked this" learns the rule is a person to argue with.
           */
          if (!loaded.gate.result.allowed) {
            const denial = loaded.gate.result.denial ?? 'paused';
            await endConversation(db, conversationId, 'parent_ended');

            await auditOrFail(
              audit,
              {
                actorId: parentId,
                actorType: 'system',
                action: 'conversation.parental_limit_reached',
                resourceType: 'conversation',
                resourceId: conversationId,
                subjectChildId: loaded.conversation.child_id,
                outcome: 'denied',
                metadata: { denial },
              },
              request,
            );

            return await reply.status(200).send({
              reply: CHILD_FACING_MESSAGE[denial],
              status: 'ended' as const,
              conversationStatus: 'ended' as const,
              messageId: null,
              replyMessageId: null,
              limits,
            });
          }

          const turnsInConversation = Math.ceil(loaded.conversation.message_count / 2);
          const overDaily = loaded.entitlements.used >= loaded.entitlements.dailyTurnLimit;
          const overSession = turnsInConversation >= loaded.entitlements.plan.max_conversation_turns;

          if (overDaily || overSession) {
            await endConversation(db, conversationId, overDaily ? 'quota_exhausted' : 'child_ended');

            await auditOrFail(
              audit,
              {
                actorId: parentId,
                actorType: 'system',
                action: 'conversation.quota_exhausted',
                resourceType: 'conversation',
                resourceId: conversationId,
                subjectChildId: loaded.conversation.child_id,
                outcome: 'denied',
                metadata: {
                  scope: overDaily ? 'daily_turns' : 'conversation_turns',
                  used: overDaily ? loaded.entitlements.used : turnsInConversation,
                  limit: overDaily
                    ? loaded.entitlements.dailyTurnLimit
                    : loaded.entitlements.plan.max_conversation_turns,
                  plan: loaded.entitlements.plan.plan_code,
                },
              },
              request,
            );

            return await reply.status(200).send({
              reply: overDaily
                ? "That was so much fun! Let's talk again tomorrow."
                : "What a lot we talked about! Let's start a fresh chat.",
              status: 'ended' as const,
              conversationStatus: 'ended' as const,
              messageId: null,
              replyMessageId: null,
              limits,
            });
          }

          // A row with a prompt_key uses the reviewed built-in it names; a row
          // without one is composed from its trait selections. Neither path lets
          // a row supply prompt text — see services/ai/src/character-traits.ts.
          const config = characterConfigFrom(loaded.conversation);
          const character = resolveCharacter({
            promptKey: loaded.conversation.prompt_key,
            ...(config === undefined ? {} : { config }),
          });

          if (!character) {
            // Refused rather than substituted. Quietly swapping in another
            // character would give a child a different companion without
            // telling anyone.
            throw validationFailed([
              { field: 'conversationId', issue: 'uses a character that is no longer available' },
            ]);
          }

          /* --- INPUT_SAFETY_CHECK → AI_GENERATION → OUTPUT_SAFETY_CHECK --- */
          const turn = await engine.respond({
            utterance: request.body.text,
            // Generation only — moderation stays on the deployment's provider
            // whatever a family chose. See RespondInput.provider.
            provider: options.providers.resolve(loaded.context.ai_provider),
            // Used for ONE thing: counting this child's recent stopped turns. It
            // is never transmitted to a provider (see SafetySubject.childRef).
            childRef: loaded.conversation.child_id,
            parental: {
              blockedTopics: loaded.context.blocked_topics,
              storytellingEnabled: loaded.context.storytelling_enabled,
              roleplayEnabled: loaded.context.roleplay_enabled,
            },
            context: {
              childName: loaded.context.display_name,
              ageGroup: loaded.context.age_group,
              language: loaded.conversation.language_code,
              character,
              history: loaded.history.map((m): HistoryMessage => ({
                role: m.role,
                text: decodeContent(m.content_ciphertext),
                sequence: m.sequence,
              })),
              /* ═══════════════════════════════════════════════════════════════
               * THE PARENTAL CONTROL WINS OVER THE MODE, ALWAYS.
               * ═══════════════════════════════════════════════════════════════
               *
               * Starting a story is refused when storytelling is off, so normally
               * these cannot disagree. They can disagree in one window: a parent
               * turns storytelling off while a story session is open. The control
               * takes effect on the child's very next turn — the story stops
               * being a story — rather than at the end of a session nobody is
               * obliged to end.
               */
              storyMode: loaded.conversation.mode === 'story' && loaded.context.storytelling_enabled,
              learningObjectives: loaded.context.topic_keys,
              blockedTopics: loaded.context.blocked_topics,
              contentRestrictions: [
                ...(loaded.context.storytelling_enabled ? [] : ['Do not tell stories.']),
                ...(loaded.context.roleplay_enabled
                  ? []
                  : ['Do not engage in pretend play or role-play.']),
              ],
              correctionStyle: loaded.context.correction_style,
            },
          });

          /* --- Persist both messages --- */
          const persisted = await app.withParent(request, async (tx) => {
            /**
             * ═══════════════════════════════════════════════════════════════
             * THE SEQUENCE IS ALLOCATED HERE, NOT BEFORE THE MODEL CALL.
             * ═══════════════════════════════════════════════════════════════
             *
             * `loaded.conversation.message_count` was read BEFORE the provider
             * was called, and that call takes hundreds of milliseconds. Two
             * turns in flight on the same conversation therefore both computed
             * the same `nextSequence`, and the second insert died on
             * `uq_messages_conversation_sequence` — a 500, which then told the
             * client to retry the thing that just failed.
             *
             * That is not exotic: a child taps send twice, or the app retries
             * on a flaky mobile connection while the first turn is still in
             * flight — which ARCHITECTURE.md §7.3 explicitly expects it to do.
             *
             * `for update` locks the conversation row, so a concurrent turn
             * waits for this one to commit and then reads the count it actually
             * produced. The unique index was doing its job; it was the only
             * thing standing between a stale read and a corrupted transcript
             * order.
             */
            const { rows: counterRows } = await tx.query<{ message_count: number }>(
              'select message_count from conversations where id = $1 for update',
              [conversationId],
            );
            const nextSequence = counterRows[0]?.message_count ?? loaded.conversation.message_count;

            const { rows: childRows } = await tx.query<{ id: string }>(
              `insert into messages
               (conversation_id, child_id, role, sequence, content_ciphertext, content_key_id,
                content_length, status)
             values ($1, $2, 'child', $3, $4, $5, $6, $7)
             returning id`,
              [
                conversationId,
                loaded.conversation.child_id,
                nextSequence,
                encodeContent(request.body.text),
                options.encryptionKeyId,
                request.body.text.length,
                turn.status === 'ok' ? 'delivered' : 'blocked',
              ],
            );
            const childMessageId = childRows[0]?.id ?? null;

            let replyMessageId: string | null = null;
            if (turn.status === 'ok') {
              const { rows: replyRows } = await tx.query<{ id: string }>(
                `insert into messages
                 (conversation_id, child_id, role, sequence, content_ciphertext, content_key_id,
                  content_length, status, provider, model, input_tokens, output_tokens, cost_usd,
                  safety_layers_passed)
               values ($1, $2, 'companion', $3, $4, $5, $6, 'delivered', $7, $8, $9, $10, $11, $12)
               returning id`,
                [
                  conversationId,
                  loaded.conversation.child_id,
                  nextSequence + 1,
                  encodeContent(turn.replyForStorage),
                  options.encryptionKeyId,
                  turn.replyForStorage.length,
                  turn.provider,
                  turn.model,
                  turn.usage.inputTokens,
                  turn.usage.outputTokens,
                  turn.usage.estimatedCostUsd,
                  turn.layersPassed,
                ],
              );
              replyMessageId = replyRows[0]?.id ?? null;
            }

            const advance = turn.status === 'ok' ? 2 : 1;
            // The conversation row is the per-session ledger: none of these columns
            // is returned by the API, and all of them are what answers "what did
            // this session cost and how much context did the model actually see?".
            await tx.query(
              `update conversations
                set message_count = message_count + $2,
                    total_input_tokens = total_input_tokens + $3,
                    total_output_tokens = total_output_tokens + $4,
                    total_cost_usd = total_cost_usd + $5,
                    context_message_count = $6,
                    provider = $7,
                    model = $8,
                    status = case
                               when $10 then 'ended'
                               when $9 then 'flagged'
                               else status
                             end,
                    ended_at = case when $10 then now() else ended_at end,
                    end_reason = case when $10 then 'safety_ended' else end_reason end
              where id = $1`,
              [
                conversationId,
                advance,
                turn.usage.inputTokens,
                turn.usage.outputTokens,
                turn.usage.estimatedCostUsd,
                turn.contextMessageCount,
                turn.provider,
                turn.model,
                turn.escalation,
                turn.status === 'ended',
              ],
            );

            return { childMessageId, replyMessageId };
          });

          /* --- Progress ------------------------------------------------------
           * Keyed on the message id, so a retried request cannot count the same
           * turn twice. Only the WORD COUNT travels; the utterance does not. */
          if (persisted.childMessageId !== null) {
            await options.learning?.turn({
              childId: loaded.conversation.child_id,
              conversationId,
              messageId: persisted.childMessageId,
              wordCount: wordCountOf(request.body.text),
            });
          }

          /* --- Usage, and the safety events ---------------------------------
           * Both under the SYSTEM context. `usage_daily` and `content_flags` are
           * SELECT-only for a parent by design — a parent must be able to see
           * their usage and their child's flags, and able to alter neither.
           */
          await asSystem(db, async (tx) => {
            await tx.query('select app.record_usage($1, 1, $2, 0, $3, $4, $5)', [
              loaded.conversation.child_id,
              turn.status === 'ok' ? 0 : 1,
              turn.usage.inputTokens,
              turn.usage.outputTokens,
              turn.usage.estimatedCostUsd,
            ]);

            for (const record of turn.safetyRecords) {
              if (record.decision === 'allowed') continue;
              await tx.query(
                `insert into content_flags
                 (child_id, message_id, conversation_id, layer, decision, categories,
                  severity, confidence, detector, policy_version, action_taken, attempt_index)
               values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
                [
                  loaded.conversation.child_id,
                  persisted.childMessageId,
                  conversationId,
                  record.layer,
                  record.decision,
                  record.categories,
                  record.decision === 'escalated' ? 'critical' : 'high',
                  record.confidence,
                  // Rule NAMES, never the text that matched them.
                  record.detectors.join(',') || null,
                  record.policyVersion,
                  record.actionTaken,
                  record.attemptIndex,
                ],
              );
            }
          });

          if (turn.escalation) {
            /* An escalation is not merely a block. docs/CHILD_SAFETY.md §6.1
             * item 5 requires it to be RECORDED and ROUTED to a human path.
             *
             * The audit entry below is the record. `options.escalations` is the
             * routing: it writes a durable delivery row and then attempts the
             * webhook without the child's turn waiting on it. WHO reads that
             * endpoint is Q-07 and is not decided here. */
            await auditOrFail(
              audit,
              {
                actorType: 'system',
                action: 'safety.escalation.raised',
                resourceType: 'conversation',
                resourceId: conversationId,
                subjectChildId: loaded.conversation.child_id,
                outcome: 'success',
                metadata: {
                  layers: turn.safetyRecords.map((r) => r.layer),
                  reason: turn.escalationReason ?? 'unspecified',
                  categories: turn.safetyRecords.flatMap((r) => r.categories),
                  requiresHumanReview: true,
                },
              },
              request,
            );
            request.log.warn(
              { requestId: request.requestId, conversationId },
              'safety escalation raised — human review required',
            );

            if (options.escalations === undefined) {
              /* Never silent. §6.1 item 1: a disclosure must never be swallowed,
               * and "nobody was told" is a form of swallowing it. */
              request.log.error(
                { requestId: request.requestId, control: 'safety_escalation_delivery' },
                'safety escalation NOT routed: no delivery configured',
              );
            } else {
              await options.escalations.record({
                childId: loaded.conversation.child_id,
                conversationId,
                reason: escalationReasonCode(turn.escalationReason),
                // Deduplicated: several layers commonly flag the same category,
                // and a reviewer wants the set, not the tally.
                categories: [...new Set(turn.safetyRecords.flatMap((r) => r.categories))],
                severity: 'critical',
              });
            }
          }

          /* The alert conditions' producer. A blocked turn is the pipeline
           * working and must never page anybody; `safety_unavailable` is the
           * pipeline failing closed, and pages on the first one. */
          options.health?.record({ status: turn.status, degradedReason: turn.degradedReason });

          // Structured, and content-free. `turn.status` and the layer names are
          // safe to log; the utterance and the reply are not, ever
          // (docs/LOGGING.md §2).
          request.log.info(
            {
              requestId: request.requestId,
              conversationId,
              turnStatus: turn.status,
              layersPassed: turn.layersPassed,
              degradedReason: turn.degradedReason,
              inputTokens: turn.usage.inputTokens,
              outputTokens: turn.usage.outputTokens,
            },
            'conversation turn completed',
          );

          return await reply.status(200).send({
            reply: turn.reply,
            status: turn.status,
            conversationStatus:
              turn.status === 'ended'
                ? ('ended' as const)
                : turn.escalation
                  ? ('flagged' as const)
                  : ('active' as const),
            messageId: persisted.childMessageId,
            replyMessageId: persisted.replyMessageId,
            limits: { ...limits, dailyTurnsUsed: loaded.entitlements.used + 1 },
          });
        },
      );

      /* ---------------------------------------------------------------------- */
      /* 3. GET /api/conversations?childId=…                                    */
      /* ---------------------------------------------------------------------- */
      /* Not in the four-endpoint specification, but the dashboard cannot page    */
      /* through a child's history without it, and it was already shipped under   */
      /* the previous path. Kept, rather than silently dropped.                   */

      app.get(
        '/conversations',
        {
          onRequest: [app.authenticate],
          preHandler: [app.authorize('conversations:read_own')],
          schema: {
            description: "A child's conversations, most recent first. No message bodies.",
            querystring: z.object({
              childId: z.uuid(),
              limit: z.coerce.number().int().min(1).max(100).default(20),
            }),
            response: { 200: z.object({ items: z.array(conversationSchema) }) },
          },
        },
        async (request, reply) => {
          const items = await app.withParent(request, async (tx) => {
            await requireChildOwnership(tx, request.query.childId);

            const { rows } = await tx.query<ConversationRow>(
              `select ${CONVERSATION_COLUMNS}
               from conversations cv
               join ai_characters ch on ch.id = cv.character_id
              where cv.child_id = $1
              order by cv.started_at desc
              limit $2`,
              [request.query.childId, request.query.limit],
            );
            return rows;
          });

          return await reply.status(200).send({ items: items.map(presentConversation) });
        },
      );

      /* ---------------------------------------------------------------------- */
      /* 4. GET /api/conversations/:id                                          */
      /* ---------------------------------------------------------------------- */

      app.get(
        '/conversations/:conversationId',
        {
          onRequest: [app.authenticate],
          preHandler: [app.authorize('conversations:read_own')],
          schema: {
            description: 'One conversation with its messages. The parent oversight surface.',
            params: z.object({ conversationId: z.uuid() }),
            response: { 200: conversationSchema.extend({ messages: z.array(messageSchema) }) },
          },
        },
        async (request, reply) => {
          const result = await app.withParent(request, async (tx) => {
            // RLS restricts `conversations` to the caller's children, so a
            // conversation belonging to another family returns zero rows here —
            // which becomes a 404, not a 403. A 403 would confirm it exists.
            const { rows } = await tx.query<ConversationRow>(
              `select ${CONVERSATION_COLUMNS}
               from conversations cv
               join ai_characters ch on ch.id = cv.character_id
              where cv.id = $1`,
              [request.params.conversationId],
            );

            const conversation = rows[0];
            if (!conversation) throw notFound();

            // Stored replies keep the {{name}} placeholder, so the name is never in
            // the transcript and never replays into a provider call. It is
            // substituted here, at presentation time.
            const { rows: child } = await tx.query<{ display_name: string }>(
              'select display_name from children where id = $1',
              [conversation.child_id],
            );
            const childName = child[0]?.display_name ?? '';

            const { rows: messages } = await tx.query<{
              id: string;
              role: 'child' | 'companion';
              sequence: number;
              content_ciphertext: Buffer | string;
              status: 'delivered' | 'blocked' | 'redacted';
              redacted_at: string | null;
              created_at: string;
            }>(
              `select id, role, sequence, content_ciphertext, status, redacted_at, created_at
               from messages where conversation_id = $1 order by sequence`,
              [request.params.conversationId],
            );

            return { conversation, messages, childName };
          });

          return await reply.status(200).send({
            ...presentConversation(result.conversation),
            messages: result.messages.map((m) => ({
              id: m.id,
              role: m.role,
              sequence: m.sequence,
              /* A redacted message returns an empty string, not the empty
               * ciphertext decoded into one by accident. The distinction matters
               * to whoever renders this: "" reads as a bug, and `redactedAt`
               * with it reads as the retention policy doing what it promised. */
              text:
                m.redacted_at === null
                  ? substituteName(decodeContent(m.content_ciphertext), result.childName)
                  : '',
              status: m.status,
              redactedAt: m.redacted_at === null ? null : new Date(m.redacted_at).toISOString(),
              createdAt: new Date(m.created_at).toISOString(),
            })),
          });
        },
      );

      /* ---------------------------------------------------------------------- */
      /* 5. POST /api/conversations/:id/end                                     */
      /* ---------------------------------------------------------------------- */

      app.post(
        '/conversations/:conversationId/end',
        {
          onRequest: [app.authenticate],
          preHandler: [app.authorize('conversations:read_own')],
          schema: {
            description: 'End a conversation. Idempotent.',
            params: z.object({ conversationId: z.uuid() }),
            body: z.object({
              reason: z
                .enum(['child_ended', 'parent_ended', 'timeout', 'quota_exhausted'])
                .default('child_ended'),
            }),
            response: { 200: conversationSchema },
          },
        },
        async (request, reply) => {
          const ended = await app.withParent(request, async (tx) => {
            // `coalesce` on both columns is what makes this idempotent: ending an
            // already-ended conversation returns it unchanged rather than
            // rewriting when and why it ended.
            const { rows } = await tx.query<ConversationRow>(
              `with updated as (
               update conversations
                  set status = case when status = 'flagged' then 'flagged' else 'ended' end,
                      ended_at = coalesce(ended_at, now()),
                      end_reason = coalesce(end_reason, $2)
                where id = $1
                returning *
             )
             select ${CONVERSATION_COLUMNS}
               from updated cv join ai_characters ch on ch.id = cv.character_id`,
              [request.params.conversationId, request.body.reason],
            );

            const conversation = rows[0];
            if (!conversation) throw notFound();
            return conversation;
          });

          await auditOrFail(
            audit,
            {
              actorId: request.principal?.parentId,
              actorType: 'parent',
              action: 'conversation.ended',
              resourceType: 'conversation',
              resourceId: ended.id,
              subjectChildId: ended.child_id,
              outcome: 'success',
              metadata: { reason: ended.end_reason },
            },
            request,
          );

          /* The session is over, so nothing is waiting on the aggregation — which
           * is why this is where the day's rollup gets rebuilt. A parent opening
           * the dashboard after a chat sees that chat. */
          const { rows: seconds } = await app.withParent(
            request,
            async (tx) =>
              await tx.query<{ seconds: number }>('select app.conversation_seconds($1) as seconds', [
                ended.id,
              ]),
          );

          await options.learning?.conversationEnded({
            childId: ended.child_id,
            conversationId: ended.id,
            seconds: seconds[0]?.seconds ?? 0,
            storyCompleted: isCompletedStory(ended),
          });

          return await reply.status(200).send(presentConversation(ended));
        },
      );
    };

/**
 * Ends a conversation as the system.
 *
 * Used when a quota, not a person, closed the session. Runs outside the parent's
 * transaction because it must succeed even when the read that discovered the
 * limit is the last thing that transaction did.
 */
const endConversation = async (
  db: Database,
  conversationId: string,
  reason: 'quota_exhausted' | 'child_ended' | 'parent_ended',
): Promise<void> => {
  await asSystem(db, async (tx) => {
    await tx.query(
      `update conversations
          set status = 'ended',
              ended_at = coalesce(ended_at, now()),
              end_reason = coalesce(end_reason, $2)
        where id = $1 and status = 'active'`,
      [conversationId, reason],
    );
  });
};
