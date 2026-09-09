import { ProviderTimeoutError, ProviderUnavailableError } from '@kids/shared';
import { describe, expect, it } from 'vitest';

import { createMockProvider } from './mock-provider.js';
import type { AIProvider, ModerationRequest, ModerationResult } from './ports.js';
import { providerAsClassifier } from './safety-classifier.js';

/**
 * The classifier adapter.
 *
 * These exist because of a real page: the safety classifier was the only
 * provider call in the system with no retry and no breaker, so one 429 blocked
 * a child's turn and fired the critical `safety_pipeline` alert. The tests that
 * matter most here are the two that pin the boundary — a blip is survived, and
 * a classifier that is genuinely down still fails closed.
 */

/** A provider whose classifier fails a given number of times, then answers. */
const flaky = (
  failures: number,
  error: () => unknown,
): { provider: AIProvider; calls: () => ModerationRequest[] } => {
  const base = createMockProvider();
  const calls: ModerationRequest[] = [];
  let remaining = failures;

  return {
    calls: () => calls,
    provider: {
      ...base,
      moderateContent: async (moderation: ModerationRequest): Promise<ModerationResult> => {
        calls.push(moderation);
        if (remaining > 0) {
          remaining -= 1;
          throw error();
        }
        return await base.moderateContent(moderation);
      },
    },
  };
};

describe('providerAsClassifier', () => {
  it('passes the request through and reports the verdict', async () => {
    const classifier = providerAsClassifier(createMockProvider());

    const result = await classifier.classify({
      text: '__unsafe__ things',
      ageGroup: 'AGE_6_8',
      language: 'en',
      scope: 'child_input',
      timeoutMs: 4_000,
    });

    expect(result.flagged).toBe(true);
    expect(result.categories).toContain('violence');
  });

  it('survives a transient rate limit rather than failing the turn', async () => {
    const { provider, calls } = flaky(1, () =>
      Object.assign(new Error('rate limited'), { status: 429 }),
    );
    const classifier = providerAsClassifier(provider);

    const result = await classifier.classify({
      text: 'I built a sandcastle',
      ageGroup: 'AGE_6_8',
      language: 'en',
      scope: 'child_input',
      timeoutMs: 4_000,
    });

    expect(result.flagged).toBe(false);
    expect(calls()).toHaveLength(2);
  });

  it('survives a transient timeout', async () => {
    const { provider, calls } = flaky(1, () => new ProviderTimeoutError('moderateContent', 2_000));
    const classifier = providerAsClassifier(provider);

    await classifier.classify({
      text: 'I built a sandcastle',
      ageGroup: 'AGE_6_8',
      language: 'en',
      scope: 'child_input',
      timeoutMs: 4_000,
    });

    expect(calls()).toHaveLength(2);
  });

  /* The half that must not regress: retrying is not failing open. */
  it('still throws when the classifier is genuinely down, so the pipeline fails closed', async () => {
    const { provider, calls } = flaky(99, () => new ProviderUnavailableError('moderateContent'));
    const classifier = providerAsClassifier(provider);

    await expect(
      classifier.classify({
        text: 'I built a sandcastle',
        ageGroup: 'AGE_6_8',
        language: 'en',
        scope: 'child_input',
        timeoutMs: 4_000,
      }),
    ).rejects.toThrow(ProviderUnavailableError);

    expect(calls()).toHaveLength(2);
  });

  it('does not retry an error that will not change', async () => {
    const { provider, calls } = flaky(99, () =>
      Object.assign(new Error('bad request'), { status: 400 }),
    );
    const classifier = providerAsClassifier(provider);

    await expect(
      classifier.classify({
        text: 'I built a sandcastle',
        ageGroup: 'AGE_6_8',
        language: 'en',
        scope: 'child_input',
        timeoutMs: 4_000,
      }),
    ).rejects.toThrow('bad request');

    // A 400 is our bug, not the vendor's weather. Asking twice wastes a child's
    // latency budget for an answer that cannot change.
    expect(calls()).toHaveLength(1);
  });

  it('splits the caller’s timeout across attempts rather than multiplying it', async () => {
    const { provider, calls } = flaky(1, () =>
      Object.assign(new Error('rate limited'), { status: 429 }),
    );
    const classifier = providerAsClassifier(provider);

    await classifier.classify({
      text: 'I built a sandcastle',
      ageGroup: 'AGE_6_8',
      language: 'en',
      scope: 'child_input',
      timeoutMs: 4_000,
    });

    // Two classifications sit inside one turn's latency budget, so the ceiling
    // for a classification is the caller's timeout, not a multiple of it.
    for (const call of calls()) expect(call.timeoutMs).toBe(2_000);
  });

  it('honours a configured attempt count', async () => {
    const { provider, calls } = flaky(2, () =>
      Object.assign(new Error('rate limited'), { status: 429 }),
    );
    const classifier = providerAsClassifier(provider, { maxAttempts: 3 });

    await classifier.classify({
      text: 'I built a sandcastle',
      ageGroup: 'AGE_6_8',
      language: 'en',
      scope: 'child_input',
      timeoutMs: 3_000,
    });

    expect(calls()).toHaveLength(3);
    for (const call of calls()) expect(call.timeoutMs).toBe(1_000);
  });
});
