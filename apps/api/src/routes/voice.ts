import { resolveCharacter, type ConversationEngine, type ProviderRegistry } from '@kids/ai';
import { asSystem, type Database, type Queryable } from '@kids/db';
import { notFound, quotaExhausted, subscriptionRequired, validationFailed } from '@kids/shared';
import type { Clock } from '@kids/shared';
import type { AgeGroup, SupportedLanguage } from '@kids/types';
import {
  fallbackForRejection,
  runVoiceTurn,
  VOICE_FALLBACKS,
  type AudioLimits,
  type AudioStorage,
  type RetentionPolicy,
  type SpeechToTextProvider,
  type TextToSpeechProvider,
} from '@kids/voice';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { auditOrFail, type AuditLogger } from '../audit.js';
import { characterConfigFrom } from '../character-config.js';
import { CHILD_FACING_MESSAGE, checkParentalGate } from '../parental-gate.js';
import { requireChildOwnership } from '../plugins/auth.js';
import type { TurnHealthReporter } from '../turn-health.js';

/**
 * The voice API.
 *
 *   POST /api/voice/turns        upload a recording, get a reply
 *   POST /api/voice/say          hear one word again, in the character's voice
 *   GET  /api/voice/audio/:key   fetch the synthesised reply, once, before it expires
 *
 * THE CLIENT NEVER RECEIVES A STORAGE CREDENTIAL. No presigned upload URL, no
 * bucket token, no direct-to-storage path. A mobile app posts bytes to this API
 * and fetches audio from this API, and the bucket is reachable only from the
 * server. A credential scoped to a bucket of children's voices, shipped inside
 * an app, is a credential in a decompiled APK — and no rotation un-leaks a
 * child's voice (docs/adr/0006).
 *
 * VOICE IS A MODALITY, NOT A SECOND PATH TO THE MODEL. The transcript goes
 * through the same conversation engine a typed message does, safety pipeline and
 * all. Nothing here can bypass INPUT_SAFETY_CHECK.
 */

export interface VoiceRoutesOptions {
  /** Resolves the family's stored preference to an adapter. */
  readonly providers: ProviderRegistry;
  readonly engine: ConversationEngine;
  readonly db: Database;
  readonly audit: AuditLogger;
  readonly stt: SpeechToTextProvider;
  readonly tts: TextToSpeechProvider;
  readonly storage: AudioStorage;
  readonly clock: Clock;
  readonly retention: RetentionPolicy;
  readonly limits: AudioLimits;
  readonly sttTimeoutMs: number;
  readonly ttsTimeoutMs: number;
  readonly maxRetries: number;
  readonly requestTimeoutMs: number;
  readonly encryptionKeyId: string;
  readonly maxExchanges: number;
  readonly rateLimitPerMinute: number;
  /** Reports what a turn says about backend health. See turn-health.ts. */
  readonly health?: TurnHealthReporter;
}

/* -------------------------------------------------------------------------- */
/* Response schemas                                                            */
/* -------------------------------------------------------------------------- */
/* No storage URLs, no bucket names, no provider names, no model names, no      */
/* confidence internals beyond a coarse flag. `audioKey` is an opaque handle     */
/* this API resolves; it is meaningless anywhere else.                          */

const voiceTurnSchema = z.object({
  status: z.enum(['ok', 'blocked', 'escalated', 'degraded', 'ended', 'unintelligible', 'rejected']),
  /** What the companion says. Always present — even when TTS failed. */
  reply: z.string(),
  /** Absent when the audio could not be transcribed, or when it was rejected. */
  transcript: z.string().optional(),
  conversationStatus: z.enum(['active', 'ended', 'flagged']),
  messageId: z.string().nullable(),
  replyMessageId: z.string().nullable(),
  audio: z
    .object({
      key: z.string(),
      mimeType: z.string(),
      durationMs: z.number().int(),
      expiresAt: z.string(),
    })
    .nullable(),
});

const perParent = (request: FastifyRequest): string =>
  request.principal ? `parent:${request.principal.parentId}` : `ip:${request.ip}`;

const parentIdOf = (request: FastifyRequest): string => {
  const principal = request.principal;
  if (!principal) throw new Error('route is missing the authenticate hook');
  return principal.parentId;
};

