import type { Clock } from '@kids/shared';

import type { AudioKind, AudioStorage, PutAudioRequest, StoredAudio } from './ports.js';
import { isReadable } from './retention.js';
import { signRequest, uriEncode, type S3Credentials } from './s3-signing.js';
import { newAudioKey } from './storage.js';

/**
 * Audio storage on an S3-compatible object store.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE GAP THIS CLOSES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The only implementation was in-memory. Audio did not survive a restart, was
 * not shared between instances, and — the consequence that mattered most — the
 * audio RETENTION sweep could not be scheduled at all. Deleting from the worker
 * would have marked the ledger while the bytes stayed alive in the API's heap,
 * and a retention record asserting a deletion that did not happen is worse than
 * no sweep, because it is the record somebody would rely on.
 *
 * With a shared store there is no such gap: the DELETE is the deletion.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE CLIENT STILL NEVER TALKS TO STORAGE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * No presigned upload URL, no presigned download URL, no bucket credential on a
 * device. A mobile app posts bytes to our API and fetches reply audio from our
 * API; only the server holds a key. A credential scoped to a bucket of
 * children's voices, shipped inside a mobile app, is a credential in a
 * decompiled APK — and there is no rotation that un-leaks a child's voice
 * (docs/adr/0006).
 *
 * This adapter therefore exposes no URL-minting method at all. The absence is
 * the control: you cannot leak what there is no function to produce.
 */

export interface S3AudioStorageOptions {
  readonly clock: Clock;
  /** e.g. `https://s3.eu-west-1.amazonaws.com`, an R2 endpoint, or MinIO. */
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly credentials: S3Credentials;
  /**
   * Path-style addressing (`endpoint/bucket/key`) rather than virtual-host.
   *
   * Required by MinIO and by most self-hosted gateways; AWS accepts both.
   * Default true because the failure mode of the wrong choice is a confusing
   * DNS error rather than a clear rejection.
   */
  readonly forcePathStyle?: boolean;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

/** Object metadata. S3 lowercases these, so nothing here may depend on case. */
const META_KIND = 'x-amz-meta-kind';
const META_MIME = 'x-amz-meta-mime';
const META_DURATION = 'x-amz-meta-duration-ms';
const META_EXPIRES = 'x-amz-meta-expires-at';

/**
 * How many objects one sweep will look at.
 *
 * Bounded so a sweep cannot hold the worker for an unbounded time or collect an
 * unbounded list of keys. Reaching it is not a failure: audio is deleted inline
 * when its turn ends, this is the backstop, and the next pass continues.
 */
const MAX_SWEEP_OBJECTS = 10_000;

/**
 * The valid kinds, derived from the type rather than listed by hand.
 *
 * A first draft hand-listed three values, none of which were the real two. The
 * consequence was not a wrong label: `metaOf` would never have matched, so
 * every read would have reported a child's audio as absent and every sweep
 * would have deleted unexpired recordings as undatable. The runtime tests did
 * not catch it — they used the same wrong value — and `tsc` did.
 *
 * Annotated so that changing `AudioKind` is a compile error here rather than a
 * silent behaviour change.
 */
const AUDIO_KINDS: readonly AudioKind[] = ['child_upload', 'companion_reply'];

const isAudioKind = (value: string): value is AudioKind =>
  (AUDIO_KINDS as readonly string[]).includes(value);

export const createS3AudioStorage = (options: S3AudioStorageOptions): AudioStorage => {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const doFetch = options.fetchImpl ?? fetch;
  const pathStyle = options.forcePathStyle ?? true;

  const base = new URL(options.endpoint);

  console.log("Base: ", base)

  /** Where one object lives. Keys are base64url, so no segment needs escaping. */
  const objectUrl = (key: string): URL => {
    const url = new URL(base.toString());
    if (pathStyle) {
      url.pathname = `/${options.bucket}/${uriEncode(key)}`;
    } else {
      url.host = `${options.bucket}.${base.host}`;
      url.pathname = `/${uriEncode(key)}`;
    }
    return url;
  };

  /**
   * One signed request.
   *
   * ═══════════════════════════════════════════════════════════════════════
   * A FAILURE HERE MUST NEVER BE MISTAKEN FOR AN ABSENCE.
   * ═══════════════════════════════════════════════════════════════════════
   *
   * `get` returns undefined for a missing or expired object, which is a normal
   * answer. A network failure or a 500 is NOT that answer, and returning
   * undefined for it would tell a caller "this child's audio is gone" when the
   * truth is "we could not ask". Every non-404 failure throws.
   */
  const send = async (
    method: string,
    url: URL,
    init: { headers?: Record<string, string>; body?: Uint8Array } = {},
  ): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    try {
      const headers = signRequest({
        method,
        url,
        ...(init.headers ? { headers: init.headers } : {}),
        ...(init.body ? { body: init.body } : {}),
        region: options.region,
        credentials: options.credentials,
        now: new Date(options.clock.now()),
      });

      const response = await doFetch(url.toString(), {
        method,
        headers,
        ...(init.body ? { body: Buffer.from(init.body) } : {}),
        signal: controller.signal,
      });

      if (!response.ok && response.status !== 404) {
        /* The body is deliberately not read into the message. An S3 error
         * document can echo the key back, and the key is the one thing between
         * a URL and a recording of a child. */
        throw new Error(`object storage returned ${String(response.status)} for ${method}`);
      }

      return response;
    } finally {
      clearTimeout(timer);
    }
  };

