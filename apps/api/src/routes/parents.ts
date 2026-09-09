import type { ProviderRegistry } from '@kids/ai';
import type { AuthProvider, SessionService } from '@kids/auth';
import { checkPasswordPolicy, permissionsFor } from '@kids/auth';
import { asSystem, type Database } from '@kids/db';
import { notFound, validationFailed } from '@kids/shared';
import { AI_PROVIDER_NAMES, isAiProviderName, type AiProviderName } from '@kids/types';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { auditOrFail, type AuditLogger } from '../audit.js';

/**
 * Parent profile, sessions, children, account deletion, data export, and the
 * one support surface in the product.
 *
 * Every route here demonstrates the four-layer check in `plugins/auth.ts`:
 * authenticated → permitted by role → owns the resource → and the database
 * agrees. The `/children/:childId` routes are where all four matter at once.
 */

export interface ParentRoutesOptions {
  readonly auth: AuthProvider;
  readonly db: Database;
  readonly sessions: SessionService;
  readonly audit: AuditLogger;
  /**
   * Which vendors this deployment can reach.
   *
   * Needed here so the profile reports what is actually SELECTABLE rather than
   * every name the schema knows. A settings screen offering a provider the
   * server has no key for would let a parent save a preference that silently
   * does nothing — the registry would fall back and the screen would keep
   * showing their choice back to them.
   */
  readonly providers: ProviderRegistry;
}

/**
 * A stored provider name, narrowed to the enum the response promises.
 *
 * The column is plain `text` with a check constraint, so the database can only
 * say "one of these four" — it cannot say "one of these four, as a TypeScript
 * union". A value that predates a rename, or arrives from a restore of an older
 * schema, is reported as null (follow the deployment) rather than crashing the
 * response serialiser on a value the schema does not list.
 */
const providerNameOrNull = (value: string | null): AiProviderName | null =>
  isAiProviderName(value) ? value : null;

const parentProfileSchema = z.object({
  id: z.string(),
  email: z.string(),
  displayName: z.string().nullable(),
  countryCode: z.string(),
  locale: z.string(),
  timezone: z.string(),
  role: z.enum(['parent', 'admin', 'support']),
  emailVerified: z.boolean(),
  status: z.string(),
  permissions: z.array(z.string()),
  createdAt: z.string(),
  /**
   * The chosen conversation vendor, or null to follow the deployment.
   *
   * Null is a real answer, not a missing one: it is what every account starts
   * as, and it means "whatever the operator configured" rather than a
   * particular vendor. The screen renders it as its own option.
   */
  aiProvider: z.enum(AI_PROVIDER_NAMES).nullable(),
  /** What `aiProvider` may be set to on THIS deployment. */
  aiProvidersAvailable: z.array(z.enum(AI_PROVIDER_NAMES)),
  /** Which vendor a null preference resolves to right now. */
  aiProviderEffective: z.enum(AI_PROVIDER_NAMES),
});