const encodeContent = (text: string): Buffer => Buffer.from(text, 'utf8');
const decodeContent = (data: Buffer | Uint8Array | string): string =>
  typeof data === 'string'
    ? Buffer.from(data.replace(/^\\x/, ''), 'hex').toString('utf8')
    : Buffer.from(data).toString('utf8');

interface VoiceContextRow {
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
  conversation_status: 'active' | 'ended' | 'flagged';
  conversation_mode: 'chat' | 'story';
  language_code: SupportedLanguage;
  prompt_key: string | null;
  message_count: number;
  voice_id: string | null;
  /* The trait columns, so a character with no `prompt_key` can be composed
   * here exactly as it is on the text route. See character-config.ts. */
  slug: string;
  /* Aliased: `display_name` on this row is the CHILD's, and the two must never
   * be confusable — one of them is transmitted to a provider and one is not. */
  character_display_name: string;
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
  /** The family's chosen conversation vendor. NULL = follow the deployment. */
  ai_provider: string | null;
}

/**
 * Everything the voice turn needs, in one RLS-scoped read.
 *
 * One round trip because this is the latency budget's critical path and voice
 * already spends two provider calls on it (ARCHITECTURE.md §7.1).
 */
const loadVoiceContext = async (
  tx: Queryable,
  conversationId: string,
): Promise<VoiceContextRow | undefined> => {
  const { rows } = await tx.query<VoiceContextRow>(
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
            cv.status as conversation_status,
            cv.mode as conversation_mode,
            cv.language_code,
            ch.prompt_key,
            cv.message_count,
            ch.voice_id,
            ch.slug,
            ch.display_name as character_display_name,
            ch.description,
            ch.allowed_age_groups,
            ch.personality_traits,
            ch.conversation_style,
            ch.vocabulary_style,
            ch.encouragement_style,
            ch.story_style,
            ch.greeting_style,
            ch.farewell_style,
            ch.educational_objectives,
            p.ai_provider
       from conversations cv
       join children c on c.id = cv.child_id
       join ai_characters ch on ch.id = cv.character_id
       join child_learning_preferences clp on clp.child_id = c.id
       join parental_controls pc on pc.child_id = c.id
       -- Still one round trip: the provider preference is another column on a
       -- row this join set already reaches, not a second query.
       join parents p on p.id = c.parent_id
      where cv.id = $1 and c.deleted_at is null`,
    [conversationId],
  );
  return rows[0];
};

interface VoiceEntitlements {
  plan_code: string;
  voice_enabled: boolean;
  daily_voice_turn_limit: number;
}

export const voiceRoutes =
  (options: VoiceRoutesOptions): FastifyPluginAsyncZod =>
  async (app) => {
    const { engine, audit, db } = options;

    /* ---------------------------------------------------------------------- */
    /* POST /api/voice/turns                                                  */
    /* ---------------------------------------------------------------------- */

    app.post(
      '/voice/turns',
      {
        onRequest: [app.authenticate],
        preHandler: [app.authorize('conversations:read_own')],
        schema: {
          description:
            'Upload a recording and receive the reply. Multipart: `conversationId` and `audio`.',
          consumes: ['multipart/form-data'],
          response: { 200: voiceTurnSchema },
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
        const parentId = parentIdOf(request);

        /* --- UPLOAD ------------------------------------------------------
         * `@fastify/multipart` enforces the byte ceiling as the body streams,
         * so an oversized upload is cut off at the socket rather than buffered
         * and then measured. Measuring after buffering means an attacker
         * chooses how much memory we spend.
         */
        let conversationId = '';
        let declaredMimeType = '';
        let audioBytes: Buffer | undefined;
        let truncated = false;

        try {
          for await (const part of request.parts()) {
            if (part.type === 'field' && part.fieldname === 'conversationId') {
              conversationId = String(part.value);
            } else if (part.type === 'file' && part.fieldname === 'audio') {
              declaredMimeType = part.mimetype;
              audioBytes = await part.toBuffer();
              truncated = part.file.truncated;
            } else if (part.type === 'file') {
              // Drain anything unexpected: an unconsumed file part stalls the
              // request, and silently ignoring one is how a second, unvalidated
              // file gets attached.
              await part.toBuffer();
            }
          }
        } catch {
          throw validationFailed([{ field: 'audio', issue: 'could not be read' }]);
        }

        if (!z.uuid().safeParse(conversationId).success) {
          throw validationFailed([{ field: 'conversationId', issue: 'must be a UUID' }]);
        }
        if (!audioBytes || audioBytes.length === 0) {
          throw validationFailed([{ field: 'audio', issue: 'is required' }]);
        }
        if (truncated) {
          throw validationFailed([{ field: 'audio', issue: 'exceeds the maximum size' }]);
        }

        /* --- Ownership, consent, and entitlements, under RLS --- */
        const loaded = await app.withParent(request, async (tx) => {
          // RLS scopes `conversations` to this parent's children, so another
          // family's conversation is simply not here.
          const context = await loadVoiceContext(tx, conversationId);
          if (!context) throw notFound();

          if (context.conversation_status !== 'active') {
            throw validationFailed([{ field: 'conversationId', issue: 'has already ended' }]);
          }
          // Voice is a modality, not a way around a parent's settings.
          const { rows: elapsed } = await tx.query<{ seconds: number }>(
            'select app.conversation_seconds($1) as seconds',
            [conversationId],
          );
          const gate = await checkParentalGate(tx, context.child_id, options.clock, {
            sessionSeconds: elapsed[0]?.seconds ?? 0,
          });

          const { rows: plans } = await tx.query<VoiceEntitlements>(
            `select plan_code, voice_enabled, daily_voice_turn_limit
               from app.parent_entitlements($1)`,
            [parentId],
          );
          const plan = plans[0] ?? {
            plan_code: 'free',
            voice_enabled: true,
            daily_voice_turn_limit: 10,
          };

          const { rows: used } = await tx.query<{ used: number }>(
            'select app.child_voice_turns_used_today($1) as used',
            [context.child_id],
          );

          // Whether this child's parent has specifically opted in to keeping
          // recordings. Absence is the answer in the overwhelming majority of
          // cases, and absence means discard.
          const { rows: consent } = await tx.query<{ granted: boolean }>(
            `select granted from current_consents
              where parent_id = $1
                and consent_type = 'audio_retention'
                and (child_id = $2 or child_id is null)
              order by child_id nulls last
              limit 1`,
            [parentId, context.child_id],
          );

          return {
            context,
            plan,
            gate,
            voiceTurnsUsed: used[0]?.used ?? 0,
            retentionOptIn: consent[0]?.granted === true,
          };
        });

        if (!loaded.gate.result.allowed) {
          const denial = loaded.gate.result.denial ?? 'paused';
          return await reply.status(200).send({
            status: 'ended' as const,
            reply: CHILD_FACING_MESSAGE[denial],
            conversationStatus: 'ended' as const,
            messageId: null,
            replyMessageId: null,
            audio: null,
          });
        }

        if (!loaded.plan.voice_enabled) {
          throw subscriptionRequired({ plan: loaded.plan.plan_code, requires: 'voice' });
        }
        if (loaded.voiceTurnsUsed >= loaded.plan.daily_voice_turn_limit) {
          throw quotaExhausted('QUOTA_DAILY_TURNS_EXHAUSTED', {
            scope: 'voice',
            limit: loaded.plan.daily_voice_turn_limit,
            used: loaded.voiceTurnsUsed,
            plan: loaded.plan.plan_code,
          });
        }

        // A row with a prompt_key uses the reviewed built-in it names; a row
        // without one is composed from its trait selections. The text route
        // has always done both; resolving by prompt_key alone here is what
        // made a configured character unusable the moment a child spoke.
        const config = characterConfigFrom({
          ...loaded.context,
          display_name: loaded.context.character_display_name,
        });
        const character = resolveCharacter({
          promptKey: loaded.context.prompt_key,
          ...(config === undefined ? {} : { config }),
        });
        if (!character) {
          throw validationFailed([
            { field: 'conversationId', issue: 'uses a character that is no longer available' },
          ]);
        }

        /* --- VALIDATE → TRANSCRIBE → SAFETY → AI → TTS ------------------- */
        let turnRecord: Awaited<ReturnType<ConversationEngine['respond']>> | undefined;

        const outcome = await runVoiceTurn(
          {
            stt: options.stt,
            tts: options.tts,
            storage: options.storage,
            clock: options.clock,
            retention: options.retention,
            limits: options.limits,
            sttTimeoutMs: options.sttTimeoutMs,
            ttsTimeoutMs: options.ttsTimeoutMs,
            retry: {
              maxAttempts: options.maxRetries + 1,
              budgetMs: options.requestTimeoutMs,
              baseDelayMs: 200,
              maxDelayMs: 2_000,
            },
          },
          {
            audio: new Uint8Array(audioBytes),
            declaredMimeType,
            ageGroup: loaded.context.age_group,
            languageHints: [loaded.context.language_code, loaded.context.primary_language],
            voiceId: loaded.context.voice_id ?? 'default',
            retentionOptIn: loaded.retentionOptIn,
          },
          async (transcript: string) => {
            const history = await app.withParent(request, async (tx) => {
              const { rows } = await tx.query<{
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
              return rows.reverse();
            });

            const turn = await engine.respond({
              utterance: transcript,
              // Generation only — moderation stays on the deployment's
              // provider whatever a family chose. See RespondInput.provider.
              provider: options.providers.resolve(loaded.context.ai_provider),
              childRef: loaded.context.child_id,
              parental: {
                blockedTopics: loaded.context.blocked_topics,
                storytellingEnabled: loaded.context.storytelling_enabled,
                roleplayEnabled: loaded.context.roleplay_enabled,
              },
              context: {
                childName: loaded.context.display_name,
                ageGroup: loaded.context.age_group,
                language: loaded.context.language_code,
                character,
                history: history.map((m) => ({
                  role: m.role,
                  text: decodeContent(m.content_ciphertext),
                  sequence: m.sequence,
                })),
                // Same rule as the text route: the parental control wins over
                // the mode, so a story stops being one the moment it is turned
                // off — on the child's next turn, not at the end of a session.
                storyMode:
                  loaded.context.conversation_mode === 'story' &&
                  loaded.context.storytelling_enabled,
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

            turnRecord = turn;
            return {
              reply: turn.reply,
              replyForStorage: turn.replyForStorage,
              status: turn.status,
              escalation: turn.escalation,
            };
          },
        );

        // The voice turn is counted whatever happened past validation: a
        // transcription that failed still cost a provider call.
        if (outcome.kind !== 'rejected') {
          await asSystem(db, async (tx) => {
            await tx.query('select app.record_voice_usage($1, 1)', [loaded.context.child_id]);
          });
        }

        /* --- Everything that is not a completed turn ---------------------
         * A CHILD HAS JUST SPOKEN INTO A MICROPHONE. None of these paths return
         * an error status: they return something the character says, so the
         * child hears a friendly voice rather than meeting a spinner
         * (docs/ERROR_HANDLING.md §10).
         */
        if (outcome.kind === 'rejected') {
          request.log.info(
            { requestId: request.requestId, conversationId, reason: outcome.reason },
            'voice upload rejected',
          );
          return await reply.status(200).send({
            status: 'rejected' as const,
            reply: VOICE_FALLBACKS[fallbackForRejection(outcome.reason)],
            conversationStatus: 'active' as const,
            messageId: null,
            replyMessageId: null,
            audio: null,
          });
        }

        if (outcome.kind === 'unintelligible') {
          return await reply.status(200).send({
            status: 'unintelligible' as const,
            reply: VOICE_FALLBACKS.unintelligible,
            conversationStatus: 'active' as const,
            messageId: null,
            replyMessageId: null,
            audio: null,
          });
        }

        if (outcome.kind === 'provider_failed') {
          request.log.warn(
            {
              requestId: request.requestId,
              conversationId,
              stage: outcome.stage,
              timedOut: outcome.timedOut,
            },
            'voice provider failed',
          );
          return await reply.status(200).send({
            status: 'degraded' as const,
            reply: outcome.timedOut
              ? VOICE_FALLBACKS.transcribe_timeout
              : VOICE_FALLBACKS.transcribe_failed,
            conversationStatus: 'active' as const,
            messageId: null,
            replyMessageId: null,
            audio: null,
          });
        }

        /* --- Persist the turn, exactly as the text path does --- */
        const turn = turnRecord;
        if (!turn) throw new Error('voice pipeline completed without a conversation turn');

        const persisted = await app.withParent(request, async (tx) => {
          const nextSequence = loaded.context.message_count;

          const { rows: childRows } = await tx.query<{ id: string }>(
            `insert into messages
               (conversation_id, child_id, role, sequence, content_ciphertext, content_key_id,
                content_length, status, input_mode)
             values ($1, $2, 'child', $3, $4, $5, $6, $7, 'voice')
             returning id`,
            [
              conversationId,
              loaded.context.child_id,
              nextSequence,
              encodeContent(outcome.transcript),
              options.encryptionKeyId,
              outcome.transcript.length,
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
                loaded.context.child_id,
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

          await tx.query(
            `update conversations
                set message_count = message_count + $2,
                    total_input_tokens = total_input_tokens + $3,
                    total_output_tokens = total_output_tokens + $4,
                    total_cost_usd = total_cost_usd + $5,
                    status = case when $6 then 'flagged' else status end
              where id = $1`,
            [
              conversationId,
              turn.status === 'ok' ? 2 : 1,
              turn.usage.inputTokens,
              turn.usage.outputTokens,
              turn.usage.estimatedCostUsd,
              turn.escalation,
            ],
          );

          return { childMessageId, replyMessageId };
        });

        /* --- The audio ledger, and the safety events --- */
        await asSystem(db, async (tx) => {
          if (outcome.uploadKey !== undefined && outcome.audioExpiresAt) {
            // Only reached when a parent specifically opted in. The row exists so
            // the retention is visible and sweepable, never because the audio is
            // wanted.
            await tx.query(
              `insert into audio_artifacts
                 (child_id, conversation_id, message_id, kind, storage_key, mime_type,
                  byte_size, duration_ms, retention_basis, expires_at)
               values ($1, $2, $3, 'child_upload', $4, $5, $6, $7, 'parent_opt_in', $8)`,
              [
                loaded.context.child_id,
                conversationId,
                persisted.childMessageId,
                outcome.uploadKey,
                'audio/wav',
                audioBytes.length,
                null,
                outcome.audioExpiresAt,
              ],
            );
          }

          if (outcome.audioKey !== undefined && outcome.audioExpiresAt) {
            await tx.query(
              `insert into audio_artifacts
                 (child_id, conversation_id, message_id, kind, storage_key, mime_type,
                  byte_size, duration_ms, retention_basis, expires_at)
               values ($1, $2, $3, 'companion_reply', $4, $5, $6, $7, 'synthesis', $8)`,
              [
                loaded.context.child_id,
                conversationId,
                persisted.replyMessageId,
                outcome.audioKey,
                outcome.audioMimeType ?? 'audio/mpeg',
                1,
                outcome.audioDurationMs ?? null,
                outcome.audioExpiresAt,
              ],
            );
          }

          for (const record of turn.safetyRecords) {
            if (record.decision === 'allowed') continue;
            await tx.query(
              `insert into content_flags
                 (child_id, message_id, conversation_id, layer, decision, categories,
                  severity, confidence, detector, policy_version, action_taken, attempt_index)
               values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
              [
                loaded.context.child_id,
                persisted.childMessageId,
                conversationId,
                record.layer,
                record.decision,
                record.categories,
                record.decision === 'escalated' ? 'critical' : 'high',
                record.confidence,
                record.detectors.join(',') || null,
                record.policyVersion,
                record.actionTaken,
                record.attemptIndex,
              ],
            );
          }
        });

        await auditOrFail(
          audit,
          {
            actorId: parentId,
            actorType: 'system',
            action: 'voice.turn.completed',
            resourceType: 'conversation',
            resourceId: conversationId,
            subjectChildId: loaded.context.child_id,
            outcome: 'success',
            metadata: {
              stages: outcome.stagesCompleted,
              // The retention DECISION is audited on every voice turn, so
              // "were recordings kept?" is answerable from the audit log alone.
              uploadRetention: outcome.uploadRetention,
              synthesised: outcome.audioKey !== undefined,
              turnStatus: turn.status,
            },
          },
          request,
        );

        // Same producer as the text route: a voice turn that fails closed is
        // the same safety failure, and must page the same way.
        options.health?.record({ status: turn.status, degradedReason: turn.degradedReason });

        request.log.info(
          {
            requestId: request.requestId,
            conversationId,
            stages: outcome.stagesCompleted,
            turnStatus: turn.status,
            uploadRetention: outcome.uploadRetention,
          },
          'voice turn completed',
        );

        return await reply.status(200).send({
          status: turn.status,
          reply: turn.reply,
          transcript: outcome.transcript,
          conversationStatus: turn.escalation ? ('flagged' as const) : ('active' as const),
          messageId: persisted.childMessageId,
          replyMessageId: persisted.replyMessageId,
          audio:
            outcome.audioKey === undefined || !outcome.audioExpiresAt
              ? null
              : {
                  key: outcome.audioKey,
                  mimeType: outcome.audioMimeType ?? 'audio/mpeg',
                  durationMs: outcome.audioDurationMs ?? 0,
                  expiresAt: outcome.audioExpiresAt.toISOString(),
                },
        });
      },
    );

    /* ---------------------------------------------------------------------- */
    /* POST /api/voice/say                                                    */
    /* ---------------------------------------------------------------------- */

    /**
     * Hear one word again.
     *
     * The child's word list shows the words they have used; tapping one plays
     * it back in their own character's voice. For a pre-reader that is the
     * whole feature — a list of written words they cannot read is not a list.
     *
     * ═══════════════════════════════════════════════════════════════════════
     * WHY THIS TAKES A WORD AND NOT TEXT
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `text` would make this a text-to-speech service that anyone holding a
     * parent token could put arbitrary strings through — billed to us, in a
     * voice we present to children as a character, on a device a child is
     * holding. The word is looked up in TWO places before anything is
     * synthesised:
     *
     *   `vocabulary_words`   the curated, reviewed product list. Not child
     *                        speech, and not anything a client supplied.
     *   `child_vocabulary`   and THIS child has actually used it.
     *
     * A word that fails either check is a 404, not a synthesis. So the set of
     * strings this endpoint can utter is a table an editor maintains, and the
     * request only picks one out of it — which is why there is no prompt
     * injection surface here and no cost surface either.
     *
     * ═══════════════════════════════════════════════════════════════════════
     * THE ARTEFACT IS A COMPANION REPLY, AND EXPIRES LIKE ONE
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Same kind, same ledger, same expiry, same `GET /api/voice/audio/:key`
     * with its two independent checks. It carries no conversation and no
     * message, because it belongs to neither — the ledger's foreign keys are
     * nullable for exactly this kind of row, and RLS on the table is scoped by
     * `child_id`, which this has.
     */
    app.post(
      '/voice/say',
      {
        onRequest: [app.authenticate],
        preHandler: [app.authorize('conversations:read_own')],
        schema: {
          description: "Synthesise one word the child has used, in their character's voice.",
          body: z
            .object({
              childId: z.uuid(),
              /** Looked up, never spoken as given. See the note above. */
              word: z.string().min(1).max(60),
              /** Whose voice. Falls back to the child's preferred character. */
              characterId: z.uuid().optional(),
            })
            .strict(),
          response: {
            200: z.object({
              key: z.string(),
              mimeType: z.string(),
              durationMs: z.number().int(),
              expiresAt: z.string(),
            }),
          },
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
        const { childId, word } = request.body;

        const context = await app.withParent(request, async (tx) => {
          await requireChildOwnership(tx, childId);

          /* The two checks. `word` reaches the query only as a parameter, and
           * only ever as something to MATCH — never as something to speak. */
          const { rows: found } = await tx.query<{ word: string; language_code: string }>(
            `select w.word, w.language_code
               from child_vocabulary cv
               join vocabulary_words w on w.id = cv.vocabulary_word_id
              where cv.child_id = $1 and lower(w.word) = lower($2) and w.is_active
              limit 1`,
            [childId, word],
          );
          const entry = found[0];
          // Not "you may not hear that" — as far as this API is concerned a
          // word this child has not used does not exist.
          if (!entry) throw notFound();

          const { rows: voices } = await tx.query<{ voice_id: string | null }>(
            `select ch.voice_id
               from ai_characters ch
              where ch.id = coalesce(
                      $2::uuid,
                      (select c.preferred_character_id from children c where c.id = $1)
                    )`,
            [childId, request.body.characterId ?? null],
          );

          return { text: entry.word, language: entry.language_code, voiceId: voices[0]?.voice_id };
        });

        const spoken = await options.tts.synthesize({
          text: context.text,
          voiceId: context.voiceId ?? 'default',
          language: context.language as SupportedLanguage,
          timeoutMs: options.ttsTimeoutMs,
        });

        /* The same transient window a reply's audio gets. It is a timeout
         * rather than a retention period: the object exists so the client can
         * fetch it once, and a crash between writing and fetching must not
         * leave a child's character's voice sitting in a bucket forever. */
        const expiresAt = new Date(options.clock.now() + options.retention.transientSeconds * 1000);

        const stored = await options.storage.put({
          kind: 'companion_reply',
          bytes: spoken.audio,
          mimeType: spoken.mimeType,
          durationMs: spoken.durationMs,
          expiresAt,
        });

        // The ledger row is what makes the artefact readable: the GET below
        // reads this table under RLS, so audio with no row here is audio
        // nobody can fetch — including us.
        await asSystem(db, async (tx) => {
          await tx.query(
            `insert into audio_artifacts
               (child_id, conversation_id, message_id, kind, storage_key, mime_type,
                byte_size, duration_ms, retention_basis, expires_at)
             values ($1, null, null, 'companion_reply', $2, $3, $4, $5, 'synthesis', $6)`,
            [
              childId,
              stored.key,
              spoken.mimeType,
              spoken.audio.length,
              spoken.durationMs,
              expiresAt,
            ],
          );
        });

        return await reply.status(200).send({
          key: stored.key,
          mimeType: spoken.mimeType,
          durationMs: spoken.durationMs,
          expiresAt: expiresAt.toISOString(),
        });
      },
    );

    /* ---------------------------------------------------------------------- */
    /* GET /api/voice/audio/:key                                              */
    /* ---------------------------------------------------------------------- */

    app.get(
      '/voice/audio/:key',
      {
        onRequest: [app.authenticate],
        preHandler: [app.authorize('conversations:read_own')],
        schema: {
          description: 'Fetch synthesised reply audio. Authorised, and expires.',
          params: z.object({ key: z.string().min(16).max(128) }),
        },
        config: {
          rateLimit: {
            max: options.rateLimitPerMinute * 2,
            timeWindow: '1 minute',
            keyGenerator: perParent,
          },
        },
      },
      async (request, reply) => {
        const { key } = request.params;

        // TWO INDEPENDENT CHECKS, and both must pass.
        //
        // The ledger read runs under RLS, so it returns a row only if this
        // artefact belongs to one of the caller's own children — an unguessable
        // key is not on its own an authorisation. The storage read then enforces
        // expiry, so a key that is still in the ledger but past its lifetime is
        // gone anyway.
        const artefact = await app.withParent(request, async (tx) => {
          const { rows } = await tx.query<{ kind: string; mime_type: string }>(
            `select kind, mime_type from audio_artifacts
              where storage_key = $1 and deleted_at is null and expires_at > now()`,
            [key],
          );
          return rows[0];
        });

        if (!artefact) throw notFound();

        // A child's own upload is never served back over the API. The only
        // legitimate reason to read one is a review process with its own access
        // path, and an endpoint that can replay a child's voice to anyone
        // holding a parent token is one subpoena away from being a problem.
        if (artefact.kind !== 'companion_reply') throw notFound();

        const stored = await options.storage.get(key);
        if (!stored) throw notFound();

        return await reply
          .status(200)
          .header('content-type', stored.meta.mimeType)
          .header('content-length', String(stored.bytes.length))
          // Never cached by an intermediary, and never written to disk by a
          // browser. This is one turn of one child's conversation.
          .header('cache-control', 'private, no-store, max-age=0')
          .header('x-content-type-options', 'nosniff')
          .send(Buffer.from(stored.bytes));
      },
    );
  };

/**
 * Deletes expired audio.
 *
 * The BACKSTOP. Audio is deleted inline when its turn ends; this catches the
 * deletes that did not happen — a crash between writing an object and deleting
 * it, or a storage call that failed. Run on a schedule.
 */
export const sweepExpiredAudio = async (
  db: Database,
  storage: AudioStorage,
): Promise<{ ledger: number; objects: number }> => {
  const expired = await asSystem(db, async (tx) => {
    const { rows } = await tx.query<{ id: string; storage_key: string }>(
      'select * from app.expire_audio_artifacts(500)',
    );
    return rows;
  });

  for (const row of expired) {
    // Best effort per object: one storage failure must not stop the sweep, and
    // the ledger row is already marked so the next pass will not retry forever.
    await storage.delete(row.storage_key).catch(() => undefined);
  }

  const objects = await storage.sweep();
  return { ledger: expired.length, objects };
};
