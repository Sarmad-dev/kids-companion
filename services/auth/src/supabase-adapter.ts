import { asSystem, type Database } from '@kids/db';
import { internalError, rateLimited, validationFailed } from '@kids/shared';

import {
  DuplicateEmailError,
  type AuthIdentity,
  type AuthProvider,
  type CredentialCheck,
  type RegisterInput,
  type RegisterResult,
} from './ports.js';
import { isRole, type Role } from './roles.js';

/**
 * Supabase Auth (GoTrue) as the identity provider.
 *
 * What production uses. GoTrue owns the credential, the email verification mail,
 * and the password reset mail; we own the `parents` profile row and everything
 * hanging off it.
 *
 * `parents.id` IS `auth.users.id`, so there is no mapping table and no way for
 * the two to drift. `parents.password_hash` stays NULL under this adapter —
 * GoTrue holds the bcrypt hash and we never see the password at all.
 *
 * ⚠️ NOT YET EXERCISED AGAINST A LIVE PROJECT. The shape follows the GoTrue REST
 * API, but no Supabase project exists to test it, so this is unverified code.
 * The contract suite in tests/contract/ runs against the local adapter only. Do
 * not deploy this without running that suite against a real project first —
 * see docs/adr/0009 "Revisit when".
 */

export interface SupabaseAuthAdapterOptions {
  readonly db: Database;
  readonly supabaseUrl: string;
  /** Server-side only. Never reaches a client bundle. */
  readonly serviceRoleKey: string;
  readonly anonKey: string;
  readonly redirectUrl: string;
  readonly fetchImpl?: typeof fetch;
}

interface GoTrueUser {
  id: string;
  email: string;
  email_confirmed_at?: string | null;
  /** Empty on an existing, already-confirmed address — GoTrue's own anti-enumeration shape. */
  identities?: unknown[];
}

interface GoTrueErrorBody {
  error_code?: string;
  msg?: string;
  message?: string;
}

/** GoTrue's duplicate-registration signal comes in two shapes; see `register` below. */
const GOTRUE_DUPLICATE_CODES = new Set(['user_already_exists', 'email_exists']);

const gotrueErrorMessage = (body: unknown): string => {
  const b = body as GoTrueErrorBody | null;
  return b?.msg ?? b?.message ?? b?.error_code ?? 'no error body';
};

const toRole = (value: string | undefined): Role => (value && isRole(value) ? value : 'parent');

