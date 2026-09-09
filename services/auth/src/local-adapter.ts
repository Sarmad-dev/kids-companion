import { createHash } from 'node:crypto';

import { asSystem, type Database } from '@kids/db';

import {
  consumeTimingBudget,
  hashPassword,
  verifyPassword,
  type PasswordHashParams,
} from './passwords.js';
import {
  DuplicateEmailError,
  type AuthIdentity,
  type AuthProvider,
  type CredentialCheck,
  type RegisterInput,
  type RegisterResult,
} from './ports.js';
import { isRole, type Role } from './roles.js';
import { hashToken, type TokenService } from './tokens.js';

/**
 * Self-managed authentication against our own tables.
 *
 * The adapter used in local and ci, so the entire auth surface — registration,
 * verification, reset, lockout — is exercised by tests without a Supabase
 * project or outbound email. In production the Supabase adapter takes over and
 * these tables stay empty.
 *
 * Every query here runs OUTSIDE a parent RLS context, because all of it happens
 * before a parent is known. That is safe because the tables it touches
 * (`email_verifications`, `password_resets`, `login_attempts`) have no grants to
 * `authenticated` at all — they are unreachable from a request context.
 */

export interface LocalAuthAdapterOptions {
  readonly db: Database;
  readonly tokens: TokenService;
  readonly hashParams: PasswordHashParams;
  readonly emailVerificationTtlSeconds: number;
  readonly passwordResetTtlSeconds: number;
  readonly maxFailedLogins: number;
  readonly lockoutMinutes: number;
  /**
   * Whether to return emailed tokens to the caller. True in local and ci so the
   * flows are completable without an inbox; ALWAYS false in a deployed
   * environment, where returning a reset token in an API response would be a
   * complete authentication bypass.
   */
  readonly exposeTokens: boolean;
  readonly now: () => Date;
}

interface ParentAuthRow {
  id: string;
  email: string;
  password_hash: string | null;
  role: string;
  status: string;
  email_verified_at: string | null;
  failed_login_count: number;
  locked_until: string | null;
  deleted_at: string | null;
}

const emailHash = (email: string): string =>
  createHash('sha256').update(email.trim().toLowerCase(), 'utf8').digest('hex');

const toRole = (value: string): Role => (isRole(value) ? value : 'parent');

const toIdentity = (row: ParentAuthRow): AuthIdentity => ({
  parentId: row.id,
  email: row.email,
  role: toRole(row.role),
  ...(row.email_verified_at === null ? {} : { emailVerifiedAt: row.email_verified_at }),
});

