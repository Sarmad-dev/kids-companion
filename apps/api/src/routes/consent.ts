import { createHash } from 'node:crypto';

import type { Queryable } from '@kids/db';
import { notFound } from '@kids/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { auditOrFail, type AuditLogger } from '../audit.js';
import { requireChildOwnership } from '../plugins/auth.js';

/**
 * Parental consent.
 *
 * Three things this subsystem is built to be, in order of importance:
 *
 * 1. AUDITABLE. Every grant and every withdrawal is a new row carrying the
 *    policy version and a hash of the exact text shown. The question a regulator
 *    or a parent asks is not "what is consented now?" but "what was consented,
 *    to what wording, on what date?" — and an overwritten row cannot answer it.
 *
 * 2. ENFORCING. A child cannot reach conversation until the required consent
 *    state is satisfied, and that is enforced by an RLS policy on
 *    `conversations`, not by a check in a handler. A handler can be forgotten
 *    on a new route; the policy cannot.
 *
 * 3. CHANGEABLE. WHICH consents are required is data in `consent_requirements`,
 *    not code. A new legal requirement, or one that applies only in one country
 *    from one date, is an INSERT.
 *
 * WHAT THIS IS NOT: compliance. Recording a consent proves a parent clicked
 * something. Whether that click satisfies verifiable parental consent under any
 * given regime is a legal question that no schema answers — see
 * [Q-08](docs/OPEN_QUESTIONS.md) and PRIVACY.md §1. This subsystem is built so
 * the answer can change without the architecture changing.
 */

export interface ConsentRoutesOptions {
  readonly audit: AuditLogger;
}

const CONSENT_TYPES = [
  'terms_of_service',
  'privacy_policy',
  'child_data_processing',
  'transcript_retention',
  'audio_retention',
  'product_analytics',
  'model_improvement',
  'marketing_email',
] as const;

const consentTypeSchema = z.enum(CONSENT_TYPES);
const policyVersionSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const requirementSchema = z.object({
  consentType: consentTypeSchema,
  scope: z.enum(['account', 'child']),
  jurisdiction: z.string(),
  minPolicyVersion: z.string(),
  blocksConversation: z.boolean(),
  rationale: z.string(),
});

