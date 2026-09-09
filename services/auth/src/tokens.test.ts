import { describe, expect, it } from 'vitest';

import { createTokenService, hashToken } from './tokens.js';

const service = createTokenService({
  secret: 'a-test-secret-that-is-at-least-32-bytes-long',
  issuer: 'https://api.test.invalid',
  audience: 'kids-companion-app',
  accessTokenTtlSeconds: 900,
  refreshTokenTtlSeconds: 2_592_000,
});

const claims = { sub: 'par_1', sid: 'ses_1', role: 'parent' } as const;

describe('access tokens', () => {
  it('round-trips the claims', async () => {
    const token = await service.issueAccessToken(claims);

    expect(await service.verifyAccessToken(token)).toMatchObject(claims);
  });

  it('rejects a token signed with a different secret', async () => {
    const other = createTokenService({
      secret: 'a-completely-different-secret-value-here',
      issuer: 'https://api.test.invalid',
      audience: 'kids-companion-app',
      accessTokenTtlSeconds: 900,
      refreshTokenTtlSeconds: 2_592_000,
    });

    expect(await service.verifyAccessToken(await other.issueAccessToken(claims))).toBeNull();
  });

  it('rejects a token from a different issuer', async () => {
    const other = createTokenService({
      secret: 'a-test-secret-that-is-at-least-32-bytes-long',
      issuer: 'https://evil.test.invalid',
      audience: 'kids-companion-app',
      accessTokenTtlSeconds: 900,
      refreshTokenTtlSeconds: 2_592_000,
    });

    expect(await service.verifyAccessToken(await other.issueAccessToken(claims))).toBeNull();
  });

  it('rejects a token for a different audience', async () => {
    const other = createTokenService({
      secret: 'a-test-secret-that-is-at-least-32-bytes-long',
      issuer: 'https://api.test.invalid',
      audience: 'some-other-app',
      accessTokenTtlSeconds: 900,
      refreshTokenTtlSeconds: 2_592_000,
    });

    expect(await service.verifyAccessToken(await other.issueAccessToken(claims))).toBeNull();
  });

  it('rejects an unsigned "alg: none" token', async () => {
    // The classic JWT vulnerability. Verification pins HS256 explicitly.
    const forged = [
      Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
      Buffer.from(JSON.stringify({ sub: 'par_1', sid: 'ses_1', role: 'admin' })).toString(
        'base64url',
      ),
      '',
    ].join('.');

    expect(await service.verifyAccessToken(forged)).toBeNull();
  });

  it('rejects an expired token', async () => {
    const shortLived = createTokenService({
      secret: 'a-test-secret-that-is-at-least-32-bytes-long',
      issuer: 'https://api.test.invalid',
      audience: 'kids-companion-app',
      accessTokenTtlSeconds: -10, // already expired at issue
      refreshTokenTtlSeconds: 2_592_000,
    });

    expect(
      await shortLived.verifyAccessToken(await shortLived.issueAccessToken(claims)),
    ).toBeNull();
  });

  it.each([['not-a-jwt'], ['a.b.c'], [''], ['....']])(
    'rejects the malformed token %s',
    async (t) => {
      expect(await service.verifyAccessToken(t)).toBeNull();
    },
  );

  it('carries child-mode claims when present', async () => {
    const token = await service.issueAccessToken({ ...claims, cid: 'chp_1', mode: 'child' });
    const verified = await service.verifyAccessToken(token);

    // The API rejects these on parent routes; the token service only carries them.
    expect(verified).toMatchObject({ cid: 'chp_1', mode: 'child' });
  });
});

describe('refresh tokens', () => {
  it('issues a token with its hash and expiry', () => {
    const issued = service.issueRefreshToken(new Date('2026-08-17T00:00:00Z'));

    expect(issued.token).toHaveLength(43); // 32 bytes, base64url
    expect(issued.hash).toBe(hashToken(issued.token));
    expect(issued.expiresAt.toISOString()).toBe('2026-09-16T00:00:00.000Z');
  });

  it('never returns the same token twice', () => {
    const now = new Date();
    const tokens = new Set(Array.from({ length: 200 }, () => service.issueRefreshToken(now).token));

    expect(tokens.size).toBe(200);
  });

  it('hashes deterministically, so a lookup by hash works', () => {
    expect(hashToken('abc')).toBe(hashToken('abc'));
    expect(hashToken('abc')).not.toBe(hashToken('abd'));
    expect(hashToken('abc')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces a hash that does not contain the token', () => {
    const issued = service.issueRefreshToken(new Date());

    // A database dump must not yield usable tokens.
    expect(issued.hash).not.toContain(issued.token);
  });
});
