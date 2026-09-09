import { randomBytes, timingSafeEqual } from 'node:crypto';

import { argon2id, argon2Verify } from 'hash-wasm';

/**
 * Password hashing.
 *
 * Argon2id, via a WebAssembly implementation rather than a native binding. That
 * is a deliberate trade: a native module that fails to load on one developer's
 * machine turns into "just use bcrypt for now", and the temporary weakening
 * outlives the temporary problem.
 *
 * PLAINTEXT PASSWORDS ARE NEVER STORED, LOGGED, OR RETURNED. The only place a
 * plaintext password exists is a local variable inside this module and the
 * request body that carried it, which the redacting logger cannot emit
 * (docs/LOGGING.md §4).
 */

export interface PasswordHashParams {
  /** OWASP's floor for Argon2id at t=2, p=1. Never lower it. */
  readonly memoryKib: number;
  readonly iterations: number;
  readonly parallelism: number;
}

export const DEFAULT_HASH_PARAMS: PasswordHashParams = Object.freeze({
  memoryKib: 19_456,
  iterations: 2,
  parallelism: 1,
});

export const hashPassword = async (
  password: string,
  params: PasswordHashParams = DEFAULT_HASH_PARAMS,
): Promise<string> =>
  await argon2id({
    password,
    salt: randomBytes(16),
    memorySize: params.memoryKib,
    iterations: params.iterations,
    parallelism: params.parallelism,
    hashLength: 32,
    outputType: 'encoded',
  });

export const verifyPassword = async (password: string, hash: string): Promise<boolean> => {
  try {
    return await argon2Verify({ password, hash });
  } catch {
    // A malformed or truncated hash is a corrupt record, not a valid login.
    return false;
  }
};

/**
 * A hash of a fixed dummy password, computed once at module load.
 *
 * Verified against when an account does not exist, so a login for an unknown
 * address costs the same ~50 ms as a real one. Without it, response time is a
 * user-enumeration oracle — and here that oracle answers "does this family use a
 * children's app?", which is worth more to an attacker than it first appears.
 */
let decoyHash: Promise<string> | undefined;

export const consumeTimingBudget = async (
  password: string,
  params: PasswordHashParams = DEFAULT_HASH_PARAMS,
): Promise<void> => {
  decoyHash ??= hashPassword('decoy-password-for-constant-time-comparison', params);
  await verifyPassword(password, await decoyHash);
};

/**
 * Minimum length only, plus a breach check the caller supplies.
 *
 * No composition rules and no forced rotation: both are known to produce weaker
 * passwords, because people satisfy them with predictable substitutions
 * (SECURITY.md §2.1).
 */
export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 256; // bounded so a huge input cannot burn CPU

export interface PasswordPolicyResult {
  readonly ok: boolean;
  readonly issue?: string;
}

export const checkPasswordPolicy = (password: string): PasswordPolicyResult => {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, issue: `must be at least ${String(MIN_PASSWORD_LENGTH)} characters` };
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return { ok: false, issue: `must be at most ${String(MAX_PASSWORD_LENGTH)} characters` };
  }
  return { ok: true };
};

/** Constant-time comparison for opaque tokens, which are compared as hashes. */
export const safeEquals = (a: string, b: string): boolean => {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
};