export const createSupabaseAuthAdapter = (options: SupabaseAuthAdapterOptions): AuthProvider => {
  const http = options.fetchImpl ?? fetch;
  const base = `${options.supabaseUrl.replace(/\/$/, '')}/auth/v1`;

  const call = async (
    path: string,
    init: { method: string; body?: unknown; useServiceRole?: boolean },
  ): Promise<{ status: number; body: unknown }> => {
    const response = await http(`${base}${path}`, {
      method: init.method,
      headers: {
        'content-type': 'application/json',
        apikey: init.useServiceRole === true ? options.serviceRoleKey : options.anonKey,
        authorization: `Bearer ${init.useServiceRole === true ? options.serviceRoleKey : options.anonKey}`,
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });

    const text = await response.text();
    return { status: response.status, body: text === '' ? null : (JSON.parse(text) as unknown) };
  };

  /** The profile row that mirrors the GoTrue user. */
  const upsertProfile = async (user: GoTrueUser, input?: RegisterInput): Promise<AuthIdentity> =>
    await asSystem(options.db, async (tx) => {
      const { rows } = await tx.query<{
        id: string;
        email: string;
        role: string;
        email_verified_at: string | null;
      }>(
        `insert into parents (id, email, display_name, country_code, locale, email_verified_at)
         values ($1, $2, $3, coalesce($4, 'PK'), coalesce($5, 'en'), $6)
         on conflict (id) do update
           set email = excluded.email,
               email_verified_at = coalesce(parents.email_verified_at, excluded.email_verified_at)
         returning id, email, role, email_verified_at`,
        [
          user.id,
          user.email,
          input?.displayName ?? null,
          input?.countryCode ?? null,
          input?.locale ?? null,
          user.email_confirmed_at ?? null,
        ],
      );

      const row = rows[0];
      if (!row) throw new Error('failed to upsert parent profile');

      return {
        parentId: row.id,
        email: row.email,
        role: toRole(row.role),
        ...(row.email_verified_at === null ? {} : { emailVerifiedAt: row.email_verified_at }),
      };
    });

  return {
    name: 'supabase',

    register: async (input: RegisterInput): Promise<RegisterResult> => {
      const { status, body } = await call('/signup', {
        method: 'POST',
        body: { email: input.email, password: input.password },
      });

      if (status >= 400) {
        const code = (body as GoTrueErrorBody | null)?.error_code;
        // Enumeration-safe, matching the local adapter: the route catches
        // this type and gives a duplicate the same response as any other
        // registration outcome.
        if (code !== undefined && GOTRUE_DUPLICATE_CODES.has(code)) {
          throw new DuplicateEmailError('email already registered');
        }
        if (status === 429) throw rateLimited();
        // A malformed address or a password GoTrue's own policy rejects: the
        // caller can fix this, so it is not our fault and not a 500.
        if (status < 500) {
          throw validationFailed([{ field: 'email', issue: gotrueErrorMessage(body) }]);
        }
        // GoTrue's own 5xx, or anything else unrecognised. The real message is
        // attached as `cause` so it reaches the log — the previous version of
        // this error carried only a status code, which is what made this class
        // of failure take a live API call to diagnose instead of a log line.
        throw internalError(
          new Error(
            `supabase signup failed with status ${String(status)}: ${gotrueErrorMessage(body)}`,
          ),
        );
      }

      const user = (body as { user?: GoTrueUser; id?: string }).user ?? (body as GoTrueUser);

      // GoTrue's OTHER duplicate-registration shape: HTTP 200 with a user
      // object whose `identities` array is empty, for an address that is
      // already registered and confirmed. Treated the same as the explicit
      // error above.
      if (Array.isArray(user.identities) && user.identities.length === 0) {
        throw new DuplicateEmailError('email already registered');
      }

      const identity = await upsertProfile(user, input);

      // GoTrue sends the verification mail and never returns the token, which
      // is why `verificationToken` is absent here and present in the local
      // adapter. Callers must not depend on it.
      return { identity };
    },

    verifyCredentials: async (email: string, password: string): Promise<CredentialCheck> => {
      const { status, body } = await call('/token?grant_type=password', {
        method: 'POST',
        body: { email, password },
      });

      if (status >= 400) {
        // GoTrue returns the same error for "no such user" and "wrong password",
        // which is the behaviour we want; do not try to distinguish them.
        return { ok: false, reason: 'bad_password' };
      }

      const user = (body as { user?: GoTrueUser }).user;
      if (!user) return { ok: false, reason: 'bad_password' };

      const identity = await upsertProfile(user);

      const suspended = await asSystem(options.db, async (tx) => {
        const { rows } = await tx.query<{ status: string }>(
          `select status from parents where id = $1`,
          [identity.parentId],
        );
        return rows[0]?.status !== 'active';
      });
      if (suspended) return { ok: false, reason: 'suspended' };

      return { ok: true, identity };
    },

    requestEmailVerification: async (parentId: string) => {
      const email = await asSystem(options.db, async (tx) => {
        const { rows } = await tx.query<{ email: string }>(
          `select email from parents where id = $1 and deleted_at is null`,
          [parentId],
        );
        return rows[0]?.email;
      });
      if (email === undefined) return {};

      await call('/resend', { method: 'POST', body: { type: 'signup', email } });
      return {};
    },

    // Email confirmation and password reset both complete in GoTrue via the
    // link it mailed; the client lands back on us with a Supabase session rather
    // than handing us a token to redeem. These exist to satisfy the port and
    // must not be wired to a route under this adapter.
    confirmEmailVerification: async () => await Promise.resolve(null),

    requestPasswordReset: async (email: string) => {
      await call('/recover', {
        method: 'POST',
        body: { email, options: { redirectTo: options.redirectUrl } },
      });
      // Always resolves the same way, registered or not.
      return {};
    },

    resetPassword: async () => await Promise.resolve(null),

    verifyCurrentPassword: async (parentId: string, password: string) => {
      const email = await asSystem(options.db, async (tx) => {
        const { rows } = await tx.query<{ email: string }>(
          `select email from parents where id = $1 and deleted_at is null`,
          [parentId],
        );
        return rows[0]?.email;
      });
      if (email === undefined) return false;

      const { status } = await call('/token?grant_type=password', {
        method: 'POST',
        body: { email, password },
      });
      return status < 400;
    },

    changePassword: async (parentId: string, _currentPassword: string, newPassword: string) => {
      const { status } = await call(`/admin/users/${parentId}`, {
        method: 'PUT',
        body: { password: newPassword },
        useServiceRole: true,
      });

      if (status >= 400) return false;

      await asSystem(options.db, async (tx) => {
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
