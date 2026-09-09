import { asSystem, type Database, type Queryable } from '@kids/db';
import {
  buildFeedback,
  newlyEarned,
  PRACTICE_DISCLAIMER,
  scorePronunciation,
  type AchievementRule,
  type PracticeCounters,
  type RuleKind,
  type SpeechAnalysisProvider,
} from '@kids/practice';
import { notFound, validationFailed } from '@kids/shared';
import type { Clock } from '@kids/shared';
import type { AgeGroup, SupportedLanguage } from '@kids/types';
import {
  resolveRetention,
  validateAudioUpload,
  type AudioLimits,
  type AudioStorage,
  type RetentionPolicy,
} from '@kids/voice';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { auditOrFail, type AuditLogger } from '../audit.js';
import type { LearningRecorder } from '../learning-events.js';
import { checkParentalGate } from '../parental-gate.js';
import { requireChildOwnership } from '../plugins/auth.js';

/**
 * Pronunciation practice.
 *
 *   GET  /api/practice/exercises?childId=…       what this child can practise
 *   POST /api/practice/sessions                  start a session
 *   POST /api/practice/sessions/:id/attempts     one recorded attempt
 *   POST /api/practice/sessions/:id/complete     finish, and roll up
 *   GET  /api/practice/progress?childId=…        history, progress, achievements
 *
 * TWO THINGS GOVERN THIS FILE.
 *
 * **It is a game, not an assessment.** Every response that carries a score also
 * carries `PRACTICE_DISCLAIMER`. Nothing here diagnoses, grades, ranks, or
 * compares a child to anyone (docs/CHILD_SAFETY.md §2).
 *
 * **The recording is discarded.** Practice keeps the SCORE. A corpus of children
 * repeating target phrases is the worst dataset this product could accumulate,
 * and this is the feature that would accumulate it — so retention runs through
 * the same policy the voice pipeline uses, which needs both configuration and a
 * parent's specific opt-in before anything survives the attempt (ADR-0006).
 */

export interface PracticeRoutesOptions {
  readonly db: Database;
  readonly audit: AuditLogger;
  readonly analysis: SpeechAnalysisProvider;
  readonly storage: AudioStorage;
  readonly clock: Clock;
  readonly retention: RetentionPolicy;
  readonly limits: AudioLimits;
  readonly analysisTimeoutMs: number;
  readonly rateLimitPerMinute: number;
  /** Records pronunciation scores for the progress dashboard. */
  readonly learning?: LearningRecorder;
}

/* -------------------------------------------------------------------------- */
/* Response schemas                                                            */
/* -------------------------------------------------------------------------- */
/* No storage keys, no transcripts of what the child said, no provider          */
/* credentials. The transcript in particular is deliberately absent: it is a    */
/* recognition of a child's speech, and the product has no reason to show it    */
/* back.                                                                       */

const targetSchema = z.object({
  sequence: z.number().int(),
  text: z.string(),
  syllables: z.array(z.string()),
  hint: z.string().nullable(),
});

const exerciseSchema = z.object({
  exerciseKey: z.string(),
  title: z.string(),
  kind: z.enum(['word', 'syllable']),
  language: z.string(),
  skillKey: z.string(),
  targets: z.array(targetSchema),
});

const feedbackSchema = z.object({
  band: z.enum(['excellent', 'good', 'nearly', 'keep_going']),
  message: z.string(),
  focus: z.string().optional(),
  tryAgain: z.boolean(),
});

const attemptSchema = z.object({
  id: z.string().nullable(),
  sequence: z.number().int(),
  attemptNumber: z.number().int(),
  targetText: z.string(),
  score: z.number(),
  confidence: z.number(),
  /** How the score was produced. Shown so nobody mistakes the weakest for the strongest. */
  method: z.enum(['phoneme_alignment', 'word_alignment', 'transcript_similarity']),
  phonemeDataAvailable: z.boolean(),
  parts: z.array(z.object({ text: z.string(), score: z.number() })),
  feedback: feedbackSchema,
  newAchievements: z.array(z.object({ key: z.string(), title: z.string() })),
  disclaimer: z.string(),
});

