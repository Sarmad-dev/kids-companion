import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  authHeader,
  createApiHarness,
  readAuditLog,
  registerAndLogin,
  type ApiHarness,
  type RegisteredParent,
} from '../helpers/api.js';

/**
 * The child profile subsystem, end to end through the real API.
 *
 * The scenarios the brief names, plus the ones that only appear when you try to
 * misuse it: a character offered to the wrong age group, a language set with two
 * primaries, and a topic key smuggled past the curated catalogue.
 */
describe('child profiles', () => {
  let harness: ApiHarness;
  let alice: RegisteredParent;
  let bob: RegisteredParent;

  const createChild = async (parent: RegisteredParent, overrides: Record<string, unknown> = {}) =>
    await harness.app.inject({
      method: 'POST',
      url: '/v1/children',
      headers: authHeader(parent.accessToken),
      payload: {
        displayName: 'Test Child',
        birthYear: 2019,
        birthMonth: 6,
        languages: [{ languageCode: 'en', isPrimary: true }],
        ...overrides,
      },
    });

  beforeAll(async () => {
    harness = await createApiHarness();
    alice = await registerAndLogin(harness, 'child-alice');
    bob = await registerAndLogin(harness, 'child-bob');
  }, 180_000);

  afterAll(async () => {
    await harness.close();
  });

  /* ---------------------------------------------------------------------- */
  /* Creation                                                               */
  /* ---------------------------------------------------------------------- */

  describe('creation', () => {
    it('creates a profile with a derived age group', async () => {
      const response = await createChild(alice, { displayName: 'Ayesha', birthYear: 2019 });

      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({
        displayName: 'Ayesha',
        status: 'active',
        ageInSupportedRange: true,
      });
      expect(response.json().id).toBeTruthy();
    });

    it('creates default parental controls and learning preferences', async () => {
      const created = await createChild(alice);
      const childId = created.json<{ id: string }>().id;

      const preferences = await harness.app.inject({
        method: 'GET',
        url: `/v1/children/${childId}/preferences`,
        headers: authHeader(alice.accessToken),
      });

      // No window in which a child exists without limits or preferences.
      expect(preferences.statusCode).toBe(200);
      expect(preferences.json()).toMatchObject({
        sessionLength: 'short',
        correctionStyle: 'gentle',
        topicKeys: [],
      });

      const controls = await harness.db.query(
        'select 1 from parental_controls where child_id = $1',
        [childId],
      );
      expect(controls.rows).toHaveLength(1);
    });

    it('collects no field beyond the minimised set', async () => {
      // The profile carries a nickname, a birth month and year, a language set,
      // a character, and bounded preferences. Anything else is a regression in
      // data minimisation, so the shape is asserted rather than assumed.
      const created = await createChild(alice);

      expect(Object.keys(created.json()).sort()).toEqual([
        'ageGroup',
        'ageInSupportedRange',
        'archivedAt',
        'avatarKey',
        'birthMonth',
        'birthYear',
        'createdAt',
        'displayName',
        'id',
        'languages',
        'preferredCharacterId',
        'status',
        'updatedAt',
      ]);
    });

    it('has no column anywhere for a surname, school, address, or photograph', async () => {
      const { rows } = await harness.db.query<{ column_name: string }>(`
        select a.attname as column_name
        from pg_attribute a
        join pg_class c on c.oid = a.attrelid
        where c.relname = 'children' and a.attnum > 0 and not a.attisdropped
          and a.attname ~* '(surname|last_name|family_name|school|address|postcode|photo|image|phone|gender)'
      `);

      expect(rows.map((r) => r.column_name)).toEqual([]);
    });

    it('no longer has a free-text interests column', async () => {
      // Removed rather than bounded: "loves visiting grandma in Lahore" is a
      // family member, a city, and a routine the product never needed.
      const { rows } = await harness.db.query(`
        select 1 from pg_attribute a
        join pg_class c on c.oid = a.attrelid
        where c.relname = 'children' and a.attname = 'interests' and not a.attisdropped
      `);

      expect(rows).toHaveLength(0);
    });

    it('rejects a birth year outside the plausible range', async () => {
      const response = await createChild(alice, { birthYear: 1899 });

      expect(response.statusCode).toBe(400);
    });

    it('rejects a display name longer than the bound', async () => {
      const response = await createChild(alice, { displayName: 'x'.repeat(41) });

      expect(response.statusCode).toBe(400);
    });

    it('audits creation with the age group, never the birth date', async () => {
      await createChild(alice);
      const entries = await readAuditLog(harness, 'child.profile.created');

      expect(entries.length).toBeGreaterThan(0);

      const { rows } = await harness.db.query<{ metadata: Record<string, unknown> }>(
        `select metadata from audit_logs where action = 'child.profile.created' limit 1`,
      );
      expect(Object.keys(rows[0]!.metadata)).toContain('ageGroup');
      expect(JSON.stringify(rows[0]!.metadata)).not.toContain('2019');
    });
  });

  /* ---------------------------------------------------------------------- */
  /* Age groups                                                             */
  /* ---------------------------------------------------------------------- */

  describe('age groups', () => {
    it.each([
      [2022, 'AGE_3_5'],
      [2021, 'AGE_3_5'],
      [2020, 'AGE_6_8'],
      [2019, 'AGE_6_8'],
      [2018, 'AGE_6_8'],
      [2017, 'AGE_9_10'],
      [2016, 'AGE_9_10'],
    ])('maps a child born in %i to %s', async (year, group) => {
      const { rows } = await harness.db.query<{ g: string }>(
        `select app.age_group($1, 6, date '2026-08-17') as g`,
        [year],
      );

      expect(rows[0]!.g).toBe(group);
    });

    it('clamps below three and above ten rather than erroring', async () => {
      const { rows } = await harness.db.query<{ young: string; old: string }>(
        `select app.age_group(2025, 6, date '2026-08-17') as young,
                app.age_group(2010, 6, date '2026-08-17') as old`,
      );

      // A profile created a month before a third birthday must not be
      // unreadable; the range flag reports the fact instead.
      expect(rows[0]!.young).toBe('AGE_3_5');
      expect(rows[0]!.old).toBe('AGE_9_10');
    });

    it('reports when a child is outside the supported range', async () => {
      const { rows } = await harness.db.query<{ inside: boolean; outside: boolean }>(
        `select app.age_in_range(2019, 6, date '2026-08-17') as inside,
                app.age_in_range(2010, 6, date '2026-08-17') as outside`,
      );

      expect(rows[0]!.inside).toBe(true);
      expect(rows[0]!.outside).toBe(false);
    });

    it('recomputes the group when a birth year is corrected', async () => {
      const created = await createChild(alice, { birthYear: 2021 });
      const childId = created.json<{ id: string }>().id;
      expect(created.json().ageGroup).toBe('AGE_3_5');

      const updated = await harness.app.inject({
        method: 'PATCH',
        url: `/v1/children/${childId}`,
        headers: authHeader(alice.accessToken),
        payload: { birthYear: 2016 },
      });

      // Derived, never stored — so a correction takes effect immediately rather
      // than leaving a nine-year-old on a three-year-old's content policy.
      expect(updated.json().ageGroup).toBe('AGE_9_10');
    });
  });

  /* ---------------------------------------------------------------------- */
  /* Languages                                                              */
  /* ---------------------------------------------------------------------- */

  describe('language selection', () => {
    it('offers all ten specified languages, tiered', async () => {
      const { rows } = await harness.db.query<{ code: string; tier: string }>(
        'select code, tier from supported_languages order by sort_order',
      );

      expect(rows.filter((r) => r.tier === 'primary').map((r) => r.code)).toEqual([
        'en',
        'ur',
        'ar',
      ]);
      expect(rows.filter((r) => r.tier === 'secondary').map((r) => r.code)).toEqual([
        'hi',
        'es',
        'fr',
        'zh',
      ]);
      expect(rows.filter((r) => r.tier === 'regional').map((r) => r.code)).toEqual([
        'pa',
        'sd',
        'ps',
      ]);
    });

    it('does not claim STT support for Urdu', async () => {
      // Unproven until the S-1 spike reports. Marking it supported before it is
      // measured would be the schema asserting something we do not know.
      const { rows } = await harness.db.query<{ stt_supported: boolean }>(
        `select stt_supported from supported_languages where code = 'ur'`,
      );

      expect(rows[0]!.stt_supported).toBe(false);
    });

    it('stores multiple languages with one primary', async () => {
      const created = await createChild(alice, {
        languages: [
          { languageCode: 'ur', isPrimary: true, proficiency: 'native' },
          { languageCode: 'en', isPrimary: false, proficiency: 'learning' },
        ],
      });

      expect(created.statusCode).toBe(201);
      expect(created.json().languages).toEqual([
        { languageCode: 'ur', isPrimary: true, proficiency: 'native' },
        { languageCode: 'en', isPrimary: false, proficiency: 'learning' },
      ]);
    });

    it('rejects two primary languages', async () => {
      const response = await createChild(alice, {
        languages: [
          { languageCode: 'en', isPrimary: true },
          { languageCode: 'ur', isPrimary: true },
        ],
      });

      // The generation language must have exactly one answer at request time.
      expect(response.statusCode).toBe(400);
    });

    it('rejects zero primary languages', async () => {
      const response = await createChild(alice, {
        languages: [{ languageCode: 'en', isPrimary: false }],
      });

      expect(response.statusCode).toBe(400);
    });

    it('rejects a language outside the catalogue', async () => {
      const response = await createChild(alice, {
        languages: [{ languageCode: 'zz', isPrimary: true }],
      });

      expect(response.statusCode).toBeGreaterThanOrEqual(400);
    });

    it('replaces the whole language set atomically', async () => {
      const created = await createChild(alice);
      const childId = created.json<{ id: string }>().id;

      const updated = await harness.app.inject({
        method: 'PUT',
        url: `/v1/children/${childId}/languages`,
        headers: authHeader(alice.accessToken),
        payload: {
          languages: [
            { languageCode: 'ur', isPrimary: true, proficiency: 'native' },
            { languageCode: 'ar', isPrimary: false, proficiency: 'learning' },
          ],
        },
      });

      expect(updated.statusCode).toBe(200);
      expect(
        updated
          .json<{ languages: { languageCode: string }[] }>()
          .languages.map((l) => l.languageCode),
      ).toEqual(['ur', 'ar']);
    });
  });

  /* ---------------------------------------------------------------------- */
  /* Character selection                                                    */
  /* ---------------------------------------------------------------------- */

  describe('character selection', () => {
    const characterBySlug = async (slug: string) => {
      const { rows } = await harness.db.query<{ id: string }>(
        'select id from ai_characters where slug = $1',
        [slug],
      );
      return rows[0]!.id;
    };

    it('accepts a character offered for the age group and language', async () => {
      const lily = await characterBySlug('lily-the-fairy');
      const response = await createChild(alice, { birthYear: 2021, preferredCharacterId: lily });

      expect(response.statusCode).toBe(201);
      expect(response.json().preferredCharacterId).toBe(lily);
    });

    it('rejects a character not offered for the age group', async () => {
      // Captain Sky is AGE_6_8/AGE_9_10 only: sustained narrative and mild story
      // tension do not suit a three-year-old.
      const captain = await characterBySlug('captain-sky');
      const response = await createChild(alice, { birthYear: 2022, preferredCharacterId: captain });

      expect(response.statusCode).toBe(400);
      expect(JSON.stringify(response.json())).toContain('age group');
    });

    it("rejects a character that speaks none of the child's languages", async () => {
      const owl = await characterBySlug('professor-owl'); // English only
      const response = await createChild(alice, {
        birthYear: 2019,
        languages: [{ languageCode: 'ur', isPrimary: true }],
        preferredCharacterId: owl,
      });

      expect(response.statusCode).toBe(400);
      expect(JSON.stringify(response.json())).toContain('languages');
    });

    it("clears a character that no longer speaks the child's languages", async () => {
      const owl = await characterBySlug('professor-owl');
      const created = await createChild(alice, { birthYear: 2019, preferredCharacterId: owl });
      const childId = created.json<{ id: string }>().id;
      expect(created.json().preferredCharacterId).toBe(owl);

      const switched = await harness.app.inject({
        method: 'PUT',
        url: `/v1/children/${childId}/languages`,
        headers: authHeader(alice.accessToken),
        payload: { languages: [{ languageCode: 'ur', isPrimary: true }] },
      });

      // Cleared rather than left dangling: keeping it would start the next
      // session in a language the child does not have.
      expect(switched.json().preferredCharacterId).toBeNull();
    });
  });

  /* ---------------------------------------------------------------------- */
  /* Learning preferences                                                   */
  /* ---------------------------------------------------------------------- */

  describe('learning preferences', () => {
    it('updates bounded preferences', async () => {
      const created = await createChild(alice, { birthYear: 2018 });
      const childId = created.json<{ id: string }>().id;

      const response = await harness.app.inject({
        method: 'PUT',
        url: `/v1/children/${childId}/preferences`,
        headers: authHeader(alice.accessToken),
        payload: {
          sessionLength: 'medium',
          storytellingEnabled: true,
          correctionStyle: 'active',
          topicKeys: ['animals', 'space'],
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        sessionLength: 'medium',
        correctionStyle: 'active',
        topicKeys: ['animals', 'space'],
      });
    });

    it('rejects a topic key that is not in the curated catalogue', async () => {
      const created = await createChild(alice, { birthYear: 2018 });
      const childId = created.json<{ id: string }>().id;

      const response = await harness.app.inject({
        method: 'PUT',
        url: `/v1/children/${childId}/preferences`,
        headers: authHeader(alice.accessToken),
        payload: { topicKeys: ['loves visiting grandma in Lahore'] },
      });

      // The curation is the point: a key that is not in the catalogue is either
      // a client bug or free text trying to get in.
      expect(response.statusCode).toBe(400);
    });

    it('rejects a topic not offered for the age group', async () => {
      const created = await createChild(alice, { birthYear: 2022 }); // AGE_3_5
      const childId = created.json<{ id: string }>().id;

      const response = await harness.app.inject({
        method: 'PUT',
        url: `/v1/children/${childId}/preferences`,
        headers: authHeader(alice.accessToken),
        payload: { topicKeys: ['history'] }, // AGE_9_10 only
      });

      expect(response.statusCode).toBe(400);
    });
  });

  /* ---------------------------------------------------------------------- */
  /* Ownership and unauthorized access                                      */
  /* ---------------------------------------------------------------------- */

  describe('ownership', () => {
    let aliceChildId: string;

    beforeAll(async () => {
      const created = await createChild(alice, { displayName: 'Alice Only' });
      aliceChildId = created.json<{ id: string }>().id;
    });

    it.each([
      ['GET', ''],
      ['PATCH', ''],
      ['GET', '/preferences'],
      ['PUT', '/preferences'],
      ['PUT', '/languages'],
      ['POST', '/archive'],
      ['POST', '/restore'],
      ['DELETE', ''],
      ['GET', '/consent-status'],
    ])("returns 404 when Bob calls %s :childId%s on Alice's child", async (method, suffix) => {
      const response = await harness.app.inject({
        method: method as 'GET' | 'PATCH' | 'PUT' | 'POST' | 'DELETE',
        url: `/v1/children/${aliceChildId}${suffix}`,
        headers: authHeader(bob.accessToken),
        ...(method === 'PATCH' || method === 'PUT' || method === 'POST'
          ? { payload: { languages: [{ languageCode: 'en', isPrimary: true }] } }
          : {}),
      });

      // 404, never 403: the resources are children, and confirming one exists
      // to an unauthorised caller is itself a disclosure.
      expect(response.statusCode).toBe(404);
    });

    it("does not list Alice's children for Bob", async () => {
      const response = await harness.app.inject({
        method: 'GET',
        url: '/v1/children',
        headers: authHeader(bob.accessToken),
      });

      const names = response
        .json<{ items: { displayName: string }[] }>()
        .items.map((c) => c.displayName);
      expect(names).not.toContain('Alice Only');
    });

    it("leaves Alice's child untouched after Bob's attempts", async () => {
      const { rows } = await harness.db.query<{ display_name: string; status: string }>(
        'select display_name, status from children where id = $1',
        [aliceChildId],
      );

      expect(rows[0]).toMatchObject({ display_name: 'Alice Only', status: 'active' });
    });

    it('rejects every child route without a token', async () => {
      for (const url of ['/v1/children', `/v1/children/${aliceChildId}`]) {
        const response = await harness.app.inject({ method: 'GET', url });
        expect(response.statusCode).toBe(401);
      }
    });
  });

  /* ---------------------------------------------------------------------- */
  /* Archive, restore, delete                                               */
  /* ---------------------------------------------------------------------- */

  describe('archive and deletion', () => {
    it('archives a profile and hides it from the default list', async () => {
      const created = await createChild(alice, { displayName: 'To Archive' });
      const childId = created.json<{ id: string }>().id;

      const archived = await harness.app.inject({
        method: 'POST',
        url: `/v1/children/${childId}/archive`,
        headers: authHeader(alice.accessToken),
      });

      expect(archived.statusCode).toBe(200);
      expect(archived.json()).toMatchObject({ status: 'archived' });
      expect(archived.json().archivedAt).toBeTruthy();

      const list = await harness.app.inject({
        method: 'GET',
        url: '/v1/children',
        headers: authHeader(alice.accessToken),
      });
      expect(list.json<{ items: { id: string }[] }>().items.map((c) => c.id)).not.toContain(
        childId,
      );
    });

    it('includes archived profiles when asked', async () => {
      const created = await createChild(alice, { displayName: 'Archived Visible' });
      const childId = created.json<{ id: string }>().id;
      await harness.app.inject({
        method: 'POST',
        url: `/v1/children/${childId}/archive`,
        headers: authHeader(alice.accessToken),
      });

      const list = await harness.app.inject({
        method: 'GET',
        url: '/v1/children?includeArchived=true',
        headers: authHeader(alice.accessToken),
      });

      expect(list.json<{ items: { id: string }[] }>().items.map((c) => c.id)).toContain(childId);
    });

    it('retains the data — archive is not deletion', async () => {
      const created = await createChild(alice, { displayName: 'Still Here' });
      const childId = created.json<{ id: string }>().id;
      await harness.app.inject({
        method: 'POST',
        url: `/v1/children/${childId}/archive`,
        headers: authHeader(alice.accessToken),
      });

      // Conflating the two would let a parent believe they had deleted their
      // child's data when they had not.
      const { rows } = await harness.db.query('select 1 from children where id = $1', [childId]);
      expect(rows).toHaveLength(1);
    });

    it('restores an archived profile', async () => {
      const created = await createChild(alice, { displayName: 'To Restore' });
      const childId = created.json<{ id: string }>().id;
      await harness.app.inject({
        method: 'POST',
        url: `/v1/children/${childId}/archive`,
        headers: authHeader(alice.accessToken),
      });

      const restored = await harness.app.inject({
        method: 'POST',
        url: `/v1/children/${childId}/restore`,
        headers: authHeader(alice.accessToken),
      });

      expect(restored.statusCode).toBe(200);
      expect(restored.json()).toMatchObject({ status: 'active', archivedAt: null });
    });

    it('deletes a profile and everything hanging off it', async () => {
      const created = await createChild(alice, { displayName: 'To Delete' });
      const childId = created.json<{ id: string }>().id;

      const deleted = await harness.app.inject({
        method: 'DELETE',
        url: `/v1/children/${childId}`,
        headers: authHeader(alice.accessToken),
      });

      expect(deleted.statusCode).toBe(204);

      for (const table of [
        'children',
        'child_languages',
        'parental_controls',
        'child_learning_preferences',
      ]) {
        const column = table === 'children' ? 'id' : 'child_id';
        const { rows } = await harness.db.query(`select 1 from ${table} where ${column} = $1`, [
          childId,
        ]);
        expect(rows, `${table} should be empty after deletion`).toHaveLength(0);
      }
    });

    it('audits archive and deletion distinctly', async () => {
      const archived = await readAuditLog(harness, 'child.profile.archived');
      const deleted = await readAuditLog(harness, 'child.profile.deleted');

      expect(archived.length).toBeGreaterThan(0);
      expect(deleted.length).toBeGreaterThan(0);
    });
  });
});
