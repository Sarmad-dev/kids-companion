import { once } from 'node:events';
import { createServer, type Server } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { parseRedisUrl, probeDatabase, probeRedis } from './probes.js';

/**
 * Readiness probes.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * A PROBE THAT HAS NEVER BEEN SEEN TO FAIL IS NOT A PROBE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The failure path is the entire point: a readiness check exists to say "no".
 * Testing only the happy path would pass just as well against a function that
 * returns `ok` unconditionally, which is indistinguishable from a working probe
 * right up until the outage it was supposed to catch.
 *
 * So every case below is driven to an actual answer, including a Redis that
 * accepts the connection and then refuses the credentials — reachable but
 * rejecting us, which is the failure a naive TCP check calls healthy.
 *
 * The Redis tests run a REAL TCP server speaking RESP. No mocking of the module
 * under test: a mocked socket would prove the test's assumptions, not the code.
 */

const servers: Server[] = [];

/** A fake Redis on an ephemeral port. `reply` decides how it behaves. */
const fakeRedis = async (reply: (received: string) => string | undefined): Promise<number> => {
  const server = createServer((socket) => {
    let buffer = '';
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const response = reply(buffer);
      if (response !== undefined) socket.write(response);
    });
    socket.on('error', () => undefined);
  });

  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return address.port;
};

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    if (server) await new Promise((resolve) => server.close(resolve));
  }
});

/* ========================================================================== */
/* Postgres                                                                   */
/* ========================================================================== */

describe('probeDatabase', () => {
  it('reports ok when the database answers', async () => {
    const db = { query: async () => await Promise.resolve({ rows: [], rowCount: 1 }) };

    expect(await probeDatabase(db as never)).toBe('ok');
  });

  it('reports unavailable when the query throws', async () => {
    const db = {
      query: async () => await Promise.reject(new Error('connection refused')),
    };

    expect(await probeDatabase(db as never)).toBe('unavailable');
  });

  it('reports unavailable rather than hanging when the database never answers', async () => {
    /* The case that matters most. An unresponsive database usually does not
     * refuse the connection — it accepts and says nothing, and a probe without
     * its own deadline waits with it, taking the load balancer down too. */
    const db = { query: async () => await new Promise<never>(() => undefined) };

    const started = Date.now();
    expect(await probeDatabase(db as never, 150)).toBe('unavailable');
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('never leaks the driver error into the result', async () => {
    // Readiness is reachable without credentials. A driver message names the
    // host, the database and the user; none of that is ours to publish.
    const db = {
      query: async () =>
        await Promise.reject(new Error('FATAL: password authentication failed for user "kc_prod"')),
    };

    const result = await probeDatabase(db as never);
    expect(result).toBe('unavailable');
    expect(JSON.stringify(result)).not.toContain('kc_prod');
  });
});

/* ========================================================================== */
/* URL parsing                                                                */
/* ========================================================================== */

describe('parseRedisUrl', () => {
  it('reads host, port, and credentials', () => {
    expect(parseRedisUrl('redis://alice:s3cret@cache.example:6380')).toEqual({
      host: 'cache.example',
      port: 6380,
      tls: false,
      username: 'alice',
      password: 's3cret',
    });
  });

  it('defaults the port', () => {
    expect(parseRedisUrl('redis://cache.example')?.port).toBe(6379);
  });

  it('treats rediss:// as TLS without being told', () => {
    expect(parseRedisUrl('rediss://cache.example')?.tls).toBe(true);
  });

  it('honours the TLS flag even for a plain redis:// url', () => {
    // `REDIS_TLS_ENABLED=true` is a production requirement in the config schema.
    // A url that forgot the extra `s` must not quietly downgrade the connection.
    expect(parseRedisUrl('redis://cache.example', true)?.tls).toBe(true);
  });

  it('decodes a percent-encoded password', () => {
    // Generated secrets contain `@` and `/` regularly, and both must survive.
    expect(parseRedisUrl('redis://:p%40ss%2Fword@cache.example')?.password).toBe('p@ss/word');
  });

  it('refuses anything that is not a redis url', () => {
    for (const url of ['', 'http://cache', 'not a url', 'redis://']) {
      expect(parseRedisUrl(url), url).toBeUndefined();
    }
  });
});

/* ========================================================================== */
/* Redis                                                                      */
/* ========================================================================== */

describe('probeRedis', () => {
  it('is skipped, not ok, when no url is configured', async () => {
    /* The distinction the whole three-valued result exists for. An unconfigured
     * dependency is unexamined, and reporting it as healthy is a lie that reads
     * exactly like the truth on a dashboard. */
    expect(await probeRedis({ url: undefined })).toBe('skipped');
    expect(await probeRedis({ url: '' })).toBe('skipped');
  });

  it('reports ok when the server answers PONG', async () => {
    const port = await fakeRedis((received) =>
      received.includes('PING') ? '+PONG\r\n' : undefined,
    );

    expect(await probeRedis({ url: `redis://127.0.0.1:${String(port)}` })).toBe('ok');
  });

  it('authenticates before pinging when the url carries a password', async () => {
    let sawAuth = false;
    const port = await fakeRedis((received) => {
      if (received.includes('AUTH')) sawAuth = true;
      return received.includes('PING') ? '+OK\r\n+PONG\r\n' : undefined;
    });

    expect(await probeRedis({ url: `redis://:hunter2@127.0.0.1:${String(port)}` })).toBe('ok');
    expect(sawAuth).toBe(true);
  });

  it('reports unavailable when the server rejects the credentials', async () => {
    /* ═══════════════════════════════════════════════════════════════════════
     * THE CASE A TCP CHECK GETS WRONG.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * The port is open and the connection succeeds, so "can I connect?" says
     * yes. But the server will not serve us. Ready means usable, not reachable.
     */
    const port = await fakeRedis(() => '-WRONGPASS invalid username-password pair\r\n');

    expect(await probeRedis({ url: `redis://:wrong@127.0.0.1:${String(port)}` })).toBe(
      'unavailable',
    );
  });

  it('reports unavailable when nothing is listening', async () => {
    // Port 1 on loopback: reserved, and nothing legitimate binds it.
    expect(await probeRedis({ url: 'redis://127.0.0.1:1', timeoutMs: 500 })).toBe('unavailable');
  });

  it('reports unavailable rather than hanging when the server accepts and says nothing', async () => {
    // A wedged Redis, or something else entirely sitting on the port.
    const port = await fakeRedis(() => undefined);

    const started = Date.now();
    expect(await probeRedis({ url: `redis://127.0.0.1:${String(port)}`, timeoutMs: 200 })).toBe(
      'unavailable',
    );
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('reports unavailable for a malformed url instead of guessing a default host', async () => {
    expect(await probeRedis({ url: 'http://cache.example' })).toBe('unavailable');
  });
});
