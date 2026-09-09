import { describe, expect, it } from 'vitest';

import { resolveVoiceProviders } from './provider-selection.js';

/**
 * Which adapter each environment produces.
 *
 * The single-vendor cases are the point of the feature; the missing-credential
 * cases are the trap it introduced. Both are pinned here.
 */
describe('resolving voice providers from the environment', () => {
  describe('one vendor for both halves of the loop', () => {
    it('serves both from Deepgram', () => {
      const { stt, tts, fellBackToMock } = resolveVoiceProviders({
        sttProvider: 'deepgram',
        ttsProvider: 'deepgram',
        deepgramApiKey: 'dg-test',
      });

      expect(stt.name).toBe('deepgram');
      expect(tts.name).toBe('deepgram');
      expect(fellBackToMock).toEqual([]);
    });

    it('serves both from ElevenLabs', () => {
      const { stt, tts, fellBackToMock } = resolveVoiceProviders({
        sttProvider: 'elevenlabs',
        ttsProvider: 'elevenlabs',
        elevenLabsApiKey: 'xi-test',
      });

      expect(stt.name).toBe('elevenlabs');
      expect(tts.name).toBe('elevenlabs');
      expect(fellBackToMock).toEqual([]);
    });
  });

  describe('a vendor per capability', () => {
    it('keeps the original split working', () => {
      const { stt, tts } = resolveVoiceProviders({
        sttProvider: 'deepgram',
        ttsProvider: 'elevenlabs',
        deepgramApiKey: 'dg-test',
        elevenLabsApiKey: 'xi-test',
      });

      expect(stt.name).toBe('deepgram');
      expect(tts.name).toBe('elevenlabs');
    });

    it('supports the reverse split', () => {
      const { stt, tts } = resolveVoiceProviders({
        sttProvider: 'elevenlabs',
        ttsProvider: 'deepgram',
        deepgramApiKey: 'dg-test',
        elevenLabsApiKey: 'xi-test',
      });

      expect(stt.name).toBe('elevenlabs');
      expect(tts.name).toBe('deepgram');
    });
  });

  describe('the mock', () => {
    it('is what a deployment with no keys gets, silently and on purpose', () => {
      const { stt, tts, fellBackToMock } = resolveVoiceProviders({
        sttProvider: 'mock',
        ttsProvider: 'mock',
      });

      expect(stt.name).toContain('mock');
      expect(tts.name).toContain('mock');
      // Asked for, so not a fallback. A fresh clone runs the whole voice loop
      // with no keys and no spend, and that must not warn.
      expect(fellBackToMock).toEqual([]);
    });

    /**
     * The failure this resolver exists to make visible.
     *
     * Naming a vendor whose credential is absent used to degrade to canned
     * audio with nothing said about it, because the vendor check and the key
     * check were one expression.
     */
    it('reports the capability when a named vendor has no credential', () => {
      const { stt, tts, fellBackToMock } = resolveVoiceProviders({
        sttProvider: 'deepgram',
        ttsProvider: 'elevenlabs',
      });

      expect(stt.name).toContain('mock');
      expect(tts.name).toContain('mock');
      expect(fellBackToMock).toEqual(['stt', 'tts']);
    });

    it('reports only the half that is missing its key', () => {
      const { stt, tts, fellBackToMock } = resolveVoiceProviders({
        sttProvider: 'deepgram',
        ttsProvider: 'deepgram',
        deepgramApiKey: undefined,
        elevenLabsApiKey: 'xi-test',
      });

      expect(fellBackToMock).toEqual(['stt', 'tts']);
      expect(stt.name).toContain('mock');
      expect(tts.name).toContain('mock');
    });

    it('reports a vendor the schema names but nothing implements', () => {
      // `google`, `azure` and `openai` are legal STT_PROVIDER values with no
      // adapter behind them. Falling back is right; doing it quietly is not.
      const { stt, fellBackToMock } = resolveVoiceProviders({
        sttProvider: 'azure',
        ttsProvider: 'mock',
      });

      expect(stt.name).toContain('mock');
      expect(fellBackToMock).toEqual(['stt']);
    });
  });

  describe('model overrides', () => {
    it('passes the configured model through to each capability', () => {
      const { stt, tts } = resolveVoiceProviders({
        sttProvider: 'deepgram',
        ttsProvider: 'elevenlabs',
        deepgramApiKey: 'dg-test',
        elevenLabsApiKey: 'xi-test',
        sttModel: 'nova-3',
        ttsModel: 'eleven_flash_v2_5',
      });

      expect(stt.model).toBe('nova-3');
      expect(tts.model).toBe('eleven_flash_v2_5');
    });

    it('falls back to each vendor default when none is configured', () => {
      const { stt, tts } = resolveVoiceProviders({
        sttProvider: 'elevenlabs',
        ttsProvider: 'deepgram',
        deepgramApiKey: 'dg-test',
        elevenLabsApiKey: 'xi-test',
      });

      expect(stt.model).toBe('scribe_v1');
      expect(tts.model).toBe('aura-2-thalia-en');
    });
  });
});
