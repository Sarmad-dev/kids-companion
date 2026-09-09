import { randomUUID } from 'node:crypto';

import { asSystem, type Database } from '@kids/db';

import type { Role } from './roles.js';
import { hashToken, type TokenService } from './tokens.js';

/**
 * Session lifecycle: issue, refresh with rotation, revoke.
 *
 * The important behaviour here is REUSE DETECTION. Every refresh rotates the
 * token and marks the old one revoked. If a revoked token is presented again,
 * either the legitimate client replayed a request or an attacker is using a
 * stolen copy — and we cannot tell which. So the entire token family is revoked,
 * signing the real user out and rendering the stolen token useless.
 *
 * Signing a user out on a false positive is a mild annoyance. Not doing it on a
 * true positive means an attacker holds a valid session for 30 days.
 */

export interface SessionRecord {
  readonly id: string;
  readonly parentId: string;
  readonly familyId: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
}

export interface IssuedSession {
  readonly sessionId: string;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly accessTokenExpiresIn: number;
  readonly refreshTokenExpiresAt: string;
}

export interface SessionContext {
  readonly userAgent?: string;
  readonly ipAddress?: string;
  readonly deviceLabel?: string;
}

export type RefreshOutcome =
  | { readonly status: 'ok'; readonly session: IssuedSession }
  | { readonly status: 'invalid' }
  | { readonly status: 'expired' }
  /** A rotated token came back. The family is now revoked; this is a security event. */
  | { readonly status: 'reuse_detected'; readonly parentId: string; readonly familyId: string };

export interface SessionServiceOptions {
  readonly db: Database;
  readonly tokens: TokenService;
  readonly accessTokenTtlSeconds: number;
  readonly now: () => Date;
}

export interface SessionService {
  issue(parentId: string, role: Role, context: SessionContext): Promise<IssuedSession>;
  refresh(refreshToken: string, context: SessionContext): Promise<RefreshOutcome>;
  revoke(refreshToken: string): Promise<boolean>;
  revokeAllForParent(parentId: string, reason: string): Promise<number>;
  isSessionActive(sessionId: string): Promise<boolean>;
  listForParent(parentId: string): Promise<SessionRecord[]>;
}

interface SessionRow {
  id: string;
  parent_id: string;
  family_id: string;
  expires_at: string;
  revoked_at: string | null;
  role: string;
}

export const createSessionService = (options: SessionServiceOptions): SessionService => {
  const { db, tokens, now } = options;

  const mint = async (
    parentId: string,
    role: Role,
    familyId: string,
    context: SessionContext,
  ): Promise<IssuedSession> => {
    const refresh = tokens.issueRefreshToken(now());

    const sessionId = await asSystem(db, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `insert into sessions
           (parent_id, family_id, refresh_token_hash, device_label, user_agent, ip_address, expires_at)
         values ($1, $2, $3, $4, $5, $6, $7)
         returning id`,
        [
          parentId,
          familyId,
          refresh.hash,
          context.deviceLabel ?? null,
          context.userAgent ?? null,
          context.ipAddress ?? null,
          refresh.expiresAt.toISOString(),
        ],
      );
      const row = rows[0];
      if (!row) throw new Error('failed to create session');
      return row.id;
    });

    const accessToken = await tokens.issueAccessToken({
      sub: parentId,
      sid: sessionId,
      role,
      mode: 'parent',
    });

    return {
      sessionId,
      accessToken,
      refreshToken: refresh.token,
      accessTokenExpiresIn: options.accessTokenTtlSeconds,
      refreshTokenExpiresAt: refresh.expiresAt.toISOString(),
    };
  };

  return {
    issue: async (parentId, role, context) =>
      // A fresh login starts a new family: sessions on different devices are
      // independent, so a compromise on one does not sign the family out of all.
      await mint(parentId, role, randomUUID(), context),

    refresh: async (refreshToken, context) => {
      const hash = hashToken(refreshToken);

      const found = await asSystem(db, async (tx) => {
        const { rows } = await tx.query<SessionRow>(
          `select s.id, s.parent_id, s.family_id, s.expires_at, s.revoked_at, p.role
             from sessions s
             join parents p on p.id = s.parent_id
            where s.refresh_token_hash = $1 and p.deleted_at is null`,
          [hash],
        );
        return rows[0];
      });

      if (!found) return { status: 'invalid' };

      if (found.revoked_at !== null) {
        // A token that was already rotated has come back. Revoke everything
        // descended from the same login and let the caller raise the alarm.
        await asSystem(db, async (tx) => {
          await tx.query(
            `update sessions set revoked_at = now(), revoked_reason = 'reuse_detected'
              where family_id = $1 and revoked_at is null`,
            [found.family_id],
          );
        });
        return {
          status: 'reuse_detected',
          parentId: found.parent_id,
          familyId: found.family_id,
        };
      }

      if (new Date(found.expires_at) <= now()) {
        await asSystem(db, async (tx) => {
          await tx.query(
            `update sessions set revoked_at = now(), revoked_reason = 'expired' where id = $1`,
            [found.id],
          );
        });
        return { status: 'expired' };
      }

      const role = (found.role as Role | undefined) ?? 'parent';
      const next = await mint(found.parent_id, role, found.family_id, context);

      await asSystem(db, async (tx) => {
        await tx.query(
          `update sessions
              set revoked_at = now(), revoked_reason = 'rotated',
                  replaced_by = $2, last_used_at = now()
            where id = $1`,
          [found.id, next.sessionId],
        );
      });

      return { status: 'ok', session: next };
    },

    revoke: async (refreshToken) =>
      await asSystem(db, async (tx) => {
        const { rows } = await tx.query(
          `update sessions set revoked_at = now(), revoked_reason = 'logout'
            where refresh_token_hash = $1 and revoked_at is null
            returning id`,
          [hashToken(refreshToken)],
        );
        return rows.length > 0;
      }),

    revokeAllForParent: async (parentId, reason) =>
      await asSystem(db, async (tx) => {
        const { rows } = await tx.query(
          `update sessions set revoked_at = now(), revoked_reason = $2
            where parent_id = $1 and revoked_at is null
            returning id`,
          [parentId, reason],
        );
        return rows.length;
      }),

    /**
     * Whether the session behind an access token is still live.
     *
     * This is what makes logout meaningful. A JWT is valid until it expires; if
     * nothing checks the session, a "logged out" token keeps working for another
     * 15 minutes. One indexed lookup per request is the price of revocation
     * actually revoking (SECURITY.md §2.1).
     */
    isSessionActive: async (sessionId) =>
      await asSystem(db, async (tx) => {
        const { rows } = await tx.query(
          `select 1 from sessions
            where id = $1 and revoked_at is null and expires_at > now()`,
          [sessionId],
        );
        return rows.length > 0;
      }),

    listForParent: async (parentId) =>
      await asSystem(db, async (tx) => {
        const { rows } = await tx.query<SessionRow>(
          `select s.id, s.parent_id, s.family_id, s.expires_at, s.revoked_at, p.role
             from sessions s join parents p on p.id = s.parent_id
            where s.parent_id = $1
            order by s.issued_at desc`,
          [parentId],
        );
        return rows.map((r) => ({
          id: r.id,
          parentId: r.parent_id,
          familyId: r.family_id,
          expiresAt: r.expires_at,
          revokedAt: r.revoked_at,
        }));
      }),
  };
};
