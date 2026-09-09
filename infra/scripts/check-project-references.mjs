#!/usr/bin/env node
/**
 * Every workspace dependency must also be a TypeScript project reference.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE BUG THIS EXISTS TO PREVENT ONLY APPEARS ON A CLEAN CHECKOUT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `tsc -b` decides BUILD ORDER from `references`, not from package.json. A
 * package that imports `@kids/voice` without referencing it compiles fine on a
 * machine where `services/voice/dist` already exists from an earlier build —
 * and fails with `TS2307: Cannot find module '@kids/voice'` on a runner that
 * starts from nothing.
 *
 * So it passes for everyone who has built the repository before, and fails for
 * CI, every time, on every pull request. It was found exactly that way: by
 * running the pipeline against a pristine copy of the tree.
 *
 * The reverse direction is checked too. A reference to a package that is not a
 * declared dependency builds something this package does not use, and hides a
 * phantom import that `import-x/no-extraneous-dependencies` would otherwise
 * catch.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const WORKSPACE_DIRS = ['apps', 'packages', 'services'];

const problems = [];
const write = (line = '') => process.stdout.write(`${line}\n`);

/**
 * Reads tsconfig, which is JSONC rather than JSON.
 *
 * Scanned character by character rather than with a regex. A regex that strips
 * block comments also matches the slash-star sequence inside an ordinary glob
 * such as a recursive wildcard path, and silently corrupts the file it is
 * trying to read. Comments only count outside string literals.
 */
const readTsconfig = (file) => {
  const source = readFileSync(file, 'utf8');
  let out = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];

    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      out += '\n';
      continue;
    }
    if (char === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 1;
      continue;
    }
    out += char;
  }

  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
};

/* Map every workspace package name to its directory. */
const packages = new Map();
for (const group of WORKSPACE_DIRS) {
  if (!existsSync(group)) continue;
  for (const entry of readdirSync(group)) {
    const manifest = path.join(group, entry, 'package.json');
    if (!existsSync(manifest)) continue;
    const { name } = JSON.parse(readFileSync(manifest, 'utf8'));
    if (name) packages.set(name, path.join(group, entry));
  }
}

let checked = 0;

for (const dir of packages.values()) {
  const tsconfigPath = path.join(dir, 'tsconfig.json');
  if (!existsSync(tsconfigPath)) continue;

  const tsconfig = readTsconfig(tsconfigPath);

  /* Only projects that actually emit declarations participate in `tsc -b`
   * ordering. `apps/web` and `apps/mobile` are bundler-compiled and reference
   * nothing, which is correct for them. */
  if (!Array.isArray(tsconfig.references)) continue;
  checked += 1;

  const manifest = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const workspaceDeps = Object.keys({
    ...manifest.dependencies,
    ...manifest.devDependencies,
  }).filter((dependency) => packages.has(dependency));

  const referenced = new Set(
    tsconfig.references
      .map((reference) => path.normalize(path.join(dir, reference.path)))
      .map((resolved) => resolved.replace(/\\/g, '/')),
  );

  for (const dependency of workspaceDeps) {
    const expected = (packages.get(dependency) ?? '').replace(/\\/g, '/');
    if (!referenced.has(expected)) {
      problems.push(
        `${tsconfigPath}: depends on ${dependency} but does not reference it.\n` +
          `      tsc -b takes build order from references, so this compiles only\n` +
          `      where ${expected}/dist already exists. It fails on a clean checkout.\n` +
          `      Add: { "path": "${path.relative(dir, expected).replace(/\\/g, '/')}" }`,
      );
    }
  }

  for (const reference of referenced) {
    const referencedName = [...packages.entries()].find(
      ([, directory]) => directory.replace(/\\/g, '/') === reference,
    )?.[0];
    if (referencedName && !workspaceDeps.includes(referencedName)) {
      problems.push(
        `${tsconfigPath}: references ${referencedName} but does not depend on it.\n` +
          `      Either add it to package.json, or drop the reference.`,
      );
    }
  }
}

write(`Project references: checked ${String(checked)} package(s).`);

if (problems.length > 0) {
  write();
  write('Mismatches between package.json dependencies and tsconfig references:');
  write();
  for (const problem of problems) write(`  ${problem}`);
  write();
  process.exit(1);
}

write('Every workspace dependency is referenced, and every reference is a dependency.');
