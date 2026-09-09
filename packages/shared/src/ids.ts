import { randomUUID, randomBytes } from 'node:crypto';

/**
 * Identifier generation.
 *
 * IDs are UUIDv7 with a short type prefix. See docs/DATABASE_CONVENTIONS.md §2:
 *
 *   - UUID, not sequential integer, so an ID in a URL does not disclose how many
 *     children are on the platform or invite enumeration.
 *   - v7, not v4, because it is time-ordered — B-tree inserts stay local instead
 *     of scattering across the index. On `turns`, the highest-write table in the
 *     system, that is the difference between healthy and steadily degrading.
 *   - The prefix is application-layer only. It makes a log line self-describing
 *     and makes passing a ChildId where a ConversationId belongs obvious.
 */

export const ID_PREFIXES = {
  parent: 'par',
  child: 'chp',
  device: 'dev',
  session: 'ses',
  conversation: 'cnv',
  message: 'msg',
  subscription: 'sub',
  safetyVerdict: 'sfv',
  character: 'chr',
  transaction: 'txn',
} as const;

export type IdKind = keyof typeof ID_PREFIXES;

/**
 * UUIDv7: 48-bit big-endian timestamp, 4-bit version, 12 bits random,
 * 2-bit variant, 62 bits random.
 */
export const uuidv7 = (now: number = Date.now()): string => {
  const bytes = randomBytes(16);

  bytes.writeUIntBE(now, 0, 6);

  // Version 7 in the high nibble of byte 6.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  // RFC 4122 variant in the top two bits of byte 8.
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
};

/** A prefixed, sortable identifier — e.g. `chp_0198f2c1-...`. */
export const createId = (kind: IdKind, now?: number): string =>
  `${ID_PREFIXES[kind]}_${uuidv7(now)}`;

/** Request identifiers are not persisted, so a v4 is sufficient and cheaper. */
export const createRequestId = (): string => randomUUID();

const PREFIX_VALUES = new Set<string>(Object.values(ID_PREFIXES));

/** Whether a string looks like an ID of the given kind. Shape only — not existence. */
export const isIdOfKind = (value: string, kind: IdKind): boolean =>
  value.startsWith(`${ID_PREFIXES[kind]}_`);

export const parseIdPrefix = (value: string): IdKind | undefined => {
  const prefix = value.split('_')[0];
  if (prefix === undefined || !PREFIX_VALUES.has(prefix)) return undefined;
  return (Object.keys(ID_PREFIXES) as IdKind[]).find((k) => ID_PREFIXES[k] === prefix);
};
