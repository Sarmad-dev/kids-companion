import { createId } from '@kids/shared';
import { describe, expect, it } from 'vitest';

import { childIdSchema, moneySchema, paginationQuerySchema } from './primitives.js';

describe('idSchema', () => {
  it('accepts an id produced by @kids/shared', () => {
    expect(childIdSchema.safeParse(createId('child')).success).toBe(true);
  });

  it('rejects an id of a different kind', () => {
    // Branded types stop this at compile time; this catches it at the boundary,
    // where the value arrives as an untyped string from a client.
    expect(childIdSchema.safeParse(createId('parent')).success).toBe(false);
  });

  it('rejects a bare uuid with no prefix', () => {
    expect(childIdSchema.safeParse('0198f2c1-1111-7222-8333-444455556666').success).toBe(false);
  });
});

describe('paginationQuerySchema', () => {
  it('defaults the limit', () => {
    expect(paginationQuerySchema.parse({}).limit).toBe(20);
  });

  it('rejects a limit above the maximum rather than clamping it', () => {
    expect(paginationQuerySchema.safeParse({ limit: 5_000 }).success).toBe(false);
  });

  it('rejects a numeric string instead of coercing it', () => {
    // Reject, do not coerce — silent coercion hides client bugs.
    expect(paginationQuerySchema.safeParse({ limit: '20' }).success).toBe(false);
  });
});

describe('moneySchema', () => {
  it('accepts integer minor units', () => {
    expect(moneySchema.parse({ amountMinor: 49_900, currency: 'pkr' })).toEqual({
      amountMinor: 49_900,
      currency: 'PKR',
    });
  });

  it('rejects a float amount', () => {
    // Money is never a float. 0.1 + 0.2 is not a billing strategy.
    expect(moneySchema.safeParse({ amountMinor: 499.5, currency: 'PKR' }).success).toBe(false);
  });
});
