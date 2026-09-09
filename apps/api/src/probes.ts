import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';

import type { Database } from '@kids/db';

/**
 * Dependency probes for the readiness endpoint.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * READINESS IS NOT LIVENESS, AND CONFLATING THEM CAUSES OUTAGES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `/health` answers "is this process alive?" and touches nothing. `/ready`
 * answers "should traffic be sent here?" and therefore must touch the things a
 * request needs. Wiring a dependency check into liveness means a slow database
 * restarts every healthy container at exactly the moment restarts hurt most —
 * so these functions are used by readiness only.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THREE OUTCOMES, NOT TWO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `skipped` exists so readiness never claims a check it did not run. A
 * dependency that is not configured is not "healthy"; it is unexamined, and
 * saying so is the difference between a probe and a decoration.
 *
 * Every probe is bounded by its own timeout. A readiness endpoint that can hang
 * is a readiness endpoint that takes the load balancer down with it.
 */

export type ProbeResult = 'ok' | 'unavailable' | 'skipped';

/** Rejects with a timeout rather than hanging, whatever the dependency does. */
const withTimeout = async <T>(
  work: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> => {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    return await Promise.race([
      work(controller.signal),
      new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener('abort', () => {
          reject(new Error(`probe exceeded ${String(timeoutMs)}ms`));
        });
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

/* -------------------------------------------------------------------------- */
/* Postgres                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Verifies the database answers, using the pool the application actually uses.
 *
 * `select 1` on purpose: the question is "can this instance reach its database
 * and get a connection from the pool?", and a probe that reads real tables
 * turns a readiness check into load, and an exhausted pool into a stampede.
 */
export const probeDatabase = async (
  db: Pick<Database, 'query'>,
  timeoutMs = 2_000,
): Promise<ProbeResult> => {
  try {
    await withTimeout(async () => await db.query('select 1'), timeoutMs);
    return 'ok';
  } catch {
    // The error is deliberately not propagated. Readiness is consumed by
    // infrastructure and is reachable without credentials; a driver message
    // naming a host, a database, or a user is not something to publish.
    return 'unavailable';
  }
};

/* -------------------------------------------------------------------------- */
/* Redis                                                                       */
/* -------------------------------------------------------------------------- */

/** RESP array encoding, so an argument containing a space cannot be mis-parsed. */
const respCommand = (...parts: readonly string[]): string =>
  `*${String(parts.length)}\r\n` +
  parts.map((part) => `$${String(Buffer.byteLength(part))}\r\n${part}\r\n`).join('');

export interface RedisTarget {
  readonly host: string;
  readonly port: number;
  readonly tls: boolean;
  readonly username: string | undefined;
  readonly password: string | undefined;
}

/**
 * Parses a Redis URL without a client library.
 *
 * `rediss://` implies TLS on its own; `REDIS_TLS_ENABLED` can also require it.
 * Returns undefined for anything unparseable, which the caller reports as
 * `unavailable` rather than guessing at a default host.
 */
export const parseRedisUrl = (url: string, tlsEnabled = false): RedisTarget | undefined => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }

  if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') return undefined;
  if (parsed.hostname === '') return undefined;

  return {
    host: parsed.hostname,
    port: parsed.port === '' ? 6379 : Number(parsed.port),
    tls: parsed.protocol === 'rediss:' || tlsEnabled,
    username: parsed.username === '' ? undefined : decodeURIComponent(parsed.username),
    password: parsed.password === '' ? undefined : decodeURIComponent(parsed.password),
  };
};

/**
 * Sends PING and waits for PONG.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THERE IS NO REDIS CLIENT LIBRARY HERE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Nothing in this application talks to Redis yet — rate limiting is still
 * in-process (see DEPLOYMENT.md). Adding a client dependency to serve one
 * readiness probe would be a dependency carried for no other purpose.
 *
 * What a readiness probe needs to establish is narrow and testable: the host
 * resolves, the port accepts, TLS negotiates if required, the credentials are
 * accepted, and the thing on the other end speaks Redis. Two commands answer
 * all of that. When the limiter moves to Redis this should be replaced by that
 * client's own health call, because by then a real client will exist.
 */
export const probeRedis = async (
  options: {
    readonly url: string | undefined;
    readonly tlsEnabled?: boolean;
    readonly timeoutMs?: number;
  },
  // Injected so the unit tests can drive a real socket against a fake server
  // rather than mocking the module under test.
  connectImpl?: (target: RedisTarget) => Socket,
): Promise<ProbeResult> => {
  if (options.url === undefined || options.url === '') return 'skipped';

  const target = parseRedisUrl(options.url, options.tlsEnabled ?? false);
  if (!target) return 'unavailable';

  const timeoutMs = options.timeoutMs ?? 2_000;

  try {
    return await withTimeout(
      async () =>
        await new Promise<ProbeResult>((resolve, reject) => {
          const socket =
            connectImpl?.(target) ??
            (target.tls
              ? tlsConnect({ host: target.host, port: target.port, servername: target.host })
              : netConnect({ host: target.host, port: target.port }));

          let received = '';

          const finish = (result: ProbeResult): void => {
            socket.removeAllListeners();
            socket.destroy();
            resolve(result);
          };

          socket.setTimeout(timeoutMs);
          socket.on('timeout', () => {
            socket.destroy();
            reject(new Error('redis probe timed out'));
          });
          socket.on('error', (error: unknown) => {
            socket.destroy();
            reject(error instanceof Error ? error : new Error('redis probe failed'));
          });

          socket.on('connect', () => {
            if (target.password !== undefined) {
              socket.write(
                target.username === undefined
                  ? respCommand('AUTH', target.password)
                  : respCommand('AUTH', target.username, target.password),
              );
            }
            socket.write(respCommand('PING'));
          });

          socket.on('data', (chunk: Buffer) => {
            received += chunk.toString('utf8');

            // An auth failure answers `-ERR`/`-WRONGPASS` before PONG ever
            // arrives. Reachable but rejecting us is NOT ready.
            if (received.startsWith('-') || received.includes('\r\n-')) finish('unavailable');
            if (received.includes('+PONG')) finish('ok');
          });
        }),
      timeoutMs,
    );
  } catch {
    return 'unavailable';
  }
};
