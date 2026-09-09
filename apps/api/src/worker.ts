import { createServer } from 'node:http';

import { ConfigurationError, loadConfig } from '@kids/config';
import { createPgDatabase } from '@kids/db';
import closeWithGrace from 'close-with-grace';

import { buildApp } from './app.js';

/**
 * The background worker.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS IS A SEPARATE PROCESS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Three reasons, in order of how much they matter:
 *
 *   1. A sweep must run ONCE per interval, not once per instance. Scheduling
 *      inside the API means N instances all reconcile the same payments at the
 *      same moment, asking a payment rail the same question N times.
 *
 *   2. Sweeps are unbounded work on a thread that also serves children. The
 *      performance phase measured what CPU-bound work does to unrelated
 *      requests: a login burst multiplied an unrelated read's p95 by 21×
 *      (PERFORMANCE_REPORT.md §3). A reconciliation pass over a backlog would
 *      do the same, during an incident, which is exactly when it runs.
 *
 *   3. They scale differently. The API scales with children talking; the sweeps
 *      scale with subscriptions and unresolved payments.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * STILL ONE INSTANCE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * There is no distributed lock, so **exactly one worker may run per
 * environment** — `deploy.replicas: 1`, enforced by the operator, not by this
 * code. Two workers would double every vendor query and race on the same rows.
 *
 * The sweeps are individually safe to run twice (each is an idempotent
 * `update … where` or a re-verification), so a brief overlap during a deploy is
 * survivable. Sustained duplication is not, and nothing here would tell you it
 * was happening. Making that safe is a Redis lease, and Redis is not yet on the
 * request path — see DEPLOYMENT.md.
 */

/** One scheduled job. */
interface Job {
  readonly name: string;
  readonly intervalMs: number;
  /** Returns something small and loggable — "what did this pass actually do?" */
  readonly run: () => Promise<unknown>;
}

