import { describe, expect, it } from 'vitest';

import {
  AppError,
  forbidden,
  internalError,
  notFound,
  safetyBlocked,
  toAppError,
  validationFailed,
} from './errors.js';

describe('AppError', () => {
  it('logs authorization denials at warn, because they carry the security signal', () => {
    expect(forbidden().logLevel).toBe('warn');
  });

  it('logs safety blocks at warn', () => {
    expect(safetyBlocked('SAFETY_INPUT_BLOCKED', 'L1').logLevel).toBe('warn');
  });

  it('logs routine validation failures at debug, so warn is not diluted', () => {
    expect(validationFailed([{ field: 'birthYear', issue: 'out of range' }]).logLevel).toBe(
      'debug',
    );
  });

  it('preserves the cause chain', () => {
    const root = new Error('socket hang up');

    expect(internalError(root).cause).toBe(root);
  });

  it('freezes context so it cannot be mutated after construction', () => {
    const error = forbidden({ resource: 'child_profile' });

    expect(Object.isFrozen(error.context)).toBe(true);
  });
});

describe('toClientBody', () => {
  it('emits only code, message, and requestId', () => {
    const body = notFound().toClientBody('req-1');

    expect(Object.keys(body.error).sort()).toEqual(['code', 'message', 'requestId']);
  });

  it('never leaks the stack, cause, category, or context', () => {
    const error = new AppError({
      code: 'INTERNAL_ERROR',
      category: 'internal',
      httpStatus: 500,
      message: 'Something went wrong.',
      context: { query: 'select * from child_profiles', parentId: 'par_secret' },
      cause: new Error('connection refused at 10.0.0.4:5432'),
    });

    const serialised = JSON.stringify(error.toClientBody('req-2'));

    expect(serialised).not.toContain('child_profiles');
    expect(serialised).not.toContain('par_secret');
    expect(serialised).not.toContain('10.0.0.4');
    expect(serialised).not.toContain('connection refused');
  });

  it('includes field details for validation errors without echoing the value', () => {
    const body = validationFailed([
      { field: 'birthYear', issue: 'must be between 2015 and 2023' },
    ]).toClientBody('req-3');

    expect(body.error.details).toEqual([
      { field: 'birthYear', issue: 'must be between 2015 and 2023' },
    ]);
  });
});

describe('status codes', () => {
  it('returns 404 rather than 403 for another tenant, so existence is not confirmed', () => {
    // The resources here are children. Confirming one exists to an unauthorised
    // caller is itself a disclosure. See docs/API_CONVENTIONS.md §4.3.
    expect(notFound().httpStatus).toBe(404);
  });

  it('returns 200 for a safety block, because the request itself succeeded', () => {
    // A 4xx would make safety blocks indistinguishable from client bugs in every
    // dashboard, and would push clients toward retrying them.
    expect(safetyBlocked('SAFETY_OUTPUT_BLOCKED', 'L3').httpStatus).toBe(200);
  });
});

describe('toAppError', () => {
  it('passes an AppError through unchanged', () => {
    const original = notFound();

    expect(toAppError(original)).toBe(original);
  });

  it('wraps an unknown throw as INTERNAL_ERROR, preserving the original', () => {
    const result = toAppError('a bare string was thrown');

    expect(result.code).toBe('INTERNAL_ERROR');
    expect(result.cause).toBe('a bare string was thrown');
  });
});
