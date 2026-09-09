#!/usr/bin/env node
/**
 * Applies migrations to the database in DATABASE_URL.
 *
 *   node infra/scripts/migrate.mjs            apply pending
 *   node infra/scripts/migrate.mjs --status   list without applying
 *
 * Uses the same loader the integration tests use (@kids/db), so the migrations
 * verified in CI are exactly the migrations this applies.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyMigrations, loadMigrations, postgresTls } from '@kids/db';
import pg from 'pg';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));
const statusOnly = process.argv.includes('--status');

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set.\n\n  cp .env.example .env   # then: pnpm docker:up\n');
  process.exit(78); // EX_CONFIG
}

const migrations = await loadMigrations(MIGRATIONS_DIR);
console.log(
  `Found ${migrations.length} migration(s) in ${path.relative(process.cwd(), MIGRATIONS_DIR)}`,
);

const client = new pg.Client({
  connectionString: url,
  ssl: postgresTls({
    mode: process.env.DATABASE_SSL_MODE,
    rootCert: process.env.DATABASE_SSL_ROOT_CERT,
  }),
});

await client.connect();

const executor = {
  exec: (sql) => client.query(sql),
  query: (sql, params) => client.query(sql, params ? [...params] : undefined),
};

try {
  if (statusOnly) {
    let applied = new Set();
    try {
      const { rows } = await client.query('select version from schema_migrations');
      applied = new Set(rows.map((r) => r.version));
    } catch {
      console.log('(schema_migrations does not exist yet — nothing has been applied)');
    }
    for (const m of migrations) {
      console.log(`  ${applied.has(m.version) ? '✓' : ' '} ${m.version}`);
    }
  } else {
    const result = await applyMigrations(executor, migrations);
    for (const version of result.applied) console.log(`  applied  ${version}`);
    if (result.applied.length === 0) console.log('  nothing to apply — already up to date');
    console.log(`\n${result.applied.length} applied, ${result.skipped.length} already present.`);
  }
} catch (error) {
  console.error(`\nMigration failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await client.end();
}
