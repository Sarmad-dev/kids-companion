import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';
import { applyMigrations, loadMigrations, type SqlExecutor } from '@kids/db';

/**
 * In-process PostgreSQL for schema and RLS tests.
 *
 * PGlite is real PostgreSQL compiled to WebAssembly, so policies, constraints,
 * triggers, and views behave as they do on a server — verified: a non-superuser
 * role under `SET ROLE` has RLS genuinely enforced against it. That is the
 * property these tests depend on, and it is why this is not a mock.
 *
 * Identity is assumed exactly as Supabase does it: by setting the
 * `request.jwt.claims` GUC to a JSON object with a `sub`. The same
 * `app.current_parent_id()` the policies call resolves it, so the tests exercise
 * the real code path rather than a test-only shortcut.
 *
 * Why not Testcontainers: it needs a Docker daemon, which turns "run the tests"
 * into a machine-setup problem. The suite proving one family cannot read another
 * family's child's conversations must be the one that always runs, not the one
 * people skip.
 *
 * KNOWN LIMITATION — version skew. PGlite is PostgreSQL 18; Supabase is
 * currently 15-17. Migrations are therefore written to PG15+ portable SQL and
 * `app.gen_uuid_v7()` is hand-rolled rather than using PG18's native `uuidv7()`.
 * This suite proves the policies are correct; it does not replace running the
 * migrations against the real target version before deploying.
 */

const MIGRATIONS_DIR = fileURLToPath(new URL('../../infra/migrations/', import.meta.url));

/** The role Supabase switches to for a signed-in request. Not the table owner. */
export const APP_ROLE = 'authenticated';

export interface TestDatabase {
  readonly db: PGlite;
  /** Runs a callback with RLS applied as the given parent, exactly as Supabase would. */
  asParent<T>(parentId: string, fn: () => Promise<T>): Promise<T>;
  /** Runs a callback with no identity — the deny-by-default case. */
  asAnonymous<T>(fn: () => Promise<T>): Promise<T>;
  /** Runs a callback with a deliberately malformed JWT claim. */
  withRawClaims<T>(claims: string, fn: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** Adapts PGlite to the driver-agnostic interface @kids/db applies migrations through. */
const asExecutor = (db: PGlite): SqlExecutor => ({
  exec: async (sql) => await db.exec(sql),
  query: async (sql, params) => await db.query(sql, params ? [...params] : undefined),
});

export const createTestDatabase = async (): Promise<TestDatabase> => {
  const db = await PGlite.create();

  await applyMigrations(asExecutor(db), await loadMigrations(MIGRATIONS_DIR));

  // Migrations run as the owner. Tests that exercise policies must not.
  const withClaims = async <T>(claims: string | null, fn: () => Promise<T>): Promise<T> => {
    await db.exec(`set role ${APP_ROLE};`);
    await db.query(`select set_config('request.jwt.claims', $1, false)`, [claims ?? '']);
    try {
      return await fn();
    } finally {
      await db.exec('reset role;');
      await db.query(`select set_config('request.jwt.claims', '', false)`);
    }
  };

  return {
    db,
    asParent: async (parentId, fn) =>
      await withClaims(JSON.stringify({ sub: parentId, role: 'authenticated' }), fn),
    asAnonymous: async (fn) => await withClaims(null, fn),
    withRawClaims: async (claims, fn) => await withClaims(claims, fn),
    close: async () => {
      await db.close();
    },
  };
};

/* -------------------------------------------------------------------------- */
/* Synthetic fixtures                                                          */
/* -------------------------------------------------------------------------- */
/*
 * Obviously fake, always. Never a real-looking name with a real-looking
 * birthday: plausible fake data eventually gets mistaken for real, or real data
 * gets pasted in beside it and nobody notices (docs/TESTING_STANDARDS.md §6).
 */

export interface SeededFamily {
  readonly parentId: string;
  readonly childId: string;
}

/** Seeds a parent with one child, as the owner (bypassing RLS). */
export const seedFamily = async (db: PGlite, label: string): Promise<SeededFamily> => {
  const parent = await db.query<{ id: string }>(
    `insert into parents (id, email, display_name)
     values (app.gen_uuid_v7(), $1, $2) returning id`,
    [`test-parent-${label}@example.invalid`, `Test Parent ${label.toUpperCase()}`],
  );
  const parentId = parent.rows[0]!.id;

  const child = await db.query<{ id: string }>(
    `insert into children (parent_id, display_name, birth_year, birth_month)
     values ($1, $2, 2019, 6) returning id`,
    [parentId, `Test Child ${label.toUpperCase()}`],
  );
  const childId = child.rows[0]!.id;

  await db.query(
    `insert into child_languages (child_id, language_code, is_primary) values ($1, 'en', true)`,
    [childId],
  );

  return { parentId, childId };
};

export interface SeededConversation {
  readonly conversationId: string;
  readonly messageId: string;
  readonly flagId: string;
}

/** Seeds a conversation with one message and a content flag on it. */
export const seedConversation = async (
  db: PGlite,
  childId: string,
): Promise<SeededConversation> => {
  const character = await db.query<{ id: string }>(
    `select id from ai_characters where status = 'active' order by sort_order limit 1`,
  );

  const conversation = await db.query<{ id: string }>(
    `insert into conversations (child_id, character_id) values ($1, $2) returning id`,
    [childId, character.rows[0]!.id],
  );
  const conversationId = conversation.rows[0]!.id;

  const message = await db.query<{ id: string }>(
    `insert into messages (conversation_id, child_id, role, sequence, content_ciphertext, content_key_id, content_length)
     values ($1, $2, 'child', 0, decode('00ff', 'hex'), 'k1', 12) returning id`,
    [conversationId, childId],
  );
  const messageId = message.rows[0]!.id;

  const flag = await db.query<{ id: string }>(
    `insert into content_flags (child_id, message_id, layer, decision, severity)
     values ($1, $2, 'L1', 'allowed', 'low') returning id`,
    [childId, messageId],
  );

  return { conversationId, messageId, flagId: flag.rows[0]!.id };
};

/** Seeds a free subscription and one succeeded transaction. */
export const seedBilling = async (
  db: PGlite,
  parentId: string,
  label: string,
): Promise<{ subscriptionId: string }> => {
  const subscription = await db.query<{ id: string }>(
    `insert into subscriptions (parent_id, plan_id, rail, status, currency, price_minor)
     select $1, p.id, 'mock', 'active', p.currency, p.price_minor
     from subscription_plans p where p.code = 'family_monthly'
     returning id`,
    [parentId],
  );
  const subscriptionId = subscription.rows[0]!.id;

  await db.query(
    `insert into transactions
       (subscription_id, parent_id, rail, external_id, kind, status, amount_minor, currency, occurred_at)
     values ($1, $2, 'mock', $3, 'charge', 'succeeded', 49900, 'PKR', now())`,
    [subscriptionId, parentId, `txn_${label}_1`],
  );

  return { subscriptionId };
};