const sessionSchema = z.object({
  id: z.string(),
  childId: z.string(),
  exerciseKey: z.string(),
  language: z.string(),
  status: z.enum(['in_progress', 'completed', 'abandoned']),
  attemptCount: z.number().int(),
  averageScore: z.number().nullable(),
  startedAt: z.string(),
  completedAt: z.string().nullable(),
});

const perParent = (request: FastifyRequest): string =>
  request.principal ? `parent:${request.principal.parentId}` : `ip:${request.ip}`;

interface TargetRow {
  sequence: number;
  text: string;
  syllables: string[];
  expected_ipa: string | null;
  hint: string | null;
}

interface ExerciseRow {
  exercise_key: string;
  title: string;
  kind: 'word' | 'syllable';
  language_code: SupportedLanguage;
  skill_key: string;
}

const loadTargets = async (tx: Queryable, exerciseKey: string): Promise<TargetRow[]> => {
  const { rows } = await tx.query<TargetRow>(
    `select t.sequence, t.text, t.syllables, t.expected_ipa, t.hint
       from practice_targets t
       join practice_exercises e on e.id = t.exercise_id
      where e.exercise_key = $1
      order by t.sequence`,
    [exerciseKey],
  );
  return rows;
};

export const practiceRoutes =
  (options: PracticeRoutesOptions): FastifyPluginAsyncZod =>
  async (app) => {
    const { audit, db } = options;

    /* ---------------------------------------------------------------------- */
    /* 1. What this child can practise                                        */
    /* ---------------------------------------------------------------------- */

    app.get(
      '/practice/exercises',
      {
        onRequest: [app.authenticate],
        preHandler: [app.authorize('conversations:read_own')],
        schema: {
          querystring: z.object({ childId: z.uuid() }),
          response: { 200: z.object({ items: z.array(exerciseSchema) }) },
        },
      },
      async (request, reply) => {
        const items = await app.withParent(request, async (tx) => {
          await requireChildOwnership(tx, request.query.childId);

          const { rows: child } = await tx.query<{
            age_group: AgeGroup;
            primary_language: SupportedLanguage;
          }>(
            `select app.age_group(c.birth_year, c.birth_month) as age_group,
                    coalesce(
                      (select cl.language_code from child_languages cl
                        where cl.child_id = c.id and cl.is_primary limit 1),
                      'en'
                    ) as primary_language
               from children c where c.id = $1 and c.deleted_at is null`,
            [request.query.childId],
          );
          if (!child[0]) throw notFound();

          // Age-gated the same way characters are: content narrows with age, it
          // never widens.
          const { rows: exercises } = await tx.query<ExerciseRow>(
            `select exercise_key, title, kind, language_code, skill_key
               from practice_exercises
              where is_active and language_code = $1 and $2 = any(age_groups)
              order by sort_order`,
            [child[0].primary_language, child[0].age_group],
          );

          return await Promise.all(
            exercises.map(async (exercise) => ({
              exercise,
              targets: await loadTargets(tx, exercise.exercise_key),
            })),
          );
        });

        return await reply.status(200).send({
          items: items.map(({ exercise, targets }) => ({
            exerciseKey: exercise.exercise_key,
            title: exercise.title,
            kind: exercise.kind,
            language: exercise.language_code,
            skillKey: exercise.skill_key,
            targets: targets.map((t) => ({
              sequence: t.sequence,
              text: t.text,
              syllables: t.syllables,
              hint: t.hint,
              // `expected_ipa` is NOT exposed. It is scoring input, and showing a
              // phonetic transcription to a seven-year-old helps nobody.
            })),
          })),
        });
      },
    );

    /* ---------------------------------------------------------------------- */
    /* 2. Start a session                                                     */
    /* ---------------------------------------------------------------------- */

    app.post(
      '/practice/sessions',
      {
        onRequest: [app.authenticate],
        preHandler: [app.authorize('conversations:read_own')],
        schema: {
          body: z.object({ childId: z.uuid(), exerciseKey: z.string().min(3).max(80) }),
          response: { 201: sessionSchema },
        },
        config: {
          rateLimit: {
            max: options.rateLimitPerMinute,
            timeWindow: '1 minute',
            keyGenerator: perParent,
          },
        },
      },
      async (request, reply) => {
        const created = await app.withParent(request, async (tx) => {
          await requireChildOwnership(tx, request.body.childId);

          const { rows: exercise } = await tx.query<ExerciseRow>(
            `select exercise_key, title, kind, language_code, skill_key
               from practice_exercises where exercise_key = $1 and is_active`,
            [request.body.exerciseKey],
          );
          if (!exercise[0]) {
            throw validationFailed([{ field: 'exerciseKey', issue: 'is not an active exercise' }]);
          }

          // Practice is a way into the app, so it is a way around the controls
          // unless it checks them too.
          const gate = await checkParentalGate(tx, request.body.childId, options.clock);
          if (!gate.result.allowed) {
            throw validationFailed([
              {
                field: 'childId',
                issue: `is not permitted right now: ${gate.result.denial ?? 'blocked'}`,
              },
            ]);
          }

          const { rows } = await tx.query<{
            id: string;
            child_id: string;
            exercise_key: string;
            language_code: string;
            status: 'in_progress' | 'completed' | 'abandoned';
            attempt_count: number;
            average_score: number | null;
            started_at: string;
            completed_at: string | null;
          }>(
            `insert into speech_practice (child_id, language_code, exercise_key)
             values ($1, $2, $3)
             returning id, child_id, exercise_key, language_code, status,
                       attempt_count, average_score, started_at, completed_at`,
            [request.body.childId, exercise[0].language_code, request.body.exerciseKey],
          );

          const session = rows[0];
          if (!session) throw notFound();
          return session;
        });

        await auditOrFail(
          audit,
          {
            actorId: request.principal?.parentId,
            actorType: 'parent',
            action: 'practice.session.started',
            resourceType: 'speech_practice',
            resourceId: created.id,
            subjectChildId: created.child_id,
            outcome: 'success',
            metadata: { exercise: created.exercise_key },
          },
          request,
        );

        return await reply.status(201).send({
          id: created.id,
          childId: created.child_id,
          exerciseKey: created.exercise_key,
          language: created.language_code,
          status: created.status,
          attemptCount: created.attempt_count,
          averageScore: created.average_score,
          startedAt: new Date(created.started_at).toISOString(),
          completedAt: null,
        });
      },
    );

    /* ---------------------------------------------------------------------- */
    /* 3. One attempt                                                         */
    /* ---------------------------------------------------------------------- */

    app.post(
      '/practice/sessions/:sessionId/attempts',
      {
        onRequest: [app.authenticate],
        preHandler: [app.authorize('conversations:read_own')],
        schema: {
          description: 'Multipart: `sequence` and `audio`. Returns a score and feedback.',
          consumes: ['multipart/form-data'],
          params: z.object({ sessionId: z.uuid() }),
          response: { 200: attemptSchema },
        },
        config: {
          rateLimit: {
            max: options.rateLimitPerMinute,
            timeWindow: '1 minute',
            keyGenerator: perParent,
          },
        },
      },
      async (request, reply) => {
        /* --- UPLOAD --- */
        let sequence = -1;
        let declaredMimeType = '';
        let audioBytes: Buffer | undefined;
        let truncated = false;

        try {
          for await (const part of request.parts()) {
            if (part.type === 'field' && part.fieldname === 'sequence') {
              sequence = Number(part.value);
            } else if (part.type === 'file' && part.fieldname === 'audio') {
              declaredMimeType = part.mimetype;
              audioBytes = await part.toBuffer();
              truncated = part.file.truncated;
            } else if (part.type === 'file') {
              await part.toBuffer();
            }
          }
        } catch {
          throw validationFailed([{ field: 'audio', issue: 'could not be read' }]);
        }

        if (!Number.isInteger(sequence) || sequence < 0) {
          throw validationFailed([{ field: 'sequence', issue: 'must be a non-negative integer' }]);
        }
        if (!audioBytes || audioBytes.length === 0) {
          throw validationFailed([{ field: 'audio', issue: 'is required' }]);
        }
        if (truncated) {
          throw validationFailed([{ field: 'audio', issue: 'exceeds the maximum size' }]);
        }

        /* --- Ownership and the target, under RLS --- */
        const loaded = await app.withParent(request, async (tx) => {
          const { rows } = await tx.query<{
            id: string;
            child_id: string;
            exercise_key: string;
            language_code: SupportedLanguage;
            status: string;
            age_group: AgeGroup;
            skill_key: string;
          }>(
            `select s.id, s.child_id, s.exercise_key, s.language_code, s.status,
                    app.age_group(c.birth_year, c.birth_month) as age_group,
                    e.skill_key
               from speech_practice s
               join children c on c.id = s.child_id
               join practice_exercises e on e.exercise_key = s.exercise_key
              where s.id = $1 and c.deleted_at is null`,
            [request.params.sessionId],
          );

          const session = rows[0];
          if (!session) throw notFound();
          if (session.status !== 'in_progress') {
            throw validationFailed([{ field: 'sessionId', issue: 'has already finished' }]);
          }

          const gate = await checkParentalGate(tx, session.child_id, options.clock);
          if (!gate.result.allowed) {
            throw validationFailed([
              {
                field: 'sessionId',
                issue: `is not permitted right now: ${gate.result.denial ?? 'blocked'}`,
              },
            ]);
          }

          const targets = await loadTargets(tx, session.exercise_key);
          const target = targets.find((t) => t.sequence === sequence);
          if (!target) {
            throw validationFailed([{ field: 'sequence', issue: 'is not part of this exercise' }]);
          }

          const { rows: attempts } = await tx.query<{ n: number }>(
            `select coalesce(max(attempt_number), 0)::int as n
               from pronunciation_results
              where speech_practice_id = $1 and sequence = $2`,
            [session.id, sequence],
          );

          const { rows: consent } = await tx.query<{ granted: boolean }>(
            `select granted from current_consents
              where parent_id = $1 and consent_type = 'audio_retention'
                and (child_id = $2 or child_id is null)
              order by child_id nulls last limit 1`,
            [request.principal?.parentId ?? '', session.child_id],
          );

          return {
            session,
            target,
            attemptNumber: (attempts[0]?.n ?? 0) + 1,
            retentionOptIn: consent[0]?.granted === true,
          };
        });

        /* --- VALIDATE --- */
        const validation = validateAudioUpload({
          bytes: new Uint8Array(audioBytes),
          declaredMimeType,
          limits: options.limits,
        });
        if (!validation.ok) {
          throw validationFailed([{ field: 'audio', issue: 'is not a supported recording' }]);
        }

        /* --- RETENTION, decided before anything is written --- */
        const retention = resolveRetention({
          policy: options.retention,
          kind: 'child_upload',
          parentOptedIn: loaded.retentionOptIn,
          clock: options.clock,
        });

        if (retention.decision === 'retained') {
          const stored = await options.storage.put({
            kind: 'child_upload',
            bytes: new Uint8Array(audioBytes),
            mimeType: validation.mimeType,
            ...(validation.durationMs === undefined ? {} : { durationMs: validation.durationMs }),
            expiresAt: retention.expiresAt,
          });

          await asSystem(db, async (tx) => {
            await tx.query(
              `insert into audio_artifacts
                 (child_id, kind, storage_key, mime_type, byte_size, duration_ms,
                  retention_basis, expires_at)
               values ($1, 'child_upload', $2, $3, $4, $5, 'parent_opt_in', $6)`,
              [
                loaded.session.child_id,
                stored.key,
                validation.mimeType,
                audioBytes.length,
                validation.durationMs ?? null,
                retention.expiresAt,
              ],
            );
          });
        }

        /* --- ANALYSE --- */
        let analysis;
        try {
          analysis = await options.analysis.analyse({
            audio: new Uint8Array(audioBytes),
            mimeType: validation.mimeType,
            targetText: loaded.target.text,
            syllables: loaded.target.syllables,
            ...(loaded.target.expected_ipa === null
              ? {}
              : { expectedIpa: loaded.target.expected_ipa }),
            language: loaded.session.language_code,
            ageGroup: loaded.session.age_group,
            timeoutMs: options.analysisTimeoutMs,
          });
        } catch {
          // A recogniser outage must not read as "your child said it wrong". No
          // result is recorded, and the child is invited to try again.
          return await reply.status(200).send({
            id: null,
            sequence,
            attemptNumber: loaded.attemptNumber,
            targetText: loaded.target.text,
            score: 0,
            confidence: 0,
            method: 'transcript_similarity' as const,
            phonemeDataAvailable: false,
            parts: [],
            feedback: {
              band: 'nearly' as const,
              message: 'My ears went funny for a moment! Shall we try that again?',
              tryAgain: true,
            },
            newAchievements: [],
            disclaimer: PRACTICE_DISCLAIMER,
          });
        }

        /* --- SCORE --- */
        const score = scorePronunciation({
          analysis,
          targetText: loaded.target.text,
          syllables: loaded.target.syllables,
        });

        const feedback = buildFeedback({
          score,
          ageGroup: loaded.session.age_group,
          targetText: loaded.target.text,
          seed: loaded.attemptNumber,
        });

        /* --- PERSIST --- */
        const attemptId = await app.withParent(request, async (tx) => {
          const { rows } = await tx.query<{ id: string }>(
            `insert into pronunciation_results
               (speech_practice_id, child_id, target_text, sequence, attempt_number,
                overall_score, phoneme_scores, is_correct, duration_ms,
                language_code, exercise_key, confidence, analysis_method,
                phoneme_data_available, provider, provider_model)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
             returning id`,
            [
              loaded.session.id,
              loaded.session.child_id,
              loaded.target.text,
              sequence,
              loaded.attemptNumber,
              score.overall,
              // Empty unless a provider genuinely produced phoneme detail — the
              // database has a CHECK constraint that enforces this too.
              JSON.stringify(score.phonemeScores),
              score.isCorrect,
              validation.durationMs ?? null,
              loaded.session.language_code,
              loaded.session.exercise_key,
              score.confidence,
              score.method,
              score.phonemeDataAvailable,
              score.provider,
              score.providerModel,
            ],
          );

          await tx.query(
            `update speech_practice sp
                set attempt_count = attempt_count + 1,
                    average_score = (
                      select avg(r.overall_score)::real from pronunciation_results r
                       where r.speech_practice_id = sp.id
                    )
              where sp.id = $1`,
            [loaded.session.id],
          );

          return rows[0]?.id ?? null;
        });

        /* Averaged rather than summed, so a child who practises more does not
         * appear to pronounce better. Keyed on the attempt id, so a retry does
         * not shift the average twice. */
        if (attemptId !== null) {
          await options.learning?.pronunciationScored({
            childId: loaded.session.child_id,
            speechPracticeId: loaded.session.id,
            attemptRef: attemptId,
            score: score.overall,
          });
        }

        /* --- PROGRESS AND ACHIEVEMENTS --- */
        const awarded = await asSystem(db, async (tx) => {
          await tx.query('select app.record_practice_progress($1, $2, $3)', [
            loaded.session.child_id,
            loaded.session.skill_key,
            score.isCorrect,
          ]);

          const { rows: counterRows } = await tx.query<PracticeCounters>(
            'select * from app.practice_counters($1)',
            [loaded.session.child_id],
          );
          const counters = counterRows[0] ?? {
            attempts_total: 0,
            sessions_completed: 0,
            distinct_days: 0,
            exercises_tried: 0,
          };

          const { rows: ruleRows } = await tx.query<{
            achievement_key: string;
            rule_kind: RuleKind;
            threshold: number;
            title: string;
          }>(
            `select achievement_key, rule_kind, threshold, title
               from achievements where is_active order by sort_order`,
          );

          const { rows: held } = await tx.query<{ achievement_key: string }>(
            `select a.achievement_key from child_achievements ca
               join achievements a on a.id = ca.achievement_id
              where ca.child_id = $1`,
            [loaded.session.child_id],
          );

          const rules: AchievementRule[] = ruleRows.map((r) => ({
            key: r.achievement_key,
            ruleKind: r.rule_kind,
            threshold: r.threshold,
          }));

          const earned = newlyEarned({
            rules,
            counters,
            alreadyAwarded: held.map((h) => h.achievement_key),
          });

          for (const rule of earned) {
            await tx.query(
              `insert into child_achievements (child_id, achievement_id)
               select $1, id from achievements where achievement_key = $2
               on conflict do nothing`,
              [loaded.session.child_id, rule.key],
            );
          }

          return earned.map((rule) => ({
            key: rule.key,
            title: ruleRows.find((r) => r.achievement_key === rule.key)?.title ?? rule.key,
          }));
        });

        request.log.info(
          {
            requestId: request.requestId,
            sessionId: loaded.session.id,
            method: score.method,
            phonemeDataAvailable: score.phonemeDataAvailable,
            band: feedback.band,
          },
          'practice attempt scored',
        );

        return await reply.status(200).send({
          id: attemptId,
          sequence,
          attemptNumber: loaded.attemptNumber,
          targetText: loaded.target.text,
          score: score.overall,
          confidence: score.confidence,
          method: score.method,
          phonemeDataAvailable: score.phonemeDataAvailable,
          parts: score.parts.map((p) => ({ text: p.text, score: p.score })),
          feedback,
          newAchievements: awarded,
          // Travels with EVERY score. A parent looking at numbers about their
          // child's speech will draw conclusions, and this says which are not
          // available.
          disclaimer: PRACTICE_DISCLAIMER,
        });
      },
    );

    /* ---------------------------------------------------------------------- */
    /* 4. Finish                                                              */
    /* ---------------------------------------------------------------------- */

    app.post(
      '/practice/sessions/:sessionId/complete',
      {
        onRequest: [app.authenticate],
        preHandler: [app.authorize('conversations:read_own')],
        schema: {
          params: z.object({ sessionId: z.uuid() }),
          body: z.object({ status: z.enum(['completed', 'abandoned']).default('completed') }),
          response: { 200: sessionSchema },
        },
      },
      async (request, reply) => {
        const session = await app.withParent(request, async (tx) => {
          const { rows } = await tx.query<{
            id: string;
            child_id: string;
            exercise_key: string;
            language_code: string;
            status: 'in_progress' | 'completed' | 'abandoned';
            attempt_count: number;
            average_score: number | null;
            started_at: string;
            completed_at: string | null;
          }>(
            `update speech_practice
                set status = case when status = 'in_progress' then $2 else status end,
                    completed_at = coalesce(completed_at, now())
              where id = $1
              returning id, child_id, exercise_key, language_code, status,
                        attempt_count, average_score, started_at, completed_at`,
            [request.params.sessionId, request.body.status],
          );

          const row = rows[0];
          if (!row) throw notFound();
          return row;
        });

        return await reply.status(200).send({
          id: session.id,
          childId: session.child_id,
          exerciseKey: session.exercise_key,
          language: session.language_code,
          status: session.status,
          attemptCount: session.attempt_count,
          averageScore: session.average_score,
          startedAt: new Date(session.started_at).toISOString(),
          completedAt:
            session.completed_at === null ? null : new Date(session.completed_at).toISOString(),
        });
      },
    );

    /* ---------------------------------------------------------------------- */
    /* 5. History, progress, and achievements                                 */
    /* ---------------------------------------------------------------------- */

    app.get(
      '/practice/progress',
      {
        onRequest: [app.authenticate],
        preHandler: [app.authorize('conversations:read_own')],
        schema: {
          querystring: z.object({
            childId: z.uuid(),
            limit: z.coerce.number().int().min(1).max(100).default(20),
          }),
          response: {
            200: z.object({
              sessions: z.array(sessionSchema),
              skills: z.array(
                z.object({
                  skillKey: z.string(),
                  exposureCount: z.number().int(),
                  lastPractisedAt: z.string(),
                }),
              ),
              achievements: z.array(
                z.object({ key: z.string(), title: z.string(), awardedAt: z.string() }),
              ),
              disclaimer: z.string(),
            }),
          },
        },
      },
      async (request, reply) => {
        const data = await app.withParent(request, async (tx) => {
          await requireChildOwnership(tx, request.query.childId);

          const { rows: sessions } = await tx.query<{
            id: string;
            child_id: string;
            exercise_key: string;
            language_code: string;
            status: 'in_progress' | 'completed' | 'abandoned';
            attempt_count: number;
            average_score: number | null;
            started_at: string;
            completed_at: string | null;
          }>(
            `select id, child_id, exercise_key, language_code, status,
                    attempt_count, average_score, started_at, completed_at
               from speech_practice
              where child_id = $1
              order by started_at desc
              limit $2`,
            [request.query.childId, request.query.limit],
          );

          // EXPOSURE ONLY. `success_count` exists in the table and is not
          // returned here: the schema comment forbids presenting it to a parent
          // as an educational score, and the surest way to honour that is not to
          // send it (Q-12).
          const { rows: skills } = await tx.query<{
            skill_key: string;
            exposure_count: number;
            last_observed_at: string;
          }>(
            `select skill_key, exposure_count, last_observed_at
               from learning_progress
              where child_id = $1
              order by last_observed_at desc`,
            [request.query.childId],
          );

          const { rows: achievements } = await tx.query<{
            achievement_key: string;
            title: string;
            awarded_at: string;
          }>(
            `select a.achievement_key, a.title, ca.awarded_at
               from child_achievements ca
               join achievements a on a.id = ca.achievement_id
              where ca.child_id = $1
              order by ca.awarded_at desc`,
            [request.query.childId],
          );

          return { sessions, skills, achievements };
        });

        return await reply.status(200).send({
          sessions: data.sessions.map((s) => ({
            id: s.id,
            childId: s.child_id,
            exerciseKey: s.exercise_key,
            language: s.language_code,
            status: s.status,
            attemptCount: s.attempt_count,
            averageScore: s.average_score,
            startedAt: new Date(s.started_at).toISOString(),
            completedAt: s.completed_at === null ? null : new Date(s.completed_at).toISOString(),
          })),
          skills: data.skills.map((s) => ({
            skillKey: s.skill_key,
            exposureCount: s.exposure_count,
            lastPractisedAt: new Date(s.last_observed_at).toISOString(),
          })),
          achievements: data.achievements.map((a) => ({
            key: a.achievement_key,
            title: a.title,
            awardedAt: new Date(a.awarded_at).toISOString(),
          })),
          disclaimer: PRACTICE_DISCLAIMER,
        });
      },
    );
  };
