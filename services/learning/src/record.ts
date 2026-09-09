import { assertPayloadIsMetadata, dayOf, weekStartOf, type LearningEvent } from './events.js';

/**
 * Recording an event.
 *
 * The write is deliberately thin: validate, persist, and tell the caller which
 * day and week now need rebuilding. The rollups are NOT recomputed here — a
 * child mid-conversation should not wait on an aggregation, and the aggregation
 * is idempotent precisely so it can happen out of band.
 */

export interface LearningStore {
  /** Returns false when the idempotency key had already been used. */
  append(event: LearningEvent): Promise<boolean>;
  /** Recomputes a day from the event log. Idempotent. */
  rebuildDay(childId: string, day: string): Promise<void>;
  /** Recomputes a week from its days. Idempotent. */
  rebuildWeek(childId: string, weekStart: string): Promise<void>;
}

export interface RecordResult {
  readonly recorded: boolean;
  readonly day: string;
  readonly weekStart: string;
}

export interface RecordOptions {
  /**
   * Rebuild the rollups now rather than leaving them to the scheduler.
   *
   * Off by default. On for the paths where a parent is about to look at a
   * dashboard, and in tests, where waiting for a scheduler is not an option.
   */
  readonly rebuildNow?: boolean;
}

export const recordLearningEvent = async (
  store: LearningStore,
  event: LearningEvent,
  options: RecordOptions = {},
): Promise<RecordResult> => {
  // Throws rather than stripping. A payload carrying content is a bug to fix
  // today, not a field to quietly drop.
  assertPayloadIsMetadata(event);

  const day = dayOf(event.occurredAt);
  const weekStart = weekStartOf(event.occurredAt);

  const recorded = await store.append(event);

  // A duplicate changes nothing, so there is nothing to rebuild.
  if (recorded && options.rebuildNow === true) {
    await store.rebuildDay(event.childId, day);
    await store.rebuildWeek(event.childId, weekStart);
  }

  return { recorded, day, weekStart };
};

/**
 * Records several events, then rebuilds each affected day and week once.
 *
 * A conversation turn produces three or four events at the same instant.
 * Rebuilding per event would recompute the same day four times for no reason.
 */
export const recordLearningEvents = async (
  store: LearningStore,
  events: readonly LearningEvent[],
  options: RecordOptions = {},
): Promise<readonly RecordResult[]> => {
  const results: RecordResult[] = [];
  for (const event of events) {
    results.push(await recordLearningEvent(store, event, { rebuildNow: false }));
  }

  if (options.rebuildNow !== true) return results;

  const touched = new Map<string, { childId: string; day: string; weekStart: string }>();
  for (const [i, result] of results.entries()) {
    if (!result.recorded) continue;
    const childId = events[i]!.childId;
    touched.set(`${childId}:${result.day}`, {
      childId,
      day: result.day,
      weekStart: result.weekStart,
    });
  }

  for (const entry of touched.values()) {
    await store.rebuildDay(entry.childId, entry.day);
  }
  for (const weekStart of new Set(
    [...touched.values()].map((t) => `${t.childId}:${t.weekStart}`),
  )) {
    const [childId, week] = weekStart.split(':') as [string, string];
    await store.rebuildWeek(childId, week);
  }

  return results;
};
