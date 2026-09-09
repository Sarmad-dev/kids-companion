import { describe, expect, it } from 'vitest';

import { ConfigurationError, parseConfig } from './load.js';

/** The minimum a deployed environment needs before the strict rules apply. */
const deployedBase = {
  APP_ENV: 'production',
  NODE_ENV: 'production',
  DATABASE_SSL_MODE: 'require',
  REDIS_TLS_ENABLED: 'true',
  REDIS_KEY_PREFIX: 'kc:prod:',
  SAFETY_ESCALATION_WEBHOOK_URL: 'https://alerts.example.com/hook',
  ALERT_WEBHOOK_URL: 'https://alerts.example.com/ops',
  ERROR_TRACKING_PROVIDER: 'webhook',
  ERROR_TRACKING_WEBHOOK_URL: 'https://errors.example.com/ingest',
  REDIS_URL: 'rediss://cache.example.com:6379',
  STORAGE_PROVIDER: 's3',
  STORAGE_S3_ENDPOINT: 'https://s3.example.com',
  STORAGE_S3_ACCESS_KEY_ID: 'AKIAEXAMPLE',
  STORAGE_S3_SECRET_ACCESS_KEY: 'not-a-real-secret-for-tests',
  CORS_ALLOWED_ORIGINS: 'https://app.example.com',
  // A deployed environment must name a real rail; the mock one is refused.
  PAYMENTS_PROVIDER: 'stripe',
  STRIPE_SECRET_KEY: 'sk_test_not_a_real_key',
  STRIPE_WEBHOOK_SECRET: 'whsec_not_a_real_secret',
} as const;

describe('parseConfig', () => {
  it('applies safe defaults so a clean checkout boots with an empty environment', () => {
    const config = parseConfig({});

    expect(config.APP_ENV).toBe('local');
    expect(config.API_PORT).toBe(8080);
    // Every external provider defaults to a mock, so no API keys are needed.
    expect(config.AI_PROVIDER).toBe('mock');
    expect(config.STT_PROVIDER).toBe('mock');
    expect(config.TTS_PROVIDER).toBe('mock');
  });

  it('defaults raw audio retention to zero days', () => {
    // The highest-risk data decision available to us defaults to "do not retain".
    // See docs/adr/0006-voice-pipeline-and-audio-retention.md.
    expect(parseConfig({}).RETENTION_RAW_AUDIO_DAYS).toBe(0);
  });

  it('rejects a value that does not parse rather than coercing it', () => {
    expect(() => parseConfig({ API_PORT: 'not-a-port' })).toThrow(ConfigurationError);
  });

  it('rejects an unrecognised boolean instead of silently reading it as false', () => {
    expect(() => parseConfig({ METRICS_ENABLED: 'yes' })).toThrow(ConfigurationError);
  });

  it('normalises durations to seconds', () => {
    const config = parseConfig({ AUTH_ACCESS_TOKEN_TTL: '15m', CHILD_SESSION_TTL: '2h' });

    expect(config.AUTH_ACCESS_TOKEN_TTL).toBe(900);
    expect(config.CHILD_SESSION_TTL).toBe(7_200);
  });

  it('parses a comma-separated list into trimmed entries', () => {
    const config = parseConfig({ CORS_ALLOWED_ORIGINS: 'https://a.com, https://b.com ' });

    expect(config.CORS_ALLOWED_ORIGINS).toEqual(['https://a.com', 'https://b.com']);
  });

  it('names every failing variable, not just the first', () => {
    try {
      parseConfig({ API_PORT: 'nope', METRICS_ENABLED: 'maybe' });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      const { issues } = error as ConfigurationError;
      expect(issues.join('\n')).toContain('API_PORT');
      expect(issues.join('\n')).toContain('METRICS_ENABLED');
    }
  });

  it('rejects a secret still set to the .env.example placeholder', () => {
    expect(() => parseConfig({ AUTH_JWT_SECRET: 'replace-me-min-32-chars-high-entropy' })).toThrow(
      ConfigurationError,
    );
  });
});

