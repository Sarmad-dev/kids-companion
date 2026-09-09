import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Migration loading and application.
 *
 * Deliberately driver-agnostic: it takes anything that can execute SQL, so the
 * same code applies migrations to a real Postgres connection (`pg`) and to the
 * in-process PGlite instance the integration tests use. One code path means the
 * migrations the tests verify are the migrations production runs.
 *
 * Forward-only. See docs/DATABASE_CONVENTIONS.md §7.
 */

export interface Migration {
  readonly version: string;
  readonly sql: string;
  readonly checksum: string;
}

/** The minimum surface a driver must provide. */
export interface SqlExecutor {
  exec(sql: string): Promise<unknown>;
  query<T = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: T[] }>;
}

const MIGRATION_FILE = /^\d{14}_[a-z0-9_]+\.sql$/;

const checksumOf = (sql: string): string =>
  createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex').slice(0, 32);

/** Reads migrations from disk, sorted by version. Filename order is apply order. */
export const loadMigrations = async (directory: string): Promise<Migration[]> => {
  const entries = await readdir(directory);
  const files = entries.filter((f) => MIGRATION_FILE.test(f)).sort();

  const rejected = entries.filter((f) => f.endsWith('.sql') && !MIGRATION_FILE.test(f));
  if (rejected.length > 0) {
    throw new Error(
      `Migration filenames must be <14-digit-timestamp>_<snake_case>.sql. Rejected: ${rejected.join(', ')}`,
    );
  }

  return await Promise.all(
    files.map(async (file) => {
      const sql = await readFile(path.join(directory, file), 'utf8');
      return { version: file.replace(/\.sql$/, ''), sql, checksum: checksumOf(sql) };
    }),
  );
};

export interface ApplyResult {
  readonly applied: readonly string[];
  readonly skipped: readonly string[];
}

/**
 * Applies every migration not yet recorded in `schema_migrations`.
 *
 * A checksum mismatch on an already-applied migration is a hard error: it means
 * someone edited a merged migration, which produces a database that does not
 * match what other environments ran. That is the failure this ledger exists to
 * catch, so it fails loudly rather than skipping quietly.
 */
export const applyMigrations = async (
  db: SqlExecutor,
  migrations: readonly Migration[],
): Promise<ApplyResult> => {
  const applied: string[] = [];
  const skipped: string[] = [];

  // The first migration creates the ledger, so tolerate its absence here.
  let recorded: Map<string, string>;
  try {
    const existing = await db.query<{ version: string; checksum: string }>(
      'select version, checksum from schema_migrations',
    );
    recorded = new Map(existing.rows.map((r) => [r.version, r.checksum]));
  } catch {
    recorded = new Map();
  }

  for (const migration of migrations) {
    const previous = recorded.get(migration.version);

    if (previous !== undefined) {
      if (previous !== migration.checksum) {
        throw new Error(
          `Migration ${migration.version} was edited after being applied ` +
            `(recorded ${previous}, found ${migration.checksum}). ` +
            'Merged migrations are immutable — write a new one instead.',
        );
      }
      skipped.push(migration.version);
      continue;
    }

    // Each migration runs in its own transaction, so a failure leaves an
    // obvious question about exactly one file.
    await db.exec('begin');
    try {
      await db.exec(migration.sql);
      await db.query('insert into schema_migrations (version, checksum) values ($1, $2)', [
        migration.version,
        migration.checksum,
      ]);
      await db.exec('commit');
      applied.push(migration.version);
    } catch (error) {
      await db.exec('rollback');
      throw new Error(
        `Migration ${migration.version} failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  return { applied, skipped };
};
