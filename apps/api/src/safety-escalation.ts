import { asSystem, type Database } from '@kids/db';
import type { Clock, Logger } from '@kids/shared';

/**
 * Routing a safety escalation to a human.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE GAP THIS CLOSES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * docs/CHILD_SAFETY.md §6.1 item 5: "escalation is recorded and routed to a
 * defined human path". Recording already worked. Routing did not —
 * `SAFETY_ESCALATION_WEBHOOK_URL` was *required* for production to boot and read
 * by nothing, so a child disclosing harm produced an audit row, a `warn` line,
 * and silence.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THIS DOES NOT DECIDE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Who is notified. §6.2 says plainly that the obvious answer — the parent — is
 * UNSAFE when the disclosure concerns the parent, and that the question needs
 * child-protection expertise and legal counsel. So this delivers to whatever
 * endpoint the operator configures and takes no view on who reads it. It is
 * deliberately NOT the `notifications` table, which is parent-readable.
 *
 * Q-07 stays open. What changes is that resolving it becomes a configuration
 * and process decision rather than an unwritten feature.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THREE PROPERTIES THAT MATTER MORE THAN DELIVERY SPEED
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * NEVER FAILS THE TURN. A child mid-conversation must not see an error because
 * a webhook is down. Delivery is attempted after the response is on its way and
 * every failure is swallowed — into the ledger, never into the request.
 *
 * NEVER LOST. Every escalation is written to `safety_escalations` BEFORE
 * delivery is attempted. If the endpoint is unreachable the row stays `pending`
 * and the worker retries it. A dropped disclosure notification is the failure
 * this whole file exists to prevent.
 *
 * NEVER CARRIES THE DISCLOSURE. The payload is a pointer — what happened, why,
 * and where to look. Not what the child said. See `buildPayload`.
 */

export type EscalationReasonCode =
  | 'signal_category'
  | 'evasion_of_safety'
  | 'repeated_attempts'
  /** The rule could not be named. Still routed — see the migration's comment. */
  | 'unspecified';

export interface EscalationRecord {
  readonly childId: string;
  readonly conversationId: string;
  readonly reason: EscalationReasonCode;
  readonly categories: readonly string[];
  readonly severity: 'low' | 'medium' | 'high' | 'critical';
}

/** Posts a body to a url. Injected so delivery is testable without a network. */
export type EscalationTransport = (
  url: string,
  body: string,
  signal: AbortSignal,
) => Promise<{ ok: boolean; status: number }>;

export interface EscalationDeliveryOptions {
  readonly db: Database;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Undefined means no endpoint is configured. See `record` for what happens. */
  readonly webhookUrl: string | undefined;
  readonly transport?: EscalationTransport;
  readonly timeoutMs?: number;
  /** Called when delivery fails, so a failed escalation is itself an alert. */
  readonly onDeliveryFailure?: (detail: string) => void;
}

/**
 * The webhook body.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * A POINTER, NOT A DISCLOSURE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * No transcript, no reply, no child name, no free text of any kind. A reviewer
 * gets the fact that something happened, which rule fired, which categories,
 * and the identifiers needed to open the case in a system with real access
 * control.
 *
 * The child id IS included, and that is a considered exception rather than an
 * oversight. Analytics events refuse child identifiers because they go to a
 * third-party product-metrics vendor. This endpoint is the operator's own
 * safeguarding path, and a reviewer who cannot tell which child is involved
 * cannot act — which is the entire point of routing. §6.1 item 5 requires a
 * DEFINED human path, and a path that cannot identify the case is not one.
 */
const buildPayload = (
  id: string,
  record: EscalationRecord,
  occurredAt: string,
): Record<string, unknown> => ({
  event: 'safety.escalation',
  version: 1,
  escalationId: id,
  occurredAt,
  reason: record.reason,
  categories: [...record.categories],
  severity: record.severity,
  childId: record.childId,
  conversationId: record.conversationId,
  // Stated in the payload so it survives being forwarded into a chat channel
  // by whatever receives it.
  handling:
    'Contains no conversation content by design. Open the case in the console. ' +
    'Do not question the child; see the disclosure protocol.',
});

/** Trimmed hard: an endpoint that echoes the request would otherwise store it. */
const shortError = (value: unknown): string => {
  const text = value instanceof Error ? value.message : String(value);
  return text.replace(/\s+/g, ' ').slice(0, 200);
};

