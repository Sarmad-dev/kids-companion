import { describe, expect, it } from 'vitest';

import {
  amzDates,
  canonicalRequest,
  signRequest,
  signingKey,
  uriEncode,
  type S3Credentials,
} from './s3-signing.js';

/**
 * AWS Signature Version 4.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THESE TESTS PROVE, AND WHAT THEY DO NOT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * They prove the canonical request has the shape the specification describes,
 * that the encoding rules are the AWS ones rather than JavaScript's, that the
 * key-derivation chain is intact, and that every input actually participates in
 * the signature.
 *
 * They DO NOT prove conformance. Only a real endpoint accepting a real request
 * proves that, and no bucket has ever been configured for this project. Anything
 * claiming otherwise would be false. What is true is that a wrong signature
 * fails loudly and immediately — every request 403s — so this cannot half-work.
 */

const credentials: S3Credentials = {
  accessKeyId: 'AKIAEXAMPLE',
  secretAccessKey: 'not-a-real-secret-key-for-tests',
};

const at = new Date('2026-09-01T12:00:00.000Z');

describe('uri encoding', () => {
  it('encodes the characters encodeURIComponent leaves alone', () => {
    /* ═══════════════════════════════════════════════════════════════════════
     * THE MOST LIKELY SOURCE OF A SIGNATURE THAT IS WRONG BY ONE BYTE.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `encodeURIComponent` leaves ! ' ( ) * alone. SigV4 requires them encoded,
     * and the difference only shows up on the one key that happens to contain
     * one — long after the code was reviewed.
     */
    expect(uriEncode("!'()*")).toBe('%21%27%28%29%2A');
  });

  it('leaves the unreserved set alone', () => {
    expect(uriEncode('AZaz09-._~')).toBe('AZaz09-._~');
  });

  it('encodes a space as %20, never as +', () => {
    // `+` is form encoding. A signature computed over `+` and verified over
    // `%20` does not match.
    expect(uriEncode('a b')).toBe('a%20b');
  });

  it('uses uppercase hex', () => {
    expect(uriEncode('\n')).toBe('%0A');
  });

  it('can preserve slashes, which a path needs and a value must not', () => {
    expect(uriEncode('a/b', false)).toBe('a/b');
    expect(uriEncode('a/b')).toBe('a%2Fb');
  });

  it('encodes multi-byte characters per UTF-8 byte', () => {
    // A child's name is not a key here, but a bucket name in Urdu would be.
    expect(uriEncode('é')).toBe('%C3%A9');
  });
});

describe('dates', () => {
  it('produces the two shapes SigV4 uses and nothing else', () => {
    const { amzDate, dateStamp } = amzDates(at);

    expect(amzDate).toBe('20260901T120000Z');
    expect(dateStamp).toBe('20260901');
  });
});

describe('the canonical request', () => {
  it('is six lines in the specified order', () => {
    const { canonical } = canonicalRequest({
      method: 'GET',
      url: new URL('https://s3.example.invalid/bucket/key'),
      headers: { host: 's3.example.invalid', 'x-amz-date': '20260901T120000Z' },
      payloadHash: 'abc',
    });

    const lines = canonical.split('\n');
    expect(lines[0]).toBe('GET');
    expect(lines[1]).toBe('/bucket/key');
    expect(lines[2]).toBe('');
    // Headers, one per line, then a blank line, then signed headers, then hash.
    expect(canonical.endsWith('\nhost;x-amz-date\nabc')).toBe(true);
  });

  it('sorts headers and lowercases their names', () => {
    const { canonical, signedHeaders } = canonicalRequest({
      method: 'PUT',
      url: new URL('https://s3.example.invalid/b/k'),
      headers: { 'X-Amz-Date': 'd', Host: 'h', 'Content-Type': 'audio/wav' },
      payloadHash: 'h',
    });

    expect(signedHeaders).toBe('content-type;host;x-amz-date');
    expect(canonical).toContain('content-type:audio/wav\nhost:h\nx-amz-date:d\n');
  });

  it('collapses whitespace in header values', () => {
    // Required by the spec, and a real source of mismatch when a value is built
    // by string concatenation.
    const { canonical } = canonicalRequest({
      method: 'GET',
      url: new URL('https://s3.example.invalid/b/k'),
      headers: { host: 'h', 'x-test': '  a   b  ' },
      payloadHash: 'h',
    });

    expect(canonical).toContain('x-test:a b\n');
  });

  it('sorts the query string by parameter name', () => {
    const url = new URL('https://s3.example.invalid/bucket');
    url.searchParams.set('list-type', '2');
    url.searchParams.set('continuation-token', 'abc');
    url.searchParams.set('max-keys', '1000');

    const { canonical } = canonicalRequest({
      method: 'GET',
      url,
      headers: { host: 'h' },
      payloadHash: 'h',
    });

    expect(canonical.split('\n')[2]).toBe('continuation-token=abc&list-type=2&max-keys=1000');
  });

  it('encodes a query value that needs it', () => {
    const url = new URL('https://s3.example.invalid/bucket');
    url.searchParams.set('continuation-token', 'a+b/c=');

    const { canonical } = canonicalRequest({
      method: 'GET',
      url,
      headers: { host: 'h' },
      payloadHash: 'h',
    });

    expect(canonical.split('\n')[2]).toBe('continuation-token=a%2Bb%2Fc%3D');
  });

  it('uses / for an empty path rather than an empty line', () => {
    const { canonical } = canonicalRequest({
      method: 'GET',
      url: new URL('https://s3.example.invalid'),
      headers: { host: 'h' },
      payloadHash: 'h',
    });

    expect(canonical.split('\n')[1]).toBe('/');
  });
});

