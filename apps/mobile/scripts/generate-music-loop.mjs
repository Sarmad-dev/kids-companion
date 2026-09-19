#!/usr/bin/env node
/**
 * Synthesises each character's background music: a short, seamless mono WAV
 * loop, one per cast member, into `assets/audio/music-<slug>.wav`.
 *
 *   node apps/mobile/scripts/generate-music-loop.mjs
 *
 * WHY IT IS GENERATED RATHER THAN LICENSED
 * The loops are original, royalty-free and reproducible from this file, so
 * there is no licence to track and no attribution to owe. Replace any file with
 * a recorded track at any time; the app only knows the file names.
 *
 * WHY THEY LOOP WITHOUT A CLICK
 * Every note is written modulo the loop length, so a note struck near the end
 * rings on across the seam into the start, and every pad chord fades in and out
 * inside its own bar.
 *
 * WHY EACH SOUNDS DIFFERENT
 * A theme is a key and scale, a chord per bar, a step length and a timbre:
 * bouncy plucks for Buddy, glassy shimmer for Lily, a wide slow pad for Sky, a
 * warm low tone for Owl, a square-wave arpeggio for Nano, and a drone with a
 * plucked raga-like line for Dada Jee.
 *
 * Randomness is a seeded generator, so re-running produces identical files.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SAMPLE_RATE = 16_000;
const BAR_SECONDS = 6;
const BARS = 4;
const TOTAL = SAMPLE_RATE * BAR_SECONDS * BARS;
const TWO_PI = Math.PI * 2;

const midi = (n) => 440 * 2 ** ((n - 69) / 12);

/** Timbres: [harmonic multiple, gain] pairs, and how fast the note dies. */
const TIMBRES = {
  bell: {
    partials: [
      [1, 1],
      [2.01, 0.25],
    ],
    decay: 0.7,
    attack: 120,
  },
  pluck: {
    partials: [
      [1, 1],
      [2, 0.5],
      [3, 0.25],
    ],
    decay: 0.28,
    attack: 40,
  },
  glass: {
    partials: [
      [1, 1],
      [2.76, 0.3],
      [5.4, 0.12],
    ],
    decay: 1.1,
    attack: 200,
  },
  warm: {
    partials: [
      [1, 1],
      [0.5, 0.5],
      [2, 0.15],
    ],
    decay: 1.0,
    attack: 600,
  },
  square: {
    partials: [
      [1, 1],
      [3, 0.33],
      [5, 0.2],
      [7, 0.14],
    ],
    decay: 0.16,
    attack: 30,
  },
  sitar: {
    partials: [
      [1, 1],
      [2, 0.7],
      [3, 0.5],
      [4, 0.35],
      [5, 0.2],
    ],
    decay: 0.6,
    attack: 25,
  },
};

const MAJOR_PENT = [0, 2, 4, 7, 9];
const MINOR_PENT = [0, 3, 5, 7, 10];
const LYDIAN = [0, 2, 4, 6, 7, 9, 11];
const DORIAN = [0, 2, 3, 5, 7, 9, 10];
const BHAIRAVI = [0, 1, 3, 5, 7, 8, 10];

/**
 * `chords` are four bars of [root, ...triad] in MIDI; `key` is the tonic of the
 * melody scale; `step` is seconds between melody notes; `arp` turns the melody
 * into a chord arpeggio instead of a wandering line.
 */
const THEMES = {
  'buddy-the-dog': {
    seed: 11,
    key: 72,
    scale: MAJOR_PENT,
    timbre: 'pluck',
    step: 0.75,
    padGain: 0.1,
    noteGain: 0.2,
    chords: [
      [48, 60, 64, 67],
      [53, 60, 65, 69],
      [43, 59, 62, 67],
      [48, 60, 64, 67],
    ],
  },
  'lily-the-fairy': {
    seed: 22,
    key: 76,
    scale: LYDIAN,
    timbre: 'glass',
    step: 1.0,
    padGain: 0.14,
    noteGain: 0.14,
    chords: [
      [50, 62, 66, 69],
      [47, 59, 62, 66],
      [43, 55, 59, 62],
      [45, 57, 61, 64],
    ],
  },
  'captain-sky': {
    seed: 33,
    key: 64,
    scale: MINOR_PENT,
    timbre: 'bell',
    step: 1.5,
    padGain: 0.22,
    noteGain: 0.12,
    chords: [
      [40, 52, 59, 64],
      [36, 48, 55, 64],
      [43, 55, 62, 67],
      [38, 50, 57, 62],
    ],
  },
  'professor-owl': {
    seed: 44,
    key: 57,
    scale: MINOR_PENT,
    timbre: 'warm',
    step: 1.5,
    padGain: 0.14,
    noteGain: 0.2,
    chords: [
      [45, 57, 60, 64],
      [50, 57, 62, 65],
      [40, 55, 59, 64],
      [45, 57, 60, 64],
    ],
  },
  'pip-the-fox': {
    seed: 55,
    key: 67,
    scale: MAJOR_PENT,
    timbre: 'pluck',
    step: 0.5,
    padGain: 0.08,
    noteGain: 0.2,
    chords: [
      [43, 59, 62, 67],
      [40, 55, 59, 64],
      [48, 60, 64, 67],
      [50, 62, 66, 69],
    ],
  },
  'nano-the-robot': {
    seed: 66,
    key: 60,
    scale: MAJOR_PENT,
    timbre: 'square',
    step: 0.375,
    padGain: 0.07,
    noteGain: 0.1,
    arp: true,
    chords: [
      [48, 60, 64, 67],
      [45, 57, 60, 64],
      [41, 57, 60, 65],
      [43, 55, 59, 62],
    ],
  },
  'mira-the-moon': {
    seed: 77,
    key: 65,
    scale: LYDIAN,
    timbre: 'glass',
    step: 2.0,
    padGain: 0.2,
    noteGain: 0.12,
    chords: [
      [41, 53, 57, 60],
      [48, 55, 60, 64],
      [38, 53, 57, 62],
      [46, 58, 62, 65],
    ],
  },
  'captain-zia': {
    seed: 88,
    key: 62,
    scale: DORIAN,
    timbre: 'pluck',
    step: 0.5,
    padGain: 0.1,
    noteGain: 0.19,
    chords: [
      [38, 57, 62, 65],
      [36, 55, 60, 64],
      [34, 53, 58, 62],
      [36, 55, 60, 64],
    ],
  },
  'dada-jee': {
    seed: 99,
    key: 62,
    scale: BHAIRAVI,
    timbre: 'sitar',
    step: 0.75,
    padGain: 0.16,
    noteGain: 0.16,
    chords: [
      [38, 50, 57, 62],
      [38, 50, 57, 62],
      [38, 50, 57, 62],
      [38, 50, 57, 62],
    ],
  },
};

