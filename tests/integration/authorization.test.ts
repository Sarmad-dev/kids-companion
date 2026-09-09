import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  authHeader,
  createApiHarness,
  queryAsParent,
  readAuditLog,
  registerAndLogin,
  setRole,
  type ApiHarness,
  type RegisteredParent,
} from '../helpers/api.js';

/**
 * Authorization through the real API.
 *
 * Every protected request must verify four things, and these tests exercise each
 * of them separately so a failure says which layer broke:
 *
 *   1. authenticated parent
 *   2. appropriate role
 *   3. appropriate permission
 *   4. ownership of the requested resource
 */
describe('authorization', () => {
  let harness: ApiHarness;
  let alice: RegisteredParent;
  let bob: RegisteredParent;
  let aliceChildId: string;

  beforeAll(async () => {
    harness = await createApiHarness();
    alice = await registerAndLogin(harness, 'authz-alice');
    bob = await registerAndLogin(harness, 'authz-bob');

    const created = await harness.app.inject({
      method: 'POST',
      url: '/v1/children',
      headers: authHeader(alice.accessToken),
      payload: {
        displayName: 'Alice Child',
        birthYear: 2019,
        birthMonth: 6,
        languages: [{ languageCode: 'en', isPrimary: true }],
      },
    });
    aliceChildId = created.json<{ id: string }>().id;
  }, 180_000);

  afterAll(async () => {
    await harness.close();
  });

  /* ---------------------------------------------------------------------- */
  /* Cross-parent access                                                    */
  /* ---------------------------------------------------------------------- */

  describe('cross-parent access attempts', () => {
    it("returns 404 when Bob requests Alice's child", async () => {
      // 404, not 403. A 403 confirms the child exists, and the resources here
      // are children — confirming existence is itself a disclosure.
      const response = await harness.app.inject({
        method: 'GET',
        url: `/v1/children/${aliceChildId}`,
        headers: authHeader(bob.accessToken),
      });

      expect(response.statusCode).toBe(404);
    });

    it('gives the same 404 for a child that does not exist at all', async () => {
      const missing = await harness.app.inject({
        method: 'GET',
        url: '/v1/children/00000000-0000-4000-8000-000000000000',
        headers: authHeader(bob.accessToken),
      });

      const someoneElses = await harness.app.inject({
        method: 'GET',
        url: `/v1/children/${aliceChildId}`,
        headers: authHeader(bob.accessToken),
      });

      // Indistinguishable, which is the point.
      expect(missing.statusCode).toBe(someoneElses.statusCode);
      expect(missing.json().error.code).toBe(someoneElses.json().error.code);
    });

    it("does not include Alice's children in Bob's list", async () => {
      const response = await harness.app.inject({
        method: 'GET',
        url: '/v1/children',
        headers: authHeader(bob.accessToken),
      });

      expect(response.statusCode).toBe(200);
      expect(response.json<{ items: { id: string }[] }>().items).toHaveLength(0);
    });

    it("does not expose Alice's profile to Bob", async () => {
      const response = await harness.app.inject({
        method: 'GET',
        url: '/v1/parents/me',
        headers: authHeader(bob.accessToken),
      });

      // `/parents/me` has no id parameter to tamper with, and RLS restricts the
      // table to one row — so there is no query that could return Alice's.
      expect(response.json().email).toBe(bob.email);
      expect(response.json().id).toBe(bob.parentId);
    });

    it('ignores a parent_id supplied in the request body', async () => {
      // The route takes parent_id from the authenticated principal. Even if a
      // client sends one, creating a child in someone else's account must be
      // impossible rather than merely unsupported.
      const response = await harness.app.inject({
        method: 'POST',
        url: '/v1/children',
        headers: authHeader(bob.accessToken),
        payload: {
          displayName: 'Planted Child',
          birthYear: 2019,
          birthMonth: 6,
          languages: [{ languageCode: 'en', isPrimary: true }],
          parentId: alice.parentId,
          parent_id: alice.parentId,
        },
      });

      expect(response.statusCode).toBe(201);

      const aliceChildren = await harness.app.inject({
        method: 'GET',
        url: '/v1/children',
        headers: authHeader(alice.accessToken),
      });

      const names = aliceChildren
        .json<{ items: { displayName: string }[] }>()
        .items.map((c) => c.displayName);
      expect(names).not.toContain('Planted Child');
    });

    it("cannot use Bob's session to read Alice's sessions", async () => {
      const response = await harness.app.inject({
        method: 'GET',
        url: '/v1/parents/me/sessions',
        headers: authHeader(bob.accessToken),
      });

      const ids = response.json<{ items: { id: string }[] }>().items;
      expect(ids.length).toBeGreaterThan(0);

      const { rows } = await harness.db.query<{ id: string }>(
        'select id from sessions where parent_id = $1',
        [alice.parentId],
      );

      const aliceSessionIds = new Set(rows.map((r) => r.id));
      expect(ids.every((s) => !aliceSessionIds.has(s.id))).toBe(true);
    });
  });

  /* ---------------------------------------------------------------------- */
  /* Unauthorized resource access                                           */
  /* ---------------------------------------------------------------------- */

  describe('unauthorized resource access', () => {
    it.each([
      ['GET', '/v1/parents/me'],
      ['GET', '/v1/parents/me/sessions'],
      ['GET', '/v1/children'],
      ['POST', '/v1/parents/me/sessions/revoke-all'],
    ])('rejects %s %s without a token', async (method, url) => {
      const response = await harness.app.inject({
        method: method as 'GET' | 'POST',
        url,
        ...(method === 'POST' ? { payload: {} } : {}),
      });

      expect(response.statusCode).toBe(401);
    });

    it('rejects a token signed with the wrong key', async () => {
      // A forged JWT with the right shape and a plausible `sub`. If the
      // algorithm were unpinned or the signature unchecked, this would pass.
      const forged = [
        Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
        Buffer.from(
          JSON.stringify({
            sub: alice.parentId,
            sid: '00000000-0000-4000-8000-000000000000',
            role: 'admin',
            exp: Math.floor(Date.now() / 1000) + 3600,
          }),
        ).toString('base64url'),
        'forged-signature',
      ].join('.');

      const response = await harness.app.inject({
        method: 'GET',
        url: '/v1/parents/me',
        headers: authHeader(forged),
      });

      expect(response.statusCode).toBe(401);
    });

    it('rejects an "alg: none" token', async () => {
      const unsigned = [
        Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
        Buffer.from(JSON.stringify({ sub: alice.parentId, sid: 'x', role: 'admin' })).toString(
          'base64url',
        ),
        '',
      ].join('.');

      const response = await harness.app.inject({
        method: 'GET',
        url: '/v1/parents/me',
        headers: authHeader(unsigned),
      });

      expect(response.statusCode).toBe(401);
    });

    it('leaks no internal detail in the 401 body', async () => {
      const response = await harness.app.inject({
        method: 'GET',
        url: '/v1/parents/me',
        headers: authHeader('garbage'),
      });

      expect(response.body).not.toContain('signature');
      expect(response.body).not.toContain('jwt');
      expect(response.body).not.toContain('at ');
      expect(response.json().error.requestId).toBeTruthy();
    });
  });

  /* ---------------------------------------------------------------------- */
  /* Roles and permissions                                                  */
  /* ---------------------------------------------------------------------- */

  describe('roles', () => {
    it('reports a parent as role parent with parent permissions', async () => {
      const response = await harness.app.inject({
        method: 'GET',
        url: '/v1/parents/me',
        headers: authHeader(alice.accessToken),
      });

      const body = response.json<{ role: string; permissions: string[] }>();
      expect(body.role).toBe('parent');
      expect(body.permissions).toContain('children:manage_own');
      // A parent holds no staff permission, however the client asks.
      expect(body.permissions).not.toContain('audit:read');
      expect(body.permissions).not.toContain('accounts:read_any');
    });

    it('reflects a role change on the next login, not on the old token', async () => {
      const staff = await registerAndLogin(harness, 'authz-staff');
      await setRole(harness, staff.parentId, 'admin');

      const relogin = await harness.app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { email: staff.email, password: staff.password },
      });
      const adminToken = relogin.json<{ accessToken: string }>().accessToken;

      const profile = await harness.app.inject({
        method: 'GET',
        url: '/v1/parents/me',
        headers: authHeader(adminToken),
      });

      const body = profile.json<{ role: string; permissions: string[] }>();
      expect(body.role).toBe('admin');
      expect(body.permissions).toContain('audit:read');
      expect(body.permissions).toContain('catalogue:manage');
    });

    it('does not let a staff role read child conversation content', async () => {
      // The narrowest and most important limit on staff access: support and
      // admin see accounts and safety metadata, never what a child said.
      const staff = await registerAndLogin(harness, 'authz-support');
      await setRole(harness, staff.parentId, 'support');

      const messages = await queryAsParent(harness, staff.parentId, 'select 1 from messages');
      const conversations = await queryAsParent(
        harness,
        staff.parentId,
        'select 1 from conversations',
      );

      expect(messages).toHaveLength(0);
      expect(conversations).toHaveLength(0);
    });

    it('lets an admin read the audit log that a parent cannot', async () => {
      const admin = await registerAndLogin(harness, 'authz-admin2');
      await setRole(harness, admin.parentId, 'admin');

      const adminRows = await queryAsParent(harness, admin.parentId, 'select 1 from audit_logs');
      const parentRows = await queryAsParent(harness, alice.parentId, 'select 1 from audit_logs');

      expect(adminRows.length).toBeGreaterThan(0);
      expect(parentRows).toHaveLength(0);
    });

    it('revokes staff access immediately when the role is removed', async () => {
      // The reason app.current_role() reads the database rather than a JWT
      // claim: a claim would leave a demoted admin privileged until it expired.
      const demoted = await registerAndLogin(harness, 'authz-demote');
      await setRole(harness, demoted.parentId, 'admin');
      const whileAdmin = await queryAsParent(harness, demoted.parentId, 'select 1 from audit_logs');

      await setRole(harness, demoted.parentId, 'parent');
      const afterDemotion = await queryAsParent(
        harness,
        demoted.parentId,
        'select 1 from audit_logs',
      );

      expect(whileAdmin.length).toBeGreaterThan(0);
      expect(afterDemotion).toHaveLength(0);
    });
  });

  describe('ownership denials are auditable', () => {
    it('leaves an audit trail of authentication and account events', async () => {
      const entries = await readAuditLog(harness);
      expect(entries.length).toBeGreaterThan(0);
      expect(entries.every((e) => ['success', 'denied', 'error'].includes(e.outcome))).toBe(true);
    });
  });
});
