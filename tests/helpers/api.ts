import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';
import type { AIProvider } from '@kids/ai';
import type { MetricsRegistry } from '@kids/analytics';
import { parseConfig } from '@kids/config';
import { applyMigrations, loadMigrations, type Database, type Queryable } from '@kids/db';
import {
  createRailRegistry,
  type MobileStore,
  type RailRegistry,
  type StoreBillingProvider,
  type SubscriptionProvider,
} from '@kids/payments';
import type { SpeechAnalysisProvider } from '@kids/practice';
import type { SpeechToTextProvider, TextToSpeechProvider } from '@kids/voice';

import { buildApp, type App } from '../../apps/api/src/app.js';
import { createAuditLogger } from '../../apps/api/src/audit.js';
import { createPaymentStore, type PaymentStore } from '../../apps/api/src/payment-store.js';

/**
 * A real API instance over a real database, for integration tests.
 *
 * Everything is genuine except the network: the routes, plugins, Zod validation,
 * response serialisation, SQL, and RLS policies are all the production ones.
 * `app.inject()` drives the full request lifecycle without binding a port.
 *
 * PGlite is real PostgreSQL compiled to WebAssembly, so `set_config` inside a
 * transaction, policy evaluation, and constraint enforcement behave exactly as
 * they do on a server. That matters here more than anywhere else in the repo:
 * these tests are the evidence that one family cannot reach another's data.
 */

const MIGRATIONS_DIR = fileURLToPath(new URL('../../infra/migrations/', import.meta.url));

/**
 * Adapts PGlite to the `Database` interface.
 *
 * PGlite is a single connection, so a "transaction" is genuinely serial. That is
 * a limitation worth naming: it means these tests cannot surface a concurrency
 * bug that only appears with a real pool. What they do prove is that the SQL,
 * the identity plumbing, and the policies are correct.
 */
/** Exported so a suite can drive a store directly, outside a request. */
export const pgliteDatabase = (db: PGlite): Database => ({
  query: async (sql, params) => {
    const result = await db.query(sql, params ? [...params] : undefined);
    return { rows: result.rows as never[], rowCount: result.rows.length };
  },

  transaction: async (fn) => {
    await db.exec('begin');
    try {
      const tx: Queryable = {
        query: async (sql, params) => {
          const result = await db.query(sql, params ? [...params] : undefined);
          return { rows: result.rows as never[], rowCount: result.rows.length };
        },
      };
      const value = await fn(tx);
      await db.exec('commit');
      return value;
    } catch (error) {
      await db.exec('rollback');
      throw error;
    }
  },
});

/**
 * Watches, counts, and optionally breaks database traffic.
 *
 * The counter answers "how many statements did that request run?", which is the
 * only cheap way to catch an N+1 before it is a production incident. The fault
 * injector answers "what does this endpoint do when the database is gone?",
 * which is the least-exercised path in any application precisely because
 * provoking it normally means breaking something real.
 */
export interface DatabaseProbe {
  /** Statements executed since the last reset. */
  count(): number;
  /** Every statement since the last reset, for diagnosing an N+1. */
  statements(): readonly string[];
  reset(): void;
  /** Makes every subsequent query fail, as an unreachable database would. */
  fail(message?: string): void;
  /** Restores normal service. */
  heal(): void;
}

export interface ApiHarness {
  readonly app: App;
  readonly db: PGlite;
  /**
   * The payment store, for driving payments outside a request.
   *
   * Reconciliation has no HTTP route — it is a sweep — so a test that cannot
   * reach it cannot cover the case where a customer paid and was never
   * credited.
   */
  readonly paymentStore: PaymentStore;
  /** See {@link DatabaseProbe}. */
  readonly database: DatabaseProbe;
  /** Advances the clock the app sees, for expiry tests. */
  setNow(date: Date): void;
  close(): Promise<void>;
}

export interface HarnessOptions {
  /**
   * Replaces the AI provider.
   *
   * The only way to drive a real timeout, a real outage, or a permissive
   * classifier through the real routes. Tests that need those build their own
   * harness rather than mutating a shared one.
   */
  readonly aiProvider?: AIProvider;
  readonly sttProvider?: SpeechToTextProvider;
  readonly ttsProvider?: TextToSpeechProvider;
  readonly analysisProvider?: SpeechAnalysisProvider;
  /**
   * Replaces the payment rail.
   *
   * Needed to drive a rail that REFUSES — a cancellation the vendor rejects, an
   * outage mid-checkout. Webhook tests do not need it: they sign their own
   * requests with the same secret the default mock rail verifies against, so
   * they exercise real verification rather than a bypass.
   */
  readonly subscriptionProvider?: SubscriptionProvider;
  /**
   * Replaces the payment rail registry.
   *
   * The default harness has NO rails, which is the product's default state and
   * the one most worth testing. A suite that needs a rail builds its own.
   */
  readonly railRegistry?: RailRegistry;
  /**
   * Replaces the mobile store providers.
   *
   * The default harness has none, which is the product default and the state
   * most worth testing: app-store billing being absent must change nothing.
   */
  readonly storeProviders?: readonly (readonly [MobileStore, StoreBillingProvider])[];
  /**
   * Replaces the metrics registry.
   *
   * Injected so a suite can read back exactly what was recorded — above all,
   * that nothing identifying ever reached a label.
   */
  readonly metricsRegistry?: MetricsRegistry;
  /** Extra config overrides, for limit and rate-limit tests. */
  readonly env?: Readonly<Record<string, string>>;
}