export const consentRoutes =
  (options: ConsentRoutesOptions): FastifyPluginAsyncZod =>
  async (app) => {
    const { audit } = options;

    /* ---------------------------------------------------------------------- */
    /* What is being asked, and why                                           */
    /* ---------------------------------------------------------------------- */

    app.get(
      '/v1/consent/requirements',
      {
        onRequest: [app.authenticate],
        schema: {
          description: 'The consents currently required, and the reason for each.',
          response: { 200: z.object({ items: z.array(requirementSchema) }) },
        },
      },
      async (request, reply) => {
        // A parent is entitled to see what is being asked of them and why —
        // which is why `rationale` is a required column and is returned here
        // rather than living in a policy document nobody opens.
        const items = await app.withParent(request, async (tx) => {
          const { rows } = await tx.query<{
            consent_type: string;
            scope: 'account' | 'child';
            jurisdiction: string;
            min_policy_version: string;
            blocks_conversation: boolean;
            rationale: string;
          }>(
            `select consent_type, scope, jurisdiction, min_policy_version,
                    blocks_conversation, rationale
               from consent_requirements
              where effective_from <= now()
                and (effective_until is null or effective_until > now())
              order by blocks_conversation desc, scope, consent_type`,
          );
          return rows;
        });

        return await reply.status(200).send({
          items: items.map((r) => ({
            consentType: r.consent_type as (typeof CONSENT_TYPES)[number],
            scope: r.scope,
            jurisdiction: r.jurisdiction,
            minPolicyVersion: r.min_policy_version,
            blocksConversation: r.blocks_conversation,
            rationale: r.rationale,
          })),
        });
      },
    );

    /* ---------------------------------------------------------------------- */
    /* Recording a decision                                                   */
    /* ---------------------------------------------------------------------- */

    app.post(
      '/v1/consent',
      {
        onRequest: [app.authenticate],
        preHandler: [app.authorize('account:update_own')],
        schema: {
          description: 'Record a consent decision. Grants and withdrawals are both new rows.',
          body: z.object({
            consentType: consentTypeSchema,
            granted: z.boolean(),
            policyVersion: policyVersionSchema,
            /**
             * The exact wording shown. Hashed server-side and discarded — we
             * store proof of what was agreed to, not a second copy of it.
             */
            policyText: z.string().min(1).max(200_000),
            /** Absent for an account-scoped consent. */
            childId: z.uuid().optional(),
          }),
          response: {
            201: z.object({
              recorded: z.boolean(),
              consentType: consentTypeSchema,
              granted: z.boolean(),
              recordedAt: z.string(),
            }),
          },
        },
        config: { rateLimit: { max: 60, timeWindow: '15 minutes' } },
      },
      async (request, reply) => {
        const principal = request.principal;
        if (!principal) throw notFound();

        const body = request.body;
        const textHash = createHash('sha256').update(body.policyText, 'utf8').digest('hex');

        const recorded = await app.withParent(request, async (tx) => {
          if (body.childId !== undefined) {
            // A consent about a child is only meaningful from that child's
            // parent. Ownership is checked before anything is written.
            await requireChildOwnership(tx, body.childId);
          }

          const { rows } = await tx.query<{ recorded_at: string }>(
            `insert into consent_records
               (parent_id, child_id, consent_type, granted, policy_version, policy_text_hash,
                source_ip, user_agent)
             values ($1, $2, $3, $4, $5, $6, $7, $8)
             returning recorded_at`,
            [
              principal.parentId,
              body.childId ?? null,
              body.consentType,
              body.granted,
              body.policyVersion,
              textHash,
              request.ip,
              request.headers['user-agent'] ?? null,
            ],
          );

          const row = rows[0];
          if (!row) throw new Error('failed to record consent');
          return row.recorded_at;
        });

        await auditOrFail(
          audit,
          {
            actorId: principal.parentId,
            actorType: 'parent',
            action: body.granted ? 'consent.granted' : 'consent.withdrawn',
            resourceType: 'consent_record',
            ...(body.childId === undefined ? {} : { subjectChildId: body.childId }),
            outcome: 'success',
            // The type and version, never the text. The text hash lives on the
            // consent row; the audit log records that a decision happened.
            metadata: {
              consentType: body.consentType,
              policyVersion: body.policyVersion,
              scope: body.childId === undefined ? 'account' : 'child',
            },
          },
          request,
        );

        return await reply.status(201).send({
          recorded: true,
          consentType: body.consentType,
          granted: body.granted,
          recordedAt: new Date(recorded).toISOString(),
        });
      },
    );

    /* ---------------------------------------------------------------------- */
    /* History — the auditable record                                         */
    /* ---------------------------------------------------------------------- */

    app.get(
      '/v1/consent/history',
      {
        onRequest: [app.authenticate],
        preHandler: [app.authorize('account:read_own')],
        schema: {
          description: 'Every consent decision this account has made, newest first.',
          querystring: z.object({ childId: z.uuid().optional() }),
          response: {
            200: z.object({
              items: z.array(
                z.object({
                  consentType: consentTypeSchema,
                  granted: z.boolean(),
                  policyVersion: z.string(),
                  policyTextHash: z.string(),
                  childId: z.string().nullable(),
                  recordedAt: z.string(),
                }),
              ),
            }),
          },
        },
      },
      async (request, reply) => {
        const items = await app.withParent(request, async (tx) => {
          const { rows } = await tx.query<{
            consent_type: string;
            granted: boolean;
            policy_version: string;
            policy_text_hash: string;
            child_id: string | null;
            recorded_at: string;
          }>(
            `select consent_type, granted, policy_version, policy_text_hash, child_id, recorded_at
               from consent_records
              where ($1::uuid is null or child_id = $1)
              order by recorded_at desc`,
            [request.query.childId ?? null],
          );
          return rows;
        });

        // The full ledger, not the current state: a parent can see that they
        // granted something in March and withdrew it in June, which is the point
        // of an append-only record.
        return await reply.status(200).send({
          items: items.map((r) => ({
            consentType: r.consent_type as (typeof CONSENT_TYPES)[number],
            granted: r.granted,
            policyVersion: r.policy_version,
            policyTextHash: r.policy_text_hash,
            childId: r.child_id,
            recordedAt: new Date(r.recorded_at).toISOString(),
          })),
        });
      },
    );

    /* ---------------------------------------------------------------------- */
    /* The gate                                                               */
    /* ---------------------------------------------------------------------- */

    app.get(
      '/v1/children/:childId/consent-status',
      {
        onRequest: [app.authenticate],
        preHandler: [app.authorize('children:manage_own')],
        schema: {
          description: 'Whether this child may enter conversation, and what is missing.',
          params: z.object({ childId: z.uuid() }),
          response: {
            200: z.object({
              conversationAllowed: z.boolean(),
              missingConsents: z.array(consentTypeSchema),
              /** Non-blocking consents not yet decided. Surfaced, not enforced. */
              blockedReason: z.enum(['consent', 'archived', 'deleted']).nullable(),
            }),
          },
        },
      },
      async (request, reply) => {
        const status = await app.withParent(request, async (tx) => {
          await requireChildOwnership(tx, request.params.childId);
          return await consentStatus(tx, request.params.childId);
        });

        return await reply.status(200).send(status);
      },
    );
  };

/**
 * The gate, read through the same functions the RLS policy uses.
 *
 * Deliberately not a second implementation: if this disagreed with the policy, a
 * parent would be told they may start a conversation and then be refused by the
 * database, or worse, the other way round.
 */
const consentStatus = async (tx: Queryable, childId: string) => {
  const { rows: missing } = await tx.query<{ consent_type: string }>(
    'select consent_type from app.child_missing_consents($1)',
    [childId],
  );

  const { rows: allowed } = await tx.query<{ ok: boolean }>(
    'select app.child_conversation_allowed($1) as ok',
    [childId],
  );

  const { rows: child } = await tx.query<{ status: string; deleted_at: string | null }>(
    'select status, deleted_at from children where id = $1',
    [childId],
  );

  const conversationAllowed = allowed[0]?.ok === true;

  // The reason matters to the client: "grant consent" and "restore this
  // profile" are different actions, and a single false would leave the app
  // guessing which to offer.
  const blockedReason = conversationAllowed
    ? null
    : child[0]?.deleted_at != null
      ? ('deleted' as const)
      : child[0]?.status === 'archived'
        ? ('archived' as const)
        : ('consent' as const);

  return {
    conversationAllowed,
    missingConsents: missing.map((m) => m.consent_type) as (typeof CONSENT_TYPES)[number][],
    blockedReason,
  };
};

export { consentStatus };