describe('blank environment variables', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════
   * THE BUG THIS PREVENTS TOOK EVERY TURN A CHILD TOOK AND BLOCKED IT
   * ═══════════════════════════════════════════════════════════════════════
   *
   * `.env.example` ships optional variables as a bare `KEY=`, which every
   * dotenv parser reads as the empty string. Under `z.string().optional()`
   * that reached the app as `''`, and `'' ?? fallback` is `''` — so the
   * safety classifier was asked for a model named `''`, 404d, and failed
   * CLOSED. Every utterance came back a safety redirect.
   */
  it('treats a blank value as absent, so defaults apply', () => {
    const config = parseConfig({
      AI_MODEL_CONVERSATION: '',
      AI_MODEL_SAFETY_CLASSIFIER: '   ',
    });

    expect(config.AI_MODEL_CONVERSATION).toBeUndefined();
    expect(config.AI_MODEL_SAFETY_CLASSIFIER).toBeUndefined();
    // The shape every call site uses. `''` would defeat it silently.
    expect(config.AI_MODEL_CONVERSATION ?? 'gemini-2.5-flash').toBe('gemini-2.5-flash');
  });

  it('does not treat a blank credential as a configured vendor', () => {
    // An empty key made a vendor look reachable: the adapter was built with no
    // credential and offered to parents as a choice.
    const config = parseConfig({ OPENAI_API_KEY: '', ELEVENLABS_API_KEY: '  ' });

    expect(config.OPENAI_API_KEY).toBeUndefined();
    expect(config.ELEVENLABS_API_KEY).toBeUndefined();
  });

  it('still rejects a selected provider whose credential is only whitespace', () => {
    // The cross-field rules run on the coerced value, so a blank key is a
    // missing key here too rather than a passing one.
    expect(() => parseConfig({ AI_PROVIDER: 'google', GOOGLE_AI_API_KEY: '   ' })).toThrow(
      /GOOGLE_AI_API_KEY/,
    );
  });

  it('trims a value that is set, so a stray space is not part of a key', () => {
    const config = parseConfig({ ANTHROPIC_API_KEY: '  sk-ant-test  ' });

    expect(config.ANTHROPIC_API_KEY).toBe('sk-ant-test');
  });
});

