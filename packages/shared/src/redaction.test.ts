import { describe, expect, it } from 'vitest';

import { createLogger } from './logger.js';
import { pseudonymize, redactObject, REDACTION_PLACEHOLDER } from './redaction.js';

describe('redactObject', () => {
  it('removes transcript text', () => {
    const result = redactObject({ transcript: 'I live at 42 Elm Street' });

    expect(result.transcript).toBe(REDACTION_PLACEHOLDER);
  });

  it('removes credentials', () => {
    const result = redactObject({ password: 'hunter2', refreshToken: 'rt_abc', apiKey: 'sk-1' });

    expect(result.password).toBe(REDACTION_PLACEHOLDER);
    expect(result.refreshToken).toBe(REDACTION_PLACEHOLDER);
    expect(result.apiKey).toBe(REDACTION_PLACEHOLDER);
  });

  it('removes child identity fields', () => {
    const result = redactObject({ displayName: 'Ayesha', birthYear: 2019 });

    expect(result.displayName).toBe(REDACTION_PLACEHOLDER);
    expect(result.birthYear).toBe(REDACTION_PLACEHOLDER);
  });

  it('redacts nested occurrences, not just top-level ones', () => {
    const result = redactObject({ outer: { inner: { transcript: 'secret words' } } });

    expect(JSON.stringify(result)).not.toContain('secret words');
  });

  it('redacts inside arrays', () => {
    const result = redactObject({ turns: [{ transcript: 'first' }, { transcript: 'second' }] });

    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain('first');
    expect(serialised).not.toContain('second');
  });

  it('keeps operational fields that carry no personal data', () => {
    const result = redactObject({
      durationMs: 1642,
      sttConfidence: 0.87,
      safetyVerdict: 'allowed',
    });

    expect(result).toEqual({ durationMs: 1642, sttConfidence: 0.87, safetyVerdict: 'allowed' });
  });

  it('truncates rather than recursing without bound', () => {
    const deep = { a: { b: { c: { d: { e: { f: 'too deep' } } } } } };

    expect(JSON.stringify(redactObject(deep))).toContain('[TRUNCATED]');
  });
});

/**
 * These assert on what the logger *writes*, not on how it is configured.
 * A redaction guarantee verified by reading the config is not verified at all.
 */
describe('logger redaction', () => {
  const capture = () => {
    const lines: string[] = [];
    const logger = createLogger({
      level: 'trace',
      serviceName: 'test',
      serviceVersion: '0.0.0',
      appEnv: 'ci',
      destination: { write: (line) => lines.push(line) },
    });
    return { logger, output: () => lines.join('') };
  };

  it('emits no transcript text even when passed explicitly at the most verbose level', () => {
    const { logger, output } = capture();

    logger.trace({ transcript: 'my name is Ayesha and I go to Beaconhouse' }, 'turn completed');

    expect(output()).not.toContain('Beaconhouse');
    expect(output()).toContain(REDACTION_PLACEHOLDER);
  });

  it('redacts a nested transcript', () => {
    const { logger, output } = capture();

    logger.info({ turn: { transcript: 'a secret sentence' } }, 'turn completed');

    expect(output()).not.toContain('a secret sentence');
  });

  it('redacts credentials and authorization headers', () => {
    const { logger, output } = capture();

    logger.info(
      { password: 'hunter2', req: { headers: { authorization: 'Bearer tok_live_abc' } } },
      'request received',
    );

    expect(output()).not.toContain('hunter2');
    expect(output()).not.toContain('tok_live_abc');
  });

  it('still emits the operational fields needed to debug a slow turn', () => {
    const { logger, output } = capture();

    logger.info(
      { durationMs: 1642, sttMs: 380, llmMs: 610, ttsMs: 340, safetyVerdict: 'allowed' },
      'conversation turn completed',
    );

    const written = output();
    expect(written).toContain('1642');
    expect(written).toContain('allowed');
    expect(written).toContain('conversation turn completed');
  });
});

describe('pseudonymize', () => {
  it('is stable for the same id and salt, so requests correlate within a window', () => {
    expect(pseudonymize('c', 'chp_123', 'salt-a')).toBe(pseudonymize('c', 'chp_123', 'salt-a'));
  });

  it('changes when the salt rotates, bounding how long logs stay linkable', () => {
    expect(pseudonymize('c', 'chp_123', 'salt-a')).not.toBe(pseudonymize('c', 'chp_123', 'salt-b'));
  });

  it('does not contain the original identifier', () => {
    expect(pseudonymize('c', 'chp_123', 'salt-a')).not.toContain('chp_123');
  });
});
