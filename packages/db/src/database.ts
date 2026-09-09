/**
 * The database interface the application is written against.
 *
 * Deliberately minimal and driver-agnostic. `apps/api` depends on this, not on
 * `pg`, which is what lets the integration tests drive the real routes against
 * real SQL and real RLS policies in PGlite — with no Docker daemon, and with no
 * mock standing in for the thing most worth testing.
 */

export interface QueryResult<T> {
  readonly rows: T[];
  readonly rowCount: number;
}

export interface Queryable {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<T>>;
}

export interface Database extends Queryable {
  /**
   * Runs `fn` inside a transaction, rolling back on throw.
   *
   * The callback receives a `Queryable` bound to that transaction, so a caller
   * cannot accidentally issue a statement on a different connection and have it
   * silently escape the rollback.
   */
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
}

/**
 * Identity for Row Level Security.
 *
 * Set with `is_local = true` so it applies for the duration of the transaction
 * and is discarded at commit. On a pooled connection a non-local setting would
 * leak one request's identity into the next request that borrowed the same
 * connection — a cross-tenant data leak with no code path that looks wrong.
 */
export const setRlsIdentity = async (tx: Queryable, parentId: string | null): Promise<void> => {
  const claims = parentId === null ? '' : JSON.stringify({ sub: parentId, role: 'authenticated' });
  await tx.query('select set_config($1, $2, true)', ['request.jwt.claims', claims]);
};

/**
 * The two identities the API operates under.
 *
 * The pool connects as a privileged role. Requests do not run that way: they
 * drop to `authenticated` for the duration of a transaction, which is what makes
 * RLS apply at all — policies are written `to authenticated`, and a privileged
 * connection is simply not subject to them.
 *
 *   asParent — user data. Drops to `authenticated` and sets the JWT claim, so
 *              every policy in the schema is in force.
 *   asSystem — operations no signed-in user may perform: creating an account,
 *              minting a session, writing an audit record. Stays privileged.
 *
 * The split is the point. `authenticated` has no INSERT on `parents` precisely
 * so that registration cannot be something a signed-in user does, and no SELECT
 * on `audit_logs` so a principal cannot read the record of their own actions.
 * Anything reaching for `asSystem` is asking to bypass RLS and should be as
 * obvious in a diff as it is here.
 */
export const APP_REQUEST_ROLE = 'authenticated';

export const asParent = async <T>(
  db: Database,
  parentId: string,
  fn: (tx: Queryable) => Promise<T>,
): Promise<T> =>
  await db.transaction(async (tx) => {
    // LOCAL: reverts at commit, so a pooled connection cannot carry the role
    // into whatever request borrows it next.
    await tx.query(`set local role ${APP_REQUEST_ROLE}`);
    await setRlsIdentity(tx, parentId);
    return await fn(tx);
  });

export const asSystem = async <T>(db: Database, fn: (tx: Queryable) => Promise<T>): Promise<T> =>
  await db.transaction(async (tx) => {
    // No identity, and no role drop. Reads of `parents` here are by email during
    // login, before a parent is known — there is no claim to set.
    await setRlsIdentity(tx, null);
    return await fn(tx);
  });
