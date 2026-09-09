import { asSystem, type Database } from '@kids/db';
import type { Logger } from '@kids/shared';

import type { AuditLogger } from './audit.js';

/**
 * Deleting transcripts when their time is up.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE GAP THIS CLOSES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `RETENTION_TRANSCRIPT_DAYS` was configured, validated and documented.
 * `parental_controls.transcript_retention_days` was a per-child setting with its
 * own column, its own CHECK constraint, its own row in the parent dashboard, and
 * a comment explaining that whether ninety days is right is an open question.
 *
 * Between them, nothing deleted a message. Ever.
 *
 * That is worse than not offering the control. A parent who found the setting,
 * thought about it, and changed it to thirty days was told something untrue by
 * a product that asks them to trust it with their child's conversations.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT "DELETED" MEANS HERE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The ciphertext is OVERWRITTEN in place — not flagged, not soft-deleted, not
 * moved. The row survives carrying only what was never content: role, sequence,
 * timestamps, token counts. See the migration for why the row has to survive
 * (`content_flags.message_id` cascades, and a retention setting must not be a
 * way to erase safety history).
 */

export interface TranscriptRetentionOptions {
  readonly db: Database;
  readonly audit: AuditLogger;
  readonly logger: Logger;
  /**
   * The operator ceiling, in days.
   *
   * A cap on the parent's setting, never a floor: the shorter of the two always
   * wins. See `app.effective_transcript_retention_days`.
   */
  readonly ceilingDays: number;
  /** Messages redacted per sweep. Bounded so one pass cannot hold a lock for ever. */
  readonly batchSize?: number;
}

export interface TranscriptRetentionSweep {
  /** Redacts everything past its retention. Returns what it did. */
  run(): Promise<{ children: number; messages: number }>;
}

export const createTranscriptRetention = (
  options: TranscriptRetentionOptions,
): TranscriptRetentionSweep => {
  const { db, audit, logger } = options;
  const batchSize = options.batchSize ?? 500;

  return {
    run: async () => {
      const rows = await asSystem(db, async (tx) => {
        const { rows: redacted } = await tx.query<{ child_id: string; redacted: number }>(
          'select child_id, redacted from app.expire_transcripts($1, $2)',
          [options.ceilingDays, batchSize],
        );
        return redacted;
      }).catch((error: unknown) => {
        /* Swallowed into the log rather than thrown. This runs on the worker's
         * timer; an exception here would take down the process that also
         * retries safety escalations, which is a far worse outcome than a
         * retention pass being late. */
        logger.error(
          { err: error, control: 'transcript_retention' },
          'transcript retention sweep failed',
        );
        return [] as { child_id: string; redacted: number }[];
      });

      /* ═══════════════════════════════════════════════════════════════════
       * A DELETION NOBODY CAN PROVE HAPPENED IS NOT MUCH OF A GUARANTEE.
       * ═══════════════════════════════════════════════════════════════════
       *
       * One audit row per child per sweep, carrying a COUNT and nothing else.
       * This is the record that answers "you said you delete after thirty days
       * — did you?" without holding anything that would need deleting itself.
       *
       * Per child rather than one row for the sweep, because the question is
       * always asked about a particular child.
       */
      for (const row of rows) {
        await audit
          .record({
            actorType: 'system',
            action: 'privacy.transcript.redacted',
            resourceType: 'child',
            resourceId: row.child_id,
            subjectChildId: row.child_id,
            outcome: 'success',
            metadata: { messages: row.redacted, ceilingDays: options.ceilingDays },
          })
          .catch((error: unknown) => {
            // The redaction already happened and is not being undone. An audit
            // failure is loud, not fatal.
            logger.error(
              { err: error, control: 'transcript_retention' },
              'transcript redaction could not be audited',
            );
          });
      }

      const messages = rows.reduce((total, row) => total + row.redacted, 0);

      if (messages > 0) {
        logger.info(
          { control: 'transcript_retention', children: rows.length, messages },
          'transcripts past their retention were redacted',
        );
      }

      return { children: rows.length, messages };
    },
  };
};
