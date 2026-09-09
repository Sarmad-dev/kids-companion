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
 * Parental consent, and the gate it drives.
 *
 * The assertion that matters most is the last group: a child cannot reach
 * conversation before the required consent state is satisfied, and that is
 * enforced by the DATABASE — proven by attempting the insert directly, with the
 * application layer entirely absent.
 */
describe('parental consent', () => {
  let harness: ApiHarness;
  let alice: RegisteredParent;
  let bob: RegisteredParent;

  const POLICY_VERSION = '2026-08-01';
  const POLICY_TEXT = "We process your child's speech to generate a reply, and discard the audio.";

  const createChild = async (parent: RegisteredParent, displayName = 'Test Child') =>
    (
      await harness.app.inject({
        method: 'POST',
        url: '/v1/children',
        headers: authHeader(parent.accessToken),
        payload: {
          displayName,
          birthYear: 2019,
          birthMonth: 6,
          languages: [{ languageCode: 'en', isPrimary: true }],
        },
      })
    ).json<{ id: string }>().id;

  const recordConsent = async (
    parent: RegisteredParent,
    consentType: string,
    granted: boolean,
    childId?: string,
  ) =>
    await harness.app.inject({
      method: 'POST',
      url: '/v1/consent',
      headers: authHeader(parent.accessToken),
      payload: {
        consentType,
        granted,
        policyVersion: POLICY_VERSION,
        policyText: POLICY_TEXT,
        ...(childId === undefined ? {} : { childId }),
      },
    });

  /** Grants everything a child needs to be allowed into conversation. */
  const grantAllRequired = async (parent: RegisteredParent, childId: string) => {
    await recordConsent(parent, 'terms_of_service', true);
    await recordConsent(parent, 'privacy_policy', true);
    await recordConsent(parent, 'child_data_processing', true, childId);
  };

  const consentStatus = async (parent: RegisteredParent, childId: string) =>
    (
      await harness.app.inject({
        method: 'GET',
        url: `/v1/children/${childId}/consent-status`,
        headers: authHeader(parent.accessToken),
      })
    ).json<{
      conversationAllowed: boolean;
      missingConsents: string[];
      blockedReason: string | null;
    }>();

  /** Attempts a conversation insert directly, bypassing every application check. */
  const tryStartConversation = async (childId: string, parentId: string) => {
    const { rows: character } = await harness.db.query<{ id: string }>(
      `select id from ai_characters where status = 'active' limit 1`,
    );

    await harness.db.exec('begin');
    try {
      await harness.db.query('set local role authenticated');
      await harness.db.query(`select set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ sub: parentId, role: 'authenticated' }),
      ]);
      await harness.db.query('insert into conversations (child_id, character_id) values ($1, $2)', [
        childId,
        character[0]!.id,
      ]);
      return { allowed: true, error: null as string | null };
    } catch (error) {
      return { allowed: false, error: (error as Error).message };
    } finally {
      await harness.db.exec('rollback');
    }
  };

  beforeAll(async () => {
    harness = await createApiHarness();
    alice = await registerAndLogin(harness, 'consent-alice');
    bob = await registerAndLogin(harness, 'consent-bob');
  }, 180_000);

  afterAll(async () => {
    await harness.close();
  });

  /* ---------------------------------------------------------------------- */
  /* Requirements are data                                                  */
  /* ---------------------------------------------------------------------- */

  describe('requirements', () => {
    it('lists what is required and why', async () => {
      const response = await harness.app.inject({
        method: 'GET',
        url: '/v1/consent/requirements',
        headers: authHeader(alice.accessToken),
      });

      expect(response.statusCode).toBe(200);
      const items = response.json<{ items: { consentType: string; rationale: string }[] }>().items;

      // A parent is entitled to see what is being asked and why, which is why
      // `rationale` is a required column rather than a comment somewhere.
      expect(items.length).toBeGreaterThan(0);
      expect(items.every((i) => i.rationale.length > 0)).toBe(true);
      expect(items.map((i) => i.consentType)).toContain('child_data_processing');
    });

    it('separates blocking requirements from advisory ones', async () => {
      const response = await harness.app.inject({
        method: 'GET',
        url: '/v1/consent/requirements',
        headers: authHeader(alice.accessToken),
      });
      const items = response.json<{
        items: { consentType: string; blocksConversation: boolean }[];
      }>().items;

      const blocking = items.filter((i) => i.blocksConversation).map((i) => i.consentType);
      const advisory = items.filter((i) => !i.blocksConversation).map((i) => i.consentType);

      expect(blocking).toContain('child_data_processing');
      // The core service must work with every optional consent refused, or it
      // is not consent (PRIVACY.md §4.2).
      expect(advisory).toContain('transcript_retention');
      expect(advisory).toContain('product_analytics');
    });

    it('lets a new requirement be added without a code change', async () => {
      // The architectural claim: changing the legal position is an INSERT.
      const childId = await createChild(alice, 'Requirement Child');
      await grantAllRequired(alice, childId);
      expect((await consentStatus(alice, childId)).conversationAllowed).toBe(true);

      await harness.db.query(
        `insert into consent_requirements
           (consent_type, scope, jurisdiction, min_policy_version, blocks_conversation, rationale)
         values ('audio_retention', 'child', '*', '2026-08-01', true,
                 'Hypothetical future requirement, added as data.')`,
      );

      const after = await consentStatus(alice, childId);
      expect(after.conversationAllowed).toBe(false);
      expect(after.missingConsents).toContain('audio_retention');

      // And satisfying it re-opens the gate, still with no deploy.
      await recordConsent(alice, 'audio_retention', true, childId);
      expect((await consentStatus(alice, childId)).conversationAllowed).toBe(true);

      await harness.db.query(
        `delete from consent_requirements where consent_type = 'audio_retention'`,
      );
    });

    it('honours a raised policy version by requiring re-consent', async () => {
      const childId = await createChild(alice, 'Reconsent Child');
      await grantAllRequired(alice, childId);
      expect((await consentStatus(alice, childId)).conversationAllowed).toBe(true);

      // A material policy change raises the minimum version, and consent given
      // against the old wording stops counting.
      await harness.db.query(
        `update consent_requirements set min_policy_version = '2027-01-01'
          where consent_type = 'child_data_processing'`,
      );

      const after = await consentStatus(alice, childId);
      expect(after.conversationAllowed).toBe(false);
      expect(after.missingConsents).toContain('child_data_processing');

      await harness.db.query(
        `update consent_requirements set min_policy_version = '2026-08-01'
          where consent_type = 'child_data_processing'`,
      );
    });
  });

  /* ---------------------------------------------------------------------- */
  /* Recording                                                              */
  /* ---------------------------------------------------------------------- */

  describe('recording a decision', () => {
    it('records a grant', async () => {
      const response = await recordConsent(alice, 'terms_of_service', true);

      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({ recorded: true, granted: true });
    });

    it('stores a hash of the wording, never the wording itself', async () => {
      await recordConsent(alice, 'privacy_policy', true);

      const { rows } = await harness.db.query<{ policy_text_hash: string }>(
        `select policy_text_hash from consent_records
          where parent_id = $1 and consent_type = 'privacy_policy'
          order by recorded_at desc limit 1`,
        [alice.parentId],
      );

      // Proof of what was agreed to, not a second copy of it.
      expect(rows[0]!.policy_text_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(rows[0]!.policy_text_hash).not.toContain('speech');
    });

    it('records a withdrawal as a new row, leaving the grant in place', async () => {
      const before = await harness.db.query(
        `select 1 from consent_records where parent_id = $1 and consent_type = 'product_analytics'`,
        [alice.parentId],
      );

      await recordConsent(alice, 'product_analytics', true);
      await recordConsent(alice, 'product_analytics', false);

      const after = await harness.db.query<{ granted: boolean }>(
        `select granted from consent_records
          where parent_id = $1 and consent_type = 'product_analytics'
          order by recorded_at`,
        [alice.parentId],
      );

      // The ledger is the point: "granted in March, withdrew in June" must
      // remain answerable.
      expect(after.rows.length).toBe(before.rows.length + 2);
      expect(after.rows.map((r) => r.granted).slice(-2)).toEqual([true, false]);
    });

    it('refuses to rewrite history', async () => {
      await expect(
        harness.db.query(`update consent_records set granted = false where parent_id = $1`, [
          alice.parentId,
        ]),
      ).rejects.toThrow(/append-only/i);
    });

    it("rejects a consent recorded against another parent's child", async () => {
      const aliceChild = await createChild(alice, 'Not Bobs');

      const response = await recordConsent(bob, 'child_data_processing', true, aliceChild);

      expect(response.statusCode).toBe(404);
    });

    it('rejects a malformed policy version', async () => {
      const response = await harness.app.inject({
        method: 'POST',
        url: '/v1/consent',
        headers: authHeader(alice.accessToken),
        payload: {
          consentType: 'terms_of_service',
          granted: true,
          policyVersion: 'v1',
          policyText: POLICY_TEXT,
        },
      });

      expect(response.statusCode).toBe(400);
    });

    it('audits grants and withdrawals distinctly', async () => {
      const granted = await readAuditLog(harness, 'consent.granted');
      const withdrawn = await readAuditLog(harness, 'consent.withdrawn');

      expect(granted.length).toBeGreaterThan(0);
      expect(withdrawn.length).toBeGreaterThan(0);
    });

    it('never records the policy text in the audit log', async () => {
      const { rows } = await harness.db.query<{ blob: string }>(
        `select coalesce(string_agg(metadata::text, ' '), '') as blob
           from audit_logs where action like 'consent.%'`,
      );

      expect(rows[0]!.blob).not.toContain('speech');
      expect(rows[0]!.blob).toContain('policyVersion');
    });
  });

  /* ---------------------------------------------------------------------- */
  /* History                                                                */
  /* ---------------------------------------------------------------------- */

  describe('history', () => {
    it('returns the full ledger, newest first', async () => {
      const response = await harness.app.inject({
        method: 'GET',
        url: '/v1/consent/history',
        headers: authHeader(alice.accessToken),
      });

      expect(response.statusCode).toBe(200);
      const items = response.json<{ items: { recordedAt: string; policyTextHash: string }[] }>()
        .items;

      expect(items.length).toBeGreaterThan(0);
      expect(items.every((i) => /^[0-9a-f]{64}$/.test(i.policyTextHash))).toBe(true);

      const timestamps = items.map((i) => i.recordedAt);
      expect([...timestamps].sort().reverse()).toEqual(timestamps);
    });

    it("does not expose another parent's consent history", async () => {
      const response = await harness.app.inject({
        method: 'GET',
        url: '/v1/consent/history',
        headers: authHeader(bob.accessToken),
      });

      const { rows: aliceHashes } = await harness.db.query<{ policy_text_hash: string }>(
        'select policy_text_hash from consent_records where parent_id = $1',
        [alice.parentId],
      );

      const bobItems = response.json<{ items: { policyTextHash: string }[] }>().items;
      const aliceSet = new Set(aliceHashes.map((r) => r.policy_text_hash));
      // Hashes are shared across parents for the same text, so compare counts:
      // Bob must see only his own rows.
      const { rows: bobRows } = await harness.db.query(
        'select 1 from consent_records where parent_id = $1',
        [bob.parentId],
      );
      expect(bobItems).toHaveLength(bobRows.length);
      expect(aliceSet.size).toBeGreaterThan(0);
    });

    it('requires authentication', async () => {
      const response = await harness.app.inject({ method: 'GET', url: '/v1/consent/history' });

      expect(response.statusCode).toBe(401);
    });
  });

  /* ---------------------------------------------------------------------- */
  /* THE GATE                                                               */
  /* ---------------------------------------------------------------------- */

  describe('the conversation gate', () => {
    it('blocks a child with no consent recorded', async () => {
      const fresh = await registerAndLogin(harness, 'consent-fresh');
      const childId = await createChild(fresh, 'Ungated');

      const status = await consentStatus(fresh, childId);

      expect(status.conversationAllowed).toBe(false);
      expect(status.blockedReason).toBe('consent');
      expect(status.missingConsents).toEqual(
        expect.arrayContaining(['terms_of_service', 'privacy_policy', 'child_data_processing']),
      );
    });

    it('still blocks when only the account-scoped consents are granted', async () => {
      const parent = await registerAndLogin(harness, 'consent-partial');
      const childId = await createChild(parent, 'Partially Consented');

      await recordConsent(parent, 'terms_of_service', true);
      await recordConsent(parent, 'privacy_policy', true);

      const status = await consentStatus(parent, childId);

      // The per-child consent is the one that matters most: a parent consenting
      // to the service is not the same as consenting to processing THIS child's
      // speech (PRIVACY.md §4.1).
      expect(status.conversationAllowed).toBe(false);
      expect(status.missingConsents).toEqual(['child_data_processing']);
    });

    it('allows conversation once every blocking consent is granted', async () => {
      const parent = await registerAndLogin(harness, 'consent-full');
      const childId = await createChild(parent, 'Fully Consented');
      await grantAllRequired(parent, childId);

      const status = await consentStatus(parent, childId);

      expect(status.conversationAllowed).toBe(true);
      expect(status.missingConsents).toEqual([]);
      expect(status.blockedReason).toBeNull();
    });

    it('does not require the advisory consents', async () => {
      const parent = await registerAndLogin(harness, 'consent-advisory');
      const childId = await createChild(parent, 'No Analytics');
      await grantAllRequired(parent, childId);
      await recordConsent(parent, 'product_analytics', false);
      await recordConsent(parent, 'transcript_retention', false, childId);

      // Refusing every optional consent must leave the core product working.
      expect((await consentStatus(parent, childId)).conversationAllowed).toBe(true);
    });

    it('closes the gate again when consent is withdrawn', async () => {
      const parent = await registerAndLogin(harness, 'consent-withdraw');
      const childId = await createChild(parent, 'Withdrawn');
      await grantAllRequired(parent, childId);
      expect((await consentStatus(parent, childId)).conversationAllowed).toBe(true);

      await recordConsent(parent, 'child_data_processing', false, childId);

      const status = await consentStatus(parent, childId);
      expect(status.conversationAllowed).toBe(false);
      expect(status.missingConsents).toContain('child_data_processing');
    });

    it('scopes per-child consent to that child only', async () => {
      const parent = await registerAndLogin(harness, 'consent-siblings');
      const first = await createChild(parent, 'Consented Sibling');
      const second = await createChild(parent, 'Unconsented Sibling');

      await recordConsent(parent, 'terms_of_service', true);
      await recordConsent(parent, 'privacy_policy', true);
      await recordConsent(parent, 'child_data_processing', true, first);

      expect((await consentStatus(parent, first)).conversationAllowed).toBe(true);
      // Consent for one child is not consent for their sibling.
      expect((await consentStatus(parent, second)).conversationAllowed).toBe(false);
    });

    it('blocks an archived child even with full consent', async () => {
      const parent = await registerAndLogin(harness, 'consent-archived');
      const childId = await createChild(parent, 'Archived Consented');
      await grantAllRequired(parent, childId);

      await harness.app.inject({
        method: 'POST',
        url: `/v1/children/${childId}/archive`,
        headers: authHeader(parent.accessToken),
      });

      const status = await consentStatus(parent, childId);
      expect(status.conversationAllowed).toBe(false);
      // The distinction matters to the client: "grant consent" and "restore this
      // profile" are different actions to offer.
      expect(status.blockedReason).toBe('archived');
    });
  });

  /* ---------------------------------------------------------------------- */
  /* Enforcement at the database                                            */
  /* ---------------------------------------------------------------------- */

  describe('enforcement', () => {
    it('refuses a conversation insert for an unconsented child, with no application layer', async () => {
      // The assertion that matters most in this file. A handler can be
      // forgotten on a new route; the RLS policy cannot.
      const parent = await registerAndLogin(harness, 'gate-db-blocked');
      const childId = await createChild(parent, 'DB Blocked');

      const attempt = await tryStartConversation(childId, parent.parentId);

      expect(attempt.allowed).toBe(false);
      expect(attempt.error).toMatch(/row-level security/i);
    });

    it('permits the same insert once consent is granted', async () => {
      const parent = await registerAndLogin(harness, 'gate-db-allowed');
      const childId = await createChild(parent, 'DB Allowed');
      await grantAllRequired(parent, childId);

      const attempt = await tryStartConversation(childId, parent.parentId);

      expect(attempt.allowed).toBe(true);
    });

    it('refuses again after withdrawal', async () => {
      const parent = await registerAndLogin(harness, 'gate-db-withdrawn');
      const childId = await createChild(parent, 'DB Withdrawn');
      await grantAllRequired(parent, childId);
      expect((await tryStartConversation(childId, parent.parentId)).allowed).toBe(true);

      await recordConsent(parent, 'child_data_processing', false, childId);

      const attempt = await tryStartConversation(childId, parent.parentId);
      expect(attempt.allowed).toBe(false);
    });

    it('refuses for an archived child', async () => {
      const parent = await registerAndLogin(harness, 'gate-db-archived');
      const childId = await createChild(parent, 'DB Archived');
      await grantAllRequired(parent, childId);

      await harness.app.inject({
        method: 'POST',
        url: `/v1/children/${childId}/archive`,
        headers: authHeader(parent.accessToken),
      });

      expect((await tryStartConversation(childId, parent.parentId)).allowed).toBe(false);
    });

    it('blocks new messages after a withdrawal, on a conversation that already existed', async () => {
      const parent = await registerAndLogin(harness, 'gate-db-messages');
      const childId = await createChild(parent, 'DB Messages');
      await grantAllRequired(parent, childId);

      const { rows: character } = await harness.db.query<{ id: string }>(
        `select id from ai_characters where status = 'active' limit 1`,
      );
      const { rows: conversation } = await harness.db.query<{ id: string }>(
        'insert into conversations (child_id, character_id) values ($1, $2) returning id',
        [childId, character[0]!.id],
      );

      await recordConsent(parent, 'child_data_processing', false, childId);

      await harness.db.exec('begin');
      let blocked = false;
      try {
        await harness.db.query('set local role authenticated');
        await harness.db.query(`select set_config('request.jwt.claims', $1, true)`, [
          JSON.stringify({ sub: parent.parentId, role: 'authenticated' }),
        ]);
        await harness.db.query(
          `insert into messages (conversation_id, child_id, role, sequence, content_ciphertext, content_key_id)
           values ($1, $2, 'child', 0, decode('00','hex'), 'k1')`,
          [conversation[0]!.id, childId],
        );
      } catch {
        blocked = true;
      } finally {
        await harness.db.exec('rollback');
      }

      // Withdrawal has to stop an in-flight conversation too, not merely prevent
      // the next one from starting.
      expect(blocked).toBe(true);
    });
  });
});