export const createEscalationDelivery = (options: EscalationDeliveryOptions) => {
  const { db, clock, logger, webhookUrl } = options;
  const timeoutMs = options.timeoutMs ?? 5_000;

  const transport: EscalationTransport =
    options.transport ??
    (async (url, body, signal) => {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal,
      });
      return { ok: response.ok, status: response.status };
    });

  /** One delivery attempt. Updates the ledger either way; never throws. */
  const attempt = async (
    id: string,
    record: EscalationRecord,
    occurredAt: string,
  ): Promise<boolean> => {
    if (webhookUrl === undefined || webhookUrl === '') {
      /* No endpoint configured. The row stays `pending` on purpose — it is not
       * "delivered", and marking it so would turn a missing configuration into
       * a silent success. Production refuses to boot without the URL, so this
       * is a local and CI state. */
      logger.warn(
        { escalationId: id, control: 'safety_escalation_delivery' },
        'safety escalation recorded but NOT routed: no webhook configured',
      );
      return false;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    try {
      const result = await transport(
        webhookUrl,
        JSON.stringify(buildPayload(id, record, occurredAt)),
        controller.signal,
      );

      if (!result.ok) throw new Error(`endpoint returned ${String(result.status)}`);

      await asSystem(db, async (tx) => {
        await tx.query(
          `update safety_escalations
              set delivery_status = 'delivered',
                  delivered_at = $2::timestamptz,
                  attempts = attempts + 1,
                  last_attempt_at = $2::timestamptz,
                  last_error = null
            where id = $1::uuid`,
          [id, clock.nowIso()],
        );
      });

      logger.info({ escalationId: id }, 'safety escalation routed');
      return true;
    } catch (error) {
      const detail = shortError(error);

      await asSystem(db, async (tx) => {
        await tx.query(
          `update safety_escalations
              set attempts = attempts + 1,
                  last_attempt_at = $2::timestamptz,
                  last_error = $3
            where id = $1::uuid`,
          [id, clock.nowIso(), detail],
        );
      }).catch(() => {
        // The ledger update failing is itself survivable: the row is already
        // `pending`, which is the state the sweep looks for.
      });

      /* A safety escalation that could not be routed is a failure of the safety
       * pipeline, not a networking footnote. It fires the alert that pages on
       * first occurrence. */
      options.onDeliveryFailure?.(`escalation ${id} could not be routed: ${detail}`);

      logger.error(
        { escalationId: id, err: error, control: 'safety_escalation_delivery' },
        'safety escalation could not be routed — it remains pending',
      );
      return false;
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    /**
     * Writes the escalation down, then tries to route it.
     *
     * Returns as soon as the row is durable. Delivery runs after, without the
     * caller waiting: a child's turn must not depend on a webhook.
     */
    record: async (record: EscalationRecord): Promise<string | undefined> => {
      const occurredAt = clock.nowIso();

      /* ═══════════════════════════════════════════════════════════════════
       * THIS FUNCTION MUST NOT THROW. EVER.
       * ═══════════════════════════════════════════════════════════════════
       *
       * It is called from the middle of a child's turn. A rejected insert —
       * the database down, a value the column will not take — would propagate
       * into that turn and fail it, which turns a safety-recording problem into
       * the child seeing an error.
       *
       * Caught by a test that passed a conversation id the uuid column
       * rejected: the exception came straight back out to the caller. Delivery
       * failures were already swallowed; the insert was not.
       */
      const id = await asSystem(db, async (tx) => {
        const { rows } = await tx.query<{ id: string }>(
          `insert into safety_escalations
             (child_id, conversation_id, reason, categories, severity, occurred_at)
           values ($1::uuid, $2::uuid, $3, $4::text[], $5, $6::timestamptz)
           returning id`,
          [
            record.childId,
            // Nullable in the column, so an absent conversation is null rather
            // than an empty string the uuid cast refuses.
            record.conversationId === '' ? null : record.conversationId,
            record.reason,
            [...record.categories],
            record.severity,
            occurredAt,
          ],
        );
        return rows[0]?.id;
      }).catch((error: unknown) => {
        logger.error(
          { err: error, control: 'safety_escalation_delivery' },
          'safety escalation could not be written down',
        );
        return undefined;
      });

      if (id === undefined) {
        // Nothing was written, so nothing will be retried. Loudest possible.
        options.onDeliveryFailure?.('an escalation could not be recorded at all');
        logger.error(
          { control: 'safety_escalation_delivery' },
          'safety escalation could not be recorded',
        );
        return undefined;
      }

      void attempt(id, record, occurredAt);
      return id;
    },

    /** The worker sweep. Retries everything no human has been told about. */
    retryPending: async (limit = 50): Promise<{ attempted: number; delivered: number }> => {
      const due = await asSystem(db, async (tx) => {
        const { rows } = await tx.query<{
          id: string;
          child_id: string;
          conversation_id: string | null;
          reason: EscalationReasonCode;
          categories: string[];
          severity: EscalationRecord['severity'];
          occurred_at: string;
        }>('select * from app.escalations_awaiting_delivery($1)', [limit]);
        return rows;
      });

      let delivered = 0;
      for (const row of due) {
        const ok = await attempt(
          row.id,
          {
            childId: row.child_id,
            conversationId: row.conversation_id ?? '',
            reason: row.reason,
            categories: row.categories,
            severity: row.severity,
          },
          new Date(row.occurred_at).toISOString(),
        );
        if (ok) delivered += 1;
      }

      return { attempted: due.length, delivered };
    },
  };
};

export type EscalationDelivery = ReturnType<typeof createEscalationDelivery>;