const render = (theme) => {
  const out = new Float32Array(TOTAL);
  let seed = theme.seed * 7919 + 20260919;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const timbre = TIMBRES[theme.timbre];

  const note = (start, n, gain, decayScale = 1) => {
    const freq = midi(n);
    const begin = Math.floor(start * SAMPLE_RATE);
    const decay = timbre.decay * decayScale;
    const length = Math.floor(SAMPLE_RATE * decay * 5);
    for (let i = 0; i < length; i += 1) {
      const t = i / SAMPLE_RATE;
      const env = Math.min(1, i / timbre.attack) * Math.exp(-t / decay);
      let tone = 0;
      for (const [mult, g] of timbre.partials) tone += g * Math.sin(TWO_PI * freq * mult * t);
      out[(begin + i) % TOTAL] += tone * env * gain;
    }
  };

  const pad = (start, seconds, n, gain) => {
    const freq = midi(n);
    const begin = Math.floor(start * SAMPLE_RATE);
    const length = Math.floor(seconds * SAMPLE_RATE);
    for (let i = 0; i < length; i += 1) {
      const t = i / SAMPLE_RATE;
      const env = Math.sin((Math.PI * i) / length) ** 2;
      const tone =
        Math.sin(TWO_PI * freq * t) +
        0.4 * Math.sin(TWO_PI * freq * 0.5 * t) +
        0.15 * Math.sin(TWO_PI * freq * 1.003 * t);
      out[(begin + i) % TOTAL] += tone * env * gain;
    }
  };

  let previous = 2;
  theme.chords.forEach(([root, ...triad], bar) => {
    const start = bar * BAR_SECONDS;
    pad(start - 0.4, BAR_SECONDS + 0.8, root, theme.padGain);
    for (const n of triad) pad(start - 0.4, BAR_SECONDS + 0.8, n, theme.padGain * 0.45);
    note(start, root + 12, theme.noteGain * 0.6, 2);

    const steps = Math.floor(BAR_SECONDS / theme.step);
    for (let s = 0; s < steps; s += 1) {
      const at = start + 0.3 + s * theme.step + rand() * 0.06;
      if (theme.arp) {
        note(at, triad[s % triad.length] + 12, theme.noteGain);
        continue;
      }
      // Wander along the scale: mostly a step up or down, sometimes a leap.
      const move = rand() < 0.7 ? (rand() < 0.5 ? -1 : 1) : Math.round((rand() - 0.5) * 6);
      previous = Math.max(0, Math.min(theme.scale.length * 2 - 1, previous + move));
      const degree = theme.scale[previous % theme.scale.length];
      const octave = Math.floor(previous / theme.scale.length) * 12;
      if (rand() < 0.15) continue; // a rest, so it breathes
      note(at, theme.key + degree + octave - 12, theme.noteGain);
    }
  });
  return out;
};

const toWav = (samples) => {
  let peak = 0;
  for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
  const scale = peak > 0 ? 0.55 / peak : 1;
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i += 1) {
    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i] * scale)) * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
};

const directory = resolve(dirname(fileURLToPath(import.meta.url)), '../assets/audio');
mkdirSync(directory, { recursive: true });
for (const [slug, theme] of Object.entries(THEMES)) {
  const file = resolve(directory, `music-${slug}.wav`);
  writeFileSync(file, toWav(render(theme)));
  process.stdout.write(`Wrote ${file}\n`);
}
