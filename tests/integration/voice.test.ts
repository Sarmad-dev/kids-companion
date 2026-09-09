import { createMockSttProvider, createMockTtsProvider, silentWav } from '@kids/voice';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  authHeader,
  createApiHarness,
  queryAsParent,
  registerAndLogin,
  type ApiHarness,
  type RegisteredParent,
} from '../helpers/api.js';

/**
 * The voice API, end to end.
 *
 *   POST /api/voice/turns
 *   GET  /api/voice/audio/:key
 *
 * Real routes, real multipart parsing, real Zod serialisation, real SQL, real
 * RLS. The providers are mocks — a test that needs a live speech vendor to prove
 * a child cannot reach another child's recording is a test that will not run.
 */

/** A multipart body, built by hand so the boundary and headers are exactly what a device sends. */
const multipart = (
  fields: Record<string, string>,
  file?: { field: string; filename: string; contentType: string; bytes: Uint8Array },
): { payload: Buffer; headers: Record<string, string> } => {
  const boundary = '----kidsCompanionTestBoundary7f3a';
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

/** A WAV whose bytes contain a marker the mock STT turns into a known transcript. */
const wavSaying = (marker: string, durationMs = 2_000): Uint8Array => {
  const audio = silentWav(durationMs);
  Buffer.from(audio.buffer, audio.byteOffset, audio.length).write(marker, 44, 'latin1');
  return audio;
};

const POLICY = { policyVersion: '2026-08-01', policyText: 'We process speech to reply.' };

describe('the voice API', () => {
  let harness: ApiHarness;
  let alice: RegisteredParent;
  let bob: RegisteredParent;
  let aliceChildId: string;
  let aliceConversationId: string;
  let bobConversationId: string;

  const createChild = async (parent: RegisteredParent, displayName = 'Rumi') =>
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

  const subscribe = async (parentId: string) => {
    await harness.db.query(
      `insert into subscriptions (parent_id, plan_id, rail, status, current_period_start, current_period_end)
       select $1, id, 'mock', 'active', now(), now() + interval '30 days'
         from subscription_plans where code = 'family_monthly'`,
      [parentId],
    );
  };

  const startConversation = async (parent: RegisteredParent, childId: string) => {
    await harness.db.query(
      `update conversations set status = 'ended', ended_at = now(),
              end_reason = coalesce(end_reason, 'parent_ended')
        where child_id = $1 and status = 'active'`,
      [childId],
    );
    return (
      await harness.app.inject({
        method: 'POST',
        url: '/api/conversations/start',
        headers: authHeader(parent.accessToken),
        payload: { childId },
      })
    ).json<{ id: string }>().id;
  };

  const speak = async (
    parent: RegisteredParent,
    conversationId: string,
    audio: Uint8Array,
    contentType = 'audio/wav',
    filename = 'turn.wav',
  ) => {
    const body = multipart(
      { conversationId },
      { field: 'audio', filename, contentType, bytes: audio },
    );
    return await harness.app.inject({
      method: 'POST',
      url: '/api/voice/turns',
      headers: { ...authHeader(parent.accessToken), ...body.headers },
      payload: body.payload,
    });
  };

  beforeAll(async () => {
    harness = await createApiHarness();
    alice = await registerAndLogin(harness, 'voice-alice');
    bob = await registerAndLogin(harness, 'voice-bob');
    aliceChildId = await createChild(alice);
    const bobChildId = await createChild(bob, 'Sana');
    await consent(alice, aliceChildId);
    await consent(bob, bobChildId);
    // A paid plan so the voice quota is not the reason an unrelated test fails;
    // the quota itself is exercised directly below.
    await subscribe(alice.parentId);
    await subscribe(bob.parentId);
    aliceConversationId = await startConversation(alice, aliceChildId);
    bobConversationId = await startConversation(bob, bobChildId);
  });

  beforeEach(async () => {
    // A fresh session per test. `startConversation` closes whatever is open,
    // so a test that starts its own would otherwise leave the shared one ended
    // and every later test would fail on "has already ended".
    aliceConversationId = await startConversation(alice, aliceChildId);
  });

  afterAll(async () => {
    await harness.close();
  });

  /* ====================================================================== */
  /* Valid audio                                                            */
  /* ====================================================================== */

  describe('valid audio', () => {
    it('transcribes, answers, and returns playable audio', async () => {
      const response = await speak(alice, aliceConversationId, silentWav(2_000));

      expect(response.statusCode).toBe(200);
      const body = response.json<{
        status: string;
        transcript: string;
        reply: string;
        audio: { key: string; mimeType: string; expiresAt: string };
      }>();
      expect(body.status).toBe('ok');
      expect(body.transcript).toContain('butterfly');
      expect(body.reply.length).toBeGreaterThan(0);
      expect(body.audio).toMatchObject({ mimeType: expect.any(String) });
      expect(body.audio.key.length).toBeGreaterThanOrEqual(32);
      expect(new Date(body.audio.expiresAt).getTime()).toBeGreaterThan(Date.now());
    });

    it('records the turn as voice, not as text', async () => {
      const conversationId = await startConversation(alice, aliceChildId);
      await speak(alice, conversationId, silentWav(1_500));

      const { rows } = await harness.db.query<{ input_mode: string; role: string }>(
        'select role, input_mode from messages where conversation_id = $1 order by sequence',
        [conversationId],
      );

      expect(rows[0]).toMatchObject({ role: 'child', input_mode: 'voice' });
      // The companion's message is always text; the audio is synthesised from it.
      expect(rows[1]).toMatchObject({ role: 'companion', input_mode: 'text' });
    });

    it('counts voice turns separately from text turns', async () => {
      const childId = await createChild(alice, 'Counted');
      await consent(alice, childId);
      const conversationId = await startConversation(alice, childId);

      await speak(alice, conversationId, silentWav(1_000));

      const { rows } = await harness.db.query<{ voice_turns: number; turns: number }>(
        'select voice_turns, turns from usage_daily where child_id = $1',
        [childId],
      );
      expect(rows[0]!.voice_turns).toBe(1);
    });

    it('never returns a storage credential, bucket, or provider name', async () => {
      const response = await speak(alice, aliceConversationId, silentWav(1_000));

      /**
       * ═══════════════════════════════════════════════════════════════════
       * THE AUDIO KEY IS EXCLUDED, AND NOT BECAUSE IT IS INCONVENIENT.
       * ═══════════════════════════════════════════════════════════════════
       *
       * `key` is an opaque handle — 24 random bytes, base64url — and it is
       * SUPPOSED to be in this response. Scanning it for two-character
       * substrings tests the random number generator, not the API.
       *
       * This assertion used to include it, and failed intermittently on a key
       * that happened to contain "s3":
       *
       *   "key":"8ekjchl14c9s3zwtap_1zzmr3lkutqkc"
       *
       * Roughly a one-in-a-hundred chance per run — often enough to make the
       * pipeline untrustworthy, rare enough to be dismissed as "just CI". Found
       * by running the suite from a clean checkout twice.
       *
       * Every other field stays under scrutiny. The key carries nothing to
       * leak; the fields around it are the ones that could.
       */
      const serialised = JSON.stringify(response.json(), (field, value) =>
        field === 'key' ? '<opaque-handle>' : (value as unknown),
      ).toLowerCase();

      for (const forbidden of [
        'http://',
        'https://',
        'bucket',
        'supabase',
        's3',
        'signature',
        'x-amz',
        'deepgram',
        'elevenlabs',
        'api_key',
        'apikey',
        'token',
      ]) {
        expect(serialised, forbidden).not.toContain(forbidden);
      }
    });
  });

  /* ====================================================================== */
  /* Invalid, oversized, unsupported, malicious                             */
  /* ====================================================================== */

  describe('rejected uploads', () => {
    it('rejects a non-audio payload without an error status', async () => {
      const response = await speak(
        alice,
        aliceConversationId,
        new Uint8Array(Buffer.from('<?php system($_GET["c"]); ?>')),
        'audio/wav',
        'shell.php',
      );

      // 200 with a friendly line: a child has just spoken into a microphone, and
      // an error code is not something they can act on.
      expect(response.statusCode).toBe(200);
      expect(response.json().status).toBe('rejected');
      expect(response.json().reply.toLowerCase()).not.toMatch(/error|invalid|failed|format/);
      expect(response.json().audio).toBeNull();
    });

    it.each([
      ['an ELF binary', Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00])],
      ['a ZIP archive', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x00, 0x00])],
      ['an SVG with script', Buffer.from('<svg onload="alert(1)"></svg>')],
      [
        'a WAV header on a script',
        Buffer.concat([Buffer.from('RIFF'), Buffer.from('EVIL<?php ?>')]),
      ],
    ])('rejects %s', async (_label, bytes) => {
      const response = await speak(alice, aliceConversationId, new Uint8Array(bytes));
      expect(response.json().status).toBe('rejected');
    });

    it('rejects a truthful format with a lying content type', async () => {
      // The bytes are a real WAV; the client claims MP3. A client asserting
      // something untrue about its own payload is refused.
      const response = await speak(alice, aliceConversationId, silentWav(1_000), 'audio/mpeg');
      expect(response.json().status).toBe('rejected');
    });

    it('rejects audio past the duration limit', async () => {
      const response = await speak(alice, aliceConversationId, silentWav(60_000));
      expect(response.json().status).toBe('rejected');
    });

    it('cuts off an oversized upload rather than buffering it', async () => {
      const h = await createApiHarness({ env: { VOICE_MAX_UPLOAD_BYTES: '4096' } });
      try {
        const parent = await registerAndLogin(h, 'voice-oversize');
        const childId = (
          await h.app.inject({
            method: 'POST',
            url: '/v1/children',
            headers: authHeader(parent.accessToken),
            payload: {
              displayName: 'Big',
              birthYear: 2019,
              birthMonth: 6,
              languages: [{ languageCode: 'en', isPrimary: true }],
            },
          })
        ).json<{ id: string }>().id;

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

        const conversationId = (
          await h.app.inject({
            method: 'POST',
            url: '/api/conversations/start',
            headers: authHeader(parent.accessToken),
            payload: { childId },
          })
        ).json<{ id: string }>().id;

        const body = multipart(
          { conversationId },
          {
            field: 'audio',
            filename: 'big.wav',
            contentType: 'audio/wav',
            bytes: silentWav(30_000),
          },
        );
        const response = await h.app.inject({
          method: 'POST',
          url: '/api/voice/turns',
          headers: { ...authHeader(parent.accessToken), ...body.headers },
          payload: body.payload,
        });

        // Enforced as the body streams. Measuring after buffering would let an
        // attacker choose how much memory we spend.
        expect(response.statusCode).toBe(400);
      } finally {
        await h.close();
      }
    });

    it('rejects a request with no audio part', async () => {
      const body = multipart({ conversationId: aliceConversationId });
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/voice/turns',
        headers: { ...authHeader(alice.accessToken), ...body.headers },
        payload: body.payload,
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('VALIDATION_FAILED');
    });

    it('rejects a malformed conversation id', async () => {
      const response = await speak(alice, 'not-a-uuid', silentWav(1_000));
      expect(response.statusCode).toBe(400);
    });
  });

  /* ====================================================================== */
  /* Transcription and provider failure                                     */
  /* ====================================================================== */

  describe('provider failure', () => {
    const buildFor = async (label: string, overrides: Parameters<typeof createApiHarness>[0]) => {
      const h = await createApiHarness(overrides);
      const parent = await registerAndLogin(h, label);
      const childId = (
        await h.app.inject({
          method: 'POST',
          url: '/v1/children',
          headers: authHeader(parent.accessToken),
          payload: {
            displayName: 'Rumi',
            birthYear: 2019,
            birthMonth: 6,
            languages: [{ languageCode: 'en', isPrimary: true }],
          },
        })
      ).json<{ id: string }>().id;

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

      const conversationId = (
        await h.app.inject({
          method: 'POST',
          url: '/api/conversations/start',
          headers: authHeader(parent.accessToken),
          payload: { childId },
        })
      ).json<{ id: string }>().id;

      const send = async (audio = silentWav(1_500)) => {
        const body = multipart(
          { conversationId },
          { field: 'audio', filename: 'turn.wav', contentType: 'audio/wav', bytes: audio },
        );
        return await h.app.inject({
          method: 'POST',
          url: '/api/voice/turns',
          headers: { ...authHeader(parent.accessToken), ...body.headers },
          payload: body.payload,
        });
      };

      return { h, parent, childId, conversationId, send };
    };

    it('degrades warmly when transcription fails', async () => {
      const { h, send } = await buildFor('voice-stt-fail', {
        sttProvider: createMockSttProvider({ behaviour: { failWith: 'unavailable' } }),
      });
      try {
        const response = await send();

        expect(response.statusCode).toBe(200);
        expect(response.json().status).toBe('degraded');
        expect(response.json().reply.length).toBeGreaterThan(10);
        expect(response.json().reply.toLowerCase()).not.toMatch(/error|failed|unavailable/);
        expect(response.json().audio).toBeNull();
      } finally {
        await h.close();
      }
    });

    it('degrades warmly when transcription times out', async () => {
      const { h, send } = await buildFor('voice-stt-timeout', {
        sttProvider: createMockSttProvider({ behaviour: { failWith: 'timeout' } }),
      });
      try {
        const response = await send();

        expect(response.statusCode).toBe(200);
        expect(response.json().status).toBe('degraded');
        // A timeout and an outage get different words, because they are
        // different experiences for the child.
        expect(response.json().reply).toMatch(/listening|again/i);
      } finally {
        await h.close();
      }
    });

    it('asks the child to repeat when confidence is low', async () => {
      const { h, send } = await buildFor('voice-lowconf', {
        sttProvider: createMockSttProvider({ behaviour: { confidence: 0.05 } }),
      });
      try {
        const response = await send();

        expect(response.json().status).toBe('unintelligible');
        expect(response.json().transcript).toBeUndefined();
        // Nothing was persisted: there is no message to record.
        expect(response.json().messageId).toBeNull();
      } finally {
        await h.close();
      }
    });

    it('still answers, as text, when synthesis fails', async () => {
      const { h, send } = await buildFor('voice-tts-fail', {
        ttsProvider: createMockTtsProvider({ behaviour: { failWith: 'unavailable' } }),
      });
      try {
        const response = await send();

        expect(response.json().status).toBe('ok');
        // Losing the voice is degraded; losing the answer is broken.
        expect(response.json().reply.length).toBeGreaterThan(0);
        expect(response.json().audio).toBeNull();
      } finally {
        await h.close();
      }
    });

    it('does not leak provider details on failure', async () => {
      const { h, send } = await buildFor('voice-nodetails', {
        sttProvider: createMockSttProvider({ behaviour: { failWith: 'unavailable' } }),
      });
      try {
        const serialised = JSON.stringify((await send()).json()).toLowerCase();
        for (const forbidden of ['deepgram', 'elevenlabs', 'api', 'stack', 'token']) {
          expect(serialised, forbidden).not.toContain(forbidden);
        }
      } finally {
        await h.close();
      }
    });
  });

  /* ====================================================================== */
  /* Safety                                                                 */
  /* ====================================================================== */

  describe('safety', () => {
    it('runs the same safety pipeline a typed message does', async () => {
      const conversationId = await startConversation(alice, aliceChildId);
      const response = await speak(alice, conversationId, wavSaying('__unsafe__'));

      expect(response.json().status).toBe('blocked');
      // Voice is a modality, not a second, weaker path to the model.
      const { rows } = await harness.db.query<{ layer: string; decision: string }>(
        'select layer, decision from content_flags where conversation_id = $1',
        [conversationId],
      );
      expect(rows.length).toBeGreaterThan(0);
    });

    it('escalates a spoken disclosure exactly as a typed one', async () => {
      const conversationId = await startConversation(alice, aliceChildId);
      const response = await speak(alice, conversationId, wavSaying('__disclosure__'));

      expect(response.json().status).toBe('escalated');
      expect(response.json().conversationStatus).toBe('flagged');
      expect(response.json().reply.toLowerCase()).toMatch(/grown-?up|parent|carer|teacher/);
    });
  });

  /* ====================================================================== */
  /* Unauthorised access                                                    */
  /* ====================================================================== */

  describe('authorization', () => {
    it('rejects an unauthenticated upload', async () => {
      const body = multipart(
        { conversationId: aliceConversationId },
        { field: 'audio', filename: 'turn.wav', contentType: 'audio/wav', bytes: silentWav(1_000) },
      );
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/voice/turns',
        headers: body.headers,
        payload: body.payload,
      });

      expect(response.statusCode).toBe(401);
    });

    it("refuses another parent's conversation", async () => {
      const response = await speak(alice, bobConversationId, silentWav(1_000));

      expect(response.statusCode).toBe(404);
      const { rows } = await harness.db.query<{ n: number }>(
        'select count(*)::int as n from messages where conversation_id = $1',
        [bobConversationId],
      );
      expect(rows[0]!.n).toBe(0);
    });

    it('rejects an unauthenticated audio fetch', async () => {
      const key = (await speak(alice, aliceConversationId, silentWav(1_000))).json<{
        audio: { key: string };
      }>().audio.key;

      const response = await harness.app.inject({
        method: 'GET',
        url: `/api/voice/audio/${key}`,
      });
      expect(response.statusCode).toBe(401);
    });

    it("refuses another parent's audio even with the exact key", async () => {
      const key = (await speak(alice, aliceConversationId, silentWav(1_000))).json<{
        audio: { key: string };
      }>().audio.key;

      const response = await harness.app.inject({
        method: 'GET',
        url: `/api/voice/audio/${key}`,
        headers: authHeader(bob.accessToken),
      });

      // The unguessable key is not the authorisation. The ledger read runs under
      // RLS and returns nothing for a family that does not own the artefact.
      expect(response.statusCode).toBe(404);
    });

    it('serves the owning parent their own audio', async () => {
      const key = (await speak(alice, aliceConversationId, silentWav(1_000))).json<{
        audio: { key: string };
      }>().audio.key;

      const response = await harness.app.inject({
        method: 'GET',
        url: `/api/voice/audio/${key}`,
        headers: authHeader(alice.accessToken),
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toMatch(/^audio\//);
      expect(response.headers['cache-control']).toContain('no-store');
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.rawPayload.length).toBeGreaterThan(44);
    });

    it('returns 404 for a key that never existed', async () => {
      const response = await harness.app.inject({
        method: 'GET',
        url: '/api/voice/audio/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        headers: authHeader(alice.accessToken),
      });
      expect(response.statusCode).toBe(404);
    });
  });

  /* ====================================================================== */
  /* Retention and expiry                                                   */
  /* ====================================================================== */

  describe('retention', () => {
    it('keeps no record of the child’s own audio under the default policy', async () => {
      const childId = await createChild(alice, 'Discarded');
      await consent(alice, childId);
      const conversationId = await startConversation(alice, childId);

      await speak(alice, conversationId, silentWav(2_000));

      // The governing decision, asserted through the real API: transcribe and
      // discard (docs/adr/0006).
      const { rows } = await harness.db.query<{ n: number }>(
        `select count(*)::int as n from audio_artifacts
          where child_id = $1 and kind = 'child_upload'`,
        [childId],
      );
      expect(rows[0]!.n).toBe(0);
    });

    it('audits the retention decision on every voice turn', async () => {
      const conversationId = await startConversation(alice, aliceChildId);
      await speak(alice, conversationId, silentWav(1_000));

      const { rows } = await harness.db.query<{ metadata: Record<string, unknown> }>(
        `select metadata from audit_logs
          where action = 'voice.turn.completed'
          order by created_at desc limit 1`,
      );

      // "Were recordings kept?" is answerable from the audit log alone, rather
      // than by trusting that a configuration value was what someone said.
      expect(rows[0]!.metadata).toMatchObject({ uploadRetention: 'transient' });
    });

    it('gives every reply artefact an expiry', async () => {
      const conversationId = await startConversation(alice, aliceChildId);
      await speak(alice, conversationId, silentWav(1_000));

      const { rows } = await harness.db.query<{ expires_at: Date; retention_basis: string }>(
        `select expires_at, retention_basis from audio_artifacts
          where conversation_id = $1 and kind = 'companion_reply'`,
        [conversationId],
      );

      expect(rows[0]!.retention_basis).toBe('synthesis');
      expect(new Date(rows[0]!.expires_at).getTime()).toBeGreaterThan(Date.now());
    });

    it('refuses expired audio and the sweep reclaims it', async () => {
      const conversationId = await startConversation(alice, aliceChildId);
      const key = (await speak(alice, conversationId, silentWav(1_000))).json<{
        audio: { key: string };
      }>().audio.key;

      // Reachable now.
      expect(
        (
          await harness.app.inject({
            method: 'GET',
            url: `/api/voice/audio/${key}`,
            headers: authHeader(alice.accessToken),
          })
        ).statusCode,
      ).toBe(200);

      await harness.db.query(
        `update audio_artifacts set expires_at = now() - interval '1 second'
          where storage_key = $1`,
        [key],
      );

      // Gone the instant it expires, without waiting for a sweep.
      expect(
        (
          await harness.app.inject({
            method: 'GET',
            url: `/api/voice/audio/${key}`,
            headers: authHeader(alice.accessToken),
          })
        ).statusCode,
      ).toBe(404);

      const { rows: swept } = await harness.db.query<{ storage_key: string }>(
        'select * from app.expire_audio_artifacts(100)',
      );
      expect(swept.map((r) => r.storage_key)).toContain(key);

      // And the sweep is idempotent: a second pass finds nothing to do.
      const { rows: again } = await harness.db.query<{ storage_key: string }>(
        'select * from app.expire_audio_artifacts(100)',
      );
      expect(again.map((r) => r.storage_key)).not.toContain(key);
    });

    it('lets a parent read the ledger and not extend it', async () => {
      const conversationId = await startConversation(alice, aliceChildId);
      await speak(alice, conversationId, silentWav(1_000));

      const mine = await queryAsParent(
        harness,
        alice.parentId,
        'select id from audio_artifacts where conversation_id = $1',
        [conversationId],
      );
      expect(mine.length).toBeGreaterThan(0);

      // A retention window a user can lengthen is not a retention window. The
      // grant is SELECT-only, so this is a permission error rather than a
      // filtered no-op — the stronger of the two outcomes.
      await expect(
        queryAsParent(
          harness,
          alice.parentId,
          `update audio_artifacts set expires_at = now() + interval '10 years'
            where conversation_id = $1`,
          [conversationId],
        ),
      ).rejects.toThrow(/permission denied/);
    });

    it("does not show one family the other's ledger", async () => {
      const conversationId = await startConversation(alice, aliceChildId);
      await speak(alice, conversationId, silentWav(1_000));

      const theirs = await queryAsParent(
        harness,
        bob.parentId,
        'select id from audio_artifacts where conversation_id = $1',
        [conversationId],
      );
      expect(theirs).toHaveLength(0);
    });
  });

  /* ====================================================================== */
  /* Limits                                                                 */
  /* ====================================================================== */

  describe('limits', () => {
    it('refuses once the daily voice allowance is spent', async () => {
      const childId = await createChild(alice, 'Spent');
      await consent(alice, childId);
      const conversationId = await startConversation(alice, childId);

      await harness.db.query('select app.record_voice_usage($1, 500)', [childId]);

      const response = await speak(alice, conversationId, silentWav(1_000));

      expect(response.statusCode).toBe(429);
      expect(response.json().error.code).toBe('QUOTA_DAILY_TURNS_EXHAUSTED');
      expect(response.json().error.meta).toMatchObject({ scope: 'voice' });
    });

    it('rate limits per parent', async () => {
      const h = await createApiHarness({ env: { RATE_LIMIT_VOICE_PER_MINUTE: '2' } });
      try {
        const parent = await registerAndLogin(h, 'voice-ratelimit');
        const childId = (
          await h.app.inject({
            method: 'POST',
            url: '/v1/children',
            headers: authHeader(parent.accessToken),
            payload: {
              displayName: 'Rumi',
              birthYear: 2019,
              birthMonth: 6,
              languages: [{ languageCode: 'en', isPrimary: true }],
            },
          })
        ).json<{ id: string }>().id;

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

        const conversationId = (
          await h.app.inject({
            method: 'POST',
            url: '/api/conversations/start',
            headers: authHeader(parent.accessToken),
            payload: { childId },
          })
        ).json<{ id: string }>().id;

        const send = async () => {
          const body = multipart(
            { conversationId },
            {
              field: 'audio',
              filename: 'turn.wav',
              contentType: 'audio/wav',
              bytes: silentWav(800),
            },
          );
          return await h.app.inject({
            method: 'POST',
            url: '/api/voice/turns',
            headers: { ...authHeader(parent.accessToken), ...body.headers },
            payload: body.payload,
          });
        };

        const statuses = [
          (await send()).statusCode,
          (await send()).statusCode,
          (await send()).statusCode,
        ];

        expect(statuses.filter((s) => s === 200)).toHaveLength(2);
        expect(statuses.at(-1)).toBe(429);
      } finally {
        await h.close();
      }
    });
  });
});
