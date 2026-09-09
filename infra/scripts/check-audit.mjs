#!/usr/bin/env node
/**
 * The dependency-audit gate.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS INSTEAD OF `pnpm audit --audit-level high`
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * That command fails this repository today, for three advisories in Expo's
 * build tooling. There are two bad ways to make it pass and one good one:
 *
 *   BAD  lower the threshold to `critical` — every future high advisory,
 *        including one on the request path, then passes silently.
 *   BAD  drop the step — the same, without leaving a trace.
 *   GOOD accept the three KNOWN advisories, by id, with a reason and a review
 *        date, and keep failing on everything else.
 *
 * An exception with an owner and a date is a decision. A lowered threshold is
 * the same decision taken once and then forgotten, and it silently widens.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT AN EXCEPTION DOES NOT DO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * It does not make the advisory untrue. It records that someone looked at the
 * paths, decided the risk is not on the request path, and accepted it until a
 * date. Past that date this script fails whether or not the advisory is still
 * open, because an exception nobody has revisited is not a decision any more.
 *
 *   node infra/scripts/check-audit.mjs              fail at high and above
 *   node infra/scripts/check-audit.mjs --level moderate
 */

import { execSync } from 'node:child_process';

/* -------------------------------------------------------------------------- */
/* Policy                                                                      */
/* -------------------------------------------------------------------------- */

const SEVERITY_ORDER = ['info', 'low', 'moderate', 'high', 'critical'];

/**
 * Accepted advisories.
 *
 * Every entry needs: why it is not reachable from anything we serve, and a date
 * by which somebody looks again. Adding one is a security decision — see
 * docs/SECURITY_AUDIT.md F-04, which is where these three were assessed.
 */
const ACCEPTED = [
  {
    id: 'GHSA-w3rx-r6r6-pgpr',
    package: 'image-size',
    reason:
      'Reached only through expo > @expo/cli > metro — build tooling that runs on a ' +
      'developer machine. Not in any server bundle, not on any request path, not in ' +
      'the API or web images (`pnpm why image-size` returns no path from apps/api).',
    reviewBy: '2026-11-30',
  },
  {
    id: 'GHSA-5p2g-fcmc-qvqq',
    package: 'image-size',
    reason: 'Same package and same paths as GHSA-w3rx-r6r6-pgpr.',
    reviewBy: '2026-11-30',
  },
  {
    id: 'GHSA-w5hq-g745-h8pq',
    package: 'uuid',
    reason:
      'Transitive through the same Expo build tooling. Moderate; a missing buffer ' +
      'bounds check in a code path the mobile bundler uses at build time.',
    reviewBy: '2026-11-30',
  },
];

/* -------------------------------------------------------------------------- */

const levelArgument = process.argv.indexOf('--level');
const threshold = levelArgument === -1 ? 'high' : (process.argv[levelArgument + 1] ?? 'high');

if (!SEVERITY_ORDER.includes(threshold)) {
  process.stderr.write(`Unknown severity "${threshold}".\n`);
  process.exit(2);
}

const atOrAbove = (severity) =>
  SEVERITY_ORDER.indexOf(severity) >= SEVERITY_ORDER.indexOf(threshold);

/* `pnpm audit --json` exits non-zero when it finds anything, so the exit code
 * is not the signal — the parsed report is. */
let report;
try {
  // A fixed command string, so there is nothing to escape and no argument
  // vector to concatenate. `pnpm` is a shell shim on Windows, which is why this
  // goes through a shell at all.
  const raw = execSync('pnpm audit --json', {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  report = JSON.parse(raw);
} catch (error) {
  const stdout = error?.stdout;
  if (typeof stdout === 'string' && stdout.trim() !== '') {
    try {
      report = JSON.parse(stdout);
    } catch {
      process.stderr.write('Could not parse `pnpm audit --json` output.\n');
      process.exit(2);
    }
  } else {
    // A registry that cannot be reached is not the same as a clean audit, and
    // must never be reported as one.
    process.stderr.write(`Dependency audit could not run: ${String(error)}\n`);
    process.exit(2);
  }
}

const advisories = Object.values(report.advisories ?? {});
const accepted = new Map(ACCEPTED.map((entry) => [entry.id, entry]));
const today = new Date().toISOString().slice(0, 10);

const blocking = [];
const waived = [];
const stale = [];

for (const advisory of advisories) {
  const id = advisory.github_advisory_id ?? String(advisory.id);
  const severity = advisory.severity ?? 'info';
  if (!atOrAbove(severity)) continue;

  const exception = accepted.get(id);
  if (!exception) {
    blocking.push({ id, severity, module: advisory.module_name, url: advisory.url });
  } else if (exception.reviewBy < today) {
    stale.push({ ...exception, severity });
  } else {
    waived.push({ ...exception, severity });
  }
}

/* An exception for an advisory that no longer appears is clutter that makes the
 * next reader trust the list less. Reported, but never fatal — a dependency bump
 * that fixes something must not fail the build. */
const present = new Set(advisories.map((a) => a.github_advisory_id ?? String(a.id)));
const obsolete = ACCEPTED.filter((entry) => !present.has(entry.id));

const write = (line = '') => process.stdout.write(`${line}\n`);

write(`Dependency audit — failing at "${threshold}" and above.`);
write();

for (const entry of waived) {
  write(`  accepted  ${entry.id}  ${entry.severity.padEnd(8)} ${entry.package}`);
  write(`            review by ${entry.reviewBy}`);
}
for (const entry of obsolete) {
  write(`  obsolete  ${entry.id}  no longer reported — remove it from ACCEPTED`);
}

if (stale.length > 0) {
  write();
  write('Exceptions past their review date:');
  for (const entry of stale) {
    write(`  EXPIRED   ${entry.id}  ${entry.package}  (review was due ${entry.reviewBy})`);
  }
}

if (blocking.length > 0) {
  write();
  write('Advisories with no accepted exception:');
  for (const entry of blocking) {
    write(`  BLOCKING  ${entry.id}  ${entry.severity.padEnd(8)} ${entry.module}`);
    if (entry.url) write(`            ${entry.url}`);
  }
}

if (blocking.length > 0 || stale.length > 0) {
  write();
  write(
    'Fix the dependency, or add an exception to infra/scripts/check-audit.mjs\n' +
      'with a reason and a review date. Adding one is a security decision.',
  );
  process.exit(1);
}

write();
write(`Clean: ${String(waived.length)} accepted, 0 blocking.`);
