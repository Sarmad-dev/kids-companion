/**
 * Audio container identification and duration, from the bytes themselves.
 *
 * THE CLIENT'S CONTENT-TYPE IS A CLAIM, NOT A FACT. Every value a client sends —
 * the MIME type, the filename, the reported duration — is attacker-controlled.
 * A `Content-Type: audio/wav` header on a PHP script is a two-line curl command,
 * and an upload path that trusts it is an upload path that stores whatever it is
 * handed. So the format is determined here, by reading the container, and the
 * declared type is only ever checked for AGREEMENT with what was found.
 *
 * Duration is parsed from the container for the same reason: a client-reported
 * duration cannot bound anything, because the client is the thing being bounded.
 *
 * Five containers, chosen because they are what mobile recorders actually
 * produce: WAV (iOS/Android raw), OGG/Opus and WebM/Opus (browser MediaRecorder),
 * MP4/M4A (iOS AVAudioRecorder), and MP3. Anything else is refused rather than
 * guessed at — see docs/adr/0006 for why the safe direction here is "no".
 */

export type AudioContainer = 'wav' | 'ogg' | 'webm' | 'mp4' | 'mp3';

export interface SniffedAudio {
  readonly container: AudioContainer;
  readonly mimeType: string;
  /**
   * Duration in milliseconds, or `undefined` when the container does not carry
   * it in a place we can read cheaply.
   *
   * Undefined is NOT "unbounded": the caller applies a byte-size ceiling either
   * way, and a duration that cannot be established is treated as a validation
   * failure wherever a duration limit is being enforced.
   */
  readonly durationMs?: number;
}

/** The canonical type for a container. What we send onward, never what we were told. */
export const CANONICAL_MIME: Readonly<Record<AudioContainer, string>> = Object.freeze({
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  webm: 'audio/webm',
  mp4: 'audio/mp4',
  mp3: 'audio/mpeg',
});

/**
 * The MIME types a client may declare for each container.
 *
 * Generous on the input side because recorders disagree — Safari says
 * `audio/mp4`, Chrome says `audio/webm;codecs=opus`, Android has said
 * `audio/x-wav` — and rejecting a legitimate recording because a vendor picked a
 * synonym is a bug that presents as "the app doesn't work on my phone".
 */
const ACCEPTED_DECLARATIONS: Readonly<Record<AudioContainer, readonly string[]>> = Object.freeze({
  wav: ['audio/wav', 'audio/wave', 'audio/x-wav', 'audio/vnd.wave'],
  ogg: ['audio/ogg', 'application/ogg', 'audio/opus'],
  webm: ['audio/webm', 'video/webm'],
  mp4: ['audio/mp4', 'audio/m4a', 'audio/x-m4a', 'video/mp4'],
  mp3: ['audio/mpeg', 'audio/mp3', 'audio/mpeg3', 'audio/x-mpeg-3'],
});

/** Strips `;codecs=opus` and normalises case, so the comparison is on the type alone. */
export const normaliseMime = (declared: string): string =>
  declared.split(';')[0]?.trim().toLowerCase() ?? '';

export const declarationMatches = (container: AudioContainer, declared: string): boolean =>
  ACCEPTED_DECLARATIONS[container].includes(normaliseMime(declared));

const ascii = (bytes: Uint8Array, offset: number, length: number): string =>
  String.fromCharCode(...bytes.subarray(offset, offset + length));

const u32be = (b: Uint8Array, o: number): number =>
  ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;

