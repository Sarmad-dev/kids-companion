import type { Role } from './roles.js';

/**
 * The authentication provider port.
 *
 * Two adapters implement it (docs/adr/0009):
 *
 *   SupabaseAuthAdapter — delegates credential storage, email verification, and
 *                         password reset to GoTrue. What runs in production.
 *   LocalAuthAdapter    — self-managed Argon2id against our own tables. What
 *                         runs in local and ci, so the whole auth surface is
 *                         testable without a Supabase project or outbound email.
 *
 * The port deals in OUR domain types. No GoTrue response shape crosses it, which
 * is what keeps the choice reversible — and what let this be built and tested
 * before a Supabase project existed.
 */

export interface AuthIdentity {
  readonly parentId: string;
  readonly email: string;
  readonly role: Role;
  readonly emailVerifiedAt?: string;
}

export interface RegisterInput {
  readonly email: string;
  readonly password: string;
  readonly displayName?: string | undefined;
  readonly countryCode?: string | undefined;
  readonly locale?: string | undefined;
}

export interface RegisterResult {
  readonly identity: AuthIdentity;
  /**
   * The emailed verification token, returned ONLY by the local adapter and ONLY
   * outside production, so tests and local development can complete the flow
   * without an inbox. The Supabase adapter always returns undefined — GoTrue
   * sends the mail and never hands the token back.
   */
  readonly verificationToken?: string;
}

/**
 * Thrown by `register` for an address that already has an account.
 *
 * Shared by both adapters rather than owned by one: the route catches this
 * type specifically to give a duplicate registration the SAME response as any
 * other registration, which is what makes "is this address registered?" not
 * answerable from the outside (docs/adr/0009, routes/auth.ts).
 */
export class DuplicateEmailError extends Error {
  override readonly name = 'DuplicateEmailError';
}

export interface CredentialCheck {
  readonly ok: boolean;
  readonly identity?: AuthIdentity;
  /** Why it failed. Never surfaced to the client verbatim — see §5 below. */
  readonly reason?: 'not_found' | 'bad_password' | 'locked' | 'suspended';
}

export interface AuthProvider {
  readonly name: string;

  register(input: RegisterInput): Promise<RegisterResult>;

  /**
   * Verifies an email and password.
   *
   * Implementations MUST take the same time whether or not the account exists —
   * a fast "no such user" and a slow "wrong password" is a user-enumeration
   * oracle, and for this product that oracle answers "does this family use a
   * children's app?" (SECURITY.md §2.1).
   */
  verifyCredentials(email: string, password: string): Promise<CredentialCheck>;

  requestEmailVerification(parentId: string): Promise<{ token?: string }>;
  confirmEmailVerification(token: string): Promise<{ parentId: string } | null>;

  /**
   * Always resolves, whether or not the address is registered. Returning "no
   * such account" here is the same enumeration oracle by another route.
   */
  requestPasswordReset(email: string, ip?: string): Promise<{ token?: string }>;

  /** Consumes the token, sets the new password, and revokes every session. */
  resetPassword(token: string, newPassword: string): Promise<{ parentId: string } | null>;

  changePassword(parentId: string, currentPassword: string, newPassword: string): Promise<boolean>;

  /**
   * Confirms a password WITHOUT changing anything.
   *
   * Re-authentication for a destructive action (account deletion) needs to prove
   * the person at the keyboard knows the password. Reusing changePassword for
   * that would rewrite the hash and revoke every session as a side effect of
   * merely asking a question.
   */
  verifyCurrentPassword(parentId: string, password: string): Promise<boolean>;
}
