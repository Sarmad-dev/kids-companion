#!/usr/bin/env node
/**
 * Compares `.env` against `.env.example`.
 *
 * A placeholder for the real check, which lands with @kids/config in Phase 1 —
 * that one validates types and cross-field rules (docs/ENVIRONMENT.md §3) and is
 * the same code the API runs at boot. This one only catches drift: a variable
 * added to the template and not to your local file, or vice versa.
 */

import { readFileSync, existsSync } from 'node:fs';

const parseKeys = (file) =>
  new Set(
    readFileSync(file, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))
      .map((l) => l.split('=')[0]?.trim())
      .filter(Boolean),
  );

if (!existsSync('.env.example')) {
  console.error('.env.example is missing. It is the environment contract — restore it.');
  process.exit(1);
}

const template = parseKeys('.env.example');

if (!existsSync('.env')) {
  console.log('No .env found.\n\n  cp .env.example .env\n');
  console.log(`The template declares ${template.size} variables. Defaults work as-is:`);
  console.log('every provider is `mock`, so no API keys are needed.');
  process.exit(0);
}

const local = parseKeys('.env');
const missing = [...template].filter((k) => !local.has(k));
const extra = [...local].filter((k) => !template.has(k));

if (missing.length > 0) {
  console.warn(`\n  ${missing.length} variable(s) in .env.example but not in .env:`);
  for (const k of missing) console.warn(`    ${k}`);
}

if (extra.length > 0) {
  console.warn(`\n  ${extra.length} variable(s) in .env but not in .env.example:`);
  for (const k of extra) console.warn(`    ${k}`);
  console.warn('\n  Every variable the app reads must be declared in the template');
  console.warn('  and in the @kids/config schema. See docs/ENVIRONMENT.md §1.');
}

if (missing.length === 0 && extra.length === 0) {
  console.log(`.env matches .env.example (${template.size} variables).`);
}

// Drift is a warning, not a failure — the authoritative check is the boot-time
// schema in @kids/config, which fails hard.
process.exit(0);