describe('cross-field rules', () => {
  it('requires the provider credential when that provider is selected', () => {
    expect(() => parseConfig({ AI_PROVIDER: 'anthropic' })).toThrow(/ANTHROPIC_API_KEY/);
    expect(() => parseConfig({ AI_PROVIDER: 'openai' })).toThrow(/OPENAI_API_KEY/);
    expect(() => parseConfig({ AI_PROVIDER: 'google' })).toThrow(/GOOGLE_AI_API_KEY/);
  });

  it('accepts a vendor key without selecting that vendor as the default', () => {
    // This is what makes a provider offerable to a PARENT: the key is present,
    // so the adapter is built and listed, even though AI_PROVIDER names another.
    const config = parseConfig({ GOOGLE_AI_API_KEY: 'AIza-test' });

    expect(config.AI_PROVIDER).toBe('mock');
    expect(config.GOOGLE_AI_API_KEY).toBe('AIza-test');
  });

  /**
   * Both voice vendors now serve both capabilities, so the credential is
   * required by the VENDOR named, on whichever side names it. Without the
   * pairing, TTS_PROVIDER=deepgram with only an ElevenLabs key boots clean and
   * answers every child in the mock voice.
   */
  it('requires the vendor credential on whichever voice capability names it', () => {
    expect(() => parseConfig({ STT_PROVIDER: 'deepgram' })).toThrow(/DEEPGRAM_API_KEY/);
    expect(() => parseConfig({ TTS_PROVIDER: 'deepgram' })).toThrow(/DEEPGRAM_API_KEY/);
    expect(() => parseConfig({ TTS_PROVIDER: 'elevenlabs' })).toThrow(/ELEVENLABS_API_KEY/);
    expect(() => parseConfig({ STT_PROVIDER: 'elevenlabs' })).toThrow(/ELEVENLABS_API_KEY/);
  });

  it('accepts one vendor serving both halves of the voice loop', () => {
    const deepgram = parseConfig({
      STT_PROVIDER: 'deepgram',
      TTS_PROVIDER: 'deepgram',
      DEEPGRAM_API_KEY: 'dg-test',
    });
    expect(deepgram.STT_PROVIDER).toBe('deepgram');
    expect(deepgram.TTS_PROVIDER).toBe('deepgram');

    const elevenlabs = parseConfig({
      STT_PROVIDER: 'elevenlabs',
      TTS_PROVIDER: 'elevenlabs',
      ELEVENLABS_API_KEY: 'xi-test',
    });
    expect(elevenlabs.STT_PROVIDER).toBe('elevenlabs');
    expect(elevenlabs.TTS_PROVIDER).toBe('elevenlabs');
  });

  it('requires a webhook secret when the Stripe rail is selected', () => {
    // An unverified webhook endpoint is a free-subscription vulnerability, so
    // the credential that verifies signatures is required to boot, not checked
    // on the first webhook.
    expect(() => parseConfig({ PAYMENTS_PROVIDER: 'stripe' })).toThrow(/STRIPE_WEBHOOK_SECRET/);
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════
   * THE MOCK RAIL CANNOT REACH A DEPLOYED ENVIRONMENT.
   * ═══════════════════════════════════════════════════════════════════════
   *
   * Its signing key is a documented default in `.env.example`. In production
   * that is not a mock — it is a webhook endpoint anyone who has read the repo
   * can post a valid `subscription.activated` to.
   */
  it('refuses the mock payment rail outside local and ci', () => {
    expect(() => parseConfig({ ...deployedBase, PAYMENTS_PROVIDER: 'mock' })).toThrow(
      /PAYMENTS_PROVIDER/,
    );
  });

  it('accepts a fully specified production environment', () => {
    expect(() => parseConfig({ ...deployedBase })).not.toThrow();
  });

  it('refuses to start production with the input safety classifier disabled', () => {
    expect(() =>
      parseConfig({ ...deployedBase, SAFETY_INPUT_CLASSIFIER_ENABLED: 'false' }),
    ).toThrow(/SAFETY_INPUT_CLASSIFIER_ENABLED/);
  });

  it('refuses to start production with the output safety classifier disabled', () => {
    expect(() =>
      parseConfig({ ...deployedBase, SAFETY_OUTPUT_CLASSIFIER_ENABLED: 'false' }),
    ).toThrow(/SAFETY_OUTPUT_CLASSIFIER_ENABLED/);
  });

  it('refuses to start production without an escalation route for disclosures', () => {
    const { SAFETY_ESCALATION_WEBHOOK_URL: _omitted, ...withoutWebhook } = deployedBase;

    expect(() => parseConfig(withoutWebhook)).toThrow(/SAFETY_ESCALATION_WEBHOOK_URL/);
  });

  it('refuses to start production with nowhere for an alert to go', () => {
    /* Five alert conditions existed, were correct, were tested — and every one
     * of them delivered a log line that nothing was watching. A paging system
     * nobody receives is indistinguishable from a working one right up to the
     * incident, which is why this is a boot refusal rather than a warning. */
    const { ALERT_WEBHOOK_URL: _omitted, ...withoutAlerts } = deployedBase;

    expect(() => parseConfig(withoutAlerts)).toThrow(/ALERT_WEBHOOK_URL/);
  });

  it('does not require an alert destination outside production', () => {
    // Local and CI have no pager and should not pretend to.
    expect(() => parseConfig({})).not.toThrow();
    expect(parseConfig({}).ALERT_WEBHOOK_URL).toBeUndefined();
  });

  it('refuses to start production with error tracking switched off', () => {
    /* `SENTRY_DSN` was declared, validated, documented and read by nothing for
     * months. The lesson is not "wire it up" — it is that a category with a
     * plausible default is exactly the kind that is never noticed to be
     * missing, so production has to say no. */
    expect(() => parseConfig({ ...deployedBase, ERROR_TRACKING_PROVIDER: 'none' })).toThrow(
      /ERROR_TRACKING_PROVIDER/,
    );
  });

  it('refuses a named error tracking provider with no destination', () => {
    // A provider that names no destination is a silent no-op, which is the
    // state error tracking was already in. Refused in every environment.
    expect(() => parseConfig({ ERROR_TRACKING_PROVIDER: 'sentry' })).toThrow(/SENTRY_DSN/);
    expect(() => parseConfig({ ERROR_TRACKING_PROVIDER: 'webhook' })).toThrow(
      /ERROR_TRACKING_WEBHOOK_URL/,
    );
  });

  it('refuses to start production without redis, because limits would be per-instance', () => {
    /* The fix for distributed rate limiting is worth nothing if production can
     * boot without the Redis it depends on: the limiter would fall back to
     * counting in each process, which is precisely the defect it replaced. */
    const { REDIS_URL: _omitted, ...withoutRedis } = deployedBase;

    expect(() => parseConfig(withoutRedis)).toThrow(/REDIS_URL/);
  });

  it('refuses to start production with in-memory audio storage', () => {
    /* The consequence is not "audio is slower to find". The retention sweep
     * could not run at all: the bytes would live in the API's heap, so a sweep
     * from the worker would mark the ledger while the objects survived. */
    expect(() => parseConfig({ ...deployedBase, STORAGE_PROVIDER: 'memory' })).toThrow(
      /STORAGE_PROVIDER/,
    );
  });

  it('refuses an s3 provider with no endpoint or credentials', () => {
    // A provider naming no destination is a silent no-op — refused in every
    // environment, not only production.
    expect(() => parseConfig({ STORAGE_PROVIDER: 's3' })).toThrow(/STORAGE_S3_ENDPOINT/);
    expect(() =>
      parseConfig({ STORAGE_PROVIDER: 's3', STORAGE_S3_ENDPOINT: 'https://s3.example.com' }),
    ).toThrow(/STORAGE_S3_ACCESS_KEY_ID/);
  });

  it('defaults to in-memory storage outside production, which is the right default there', () => {
    expect(parseConfig({}).STORAGE_PROVIDER).toBe('memory');
  });

  it('refuses to retain raw child audio in production without explicit acknowledgement', () => {
    expect(() => parseConfig({ ...deployedBase, RETENTION_RAW_AUDIO_DAYS: '30' })).toThrow(
      /RETENTION_RAW_AUDIO_DAYS/,
    );
  });

  it('allows raw audio retention in production once acknowledged', () => {
    expect(() =>
      parseConfig({
        ...deployedBase,
        RETENTION_RAW_AUDIO_DAYS: '30',
        RETENTION_RAW_AUDIO_OPT_IN_ACK: 'approved-2026-08-17-parent-opt-in-only',
      }),
    ).not.toThrow();
  });

  it('rejects a wildcard CORS origin in a deployed environment', () => {
    expect(() => parseConfig({ ...deployedBase, CORS_ALLOWED_ORIGINS: '*' })).toThrow(
      /CORS_ALLOWED_ORIGINS/,
    );
  });

  it('requires database TLS in a deployed environment', () => {
    expect(() => parseConfig({ ...deployedBase, DATABASE_SSL_MODE: 'disable' })).toThrow(
      /DATABASE_SSL_MODE/,
    );
  });

  it('rejects trace-level logging in production', () => {
    expect(() => parseConfig({ ...deployedBase, LOG_LEVEL: 'trace' })).toThrow(/LOG_LEVEL/);
  });

  it('rejects the local Redis key prefix in production', () => {
    expect(() => parseConfig({ ...deployedBase, REDIS_KEY_PREFIX: 'kc:local:' })).toThrow(
      /REDIS_KEY_PREFIX/,
    );
  });

  it('does not apply deployed-environment rules to local', () => {
    // Local development must stay frictionless: no TLS, no wildcarding rules.
    expect(() => parseConfig({ APP_ENV: 'local', DATABASE_SSL_MODE: 'disable' })).not.toThrow();
  });
});
