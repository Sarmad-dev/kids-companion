#!/usr/bin/env node
/**
 * Validates the deployment contract without needing Docker.
 *
 * A compose file that references an undocumented variable fails at `up` time,
 * on someone else's machine, with a message about an empty string. These checks
 * are cheap and catch the whole class before it leaves the repository:
 *
 *   1. Every `${VAR}` the staging compose file interpolates is either declared
 *      in `.env.staging.example` or carries an inline default.
 *   2. Every Dockerfile and env_file it references exists.
 *   3. No secret-looking literal is committed in a compose file or a template.
 *   4. Every config key the API requires at boot appears in the templates that
 *      are supposed to describe it.
 *
 * Deliberately does NOT try to be a Docker linter. It checks the contract
 * between this repository's files, which is the part that rots.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const problems = [];
const note = (file, message) => problems.push(`${file}: ${message}`);

const read = (file) => readFileSync(file, 'utf8');

/** Keys declared in a dotenv-style template. */
const templateKeys = (file) =>
  new Set(
    read(file)
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#'))
      .map((line) => line.split('=')[0]?.trim())
      .filter(Boolean),
  );

/* -------------------------------------------------------------------------- */
/* 1 + 2. The staging compose file                                             */
/* -------------------------------------------------------------------------- */

const COMPOSE = 'infra/docker/docker-compose.staging.yml';
const STAGING_TEMPLATE = '.env.staging.example';

