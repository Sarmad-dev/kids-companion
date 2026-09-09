import { createHash, createHmac } from 'node:crypto';

/**
 * AWS Signature Version 4, for S3-compatible object storage.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS IS HAND-WRITTEN
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The same reason `probeRedis` speaks RESP without a Redis client and the error
 * tracker writes its own envelope: an SDK brings behaviour nobody in this
 * repository chose. `@aws-sdk/client-s3` pulls a large dependency tree, retries
 * and instruments on its own schedule, and would put a third party between this
 * service and a bucket of children's voice recordings.
 *
 * SigV4 is fully specified and deterministic, which makes it a reasonable thing
 * to write out. It is also unforgiving: a signature that is wrong by one byte
 * produces a 403, immediately and every time. That is the good kind of failure —
 * it cannot half-work, and it cannot silently store a child's audio somewhere
 * unintended.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THE TESTS CAN AND CANNOT PROVE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The unit tests cover the canonical request format, the encoding rules, the
 * key-derivation chain, and that every input actually changes the signature.
 * They CANNOT prove conformance: only a real endpoint accepting a real request
 * does that, and no bucket has ever been configured. Anything that says
 * otherwise in a review would be wrong.
 */

export interface S3Credentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** For temporary credentials. Sent as `x-amz-security-token` when present. */
  readonly sessionToken?: string | undefined;
}

export interface SignedRequest {
  readonly method: string;
  readonly url: URL;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}

const SERVICE = 's3';
const ALGORITHM = 'AWS4-HMAC-SHA256';

const sha256Hex = (data: Uint8Array | string): string =>
  createHash('sha256')
    .update(typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data))
    .digest('hex');

const hmac = (key: Buffer | string, data: string): Buffer =>
  createHmac('sha256', key).update(data, 'utf8').digest();

/**
 * RFC 3986 percent-encoding, which is NOT what `encodeURIComponent` does.
 *
 * The differences are small and every one of them breaks a signature:
 * `!`, `'`, `(`, `)` and `*` are left alone by `encodeURIComponent` and must be
 * encoded here; a space must become `%20` and never `+`; and the hex digits are
 * uppercase.
 */
export const uriEncode = (value: string, encodeSlash = true): string => {
  let out = '';
  for (const char of Buffer.from(value, 'utf8')) {
    const c = String.fromCharCode(char);
    if (/[A-Za-z0-9\-._~]/.test(c)) {
      out += c;
    } else if (c === '/' && !encodeSlash) {
      out += c;
    } else {
      out += `%${char.toString(16).toUpperCase().padStart(2, '0')}`;
    }
  }
  return out;
};

/** `20260901T120000Z` and `20260901`, the only two date shapes SigV4 uses. */
export const amzDates = (now: Date): { amzDate: string; dateStamp: string } => {
  const amzDate = `${now.toISOString().replace(/[-:]/g, '').split('.')[0]!}Z`;
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
};

/**
 * The canonical request.
 *
 * Six lines, in this order, exactly. Exported because a malformed canonical
 * request is the single most likely way this goes wrong, and a test that can
 * read it is worth more than one that can only see a hex digest at the end.
 */
export const canonicalRequest = (input: {
  method: string;
  url: URL;
  headers: Readonly<Record<string, string>>;
  payloadHash: string;
}): { canonical: string; signedHeaders: string } => {
  const path = input.url.pathname === '' ? '/' : uriEncode(input.url.pathname, false);

  // Sorted by name, values encoded. A parameter with no value still gets its
  // `=`, which is why this builds pairs rather than using URLSearchParams.
  const query = [...input.url.searchParams.entries()]
    .map(([key, value]) => [uriEncode(key), uriEncode(value)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');

  const entries = Object.entries(input.headers)
    .map(([name, value]) => [name.toLowerCase(), value.trim().replace(/\s+/g, ' ')] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));

  const canonicalHeaders = entries.map(([name, value]) => `${name}:${value}\n`).join('');
  const signedHeaders = entries.map(([name]) => name).join(';');

  return {
    canonical: [
      input.method.toUpperCase(),
      path,
      query,
      canonicalHeaders,
      signedHeaders,
      input.payloadHash,
    ].join('\n'),
    signedHeaders,
  };
};

/**
 * The signing key.
 *
 * Four chained HMACs, each keyed by the previous result. The literal `AWS4`
 * prefix on the secret is part of the specification and is easy to lose in a
 * refactor — the derivation is separated out so a test can pin the chain.
 */
export const signingKey = (secretAccessKey: string, dateStamp: string, region: string): Buffer => {
  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, SERVICE);
  return hmac(kService, 'aws4_request');
};

/**
 * Signs a request, returning the headers to send with it.
 *
 * `x-amz-content-sha256` is required by S3 on every request and is also what
 * makes the body part of the signature: an intercepted request cannot have a
 * different child's audio substituted into it.
 */
export const signRequest = (input: {
  method: string;
  url: URL;
  headers?: Readonly<Record<string, string>>;
  body?: Uint8Array;
  region: string;
  credentials: S3Credentials;
  now: Date;
}): Record<string, string> => {
  const body = input.body ?? new Uint8Array(0);
  const payloadHash = sha256Hex(body);
  const { amzDate, dateStamp } = amzDates(input.now);

  const headers: Record<string, string> = {
    ...(input.headers ?? {}),
    host: input.url.host,
    'x-amz-date': amzDate,
    'x-amz-content-sha256': payloadHash,
    ...(input.credentials.sessionToken
      ? { 'x-amz-security-token': input.credentials.sessionToken }
      : {}),
  };

  const { canonical, signedHeaders } = canonicalRequest({
    method: input.method,
    url: input.url,
    headers,
    payloadHash,
  });

  const scope = `${dateStamp}/${input.region}/${SERVICE}/aws4_request`;
  const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonical)].join('\n');

  const signature = createHmac(
    'sha256',
    signingKey(input.credentials.secretAccessKey, dateStamp, input.region),
  )
    .update(stringToSign, 'utf8')
    .digest('hex');

  return {
    ...headers,
    authorization:
      `${ALGORITHM} Credential=${input.credentials.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
};
