/**
 * The learning-event architecture.
 *
 * ONE APPEND-ONLY LOG, AND EVERYTHING ELSE IS DERIVED FROM IT. Daily rollups,
 * weekly rollups, levels, and milestones are all recomputable from
 * `learning_events`, which is what makes it safe to change how a metric is
 * defined later: you rebuild rather than migrate a number nobody can re-derive.
 *
 * ADDING AN ACTIVITY IS A ROW, NOT A RELEASE. The taxonomy lives in
 * `learning_event_types`, so a new activity — a reading game, a drawing
 * description, a counting exercise — is an INSERT plus, when its metric is
 * designed, a rollup column. `metricKey: null` is a legitimate state meaning
 * "recorded, not yet aggregated", and is far better than inventing a metric to
 * make a new activity fit an existing column.
 *
 * The payload is NON-CONTENT METADATA ONLY: counts, durations, curated keys.
 * A transcript here is a defect, and the schema bounds the column to 2 KB to
 * make that harder to do by accident.
 */

export const CORE_EVENT_TYPES = [
  'skill_exposed',
  'skill_practised',
  'skill_succeeded',
  'word_encountered',
  'story_completed',
  'session_completed',
  'conversation_turn',
  'conversation_time',
  'conversation_ended',
  'vocabulary_new',
  'pronunciation_scored',
] as const;

/**
 * The types this codebase knows by name.
 *
 * Deliberately NOT a closed union at the type level — `LearningEventType` is a
 * string, because the store is the authority and a type that had to be edited
 * for every new activity would defeat the point of the table.
 */
export type CoreEventType = (typeof CORE_EVENT_TYPES)[number];
export type LearningEventType = CoreEventType | (string & {});

export interface LearningEvent {
  readonly childId: string;
  readonly eventType: LearningEventType;
  readonly skillKey?: string;
  readonly conversationId?: string;
  readonly speechPracticeId?: string;
  /** Counts, durations, curated keys. Never anything the child said. */
  readonly payload?: Readonly<Record<string, number | string | boolean>>;
  readonly occurredAt: Date;
  /**
   * De-duplication handle.
   *
   * A retried request must not double-count a child's morning. Callers that can
   * name the thing that happened — a message id, a practice attempt id — should.
   */
  readonly idempotencyKey?: string;
}

/**
 * Keys that must never appear in a payload.
 *
 * The payload is the one open-shaped field in this subsystem, which makes it the
 * place transcript text ends up when somebody is in a hurry. Checked on the way
 * in rather than discovered later in a log aggregator.
 */
const FORBIDDEN_PAYLOAD_KEYS: readonly string[] = Object.freeze([
  'text',
  'transcript',
  'utterance',
  'message',
  'content',
  'reply',
  'name',
  'displayName',
  'display_name',
  'email',
]);

export class InvalidLearningEventError extends Error {
  override readonly name = 'InvalidLearningEventError';
  readonly reason: string;

  constructor(reason: string) {
    super(`invalid learning event: ${reason}`);
    this.reason = reason;
  }
}

/**
 * Rejects an event that carries content.
 *
 * Throws rather than stripping. Silently removing the field would let the
 * mistake persist and ship; failing makes it a bug someone fixes today — the
 * same reasoning as `assertNoProhibitedData` on the provider boundary.
 */
export const assertPayloadIsMetadata = (event: LearningEvent): void => {
  const payload = event.payload ?? {};

  for (const key of Object.keys(payload)) {
    if (FORBIDDEN_PAYLOAD_KEYS.includes(key)) {
      throw new InvalidLearningEventError(`payload key "${key}" may carry content`);
    }
  }

  for (const [key, value] of Object.entries(payload)) {
    // A long string in a metadata payload is a sentence, and a sentence in this
    // subsystem is something a child said.
    if (typeof value === 'string' && value.length > 64) {
      throw new InvalidLearningEventError(`payload value for "${key}" is too long to be metadata`);
    }
  }
};

/** The UTC day an event belongs to. Aggregation and display must agree on this. */
export const dayOf = (occurredAt: Date): string => occurredAt.toISOString().slice(0, 10);

/**
 * The Monday of the week containing a date, in UTC.
 *
 * Mirrors `app.week_start()`. Two definitions of "week" produce a dashboard that
 * disagrees with its own totals, so both exist and a test pins them together.
 */
export const weekStartOf = (occurredAt: Date): string => {
  const date = new Date(
    Date.UTC(occurredAt.getUTCFullYear(), occurredAt.getUTCMonth(), occurredAt.getUTCDate()),
  );
  // getUTCDay: 0 = Sunday. ISO weeks start Monday, so Sunday is day 7.
  const isoDay = date.getUTCDay() === 0 ? 7 : date.getUTCDay();
  date.setUTCDate(date.getUTCDate() - (isoDay - 1));
  return date.toISOString().slice(0, 10);
};