const main = async (): Promise<void> => {
  const config = loadConfig();

  if (config.DATABASE_URL === undefined) {
    throw new ConfigurationError(['DATABASE_URL: is required to start the worker']);
  }

  const db = createPgDatabase({
    connectionString: config.DATABASE_URL,
    // A worker does not need the API's pool. It runs a handful of sweeps on a
    // timer, and a large idle pool is connections taken from the API for
    // nothing.
    max: Math.max(2, Math.floor(config.DATABASE_POOL_MAX / 2)),
    ssl: config.DATABASE_SSL_MODE === 'require',
    ...(config.DATABASE_SSL_ROOT_CERT === undefined
      ? {}
      : { sslRootCert: config.DATABASE_SSL_ROOT_CERT }),
    statementTimeoutMs: config.DATABASE_STATEMENT_TIMEOUT_MS,
  });

  /* Built for its wiring, never listened on. See the note on `maintenance` in
   * app.ts: one place decides how rails and store providers are constructed,
   * and this process uses that same place rather than a copy of it. */
  const app = await buildApp({ config, db });
  const log = app.log.child({ process: 'worker' });

  const jobs: Job[] = [
    {
      /**
       * ═══════════════════════════════════════════════════════════════════
       * FIRST IN THE LIST, AND ON THE SHORTEST INTERVAL.
       * ═══════════════════════════════════════════════════════════════════
       *
       * Every other sweep repairs a number that is stale. This one repairs a
       * child who disclosed something and whose escalation has not yet reached
       * a human, because the endpoint was unreachable when the turn happened.
       *
       * A minute is short for a backstop and long for this; it is a compromise
       * with not hammering an endpoint that is already failing. The delivery
       * attempt on the request path is the primary route — this only catches
       * what that could not do.
       */
      name: 'safety.retryEscalationDelivery',
      intervalMs: config.WORKER_ESCALATION_RETRY_INTERVAL_MS,
      run: async () => await app.maintenance.retryEscalationDelivery(),
    },
    {
      name: 'subscriptions.sweepExpired',
      intervalMs: config.WORKER_SUBSCRIPTION_SWEEP_INTERVAL_MS,
      run: async () => ({ expired: await app.maintenance.sweepExpiredSubscriptions() }),
    },
    {
      /**
       * The backstop for progress numbers.
       *
       * Rollups are rebuilt when a conversation is explicitly ended, and a
       * five-year-old does not end conversations — the app gets closed, the
       * tablet gets taken away. Without this the turns are recorded correctly
       * and the parent still sees zero.
       */
      name: 'learning.rebuildRollups',
      intervalMs: config.WORKER_LEARNING_ROLLUP_INTERVAL_MS,
      run: async () => await app.maintenance.rebuildLearningRollups(),
    },
    {
      /**
       * A privacy control, and one that CAN safely run here.
       *
       * The audio sweep below cannot, because the bytes live in the API's heap
       * and a ledger claiming a deletion that did not happen is worse than no
       * sweep. Transcripts are in the database, so there is no such gap: the
       * statement that overwrites the content IS the deletion.
       */
      name: 'privacy.expireTranscripts',
      intervalMs: config.WORKER_TRANSCRIPT_RETENTION_INTERVAL_MS,
      run: async () => await app.maintenance.expireTranscripts(),
    },
    {
      name: 'payments.reconcile',
      intervalMs: config.WORKER_PAYMENT_RECONCILE_INTERVAL_MS,
      run: async () => await app.maintenance.reconcilePayments(),
    },
    {
      name: 'storeBilling.synchronise',
      intervalMs: config.WORKER_STORE_SYNC_INTERVAL_MS,
      run: async () => await app.maintenance.synchroniseStorePurchases(),
    },
  ];

  /**
   * The audio retention sweep, scheduled only when it can actually delete.
   *
   * ═══════════════════════════════════════════════════════════════════════
   * THIS IS THE SWEEP THAT USED TO BE IMPOSSIBLE.
   * ═══════════════════════════════════════════════════════════════════════
   *
   * With the in-memory store the bytes live in whichever process wrote them, so
   * a sweep from HERE would mark the ledger rows deleted while the objects
   * survived in the API's heap. A retention record asserting a deletion that
   * did not happen is worse than no sweep, because it is the record somebody
   * would rely on — so the worker refused to schedule it and said so on every
   * boot.
   *
   * A shared object store closes that gap: the DELETE is the deletion, and the
   * ledger and the bytes agree. The refusal is kept for local and CI, where
   * memory is still the right default and the warning is still the honest
   * thing to say.
   */
  if (app.maintenance.audioSweepIsShared) {
    jobs.push({
      name: 'privacy.expireAudio',
      intervalMs: config.WORKER_AUDIO_SWEEP_INTERVAL_MS,
      run: async () => await app.maintenance.sweepExpiredAudio(),
    });
  } else {
    log.warn(
      { control: 'audio_retention_backstop' },
      'audio retention sweep NOT scheduled: no shared object store is configured, ' +
        'so deletion cannot be performed from this process. See DEPLOYMENT.md.',
    );
  }

  /* ------------------------------------------------------------------------ */
  /* Scheduling                                                                */
  /* ------------------------------------------------------------------------ */

  const timers: NodeJS.Timeout[] = [];
  let running = true;

  const runOnce = async (job: Job): Promise<void> => {
    const started = Date.now();
    try {
      const result = await job.run();
      log.info({ job: job.name, ms: Date.now() - started, result }, 'sweep completed');
    } catch (error) {
      /* A failing sweep must never take the worker down. These are backstops:
       * the next pass retries, and a crash-loop would stop every OTHER sweep
       * from running too. It is logged at error so it is visible without being
       * fatal. */
      log.error({ err: error, job: job.name, ms: Date.now() - started }, 'sweep failed');
    }
  };

  for (const job of jobs) {
    /* Deliberately NOT run at boot. A deploy restarts every instance at once,
     * and a sweep on start means a thundering herd against the database and
     * every payment rail at exactly the moment a release is going out. The
     * first pass waits one interval. */
    const timer = setInterval(() => {
      if (!running) return;
      void runOnce(job);
    }, job.intervalMs);

    timers.push(timer);
    log.info({ job: job.name, intervalMs: job.intervalMs }, 'sweep scheduled');
  }

  /* ------------------------------------------------------------------------ */
  /* Liveness                                                                  */
  /* ------------------------------------------------------------------------ */

  /**
   * A liveness port, and nothing else.
   *
   * An orchestrator needs something to probe or it cannot tell a working worker
   * from a wedged one — a process that is "up" but whose timers have stopped
   * looks identical from the outside. This answers exactly one route and is
   * never the API: no routes from `buildApp` are served here.
   *
   * It is liveness, not readiness. The worker has no traffic to be withdrawn
   * from, and a sweep that cannot reach a payment rail is a reason to log, not a
   * reason to restart.
   */
  const liveness = createServer((request, response) => {
    if (request.url === '/health') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          status: 'ok',
          service: `${config.SERVICE_NAME}-worker`,
          version: config.SERVICE_VERSION,
        }),
      );
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'not found' }));
  });

  await new Promise<void>((resolve) => {
    liveness.listen(config.WORKER_PORT, config.API_HOST, resolve);
  });
  log.info({ port: config.WORKER_PORT, jobs: jobs.length }, 'worker started');

  closeWithGrace({ delay: 15_000 }, async ({ err, signal }) => {
    if (err) {
      log.fatal({ err }, 'shutting down after an unhandled error');
    } else {
      log.info({ signal }, 'shutting down');
    }

    // Stop scheduling first, then let anything in flight finish. A sweep killed
    // mid-transaction rolls back, which is safe — but a sweep killed between a
    // vendor call and the write recording it is not, so it is given time.
    running = false;
    for (const timer of timers) clearInterval(timer);

    await new Promise<void>((resolve) => liveness.close(() => resolve()));
    await app.close();
    await db.close();
  });
};

try {
  await main();
} catch (error) {
  if (error instanceof ConfigurationError) {
    // Before the logger exists, a human reading a deploy log is the audience.
    process.stderr.write(`${error.message}\n`);
    process.exit(78); // EX_CONFIG
  }
  process.stderr.write(`Worker failed to start: ${String(error)}\n`);
  process.exit(1);
}
