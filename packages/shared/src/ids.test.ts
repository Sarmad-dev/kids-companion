import { describe, expect, it } from 'vitest';

import { createId, isIdOfKind, parseIdPrefix, uuidv7 } from './ids.js';

describe('uuidv7', () => {
  it('produces a valid v7 UUID', () => {
    expect(uuidv7()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('sorts lexicographically in time order', () => {
    // This is the whole reason for v7 over v4: time-ordered keys keep B-tree
    // inserts local instead of scattering across the index.
    const early = uuidv7(1_700_000_000_000);
    const late = uuidv7(1_800_000_000_000);

    expect(early < late).toBe(true);
  });

  it('is unique across a tight loop at the same timestamp', () => {
    const ids = new Set(Array.from({ length: 1_000 }, () => uuidv7(1_700_000_000_000)));

    expect(ids.size).toBe(1_000);
  });
});

describe('createId', () => {
  it('prefixes by kind so a log line is self-describing', () => {
    expect(createId('child')).toMatch(/^chp_/);
    expect(createId('conversation')).toMatch(/^cnv_/);
  });

  it('distinguishes kinds, which is what stops a ChildId being used as a ParentId', () => {
    const childId = createId('child');

    expect(isIdOfKind(childId, 'child')).toBe(true);
    expect(isIdOfKind(childId, 'parent')).toBe(false);
  });
});

describe('parseIdPrefix', () => {
  it('recovers the kind from a well-formed id', () => {
    expect(parseIdPrefix(createId('message'))).toBe('message');
  });

  it('returns undefined for an unrecognised prefix', () => {
    expect(parseIdPrefix('zzz_0198f2c1')).toBeUndefined();
  });
});
