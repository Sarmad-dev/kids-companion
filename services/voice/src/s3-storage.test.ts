import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { Clock } from '@kids/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createS3AudioStorage } from './s3-storage.js';

/**
 * The S3 adapter, driven against a real HTTP server.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * A STUB THAT RETURNS WHAT THE CODE EXPECTS PROVES NOTHING
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * So this runs a small server that behaves the way S3 does on the four
 * operations used: it stores what it is given, answers 404 for what it does not
 * have, returns 204 for a delete whether or not the object was there, and
 * answers a ListObjectsV2 request with the XML shape the sweep parses.
 *
 * What it deliberately does NOT do is verify the signature — that would be
 * checking this implementation against itself. Conformance needs a real
 * endpoint, and none has ever been configured. What these tests cover is
 * everything else: the round trip, expiry on read, the sweep loop including
 * pagination, and that a failure is never mistaken for an absence.
 */

interface Stored {
  bytes: Buffer;
  headers: Record<string, string>;
}

describe('s3 audio storage', () => {
  let server: Server;
  let endpoint: string;
  let objects: Map<string, Stored>;
  let requests: { method: string; url: string; auth: string | undefined }[];
  /** Forces a status, so a failure path can be driven. */
  let failWith: number | undefined;

  let currentMs = new Date('2026-09-01T12:00:00.000Z').getTime();
  const clock: Clock = {
    now: () => currentMs,
    nowIso: () => new Date(currentMs).toISOString() as never,
  };

  const storage = () =>
    createS3AudioStorage({
      clock,
      endpoint,
      region: 'eu-west-1',
      bucket: 'child-audio',
      credentials: { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'not-a-real-secret' },
    });

  beforeAll(async () => {
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const url = new URL(request.url ?? '/', 'http://localhost');
        requests.push({
          method: request.method ?? '',
          url: request.url ?? '',
          auth: request.headers.authorization,
        });

        if (failWith !== undefined) {
          response.writeHead(failWith).end('<Error><Code>InternalError</Code></Error>');
          return;
        }

        // ListObjectsV2: `/bucket?list-type=2`.
        if (request.method === 'GET' && url.searchParams.get('list-type') === '2') {
          const token = url.searchParams.get('continuation-token');
          const keys = [...objects.keys()];
          // Two per page, so pagination is genuinely exercised.
          const start = token === null ? 0 : Number(token);
          const page = keys.slice(start, start + 2);
          const truncated = start + 2 < keys.length;

          response
            .writeHead(200, { 'content-type': 'application/xml' })
            .end(
              `<?xml version="1.0"?><ListBucketResult>${page
                .map((key) => `<Contents><Key>${key}</Key></Contents>`)
                .join('')}<IsTruncated>${String(truncated)}</IsTruncated>${
                truncated
                  ? `<NextContinuationToken>${String(start + 2)}</NextContinuationToken>`
                  : ''
              }</ListBucketResult>`,
            );
          return;
        }

        const key = decodeURIComponent(url.pathname.replace('/child-audio/', ''));

        if (request.method === 'PUT') {
          const headers: Record<string, string> = {};
          for (const [name, value] of Object.entries(request.headers)) {
            if (name.startsWith('x-amz-meta-') || name === 'content-type') {
              headers[name] = String(value);
            }
          }
          objects.set(key, { bytes: Buffer.concat(chunks), headers });
          response.writeHead(200).end();
          return;
        }

        const stored = objects.get(key);

        if (request.method === 'DELETE') {
          // S3 answers 204 whether or not it was there.
          objects.delete(key);
          response.writeHead(204).end();
          return;
        }

        if (!stored) {
          response.writeHead(404).end('<Error><Code>NoSuchKey</Code></Error>');
          return;
        }

        const headers = { ...stored.headers, 'content-length': String(stored.bytes.length) };
        if (request.method === 'HEAD') {
          response.writeHead(200, headers).end();
          return;
        }
        response.writeHead(200, headers).end(stored.bytes);
      });
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    endpoint = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });

  beforeEach(() => {
    objects = new Map();
    requests = [];
    failWith = undefined;
    currentMs = new Date('2026-09-01T12:00:00.000Z').getTime();
  });

  const put = async (expiresInMs = 60_000) =>
    await storage().put({
      kind: 'companion_reply',
      bytes: new Uint8Array([1, 2, 3, 4]),
      mimeType: 'audio/mpeg',
      durationMs: 1_500,
      expiresAt: new Date(currentMs + expiresInMs),
    });

  /* ======================================================================== */
  /* The round trip                                                           */
  /* ======================================================================== */

  it('stores and returns the same bytes', async () => {
    const stored = await put();
    const fetched = await storage().get(stored.key);

    expect(fetched?.bytes).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(fetched?.meta.kind).toBe('companion_reply');
    expect(fetched?.meta.mimeType).toBe('audio/mpeg');
    expect(fetched?.meta.durationMs).toBe(1_500);
  });

  it('signs every request it makes', async () => {
    // Not a conformance check — just that nothing goes out unsigned, which is
    // how an object ends up publicly readable by accident.
    await put();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.auth).toMatch(/^AWS4-HMAC-SHA256 Credential=/);
  });

  it('gives every object an unguessable key', async () => {
    /* The key is the only thing between a URL and a recording of a child, and
     * the fact that every read is also authorised does not make a guessable key
     * acceptable — defence in depth means the second control assumes the first
     * has failed. */
    const keys = new Set<string>();
    for (let i = 0; i < 5; i += 1) keys.add((await put()).key);

    expect(keys.size).toBe(5);
    for (const key of keys) expect(key).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });

  /* ======================================================================== */
  /* Expiry                                                                   */
  /* ======================================================================== */

  it('refuses to return an expired object even though it is still there', async () => {
    /* ═══════════════════════════════════════════════════════════════════════
     * EXPIRY IS ENFORCED ON READ, NOT LEFT TO THE SWEEP.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * A bucket lifecycle rule runs when the provider feels like it and the
     * sweep runs on a timer. Neither is a guarantee at the moment somebody asks
     * for a child's recording. The port says an expired object is gone rather
     * than merely old.
     */
    const stored = await put(60_000);
    currentMs += 61_000;

    expect(await storage().get(stored.key)).toBeUndefined();
    // Still in the bucket — this is a read-time refusal, not a deletion.
    expect(objects.size).toBe(1);
  });

  it('cannot tell a caller the difference between absent and expired', async () => {
    // Deliberate: the port says so. A caller that could distinguish them would
    // learn that a recording once existed.
    const stored = await put(60_000);
    currentMs += 61_000;

    expect(await storage().get(stored.key)).toBeUndefined();
    expect(await storage().get('never-existed-at-all')).toBeUndefined();
  });

  /* ======================================================================== */
  /* Deletion                                                                 */
  /* ======================================================================== */

  it('deletes, rather than tombstoning', async () => {
    const stored = await put();
    await storage().delete(stored.key);

    expect(objects.size).toBe(0);
  });

  it('is idempotent about deleting something that is already gone', async () => {
    await expect(storage().delete('not-there')).resolves.toBeUndefined();
  });

  /* ======================================================================== */
  /* The sweep                                                                */
  /* ======================================================================== */

  it('sweeps what has expired and leaves what has not', async () => {
    const keep = await put(600_000);
    await put(1_000);
    await put(1_000);

    currentMs += 60_000;

    expect(await storage().sweep()).toBe(2);
    expect([...objects.keys()]).toEqual([keep.key]);
  });

  it('follows pagination rather than stopping at the first page', async () => {
    /* The server pages two at a time. A sweep that ignored the continuation
     * token would silently retain everything past the first page — a retention
     * failure that looks exactly like a working sweep. */
    for (let i = 0; i < 5; i += 1) await put(1_000);
    currentMs += 60_000;

    expect(await storage().sweep()).toBe(5);
    expect(objects.size).toBe(0);
  });

  it('deletes an object it cannot date', async () => {
    // An object in this bucket with no expiry metadata is not one to keep: we
    // cannot say when it should go, and it holds a child's voice.
    objects.set('orphan-with-no-metadata', { bytes: Buffer.from([1]), headers: {} });

    expect(await storage().sweep()).toBe(1);
    expect(objects.size).toBe(0);
  });

  /* ======================================================================== */
  /* Failure is not absence                                                   */
  /* ======================================================================== */

  it('throws on a server error rather than reporting the audio as gone', async () => {
    /* ═══════════════════════════════════════════════════════════════════════
     * THE DIFFERENCE BETWEEN "IT IS GONE" AND "WE COULD NOT ASK".
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `get` returning undefined means the object is absent or expired, and a
     * caller acts on that. Returning undefined for a 500 would tell the caller
     * a child's audio no longer exists when the truth is that the store was
     * unreachable for a moment.
     */
    const stored = await put();
    failWith = 500;

    await expect(storage().get(stored.key)).rejects.toThrow(/object storage returned 500/);
  });

  it('never puts the object key in an error message', async () => {
    /* An S3 error document echoes the key back, and the key is the one thing
     * between a URL and a recording of a child. Error messages reach logs. */
    const stored = await put();
    failWith = 503;

    const message = await storage()
      .get(stored.key)
      .then(
        () => '',
        (error: unknown) => String(error),
      );

    expect(message).toContain('503');
    expect(message).not.toContain(stored.key);
  });

  /* ======================================================================== */
  /* The shape of the port                                                    */
  /* ======================================================================== */

  it('offers no way to mint a URL for a client', async () => {
    /* ═══════════════════════════════════════════════════════════════════════
     * THE ABSENCE IS THE CONTROL.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * No presigned upload URL, no presigned download URL, no bucket credential
     * on a device. A credential scoped to a bucket of children's voices,
     * shipped inside a mobile app, is a credential in a decompiled APK — and
     * there is no rotation that un-leaks a child's voice.
     *
     * You cannot leak what there is no function to produce, so this asserts the
     * surface stays exactly four operations wide.
     */
    const surface = Object.keys(storage()).sort();

    expect(surface).toEqual(['delete', 'get', 'name', 'put', 'sweep']);
    expect(JSON.stringify(surface)).not.toMatch(/sign|presign|url/i);
  });

  it('reports a name the sweep gate can act on', async () => {
    // `audioSweepIsShared` is decided by this, and it decides whether the
    // worker schedules audio retention at all.
    expect(storage().name).toBe('s3');
  });
});
