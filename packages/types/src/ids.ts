/**
 * Branded entity identifiers.
 *
 * Every ID in this system is a string at runtime, which means the compiler would
 * happily let a `ParentId` be passed where a `ChildId` belongs. That confusion is
 * precisely the bug that leaks one family's data to another, so IDs are branded:
 * structurally identical, nominally distinct, zero runtime cost.
 *
 * See docs/CODING_STANDARDS.md#13-branded-ids.
 */

declare const brand: unique symbol;

/** Attach a nominal tag to a structural type. */
export type Brand<T, B extends string> = T & { readonly [brand]: B };

export type ParentId = Brand<string, 'ParentId'>;
export type ChildId = Brand<string, 'ChildId'>;
export type DeviceId = Brand<string, 'DeviceId'>;
export type SessionId = Brand<string, 'SessionId'>;
export type CharacterId = Brand<string, 'CharacterId'>;
export type ConversationId = Brand<string, 'ConversationId'>;
export type MessageId = Brand<string, 'MessageId'>;
export type SubscriptionId = Brand<string, 'SubscriptionId'>;
export type TransactionId = Brand<string, 'TransactionId'>;
export type SafetyVerdictId = Brand<string, 'SafetyVerdictId'>;

/**
 * An ISO 8601 / RFC 3339 timestamp in UTC.
 *
 * Carried as a branded string rather than a `Date` so it survives a JSON round
 * trip unchanged — a `Date` deserialises to a string anyway, and the brand keeps
 * the intent visible at the boundary.
 */
export type IsoTimestamp = Brand<string, 'IsoTimestamp'>;
