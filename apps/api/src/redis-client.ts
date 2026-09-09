import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';

import type { Logger } from '@kids/shared';

import { parseRedisUrl } from './probes.js';

/**
 * A small Redis client, for the rate limiter.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS IS HAND-WRITTEN, AND WHY THAT IS SAFE HERE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The house pattern is to speak protocols directly rather than carry a client:
 * `probeRedis` already does RESP, the error tracker writes its own Sentry
 * envelope, the storage adapter signs its own requests. Its own comment says
 * this should be replaced "when the limiter moves to Redis, because by then a
 * real client will exist" — this is that client.
 *
 * But this one is different in kind from the others, and the difference is
 * worth naming. Signing a request is stateless formatting. A Redis client is
 * CONNECTION STATE: reconnection, pipelining, in-flight replies, a socket that
 * dies mid-command. That is harder to get right, and rate limiting is a
 * security control.
 *
 * What makes it acceptable is the containment, not the confidence: every
 * failure here degrades the limiter to the in-process one, which is exactly
 * what the product did before. A bug in this file cannot produce a WEAKER
 * position than the status quo — the worst case is the status quo, loudly
 * logged. See `rate-limit-store.ts`.
 *
 * Deliberately not supported: cluster, sentinel, pub/sub, TLS client certs.
 * A limiter needs one connection and three commands.
 */

export type RedisReply = string | number | null | RedisReply[];

export interface RedisClient {
  /** One command. Rejects if the connection is not usable. */
  command(...parts: readonly string[]): Promise<RedisReply>;
  /** Several commands in one write, replies in order. */
  pipeline(commands: readonly (readonly string[])[]): Promise<RedisReply[]>;
  /** Whether the last attempt worked. Drives the fallback, not a probe. */
  readonly healthy: boolean;
  close(): void;
}

/** RESP array encoding, so an argument containing a space cannot be mis-parsed. */
const encode = (parts: readonly string[]): string =>
  `*${String(parts.length)}\r\n` +
  parts.map((part) => `$${String(Buffer.byteLength(part))}\r\n${part}\r\n`).join('');

/**
 * Parses one complete reply, or reports that more bytes are needed.
 *
 * Returns the consumed length alongside the value so the caller can keep the
 * remainder — a reply can arrive split across packets, and a parser that
 * assumes otherwise works perfectly until the day it does not.
 */
export const parseReply = (
  buffer: Buffer,
  offset = 0,
): { value: RedisReply; next: number } | undefined => {
  const end = buffer.indexOf('\r\n', offset);
  if (end === -1) return undefined;

  const type = buffer[offset];
  // Past the end of what has arrived. Unreachable while `indexOf` found a
  // terminator, but the type permits it and a wrong guess here would
  // mis-attribute every later reply.
  if (type === undefined) return undefined;

  const payload = buffer.toString('utf8', offset + 1, end);
  const afterLine = end + 2;

  switch (type) {
    // +simple
    case 0x2b:
      return { value: payload, next: afterLine };
    // -error. Surfaced as a value, not thrown: a rate-limit command that gets
    // an error reply should degrade, not crash a request.
    case 0x2d:
      return { value: new Error(payload) as unknown as RedisReply, next: afterLine };
    // :integer
    case 0x3a:
      return { value: Number(payload), next: afterLine };
    // $bulk
    case 0x24: {
      const length = Number(payload);
      if (length === -1) return { value: null, next: afterLine };
      if (buffer.length < afterLine + length + 2) return undefined;
      return {
        value: buffer.toString('utf8', afterLine, afterLine + length),
        next: afterLine + length + 2,
      };
    }
    // *array
    case 0x2a: {
      const count = Number(payload);
      if (count === -1) return { value: null, next: afterLine };

      const items: RedisReply[] = [];
      let cursor = afterLine;
      for (let i = 0; i < count; i += 1) {
        const item = parseReply(buffer, cursor);
        if (!item) return undefined;
        items.push(item.value);
        cursor = item.next;
      }
      return { value: items, next: cursor };
    }
    default:
      // An unrecognised type byte means the stream is out of sync, and
      // guessing past it would silently mis-attribute every later reply.
      return {
        value: new Error('unrecognised RESP reply') as unknown as RedisReply,
        next: afterLine,
      };
  }
};

export interface RedisClientOptions {
  readonly url: string;
  readonly tlsEnabled?: boolean;
  readonly logger: Logger;
  readonly connectTimeoutMs?: number;
  readonly commandTimeoutMs?: number;
  /** Injected so tests can drive a socket that misbehaves. */
  readonly connectImpl?: (target: { host: string; port: number; tls: boolean }) => Socket;
}

