import pg from 'pg';

import type { Database, Queryable, QueryResult } from './database.js';
import { postgresTls } from './tls.js';

/**
 * The `pg`-backed Database used at runtime.
 *
 * Every transaction acquires a dedicated client from the pool and releases it in
 * a `finally`, because a connection leaked mid-transaction is both an outage
 * (the pool drains) and a correctness problem (the next borrower inherits a
 * transaction and, without `set_config(..., true)`, an identity).
 */
export interface PgDatabaseOptions {
  readonly connectionString: string;
  readonly max?: number;
  readonly ssl?: boolean;
  /** A PEM file path, or the PEM itself, for a provider with a private root. */
  readonly sslRootCert?: string | undefined;
  readonly statementTimeoutMs?: number;
}

export const createPgDatabase = (
  options: PgDatabaseOptions,
): Database & { close(): Promise<void> } => {
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: options.max ?? 10,
    ssl: postgresTls({
      ...(options.ssl === true ? { mode: 'require' } : {}),
      ...(options.sslRootCert === undefined ? {} : { rootCert: options.sslRootCert }),
    }),
    // An unbounded query on the path a child is standing in front of is worse
    // than a failed one.
    statement_timeout: options.statementTimeoutMs ?? 10_000,
  });

  const run = async <T>(
    client: pg.PoolClient | pg.Pool,
    sql: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<T>> => {
    const result = await client.query(sql, params ? [...params] : undefined);
    return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
  };

  return {
    query: async (sql, params) => await run(pool, sql, params),

    transaction: async (fn) => {
      const client = await pool.connect();
      try {
        await client.query('begin');
        const tx: Queryable = { query: async (sql, params) => await run(client, sql, params) };
        const result = await fn(tx);
        await client.query('commit');
        return result;
      } catch (error) {
        await client.query('rollback').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },

    close: async () => {
      await pool.end();
    },
  };
};
