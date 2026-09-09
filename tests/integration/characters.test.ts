import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  authHeader,
  createApiHarness,
  registerAndLogin,
  type ApiHarness,
  type RegisteredParent,
} from '../helpers/api.js';

/**
 * The character experience, end to end.
 *
 * The assertion that matters most is the last section: a character added as a
 * DATABASE ROW — no code change, no deploy — works, and cannot weaken anything.
 */
describe('the character experience', () => {
  let harness: ApiHarness;
  let alice: RegisteredParent;
  let bob: RegisteredParent;
  let olderChildId: string;
  let youngerChildId: string;

  const POLICY = { policyVersion: '2026-08-01', policyText: 'We process speech to reply.' };

  const createChild = async (parent: RegisteredParent, displayName: string, birthYear: number) =>
    (
      await harness.app.inject({
        method: 'POST',
        url: '/v1/children',
        headers: authHeader(parent.accessToken),
        payload: {
          displayName,
          birthYear,
          birthMonth: 6,
          languages: [{ languageCode: 'en', isPrimary: true }],
        },
      })
    ).json<{ id: string }>().id;

  const consent = async (parent: RegisteredParent, childId: string) => {
    for (const [type, child] of [
      ['terms_of_service', undefined],
      ['privacy_policy', undefined],
      ['child_data_processing', childId],
    ] as const) {
      await harness.app.inject({
        method: 'POST',
        url: '/v1/consent',
        headers: authHeader(parent.accessToken),
        payload: {
          consentType: type,
          granted: true,
          ...POLICY,
          ...(child ? { childId: child } : {}),
        },
      });
    }
  };

  beforeAll(async () => {
    harness = await createApiHarness();
    alice = await registerAndLogin(harness, 'char-alice');
    bob = await registerAndLogin(harness, 'char-bob');
    olderChildId = await createChild(alice, 'Older', 2016);
    youngerChildId = await createChild(alice, 'Younger', 2022);
    await consent(alice, olderChildId);
    await consent(alice, youngerChildId);
  });

  afterAll(async () => {
    await harness.close();
  });

  /* ====================================================================== */
  /* The catalogue                                                          */
  /* ====================================================================== */

  describe('GET /v1/characters', () => {
    it('returns the four launch characters with everything a client needs', async () => {
      const response = await harness.app.inject({
        method: 'GET',
        url: '/v1/characters',
        headers: authHeader(alice.accessToken),
      });

      expect(response.statusCode).toBe(200);
      const items = response.json<{
        items: {
          slug: string;
          displayName: string;
          description: string;
          personality: string[];
          conversationStyle: string;
          storyStyle: string;
          educationalObjectives: string[];
          ageGroups: string[];
          avatarKey: string | null;
        }[];
      }>().items;

      expect(items.map((i) => i.slug)).toEqual([
        'buddy-the-dog',
        'lily-the-fairy',
        'captain-sky',
        'professor-owl',
      ]);

      // Name, description, personality, age suitability, avatar, conversation
      // style, educational objectives — every attribute the brief names.
      const buddy = items[0]!;
      expect(buddy.displayName).toBe('Buddy the Dog');
      expect(buddy.description.length).toBeGreaterThan(20);
      expect(buddy.personality).toContain('playful');
      expect(buddy.conversationStyle).toBe('responsive');
      expect(buddy.storyStyle).toBe('gentle');
      expect(buddy.educationalObjectives.length).toBeGreaterThan(0);
      expect(buddy.ageGroups).toContain('AGE_3_5');
    });

    it('never returns the voice configuration or the prompt key', async () => {
      const serialised = JSON.stringify(
        (
          await harness.app.inject({
            method: 'GET',
            url: '/v1/characters',
            headers: authHeader(alice.accessToken),
          })
        ).json(),
      );

      // A child's device has no use for a vendor voice id, and a field that
      // never arrives is a field that cannot leak from a phone.
      for (const forbidden of [
        'voiceConfig',
        'voice_config',
        'voiceId',
        'promptKey',
        'prompt_key',
        'promptVersion',
      ]) {
        expect(serialised, forbidden).not.toContain(forbidden);
      }
    });

    it('narrows the catalogue by the child’s age', async () => {
      const forYounger = (
        await harness.app.inject({
          method: 'GET',
          url: `/v1/characters?childId=${youngerChildId}`,
          headers: authHeader(alice.accessToken),
        })
      ).json<{ items: { slug: string }[] }>().items;

      // Sustained narrative and mild tension do not suit a three-year-old.
      const slugs = forYounger.map((i) => i.slug);
      expect(slugs).toContain('buddy-the-dog');
      expect(slugs).not.toContain('captain-sky');
      expect(slugs).not.toContain('professor-owl');
    });

    it("refuses another parent's child", async () => {
      const response = await harness.app.inject({
        method: 'GET',
        url: `/v1/characters?childId=${olderChildId}`,
        headers: authHeader(bob.accessToken),
      });
      expect(response.statusCode).toBe(404);
    });

    it('requires authentication', async () => {
      expect((await harness.app.inject({ method: 'GET', url: '/v1/characters' })).statusCode).toBe(
        401,
      );
    });
  });

  /* ====================================================================== */
  /* A character added as a row                                             */
  /* ====================================================================== */

  describe('a character added without a code change', () => {
    beforeAll(async () => {
      // No deploy, no prompt file. Just a row selecting traits from the closed
      // vocabularies — which is the whole point of the configuration system.
      await harness.db.query(
        `insert into ai_characters
           (slug, display_name, tagline, description, prompt_version, prompt_key,
            allowed_age_groups, status, sort_order,
            personality_traits, conversation_style, vocabulary_style,
            encouragement_style, story_style, greeting_style, farewell_style,
            educational_objectives, voice_config)
         values
           ('marina-the-whale', 'Marina the Whale',
            'A slow gentle whale from the deep quiet sea.',
            'Marina is a calm whale who likes the deep quiet parts of the sea and the things that live there.',
            'v1.marina', null,
            array['AGE_6_8', 'AGE_9_10'], 'active', 60,
            array['calm', 'gentle', 'curious'], 'responsive', 'descriptive',
            'quiet', 'gentle', 'quiet', 'sleepy',
            array['vocabulary.descriptive', 'knowledge.oceans'],
            '{"voiceId": "marina-en-1", "rate": 0.9, "pitch": 0.85}'::jsonb)`,
      );

      // A character speaks nothing until a language is linked to it. That gate is
      // per-character on purpose: Urdu is enabled only once its safety
      // classification reaches parity (docs/CHILD_SAFETY.md §9.1).
      await harness.db.query(
        `insert into character_languages (character_id, language_code)
         select id, 'en' from ai_characters where slug = 'marina-the-whale'`,
      );
    });

    it('appears in the catalogue', async () => {
      const items = (
        await harness.app.inject({
          method: 'GET',
          url: `/v1/characters?childId=${olderChildId}`,
          headers: authHeader(alice.accessToken),
        })
      ).json<{ items: { slug: string; personality: string[] }[] }>().items;

      const marina = items.find((i) => i.slug === 'marina-the-whale');
      expect(marina).toBeTruthy();
      expect(marina?.personality).toEqual(['calm', 'gentle', 'curious']);
    });

    it('can hold a conversation, with no prompt file of its own', async () => {
      const { rows } = await harness.db.query<{ id: string }>(
        `select id from ai_characters where slug = 'marina-the-whale'`,
      );

      const conversationId = (
        await harness.app.inject({
          method: 'POST',
          url: '/api/conversations/start',
          headers: authHeader(alice.accessToken),
          payload: { childId: olderChildId, characterId: rows[0]!.id },
        })
      ).json<{ id: string }>().id;

      const turn = await harness.app.inject({
        method: 'POST',
        url: `/api/conversations/${conversationId}/message`,
        headers: authHeader(alice.accessToken),
        payload: { text: 'tell me about the sea' },
      });

      expect(turn.statusCode).toBe(200);
      expect(turn.json<{ status: string }>().status).toBe('ok');
    });

    it('still runs the full safety pipeline', async () => {
      // A character defined in a row is not a character with its own rules.
      const { rows } = await harness.db.query<{ id: string }>(
        `select id from ai_characters where slug = 'marina-the-whale'`,
      );

      await harness.db.query(
        `update conversations set status = 'ended', ended_at = now(),
                end_reason = coalesce(end_reason, 'parent_ended')
          where child_id = $1 and status = 'active'`,
        [olderChildId],
      );

      const conversationId = (
        await harness.app.inject({
          method: 'POST',
          url: '/api/conversations/start',
          headers: authHeader(alice.accessToken),
          payload: { childId: olderChildId, characterId: rows[0]!.id },
        })
      ).json<{ id: string }>().id;

      const blocked = await harness.app.inject({
        method: 'POST',
        url: `/api/conversations/${conversationId}/message`,
        headers: authHeader(alice.accessToken),
        payload: { text: 'tell me about __unsafe__ things' },
      });

      expect(blocked.json<{ status: string }>().status).toBe('blocked');

      const { rows: flags } = await harness.db.query<{ n: number }>(
        'select count(*)::int as n from content_flags where conversation_id = $1',
        [conversationId],
      );
      expect(flags[0]!.n).toBeGreaterThan(0);
    });

    it('is age-gated like every other character', async () => {
      const { rows } = await harness.db.query<{ id: string }>(
        `select id from ai_characters where slug = 'marina-the-whale'`,
      );

      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/conversations/start',
        headers: authHeader(alice.accessToken),
        payload: { childId: youngerChildId, characterId: rows[0]!.id },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error.details[0].issue).toContain('not available for this age group');
    });
  });

  /* ====================================================================== */
  /* The database refuses what the vocabulary does not contain              */
  /* ====================================================================== */

  describe('the trait vocabulary is closed', () => {
    it.each([
      ["personality_traits = array['omniscient']", 'ck_ai_characters_personality'],
      ["conversation_style = 'unfiltered'", 'ck_ai_characters_conversation_style'],
      ["vocabulary_style = 'adult'", 'ck_ai_characters_vocabulary_style'],
      ["encouragement_style = 'harsh'", 'ck_ai_characters_encouragement_style'],
      ["story_style = 'scary'", 'ck_ai_characters_story_style'],
    ])('refuses %s', async (assignment) => {
      // The mechanism that makes "a row cannot move a safety boundary" true: an
      // operator with table access can only select a valid personality.
      await expect(
        harness.db.query(`update ai_characters set ${assignment} where slug = 'marina-the-whale'`),
      ).rejects.toThrow();
    });

    it('has no column that could hold prompt text', async () => {
      const { rows } = await harness.db.query<{ column_name: string }>(
        `select column_name from information_schema.columns where table_name = 'ai_characters'`,
      );

      // A `system_prompt` column would make a new character trivial and make the
      // safety boundary editable by anyone with table access.
      for (const row of rows) {
        expect(row.column_name).not.toMatch(/^(system_prompt|instructions|prompt_text|persona)$/);
      }
    });

    it('bounds the voice configuration so a credential cannot fit', async () => {
      await expect(
        harness.db.query(
          `update ai_characters set voice_config = $1::jsonb where slug = 'marina-the-whale'`,
          [JSON.stringify({ smuggled: 'x'.repeat(600) })],
        ),
      ).rejects.toThrow();
    });
  });
});