export const createRedisClient = (options: RedisClientOptions): RedisClient | undefined => {
  const target = parseRedisUrl(options.url, options.tlsEnabled ?? false);
  if (!target) {
    options.logger.error(
      { control: 'rate_limit_store' },
      'REDIS_URL could not be parsed: rate limiting will stay per-instance',
    );
    return undefined;
  }

  const commandTimeoutMs = options.commandTimeoutMs ?? 1_000;
  const connectTimeoutMs = options.connectTimeoutMs ?? 2_000;

  let socket: Socket | undefined;
  let buffer = Buffer.alloc(0);
  let connecting: Promise<void> | undefined;
  let healthy = false;
  let closed = false;
  /** Replies are matched to commands FIFO, which is what RESP guarantees. */
  let waiting: { resolve: (value: RedisReply) => void; reject: (error: Error) => void }[] = [];

  const failAllWaiting = (error: Error): void => {
    const pending = waiting;
    waiting = [];
    for (const entry of pending) entry.reject(error);
  };

  const teardown = (reason: string): void => {
    healthy = false;
    buffer = Buffer.alloc(0);
    socket?.removeAllListeners();
    socket?.destroy();
    socket = undefined;
    connecting = undefined;
    failAllWaiting(new Error(reason));
  };

  const onData = (chunk: Buffer): void => {
    buffer = Buffer.concat([buffer, chunk]);

    for (;;) {
      const reply = parseReply(buffer);
      if (!reply) break;
      buffer = buffer.subarray(reply.next);

      const entry = waiting.shift();
      if (!entry) continue;
      if (reply.value instanceof Error) entry.reject(reply.value);
      else entry.resolve(reply.value);
    }
  };

  const open = async (): Promise<void> => {
    if (closed) throw new Error('client is closed');
    if (socket && healthy) return;
    if (connecting) return await connecting;

    connecting = new Promise<void>((resolve, reject) => {
      const created = options.connectImpl
        ? options.connectImpl(target)
        : target.tls
          ? tlsConnect({ host: target.host, port: target.port, servername: target.host })
          : netConnect({ host: target.host, port: target.port });

      socket = created;
      const timer = setTimeout(() => {
        teardown('redis connect timed out');
        reject(new Error('redis connect timed out'));
      }, connectTimeoutMs);

      const settle = (error?: Error): void => {
        clearTimeout(timer);
        if (error) {
          teardown(error.message);
          reject(error);
          return;
        }
        healthy = true;
        resolve();
      };

      created.setNoDelay(true);
      created.on('data', onData);
      created.on('error', (error: Error) => {
        // Reconnection is lazy: the next command reopens. A retry loop here
        // would hammer a Redis that is already struggling.
        if (healthy) teardown(error.message);
        else settle(error);
      });
      created.on('close', () => {
        if (healthy) teardown('redis connection closed');
      });

      created.on(target.tls ? 'secureConnect' : 'connect', () => {
        if (target.password === undefined) {
          settle();
          return;
        }

        /* AUTH before anything else, and its reply is consumed by the normal
         * FIFO path so nothing special-cases the handshake. */
        const parts =
          target.username === undefined
            ? ['AUTH', target.password]
            : ['AUTH', target.username, target.password];

        waiting.push({
          resolve: () => {
            settle();
          },
          reject: (error) => {
            settle(error);
          },
        });
        created.write(encode(parts));
      });
    });

    try {
      await connecting;
    } finally {
      connecting = undefined;
    }
  };

  const send = async (commands: readonly (readonly string[])[]): Promise<RedisReply[]> => {
    await open();
    const active = socket;
    if (!active) throw new Error('redis is not connected');

    const replies = commands.map(
      async (parts) =>
        await new Promise<RedisReply>((resolve, reject) => {
          const timer = setTimeout(() => {
            /* A timed-out command leaves the stream ambiguous — its reply may
             * still arrive and would be matched to the NEXT command. Dropping
             * the connection is the only way to stay in sync, and a limiter
             * that mis-attributes counts is worse than one that reconnects. */
            teardown('redis command timed out');
            reject(new Error('redis command timed out'));
          }, commandTimeoutMs);

          waiting.push({
            resolve: (value) => {
              clearTimeout(timer);
              resolve(value);
            },
            reject: (error) => {
              clearTimeout(timer);
              reject(error);
            },
          });

          void parts;
        }),
    );

    active.write(commands.map((parts) => encode(parts)).join(''));
    return await Promise.all(replies);
  };

  return {
    command: async (...parts: readonly string[]) => (await send([parts]))[0] ?? null,
    pipeline: async (commands) => await send(commands),
    get healthy() {
      return healthy;
    },
    close: () => {
      closed = true;
      teardown('client closed');
    },
  };
};
