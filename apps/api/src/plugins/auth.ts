import type { Permission, Role, SessionService, TokenService } from '@kids/auth';
import { hasPermission } from '@kids/auth';
import { asParent, type Database, type Queryable } from '@kids/db';
import { forbidden, notFound, unauthenticated } from '@kids/shared';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';

/**
 * Authentication and authorization.
 *
 * Every protected request answers four questions, in order, and stops at the
 * first "no":
 *
 *   1. Is the caller an authenticated parent?      → `authenticate`
 *   2. Does their role permit this operation?      → `authorize(permission)`
 *   3. Do they own the resource being addressed?   → `requireChildOwnership` /
 *                                                     scoped repository access
 *   4. Does the DATABASE agree?                    → RLS, on every query
 *
 * Layer 4 is the one that matters most. Layers 1-3 are application code and can
 * be forgotten on a new route; RLS cannot, because the query itself carries the
 * identity. See docs/DATA_MODEL.md §2.
 */

export interface AuthenticatedPrincipal {
  readonly parentId: string;
  readonly sessionId: string;
  readonly role: Role;
}

declare module 'fastify' {
  interface FastifyRequest {
    principal?: AuthenticatedPrincipal;
  }
  interface FastifyInstance {
    /** Rejects unless a valid, unrevoked session presents a valid access token. */
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /** Rejects unless the caller's role carries `permission`. */
    authorize: (
      permission: Permission,
    ) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /** Runs `fn` inside a transaction scoped by RLS to the authenticated parent. */
    withParent: <T>(request: FastifyRequest, fn: (tx: Queryable) => Promise<T>) => Promise<T>;
  }
}

export interface AuthPluginOptions {
  readonly db: Database;
  readonly tokens: TokenService;
  readonly sessions: SessionService;
}

const BEARER = /^Bearer (.+)$/;

const authPlugin: FastifyPluginAsync<AuthPluginOptions> = async (app, opts) => {
  app.decorateRequest('principal', undefined);

  app.decorate('authenticate', async (request: FastifyRequest, _reply: FastifyReply) => {
    const header = request.headers.authorization;
    const match = header === undefined ? null : BEARER.exec(header);

    if (!match?.[1]) {
      throw unauthenticated('AUTH_INVALID_CREDENTIALS');
    }

    const claims = await opts.tokens.verifyAccessToken(match[1]);
    if (!claims) {
      // Expired, malformed, wrong signature, wrong issuer — one response for all
      // of them. Telling a caller *which* is a gift to someone probing.
      throw unauthenticated('AUTH_TOKEN_EXPIRED');
    }

    // A JWT is valid until it expires; without this check a "logged out" token
    // keeps working for the rest of its lifetime, and revocation is theatre.
    if (!(await opts.sessions.isSessionActive(claims.sid))) {
      throw unauthenticated('AUTH_TOKEN_EXPIRED', { reason: 'session_revoked' });
    }

    // Child-mode tokens are scoped to the conversation endpoints and must never
    // satisfy a parent-authenticated route (docs/adr/0005 §2.2).
    if (claims.mode === 'child') {
      throw forbidden({ reason: 'child_session_on_parent_route' });
    }

    // Fastify's supported extension mechanism; no-param-reassign cannot tell it
    // apart from an accidental mutation.
    // eslint-disable-next-line no-param-reassign
    request.principal = {
      parentId: claims.sub,
      sessionId: claims.sid,
      role: claims.role as Role,
    };
  });

  app.decorate(
    'authorize',
    (permission: Permission) => async (request: FastifyRequest, _reply: FastifyReply) => {
      const principal = request.principal;
      if (!principal) {
        // A programming error, not a client one: `authorize` was wired without
        // `authenticate` in front of it. Fail closed and make it loud.
        request.log.error(
          { route: request.routeOptions.url },
          'authorize ran without authenticate — route is misconfigured',
        );
        throw unauthenticated('AUTH_INVALID_CREDENTIALS');
      }

      if (!hasPermission(principal.role, permission)) {
        request.log.warn(
          { requiredPermission: permission, role: principal.role, requestId: request.requestId },
          'permission denied',
        );
        throw forbidden({ requiredPermission: permission });
      }
    },
  );

  app.decorate(
    'withParent',
    async <T>(request: FastifyRequest, fn: (tx: Queryable) => Promise<T>) => {
      const principal = request.principal;
      if (!principal) throw unauthenticated('AUTH_INVALID_CREDENTIALS');
      return await asParent(opts.db, principal.parentId, fn);
    },
  );
};

/**
 * Ownership guard for `/children/:childId` routes.
 *
 * Returns 404, not 403: a 403 confirms the child exists. The resources here are
 * children, so confirming existence to an unauthorised caller is itself a
 * disclosure (docs/API_CONVENTIONS.md §4.3).
 */
export const requireChildOwnership = async (tx: Queryable, childId: string): Promise<void> => {
  const { rows } = await tx.query('select 1 from children where id = $1 and deleted_at is null', [
    childId,
  ]);
  // The query already runs under the parent's RLS context, so a child belonging
  // to someone else returns zero rows here — the check and the backstop agree.
  if (rows.length === 0) throw notFound();
};

export default fp(authPlugin, { name: 'auth' });
