#!/usr/bin/env node
/**
 * Secret scanner. Runs pre-commit and in CI.
 *
 * This is a safety net, not a security control — it catches the common shapes of
 * an accidentally committed credential. It cannot catch a secret that does not
 * match a known pattern, so it never replaces review.
 *
 * A hit means: rotate the credential first, then clean the history. Removing the
 * commit is not remediation — see SECURITY.md §5.
 */

import { readFileSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';

const PATTERNS = [
  { name: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'Private key block', re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { name: 'Stripe secret key', re: /\bsk_(?:live|test)_[0-9a-zA-Z]{16,}\b/ },
  { name: 'Stripe webhook secret', re: /\bwhsec_[0-9a-zA-Z]{16,}\b/ },
  { name: 'Anthropic API key', re: /\bsk-ant-[0-9A-Za-z_-]{20,}\b/ },
  { name: 'OpenAI API key', re: /\bsk-proj-[0-9A-Za-z_-]{20,}\b/ },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'Slack token', re: /\bxox[abprs]-[0-9A-Za-z-]{10,}\b/ },
  { name: 'GitHub token', re: /\bgh[pousr]_[0-9A-Za-z]{36,}\b/ },
  { name: 'JWT', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\./ },
  /*
   * `(?!\$\{)` — the password position must not be an interpolation.
   *
   * `postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/app` is not
   * a credential; it is the SHAPE of one, with the value supplied at run time
   * from the secret manager. Compose files and deployment workflows are full of
   * these by design, and flagging them trains people to skip the hook — which
   * costs far more than the pattern buys.
   *
   * Deliberately narrow: only the password position, only an interpolation. A
   * literal password on the same line is still caught, and every vendor
   * signature above is untouched.
   */
  {
    name: 'Postgres URL with password',
    re: /postgres(?:ql)?:\/\/[^:\s]+:(?!\$\{)[^@\s]{6,}@(?!localhost|127\.0\.0\.1)/,
  },
  {
    name: 'Redis URL with password',
    re: /redis(?:s)?:\/\/[^:\s]*:(?!\$\{)[^@\s]{6,}@(?!localhost|127\.0\.0\.1)/,
  },
  {
    name: 'Assigned secret-shaped literal',
    re: /\b(?:api[_-]?key|secret|password|passwd|token|private[_-]?key)\b\s*[:=]\s*['"][^'"\s]{16,}['"]/i,
    // A heuristic, not a signature: it fires on any long string assigned to a
    // secret-ish name. That is right for application code and wrong for a test
    // fixture, which legitimately assigns a long passphrase to such a name.
    //
    // Exempted in test files ONLY, and only this pattern — every vendor
    // signature above still applies everywhere, so a real AWS key or Stripe
    // secret pasted into a test is still caught. Suppressing the whole file
    // would be the mistake.
    skipInTests: true,
  },
];

/** Test files, where a password-shaped literal is expected rather than alarming. */
const TEST_FILE = /(^|\/)(tests?|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$/;

/** Placeholders that are supposed to be here. */
const ALLOWED = [
  /replace-me/i,
  /your-project-ref/i,
  /placeholder/i,
  /example/i,
  /\bxxx+\b/i,
  /changeme/i,
];

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.expo',
  '.turbo',
  'coverage',
]);
const SKIP_FILES = new Set(['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock']);
const TEXT_EXT = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.yaml',
  '.yml',
  '.md',
  '.sql',
  '.sh',
  '.env',
  '.example',
  '.toml',
  '.txt',
  '.html',
  '.css',
]);

const MAX_BYTES = 2 * 1024 * 1024;

function listFiles() {
  try {
    return execSync('git ls-files', { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
      .split('\n')
      .filter(Boolean);
  } catch {
    console.error('Not a git repository — nothing to scan.');
    process.exit(0);
  }
}

const findings = [];

for (const file of listFiles()) {
  const parts = file.split('/');
  if (parts.some((p) => SKIP_DIRS.has(p))) continue;
  if (SKIP_FILES.has(path.basename(file))) continue;

  const ext = path.extname(file);
  if (ext && !TEXT_EXT.has(ext) && !path.basename(file).startsWith('.env')) continue;

  let content;
  try {
    if (statSync(file).size > MAX_BYTES) continue;
    content = readFileSync(file, 'utf8');
  } catch {
    continue;
  }

  const isTest = TEST_FILE.test(file);

  content.split('\n').forEach((line, i) => {
    if (ALLOWED.some((a) => a.test(line))) return;
    for (const { name, re, skipInTests } of PATTERNS) {
      if (skipInTests === true && isTest) continue;
      if (re.test(line)) {
        // Never print the matched value — that would put the secret in CI logs.
        findings.push({ file, line: i + 1, name });
      }
    }
  });
}

if (findings.length > 0) {
  console.error('\n  POSSIBLE SECRETS DETECTED\n');
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}  ${f.name}`);
  }
  console.error(`\n  ${findings.length} finding(s).`);
  console.error('  If any is a real credential: ROTATE IT FIRST, then clean the history.');
  console.error('  Removing the commit is not remediation. See SECURITY.md §5.\n');
  process.exit(1);
}

console.log('No secret patterns detected.');