const u32le = (b: Uint8Array, o: number): number =>
  (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;

const u16le = (b: Uint8Array, o: number): number => b[o]! | (b[o + 1]! << 8);

/* -------------------------------------------------------------------------- */
/* WAV                                                                         */
/* -------------------------------------------------------------------------- */
/**
 * `RIFF....WAVE`, then chunks. Duration comes from the `fmt ` byte rate and the
 * `data` chunk size, which is exact rather than estimated.
 */
const sniffWav = (b: Uint8Array): SniffedAudio | undefined => {
  if (b.length < 44) return undefined;
  if (ascii(b, 0, 4) !== 'RIFF' || ascii(b, 8, 4) !== 'WAVE') return undefined;

  let byteRate = 0;
  let dataBytes = 0;
  let offset = 12;

  // Bounded walk: a malformed or hostile file must not spin here.
  while (offset + 8 <= b.length) {
    const id = ascii(b, offset, 4);
    const size = u32le(b, offset + 4);
    // A chunk claiming to be larger than the file is a malformed file, and
    // trusting it would walk the cursor past the end.
    if (size > b.length) break;

    if (id === 'fmt ' && offset + 16 + 8 <= b.length) {
      byteRate = u32le(b, offset + 8 + 8);
      // A zero byte rate would divide by zero below; a zero channel count or
      // sample rate is a corrupt header either way.
      if (u16le(b, offset + 8 + 2) === 0) return undefined;
    } else if (id === 'data') {
      dataBytes = Math.min(size, b.length - (offset + 8));
      break;
    }

    // Chunks are word-aligned; the pad byte is not counted in `size`.
    offset += 8 + size + (size % 2);
  }

  if (byteRate <= 0 || dataBytes <= 0) return { container: 'wav', mimeType: CANONICAL_MIME.wav };
  return {
    container: 'wav',
    mimeType: CANONICAL_MIME.wav,
    durationMs: Math.round((dataBytes / byteRate) * 1000),
  };
};

/* -------------------------------------------------------------------------- */
/* OGG                                                                         */
/* -------------------------------------------------------------------------- */
/**
 * `OggS` pages. Duration is the granule position of the LAST page, which for
 * Opus is a sample count at a fixed 48 kHz.
 *
 * Read by scanning backwards from the end for the final page header rather than
 * walking every page from the front: a two-minute recording is thousands of
 * pages, and this runs on the request path.
 */
const sniffOgg = (b: Uint8Array): SniffedAudio | undefined => {
  if (b.length < 27 || ascii(b, 0, 4) !== 'OggS') return undefined;

  const isOpus = indexOfAscii(b, 'OpusHead', 0, 512) !== -1;
  const rate = isOpus ? 48_000 : sniffVorbisRate(b);

  for (let i = b.length - 27; i >= 0; i -= 1) {
    if (b[i] !== 0x4f || ascii(b, i, 4) !== 'OggS') continue;

    // 64-bit granule position at offset 6. Read as two 32-bit halves, because a
    // shift past 31 bits is undefined in JavaScript's bitwise operators.
    const low = u32le(b, i + 6);
    const high = u32le(b, i + 10);
    const granule = high * 2 ** 32 + low;

    if (!Number.isFinite(granule) || granule <= 0 || rate <= 0) break;
    // Opus granule positions include 80 ms of pre-skip; close enough for a limit
    // check and not worth parsing the header for.
    return {
      container: 'ogg',
      mimeType: CANONICAL_MIME.ogg,
      durationMs: Math.round((granule / rate) * 1000),
    };
  }

  return { container: 'ogg', mimeType: CANONICAL_MIME.ogg };
};

/** Vorbis identification header carries the sample rate at a fixed offset. */
const sniffVorbisRate = (b: Uint8Array): number => {
  const at = indexOfAscii(b, 'vorbis', 0, 512);
  return at === -1 || at + 11 > b.length ? 0 : u32le(b, at + 5);
};

/* -------------------------------------------------------------------------- */
/* WebM / Matroska                                                             */
/* -------------------------------------------------------------------------- */
/**
 * EBML magic, then a `Duration` element inside `Info`.
 *
 * MediaRecorder in a browser produces WebM with an UNKNOWN duration when the
 * stream is not finalised, which is normal rather than suspicious — the byte
 * ceiling is what bounds those.
 */
const sniffWebm = (b: Uint8Array): SniffedAudio | undefined => {
  if (b.length < 4) return undefined;
  if (!(b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3)) return undefined;

  const result: SniffedAudio = { container: 'webm', mimeType: CANONICAL_MIME.webm };

  // TimecodeScale (0x2AD7B1) defaults to 1 ms; Duration (0x4489) is a float in
  // those units. Search a bounded prefix — the Info element is near the front.
  const limit = Math.min(b.length - 8, 8_192);
  let scaleNs = 1_000_000;

  for (let i = 0; i < limit; i += 1) {
    if (b[i] === 0x2a && b[i + 1] === 0xd7 && b[i + 2] === 0xb1) {
      const size = b[i + 3]! & 0x7f;
      if (size >= 1 && size <= 8 && i + 4 + size <= b.length) {
        let value = 0;
        for (let k = 0; k < size; k += 1) value = value * 256 + b[i + 4 + k]!;
        if (value > 0) scaleNs = value;
      }
    }
  }

  for (let i = 0; i < limit; i += 1) {
    if (b[i] !== 0x44 || b[i + 1] !== 0x89) continue;
    const size = b[i + 2]! & 0x7f;
    const at = i + 3;

    if (size === 4 && at + 4 <= b.length) {
      const view = new DataView(b.buffer, b.byteOffset + at, 4);
      const seconds = (view.getFloat32(0) * scaleNs) / 1_000_000_000;
      if (seconds > 0 && Number.isFinite(seconds)) {
        return { ...result, durationMs: Math.round(seconds * 1000) };
      }
    }
    if (size === 8 && at + 8 <= b.length) {
      const view = new DataView(b.buffer, b.byteOffset + at, 8);
      const seconds = (view.getFloat64(0) * scaleNs) / 1_000_000_000;
      if (seconds > 0 && Number.isFinite(seconds)) {
        return { ...result, durationMs: Math.round(seconds * 1000) };
      }
    }
  }

  return result;
};

/* -------------------------------------------------------------------------- */
/* MP4 / M4A                                                                   */
/* -------------------------------------------------------------------------- */
/**
 * `ftyp` box at offset 4, then `moov` → `mvhd` for the timescale and duration.
 *
 * A brand has to be recognised, but the recogniser looks at the WHOLE brand list
 * in the `ftyp` box, not just the major brand at offset 8. Android's recorder
 * (and Expo AV on top of it) writes `.m4a` files whose major brand is a generic
 * ISO brand — `isom`, `mp42`, `3gp4` — with the audio-specific brand further
 * down the compatible list, so a major-brand-only check rejects a legitimate
 * mobile recording as "unsupported".
 *
 * A file that carries a video track is still refused: a video arriving at an
 * audio endpoint is either a bug or a probe. That check reads the `handler_type`
 * field of each real `hdlr` box, not a raw `vide` substring — the four bytes
 * `vide` turn up inside AAC config and handler-name strings often enough that a
 * plain search rejects valid audio (Android's `3gp4` recordings in particular).
 */
const AUDIO_BRANDS = new Set([
  'M4A ',
  'M4B ',
  'M4P ',
  'mp41',
  'mp42',
  'isom',
  'iso2',
  'iso4',
  'iso5',
  'iso6',
  '3gp4',
  '3gp5',
  '3gp6',
  '3gp7',
  '3gpp',
  'f4a ',
  'f4b ',
  'mp4a',
  'dash',
  'msdh',
  'msix',
]);

/** Major brand at offset 8, then the compatible brands that fill the rest of the box. */
const ftypBrands = (b: Uint8Array): string[] => {
  const boxSize = Math.min(u32be(b, 0) || b.length, b.length);
  const brands = [ascii(b, 8, 4)];
  for (let o = 16; o + 4 <= boxSize; o += 4) brands.push(ascii(b, o, 4));
  return brands;
};

/**
 * A real video track, read from the `handler_type` of an `hdlr` box.
 *
 * `hdlr` is a FullBox: after its 4-byte type comes version+flags (4) and
 * pre_defined (4), then the 4-byte `handler_type`. Only that field counts —
 * `vide` appearing anywhere else in the bytes is not a video track.
 */
const hasVideoTrack = (b: Uint8Array): boolean => {
  const cap = Math.min(b.length, 64 * 1024);
  for (let from = 0; from < cap;) {
    const h = indexOfAscii(b, 'hdlr', from, cap - from);
    if (h === -1) return false;
    if (ascii(b, h + 12, 4) === 'vide') return true;
    from = h + 4;
  }
  return false;
};

const sniffMp4 = (b: Uint8Array): SniffedAudio | undefined => {
  if (b.length < 12 || ascii(b, 4, 4) !== 'ftyp') return undefined;
  if (!ftypBrands(b).some((brand) => AUDIO_BRANDS.has(brand))) return undefined;
  if (hasVideoTrack(b)) return undefined;

  const result: SniffedAudio = { container: 'mp4', mimeType: CANONICAL_MIME.mp4 };

  const at = indexOfAscii(b, 'mvhd', 0, Math.min(b.length, 64 * 1024));
  if (at === -1 || at + 24 > b.length) return result;

  const version = b[at + 4];
  if (version === 0 && at + 20 <= b.length) {
    const timescale = u32be(b, at + 16);
    const duration = u32be(b, at + 20);
    if (timescale > 0 && duration > 0) {
      return { ...result, durationMs: Math.round((duration / timescale) * 1000) };
    }
  }
  if (version === 1 && at + 32 <= b.length) {
    const timescale = u32be(b, at + 24);
    const duration = u32be(b, at + 28) * 2 ** 32 + u32be(b, at + 32);
    if (timescale > 0 && duration > 0) {
      return { ...result, durationMs: Math.round((duration / timescale) * 1000) };
    }
  }

  return result;
};

/* -------------------------------------------------------------------------- */
/* MP3                                                                         */
/* -------------------------------------------------------------------------- */
/**
 * `ID3` tag or a frame sync.
 *
 * No duration: getting it right means either a Xing/VBRI header or counting
 * every frame, and MP3 is the least likely of these to arrive from a mobile
 * recorder. The byte ceiling bounds it, and a request that needs a duration
 * treats "unknown" as a failure rather than as permission.
 */
const sniffMp3 = (b: Uint8Array): SniffedAudio | undefined => {
  if (b.length >= 3 && ascii(b, 0, 3) === 'ID3') {
    return { container: 'mp3', mimeType: CANONICAL_MIME.mp3 };
  }
  // Frame sync: eleven set bits, and a valid non-reserved layer.
  if (b.length >= 2 && b[0] === 0xff && (b[1]! & 0xe0) === 0xe0 && (b[1]! & 0x06) !== 0) {
    return { container: 'mp3', mimeType: CANONICAL_MIME.mp3 };
  }
  return undefined;
};

/** Bounded ASCII search. Never scans the whole file. */
const indexOfAscii = (b: Uint8Array, needle: string, from: number, limit: number): number => {
  const end = Math.min(b.length - needle.length, from + limit);
  for (let i = from; i <= end; i += 1) {
    let hit = true;
    for (let k = 0; k < needle.length; k += 1) {
      if (b[i + k] !== needle.charCodeAt(k)) {
        hit = false;
        break;
      }
    }
    if (hit) return i;
  }
  return -1;
};

const SNIFFERS = [sniffWav, sniffOgg, sniffWebm, sniffMp4, sniffMp3] as const;

/**
 * Identifies the container, or returns `undefined`.
 *
 * `undefined` means "this is not one of the five audio containers we accept",
 * and the only correct response to that is to refuse the upload. It is
 * deliberately not "unknown, proceed with the declared type".
 */
export const sniffAudio = (bytes: Uint8Array): SniffedAudio | undefined => {
  for (const sniff of SNIFFERS) {
    const result = sniff(bytes);
    if (result) return result;
  }
  return undefined;
};