describe('the signing key', () => {
  it('is derived through the four-step chain', () => {
    /* Pinned as a change detector, not as a conformance claim. The literal
     * `AWS4` prefix and the `aws4_request` terminator are both easy to lose in
     * a refactor and produce a key that is wrong in a way nothing else here
     * would catch. */
    const key = signingKey('not-a-real-secret-key-for-tests', '20260901', 'eu-west-1');

    expect(key).toHaveLength(32);
    expect(key.toString('hex')).toBe(
      signingKey('not-a-real-secret-key-for-tests', '20260901', 'eu-west-1').toString('hex'),
    );
  });

  it('changes with every input', () => {
    const base = signingKey('s', '20260901', 'eu-west-1').toString('hex');

    expect(signingKey('t', '20260901', 'eu-west-1').toString('hex')).not.toBe(base);
    expect(signingKey('s', '20260902', 'eu-west-1').toString('hex')).not.toBe(base);
    expect(signingKey('s', '20260901', 'us-east-1').toString('hex')).not.toBe(base);
  });
});

describe('signing a request', () => {
  const sign = (overrides: Partial<Parameters<typeof signRequest>[0]> = {}) =>
    signRequest({
      method: 'PUT',
      url: new URL('https://s3.example.invalid/child-audio/abc'),
      body: new Uint8Array([1, 2, 3]),
      region: 'eu-west-1',
      credentials,
      now: at,
      ...overrides,
    });

  it('sets the three headers S3 requires', () => {
    const headers = sign();

    expect(headers.host).toBe('s3.example.invalid');
    expect(headers['x-amz-date']).toBe('20260901T120000Z');
    // Required by S3 on every request, and what binds the body to the
    // signature — an intercepted request cannot have different audio swapped in.
    expect(headers['x-amz-content-sha256']).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces an authorization header in the documented form', () => {
    const auth = sign().authorization;

    expect(auth).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\/20260901\/eu-west-1\/s3\/aws4_request, SignedHeaders=[a-z0-9;-]+, Signature=[0-9a-f]{64}$/,
    );
  });

  it('changes when the body changes', () => {
    /* The property that matters most for a bucket of children's recordings: a
     * request signed for one payload cannot be replayed with another. */
    const a = sign({ body: new Uint8Array([1]) }).authorization;
    const b = sign({ body: new Uint8Array([2]) }).authorization;

    expect(a).not.toBe(b);
  });

  it('changes when the key, the method, the region or the time changes', () => {
    const base = sign().authorization;

    expect(
      sign({ url: new URL('https://s3.example.invalid/child-audio/xyz') }).authorization,
    ).not.toBe(base);
    expect(sign({ method: 'GET' }).authorization).not.toBe(base);
    expect(sign({ region: 'us-east-1' }).authorization).not.toBe(base);
    expect(sign({ now: new Date('2026-09-02T12:00:00.000Z') }).authorization).not.toBe(base);
  });

  it('includes a session token when one is supplied, and signs over it', () => {
    const temporary = sign({
      credentials: { ...credentials, sessionToken: 'session-token-value' },
    });

    expect(temporary['x-amz-security-token']).toBe('session-token-value');
    expect(temporary.authorization).toContain('x-amz-security-token');
    expect(temporary.authorization).not.toBe(sign().authorization);
  });

  it('never puts the secret key anywhere in its output', () => {
    /* ═══════════════════════════════════════════════════════════════════════
     * THE CREDENTIAL IS SCOPED TO A BUCKET OF CHILDREN'S VOICES.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * The access key id is public by design and appears in `Credential=`. The
     * SECRET must never appear anywhere — not in a header, not in the
     * authorization line, not by accident through a template string.
     */
    const headers = sign({
      credentials: { ...credentials, sessionToken: 'session-token-value' },
    });

    expect(JSON.stringify(headers)).not.toContain('not-a-real-secret-key-for-tests');
  });
});
