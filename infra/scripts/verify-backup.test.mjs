import { describe, expect, it } from 'vitest';

import { analyseDump, verifyDump } from './verify-backup.mjs';

/**
 * Verifying that a backup is worth having.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THESE TESTS ARE ACTUALLY FOR
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The backup script cannot be run here — there is no Postgres on this machine
 * and no bucket to write to. What CAN be proven is the part that decides
 * whether a dump is trusted, and that is the part where a mistake is silent.
 *
 * The nightmare is not a backup that failed. It is one that ran every night for
 * a year, exited 0 every time, and produced a file missing the RLS policies —
 * so the eventual restore comes back serving traffic with no tenant isolation
 * and nothing visibly wrong.
 */

/** A dump with everything a real one has, sized past the floor. */
const goodDump = (overrides = {}) => {
  const tables = overrides.tables ?? 45;
  const policies = overrides.policies ?? 85;
  const forced = overrides.forced ?? tables;

  const parts = [
    '-- PostgreSQL database dump',
    'CREATE SCHEMA IF NOT EXISTS app;',
    'CREATE FUNCTION app.current_parent_id() RETURNS uuid AS $$ ... $$;',
    'CREATE FUNCTION app.owns_child(p uuid) RETURNS boolean AS $$ ... $$;',
    'CREATE TABLE "public"."schema_migrations" (version text primary key);',
    'CREATE TABLE "public"."children" (id uuid primary key);',
    'CREATE TABLE "public"."messages" (id uuid primary key);',
  ];

  for (let i = 0; i < tables - 3; i += 1) {
    parts.push(`CREATE TABLE "public"."filler_${String(i)}" (id uuid primary key);`);
  }
  for (let i = 0; i < policies; i += 1) {
    parts.push(`CREATE POLICY "p_${String(i)}" ON "public"."children" FOR SELECT USING (true);`);
  }
  for (let i = 0; i < tables; i += 1) {
    parts.push(`ALTER TABLE "public"."t_${String(i)}" ENABLE ROW LEVEL SECURITY;`);
  }
  for (let i = 0; i < forced; i += 1) {
    parts.push(`ALTER TABLE "public"."t_${String(i)}" FORCE ROW LEVEL SECURITY;`);
  }

  // Padding, so a valid fixture is not rejected merely for being short.
  parts.push(`-- ${'x'.repeat(20_000)}`);

  if (overrides.truncated !== true) parts.push('-- PostgreSQL database dump complete');

  return parts.join('\n');
};

const verify = (text, expectations) => verifyDump(text, Buffer.byteLength(text), expectations);

describe('a good dump', () => {
  it('passes', () => {
    const result = verify(goodDump());

    expect(result.ok).toBe(true);
    expect(result.problems).toEqual([]);
  });

  it('reports what it found, so an operator can sanity-check the numbers', () => {
    const found = analyseDump(goodDump({ tables: 50, policies: 85 }));

    expect(found.tables).toBe(50);
    expect(found.policies).toBe(85);
    expect(found.complete).toBe(true);
  });
});

describe('the failures that matter', () => {
  it('rejects a dump with no RLS policies', () => {
    /* ═══════════════════════════════════════════════════════════════════════
     * THE ASSERTION THIS FILE EXISTS FOR.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * A restore from this starts, serves traffic, passes a smoke test — and one
     * family can read another's conversations. It is a total confidentiality
     * failure that looks exactly like a successful recovery, which is why it
     * has to be caught in the file rather than noticed afterwards.
     */
    const result = verify(goodDump({ policies: 0 }));

    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toContain('no tenant isolation');
  });

  it('rejects a dump with too few policies, not merely zero', () => {
    // A partial dump is the realistic case: the connection dropped part way
    // through, and some policies made it.
    expect(verify(goodDump({ policies: 12 })).ok).toBe(false);
  });

  it('rejects tables that enable RLS without forcing it', () => {
    /* ENABLE alone lets the TABLE OWNER bypass every policy — and the owner is
     * the role the application connects as. A restore like this has policies
     * that read correctly and enforce nothing. */
    const result = verify(goodDump({ tables: 45, forced: 40 }));

    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toContain('bypass every policy');
  });

  it('rejects a truncated dump even when everything present is valid', () => {
    /* The broken-pipe case. Everything in the file parses; the file simply
     * stops. Without the completion marker there is no way to tell how much is
     * missing. */
    const result = verify(goodDump({ truncated: true }));

    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toContain('truncated');
  });

  it('rejects a file far too small to be a dump of this schema', () => {
    const result = verify('-- PostgreSQL database dump\n-- PostgreSQL database dump complete');

    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toContain('too small');
  });

  it('rejects a dump missing the functions every policy is written against', () => {
    /* The mirror of the missing-policies case, and quieter. The policies are
     * all there and they all call `app.owns_child`, which is not — so every
     * query returns nothing and the product looks empty rather than exposed. */
    const withoutFunctions = goodDump().replace(/CREATE FUNCTION app\.owns_child[^\n]*\n/, '');
    const result = verify(withoutFunctions);

    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toContain('app.owns_child');
  });

  it('rejects a dump missing the migration ledger', () => {
    // Restoring without it makes the next deploy try to apply every migration
    // from the beginning, against a database that already has them.
    const withoutLedger = goodDump().replace(
      /CREATE TABLE "public"\."schema_migrations"[^\n]*\n/,
      '',
    );

    expect(verify(withoutLedger).ok).toBe(false);
  });

  it('names every problem at once rather than stopping at the first', () => {
    // Somebody reading this at 3 a.m. during an incident should see the whole
    // picture in one go.
    const result = verify(goodDump({ policies: 0, truncated: true }));

    expect(result.problems.length).toBeGreaterThanOrEqual(2);
  });
});

describe('what it does not claim', () => {
  it('is a check on the file, not on the data', () => {
    /* A structurally perfect dump of an EMPTY database passes every check here,
     * and should: this verifies the artefact is intact, and only a restore into
     * a scratch database proves the rows are there. The distinction is stated
     * in the output so nobody reads a green tick as more than it is.
     */
    const emptyButValid = goodDump();

    expect(verify(emptyButValid).ok).toBe(true);
    // No COPY statements at all — no data whatsoever.
    expect(emptyButValid).not.toContain('COPY ');
  });
});
