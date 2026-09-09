import { createMockAnalysisProvider, DIAGNOSTIC_VOCABULARY } from '@kids/practice';
import { silentWav } from '@kids/voice';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  authHeader,
  createApiHarness,
  queryAsParent,
  registerAndLogin,
  type ApiHarness,
  type RegisteredParent,
} from '../helpers/api.js';

/**
 * Pronunciation practice, end to end.
 *
 * The scoring arithmetic is covered in `services/practice`. This file covers
 * what only a database can prove: that phoneme detail cannot be recorded without
 * a provider that produced it, that a recording does not survive an attempt, and
 * that one family cannot see another's practice history.
 */

const multipart = (
  fields: Record<string, string>,
  file?: { field: string; filename: string; contentType: string; bytes: Uint8Array },
): { payload: Buffer; headers: Record<string, string> } => {
  const boundary = '----kidsPracticeBoundary4b1c';
  const chunks: Buffer[] = [];

  for (const [name, value] of Object.entries(fields)) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ),
    );
  }
  if (file) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\n` +
          `Content-Type: ${file.contentType}\r\n\r\n`,
      ),
      Buffer.from(file.bytes),
      Buffer.from('\r\n'),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));

  return {
    payload: Buffer.concat(chunks),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
};

const POLICY = { policyVersion: '2026-08-01', policyText: 'We process speech to reply.' };

describe('pronunciation practice', () => {
  let harness: ApiHarness;
  let alice: RegisteredParent;
  let bob: RegisteredParent;
  let aliceChildId: string;

  const createChild = async (
    h: ApiHarness,
    parent: RegisteredParent,
    displayName = 'Rumi',
    birthYear = 2018,
  ) =>
    (
      await h.app.inject({
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

  const consent = async (h: ApiHarness, parent: RegisteredParent, childId: string) => {
    for (const [type, child] of [
      ['terms_of_service', undefined],
      ['privacy_policy', undefined],
      ['child_data_processing', childId],
    ] as const) {
      await h.app.inject({
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

  const startSession = async (
    h: ApiHarness,
    parent: RegisteredParent,
    childId: string,
    exerciseKey = 'phonics.th_sounds',
  ) =>
    await h.app.inject({
      method: 'POST',
      url: '/api/practice/sessions',
      headers: authHeader(parent.accessToken),
      payload: { childId, exerciseKey },
    });

  const attempt = async (
    h: ApiHarness,
    parent: RegisteredParent,
    sessionId: string,
    sequence = 0,
    bytes = silentWav(1_500),
  ) => {
    const body = multipart(
      { sequence: String(sequence) },
      { field: 'audio', filename: 'try.wav', contentType: 'audio/wav', bytes },
    );
    return await h.app.inject({
      method: 'POST',
      url: `/api/practice/sessions/${sessionId}/attempts`,
      headers: { ...authHeader(parent.accessToken), ...body.headers },
      payload: body.payload,
    });
  };

  beforeAll(async () => {
    harness = await createApiHarness();
    alice = await registerAndLogin(harness, 'practice-alice');
    bob = await registerAndLogin(harness, 'practice-bob');
    aliceChildId = await createChild(harness, alice);
    await consent(harness, alice, aliceChildId);
  });

  afterAll(async () => {
    await harness.close();
  });

  /* ====================================================================== */
  /* Content                                                                */
  /* ====================================================================== */

  describe('exercises', () => {
    it('offers word and syllable exercises for the child’s age and language', async () => {
      const response = await harness.app.inject({
        method: 'GET',
        url: `/api/practice/exercises?childId=${aliceChildId}`,
        headers: authHeader(alice.accessToken),
      });

      expect(response.statusCode).toBe(200);
      const items = response.json<{ items: { kind: string; targets: unknown[] }[] }>().items;
      expect(items.length).toBeGreaterThan(0);
      expect(items.map((i) => i.kind)).toContain('word');
      expect(items.map((i) => i.kind)).toContain('syllable');
      expect(items[0]!.targets.length).toBeGreaterThan(0);
    });

    it('narrows content by age group', async () => {
      const toddlerId = await createChild(harness, alice, 'Small', 2022);
      await consent(harness, alice, toddlerId);

      const items = (
        await harness.app.inject({
          method: 'GET',
          url: `/api/practice/exercises?childId=${toddlerId}`,
          headers: authHeader(alice.accessToken),
        })
      ).json<{ items: { exerciseKey: string }[] }>().items;

      // Age narrows what is offered, exactly as it does for characters.
      expect(items.map((i) => i.exerciseKey)).not.toContain('phonics.th_sounds');
    });

    it('never exposes the phonetic transcription to the client', async () => {
      const serialised = JSON.stringify(
        (
          await harness.app.inject({
            method: 'GET',
            url: `/api/practice/exercises?childId=${aliceChildId}`,
            headers: authHeader(alice.accessToken),
          })
        ).json(),
      );

      // It is scoring input. Showing IPA to a seven-year-old helps nobody.
      expect(serialised).not.toContain('expectedIpa');
      expect(serialised).not.toContain('θ');
    });

    it("refuses another parent's child", async () => {
      const response = await harness.app.inject({
        method: 'GET',
        url: `/api/practice/exercises?childId=${aliceChildId}`,
        headers: authHeader(bob.accessToken),
      });
      expect(response.statusCode).toBe(404);
    });
  });

  /* ====================================================================== */
  /* Attempts and scoring                                                   */
  /* ====================================================================== */

  describe('attempts', () => {
    it('records everything a result is required to record', async () => {
      const sessionId = (await startSession(harness, alice, aliceChildId)).json<{ id: string }>()
        .id;
      const response = await attempt(harness, alice, sessionId);

      expect(response.statusCode).toBe(200);

      const { rows } = await harness.db.query<{
        child_id: string;
        exercise_key: string;
        created_at: Date;
        language_code: string;
        target_text: string;
        overall_score: number;
        confidence: number;
        provider: string;
        provider_model: string;
        analysis_method: string;
      }>(
        `select child_id, exercise_key, created_at, language_code, target_text,
                overall_score, confidence, provider, provider_model, analysis_method
           from pronunciation_results where speech_practice_id = $1`,
        [sessionId],
      );

      // Child, exercise, timestamp, language, target word, score, confidence,
      // and provider metadata — every one of them, on every result.
      expect(rows[0]).toMatchObject({
        child_id: aliceChildId,
        exercise_key: 'phonics.th_sounds',
        language_code: 'en',
        target_text: 'thumb',
        analysis_method: 'transcript_similarity',
        provider: 'mock',
      });
      expect(rows[0]!.created_at).toBeTruthy();
      expect(rows[0]!.overall_score).toBeGreaterThan(0);
      expect(rows[0]!.provider_model).toBeTruthy();
    });

    it('returns encouraging feedback and the disclaimer', async () => {
      const sessionId = (await startSession(harness, alice, aliceChildId)).json<{ id: string }>()
        .id;
      const body = (await attempt(harness, alice, sessionId)).json<{
        feedback: { message: string; band: string };
        disclaimer: string;
      }>();

      expect(body.feedback.message.length).toBeGreaterThan(3);
      // Travels with every score. A parent reading numbers about their child's
      // speech will draw conclusions; this says which are not available.
      expect(body.disclaimer.toLowerCase()).toContain('not a speech assessment');

      for (const forbidden of DIAGNOSTIC_VOCABULARY) {
        expect(body.feedback.message.toLowerCase(), forbidden).not.toContain(forbidden);
      }
    });

    it('never returns what the recogniser heard', async () => {
      const h = await createApiHarness({
        analysisProvider: createMockAnalysisProvider({
          behaviour: { transcript: 'pineapple submarine trombone' },
        }),
      });
      try {
        const parent = await registerAndLogin(h, 'practice-notranscript');
        const childId = await createChild(h, parent);
        await consent(h, parent, childId);
        const sessionId = (await startSession(h, parent, childId)).json<{ id: string }>().id;

        const serialised = JSON.stringify((await attempt(h, parent, sessionId)).json());

        // The product has no reason to show a recognition of a child's speech
        // back to anyone. (`transcript_similarity` names the METHOD, which is
        // why the assertion is on the recognised words rather than the word
        // "transcript".)
        expect(serialised).not.toContain('pineapple');
        expect(serialised).not.toContain('submarine');
        expect(serialised).not.toMatch(/"transcript"\s*:/);
      } finally {
        await h.close();
      }
    });

    it('increments the attempt number on a retry', async () => {
      const sessionId = (await startSession(harness, alice, aliceChildId)).json<{ id: string }>()
        .id;

      expect(
        (await attempt(harness, alice, sessionId)).json<{ attemptNumber: number }>().attemptNumber,
      ).toBe(1);
      expect(
        (await attempt(harness, alice, sessionId)).json<{ attemptNumber: number }>().attemptNumber,
      ).toBe(2);
    });

    it('rolls the session average up', async () => {
      const sessionId = (await startSession(harness, alice, aliceChildId)).json<{ id: string }>()
        .id;
      await attempt(harness, alice, sessionId, 0);
      await attempt(harness, alice, sessionId, 1);

      const { rows } = await harness.db.query<{ attempt_count: number; average_score: number }>(
        'select attempt_count, average_score from speech_practice where id = $1',
        [sessionId],
      );
      expect(rows[0]!.attempt_count).toBe(2);
      expect(rows[0]!.average_score).toBeGreaterThan(0);
    });

    it('rejects a sequence that is not in the exercise', async () => {
      const sessionId = (await startSession(harness, alice, aliceChildId)).json<{ id: string }>()
        .id;
      expect((await attempt(harness, alice, sessionId, 99)).statusCode).toBe(400);
    });

    it('rejects a non-audio upload', async () => {
      const sessionId = (await startSession(harness, alice, aliceChildId)).json<{ id: string }>()
        .id;
      const response = await attempt(
        harness,
        alice,
        sessionId,
        0,
        new Uint8Array(Buffer.from('<?php system($_GET["c"]); ?>')),
      );
      expect(response.statusCode).toBe(400);
    });

    it('rejects an unauthenticated attempt', async () => {
      const sessionId = (await startSession(harness, alice, aliceChildId)).json<{ id: string }>()
        .id;
      const body = multipart(
        { sequence: '0' },
        { field: 'audio', filename: 'try.wav', contentType: 'audio/wav', bytes: silentWav(800) },
      );
      const response = await harness.app.inject({
        method: 'POST',
        url: `/api/practice/sessions/${sessionId}/attempts`,
        headers: body.headers,
        payload: body.payload,
      });
      expect(response.statusCode).toBe(401);
    });

    it("refuses another parent's session", async () => {
      const sessionId = (await startSession(harness, alice, aliceChildId)).json<{ id: string }>()
        .id;
      expect((await attempt(harness, bob, sessionId)).statusCode).toBe(404);
    });

    it('refuses a session that has finished', async () => {
      const sessionId = (await startSession(harness, alice, aliceChildId)).json<{ id: string }>()
        .id;
      await harness.app.inject({
        method: 'POST',
        url: `/api/practice/sessions/${sessionId}/complete`,
        headers: authHeader(alice.accessToken),
        payload: {},
      });

      expect((await attempt(harness, alice, sessionId)).statusCode).toBe(400);
    });
  });

  /* ====================================================================== */
  /* Phoneme honesty — the constraint that matters most                     */
  /* ====================================================================== */

  describe('phoneme data', () => {
    it('records none when the provider produced none', async () => {
      const sessionId = (await startSession(harness, alice, aliceChildId)).json<{ id: string }>()
        .id;
      const body = (await attempt(harness, alice, sessionId)).json<{
        phonemeDataAvailable: boolean;
        method: string;
      }>();

      expect(body.phonemeDataAvailable).toBe(false);
      expect(body.method).toBe('transcript_similarity');

      const { rows } = await harness.db.query<{ phoneme_scores: unknown }>(
        'select phoneme_scores from pronunciation_results where speech_practice_id = $1',
        [sessionId],
      );
      expect(rows[0]!.phoneme_scores).toEqual({});
    });

    it('records phoneme detail when a provider genuinely produced it', async () => {
      const h = await createApiHarness({
        analysisProvider: createMockAnalysisProvider({
          behaviour: { withPhonemes: true, phonemeScores: { θ: 0.3, ʌ: 0.9, m: 0.8 } },
        }),
      });
      try {
        const parent = await registerAndLogin(h, 'practice-phoneme');
        const childId = await createChild(h, parent);
        await consent(h, parent, childId);
        const sessionId = (await startSession(h, parent, childId)).json<{ id: string }>().id;

        const body = (await attempt(h, parent, sessionId)).json<{
          phonemeDataAvailable: boolean;
          method: string;
          feedback: { focus?: string };
        }>();

        expect(body.phonemeDataAvailable).toBe(true);
        expect(body.method).toBe('phoneme_alignment');
        // Specific feedback is available ONLY here.
        expect(body.feedback.focus).toContain('θ');

        const { rows } = await h.db.query<{ phoneme_scores: Record<string, number> }>(
          'select phoneme_scores from pronunciation_results where speech_practice_id = $1',
          [sessionId],
        );
        expect(rows[0]!.phoneme_scores['θ']).toBeCloseTo(0.3, 5);
      } finally {
        await h.close();
      }
    });

    it('the database refuses phoneme detail that no provider produced', async () => {
      // The last line of defence. A well-meaning change that back-fills
      // plausible-looking phoneme scores from a transcript would otherwise be
      // invisible — and a child would be told their /r/ needs work on the basis
      // of a number somebody made up.
      const sessionId = (await startSession(harness, alice, aliceChildId)).json<{ id: string }>()
        .id;
      await attempt(harness, alice, sessionId);

      await expect(
        harness.db.query(
          `update pronunciation_results
              set phoneme_scores = '{"r": 0.2}'::jsonb
            where speech_practice_id = $1`,
          [sessionId],
        ),
      ).rejects.toThrow(/ck_pr_phonemes_need_provider_data/);
    });

    it('the database refuses a method that disagrees with the evidence', async () => {
      const sessionId = (await startSession(harness, alice, aliceChildId)).json<{ id: string }>()
        .id;
      await attempt(harness, alice, sessionId);

      await expect(
        harness.db.query(
          `update pronunciation_results set analysis_method = 'phoneme_alignment'
            where speech_practice_id = $1`,
          [sessionId],
        ),
      ).rejects.toThrow(/ck_pr_method_matches_availability/);
    });
  });

  /* ====================================================================== */
  /* No recordings                                                          */
  /* ====================================================================== */

  describe('retention', () => {
    it('keeps the score and discards the recording', async () => {
      const sessionId = (await startSession(harness, alice, aliceChildId)).json<{ id: string }>()
        .id;
      await attempt(harness, alice, sessionId);

      // Practice is the feature that would accumulate a corpus of children
      // repeating target phrases. It does not (ADR-0006).
      const { rows } = await harness.db.query<{ n: number }>(
        'select count(*)::int as n from audio_artifacts where child_id = $1',
        [aliceChildId],
      );
      expect(rows[0]!.n).toBe(0);

      const { rows: scored } = await harness.db.query<{ n: number }>(
        'select count(*)::int as n from pronunciation_results where speech_practice_id = $1',
        [sessionId],
      );
      expect(scored[0]!.n).toBe(1);
    });

    it('has nowhere in the results table to put audio', async () => {
      const { rows } = await harness.db.query<{ column_name: string; data_type: string }>(
        `select column_name, data_type from information_schema.columns
          where table_name in ('pronunciation_results', 'speech_practice')`,
      );

      for (const row of rows) {
        expect(row.data_type, row.column_name).not.toBe('bytea');
        expect(row.column_name).not.toMatch(/audio|recording|waveform/);
      }
    });
  });

  /* ====================================================================== */
  /* Provider failure                                                       */
  /* ====================================================================== */

  describe('analysis failure', () => {
    it('invites another go rather than scoring the child down', async () => {
      const h = await createApiHarness({
        analysisProvider: createMockAnalysisProvider({ behaviour: { failWith: 'unavailable' } }),
      });
      try {
        const parent = await registerAndLogin(h, 'practice-fail');
        const childId = await createChild(h, parent);
        await consent(h, parent, childId);
        const sessionId = (await startSession(h, parent, childId)).json<{ id: string }>().id;

        const response = await attempt(h, parent, sessionId);
        expect(response.statusCode).toBe(200);
        const body = response.json<{ id: string | null; feedback: { tryAgain: boolean } }>();

        // A recogniser outage must not read as "your child said it wrong", so no
        // result is recorded at all.
        expect(body.id).toBeNull();
        expect(body.feedback.tryAgain).toBe(true);

        const { rows } = await h.db.query<{ n: number }>(
          'select count(*)::int as n from pronunciation_results where speech_practice_id = $1',
          [sessionId],
        );
        expect(rows[0]!.n).toBe(0);
      } finally {
        await h.close();
      }
    });

    it('does the same on a timeout', async () => {
      const h = await createApiHarness({
        analysisProvider: createMockAnalysisProvider({ behaviour: { failWith: 'timeout' } }),
      });
      try {
        const parent = await registerAndLogin(h, 'practice-timeout');
        const childId = await createChild(h, parent);
        await consent(h, parent, childId);
        const sessionId = (await startSession(h, parent, childId)).json<{ id: string }>().id;

        expect((await attempt(h, parent, sessionId)).json<{ id: string | null }>().id).toBeNull();
      } finally {
        await h.close();
      }
    });
  });

  /* ====================================================================== */
  /* Progress and achievements                                              */
  /* ====================================================================== */

  describe('progress', () => {
    it('records exposure against the skill', async () => {
      const childId = await createChild(harness, alice, 'Progressing');
      await consent(harness, alice, childId);
      const sessionId = (await startSession(harness, alice, childId)).json<{ id: string }>().id;

      await attempt(harness, alice, sessionId, 0);
      await attempt(harness, alice, sessionId, 1);

      const { rows } = await harness.db.query<{ skill_key: string; exposure_count: number }>(
        'select skill_key, exposure_count from learning_progress where child_id = $1',
        [childId],
      );
      expect(rows[0]).toMatchObject({ skill_key: 'phonics.th', exposure_count: 2 });
    });

    it('never returns success_count to a parent', async () => {
      const sessionId = (await startSession(harness, alice, aliceChildId)).json<{ id: string }>()
        .id;
      await attempt(harness, alice, sessionId);

      const serialised = JSON.stringify(
        (
          await harness.app.inject({
            method: 'GET',
            url: `/api/practice/progress?childId=${aliceChildId}`,
            headers: authHeader(alice.accessToken),
          })
        ).json(),
      );

      // The schema comment forbids presenting it as an educational score. The
      // surest way to honour that is not to send it (Q-12).
      expect(serialised).not.toContain('successCount');
      expect(serialised).not.toContain('success_count');
    });

    it('returns history, skills, achievements, and the disclaimer', async () => {
      const response = await harness.app.inject({
        method: 'GET',
        url: `/api/practice/progress?childId=${aliceChildId}`,
        headers: authHeader(alice.accessToken),
      });

      expect(response.statusCode).toBe(200);
      const body = response.json<{
        sessions: unknown[];
        skills: unknown[];
        achievements: { key: string }[];
        disclaimer: string;
      }>();

      expect(body.sessions.length).toBeGreaterThan(0);
      expect(body.skills.length).toBeGreaterThan(0);
      expect(body.achievements.map((a) => a.key)).toContain('first_try');
      expect(body.disclaimer.length).toBeGreaterThan(20);
    });

    it('awards an achievement once and only once', async () => {
      const childId = await createChild(harness, alice, 'Awarded');
      await consent(harness, alice, childId);
      const sessionId = (await startSession(harness, alice, childId)).json<{ id: string }>().id;

      const first = (await attempt(harness, alice, sessionId, 0)).json<{
        newAchievements: { key: string }[];
      }>();
      expect(first.newAchievements.map((a) => a.key)).toContain('first_try');

      const second = (await attempt(harness, alice, sessionId, 1)).json<{
        newAchievements: { key: string }[];
      }>();
      // A child seeing the same celebration twice learns it means nothing.
      expect(second.newAchievements.map((a) => a.key)).not.toContain('first_try');
    });

    it("does not show one family the other's practice", async () => {
      const response = await harness.app.inject({
        method: 'GET',
        url: `/api/practice/progress?childId=${aliceChildId}`,
        headers: authHeader(bob.accessToken),
      });
      expect(response.statusCode).toBe(404);

      const rows = await queryAsParent(
        harness,
        bob.parentId,
        'select id from pronunciation_results where child_id = $1',
        [aliceChildId],
      );
      expect(rows).toHaveLength(0);
    });

    it('lets a parent read their own child’s results and write none of them', async () => {
      const mine = await queryAsParent(
        harness,
        alice.parentId,
        'select id from pronunciation_results where child_id = $1',
        [aliceChildId],
      );
      expect(mine.length).toBeGreaterThan(0);

      await expect(
        queryAsParent(
          harness,
          alice.parentId,
          'update pronunciation_results set overall_score = 1 where child_id = $1',
          [aliceChildId],
        ),
      ).rejects.toThrow();
    });
  });
});