  const metaOf = (key: string, headers: Headers): StoredAudio | undefined => {
    const expires = headers.get(META_EXPIRES);
    const kind = headers.get(META_KIND) ?? '';
    if (expires === null || !isAudioKind(kind)) return undefined;

    const durationRaw = headers.get(META_DURATION);
    const duration = durationRaw === null ? undefined : Number(durationRaw);

    return {
      key,
      kind,
      mimeType: headers.get(META_MIME) ?? 'application/octet-stream',
      byteSize: Number(headers.get('content-length') ?? 0),
      ...(duration !== undefined && Number.isFinite(duration) ? { durationMs: duration } : {}),
      expiresAt: new Date(expires),
    };
  };

  return {
    name: 's3',

    put: async (request: PutAudioRequest): Promise<StoredAudio> => {
      const key = newAudioKey();

      await send('PUT', objectUrl(key), {
        headers: {
          'content-type': request.mimeType,
          [META_KIND]: request.kind,
          [META_MIME]: request.mimeType,
          [META_EXPIRES]: request.expiresAt.toISOString(),
          ...(request.durationMs === undefined
            ? {}
            : { [META_DURATION]: String(request.durationMs) }),
        },
        body: request.bytes,
      });

      return {
        key,
        kind: request.kind,
        mimeType: request.mimeType,
        byteSize: request.bytes.length,
        ...(request.durationMs === undefined ? {} : { durationMs: request.durationMs }),
        expiresAt: request.expiresAt,
      };
    },

    get: async (key: string) => {
      const response = await send('GET', objectUrl(key));
      if (response.status === 404) return undefined;

      const meta = metaOf(key, response.headers);
      // An object with no usable metadata is not something to hand back and
      // guess about. Treated as absent, and it will be swept.
      if (!meta) return undefined;

      /* ═══════════════════════════════════════════════════════════════════
       * EXPIRY IS ENFORCED ON READ, NOT LEFT TO THE SWEEP.
       * ═══════════════════════════════════════════════════════════════════
       *
       * A bucket lifecycle rule runs when the provider feels like it, and the
       * sweep runs on a timer. Neither is a guarantee at the moment somebody
       * asks for a child's recording. The port says an expired object is gone
       * rather than merely old, and this is where that is true.
       */
      if (!isReadable(meta.expiresAt, options.clock)) return undefined;

      const bytes = new Uint8Array(await response.arrayBuffer());
      return { meta: { ...meta, byteSize: bytes.length }, bytes };
    },

    delete: async (key: string): Promise<void> => {
      // S3 answers 204 for a delete whether or not the object was there, which
      // is the semantics we want: this is idempotent by design.
      await send('DELETE', objectUrl(key));
    },

    /**
     * The backstop.
     *
     * Audio is deleted inline when its turn ends; this catches the deletes that
     * did not happen — a crash between writing an object and deleting it, or a
     * storage call that failed.
     *
     * A bucket lifecycle rule is NOT a substitute. It is configuration on the
     * provider that this application cannot see, cannot test, and cannot prove
     * ran. Deleting explicitly means the retention record and the bytes agree.
     */
    sweep: async (): Promise<number> => {
      /* ═══════════════════════════════════════════════════════════════════
       * LIST EVERYTHING FIRST, THEN DELETE. NOT INTERLEAVED.
       * ═══════════════════════════════════════════════════════════════════
       *
       * Deleting while paginating means the listing is changing underneath the
       * cursor. AWS happens to survive that because its continuation token
       * encodes the last key seen, but that is a property of one provider —
       * an offset-based implementation would silently SKIP objects, and a
       * retention sweep that quietly misses a child's audio looks exactly like
       * a working one.
       *
       * So the two phases are separate, and the cost is bounded by the cap
       * below rather than by how much is in the bucket.
       */
      const expired: string[] = [];
      let examined = 0;
      let continuation: string | undefined;

      do {
        const url = new URL(base.toString());
        url.pathname = pathStyle ? `/${options.bucket}` : '/';
        if (!pathStyle) url.host = `${options.bucket}.${base.host}`;
        url.searchParams.set('list-type', '2');
        url.searchParams.set('max-keys', '1000');
        if (continuation !== undefined) url.searchParams.set('continuation-token', continuation);

        const response = await send('GET', url);
        const xml = await response.text();

        /* A regex over the listing rather than an XML parser.
         *
         * The response shape is fixed, the one field needed is simple, and a
         * parser is another dependency reading data from outside the system.
         * Keys are base64url here, so nothing in one needs unescaping.
         */
        const keys = [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((match) => match[1] ?? '');

        for (const key of keys) {
          if (key === '') continue;
          examined += 1;

          /* HEAD before deciding, because the expiry lives in the object's own
           * metadata and a listing does not carry it. One request per object
           * per sweep is the price of not trusting a lifecycle rule that
           * nothing here can see, test, or prove ran. */
          const head = await send('HEAD', objectUrl(key));
          if (head.status === 404) continue;

          const meta = metaOf(key, head.headers);
          // No metadata means nothing here can say when it should go. Deleted:
          // an object in this bucket that we cannot date is not one to keep.
          if (!meta || !isReadable(meta.expiresAt, options.clock)) expired.push(key);
        }

        const truncated = xml.includes('<IsTruncated>true</IsTruncated>');
        const next = /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml);
        continuation =
          truncated && next && examined < MAX_SWEEP_OBJECTS ? (next[1] ?? undefined) : undefined;
      } while (continuation !== undefined);

      let deleted = 0;
      for (const key of expired) {
        await send('DELETE', objectUrl(key));
        deleted += 1;
      }

      return deleted;
    },
  };
};
