import { asSystem, type Database } from '@kids/db';
import type { FastifyRequest } from 'fastify';

/**
 * Audit logging for security-relevant actions.
 *
 * Records WHO did WHAT to WHICH resource, and whether it succeeded. Never the
 * content of what was accessed: an entry saying "an operator read a transcript"
 * must not contain the transcript, or the audit log becomes a second,
 * less-protected copy of the thing it exists to protect (docs/LOGGING.md §8).
 *
 * Writes run under the system context because `audit_logs` has no SELECT policy
 * for `authenticated` — a principal cannot read, edit, or remove the record of
 * their own actions.
 */

export const AUDIT_ACTIONS = [
  'auth.registration.succeeded',
  'auth.registration.duplicate_email',
  'auth.login.succeeded',
  'auth.login.failed',
  'auth.login.locked_out',
  'auth.logout.succeeded',
  'auth.session.refreshed',
  'auth.session.reuse_detected',
  'auth.session.revoked_all',
  'auth.email.verification_requested',
  'auth.email.verified',
  'auth.password.reset_requested',
  'auth.password.reset_completed',
  'auth.password.changed',
  'account.profile.updated',
  'child.profile.created',
  'child.profile.updated',
  'child.profile.archived',
  'child.profile.restored',
  'child.profile.deleted',
  'conversation.started',
  'conversation.ended',
  'conversation.quota_exhausted',
  'safety.escalation.raised',
  'consent.granted',
  'consent.withdrawn',
  'account.deletion.requested',
  'account.deletion.cancelled',
  /* A parent asked for a copy of everything. Audited for the same reason the
   * deletion request is: "who asked for this family's whole history, and when?"
   * is a question that must be answerable afterwards. */
  'account.export.requested',
  /* The one support surface in the product. Carries an app version, a platform
   * and a request id — never a transcript, never a recording, never free text.
   * See `POST /v1/support/diagnostics`. */
  'support.diagnostics.submitted',
  'authz.permission.denied',
  'authz.ownership.denied',
  'admin.role.assigned',
  'admin.account.suspended',
  'support.flag.reviewed',

  // Voice. The retention DECISION is audited on every turn, so "were
  // recordings kept?" is answerable from the audit log alone rather than by
  // trusting that a configuration value was what someone said it was.
  'voice.turn.completed',
  'voice.audio.expired',

  /* Privacy. The counterpart to the line above, for text: a deletion nobody can
   * prove happened is not much of a guarantee. One row per child per sweep,
   * carrying a COUNT and nothing else — this is the record that answers "you
   * said you delete after thirty days, did you?" without itself holding
   * anything that would need deleting. */
  'privacy.transcript.redacted',

  // Practice.
  'practice.session.started',

  // Parental controls. "Who loosened this, and when?" has to be answerable.
  'parental_controls.updated',
  'conversation.parental_limit_reached',

  // Billing. A subscription changing state is a financial event, and the
  // question "who did this — the parent, or a webhook?" must be answerable
  // long after the fact.
  'subscription.checkout.opened',
  'subscription.activated',
  'subscription.renewed',
  'subscription.payment_failed',
  'subscription.grace_started',
  'subscription.cancel_requested',
  'subscription.cancelled',
  'subscription.resume_requested',
  'subscription.resumed',
  'subscription.expired',
  'subscription.refunded',
  'webhook.received',
  'webhook.rejected',
  'webhook.replayed',

  // Payments. Separate from the subscription actions above, because they
  // answer a different question: "did money move?", not "what is this family
  // entitled to?".
  'payment.initiated',
  'payment.captured',
  'payment.failed',
  'payment.cancelled',
  'payment.unresolved',
  'payment.reconciled',
  'payment.refund_requested',
  'payment.refund_succeeded',
  'payment.refund_refused',
  'payment.rail_unavailable',

  // Mobile store billing. Separate again: a store owns the subscription and we
  // mirror it, so these record what the STORE said and what we did about it —
  // never what a device claimed.
  'store.purchase.verified',
  'store.purchase.not_entitled',
  'store.purchase.rejected',
  // The same purchase presented under two accounts. Recorded with both parent
  // ids, because one purchase attempted by a dozen accounts is a very different
  // thing from a family reinstalling on a second device.
  'store.purchase.conflict',
  'store.purchases.restored',
  'store.subscription.synchronised',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export type ActorType = 'parent' | 'child_session' | 'system' | 'operator' | 'service_role';

export interface AuditEntry {
  readonly actorId?: string | undefined;
  readonly actorType: ActorType;
  readonly action: AuditAction;
  readonly resourceType: string;
  readonly resourceId?: string | undefined;
  readonly subjectChildId?: string | undefined;
  readonly outcome: 'success' | 'denied' | 'error';
  /** Required for service_role actions — an RLS-bypassing action needs a reason. */
  readonly justification?: string | undefined;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
}

export interface AuditLogger {
  record(entry: AuditEntry, request?: FastifyRequest): Promise<void>;
}

export const createAuditLogger = (db: Database): AuditLogger => ({
  record: async (entry, request) => {
    await asSystem(db, async (tx) => {
      await tx.query(
        `insert into audit_logs
           (actor_id, actor_type, action, resource_type, resource_id, subject_child_id,
            outcome, justification, request_id, source_ip, user_agent, metadata)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          entry.actorId ?? null,
          entry.actorType,
          entry.action,
          entry.resourceType,
          entry.resourceId ?? null,
          entry.subjectChildId ?? null,
          entry.outcome,
          entry.justification ?? null,
          request?.requestId ?? null,
          request?.ip ?? null,
          request?.headers['user-agent'] ?? null,
          JSON.stringify(entry.metadata ?? {}),
        ],
      );
    });
  },
});

/**
 * An audit write that fails must fail the operation.
 *
 * A security-relevant action that could not be recorded is an unaccountable
 * action, and the correct response is to refuse it rather than perform it
 * invisibly (docs/ERROR_HANDLING.md §9). This wrapper exists so that intent is
 * explicit at each call site rather than implied by the absence of a `.catch()`.
 */
export const auditOrFail = async (
  logger: AuditLogger,
  entry: AuditEntry,
  request?: FastifyRequest,
): Promise<void> => {
  await logger.record(entry, request);
};
