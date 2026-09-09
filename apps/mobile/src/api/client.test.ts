import { describe, expect, it } from 'vitest';

import { createApiClient } from './client';

/**
 * The API client.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY `mediaSource` IS TESTED AND THE REST IS MOSTLY NOT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every other call goes through `request()`, which adds the base url and the
 * authorization header for you. Audio playback does not: the player fetches the
 * file itself, so anything `request()` would have added has to be handed to it
 * explicitly.
 *
 * It was not. The conversation screen passed a bare `/api/voice/audio/<key>`,
 * which fails twice — a relative path has no origin to resolve against on a
 * native platform, and the endpoint is authenticated so it answers 401 anyway.
 * The result was that the character's SPOKEN reply never played, in a
 * voice-first product whose users are too young to read the transcript.
 *
 * Nothing caught it, because the screens have no tests and the failure is
 * silent — the text reply still arrived, so the app looked like it worked.
 */

const client = (token: string | undefined, baseUrl = 'https://api.kidscompanion.app') =>
  createApiClient({
    baseUrl,
    getToken: async () => await Promise.resolve(token),
    isOnline: () => true,
  });

describe('mediaSource', () => {
  it('returns an absolute url', async () => {
    // The bug. A native audio player has no page to resolve a relative path
    // against, so `/api/voice/audio/abc` is not a location at all.
    const source = await client('tok').mediaSource('/api/voice/audio/abc');

    expect(source.uri).toBe('https://api.kidscompanion.app/api/voice/audio/abc');
    expect(source.uri.startsWith('http')).toBe(true);
  });

  it('carries the session token', async () => {
    // The other half. That endpoint is authenticated and scoped to the child's
    // own conversations; without this header it answers 401 and the child hears
    // nothing.
    const source = await client('tok').mediaSource('/api/voice/audio/abc');

    expect(source.headers).toEqual({ authorization: 'Bearer tok' });
  });

  it('omits the header entirely when signed out', async () => {
    // Not `authorization: "Bearer undefined"`, which is a header that looks
    // present and is worse to debug than an absent one.
    const source = await client(undefined).mediaSource('/api/voice/audio/abc');

    expect(source.headers).toEqual({});
    expect('authorization' in source.headers).toBe(false);
  });

  it('does not double the slash between base and route', async () => {
    const source = await client('tok', 'https://api.example').mediaSource('/api/voice/audio/abc');

    expect(source.uri).not.toContain('//api/voice');
  });
});
