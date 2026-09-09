#!/usr/bin/env node
/**
 * Migration safeguards, run on every pull request.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THIS ADDS TO THE GUARD THAT ALREADY EXISTS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `applyMigrations` already refuses to run when a merged migration's checksum
 * has changed. That guard is real, and it fires at DEPLOY time — against a
 * database, in an environment, with a release in flight.
 *
 * This moves the same failures to the pull request, and adds the two the
 * runtime guard cannot make:
 *
 *   BACK-DATING   a migration whose timestamp sorts before one already applied.
 *                 The ledger is keyed by version, so it still runs — just in the
 *                 wrong order relative to what every other environment did. Two
 *                 databases then have the same rows applied in a different
 *                 sequence, and nothing reports it.
 *
 *   DESTRUCTIVE   a statement that breaks the version currently running. During
 *                 any rolling deploy both versions are live for a few minutes
 *                 (DEPLOYMENT.md §4), so dropping a column the old version still
 *                 selects is an outage during its own deploy.
 *
 * Usage:
 *   node infra/scripts/check-migrations.mjs [--base origin/main]
 *
 * Structural checks always run. The git-based ones need a base ref to compare
 * against; without one they are SKIPPED and say so, because a check that
 * silently does nothing is worse than one that is absent.
 */

import { execSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const DIR = 'infra/migrations';
const FILENAME = /^\d{14}_[a-z0-9_]+\.sql$/;

const baseIndex = process.argv.indexOf('--base');
const baseRef = baseIndex === -1 ? 'origin/main' : (process.argv[baseIndex + 1] ?? 'origin/main');

const problems = [];
const fail = (message) => problems.push(message);
const write = (line = '') => process.stdout.write(`${line}\n`);

/* -------------------------------------------------------------------------- */
/* Structural — always                                                         */
/* -------------------------------------------------------------------------- */

const entries = readdirSync(DIR).filter((file) => file.endsWith('.sql'));

for (const file of entries) {
  if (!FILENAME.test(file)) {
    fail(`${file}: filename must be <14-digit-timestamp>_<snake_case>.sql`);
  }
  if (/down|rollback|revert/i.test(file)) {
    fail(
      `${file}: migrations are forward-only. A change that must be undone is a NEW ` +
        `migration, not a reversal of an old one.`,
    );
  }
  if (readFileSync(path.join(DIR, file), 'utf8').trim() === '') {
    fail(`${file}: is empty`);
  }
}

const versions = entries.map((file) => file.replace(/\.sql$/, ''));
const duplicates = versions.filter((version, index) => versions.indexOf(version) !== index);
for (const version of new Set(duplicates)) fail(`${version}: duplicate migration version`);

/* -------------------------------------------------------------------------- */
/* Git-based — only with a base ref                                            */
/* -------------------------------------------------------------------------- */

/** Runs git, returning undefined rather than throwing when the ref is unknown. */
const git = (command) => {
  try {
    return execSync(`git ${command}`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
};

const baseResolves = git(`rev-parse --verify --quiet ${baseRef}`) !== undefined;

let gitChecksRan = false;

if (!baseResolves) {
  write(`Base ref "${baseRef}" does not resolve — immutability, ordering and`);
  write('destructive-statement checks were SKIPPED. They run in CI against the');
  write('pull request base.');
  write();
} else {
  gitChecksRan = true;

  const mergeBase = git(`merge-base ${baseRef} HEAD`) ?? baseRef;

  /* Files under the migrations directory as they are on the base. */
  const onBase = new Set(
    (git(`ls-tree -r --name-only ${mergeBase} -- ${DIR}`) ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.endsWith('.sql'))
      .map((line) => path.basename(line)),
  );

  /* ---- Immutability -------------------------------------------------------
   * A merged migration has already run somewhere. Editing it produces a
   * database that does not match what other environments applied, and the
   * checksum guard turns that into a failed deploy rather than a failed PR. */
  /* `diff <base>` — not `<base>...HEAD` — so the WORKING TREE is compared, not
   * just what has been committed. In CI the two are the same; locally the
   * three-dot form would happily pass an edit sitting unstaged in the editor,
   * which is exactly when someone wants to be told. */
  const changed = (git(`diff --name-status ${mergeBase} -- ${DIR}`) ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [status, ...rest] = line.split(/\s+/);
      return { status: status ?? '', file: path.basename(rest[rest.length - 1] ?? '') };
    });

  for (const { status, file } of changed) {
    if (!onBase.has(file)) continue;
    if (status.startsWith('M')) {
      fail(
        `${file}: modified, but it is already merged. Migrations are immutable once ` +
          `merged — someone has already run this one. Write a new migration.`,
      );
    }
    if (status.startsWith('D')) {
      fail(`${file}: deleted, but it is already merged. The ledger still references it.`);
    }
    if (status.startsWith('R')) {
      fail(`${file}: renamed, but it is already merged. The version IS the filename.`);
    }
  }

  /* ---- No back-dating ----------------------------------------------------- */
  /* `git diff` cannot see a file that has never been added to the index, so a
   * brand-new migration sitting untracked in the working tree would slip past
   * every check below. In CI the file is committed and shows up as `A`; locally
   * it usually does not, and locally is where someone still has time to fix it. */
  const untracked = (git(`ls-files --others --exclude-standard -- ${DIR}`) ?? '')
    .split('\n')
    .map((line) => path.basename(line.trim()))
    .filter((file) => file.endsWith('.sql'));

  const added = [
    ...new Set([
      ...changed
        .filter(({ status, file }) => status.startsWith('A') && FILENAME.test(file))
        .map(({ file }) => file),
      ...untracked.filter((file) => FILENAME.test(file)),
    ]),
  ];

  const highestOnBase = [...onBase].sort().pop();

  for (const file of added) {
    if (
      highestOnBase !== undefined &&
      file.replace(/\.sql$/, '') < highestOnBase.replace(/\.sql$/, '')
    ) {
      fail(
        `${file}: sorts BEFORE ${highestOnBase}, which is already on ${baseRef}. ` +
          `A back-dated migration runs out of order relative to environments that ` +
          `already applied the later one. Re-stamp it with a current timestamp.`,
      );
    }
  }

  /* ---- Destructive statements in NEW migrations ---------------------------
   *
   * Only new ones. Existing migrations are immutable, so requiring a marker in
   * them would demand an edit this same script forbids — the historical ones
   * are grandfathered by construction, not by exception.
   *
   * `drop not null` is deliberately absent: widening a constraint is safe in
   * both directions during a rolling deploy. `set not null` is not, because the
   * version still running may insert a null. */
  const DESTRUCTIVE = [
    { pattern: /\bdrop\s+table\b/i, what: 'drop table' },
    { pattern: /\bdrop\s+column\b/i, what: 'drop column' },
    { pattern: /\bdrop\s+(?:materialized\s+)?view\b/i, what: 'drop view' },
    { pattern: /\balter\s+column\s+\S+\s+type\b/i, what: 'alter column type' },
    { pattern: /\bset\s+not\s+null\b/i, what: 'set not null' },
    { pattern: /\brename\s+(?:table|column|to)\b/i, what: 'rename' },
    { pattern: /\btruncate\b/i, what: 'truncate' },
    { pattern: /\bdelete\s+from\b(?![\s\S]{0,200}?\bwhere\b)/i, what: 'delete without where' },
  ];

  const ACK = /--\s*destructive-ok:\s*\S+/i;

  for (const file of added) {
    const sql = readFileSync(path.join(DIR, file), 'utf8');
    if (ACK.test(sql)) continue;

    /* Comments are stripped first, so prose describing a drop is not mistaken
     * for one. The comments in this repository routinely explain what a
     * migration deliberately does NOT do. */
    const code = sql
      .split('\n')
      .map((line) => line.replace(/--.*$/, ''))
      .join('\n')
      .replace(/\/\*[\s\S]*?\*\//g, '');

    for (const { pattern, what } of DESTRUCTIVE) {
      if (pattern.test(code)) {
        fail(
          `${file}: contains "${what}", which breaks the version still running during ` +
            `a rolling deploy (DEPLOYMENT.md §4).\n` +
            `      If it is genuinely safe — the column is unused by the deployed version, ` +
            `or this ships after that version is gone — say so explicitly:\n` +
            `        -- destructive-ok: <why this is safe with both versions live>`,
        );
      }
    }
  }
}

/* -------------------------------------------------------------------------- */

write(`Migrations: ${String(entries.length)} file(s) in ${DIR}.`);
if (gitChecksRan) write(`Compared against ${baseRef}.`);

if (problems.length > 0) {
  write();
  write('Migration safeguards failed:');
  write();
  for (const problem of problems) write(`  ${problem}`);
  write();
  process.exit(1);
}

write('All safeguards passed.');
