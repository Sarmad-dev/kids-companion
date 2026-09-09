import { describe, expect, it } from 'vitest';

import { declarationMatches, normaliseMime, sniffAudio } from './formats.js';
import { silentWav } from './mock-providers.js';

/**
 * Container identification.
 *
 * The rule under test throughout: the bytes decide, and the client's
 * `Content-Type` is only ever checked for agreement with them.
 */

const wav = (durationMs: number): Uint8Array => silentWav(durationMs);

/** A minimal OggS page with a granule position, which is where duration lives. */
const ogg = (granule: number, sampleRate = 48_000): Uint8Array => {
  const head = Buffer.alloc(28 + 8 + 8);
  head.write('OggS', 0, 'ascii');
  head.writeUInt32LE(granule >>> 0, 6);
  head.writeUInt32LE(Math.floor(granule / 2 ** 32), 10);
  head.write('OpusHead', 28, 'ascii');
  // The sample rate is fixed at 48 kHz for Opus, so this argument only documents
  // intent for the Vorbis path.
  void sampleRate;
  return new Uint8Array(head);
};

const webm = (): Uint8Array => new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x02, 0x03, 0x04]);

const mp4 = (brand: string, compatible: string[] = []): Uint8Array => {
  const size = 16 + compatible.length * 4;
  const b = Buffer.alloc(Math.max(size, 32));
  b.writeUInt32BE(size, 0);
  b.write('ftyp', 4, 'ascii');
  b.write(brand, 8, 'ascii');
  compatible.forEach((c, i) => b.write(c, 16 + i * 4, 'ascii'));
  return new Uint8Array(b);
};

/** An MP4 whose `moov` carries a `vide` handler — i.e. it has a video track. */
const mp4WithVideo = (brand: string): Uint8Array => {
  const head = mp4(brand);
  const moov = Buffer.alloc(24);
  moov.write('hdlr', 4, 'ascii');
  moov.write('vide', 16, 'ascii');
  return new Uint8Array(Buffer.concat([head, moov]));
};

const mp3 = (): Uint8Array => new Uint8Array([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00]);

describe('sniffAudio', () => {
  it('identifies a WAV and reads its exact duration', () => {
    const result = sniffAudio(wav(2_000));

    expect(result?.container).toBe('wav');
    expect(result?.mimeType).toBe('audio/wav');
    // Exact, not estimated: byte rate and data chunk size are both in the header.
    expect(result?.durationMs).toBe(2_000);
  });

  it('identifies an OGG and reads the granule position', () => {
    // 48 000 samples at 48 kHz is one second.
    const result = sniffAudio(ogg(48_000));

    expect(result?.container).toBe('ogg');
    expect(result?.durationMs).toBe(1_000);
  });

  it('identifies a WebM without a duration', () => {
    // Normal, not suspicious: MediaRecorder does not write a duration until the
    // stream is finalised. The byte ceiling is what bounds these.
    const result = sniffAudio(webm());

    expect(result?.container).toBe('webm');
    expect(result?.durationMs).toBeUndefined();
  });

  it.each(['M4A ', 'mp42', 'isom', '3gp4', 'mp4a'])(
    'identifies an MP4 with the %j major brand',
    (brand) => {
      expect(sniffAudio(mp4(brand))?.container).toBe('mp4');
    },
  );

  it('identifies an MP4 whose audio brand is only in the compatible list', () => {
    // Android's recorder — and Expo AV on top of it — writes `.m4a` with a
    // generic major brand and the audio brand further down the list.
    expect(sniffAudio(mp4('isom', ['isom', 'iso2', 'mp41', 'M4A ']))?.container).toBe('mp4');
    expect(sniffAudio(mp4('mp42', ['isom', '3gp4']))?.container).toBe('mp4');
  });

  it('refuses an MP4 whose brand is a video one', () => {
    // An `avc1` file arriving at an audio endpoint is either a bug or a probe.
    expect(sniffAudio(mp4('avc1'))).toBeUndefined();
  });

  it('refuses an MP4 that carries a video track', () => {
    // A recognised audio brand is not enough: a `vide` handler means there is a
    // video track, and a video at an audio endpoint is a bug or a probe.
    expect(sniffAudio(mp4WithVideo('isom'))).toBeUndefined();
  });

  it('identifies an MP3 by ID3 tag and by frame sync', () => {
    expect(sniffAudio(mp3())?.container).toBe('mp3');
    expect(sniffAudio(new Uint8Array([0xff, 0xfb, 0x90, 0x00]))?.container).toBe('mp3');
  });

  it.each([
    ['a PHP script', Buffer.from('<?php system($_GET["c"]); ?>')],
    ['an ELF binary', Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00])],
    ['a ZIP archive', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00])],
    ['a PNG', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
    ['an SVG with script', Buffer.from('<svg onload="alert(1)"></svg>')],
    ['empty bytes', Buffer.alloc(0)],
    ['random noise', Buffer.from([0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77])],
  ])('refuses %s', (_label, bytes) => {
    expect(sniffAudio(new Uint8Array(bytes))).toBeUndefined();
  });

  it('refuses a polyglot that only claims to be audio', () => {
    // `RIFF` without `WAVE`, followed by a payload. The four magic bytes are not
    // the check — the container structure is.
    const b = Buffer.alloc(64);
    b.write('RIFF', 0, 'ascii');
    b.write('EVIL', 8, 'ascii');
    b.write('<?php echo 1; ?>', 12, 'ascii');

    expect(sniffAudio(new Uint8Array(b))).toBeUndefined();
  });

  it('does not walk past the end of a WAV with a lying chunk size', () => {
    // A chunk claiming to be larger than the file. The parser must stop rather
    // than run off the buffer.
    const b = Buffer.from(silentWav(500));
    b.writeUInt32LE(0xffffffff, 16);

    expect(() => sniffAudio(new Uint8Array(b))).not.toThrow();
  });

  it('survives a truncated file of every accepted container', () => {
    for (const full of [wav(1_000), ogg(48_000), webm(), mp4('M4A '), mp3()]) {
      for (let cut = 0; cut < Math.min(full.length, 40); cut += 1) {
        expect(() => sniffAudio(full.subarray(0, cut))).not.toThrow();
      }
    }
  });
});

describe('declared type agreement', () => {
  it('accepts the synonyms real recorders send', () => {
    expect(declarationMatches('wav', 'audio/x-wav')).toBe(true);
    expect(declarationMatches('webm', 'audio/webm;codecs=opus')).toBe(true);
    expect(declarationMatches('mp4', 'audio/x-m4a')).toBe(true);
    expect(declarationMatches('ogg', 'application/ogg')).toBe(true);
  });

  it('rejects a declaration that does not match the bytes', () => {
    // The interesting case: a client asserting something untrue about its own
    // payload, which is worth counting separately from an honest wrong format.
    expect(declarationMatches('wav', 'audio/mpeg')).toBe(false);
    expect(declarationMatches('wav', 'application/octet-stream')).toBe(false);
    expect(declarationMatches('mp3', 'audio/wav')).toBe(false);
  });

  it('normalises parameters and case', () => {
    expect(normaliseMime('AUDIO/WEBM; codecs=opus')).toBe('audio/webm');
    expect(normaliseMime('  audio/wav  ')).toBe('audio/wav');
  });
});