export const createLocalAuthAdapter = (options: LocalAuthAdapterOptions): AuthProvider => {
  const { db, tokens, now } = options;

  const findByEmail = async (email: string): Promise<ParentAuthRow | undefined> =>
    await asSystem(db, async (tx) => {
      const { rows } = await tx.query<ParentAuthRow>(
        `select id, email, password_hash, role, status, email_verified_at,
                failed_login_count, locked_until, deleted_at
         from parents where lower(email) = lower($1) and deleted_at is null`,
        [email],
      );
      return rows[0];
    });

  const recordAttempt = async (email: string, succeeded: boolean, ip?: string): Promise<void> => {
    await asSystem(db, async (tx) => {
      await tx.query(
        `insert into login_attempts (email_hash, ip_address, succeeded) values ($1, $2, $3)`,
        [emailHash(email), ip ?? null, succeeded],
      );
    });
  };

  return {
    name: 'local',

    register: async (input: RegisterInput): Promise<RegisterResult> => {
      const passwordHash = await hashPassword(input.password, options.hashParams);

      return await asSystem(db, async (tx) => {
        const existing = await tx.query(
          `select 1 from parents where lower(email) = lower($1) and deleted_at is null`,
          [input.email],
        );
        if (existing.rows.length > 0) {
          // Surfaced to the caller as a DuplicateEmailError, which the route
          // deliberately does NOT pass through to the client — see routes/auth.
          throw new DuplicateEmailError('email already registered');
        }

        const { rows } = await tx.query<ParentAuthRow>(
          `insert into parents (id, email, password_hash, display_name, country_code, locale, role)
           values (app.gen_uuid_v7(), $1, $2, $3, coalesce($4, 'PK'), coalesce($5, 'en'), 'parent')
           returning id, email, password_hash, role, status, email_verified_at,
                     failed_login_count, locked_until, deleted_at`,
          [
            input.email.trim(),
            passwordHash,
            input.displayName ?? null,
            input.countryCode ?? null,
            input.locale ?? null,
          ],
        );

        const parent = rows[0];
        if (!parent) throw new Error('registration failed to return a row');

        const verification = tokens.issueOpaqueToken(options.emailVerificationTtlSeconds, now());
        await tx.query(
          `insert into email_verifications (parent_id, token_hash, email, expires_at)
           values ($1, $2, $3, $4)`,
          [parent.id, verification.hash, parent.email, verification.expiresAt.toISOString()],
        );

        return {
          identity: toIdentity(parent),
          ...(options.exposeTokens ? { verificationToken: verification.token } : {}),
        };
      });
    },

    verifyCredentials: async (email: string, password: string): Promise<CredentialCheck> => {
      const parent = await findByEmail(email);

      // Spend the same time on a miss as on a hit. A fast rejection here is a
      // user-enumeration oracle.
      if (parent?.password_hash == null) {
        await consumeTimingBudget(password, options.hashParams);
        await recordAttempt(email, false);
        return { ok: false, reason: 'not_found' };
      }

      const lockedUntil = parent.locked_until === null ? null : new Date(parent.locked_until);
      if (lockedUntil !== null && lockedUntil > now()) {
        await consumeTimingBudget(password, options.hashParams);
        await recordAttempt(email, false);
        return { ok: false, reason: 'locked' };
      }

      const valid = await verifyPassword(password, parent.password_hash);

      if (!valid) {
        await asSystem(db, async (tx) => {
          // Lock at the threshold. The window is short and self-clearing: the
          // goal is to make online guessing impractical, not to let anyone lock
          // a family out of their account by guessing badly on purpose.
          await tx.query(
            `update parents
                set failed_login_count = failed_login_count + 1,
                    locked_until = case
                      when failed_login_count + 1 >= $2
                      then now() + make_interval(mins => $3)
                      else locked_until
                    end
              where id = $1`,
            [parent.id, options.maxFailedLogins, options.lockoutMinutes],
          );
        });
        await recordAttempt(email, false);
        return { ok: false, reason: 'bad_password' };
      }

      if (parent.status !== 'active') {
        await recordAttempt(email, false);
        return { ok: false, reason: 'suspended' };
      }

      await asSystem(db, async (tx) => {
        await tx.query(
          `update parents set failed_login_count = 0, locked_until = null, last_login_at = now()
            where id = $1`,
          [parent.id],
        );
      });
      await recordAttempt(email, true);

      return { ok: true, identity: toIdentity(parent) };
    },

    requestEmailVerification: async (parentId: string) => {
      const verification = tokens.issueOpaqueToken(options.emailVerificationTtlSeconds, now());

      return await asSystem(db, async (tx) => {
        const { rows } = await tx.query<{ email: string }>(
          `select email from parents where id = $1 and deleted_at is null`,
          [parentId],
        );
        const parent = rows[0];
        if (!parent) return {};

        // Supersede any outstanding token: two live verification links for one
        // address means the older one stays valid in an inbox indefinitely.
        await tx.query(
          `update email_verifications set consumed_at = now()
            where parent_id = $1 and consumed_at is null`,
          [parentId],
        );
        await tx.query(
          `insert into email_verifications (parent_id, token_hash, email, expires_at)
           values ($1, $2, $3, $4)`,
          [parentId, verification.hash, parent.email, verification.expiresAt.toISOString()],
        );

        return options.exposeTokens ? { token: verification.token } : {};
      });
    },

    confirmEmailVerification: async (token: string) =>
      await asSystem(db, async (tx) => {
        // Consume and validate in one statement: two round trips leave a window
        // in which the same token is redeemed twice.
        const { rows } = await tx.query<{ parent_id: string }>(
          `update email_verifications
              set consumed_at = now()
            where token_hash = $1 and consumed_at is null and expires_at > now()
            returning parent_id`,
          [hashToken(token)],
        );
        const record = rows[0];
        if (!record) return null;

        await tx.query(
          `update parents set email_verified_at = coalesce(email_verified_at, now())
            where id = $1`,
          [record.parent_id],
        );
        return { parentId: record.parent_id };
      }),

    requestPasswordReset: async (email: string, ip?: string) => {
      const parent = await findByEmail(email);
      // Resolve identically for an unknown address. Returning "no such account"
      // is the enumeration oracle again, by another route.
      if (!parent) return {};

      const reset = tokens.issueOpaqueToken(options.passwordResetTtlSeconds, now());

      return await asSystem(db, async (tx) => {
        await tx.query(
          `update password_resets set consumed_at = now()
            where parent_id = $1 and consumed_at is null`,
          [parent.id],
        );
        await tx.query(
          `insert into password_resets (parent_id, token_hash, expires_at, requested_ip)
           values ($1, $2, $3, $4)`,
          [parent.id, reset.hash, reset.expiresAt.toISOString(), ip ?? null],
        );
        return options.exposeTokens ? { token: reset.token } : {};
      });
    },

    resetPassword: async (token: string, newPassword: string) => {
      const passwordHash = await hashPassword(newPassword, options.hashParams);

      return await asSystem(db, async (tx) => {
        const { rows } = await tx.query<{ parent_id: string }>(
          `update password_resets
              set consumed_at = now()
            where token_hash = $1 and consumed_at is null and expires_at > now()
            returning parent_id`,
          [hashToken(token)],
        );
        const record = rows[0];
        if (!record) return null;

        await tx.query(
          `update parents
              set password_hash = $2, failed_login_count = 0, locked_until = null
            where id = $1`,
          [record.parent_id, passwordHash],
        );

        // Every session dies. A password reset is the action someone takes when
        // they believe their account is compromised; leaving the attacker's
        // refresh token alive would make it ceremonial.
        await tx.query(
          `update sessions set revoked_at = now(), revoked_reason = 'password_changed'
            where parent_id = $1 and revoked_at is null`,
          [record.parent_id],
        );

        return { parentId: record.parent_id };
      });
    },

    verifyCurrentPassword: async (parentId: string, password: string) => {
      const current = await asSystem(db, async (tx) => {
        const { rows } = await tx.query<{ password_hash: string | null }>(
          `select password_hash from parents where id = $1 and deleted_at is null`,
          [parentId],
        );
        return rows[0];
      });

      if (!current?.password_hash) return false;
      return await verifyPassword(password, current.password_hash);
    },

    changePassword: async (parentId: string, currentPassword: string, newPassword: string) => {
      const current = await asSystem(db, async (tx) => {
        const { rows } = await tx.query<{ password_hash: string | null }>(
          `select password_hash from parents where id = $1 and deleted_at is null`,
          [parentId],
        );
        return rows[0];
      });

      if (!current?.password_hash) return false;
      if (!(await verifyPassword(currentPassword, current.password_hash))) return false;

      const passwordHash = await hashPassword(newPassword, options.hashParams);

      await asSystem(db, async (tx) => {
        await tx.query(`update parents set password_hash = $2 where id = $1`, [
          parentId,
          passwordHash,
        ]);
        await tx.query(
          `update sessions set revoked_at = now(), revoked_reason = 'password_changed'
            where parent_id = $1 and revoked_at is null`,
          [parentId],
        );
      });

      return true;
    },
  };
};