/** Wraps a Database so a test can count its traffic and cut it off. */
export const instrumentDatabase = (
  inner: Database,
): { database: Database; probe: DatabaseProbe } => {
  let statements: string[] = [];
  let failure: string | undefined;

  const guard = (sql: string): void => {
    statements.push(sql.replace(/\s+/g, ' ').trim().slice(0, 120));
    if (failure !== undefined) throw new Error(failure);
  };

  const database: Database = {
    query: async (sql, params) => {
      guard(sql);
      return await inner.query(sql, params);
    },
    transaction: async (fn) =>
      await inner.transaction(async (tx) => {
        return await fn({
          query: async (sql, params) => {
            guard(sql);
            return await tx.query(sql, params);
          },
        });
      }),
  };

  return {
    database,
    probe: {
      count: () => statements.length,
      statements: () => [...statements],
      reset: () => {
        statements = [];
      },
      fail: (message = 'database is unreachable') => {
        failure = message;
      },
      heal: () => {
        failure = undefined;
      },
    },
  };
};

export const createApiHarness = async (options: HarnessOptions = {}): Promise<ApiHarness> => {
  const pg = await PGlite.create();

  await applyMigrations(
    {
      exec: async (sql) => await pg.exec(sql),
      query: async (sql, params) => await pg.query(sql, params ? [...params] : undefined),
    },
    await loadMigrations(MIGRATIONS_DIR),
  );

  // The connection stays privileged, exactly as the production pool does. Each
  // request drops to `authenticated` inside its own transaction via asParent(),
  // so the policies are genuinely in force for user data while system operations
  // (registration, session minting, audit writes) still work.

  let current = new Date();

  const config = parseConfig({
    APP_ENV: 'ci',
    NODE_ENV: 'test',
    // Overridable so a failing suite can be debugged: TEST_LOG_LEVEL=error pnpm test:integration
    LOG_LEVEL: process.env.TEST_LOG_LEVEL ?? 'fatal',
    AUTH_PROVIDER: 'local',
    // Argon2id at production parameters costs ~50 ms per hash, and these suites
    // hash on nearly every request. Lowered here ONLY — the config schema floors
    // the real values, so this cannot leak into a deployed environment.
    PASSWORD_HASH_MEMORY_KIB: '19456',
    PASSWORD_HASH_ITERATIONS: '2',
    PASSWORD_HASH_PARALLELISM: '1',
    PARENT_GATE_MAX_ATTEMPTS: '5',
    PARENT_GATE_LOCKOUT_MINUTES: '15',
    // The production limit (10 per 15 min) is what makes online guessing
    // impractical, and it is deliberately low enough that a full suite exhausts
    // it. Raised here so the tests exercise auth rather than the limiter; a
    // dedicated test drives the limiter itself with a low value.
    RATE_LIMIT_AUTH_PER_15_MIN: '10000',
    // Same reasoning for the conversation limiter: the suite would exhaust the
    // production value long before it finished exercising the routes. The
    // limiter itself is driven by a dedicated harness with a low value.
    RATE_LIMIT_CONVERSATION_PER_MINUTE: '10000',
    RATE_LIMIT_CONVERSATION_START_PER_HOUR: '10000',
    RATE_LIMIT_VOICE_PER_MINUTE: '10000',
    ...options.env,
  });

  const { database: instrumented, probe } = instrumentDatabase(pgliteDatabase(pg));

  const app = await buildApp({
    config,
    db: instrumented,
    now: () => current,
    ...(options.aiProvider ? { aiProvider: options.aiProvider } : {}),
    ...(options.sttProvider ? { sttProvider: options.sttProvider } : {}),
    ...(options.ttsProvider ? { ttsProvider: options.ttsProvider } : {}),
    ...(options.analysisProvider ? { analysisProvider: options.analysisProvider } : {}),
    ...(options.subscriptionProvider ? { subscriptionProvider: options.subscriptionProvider } : {}),
    ...(options.railRegistry ? { railRegistry: options.railRegistry } : {}),
    ...(options.storeProviders ? { storeProviders: options.storeProviders } : {}),
    ...(options.metricsRegistry ? { metricsRegistry: options.metricsRegistry } : {}),
  });
  await app.ready();

  // Built over the same database and registry the app uses, so a sweep driven
  // from a test sees exactly what the running application would.
  const paymentStore = createPaymentStore({
    db: instrumented,
    registry: options.railRegistry ?? createRailRegistry({ enabled: [] }),
    audit: createAuditLogger(pgliteDatabase(pg)),
    clock: { now: () => current.getTime(), nowIso: () => current.toISOString() as never },
    reconcileAfterMinutes: 15,
  });

  return {
    app,
    db: pg,
    paymentStore,
    database: probe,
    setNow: (date) => {
      current = date;
    },
    close: async () => {
      await app.close();
      await pg.close();
    },
  };
};

