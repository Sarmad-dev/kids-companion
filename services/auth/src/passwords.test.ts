import { describe, expect, it } from 'vitest';

import {
  checkPasswordPolicy,
  hashPassword,
  MIN_PASSWORD_LENGTH,
  safeEquals,
  verifyPassword,
} from './passwords.js';

/**
 * Argon2id at production parameters costs ~50 ms per call, so these use reduced
 * work factors. The parameters themselves are floored by a check constraint in
 * the config schema, which is what stops a reduction leaking into a deployment.
 */
const FAST = { memoryKib: 512, iterations: 1, parallelism: 1 } as const;

describe('password hashing', () => {
  it('produces an Argon2id encoded hash', async () => {
    const hash = await hashPassword('correct-horse-battery-staple', FAST);

    expect(hash).toMatch(/^\$argon2id\$/);
  });

  it('never contains the plaintext', async () => {
    const password = 'a-very-distinctive-passphrase-42';
    const hash = await hashPassword(password, FAST);

    // The whole point. If this ever fails, nothing else about auth matters.
    expect(hash).not.toContain(password);
  });

  it('verifies the correct password', async () => {
    const hash = await hashPassword('correct-horse-battery-staple', FAST);

    expect(await verifyPassword('correct-horse-battery-staple', hash)).toBe(true);
  });

  it('rejects the wrong password', async () => {
    const hash = await hashPassword('correct-horse-battery-staple', FAST);

    expect(await verifyPassword('correct-horse-battery-stapl', hash)).toBe(false);
    expect(await verifyPassword('', hash)).toBe(false);
  });

  it('salts, so the same password hashes differently each time', async () => {
    const [a, b] = await Promise.all([
      hashPassword('identical-password-value', FAST),
      hashPassword('identical-password-value', FAST),
    ]);

    // Without a per-hash salt, identical passwords are visibly identical in a
    // database dump, and one cracked hash cracks every account that shares it.
    expect(a).not.toBe(b);
    expect(await verifyPassword('identical-password-value', a)).toBe(true);
    expect(await verifyPassword('identical-password-value', b)).toBe(true);
  });

  it('returns false for a corrupt hash rather than throwing', async () => {
    // A corrupt record is a failed login, not a 500 that reveals the record is
    // corrupt.
    expect(await verifyPassword('anything', 'not-a-hash')).toBe(false);
    expect(await verifyPassword('anything', '')).toBe(false);
    expect(await verifyPassword('anything', '$argon2id$v=19$truncated')).toBe(false);
  });
});

describe('password policy', () => {
  it('requires a minimum length', () => {
    expect(checkPasswordPolicy('short').ok).toBe(false);
    expect(checkPasswordPolicy('a'.repeat(MIN_PASSWORD_LENGTH)).ok).toBe(true);
  });

  it('bounds the maximum length', () => {
    // Unbounded input into a memory-hard function is a denial-of-service vector.
    expect(checkPasswordPolicy('a'.repeat(1000)).ok).toBe(false);
  });

  it('imposes no composition rules', () => {
    // No "must contain a symbol": composition rules are known to produce weaker
    // passwords, because people satisfy them predictably (SECURITY.md §2.1).
    expect(checkPasswordPolicy('correct horse battery staple').ok).toBe(true);
    expect(checkPasswordPolicy('aaaaaaaaaaaaaaaaaaaa').ok).toBe(true);
  });
});

describe('safeEquals', () => {
  it('compares equal strings', () => {
    expect(safeEquals('abc123', 'abc123')).toBe(true);
  });

  it('rejects different strings and different lengths', () => {
    expect(safeEquals('abc123', 'abc124')).toBe(false);
    expect(safeEquals('abc', 'abcdef')).toBe(false);
  });
});
