import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { SESSION_COOKIE_NAME, sessionCookieOptions } from './session';

const SRC = fileURLToPath(new URL('..', import.meta.url));

const filesUnder = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return filesUnder(full);
    return entry.name.endsWith('.tsx') || entry.name.endsWith('.ts') ? [full] : [];
  });

describe('the session cookie', () => {
  it('cannot be read by client JavaScript', () => {
    // The whole reason the dashboard fetches on the server. An XSS in this app
    // finds nothing in `document` to steal.
    expect(sessionCookieOptions.httpOnly).toBe(true);
  });

  it('is not sent on cross-site requests', () => {
    // Strict rather than Lax: nothing here is meant to be reachable by following
    // a link from somewhere else, so there is no navigation to accommodate.
    expect(sessionCookieOptions.sameSite).toBe('strict');
  });

  it('is scoped to the whole app and expires on its own', () => {
    expect(sessionCookieOptions.path).toBe('/');
    expect(sessionCookieOptions.maxAge).toBe(60 * 60 * 12);
  });

  it('has a name that says nothing about what it holds', () => {
    expect(SESSION_COOKIE_NAME).toBe('kc_session');
    expect(SESSION_COOKIE_NAME).not.toMatch(/token|jwt|auth|bearer/i);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE TOKEN NEVER REACHES A CLIENT COMPONENT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `httpOnly` protects the cookie from the browser. This protects it from us: a
 * client component that imported the API client would have the token compiled
 * into the browser bundle, and nothing about that would look wrong in review.
 */
describe('the client/server boundary', () => {
  const clientFiles = filesUnder(SRC).filter((file) => {
    const source = readFileSync(file, 'utf8');
    return source.startsWith("'use client'") || source.startsWith('"use client"');
  });

  it('has client components, so this test is testing something', () => {
    expect(clientFiles.length).toBeGreaterThan(0);
  });

  it('never imports the API client or the session into a client component', () => {
    for (const file of clientFiles) {
      const source = readFileSync(file, 'utf8');
      expect(source, `${file} imports lib/api`).not.toMatch(/from '[^']*lib\/api'/);
      expect(source, `${file} imports lib/session`).not.toMatch(/from '[^']*lib\/session'/);
    }
  });

  it('never reads a secret environment variable outside the server-only modules', () => {
    // `API_BASE_URL` is the only configured value this app reads, and it is read
    // in exactly one module. `NODE_ENV` is allowed anywhere — it is a build-time
    // constant, not configuration, and it is what decides whether the cookie is
    // marked Secure. Anything else appearing in a page would be a value with a
    // real chance of ending up in a bundle.
    const allowed = new Set([join(SRC, 'lib', 'api.ts')]);

    for (const file of filesUnder(SRC)) {
      if (allowed.has(file) || file.endsWith('.test.ts')) continue;

      const source = readFileSync(file, 'utf8');
      const names = [...source.matchAll(/process\.env(?:\.(\w+)|\['(\w+)'\])/g)].map(
        (match) => match[1] ?? match[2],
      );

      for (const name of names) {
        expect(name, `${file} reads process.env.${name ?? '?'}`).toBe('NODE_ENV');
      }
    }
  });
});
