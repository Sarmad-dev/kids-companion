import { fixedClock } from '@kids/shared';
import { beforeEach, describe, expect, it } from 'vitest';

import { createMockSttProvider, createMockTtsProvider, silentWav } from './mock-providers.js';
import { runVoiceTurn, type VoiceResponse, type VoiceTurnOptions } from './pipeline.js';
import type { AudioStorage } from './ports.js';
import { DEFAULT_RETENTION_POLICY } from './retention.js';
import { createMemoryAudioStorage } from './storage.js';
import { DEFAULT_AUDIO_LIMITS } from './validation.js';

/**
 * The voice pipeline, end to end without a network.
 *
 * The two properties that matter most and are asserted repeatedly:
 *
 *   * the child's audio does not survive the turn, and
 *   * nothing here is a second path to the model — the `respond` callback is the
 *     real conversation turn, safety pipeline and all.
 */

const CLOCK = fixedClock(Date.parse('2026-08-18T10:00:00.000Z'));

const okResponse = (reply = 'That sounds lovely!'): VoiceResponse => ({
  reply,
  replyForStorage: reply,
  status: 'ok',
  escalation: false,
});

describe('the voice pipeline', () => {
  let storage: AudioStorage;
  let base: VoiceTurnOptions;

  beforeEach(() => {
    storage = createMemoryAudioStorage({ clock: CLOCK });
    base = {
      stt: createMockSttProvider(),
      tts: createMockTtsProvider(),
      storage,
      clock: CLOCK,
      retention: DEFAULT_RETENTION_POLICY,
      limits: DEFAULT_AUDIO_LIMITS,
    };
  });

  const run = async (
    overrides: Partial<VoiceTurnOptions> = {},
    request: Partial<Parameters<typeof runVoiceTurn>[1]> = {},
    respond: (transcript: string) => Promise<VoiceResponse> = async () =>
      await Promise.resolve(okResponse()),
  ) =>
    await runVoiceTurn(
      { ...base, ...overrides },
      {
        audio: silentWav(2_000),
        declaredMimeType: 'audio/wav',
        ageGroup: 'AGE_6_8',
        languageHints: ['en'],
        voiceId: 'voice-1',
        retentionOptIn: false,
        ...request,
      },
      respond,
    );

  /* ---------------------------------------------------------------------- */
  /* Valid audio                                                            */
  /* ---------------------------------------------------------------------- */

  describe('valid audio', () => {
    it('runs every stage and returns playable reply audio', async () => {
      const outcome = await run();

      expect(outcome.kind).toBe('ok');
      if (outcome.kind !== 'ok') return;

      expect(outcome.stagesCompleted).toEqual([
        'VALIDATE',
        'TRANSCRIBE',
        'SAFETY_AND_RESPONSE',
        'TTS',
        'RETURN',
      ]);
      expect(outcome.transcript).toContain('butterfly');
      expect(outcome.audioKey).toBeTruthy();

      const stored = await storage.get(outcome.audioKey!);
      expect(stored?.meta.kind).toBe('companion_reply');
    });

    it('sends the SNIFFED type to the provider, not the declared one', async () => {
      let seen = '';
      const stt = createMockSttProvider();
      const spying = {
        ...stt,
        transcribe: async (r: Parameters<typeof stt.transcribe>[0]) => {
          seen = r.mimeType;
          return await stt.transcribe(r);
        },
      };

      // A truthful client that happens to use a synonym. The provider must get
      // the canonical type we established from the bytes.
      await run({ stt: spying }, { declaredMimeType: 'audio/x-wav' });

      expect(seen).toBe('audio/wav');
    });

    it('passes the transcript through the caller’s turn, not a second path', async () => {
      let sawTranscript = '';
      await run({}, {}, async (transcript: string) => {
        sawTranscript = transcript;
        return await Promise.resolve(okResponse());
      });

      // Voice must never become a weaker route to the model. The callback IS the
      // conversation turn, safety pipeline included.
      expect(sawTranscript).toContain('butterfly');
    });

    it('carries a safety block straight through', async () => {
      const outcome = await run(
        {},
        {},
        async () =>
          await Promise.resolve({
            reply: "Let's talk about something else!",
            replyForStorage: "Let's talk about something else!",
            status: 'blocked',
            escalation: false,
          }),
      );

      expect(outcome.kind).toBe('ok');
      if (outcome.kind !== 'ok') return;
      // A blocked turn still gets spoken audio — the child hears a warm change
      // of subject rather than silence.
      expect(outcome.response.status).toBe('blocked');
      expect(outcome.audioKey).toBeTruthy();
    });
  });

  /* ---------------------------------------------------------------------- */
  /* Invalid, oversized, and unsupported                                    */
  /* ---------------------------------------------------------------------- */

  describe('rejected uploads', () => {
    it('rejects an unsupported format before anything is sent anywhere', async () => {
      let called = false;
      const stt = {
        ...createMockSttProvider(),
        transcribe: async () => {
          called = true;
          throw new Error('unreachable');
        },
      };

      const outcome = await run({ stt }, { audio: new Uint8Array(Buffer.from('<?php ?>')) });

      expect(outcome.kind).toBe('rejected');
      if (outcome.kind === 'rejected') expect(outcome.reason).toBe('unsupported_format');
      // A rejected upload leaves no trace and reaches no vendor.
      expect(called).toBe(false);
      expect(await storage.sweep()).toBe(0);
    });

    it('rejects audio larger than the ceiling', async () => {
      const outcome = await run(
        { limits: { ...DEFAULT_AUDIO_LIMITS, maxBytes: 1_000 } },
        { audio: silentWav(5_000) },
      );

      expect(outcome.kind).toBe('rejected');
      if (outcome.kind === 'rejected') expect(outcome.reason).toBe('too_large');
    });

    it('rejects audio longer than the duration limit', async () => {
      const outcome = await run(
        { limits: { ...DEFAULT_AUDIO_LIMITS, maxDurationMs: 3_000 } },
        { audio: silentWav(10_000) },
      );

      expect(outcome.kind).toBe('rejected');
      if (outcome.kind === 'rejected') expect(outcome.reason).toBe('too_long');
    });

    it('rejects a declared type that disagrees with the bytes', async () => {
      const outcome = await run({}, { declaredMimeType: 'audio/mpeg' });

      expect(outcome.kind).toBe('rejected');
      if (outcome.kind === 'rejected') expect(outcome.reason).toBe('declared_type_mismatch');
    });

    it('rejects an empty body', async () => {
      const outcome = await run({}, { audio: new Uint8Array(0) });

      expect(outcome.kind).toBe('rejected');
      if (outcome.kind === 'rejected') expect(outcome.reason).toBe('empty');
    });
  });

  /* ---------------------------------------------------------------------- */
  /* Transcription                                                          */
  /* ---------------------------------------------------------------------- */

  describe('transcription', () => {
    it('asks the child to repeat rather than answering a low-confidence transcript', async () => {
      let responded = false;
      const outcome = await run(
        { stt: createMockSttProvider({ behaviour: { confidence: 0.15 } }) },
        {},
        async () => {
          responded = true;
          return await Promise.resolve(okResponse());
        },
      );

      expect(outcome.kind).toBe('unintelligible');
      // The failure this prevents is the worst one available: replying
      // confidently to something the child did not say.
      expect(responded).toBe(false);
    });

    it('treats an empty transcript as unintelligible, not as an empty message', async () => {
      const outcome = await run({
        stt: createMockSttProvider({ behaviour: { transcript: '' } }),
      });

      expect(outcome.kind).toBe('unintelligible');
    });

    it('reports a transcription failure without reaching the model', async () => {
      let responded = false;
      const outcome = await run(
        { stt: createMockSttProvider({ behaviour: { failWith: 'unavailable' } }) },
        {},
        async () => {
          responded = true;
          return await Promise.resolve(okResponse());
        },
      );

      expect(outcome.kind).toBe('provider_failed');
      if (outcome.kind === 'provider_failed') {
        expect(outcome.stage).toBe('TRANSCRIBE');
        expect(outcome.timedOut).toBe(false);
      }
      expect(responded).toBe(false);
    });

    it('distinguishes a timeout from an outage', async () => {
      const outcome = await run({
        stt: createMockSttProvider({ behaviour: { failWith: 'timeout' } }),
      });

      expect(outcome.kind).toBe('provider_failed');
      // The two get different words from the character, and different metrics.
      if (outcome.kind === 'provider_failed') expect(outcome.timedOut).toBe(true);
    });

    it('retries a transient transcription failure within the budget', async () => {
      const outcome = await run({
        stt: createMockSttProvider({ behaviour: { failWith: 'unavailable', failTimes: 1 } }),
        retry: { maxAttempts: 3, budgetMs: 5_000, baseDelayMs: 1, maxDelayMs: 2 },
      });

      expect(outcome.kind).toBe('ok');
    });
  });

  /* ---------------------------------------------------------------------- */
  /* TTS                                                                    */
  /* ---------------------------------------------------------------------- */

  describe('synthesis', () => {
    it('still returns the turn when TTS fails', async () => {
      const outcome = await run({
        tts: createMockTtsProvider({ behaviour: { failWith: 'unavailable' } }),
      });

      expect(outcome.kind).toBe('ok');
      if (outcome.kind !== 'ok') return;

      // Losing the voice is a degraded experience; losing the answer is a broken
      // one. The reply is here, as text, and the client falls back to showing it.
      expect(outcome.response.reply).toBeTruthy();
      expect(outcome.audioKey).toBeUndefined();
      expect(outcome.stagesCompleted).not.toContain('TTS');
    });

    it('gives reply audio a transient expiry, never a retention period', async () => {
      const outcome = await run();

      expect(outcome.kind).toBe('ok');
      if (outcome.kind !== 'ok') return;

      const expected = CLOCK.now() + DEFAULT_RETENTION_POLICY.transientSeconds * 1000;
      expect(outcome.audioExpiresAt?.getTime()).toBe(expected);
    });
  });

  /* ---------------------------------------------------------------------- */
  /* Retention                                                              */
  /* ---------------------------------------------------------------------- */

  describe('retention', () => {
    it('does not store the child’s audio at all under the default policy', async () => {
      const outcome = await run();

      expect(outcome.kind).toBe('ok');
      if (outcome.kind !== 'ok') return;

      // The governing decision, asserted directly: transcribe and discard.
      expect(outcome.uploadRetention).toBe('transient');
      expect(outcome.uploadKey).toBeUndefined();
    });

    it('does not store it even when a parent opted in, if configuration says zero', async () => {
      const outcome = await run({}, { retentionOptIn: true });

      expect(outcome.kind).toBe('ok');
      if (outcome.kind !== 'ok') return;
      // Consent alone is not enough. Both gates must open.
      expect(outcome.uploadKey).toBeUndefined();
    });

    it('does not store it when configuration allows retention but the parent has not opted in', async () => {
      const outcome = await run({ retention: { rawAudioDays: 7, transientSeconds: 300 } });

      expect(outcome.kind).toBe('ok');
      if (outcome.kind !== 'ok') return;
      expect(outcome.uploadRetention).toBe('transient');
      expect(outcome.uploadKey).toBeUndefined();
    });

    it('stores it only when configuration AND the parent both permit', async () => {
      const outcome = await run(
        { retention: { rawAudioDays: 7, transientSeconds: 300 } },
        { retentionOptIn: true },
      );

      expect(outcome.kind).toBe('ok');
      if (outcome.kind !== 'ok') return;

      expect(outcome.uploadRetention).toBe('retained');
      expect(outcome.uploadKey).toBeTruthy();

      const stored = await storage.get(outcome.uploadKey!);
      expect(stored?.meta.expiresAt.getTime()).toBe(CLOCK.now() + 7 * 86_400_000);
    });

    it('stores nothing when the upload is rejected, whatever the policy says', async () => {
      await run(
        { retention: { rawAudioDays: 30, transientSeconds: 300 } },
        { retentionOptIn: true, audio: new Uint8Array(Buffer.from('not audio')) },
      );

      // Nothing reached storage, so there is nothing for the sweep to find.
      expect(await storage.sweep()).toBe(0);
    });
  });
});