export const parentRoutes =
  (options: ParentRoutesOptions): FastifyPluginAsyncZod =>
  async (app) => {
    const { audit } = options;

    /* ---------------------------------------------------------------------- */
    /* Profile                                                                */
    /* ---------------------------------------------------------------------- */

    app.get(
      '/v1/parents/me',
      {
        onRequest: [app.authenticate],
        preHandler: [app.authorize('account:read_own')],
        schema: {
          description: 'The authenticated parent.',
          response: { 200: parentProfileSchema },
        },
      },
      async (request, reply) => {
        const principal = request.principal;
        if (!principal) throw notFound();

        // The WHERE is not redundant with RLS, and assuming it was is a bug this
        // route actually had: `parents` has a staff SELECT policy, so for an
        // admin or support user RLS returns EVERY parent, and an unfiltered
        // "select from parents" would hand /me an arbitrary other family's
        // profile. RLS is the backstop for a missed check, never a substitute
        // for making the query say what it means.
        const profile = await app.withParent(request, async (tx) => {
          const { rows } = await tx.query<{
            id: string;
            email: string;
            display_name: string | null;
            country_code: string;
            locale: string;
            timezone: string;
            role: 'parent' | 'admin' | 'support';
            email_verified_at: string | null;
            status: string;
            created_at: string;
            ai_provider: string | null;
          }>(
            `select id, email, display_name, country_code, locale, timezone,
                    role, email_verified_at, status, created_at, ai_provider
               from parents
              where id = $1`,
            [principal.parentId],
          );
          return rows[0];
        });

        if (!profile) throw notFound();

        return await reply.status(200).send({
          id: profile.id,
          email: profile.email,
          displayName: profile.display_name,
          countryCode: profile.country_code,
          locale: profile.locale,
          timezone: profile.timezone,
          role: profile.role,
          emailVerified: profile.email_verified_at !== null,
          status: profile.status,
          permissions: [...permissionsFor(profile.role)],
          createdAt: new Date(profile.created_at).toISOString(),
          // Reported through the registry rather than echoed from the row: a
          // preference naming a vendor whose key has since been rotated out is
          // resolved, not shown back as if it were in effect.
          aiProvider: providerNameOrNull(profile.ai_provider),
          aiProvidersAvailable: [...options.providers.available],
          aiProviderEffective: options.providers.resolve(profile.ai_provider)
            .name as AiProviderName,
        });
      },
    );

    app.patch(
      '/v1/parents/me',
      {
        onRequest: [app.authenticate],
        preHandler: [app.authorize('account:update_own')],
        schema: {
          description: 'Update the authenticated parent. Absent fields are unchanged.',
          body: z.object({
            displayName: z.string().min(1).max(80).nullable().optional(),
            countryCode: z.string().length(2).optional(),
            locale: z.string().min(2).max(10).optional(),
            timezone: z.string().min(1).max(64).optional(),
            /**
             * Which vendor answers this family's children.
             *
             * Explicit null clears the preference and returns the account to
             * the deployment default — the same PATCH semantics as
             * `displayName`, and the only way back to "follow the operator"
             * once a vendor has been named.
             *
             * Validated against what this deployment can actually reach, not
             * against the whole enum: saving a name with no key behind it would
             * be accepted, resolved away on every turn, and shown back to the
             * parent forever as though it had taken effect.
             */
            aiProvider: z
              .enum(AI_PROVIDER_NAMES)
              .nullable()
              .optional()
              .refine(
                (value) =>
                  value == null ||
                  (options.providers.available as readonly string[]).includes(value),
                { message: 'is not configured on this deployment' },
              ),
          }),
          response: { 200: parentProfileSchema.pick({ id: true, displayName: true }) },
        },
      },
      async (request, reply) => {
        const body = request.body;

        // PATCH semantics: an absent key means "leave it alone", an explicit
        // null means "clear it". Conflating them means editing a nickname
        // silently wipes a timezone (docs/API_CONVENTIONS.md §2).
        const updated = await app.withParent(request, async (tx) => {
          const { rows } = await tx.query<{ id: string; display_name: string | null }>(
            `update parents
                set display_name = case when $1 then $2 else display_name end,
                    country_code = coalesce($3, country_code),
                    locale       = coalesce($4, locale),
                    timezone     = coalesce($5, timezone),
                    ai_provider  = case when $6 then $7 else ai_provider end
              where id = $8
              returning id, display_name`,
            [
              Object.hasOwn(body, 'displayName'),
              body.displayName ?? null,
              body.countryCode ?? null,
              body.locale ?? null,
              body.timezone ?? null,
              // Same case/coalesce split as displayName, and for the same
              // reason: null here MEANS something (follow the deployment), so
              // coalesce would make clearing a preference impossible.
              Object.hasOwn(body, 'aiProvider'),
              body.aiProvider ?? null,
              request.principal?.parentId ?? null,
            ],
          );
          return rows[0];
        });

        if (!updated) throw notFound();

        await auditOrFail(
          audit,
          {
            actorId: request.principal?.parentId,
            actorType: 'parent',
            action: 'account.profile.updated',
            resourceType: 'parent',
            resourceId: updated.id,
            outcome: 'success',
            // Field NAMES, never field values. A value here would put personal
            // data into the audit log (docs/LOGGING.md §8).
            metadata: { fields: Object.keys(body) },
          },
          request,
        );

        return await reply.status(200).send({ id: updated.id, displayName: updated.display_name });
      },
    );

    /* ---------------------------------------------------------------------- */
    /* Sessions                                                               */
    /* ---------------------------------------------------------------------- */

    app.get(
      '/v1/parents/me/sessions',
      {
        onRequest: [app.authenticate],
        preHandler: [app.authorize('sessions:read_own')],
        schema: {
          description: 'Where this account is signed in.',
          response: {
            200: z.object({
              items: z.array(
                z.object({
                  id: z.string(),
                  expiresAt: z.string(),
                  revokedAt: z.string().nullable(),
                  current: z.boolean(),
                }),
              ),
            }),
          },
        },
      },
      async (request, reply) => {
        const principal = request.principal;
        if (!principal) throw notFound();

        const records = await options.sessions.listForParent(principal.parentId);

        return await reply.status(200).send({
          items: records.map((s) => ({
            id: s.id,
            expiresAt: new Date(s.expiresAt).toISOString(),
            revokedAt: s.revokedAt === null ? null : new Date(s.revokedAt).toISOString(),
            current: s.id === principal.sessionId,
          })),
        });
      },
    );

    app.post(
      '/v1/parents/me/sessions/revoke-all',
      {
        onRequest: [app.authenticate],
        preHandler: [app.authorize('sessions:revoke_own')],
        schema: {
          description: 'Sign out everywhere, including this session.',
          response: { 200: z.object({ revoked: z.number().int() }) },
        },
      },
      async (request, reply) => {
        const principal = request.principal;
        if (!principal) throw notFound();

        const revoked = await options.sessions.revokeAllForParent(
          principal.parentId,
          'admin_revoked',
        );

        await auditOrFail(
          audit,
          {
            actorId: principal.parentId,
            actorType: 'parent',
            action: 'auth.session.revoked_all',
            resourceType: 'session',
            outcome: 'success',
            metadata: { count: revoked },
          },
          request,
        );

        return await reply.status(200).send({ revoked });
      },
    );

    /* ---------------------------------------------------------------------- */
    /* Password change and account deletion                                   */
    /* ---------------------------------------------------------------------- */

    app.post(
      '/v1/parents/me/password',
      {
        onRequest: [app.authenticate],
        preHandler: [app.authorize('account:update_own')],
        schema: {
          description: 'Change password. Revokes every session, including this one.',
          body: z.object({
            currentPassword: z.string().min(1).max(256),
            newPassword: z.string().min(1).max(256),
          }),
          response: { 200: z.object({ changed: z.boolean() }) },
        },
      },
      async (request, reply) => {
        const principal = request.principal;
        if (!principal) throw notFound();

        const policy = checkPasswordPolicy(request.body.newPassword);
        if (!policy.ok) {
          throw validationFailed([
            { field: 'newPassword', issue: policy.issue ?? 'is not acceptable' },
          ]);
        }

        // Re-authentication, not just an active session. Changing a password is
        // exactly what someone with a stolen device would do first.
        const changed = await options.auth.changePassword(
          principal.parentId,
          request.body.currentPassword,
          request.body.newPassword,
        );

        if (!changed) {
          throw validationFailed([{ field: 'currentPassword', issue: 'is incorrect' }]);
        }

        await auditOrFail(
          audit,
          {
            actorId: principal.parentId,
            actorType: 'parent',
            action: 'auth.password.changed',
            resourceType: 'parent',
            resourceId: principal.parentId,
            outcome: 'success',
            metadata: { sessionsRevoked: true },
          },
          request,
        );

        return await reply.status(200).send({ changed: true });
      },
    );

    app.delete(
      '/v1/parents/me',
      {
        onRequest: [app.authenticate],
        preHandler: [app.authorize('account:delete_own')],
        schema: {
          description: 'Schedule account deletion. Enters the 30-day grace window.',
          body: z.object({ confirmPassword: z.string().min(1).max(256) }),
          response: {
            202: z.object({ status: z.literal('pending_deletion'), graceDays: z.number().int() }),
          },
        },
      },
      async (request, reply) => {
        const principal = request.principal;
        if (!principal) throw notFound();

        // Re-authentication for a destructive action. An active session is not
        // enough for something irreversible (SECURITY.md §2.3).
        const confirmed = await options.auth.verifyCurrentPassword(
          principal.parentId,
          request.body.confirmPassword,
        );

        if (!confirmed) {
          throw validationFailed([{ field: 'confirmPassword', issue: 'is incorrect' }]);
        }

        // A SYSTEM operation, not a parent update — and the schema says so. Every
        // policy on `parents` carries `deleted_at is null`, so the row the update
        // produces would fail its own policy: a parent cannot write themselves
        // into a state where they can no longer act. That is correct. The parent
        // *requests* deletion; the system performs it, with a justification on
        // the audit record (SECURITY.md §3.2).
        await asSystem(options.db, async (tx) => {
          await tx.query(
            `update parents set status = 'pending_deletion', deleted_at = now() where id = $1`,
            [principal.parentId],
          );
        });

        await options.sessions.revokeAllForParent(principal.parentId, 'account_deleted');

        await auditOrFail(
          audit,
          {
            actorId: principal.parentId,
            actorType: 'service_role',
            action: 'account.deletion.requested',
            resourceType: 'parent',
            resourceId: principal.parentId,
            outcome: 'success',
            justification: 'parent-initiated account deletion, re-authenticated',
            metadata: { graceDays: 30 },
          },
          request,
        );

        // The grace window is a deletion in progress, not a hidden account: the
        // parent row is already invisible to RLS, and the retention sweep hard
        // deletes at the end of it (PRIVACY.md §6).
        return await reply.status(202).send({ status: 'pending_deletion' as const, graceDays: 30 });
      },
    );

    /* ---------------------------------------------------------------------- */
    /* Your data                                                              */
    /* ---------------------------------------------------------------------- */

    /**
     * Request an export of everything we hold.
     *
     * ═══════════════════════════════════════════════════════════════════════
     * DELETION HAD AN ENDPOINT; EXPORT HAD A PROMISE
     * ═══════════════════════════════════════════════════════════════════════
     *
     * PRIVACY.md and the privacy centre both offer a parent every profile,
     * every transcript we still hold, and every setting, as a file. That was
     * only ever true if someone asked support for it by hand.
     *
     * ═══════════════════════════════════════════════════════════════════════
     * WHY 202 AND A ROW RATHER THAN A FILE
     * ═══════════════════════════════════════════════════════════════════════
     *
     * The archive is a whole family's history. Building it inside a request
     * means holding a connection for as long as the largest family takes and
     * timing out on exactly the parents with most to export. It is a job, and
     * the worker picks the row up.
     *
     * A parent who taps twice has asked once: the partial unique index on
     * `data_export_requests` makes a second outstanding request a conflict, and
     * a conflict here answers 202 with the request they already have rather
     * than an error about a constraint they cannot see.
     */
    app.post(
      '/v1/parents/me/data-export',
      {
        onRequest: [app.authenticate],
        preHandler: [app.authorize('account:read_own')],
        schema: {
          description: 'Ask for a copy of everything. Answered by email, not in this response.',
          response: {
            202: z.object({
              status: z.enum(['pending', 'running', 'ready']),
              requestedAt: z.string(),
              /** What happens next, in the words the parent will see. */
              note: z.string(),
            }),
          },
        },
      },
      async (request, reply) => {
        const principal = request.principal;
        if (!principal) throw notFound();

        const existing = await app.withParent(request, async (tx) => {
          const { rows } = await tx.query<{ status: string; requested_at: string }>(
            `insert into data_export_requests (parent_id) values ($1)
             on conflict do nothing
             returning status, requested_at`,
            [principal.parentId],
          );

          if (rows[0]) return rows[0];

          // The conflict case: one is already in flight. Report THAT one, so a
          // second tap looks like the same request rather than a failure.
          //
          // Selected without a status filter on purpose. The outstanding row can
          // complete between the insert and this read, and a parent whose export
          // became ready in that instant should be told it is ready rather than
          // meeting an empty result.
          const { rows: latest } = await tx.query<{
            status: string;
            requested_at: string;
          }>(
            `select status, requested_at from data_export_requests
              where parent_id = $1 order by requested_at desc limit 1`,
            [principal.parentId],
          );
          return latest[0];
        });

        // Neither inserted nor found: the row this parent must have is missing,
        // and reporting a request that does not exist would be worse than
        // reporting that something went wrong.
        if (!existing) throw notFound();

        await auditOrFail(
          audit,
          {
            actorId: principal.parentId,
            actorType: 'parent',
            action: 'account.export.requested',
            resourceType: 'parent',
            resourceId: principal.parentId,
            outcome: 'success',
          },
          request,
        );

        return await reply.status(202).send({
          status: existing.status as 'pending' | 'running' | 'ready',
          requestedAt: existing.requested_at,
          note: 'We will email you a link when it is ready. The link works for 24 hours.',
        });
      },
    );

    /* ---------------------------------------------------------------------- */
    /* Support                                                                */
    /* ---------------------------------------------------------------------- */

    /**
     * A diagnostic report, sent by a parent.
     *
     * ═══════════════════════════════════════════════════════════════════════
     * WHAT THIS DELIBERATELY DOES NOT ACCEPT
     * ═══════════════════════════════════════════════════════════════════════
     *
     * No log body, no free-text description, no attachment, no transcript, and
     * no recording. An endpoint that took arbitrary client text would be an
     * endpoint through which a child's conversation could be posted to our
     * servers outside every retention rule that exists to stop exactly that —
     * and "the parent chose to" is not a consent a child gave.
     *
     * What it takes is what identifies the FAILURE: an app version, a platform,
     * and the request id the client already saw in a response header. The
     * server has the logs; the parent has the id that finds them.
     *
     * ═══════════════════════════════════════════════════════════════════════
     * WHY IT LANDS IN THE AUDIT LOG
     * ═══════════════════════════════════════════════════════════════════════
     *
     * "A parent asked us to look at something" is exactly the shape the audit
     * log already records, is already queryable by support, already carries the
     * request context this needs, and is already redacted on write. A second
     * table would be the same rows with fewer guarantees.
     */
    app.post(
      '/v1/support/diagnostics',
      {
        onRequest: [app.authenticate],
        preHandler: [app.authorize('account:read_own')],
        schema: {
          description: 'Report a problem. Carries no transcript, no recording and no free text.',
          body: z
            .object({
              appVersion: z.string().min(1).max(32),
              platform: z.enum(['ios', 'android', 'web', 'windows', 'macos']),
              /** The id the client saw on the failing response. */
              requestId: z.string().max(64).optional(),
              /** One of `FailureKind`, so the client cannot smuggle prose. */
              lastFailureKind: z.string().max(40).optional(),
            })
            .strict(),
          response: {
            202: z.object({
              /** Quote this to support. The one code that surfaces in the product. */
              reference: z.string(),
            }),
          },
        },
      },
      async (request, reply) => {
        const principal = request.principal;
        if (!principal) throw notFound();

        // The request id of THIS call when the client had none to offer: there
        // is always a reference a parent can quote, and it always finds
        // something.
        const reference = request.body.requestId ?? request.id;

        await auditOrFail(
          audit,
          {
            actorId: principal.parentId,
            actorType: 'parent',
            action: 'support.diagnostics.submitted',
            resourceType: 'parent',
            resourceId: principal.parentId,
            outcome: 'success',
            metadata: {
              reference,
              appVersion: request.body.appVersion,
              platform: request.body.platform,
              ...(request.body.lastFailureKind === undefined
                ? {}
                : { lastFailureKind: request.body.lastFailureKind }),
            },
          },
          request,
        );

        return await reply.status(202).send({ reference });
      },
    );
  };
