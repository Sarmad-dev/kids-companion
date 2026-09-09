import { createServer, type Server, type Socket } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseReply } from '../../apps/api/src/redis-client.js';
import { createApiHarness, type ApiHarness } from '../helpers/api.js';

/**
 * Rate limiting through the real application.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS ON TOP OF THE UNIT TESTS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The store is covered in `apps/api/src/rate-limit-store.test.ts`. What that
 * cannot show is whether the application ever ASKS it anything — and in this
 * codebase a correct mechanism nobody called has been the defect five times
 * running: learning events, story mode, three of five alert conditions, the
 * error tracker, transcript retention.
 *
 * So this boots the real app pointed at a Redis, makes real requests through
 * the real limiter, and then looks in Redis to see whether the counting
 * actually happened there.
 */

/** A Redis good enough for INCR, PTTL and PEXPIRE. */
const createFakeRedis = async (): Promise<{
  url: string;
  keys: Map<string, { value: number; expiresAt: number | undefined }>;
  close: () => Promise<void>;
}> => {
  const keys = new Map<string, { value: number; expiresAt: number | undefined }>();
  const sockets = new Set<Socket>();

  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);

    let buffer = Buffer.alloc(0);

    socket.on('data', (chunk: Buffer) => {
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

  return {
    url: `redis://127.0.0.1:${String((server.address() as { port: number }).port)}`,
    keys,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
};

describe('rate limiting', () => {
  let redis: Awaited<ReturnType<typeof createFakeRedis>>;
  let harness: ApiHarness;

  beforeAll(async () => {
    redis = await createFakeRedis();

    harness = await createApiHarness({
      env: {
        REDIS_URL: redis.url,
        REDIS_KEY_PREFIX: 'kc:ratetest:',
        // Low enough that a handful of requests trips it. The production value
        // is 10 per 15 minutes and is what makes guessing impractical.
        RATE_LIMIT_AUTH_PER_15_MIN: '3',
      },
    });
  }, 180_000);

  afterAll(async () => {
    await harness.close();
    await redis.close();
  });

  const login = async () =>
    await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'nobody@example.com', password: 'wrong-password-entirely' },
    });

  it('counts login attempts in redis, not in this process', async () => {
    /* ═══════════════════════════════════════════════════════════════════════
     * THE WIRING, END TO END.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Every piece of this can be individually correct while the application
     * never hands the store a request — which is exactly the state five other
     * subsystems in this repository were found in.
     */
    await login();

    expect(redis.keys.size).toBeGreaterThanOrEqual(1);
    // Counted under the configured namespace, so two environments sharing a
    // Redis cannot consume each other's limits.
    expect([...redis.keys.keys()].every((key) => key.startsWith('kc:ratetest:'))).toBe(true);
  });

  it('refuses once the limit is reached', async () => {
    // A limiter that counts and never refuses is not a limiter.
    let refused = false;
    for (let i = 0; i < 8; i += 1) {
      const response = await login();
      if (response.statusCode === 429) {
        refused = true;
        break;
      }
    }

    expect(refused).toBe(true);
  });

  it('tells the client when it may try again', async () => {
    const response = await login();

    expect(response.statusCode).toBe(429);
    expect(response.headers['retry-after']).toBeDefined();
    // The envelope every other error uses, not the plugin's own shape.
    expect(response.json<{ error: { code: string } }>().error.code).toBe('RATE_LIMITED');
  });

  it('never puts an email or an address in the counter key', async () => {
    /* Redis would otherwise become a record of which addresses tried to log in
     * and when — personal data in a system nobody counted as holding any. */
    const stored = [...redis.keys.keys()].join(' ');

    expect(stored).not.toContain('nobody@example.com');
    expect(stored).not.toContain('127.0.0.1');
  });
});
