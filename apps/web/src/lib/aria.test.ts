import { describe, expect, it } from 'vitest';

import { mergeDescribedBy } from './aria';

/**
 * `aria-describedby` is a LIST, and treating it as a single value is the bug
 * this function exists to prevent. A control described by both a hint and a
 * validation message must keep both; overwriting silently drops half of what a
 * screen reader would have said, and nothing visual changes.
 */
describe('mergeDescribedBy', () => {
  it('returns the new id when there was nothing before', () => {
    expect(mergeDescribedBy(undefined, 'limit-hint')).toBe('limit-hint');
  });

  it('keeps an existing id rather than replacing it', () => {
    // The case that matters: a field pointing at its validation message must
    // not lose it when the hint is attached.
    expect(mergeDescribedBy('limit-error', 'limit-hint')).toBe('limit-error limit-hint');
  });

  it('does not repeat an id that is already present', () => {
    // A duplicate makes some screen readers announce the same text twice.
    expect(mergeDescribedBy('limit-hint', 'limit-hint')).toBe('limit-hint');
  });

  it('handles a list that already has several ids', () => {
    expect(mergeDescribedBy('a b', 'c')).toBe('a b c');
  });

  it('tolerates the messy whitespace a template literal produces', () => {
    expect(mergeDescribedBy('  a   b  ', ' c ')).toBe('a b c');
  });

  it('is undefined when there is genuinely nothing to describe', () => {
    // `undefined` rather than an empty string: React omits the attribute
    // entirely, and `aria-describedby=""` is a dangling reference.
    expect(mergeDescribedBy(undefined, undefined)).toBeUndefined();
    expect(mergeDescribedBy('', '')).toBeUndefined();
  });

  it('accepts several additions at once', () => {
    expect(mergeDescribedBy(undefined, 'hint', 'error')).toBe('hint error');
  });
});
