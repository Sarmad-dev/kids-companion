import { asSystem, type Database } from '@kids/db';
import {
  recordLearningEvent,
  recordLearningEvents,
  weekStartOf,
  type LearningStore,
} from '@kids/learning';
import type { Clock, Logger } from '@kids/shared';

/**
 * Emitting learning events.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE GAP THIS CLOSES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The progress pipeline was built correctly end to end —
 *
 *     event  →  app.rebuild_learning_daily()  →  learning_daily  →  dashboard
 *
 * — and had no producer. `createLearningStore().append()` was called by
 * nothing, every route in `learning.ts` is a GET, and no conversation turn or
 * practice attempt ever emitted anything. So a parent whose child had talked
 * all week opened Progress and saw zeros beside a safety panel that had clearly
 * noticed the conversations. That reads as broken, and it was.
 *
 * Nothing about the design needed changing. This file is the missing wiring.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * TWO RULES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * NEVER FAILS THE THING IT MEASURES. A metric that breaks a child's turn is
 * worse than a missing metric. Every method here swallows its own failures into
 * the log; none of them can reject into a caller.
 *
 * NEVER CARRIES CONTENT. Payloads are counts, durations and scores — never a
 * word the child said. `recordLearningEvent` asserts this and throws rather
 * than stripping, so a payload carrying content is a bug that surfaces in a
 * test rather than a field that silently disappears in production.
 */

export interface LearningRecorderOptions {
  readonly db: Database;
  readonly store: LearningStore;
  readonly clock: Clock;
  readonly logger: Logger;
}

/** Words in an utterance. A COUNT — the words themselves never leave the route. */
export const wordCountOf = (text: string): number =>
  text.trim() === '' ? 0 : text.trim().split(/\s+/).length;

export const createLearningRecorder = (options: LearningRecorderOptions) => {
  const { store, clock, logger } = options;

  /** Runs one emission, absorbing anything it throws. */
  const safely = async (what: string, run: () => Promise<unknown>): Promise<void> => {
    try {
      await run();
    } catch (error) {
      logger.error({ err: error, event: what }, 'learning event not recorded');
    }
  };

  return {
    /**
     * One conversation turn.
     *
     * Two events: the turn itself, and how many words the child used. Both keyed
     * on the message id, so a retried request cannot double-count a child's
     * morning — which is what the idempotency index exists for.
     *
     * No rollup rebuild here. A child mid-conversation should not wait on an
     * aggregation; the day is rebuilt when the conversation ends, and the worker
     * catches anything that never got there.
     */
    turn: async (input: {
      childId: string;
      conversationId: string;
      messageId: string;
      wordCount: number;
    }): Promise<void> => {
      await safely('conversation_turn', async () => {
        const occurredAt = new Date(clock.now());

        await recordLearningEvents(store, [
          {
            childId: input.childId,
            eventType: 'conversation_turn',
            conversationId: input.conversationId,
            occurredAt,
            idempotencyKey: `turn:${input.messageId}`,
          },
          ...(input.wordCount > 0
            ? [
                {
                  childId: input.childId,
                  eventType: 'word_encountered' as const,
                  conversationId: input.conversationId,
                  // `payload_field` here is `count`, summed into `words_used`.
                  payload: { count: input.wordCount },
                  occurredAt,
                  idempotencyKey: `words:${input.messageId}`,
                },
              ]
            : []),
        ]);
      });
    },

    /**
     * A conversation finished.
     *
     * Rebuilds the rollups inline, and this is the right place for it: the
     * session is over so nothing is waiting, and the day is now complete enough
     * that a parent opening the dashboard sees the truth.
     */
    conversationEnded: async (input: {
      childId: string;
      conversationId: string;
      seconds: number;
      /**
       * Whether this was a story the child actually finished.
       *
       * The parent dashboard says "Stories your child finished with their
       * character" and "a story your child abandoned halfway is not counted".
       * The route decides; this only records what it was told.
       */
      storyCompleted?: boolean;
    }): Promise<void> => {
      await safely('conversation_ended', async () => {
        const occurredAt = new Date(clock.now());

        await recordLearningEvents(
          store,
          [
            {
              childId: input.childId,
              eventType: 'conversation_ended',
              conversationId: input.conversationId,
              occurredAt,
              idempotencyKey: `ended:${input.conversationId}`,
            },
            ...(input.seconds > 0
              ? [
                  {
                    childId: input.childId,
                    eventType: 'conversation_time' as const,
                    conversationId: input.conversationId,
                    payload: { seconds: Math.round(input.seconds) },
                    occurredAt,
                    idempotencyKey: `seconds:${input.conversationId}`,
                  },
                ]
              : []),
            ...(input.storyCompleted === true
              ? [
                  {
                    childId: input.childId,
                    eventType: 'story_completed' as const,
                    conversationId: input.conversationId,
                    occurredAt,
                    // Ending is idempotent, so ending twice must not record two
                    // stories.
                    idempotencyKey: `story:${input.conversationId}`,
                  },
                ]
              : []),
          ],
          // One rebuild for both, not one each.
          { rebuildNow: true },
        );
      });
    },

    /**
     * A pronunciation attempt was scored.
     *
     * Averaged rather than summed, so a child who practises more does not appear
     * to pronounce better.
     */
    pronunciationScored: async (input: {
      childId: string;
      speechPracticeId: string;
      attemptRef: string;
      score: number;
    }): Promise<void> => {
      await safely('pronunciation_scored', async () => {
        await recordLearningEvent(
          store,
          {
            childId: input.childId,
            eventType: 'pronunciation_scored',
            speechPracticeId: input.speechPracticeId,
            payload: { score: input.score },
            occurredAt: new Date(clock.now()),
            idempotencyKey: `pron:${input.attemptRef}`,
          },
          { rebuildNow: true },
        );
      });
    },

    /**
     * The backstop, run by the worker.
     *
     * ═══════════════════════════════════════════════════════════════════════
     * A FIVE-YEAR-OLD DOES NOT END CONVERSATIONS.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * The app gets closed, the tablet gets taken away, the battery dies. Those
     * turns are recorded correctly and — without this — would sit in
     * `learning_events` forever while the parent sees zero, which is the exact
     * failure this file exists to fix arriving through a different door.
     *
     * Rebuilds recompute rather than increment, so sweeping a day that did not
     * need it costs a query and nothing else.
     */
    rebuildStale: async (limit = 200): Promise<{ days: number }> => {
      let days = 0;

      await safely('rebuild_stale', async () => {
        const due = await asSystem(options.db, async (tx) => {
          const { rows } = await tx.query<{ child_id: string; day: string }>(
            'select child_id, day::text as day from app.learning_days_awaiting_rebuild($1)',
            [limit],
          );
          return rows;
        });

        for (const row of due) {
          // Per day, so one child's unrebuildable day cannot stall the sweep for
          // everyone behind it.
          await safely('rebuild_stale_day', async () => {
            await store.rebuildDay(row.child_id, row.day);
            await store.rebuildWeek(row.child_id, weekStartOf(new Date(`${row.day}T00:00:00Z`)));
            days += 1;
          });
        }
      });

      return { days };
    },
  };
};

export type LearningRecorder = ReturnType<typeof createLearningRecorder>;
