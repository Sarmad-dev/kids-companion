import { z } from 'zod';

/**
 * Environment variables arrive as strings. These coerce to the intended type and
 * REJECT anything that does not parse, rather than quietly falling back to a
 * default — a misconfigured value that silently becomes `0` is worse than a
 * service that refuses to start.
 */

/** An integer, optionally with a default. `PORT=abc` fails; it does not become NaN. */
export const intFromEnv = (opts?: { min?: number; max?: number }) => {
  let schema = z.coerce.number().int();
  if (opts?.min !== undefined) schema = schema.min(opts.min);
  if (opts?.max !== undefined) schema = schema.max(opts.max);
  return schema;
};

/**
 * A boolean from the strings people actually write in `.env` files.
 * Anything else is an error — `ENABLED=yes` should not silently mean `false`.
 */
export const boolFromEnv = z
  .string()
  .transform((v) => v.trim().toLowerCase())
  .pipe(z.enum(['true', 'false', '1', '0']))
  .transform((v) => v === 'true' || v === '1');

/**
 * An optional string, where BLANK MEANS ABSENT.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY `z.string().optional()` IS THE WRONG SHAPE FOR AN ENV VAR
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `.env.example` ships most optional variables as a bare `KEY=`, and every
 * dotenv parser — Node's `--env-file` included — reads that as the empty
 * string, not as absent. `z.string().optional()` accepts it happily, so the
 * config carries `''`, and every `!== undefined` check downstream reads it as
 * CONFIGURED.
 *
 * The failures that produces are silent and vary by variable:
 *
 *   * `AI_MODEL_SAFETY_CLASSIFIER=` becomes a request to a model named `''`,
 *     which 404s, which fails the safety classifier, which fails CLOSED — so
 *     every single turn a child takes comes back as a safety redirect.
 *   * An empty `OPENAI_API_KEY=` makes that vendor look configured: the adapter
 *     is built with no credential and offered to parents as a choice.
 *   * `??` does not help, because `'' ?? fallback` is `''`. Only an explicit
 *     emptiness check does, and thirty-odd call sites will not all remember.
 *
 * So the coercion belongs here, once, at the boundary where the string arrives:
 * trim it, and treat what is left of nothing as nothing.
 */
export const optionalString = z
  .string()
  .transform((v) => v.trim())
  .transform((v) => (v.length === 0 ? undefined : v))
  .optional();

/** A comma-separated list, trimmed, with empties dropped. */
export const csvFromEnv = z
  .string()
  .transform((v) =>
    v
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  )
  .pipe(z.array(z.string()));

/**
 * A duration written the way humans write it: `15m`, `30d`, `604800s`.
 * Normalised to seconds so nothing downstream has to guess at a unit.
 *
 * Takes the fallback as a string and applies it *before* the transform, so the
 * default is written in the same notation as the environment variable it stands
 * in for — `durationSecondsFromEnv('15m')`, not `.default(900)`.
 */
const durationBody = z
  .string()
  .regex(/^\d+[smhd]$/, 'must be a number followed by s, m, h, or d (e.g. "15m")')
  .transform((v) => {
    const amount = Number(v.slice(0, -1));
    const unit = v.slice(-1);
    const multiplier = unit === 's' ? 1 : unit === 'm' ? 60 : unit === 'h' ? 3600 : 86_400;
    return amount * multiplier;
  });

export const durationSecondsFromEnv = (fallback: string) =>
  z.string().default(fallback).pipe(durationBody);

/**
 * A secret. Required to be non-trivial, and never given a default — a default
 * for a signing key means a production system running on a value from a README.
 */
export const secretFromEnv = (minLength = 32) =>
  z
    .string()
    .min(minLength, `must be at least ${String(minLength)} characters of high-entropy material`)
    .refine((v) => !v.toLowerCase().includes('replace-me'), {
      message: 'is still set to the placeholder from .env.example',
    });

/**
 * A URL that must be absolute. Relative values are a configuration bug.
 *
 * An empty string is treated the same as an absent variable — `.env.example`
 * ships every optional URL blank (`FOO_URL=`), and a `.env` file sets that key
 * to `""` rather than leaving it out of `process.env` entirely.
 */
export const urlFromEnv = z.preprocess((v) => (v === '' ? undefined : v), z.url().optional());
