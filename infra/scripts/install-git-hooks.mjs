#!/usr/bin/env node
/**
 * Installs git hooks via simple-git-hooks.
 *
 * Runs from the root `prepare` script. It must never fail the install: a fresh
 * clone that is not yet a git repository, a CI checkout, or a Docker build with
 * no `.git` directory are all normal, and none of them should break
 * `pnpm install`.
 *
 * The package's own postinstall is disabled in pnpm-workspace.yaml — we invoke it
 * here instead, so hook installation is explicit and skippable rather than a
 * third-party script running silently at install time.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

if (process.env.CI) {
  console.log('CI detected — skipping git hook installation.');
  process.exit(0);
}

if (!existsSync('.git')) {
  console.log('No .git directory — skipping git hook installation.');
  process.exit(0);
}

try {
  execFileSync('node', ['node_modules/simple-git-hooks/cli.js'], { stdio: 'pipe' });
  console.log('Git hooks installed (pre-commit: lint-staged, pre-push: typecheck).');
} catch (error) {
  // A missing hook is an inconvenience. A failed install is a blocked developer.
  const reason = error instanceof Error ? error.message : String(error);
  console.warn(`Could not install git hooks: ${reason}`);
  console.warn('Run `pnpm exec simple-git-hooks` manually once dependencies are installed.');
}
