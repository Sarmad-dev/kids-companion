/**
 * @kids/db — migrations and the database interface.
 *
 * Intentionally narrow: no query builder, no repositories, no domain logic. SQL
 * for the domain is written in `apps/api/src/repositories`, which is the only
 * place it lives (docs/DATABASE_CONVENTIONS.md §11).
 */

export { applyMigrations, loadMigrations } from './migrations.js';
export type { ApplyResult, Migration, SqlExecutor } from './migrations.js';
export { asParent, asSystem, setRlsIdentity } from './database.js';
export type { Database, Queryable, QueryResult } from './database.js';
export { createPgDatabase } from './pg.js';
export { postgresTls } from './tls.js';
export type { PostgresTlsOptions, PostgresTlsConfig } from './tls.js';
export type { PgDatabaseOptions } from './pg.js';
