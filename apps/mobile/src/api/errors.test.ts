import { describe, expect, it } from 'vitest';

import { failureFor, toFriendlyFailure } from './errors';

/**
 * What a child is shown when something breaks.
 *
 * The assertions here are mostly about what is ABSENT: no code, no status, no
 * provider name, no request id. A four-year-old cannot act on "503", and showing
 * it teaches them the thing is broken and that they broke it.
 */

describe('mapping a failure', () => {
  it.each([
    [{ offline: true }, 'offline'],
    [{ timedOut: true }, 'slow'],
    [{ status: 500 }, 'server'],
    [{ status: 503 }, 'server'],
    [{ status: 401 }, 'unauthorised'],
    [{ status: 403 }, 'unauthorised'],
    [{ status: 429 }, 'not_allowed_now'],
    [{ status: 402 }, 'not_allowed_now'],
    [{ status: 400 }, 'not_allowed_now'],
    [{}, 'unknown'],
  ])('maps %j to %s', (input, expected) => {
    expect(toFriendlyFailure(input).kind).toBe(expected);
  });

  it('prefers offline over anything the server might have said', () => {
    // A request that never left the device tells us nothing about the server.
    expect(toFriendlyFailure({ offline: true, status: 500 }).kind).toBe('offline');
  });

  it('recognises a plan refusal by code', () => {
    expect(
      toFriendlyFailure({ status: 402, body: { error: { code: 'SUBSCRIPTION_REQUIRED' } } }).kind,
    ).toBe('not_allowed_now');
  });
});

describe('what reaches the screen', () => {
  const everyFailure = () => [
    toFriendlyFailure({ offline: true }),
    toFriendlyFailure({ timedOut: true }),
    toFriendlyFailure({ status: 500 }),
    toFriendlyFailure({ status: 401 }),
    toFriendlyFailure({ status: 429 }),
    toFriendlyFailure({}),
    failureFor('nothing_heard'),
    failureFor('microphone_blocked'),
  ];

  it('never contains a status code, a stack, or a vendor name', () => {
    for (const failure of everyFailure()) {
      const text = failure.message.toLowerCase();
      expect(text).not.toMatch(/\b[45]\d\d\b/);
      expect(text).not.toMatch(/error|exception|stack|null|undefined|failed/);
      expect(text).not.toMatch(/anthropic|deepgram|elevenlabs|postgres|supabase|api key|token/);
    }
  });

  it('never blames the child', () => {
    for (const failure of everyFailure()) {
      expect(failure.message.toLowerCase()).not.toMatch(/you did|your fault|invalid|wrong/);
    }
  });

  it('is always a full warm sentence', () => {
    for (const failure of everyFailure()) {
      expect(failure.message.length).toBeGreaterThan(15);
      expect(failure.message).toMatch(/[.!?]$/);
    }
  });

  it('sends a child to a grown-up when only a grown-up can fix it', () => {
    // A child has no account and cannot sign in. Telling them they are "logged
    // out" gives them a problem they cannot solve.
    expect(toFriendlyFailure({ status: 401 }).message.toLowerCase()).toContain('grown-up');
    expect(failureFor('microphone_blocked').message.toLowerCase()).toContain('grown-up');
  });

  it('keeps the request id for support and off the screen', () => {
    const failure = toFriendlyFailure({
      status: 500,
      body: { error: { code: 'INTERNAL_ERROR', requestId: 'req-abc-123' } },
    });

    expect(failure.requestId).toBe('req-abc-123');
    expect(failure.message).not.toContain('req-abc-123');
  });

  it('keeps the error code so a screen can act on it, and off the screen', () => {
    const failure = toFriendlyFailure({
      status: 429,
      body: { error: { code: 'QUOTA_CONCURRENT_CONVERSATIONS', requestId: 'req-1' } },
    });

    // ConversationScreen recognises this one and repairs the conversation a
    // previous session left open, instead of showing a child a sentence that
    // will never stop being true.
    expect(failure.code).toBe('QUOTA_CONCURRENT_CONVERSATIONS');
    expect(failure.kind).toBe('not_allowed_now');
    // Carried for a decision, never for display — same rule as the request id.
    expect(failure.message).not.toContain('QUOTA');
    expect(failure.message).not.toContain('_');
  });

  it('offers a retry only when retrying could help', () => {
    expect(toFriendlyFailure({ offline: true }).retryable).toBe(true);
    expect(toFriendlyFailure({ status: 500 }).retryable).toBe(true);
    // Waiting does not fix a plan or a parental control, and a button that never
    // works teaches a child the app is broken.
    expect(toFriendlyFailure({ status: 429 }).retryable).toBe(false);
    expect(toFriendlyFailure({ status: 401 }).retryable).toBe(false);
  });
});