/* -------------------------------------------------------------------------- */
/* Request helpers                                                             */
/* -------------------------------------------------------------------------- */

export interface RegisteredParent {
  readonly parentId: string;
  readonly email: string;
  readonly password: string;
  readonly accessToken: string;
  readonly refreshToken: string;
}

/** Obviously synthetic. Never a real-looking address (docs/TESTING_STANDARDS.md §6). */
export const testEmail = (label: string): string => `test-${label}@example.invalid`;

/** A password that satisfies the 12-character policy without being guessable-looking. */
export const TEST_PASSWORD = 'correct-horse-battery-staple-01';

export const registerAndLogin = async (
  harness: ApiHarness,
  label: string,
): Promise<RegisteredParent> => {
  const email = testEmail(label);

  const registration = await harness.app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email, password: TEST_PASSWORD, displayName: `Test Parent ${label}` },
  });

  if (registration.statusCode !== 201) {
    throw new Error(`registration failed: ${String(registration.statusCode)} ${registration.body}`);
  }

  const parentId = registration.json<{ parent: { id: string } }>().parent.id;

  const login = await harness.app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { email, password: TEST_PASSWORD },
  });

  if (login.statusCode !== 200) {
    throw new Error(`login failed: ${String(login.statusCode)} ${login.body}`);
  }

  const tokens = login.json<{ accessToken: string; refreshToken: string }>();

  return {
    parentId,
    email,
    password: TEST_PASSWORD,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
  };
};

export const authHeader = (accessToken: string): Record<string, string> => ({
  authorization: `Bearer ${accessToken}`,
});

/** Promotes a parent to a staff role, bypassing RLS as the owner. */
export const setRole = async (
  harness: ApiHarness,
  parentId: string,
  role: 'parent' | 'admin' | 'support',
): Promise<void> => {
  await harness.db.query('update parents set role = $1 where id = $2', [role, parentId]);
};

/** Reads the audit trail, bypassing RLS as the owner. */
export const readAuditLog = async (
  harness: ApiHarness,
  action?: string,
): Promise<{ action: string; outcome: string; actor_type: string }[]> => {
  const result = await harness.db.query<{ action: string; outcome: string; actor_type: string }>(
    action === undefined
      ? 'select action, outcome, actor_type from audit_logs order by occurred_at'
      : 'select action, outcome, actor_type from audit_logs where action = $1 order by occurred_at',
    action === undefined ? undefined : [action],
  );
  return result.rows;
};

/**
 * Runs a query with RLS in force as `parentId`, exactly as a request would.
 *
 * For assertions that must bypass the API and address the policies directly —
 * "can an admin read the audit log?", "does a demoted admin lose access?". The
 * harness connection is otherwise privileged, so without this a test would be
 * asking the superuser, which RLS does not apply to, and would pass regardless.
 */
export const queryAsParent = async <T = Record<string, unknown>>(
  harness: ApiHarness,
  parentId: string,
  sql: string,
  params?: readonly unknown[],
): Promise<T[]> => {
  await harness.db.exec('begin');
  try {
    await harness.db.query('set local role authenticated');
    await harness.db.query(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ sub: parentId, role: 'authenticated' }),
    ]);
    const result = await harness.db.query<T>(sql, params ? [...params] : undefined);
    return result.rows;
  } finally {
    // Rolling back rather than committing: these are assertions, and the role
    // and claim are transaction-local, so nothing leaks into the next query.
    await harness.db.exec('rollback');
  }
};

/* -------------------------------------------------------------------------- */
/* Payments                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The mock rail's webhook secret, as configuration defaults it.
 *
 * Exported so a suite signs its webhooks the way the rail would. An assertion
 * that a forged signature is rejected only means something if the accepted case
 * went through the same verification.
 */
export const MOCK_WEBHOOK_SECRET = 'local-mock-webhook-signing-key';
