#!/usr/bin/env node
/**
 * Verifies that a database dump is actually restorable.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * A BACKUP JOB THAT EXITED 0 IS NOT A BACKUP
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The classic failure is not a backup that never ran. It is a backup that ran
 * every night for eighteen months, exited 0 every time, and produced a file
 * that stops halfway through the schema — a broken pipe, a disk that filled, a
 * connection dropped mid-COPY. Nobody looks, because the job is green.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE FAILURE THAT WOULD BE WORST HERE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A restore that comes back WITHOUT THE RLS POLICIES.
 *
 * Every table in this database is `ENABLE` plus `FORCE` row-level security, and
 * 85 policies are what stop one family reading another's conversations. A dump
 * missing them restores into a database that starts, serves traffic, passes a
 * smoke test — and has no tenant isolation at all. That is a silent, total
 * confidentiality failure that looks exactly like a successful recovery.
 *
 * So this checks for them by name and count, not merely that the file parses.
 *
 * Usage:
 *   node infra/scripts/verify-backup.mjs <dump-file> [--min-tables N]
 */

import { readFileSync, statSync } from 'node:fs';

/**
 * The smallest a real dump of this schema can be.
 *
 * A truncated file is the thing being caught, and a length check is the cheapest
 * way to catch the worst of them before parsing anything.
 */
const MIN_BYTES = 20_000;

/** Things whose absence means the restore would come back subtly wrong. */
const REQUIRED_OBJECTS = [
  // Without the schema, none of the `app.` functions land and every policy that
  // calls one breaks.
  { what: 'the app schema', pattern: /CREATE SCHEMA\s+(IF NOT EXISTS\s+)?app\b/i },
  // The two functions every RLS policy is written in terms of. A dump with the
  // policies but not these restores a database where no query returns anything.
  { what: 'app.current_parent_id()', pattern: /FUNCTION\s+app\.current_parent_id/i },
  { what: 'app.owns_child()', pattern: /FUNCTION\s+app\.owns_child/i },
  // Where the migration runner reads its position. Restoring without it makes
  // the next deploy try to apply every migration again.
  { what: 'the migration ledger', pattern: /CREATE TABLE[^;]*schema_migrations/i },
  // The tables holding what this product exists to protect.
  { what: 'the messages table', pattern: /CREATE TABLE[^;]*\bmessages\b/i },
  { what: 'the children table', pattern: /CREATE TABLE[^;]*\bchildren\b/i },
];

export const analyseDump = (text) => {
  const count = (pattern) => (text.match(pattern) ?? []).length;

  return {
    tables: count(/^\s*CREATE TABLE /gim),
    policies: count(/^\s*CREATE POLICY /gim),
    // `ENABLE` alone is not enough: without FORCE, the table owner — which is
    // the role the application connects as — bypasses every policy.
    rlsEnabled: count(/ENABLE ROW LEVEL SECURITY/gi),
    rlsForced: count(/FORCE ROW LEVEL SECURITY/gi),
    functions: count(/^\s*CREATE (OR REPLACE )?FUNCTION /gim),
    // pg_dump writes this as the last line of a complete dump. Its absence is
    // the clearest possible signal of truncation.
    complete: /--\s*PostgreSQL database dump complete/i.test(text),
    missing: REQUIRED_OBJECTS.filter((object) => !object.pattern.test(text)).map((o) => o.what),
  };
};

export const verifyDump = (text, byteSize, expectations = {}) => {
  const minTables = expectations.minTables ?? 40;
  const minPolicies = expectations.minPolicies ?? 60;
  const problems = [];

  if (byteSize < MIN_BYTES) {
    problems.push(
      `the file is ${String(byteSize)} bytes — far too small to be a dump of this schema`,
    );
  }

  const found = analyseDump(text);

  if (!found.complete) {
    problems.push('the dump does not end with pg_dump’s completion marker: it was truncated');
  }
  if (found.tables < minTables) {
    problems.push(`only ${String(found.tables)} tables, expected at least ${String(minTables)}`);
  }
  if (found.policies < minPolicies) {
    problems.push(
      `only ${String(found.policies)} RLS policies, expected at least ${String(minPolicies)} — ` +
        'a restore from this would have no tenant isolation',
    );
  }
  if (found.rlsForced < found.rlsEnabled) {
    problems.push(
      `${String(found.rlsEnabled)} tables enable RLS but only ${String(found.rlsForced)} force it — ` +
        'the application role would bypass every policy on the difference',
    );
  }
  for (const what of found.missing) problems.push(`${what} is missing`);

  return { ok: problems.length === 0, problems, found };
};

/* -------------------------------------------------------------------------- */
/* CLI                                                                         */
/* -------------------------------------------------------------------------- */

const main = () => {
  const [, , file, ...rest] = process.argv;

  if (!file) {
    console.error('usage: verify-backup.mjs <dump-file> [--min-tables N] [--min-policies N]');
    process.exit(2);
  }

  const numeric = (flag, fallback) => {
    const index = rest.indexOf(flag);
    return index === -1 ? fallback : Number(rest[index + 1]);
  };

  let text;
  let bytes;
  try {
    bytes = statSync(file).size;
    text = readFileSync(file, 'utf8');
  } catch (error) {
    console.error(`\n  Cannot read ${file}: ${error.message}\n`);
    process.exit(1);
  }

  const result = verifyDump(text, bytes, {
    minTables: numeric('--min-tables', 40),
    minPolicies: numeric('--min-policies', 60),
  });

  const { found } = result;
  console.log(
    `\n  ${file}\n` +
      `  ${String(bytes)} bytes · ${String(found.tables)} tables · ` +
      `${String(found.policies)} policies · ${String(found.functions)} functions\n` +
      `  RLS: ${String(found.rlsEnabled)} enabled, ${String(found.rlsForced)} forced\n`,
  );

  if (result.ok) {
    console.log('  The dump is structurally complete.\n');
    console.log('  NOTE: this proves the FILE is intact. It does not prove the data');
    console.log('  restores — only a restore into a scratch database proves that.');
    console.log('  See DEPLOYMENT.md §10.3.\n');
    return;
  }

  console.error('\n  THIS BACKUP IS NOT SAFE TO RELY ON\n');
  for (const problem of result.problems) console.error(`  - ${problem}`);
  console.error('');
  process.exit(1);
};

// Only when run directly, so the functions above stay importable by tests.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  main();
}
