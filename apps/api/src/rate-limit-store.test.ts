import { createServer, type Server, type Socket } from 'node:net';

import type { Logger } from '@kids/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { counterKey, createRateLimitStore } from './rate-limit-store.js';
import { createRedisClient, parseReply, type RedisClient } from './redis-client.js';

/**
 * Rate limiting, shared across instances.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT WAS WRONG
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `@fastify/rate-limit` counted in process memory, so behind N instances every
 * limit was N times its configured value — including
 * `RATE_LIMIT_AUTH_PER_15_MIN=10`, which is what makes online password guessing
 * impractical. Three instances gave an attacker thirty attempts per window.
 *
 * These tests run a REAL TCP SERVER speaking RESP, because the thing being
 * fixed is that two processes agree on a count. A mocked client could not show
 * that.
 */

const silentLogger = (): Logger =>
  ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(),
  }) as unknown as Logger;

/** A Redis good enough for INCR, PTTL and PEXPIRE. */
const createFakeRedis = async (): Promise<{
  url: string;
  keys: Map<string, { value: number; expiresAt: number | undefined }>;
  close: () => Promise<void>;
  stop: () => void;
  start: () => void;
}> => {
  const keys = new Map<string, { value: number; expiresAt: number | undefined }>();
  let refusing = false;
  const sockets = new Set<Socket>();

  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);

    let buffer = Buffer.alloc(0);

    socket.on('data', (chunk: Buffer) => {
      if (refusing) {
        socket.destroy();
        return;
      }

      buffer = Buffer.concat([buffer, chunk]);

      for (;;) {
        const parsed = parseReply(buffer);
        if (!parsed) break;
        buffer = buffer.subarray(parsed.next);

        const parts = (Array.isArray(parsed.value) ? parsed.value : []).map(String);
        const [command, key, argument] = parts;

        if (command === 'INCR' && key !== undefined) {
          const existing = keys.get(key);
          const expired = existing?.expiresAt !== undefined && existing.expiresAt <= Date.now();
          const value = existing && !expired ? existing.value + 1 : 1;
          keys.set(key, { value, expiresAt: expired ? undefined : existing?.expiresAt });
          socket.write(`:${String(value)}\r\n`);
        } else if (command === 'PTTL' && key !== undefined) {
          const existing = keys.get(key);
          const ttl =
            existing?.expiresAt === undefined ? -1 : Math.max(0, existing.expiresAt - Date.now());
          socket.write(`:${String(ttl)}\r\n`);
        } else if (command === 'PEXPIRE' && key !== undefined && argument !== undefined) {
          const existing = keys.get(key);
          if (existing) existing.expiresAt = Date.now() + Number(argument);
          socket.write(':1\r\n');
        } else {
          socket.write('+OK\r\n');
        }
      }
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const port = (server.address() as { port: number }).port;

  return {
    url: `redis://127.0.0.1:${String(port)}`,
    keys,
    stop: () => {
      refusing = true;
      for (const socket of sockets) socket.destroy();
    },
    start: () => {
      refusing = false;
    },
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
};

/** Drives a store the way @fastify/rate-limit does. */
const incr = async (
  store: {
    incr: (
      key: string,
      cb: (e: Error | null, r?: { current: number; ttl: number }) => void,
      w: number,
      m: number,
    ) => void;
  },
  key: string,
  windowMs = 60_000,
): Promise<{ current: number; ttl: number }> =>
  await new Promise((resolve, reject) => {
    store.incr(
      key,
      (error, result) => {
        if (error || !result) reject(error ?? new Error('no result'));
        else resolve(result);
      },
      windowMs,
      100,
    );
  });

describe('the shared rate limit store', () => {
  let redisServer: Awaited<ReturnType<typeof createFakeRedis>>;
  let client: RedisClient;

  beforeAll(async () => {
    redisServer = await createFakeRedis();
  });

  afterAll(async () => {
    client.close();
    await redisServer.close();
  });

  beforeEach(() => {
    redisServer.keys.clear();
    redisServer.start();
  });

  const newStore = (onDegraded?: (reason: string) => void) => {
    client = createRedisClient({ url: redisServer.url, logger: silentLogger() })!;
    const Store = createRateLimitStore({
      redis: client,
      keyPrefix: 'kc:test:',
      logger: silentLogger(),
      ...(onDegraded ? { onDegraded } : {}),
    });
    return new Store({ path: '/v1/auth/login', prefix: '' });
  };

  /* ======================================================================== */
  /* The thing that was broken                                                */
  /* ======================================================================== */

  it('counts one limit across two instances, not one each', async () => {
    /* ═══════════════════════════════════════════════════════════════════════
     * THE ASSERTION THIS FILE EXISTS FOR.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Two independent stores, as two API processes would be. The fifth request
     * has to see 5, not 3-and-2. In process memory it saw 3-and-2, and that is
     * how ten login attempts became thirty.
     */
    const instanceA = newStore();
    const instanceB = newStore();

    await incr(instanceA, 'ip:203.0.113.7');
    await incr(instanceB, 'ip:203.0.113.7');
    await incr(instanceA, 'ip:203.0.113.7');
    await incr(instanceB, 'ip:203.0.113.7');
    const fifth = await incr(instanceA, 'ip:203.0.113.7');

    expect(fifth.current).toBe(5);
  });

  it('keeps separate keys separate', async () => {
    const store = newStore();

    await incr(store, 'ip:203.0.113.7');
    await incr(store, 'ip:203.0.113.7');
    const other = await incr(store, 'ip:198.51.100.4');

    expect(other.current).toBe(1);
  });

  it('keeps separate routes separate', async () => {
    /* A limit on the login route must not be consumable by traffic to an
     * unrelated endpoint that happens to key on the same IP. */
    const Store = createRateLimitStore({
      redis: (client = createRedisClient({ url: redisServer.url, logger: silentLogger() })!),
      keyPrefix: 'kc:test:',
      logger: silentLogger(),
    });

    const login = new Store({ path: '/v1/auth/login', prefix: '' });
    const messages = login.child({ path: '/api/conversations/:id/message', prefix: '' });

    await incr(login, 'ip:203.0.113.7');
    const elsewhere = await incr(messages, 'ip:203.0.113.7');

    expect(elsewhere.current).toBe(1);
  });

  /* ======================================================================== */
  /* Expiry                                                                   */
  /* ======================================================================== */

  it('gives a new counter the full window', async () => {
    const store = newStore();
    const first = await incr(store, 'ip:203.0.113.7', 900_000);

    expect(first.current).toBe(1);
    expect(first.ttl).toBe(900_000);
  });

  it('never leaves a counter without an expiry', async () => {
    /* ═══════════════════════════════════════════════════════════════════════
     * A PARENT LOCKED OUT FOR EVER IS NOT AN ACCEPTABLE FAILURE.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * The obvious implementation — INCR, then PEXPIRE when the result is 1 —
     * leaves the key immortal if the process dies between the two. Reading the
     * TTL back and setting it when missing self-heals on the next request.
     */
    const store = newStore();
    await incr(store, 'ip:203.0.113.7');

    // Simulate the crash: the key exists with no expiry.
    const key = counterKey('kc:test:', '/v1/auth/login', 'ip:203.0.113.7');
    redisServer.keys.set(key, { value: 5, expiresAt: undefined });

    const next = await incr(store, 'ip:203.0.113.7', 900_000);

    expect(next.ttl).toBe(900_000);
    expect(redisServer.keys.get(key)?.expiresAt).toBeDefined();
  });

  /* ======================================================================== */
  /* When Redis is gone                                                       */
  /* ======================================================================== */

  it('falls back to counting locally rather than allowing everything', async () => {
    /* ═══════════════════════════════════════════════════════════════════════
     * NEITHER FAIL-OPEN NOR FAIL-CLOSED.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Allowing everything would remove the auth limiter at exactly the moment
     * an attacker might be why Redis is struggling. Refusing everything turns a
     * cache outage into a total outage for a product a child is mid-conversation
     * with. Counting in this process keeps a real limit — the one the product
     * had before any of this existed.
     */
    const degraded: string[] = [];
    const store = newStore((reason) => degraded.push(reason));

    await incr(store, 'ip:203.0.113.7');
    redisServer.stop();

    const first = await incr(store, 'ip:203.0.113.7');
    const second = await incr(store, 'ip:203.0.113.7');
    const third = await incr(store, 'ip:203.0.113.7');

    // Still counting, and still climbing. Not 1 every time, which is what
    // "fail open" would look like from here.
    expect(first.current).toBe(1);
    expect(second.current).toBe(2);
    expect(third.current).toBe(3);
    expect(degraded.length).toBeGreaterThanOrEqual(1);
  });

  it('never rejects a request because the store failed', async () => {
    // The callback must not receive an error: `@fastify/rate-limit` would turn
    // that into a failed request, so a Redis blip would become a 500 for a
    // child mid-sentence.
    const store = newStore();
    redisServer.stop();

    await expect(incr(store, 'ip:203.0.113.7')).resolves.toMatchObject({ current: 1 });
  });

  it('goes back to sharing once Redis returns', async () => {
    const store = newStore();
    redisServer.stop();
    await incr(store, 'ip:203.0.113.7');

    redisServer.start();
    const recovered = await incr(store, 'ip:203.0.113.7');

    // Counted in Redis again — the local tally is not carried over, which errs
    // towards allowing a few extra rather than locking a parent out.
    expect(recovered.current).toBe(1);
    expect(redisServer.keys.size).toBeGreaterThanOrEqual(1);
  });

  /* ======================================================================== */
  /* Privacy                                                                  */
  /* ======================================================================== */

  it('never stores an IP address or a parent id in redis', async () => {
    /* ═══════════════════════════════════════════════════════════════════════
     * REDIS MUST NOT BECOME A LOG OF WHO WAS WHERE.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * The limiter keys on an IP or a parent id. Storing those raw would make
     * the cache a new home for personal data, in a system nobody counted as
     * holding any, with whatever retention it happens to have. A hash counts
     * identically.
     */
    const store = newStore();
    await incr(store, 'ip:203.0.113.7');
    await incr(store, 'parent:8f14e45f-ceea-467a-9e4a-4b34d1a35555');

    const stored = [...redisServer.keys.keys()].join(' ');

    expect(stored).not.toContain('203.0.113.7');
    expect(stored).not.toContain('8f14e45f');
    expect(stored).not.toContain('parent:');
  });

  it('namespaces keys so environments cannot consume each other’s limits', () => {
    // `REDIS_KEY_PREFIX` must differ per environment — the config schema
    // enforces that in production. This is what makes it matter.
    const staging = counterKey('kc:staging:', '/v1/auth/login', 'ip:203.0.113.7');
    const production = counterKey('kc:prod:', '/v1/auth/login', 'ip:203.0.113.7');

    expect(staging).not.toBe(production);
    expect(staging.startsWith('kc:staging:')).toBe(true);
  });

  it('produces the same key for the same caller every time', () => {
    // Otherwise the counter never accumulates and the limit never binds.
    expect(counterKey('p:', '/r', 'ip:1.2.3.4')).toBe(counterKey('p:', '/r', 'ip:1.2.3.4'));
  });
});
