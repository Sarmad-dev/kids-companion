import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { jwtVerify, SignJWT } from 'jose';

/**
 * Token minting and verification.
 *
 * Access tokens are short-lived stateless JWTs. Refresh tokens are long-lived,
 * opaque, and stored only as a hash — so a database dump yields no usable token,
 * and a stolen token can be revoked, which a JWT cannot.
 *
 * The `sub` claim is the parent id, matching what `app.current_parent_id()`
 * reads. One identity, one claim, one meaning, from the JWT through to the RLS
 * policy.
 */

export interface AccessTokenClaims {
  readonly sub: string;
  readonly sid: string;
  readonly role: string;
  /** Present only in child mode. Children hold no credential of their own. */
  readonly cid?: string;
  readonly mode?: 'parent' | 'child';
}

export interface TokenServiceOptions {
  readonly secret: string;
  readonly issuer: string;
  readonly audience: string;
  readonly accessTokenTtlSeconds: number;
  readonly refreshTokenTtlSeconds: number;
}

export interface IssuedRefreshToken {
  /** Returned to the client once and never stored in this form. */
  readonly token: string;
  readonly hash: string;
  readonly expiresAt: Date;
}

/** SHA-256, hex. Refresh tokens are 256 bits of entropy, so no salt is needed. */
export const hashToken = (token: string): string =>
  createHash('sha256').update(token, 'utf8').digest('hex');

export interface TokenService {
  issueAccessToken(claims: AccessTokenClaims): Promise<string>;
  verifyAccessToken(token: string): Promise<AccessTokenClaims | null>;
  issueRefreshToken(now: Date): IssuedRefreshToken;
  /** A single-use, emailed token: verification or password reset. */
  issueOpaqueToken(ttlSeconds: number, now: Date): IssuedRefreshToken;
}

export const createTokenService = (options: TokenServiceOptions): TokenService => {
  const key = new TextEncoder().encode(options.secret);

  const mintOpaque = (ttlSeconds: number, now: Date): IssuedRefreshToken => {
    // 32 bytes, base64url. Guessing is not a threat model at this size, which is
    // why these can be plain random rather than signed.
    const token = randomBytes(32).toString('base64url');
    return {
      token,
      hash: hashToken(token),
      expiresAt: new Date(now.getTime() + ttlSeconds * 1000),
    };
  };

  return {
    issueAccessToken: async (claims) => {
      const jwt = new SignJWT({
        sid: claims.sid,
        role: claims.role,
        ...(claims.cid === undefined ? {} : { cid: claims.cid }),
        ...(claims.mode === undefined ? {} : { mode: claims.mode }),
      })
        .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
        .setSubject(claims.sub)
        .setIssuer(options.issuer)
        .setAudience(options.audience)
        .setJti(randomUUID())
        .setIssuedAt()
        .setExpirationTime(`${String(options.accessTokenTtlSeconds)}s`);

      return await jwt.sign(key);
    },

    verifyAccessToken: async (token) => {
      try {
        const { payload } = await jwtVerify(token, key, {
          issuer: options.issuer,
          audience: options.audience,
          // Explicit: without pinning the algorithm, a token with `alg: none`
          // or an attacker-chosen algorithm is accepted. The classic JWT bug.
          algorithms: ['HS256'],
        });

        if (typeof payload.sub !== 'string' || typeof payload.sid !== 'string') return null;
        if (typeof payload.role !== 'string') return null;

        return {
          sub: payload.sub,
          sid: payload.sid,
          role: payload.role,
          ...(typeof payload.cid === 'string' ? { cid: payload.cid } : {}),
          ...(payload.mode === 'child' || payload.mode === 'parent' ? { mode: payload.mode } : {}),
        };
      } catch {
        // Expired, malformed, wrong issuer, wrong signature — all the same to a
        // caller: no identity. Distinguishing them for the client would leak.
        return null;
      }
    },

    issueRefreshToken: (now) => mintOpaque(options.refreshTokenTtlSeconds, now),
    issueOpaqueToken: (ttlSeconds, now) => mintOpaque(ttlSeconds, now),
  };
};
