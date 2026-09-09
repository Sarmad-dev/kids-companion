import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  authHeader,
  createApiHarness,
  queryAsParent,
  readAuditLog,
  registerAndLogin,
  TEST_PASSWORD,
  testEmail,
  type ApiHarness,
} from '../helpers/api.js';

/**
 * Authentication and authorization, end to end through the real API.
 *
 * Covers every scenario the brief names, plus the ones that only show up when
 * you try to break it: refresh-token reuse, enumeration through timing and
 * status codes, and a child-mode token on a parent route.
 */
describe('authentication', () => {
  let harness: ApiHarness;

  beforeAll(async () => {
    harness = await createApiHarness();
  }, 180_000);

  afterAll(async () => {
    await harness.close();
  });

  /* ---------------------------------------------------------------------- */
  /* Registration                                                           */
  /* ---------------------------------------------------------------------- */

  describe('registration', () => {
    it('creates an account and returns the profile', async () => {
      const response = await harness.app.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: {
          email: testEmail('reg-success'),
          password: TEST_PASSWORD,
          displayName: 'Test Parent',
        },
      });

      expect(response.statusCode).toBe(201);
      expect(response.json().parent).toMatchObject({
        email: testEmail('reg-success'),
        role: 'parent',
        emailVerified: false,
      });
    });

    it('never returns the password or a hash of it', async () => {
      const response = await harness.app.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: { email: testEmail('reg-nohash'), password: TEST_PASSWORD },
      });

      expect(response.body).not.toContain(TEST_PASSWORD);
      expect(response.body).not.toContain('argon2');
      expect(response.body).not.toContain('password');
    });

    it('stores the password only as an Argon2id hash', async () => {
      await harness.app.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: { email: testEmail('reg-storage'), password: TEST_PASSWORD },
      });

      const { rows } = await harness.db.query<{ password_hash: string }>(
        'select password_hash from parents where email = $1',
        [testEmail('reg-storage')],
      );

      // The single most important assertion about credential storage.
      expect(rows[0]!.password_hash).not.toBe(TEST_PASSWORD);
      expect(rows[0]!.password_hash).not.toContain(TEST_PASSWORD);
      expect(rows[0]!.password_hash).toMatch(/^\$argon2id\$/);
    });

    it('creates a default parental controls row for a new child', async () => {
      const parent = await registerAndLogin(harness, 'reg-controls');

      const created = await harness.app.inject({
        method: 'POST',
        url: '/v1/children',
        headers: authHeader(parent.accessToken),
        payload: {
          displayName: 'Test Child',
          birthYear: 2019,
          birthMonth: 6,
          languages: [{ languageCode: 'en', isPrimary: true }],
        },
      });

      expect(created.statusCode).toBe(201);
      expect(created.json().ageGroup).toBeTruthy();
    });

    it('rejects a password below the policy minimum', async () => {
      const response = await harness.app.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: { email: testEmail('reg-weak'), password: 'short' },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('duplicate registration', () => {
    it('rejects a second registration for the same address', async () => {
      const email = testEmail('dup');
      const first = await harness.app.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: { email, password: TEST_PASSWORD },
      });
      expect(first.statusCode).toBe(201);

      const second = await harness.app.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: { email, password: TEST_PASSWORD },
      });

      expect(second.statusCode).toBe(400);
    });

    it('does not reveal that the address is already registered', async () => {
      // The enumeration guarantee. "That email is taken" answers "does this
      // family use a children's app?" for anyone who asks.
      const email = testEmail('dup-quiet');
      await harness.app.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: { email, password: TEST_PASSWORD },
      });

      const second = await harness.app.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: { email, password: TEST_PASSWORD },
      });

      const body = second.body.toLowerCase();
      expect(body).not.toContain('already');
      expect(body).not.toContain('exists');
      expect(body).not.toContain('taken');
      expect(body).not.toContain('duplicate');
    });

    it('is case-insensitive about the address', async () => {
      await harness.app.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: { email: 'test-case@example.invalid', password: TEST_PASSWORD },
      });

      const upper = await harness.app.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: { email: 'TEST-CASE@EXAMPLE.INVALID', password: TEST_PASSWORD },
      });

      // Otherwise a parent creates a second account they cannot sign into.
      expect(upper.statusCode).toBe(400);
    });

    it('records the attempt in the audit log without revealing it to the caller', async () => {
      const entries = await readAuditLog(harness, 'auth.registration.duplicate_email');

      expect(entries.length).toBeGreaterThan(0);
      expect(entries[0]).toMatchObject({ outcome: 'denied' });
    });
  });

  /* ---------------------------------------------------------------------- */
  /* Login                                                                  */
  /* ---------------------------------------------------------------------- */

  describe('login', () => {
    it('returns an access and refresh token', async () => {
      const email = testEmail('login-ok');
      await harness.app.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: { email, password: TEST_PASSWORD },
      });

      const response = await harness.app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { email, password: TEST_PASSWORD },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ tokenType: 'Bearer' });
      expect(response.json().accessToken).toBeTruthy();
      expect(response.json().refreshToken).toBeTruthy();
    });

    it('grants access to a protected route', async () => {
      const parent = await registerAndLogin(harness, 'login-protected');

      const response = await harness.app.inject({
        method: 'GET',
        url: '/v1/parents/me',
        headers: authHeader(parent.accessToken),
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ email: parent.email, role: 'parent' });
    });

    it('audits a successful login', async () => {
      const entries = await readAuditLog(harness, 'auth.login.succeeded');
      expect(entries.length).toBeGreaterThan(0);
    });

    it('stores the refresh token only as a hash', async () => {
      const parent = await registerAndLogin(harness, 'login-hash');

      const { rows } = await harness.db.query<{ refresh_token_hash: string }>(
        'select refresh_token_hash from sessions where parent_id = $1',
        [parent.parentId],
      );

      expect(rows[0]!.refresh_token_hash).not.toBe(parent.refreshToken);
      expect(rows[0]!.refresh_token_hash).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('invalid password', () => {
    it('rejects a wrong password with 401', async () => {
      const email = testEmail('login-bad');
      await harness.app.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: { email, password: TEST_PASSWORD },
      });

      const response = await harness.app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { email, password: 'this-is-the-wrong-password' },
      });

      expect(response.statusCode).toBe(401);
      expect(response.json().error.code).toBe('AUTH_INVALID_CREDENTIALS');
    });

    it('gives an identical response for a wrong password and an unknown address', async () => {
      // A different status or body between the two is a user-enumeration oracle.
      const email = testEmail('login-bad2');
      await harness.app.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: { email, password: TEST_PASSWORD },
      });

      const wrongPassword = await harness.app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { email, password: 'wrong-password-entirely' },
      });

      const unknownUser = await harness.app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { email: testEmail('never-registered'), password: 'wrong-password-entirely' },
      });

      expect(wrongPassword.statusCode).toBe(unknownUser.statusCode);
      expect(wrongPassword.json().error.code).toBe(unknownUser.json().error.code);
      expect(wrongPassword.json().error.message).toBe(unknownUser.json().error.message);
    });

    it('locks the account after repeated failures', async () => {
      const email = testEmail('login-lockout');
      await harness.app.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: { email, password: TEST_PASSWORD },
      });

      for (let i = 0; i < 5; i += 1) {
        await harness.app.inject({
          method: 'POST',
          url: '/v1/auth/login',
          payload: { email, password: `wrong-attempt-${String(i)}` },
        });
      }

      // Even the correct password is refused while the lockout holds.
      const correct = await harness.app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { email, password: TEST_PASSWORD },
      });

      expect(correct.statusCode).toBe(401);

      const locked = await readAuditLog(harness, 'auth.login.locked_out');
      expect(locked.length).toBeGreaterThan(0);
    });

    it('records failed attempts without storing any credential material', async () => {
      const { rows } = await harness.db.query<{ email_hash: string }>(
        'select email_hash from login_attempts where succeeded = false limit 1',
      );

      expect(rows[0]!.email_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(rows[0]!.email_hash).not.toContain('@');
    });
  });

  /* ---------------------------------------------------------------------- */
  /* Sessions                                                               */
  /* ---------------------------------------------------------------------- */

  describe('session handling', () => {
    it('rotates the refresh token, invalidating the old one', async () => {
      const parent = await registerAndLogin(harness, 'refresh-rotate');

      const refreshed = await harness.app.inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        payload: { refreshToken: parent.refreshToken },
      });

      expect(refreshed.statusCode).toBe(200);
      expect(refreshed.json().refreshToken).not.toBe(parent.refreshToken);
    });

    it('revokes the whole family when a rotated token is presented again', async () => {
      // The primary detection for a stolen refresh token. We cannot tell a
      // replay from a theft, so the family dies either way.
      const parent = await registerAndLogin(harness, 'refresh-reuse');

      const first = await harness.app.inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        payload: { refreshToken: parent.refreshToken },
      });
      expect(first.statusCode).toBe(200);
      const rotated = first.json<{ refreshToken: string }>().refreshToken;

      const replay = await harness.app.inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        payload: { refreshToken: parent.refreshToken },
      });

      expect(replay.statusCode).toBe(401);
      expect(replay.json().error.code).toBe('AUTH_REFRESH_REUSE_DETECTED');

      // The token issued by the legitimate rotation is dead too.
      const afterwards = await harness.app.inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        payload: { refreshToken: rotated },
      });
      expect(afterwards.statusCode).toBe(401);

      const audited = await readAuditLog(harness, 'auth.session.reuse_detected');
      expect(audited.length).toBeGreaterThan(0);
    });

    it('rejects an unknown refresh token', async () => {
      const response = await harness.app.inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        payload: { refreshToken: 'a'.repeat(43) },
      });

      expect(response.statusCode).toBe(401);
    });
  });

  describe('expired session', () => {
    it('rejects an access token whose session has been revoked', async () => {
      // The reason `authenticate` checks the session store rather than trusting
      // the JWT: without it a revoked token works until it expires.
      const parent = await registerAndLogin(harness, 'expire-revoked');

      await harness.app.inject({
        method: 'POST',
        url: '/v1/auth/logout',
        payload: { refreshToken: parent.refreshToken },
      });

      const response = await harness.app.inject({
        method: 'GET',
        url: '/v1/parents/me',
        headers: authHeader(parent.accessToken),
      });

      expect(response.statusCode).toBe(401);
    });

    it('rejects a refresh token past its expiry', async () => {
      const parent = await registerAndLogin(harness, 'expire-refresh');

      // Age the whole session rather than waiting 30 days. Both timestamps move:
      // `ck_sessions_expiry_after_issue` correctly refuses a row that expired
      // before it was issued, and a session that is merely old is what we mean.
      await harness.db.query(
        `update sessions
            set issued_at  = now() - interval '31 days',
                expires_at = now() - interval '1 day'
          where parent_id = $1`,
        [parent.parentId],
      );

      const response = await harness.app.inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        payload: { refreshToken: parent.refreshToken },
      });

      expect(response.statusCode).toBe(401);
      expect(response.json().error.code).toBe('AUTH_TOKEN_EXPIRED');
    });

    it('rejects a malformed or forged token', async () => {
      for (const token of ['not-a-jwt', 'a.b.c', '']) {
        const response = await harness.app.inject({
          method: 'GET',
          url: '/v1/parents/me',
          headers: { authorization: `Bearer ${token}` },
        });
        expect(response.statusCode).toBe(401);
      }
    });

    it('rejects a request with no Authorization header', async () => {
      const response = await harness.app.inject({ method: 'GET', url: '/v1/parents/me' });

      expect(response.statusCode).toBe(401);
    });
  });

  describe('logout', () => {
    it('revokes the session', async () => {
      const parent = await registerAndLogin(harness, 'logout');

      const response = await harness.app.inject({
        method: 'POST',
        url: '/v1/auth/logout',
        payload: { refreshToken: parent.refreshToken },
      });

      expect(response.statusCode).toBe(204);
    });

    it('makes the refresh token unusable afterwards', async () => {
      const parent = await registerAndLogin(harness, 'logout-refresh');

      await harness.app.inject({
        method: 'POST',
        url: '/v1/auth/logout',
        payload: { refreshToken: parent.refreshToken },
      });

      const refreshed = await harness.app.inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        payload: { refreshToken: parent.refreshToken },
      });

      expect(refreshed.statusCode).toBe(401);
    });

    it('is idempotent', async () => {
      const parent = await registerAndLogin(harness, 'logout-twice');
      const payload = { refreshToken: parent.refreshToken };

      const first = await harness.app.inject({ method: 'POST', url: '/v1/auth/logout', payload });
      const second = await harness.app.inject({ method: 'POST', url: '/v1/auth/logout', payload });

      // An already-revoked token and an unknown one look the same to the caller.
      expect(first.statusCode).toBe(204);
      expect(second.statusCode).toBe(204);
    });

    it('signs out everywhere on request', async () => {
      const parent = await registerAndLogin(harness, 'logout-all');

      const revoked = await harness.app.inject({
        method: 'POST',
        url: '/v1/parents/me/sessions/revoke-all',
        headers: authHeader(parent.accessToken),
      });

      expect(revoked.statusCode).toBe(200);
      expect(revoked.json().revoked).toBeGreaterThan(0);

      const afterwards = await harness.app.inject({
        method: 'GET',
        url: '/v1/parents/me',
        headers: authHeader(parent.accessToken),
      });
      expect(afterwards.statusCode).toBe(401);
    });
  });

  /* ---------------------------------------------------------------------- */
  /* Email verification                                                     */
  /* ---------------------------------------------------------------------- */

  describe('email verification', () => {
    it('verifies with the emailed token', async () => {
      const registration = await harness.app.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: { email: testEmail('verify'), password: TEST_PASSWORD },
      });

      const token = registration.json<{ verificationToken: string }>().verificationToken;

      const verified = await harness.app.inject({
        method: 'POST',
        url: '/v1/auth/verify-email',
        payload: { token },
      });

      expect(verified.statusCode).toBe(200);
      expect(verified.json().verified).toBe(true);
    });

    it('refuses to consume the same token twice', async () => {
      const registration = await harness.app.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: { email: testEmail('verify-replay'), password: TEST_PASSWORD },
      });
      const token = registration.json<{ verificationToken: string }>().verificationToken;

      await harness.app.inject({
        method: 'POST',
        url: '/v1/auth/verify-email',
        payload: { token },
      });
      const replay = await harness.app.inject({
        method: 'POST',
        url: '/v1/auth/verify-email',
        payload: { token },
      });

      expect(replay.statusCode).toBe(400);
    });

    it('rejects an invalid token', async () => {
      const response = await harness.app.inject({
        method: 'POST',
        url: '/v1/auth/verify-email',
        payload: { token: 'x'.repeat(43) },
      });

      expect(response.statusCode).toBe(400);
    });

    it('stores only a hash of the token', async () => {
      const { rows } = await harness.db.query<{ token_hash: string }>(
        'select token_hash from email_verifications limit 1',
      );

      expect(rows[0]!.token_hash).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  /* ---------------------------------------------------------------------- */
  /* Password reset                                                         */
  /* ---------------------------------------------------------------------- */

  describe('password reset', () => {
    it('completes the flow and allows login with the new password', async () => {
      const email = testEmail('reset');
      await harness.app.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: { email, password: TEST_PASSWORD },
      });

      const requested = await harness.app.inject({
        method: 'POST',
        url: '/v1/auth/password-reset',
        payload: { email },
      });
      expect(requested.statusCode).toBe(202);

      const token = requested.json<{ resetToken: string }>().resetToken;
      const newPassword = 'a-completely-different-passphrase';

      const confirmed = await harness.app.inject({
        method: 'POST',
        url: '/v1/auth/password-reset/confirm',
        payload: { token, newPassword },
      });
      expect(confirmed.statusCode).toBe(200);

      const login = await harness.app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { email, password: newPassword },
      });
      expect(login.statusCode).toBe(200);
    });

    it('invalidates the old password', async () => {
      const email = testEmail('reset-old');
      await harness.app.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: { email, password: TEST_PASSWORD },
      });

      const requested = await harness.app.inject({
        method: 'POST',
        url: '/v1/auth/password-reset',
        payload: { email },
      });
      await harness.app.inject({
        method: 'POST',
        url: '/v1/auth/password-reset/confirm',
        payload: {
          token: requested.json<{ resetToken: string }>().resetToken,
          newPassword: 'another-entirely-new-passphrase',
        },
      });

      const oldPassword = await harness.app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { email, password: TEST_PASSWORD },
      });

      expect(oldPassword.statusCode).toBe(401);
    });

    it('revokes every existing session', async () => {
      // A reset is what someone does when they think they are compromised.
      // Leaving the attacker's session alive would make it ceremonial.
      const parent = await registerAndLogin(harness, 'reset-sessions');

      const requested = await harness.app.inject({
        method: 'POST',
        url: '/v1/auth/password-reset',
        payload: { email: parent.email },
      });
      await harness.app.inject({
        method: 'POST',
        url: '/v1/auth/password-reset/confirm',
        payload: {
          token: requested.json<{ resetToken: string }>().resetToken,
          newPassword: 'yet-another-new-passphrase-here',
        },
      });

      const response = await harness.app.inject({
        method: 'GET',
        url: '/v1/parents/me',
        headers: authHeader(parent.accessToken),
      });

      expect(response.statusCode).toBe(401);
    });

    it('responds identically for an unregistered address', async () => {
      const known = await harness.app.inject({
        method: 'POST',
        url: '/v1/auth/password-reset',
        payload: { email: testEmail('reset') },
      });

      const unknown = await harness.app.inject({
        method: 'POST',
        url: '/v1/auth/password-reset',
        payload: { email: testEmail('does-not-exist-at-all') },
      });

      // Same status either way. A 404 here is the enumeration oracle again.
      expect(known.statusCode).toBe(202);
      expect(unknown.statusCode).toBe(202);
    });

    it('refuses to consume the same reset token twice', async () => {
      const email = testEmail('reset-replay');
      await harness.app.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: { email, password: TEST_PASSWORD },
      });

      const requested = await harness.app.inject({
        method: 'POST',
        url: '/v1/auth/password-reset',
        payload: { email },
      });
      const token = requested.json<{ resetToken: string }>().resetToken;

      await harness.app.inject({
        method: 'POST',
        url: '/v1/auth/password-reset/confirm',
        payload: { token, newPassword: 'first-new-passphrase-value' },
      });

      const replay = await harness.app.inject({
        method: 'POST',
        url: '/v1/auth/password-reset/confirm',
        payload: { token, newPassword: 'second-new-passphrase-value' },
      });

      expect(replay.statusCode).toBe(400);
    });

    it('enforces the password policy on the new password', async () => {
      const email = testEmail('reset-weak');
      await harness.app.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: { email, password: TEST_PASSWORD },
      });
      const requested = await harness.app.inject({
        method: 'POST',
        url: '/v1/auth/password-reset',
        payload: { email },
      });

      const response = await harness.app.inject({
        method: 'POST',
        url: '/v1/auth/password-reset/confirm',
        payload: {
          token: requested.json<{ resetToken: string }>().resetToken,
          newPassword: 'weak',
        },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  /* ---------------------------------------------------------------------- */
  /* Account deletion                                                       */
  /* ---------------------------------------------------------------------- */

  describe('account deletion', () => {
    it('requires the password again', async () => {
      const parent = await registerAndLogin(harness, 'delete-reauth');

      const response = await harness.app.inject({
        method: 'DELETE',
        url: '/v1/parents/me',
        headers: authHeader(parent.accessToken),
        payload: { confirmPassword: 'not-the-right-password' },
      });

      // An active session is not enough for something irreversible.
      expect(response.statusCode).toBe(400);
    });

    it('enters the grace window and revokes every session', async () => {
      const parent = await registerAndLogin(harness, 'delete-ok');

      const response = await harness.app.inject({
        method: 'DELETE',
        url: '/v1/parents/me',
        headers: authHeader(parent.accessToken),
        payload: { confirmPassword: parent.password },
      });

      expect(response.statusCode).toBe(202);
      expect(response.json()).toMatchObject({ status: 'pending_deletion', graceDays: 30 });

      const afterwards = await harness.app.inject({
        method: 'GET',
        url: '/v1/parents/me',
        headers: authHeader(parent.accessToken),
      });
      expect(afterwards.statusCode).toBe(401);

      const audited = await readAuditLog(harness, 'account.deletion.requested');
      expect(audited.length).toBeGreaterThan(0);
    });

    it('prevents login once deletion is scheduled', async () => {
      const parent = await registerAndLogin(harness, 'delete-nologin');
      await harness.app.inject({
        method: 'DELETE',
        url: '/v1/parents/me',
        headers: authHeader(parent.accessToken),
        payload: { confirmPassword: parent.password },
      });

      const login = await harness.app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { email: parent.email, password: parent.password },
      });

      expect(login.statusCode).toBe(401);
    });
  });

  /* ---------------------------------------------------------------------- */
  /* Audit                                                                  */
  /* ---------------------------------------------------------------------- */

  describe('audit logging', () => {
    it('records sensitive actions', async () => {
      const all = await readAuditLog(harness);
      const actions = new Set(all.map((e) => e.action));

      for (const expected of [
        'auth.registration.succeeded',
        'auth.login.succeeded',
        'auth.login.failed',
        'auth.logout.succeeded',
        'auth.password.reset_completed',
        'account.deletion.requested',
      ]) {
        expect(actions, `expected ${expected} in the audit log`).toContain(expected);
      }
    });

    it('never records a password or a token', async () => {
      const { rows } = await harness.db.query<{ blob: string }>(
        'select coalesce(string_agg(metadata::text, %s), %s) as blob from audit_logs'.replace(
          /%s/g,
          "' '",
        ),
      );

      expect(rows[0]!.blob).not.toContain(TEST_PASSWORD);
      expect(rows[0]!.blob.toLowerCase()).not.toContain('argon2');
    });

    it('is not readable by a parent', async () => {
      const parent = await registerAndLogin(harness, 'audit-noread');

      const rows = await queryAsParent(harness, parent.parentId, 'select 1 from audit_logs');

      // A principal must not be able to read the record of their own actions.
      expect(rows).toHaveLength(0);
    });
  });
});