if (!existsSync(COMPOSE)) {
  note(COMPOSE, 'is missing — staging cannot be started without it');
} else {
  const compose = read(COMPOSE);
  const declared = existsSync(STAGING_TEMPLATE) ? templateKeys(STAGING_TEMPLATE) : new Set();

  /* `${VAR}`, `${VAR:-default}`, `${VAR:?message}`. Only the bare form has to be
   * documented: the other two carry their own answer. */
  for (const match of compose.matchAll(/\$\{([A-Z0-9_]+)([:?}-][^}]*)?\}/g)) {
    const name = match[1];
    const suffix = match[2] ?? '}';
    const hasDefault = suffix.startsWith(':-') || suffix.startsWith(':?');

    if (!hasDefault && !declared.has(name)) {
      note(
        COMPOSE,
        `interpolates \${${name}} with no default, and ${STAGING_TEMPLATE} does not declare it`,
      );
    }
  }

  // Referenced build files must exist, or the failure is a build error minutes in.
  for (const match of compose.matchAll(/dockerfile:\s*(\S+)/g)) {
    const target = match[1];
    if (!existsSync(target)) note(COMPOSE, `references a missing Dockerfile: ${target}`);
  }

  // `env_file` paths are relative to the compose file's own directory.
  const composeDir = path.dirname(COMPOSE);
  for (const match of compose.matchAll(
    /^\s*-\s*(\.\.\/[^\s#]+\.env[^\s#]*|\.\.\/[^\s#]*\.env)/gm,
  )) {
    const target = path.join(composeDir, match[1]);
    // The real file is git-ignored by design; the template beside it is what
    // must exist, so an operator has something to copy.
    if (!existsSync(target) && !existsSync(`${target}.example`)) {
      note(COMPOSE, `env_file ${match[1]} has neither a file nor a .example template`);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* 3. Nothing that looks like a real credential                                */
/* -------------------------------------------------------------------------- */

/* Narrow on purpose. `check-no-secrets.mjs` owns the broad scan; this catches
 * the specific mistake of filling in a template or a compose file "just to test
 * it" and committing the result. */
const CREDENTIAL_SHAPED = [
  { pattern: /\bsk-[A-Za-z0-9]{16,}/, what: 'an API key' },
  { pattern: /\bAKIA[0-9A-Z]{12,}/, what: 'an AWS access key id' },
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, what: 'a private key' },
  { pattern: /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/, what: 'a JWT' },
];

for (const file of [
  COMPOSE,
  'infra/docker/docker-compose.yml',
  '.env.example',
  '.env.staging.example',
  '.env.production.example',
]) {
  if (!existsSync(file)) continue;
  const content = read(file);
  for (const { pattern, what } of CREDENTIAL_SHAPED) {
    if (pattern.test(content)) note(file, `contains something shaped like ${what}`);
  }
}

/* -------------------------------------------------------------------------- */
/* 4. No workflow can print a secret                                           */
/* -------------------------------------------------------------------------- */

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * GITHUB'S MASKING IS A SAFETY NET, NOT A CONTROL.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Registered secrets are replaced with `***` in logs, which covers the obvious
 * case and misses several real ones: a value transformed before printing
 * (base64, a substring, JSON-encoded) is no longer the registered string and is
 * not masked; `env` and `printenv` dump everything the step can see; and
 * `set -x` echoes the expanded command line of every subsequent command.
 *
 * So the rule enforced here is not "mask secrets", it is "do not write them
 * anywhere". Build logs are readable by anyone with read access to the
 * repository, and for a public repository that is everyone.
 */
const SECRET_LEAKS = [
  {
    pattern: /\b(?:echo|printf)\b[^\n]*\$\{\{\s*secrets\./,
    what: 'echoes a secret',
    fix: 'pass it through `env:` on the step, or use an action that takes it as an input',
  },
  {
    pattern: /^\s*run:\s*(?:\||>)?[^\n]*\b(?:printenv|env)\s*$/m,
    what: 'dumps the whole environment',
    fix: 'print only the specific value you need, and never a credential',
  },
  {
    pattern: /set\s+-[a-z]*x/,
    what: 'enables shell tracing, which echoes every expanded command line',
    fix: 'remove `set -x`; use `set -euo pipefail` without it',
  },
  {
    pattern: /\$\{\{\s*secrets\.[A-Z0-9_]+\s*\}\}[^\n]*>>\s*"?\$GITHUB_(?:OUTPUT|STEP_SUMMARY|ENV)/,
    what: 'writes a secret to an output, summary, or environment file',
    fix: 'these are readable artifacts; keep the value inside the step that needs it',
  },
];

const workflowDir = '.github/workflows';
if (existsSync(workflowDir)) {
  for (const file of readdirSync(workflowDir).filter((name) => /\.ya?ml$/.test(name))) {
    const full = path.join(workflowDir, file);
    const content = read(full);

    for (const { pattern, what, fix } of SECRET_LEAKS) {
      if (pattern.test(content)) note(full, `${what} — ${fix}`);
    }

    // `pull_request_target` runs with repository secrets AND the base
    // repository's permissions, against a fork's code. Combined with a checkout
    // of the fork's ref it hands write credentials to anyone who opens a pull
    // request. There is no use for it here.
    if (/^\s*pull_request_target\s*:/m.test(content)) {
      note(full, 'uses pull_request_target, which exposes secrets to fork pull requests');
    }
  }
}

/* -------------------------------------------------------------------------- */
/* 5. Deployment-critical keys are described somewhere an operator will look    */
/* -------------------------------------------------------------------------- */

const REQUIRED_IN_TEMPLATES = [
  'WORKER_PORT',
  'WORKER_SUBSCRIPTION_SWEEP_INTERVAL_MS',
  'WORKER_PAYMENT_RECONCILE_INTERVAL_MS',
  'WORKER_STORE_SYNC_INTERVAL_MS',
  'READINESS_PROBE_TIMEOUT_MS',
];

for (const template of ['.env.example', '.env.staging.example', '.env.production.example']) {
  if (!existsSync(template)) {
    note(template, 'is missing — it is the environment contract for that tier');
    continue;
  }
  const keys = templateKeys(template);
  for (const key of REQUIRED_IN_TEMPLATES) {
    if (!keys.has(key)) note(template, `does not document ${key}`);
  }
}

/* -------------------------------------------------------------------------- */

if (problems.length > 0) {
  process.stderr.write(`Deployment configuration problems:\n\n`);
  for (const problem of problems) process.stderr.write(`  ${problem}\n`);
  process.stderr.write('\n');
  process.exit(1);
}

process.stdout.write('Deployment configuration is consistent.\n');
