import { randomBytes } from 'node:crypto';

import multipart from '@fastify/multipart';
import swagger from '@fastify/swagger';
import {
  createAnthropicProvider,
  createConversationEngine,
  createGoogleProvider,
  createMockProvider,
  createOpenAIProvider,
  createProviderRegistry,
  GOOGLE_FREE_TIER_MODELS,
  type AIProvider,
  type ProviderRegistry,
} from '@kids/ai';
import { createMetricsRegistry, type MetricsRegistry } from '@kids/analytics';
import {
  createLocalAuthAdapter,
  createSessionService,
  createSupabaseAuthAdapter,
  createTokenService,
  type AuthProvider,
} from '@kids/auth';
import type { Config } from '@kids/config';
import type { Database } from '@kids/db';
import {
  createMockSubscriptionProvider,
  createAppleStoreProvider,
  createGooglePlayProvider,
  createMockStoreProvider,
  createRailRegistry,
  createRevenueCatProvider,
  describeRegistry,
  type CardConfig,
  type CarrierBillingConfig,
  type EasypaisaConfig,
  type JazzCashConfig,
  type MobileStore,
  type RailRegistry,
  type StoreBillingProvider,
  type SubscriptionProvider,
} from '@kids/payments';
import {
  createMockAnalysisProvider,
  createTranscriptionAnalysisProvider,
  type SpeechAnalysisProvider,
} from '@kids/practice';
import { createCircuitBreaker, createLogger, systemClock } from '@kids/shared';
import {
  createMemoryAudioStorage,
  createMemoryTtsCache,
  createS3AudioStorage,
  resolveVoiceProviders,
  type AudioStorage,
  type SpeechToTextProvider,
  type TextToSpeechProvider,
} from '@kids/voice';
import Fastify from 'fastify';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';

import {
  createAlertMonitor,
  createAlertWebhookTransport,
  createLogAlertSink,
  createWebhookAlertSink,
} from './alerts.js';
import { createAuditLogger } from './audit.js';
import {
  createErrorTracker,
  createSentryTransport,
  createWebhookTransport,
} from './error-tracking.js';
import { createLearningRecorder } from './learning-events.js';
import { createPaymentStore } from './payment-store.js';
import authPlugin from './plugins/auth.js';
import errorBoundary from './plugins/error-boundary.js';
import metricsPlugin from './plugins/metrics.js';
import requestContext from './plugins/request-context.js';
import security from './plugins/security.js';
import { createRateLimitStore } from './rate-limit-store.js';
import { createRedisClient } from './redis-client.js';
import { authRoutes } from './routes/auth.js';
import { characterRoutes } from './routes/characters.js';
import { childRoutes } from './routes/children.js';
import { consentRoutes } from './routes/consent.js';
import { conversationRoutes } from './routes/conversations.js';
import { healthRoutes } from './routes/health.js';
import { createLearningStore, learningRoutes } from './routes/learning.js';
import { metricsScrapeRoutes, observabilityRoutes } from './routes/observability.js';
import { parentRoutes as parentDashboardRoutes } from './routes/parent.js';
import { parentRoutes as parentAccountRoutes } from './routes/parents.js';
import { paymentRoutes } from './routes/payments.js';
import { practiceRoutes } from './routes/practice.js';
import { storeBillingRoutes } from './routes/store-billing.js';
import { subscriptionRoutes } from './routes/subscriptions.js';
import { sweepExpiredAudio, voiceRoutes } from './routes/voice.js';
import { createEscalationDelivery } from './safety-escalation.js';
import { createAttemptCounter, createPolicyStore } from './safety-store.js';
import { createStoreBilling } from './store-billing.js';
import { createSubscriptionReconciler } from './subscription-reconciler.js';
import { createTranscriptRetention } from './transcript-retention.js';
import { createTurnHealthReporter } from './turn-health.js';

export interface BuildAppOptions {
  readonly config: Config;
  /**
   * Injected so integration tests can drive the real routes against real SQL and
   * real RLS policies in PGlite, with no Docker daemon and no mock standing in
   * for the thing most worth testing.
   */
  readonly db: Database;
  readonly now?: () => Date;
  /**
   * Overrides the provider chosen from configuration.
   *
   * Same reasoning as `db`: integration tests need to drive the real routes
   * through real failure modes — a timeout, an outage, a malformed response —
   * and the only honest way to produce those is a provider that produces them.
   * Never set outside tests; production resolves the provider from config below.
   */
  readonly aiProvider?: AIProvider;
  readonly sttProvider?: SpeechToTextProvider;
  readonly ttsProvider?: TextToSpeechProvider;
  /** Injected so a test can assert audio is actually gone, not merely marked. */
  readonly audioStorage?: AudioStorage;
  readonly analysisProvider?: SpeechAnalysisProvider;
  /**
   * Overrides the payment rail.
   *
   * Set only by tests, which need to sign webhooks with a known secret and to
   * drive a rail that refuses a cancellation. Production resolves this from
   * `PAYMENTS_PROVIDER`, and configuration refuses `mock` outside local and ci.
   */
  readonly subscriptionProvider?: SubscriptionProvider;
  /**
   * Overrides the payment rail registry.
   *
   * Tests need rails that refuse, rails that go quiet, and — importantly — a
   * registry with nothing in it, because "payments are off" is the default
   * state of this product and has to keep working.
   */
  readonly railRegistry?: RailRegistry;
  /**
   * Overrides the mobile store providers.
   *
   * Tests need a store that refuses, a store that changes its mind, and — the
   * default — no store at all, since a product with no app-store billing has to
   * keep working.
   */
  readonly storeProviders?: readonly (readonly [MobileStore, StoreBillingProvider])[];
  /**
   * Overrides the metrics registry.
   *
   * Injected so a test can assert what was recorded — and, more usefully, that
   * nothing identifying ever reaches a label.
   */
  readonly metricsRegistry?: MetricsRegistry;
}

/**
 * Resolves the JWT signing secret.
 *
 * Production must supply one — the config schema requires it. Local and CI fall
 * back to an ephemeral per-process secret so a fresh clone runs with an unedited
 * `.env`; sessions then do not survive a restart, which is stated loudly rather
 * than discovered. A hardcoded development default would eventually ship.
 */
const resolveJwtSecret = (config: Config, warn: (msg: string) => void): string => {
  if (config.AUTH_JWT_SECRET !== undefined) return config.AUTH_JWT_SECRET;

  if (config.APP_ENV === 'local' || config.APP_ENV === 'ci') {
    warn('AUTH_JWT_SECRET is unset — using an ephemeral secret. Sessions end at restart.');
    return randomBytes(48).toString('base64');
  }

  throw new Error(`AUTH_JWT_SECRET is required when APP_ENV=${config.APP_ENV}`);
};

export const buildApp = async (options: BuildAppOptions) => {
  const { config, db } = options;
  // The composition root is where the default Clock is chosen; everything
  // downstream receives it by injection, which is what the lint rule protects.
  // eslint-disable-next-line no-restricted-syntax
  const now = options.now ?? (() => new Date());

  const app = Fastify({
    // The redacting logger from @kids/shared, not Fastify's default. Transcript
    // text, child identifiers, and credentials must never reach a log line.
    loggerInstance: createLogger({
      level: config.LOG_LEVEL,
      serviceName: config.SERVICE_NAME,
      serviceVersion: config.SERVICE_VERSION,
      appEnv: config.APP_ENV,
      pretty: config.APP_ENV === 'local',
    }),
    genReqId: () => '',
    bodyLimit: config.API_BODY_LIMIT_BYTES,
    requestTimeout: config.API_REQUEST_TIMEOUT_MS,
    trustProxy: config.API_TRUST_PROXY,
    routerOptions: { ignoreTrailingSlash: false },
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  const tokens = createTokenService({
    secret: resolveJwtSecret(config, (msg) => {
      app.log.warn(msg);
    }),
    issuer: config.AUTH_JWT_ISSUER ?? config.API_PUBLIC_URL,
    audience: config.AUTH_JWT_AUDIENCE ?? 'kids-companion-app',
    accessTokenTtlSeconds: config.AUTH_ACCESS_TOKEN_TTL,
    refreshTokenTtlSeconds: config.AUTH_REFRESH_TOKEN_TTL,
  });

  const sessions = createSessionService({
    db,
    tokens,
    accessTokenTtlSeconds: config.AUTH_ACCESS_TOKEN_TTL,
    now,
  });

  // Emailed tokens are returned in the API response ONLY outside deployed
  // environments. Doing so in production would be a complete authentication
  // bypass — anyone could request a reset for any address and read the token.
  const exposeTokens = config.APP_ENV === 'local' || config.APP_ENV === 'ci';

  const auth: AuthProvider =
    config.AUTH_PROVIDER === 'supabase'
      ? createSupabaseAuthAdapter({
          db,
          supabaseUrl: config.SUPABASE_URL ?? '',
          serviceRoleKey: config.SUPABASE_SERVICE_ROLE_KEY ?? '',
          anonKey: config.SUPABASE_ANON_KEY ?? '',
          redirectUrl: `${config.API_PUBLIC_URL}/auth/callback`,
        })
      : createLocalAuthAdapter({
          db,
          tokens,
          hashParams: {
            memoryKib: config.PASSWORD_HASH_MEMORY_KIB,
            iterations: config.PASSWORD_HASH_ITERATIONS,
            parallelism: config.PASSWORD_HASH_PARALLELISM,
          },
          emailVerificationTtlSeconds: 86_400,
          passwordResetTtlSeconds: 3_600,
          maxFailedLogins: config.PARENT_GATE_MAX_ATTEMPTS,
          lockoutMinutes: config.PARENT_GATE_LOCKOUT_MINUTES,
          exposeTokens,
          now,
        });

  const audit = createAuditLogger(db);

  /**
   * Every vendor this deployment can actually reach — not just the default one.
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * WHY ALL OF THEM ARE BUILT, AND WHY A KEY IS WHAT MAKES ONE AVAILABLE
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * A parent choosing a provider can only be offered what this process can
   * serve, and the honest test of that is whether the credential is present.
   * So an adapter is constructed for each key that exists, `AI_PROVIDER` picks
   * the default among them, and the registry answers everything else.
   *
   * Constructing an adapter costs nothing — no connection is opened and no key
   * is validated until a turn actually uses it — so building the unselected
   * ones is not speculative work, it is the list the settings screen draws.
   *
   * The mock is ALWAYS present and always last. It needs no key, it is the
   * default in local and ci so the whole loop runs with no spend, and it
   * guarantees the registry can never be empty.
   */
  const buildProviders = (): AIProvider[] => {
    const providers: AIProvider[] = [];

    if (config.ANTHROPIC_API_KEY !== undefined) {
      providers.push(
        createAnthropicProvider({
          apiKey: config.ANTHROPIC_API_KEY,
          conversationModel: 'claude-sonnet-5',
          classifierModel: 'claude-haiku-4-5-20251001',
        }),
      );
    }

    if (config.OPENAI_API_KEY !== undefined) {
      providers.push(
        createOpenAIProvider({
          apiKey: config.OPENAI_API_KEY,
          conversationModel: 'gpt-4.1-mini',
          classifierModel: 'gpt-4.1-nano',
        }),
      );
    }

    if (config.GOOGLE_AI_API_KEY !== undefined) {
      providers.push(
        createGoogleProvider({
          apiKey: config.GOOGLE_AI_API_KEY,
          // Free-tier models by default: this provider exists so the loop can be
          // exercised against a real vendor without a bill.
          conversationModel: GOOGLE_FREE_TIER_MODELS.conversation,
          classifierModel: GOOGLE_FREE_TIER_MODELS.classifier,
        }),
      );
    }

    providers.push(createMockProvider());
    return providers;
  };

  /**
   * An injected provider replaces the whole set, not just the default.
   *
   * `options.aiProvider` is how the test suite runs the API with a fake. A test
   * that injects one and then finds a real vendor selected by a stored
   * preference would be reaching the network from a unit test, which is the
   * exact thing the injection point exists to prevent.
   */
  const providerRegistry: ProviderRegistry = createProviderRegistry(
    options.aiProvider
      ? { providers: [options.aiProvider], defaultName: options.aiProvider.name }
      : { providers: buildProviders(), defaultName: config.AI_PROVIDER },
  );

  const aiProvider: AIProvider = providerRegistry.fallback;

  // Safety policy is DATA, not code (infra/migrations/…_safety_subsystem.sql).
  // Primed at boot and refreshed in the background, so tightening a threshold
  // after a real-world miss is an UPDATE rather than a release.
  const policies = createPolicyStore({
    db,
    onError: (error) => {
      app.log.error(
        { err: error },
        'safety policy load failed — running on the compiled-in fallback',
      );
    },
  });
  await policies.prime();
  if (policies.isFallback()) {
    app.log.warn('safety policy table unavailable — using the compiled-in fallback policy');
  }

  const engine = createConversationEngine({
    provider: aiProvider,
    safetyPolicy: policies.current,
    attempts: createAttemptCounter(db),
    limits: {
      maxExchanges: config.AI_CONTEXT_MAX_EXCHANGES,
      maxHistoryTokens: config.AI_CONTEXT_MAX_HISTORY_TOKENS,
      maxOutputTokens: config.AI_MAX_OUTPUT_TOKENS,
    },
    retry: {
      maxAttempts: config.AI_MAX_RETRIES + 1,
      // Bounded by the voice-loop latency budget: a retry that would exceed the
      // remaining budget is not attempted (ARCHITECTURE.md §7.1).
      budgetMs: config.AI_REQUEST_TIMEOUT_MS,
      baseDelayMs: 200,
      maxDelayMs: 2000,
    },
    breaker: createCircuitBreaker({ failureThreshold: 5, cooldownMs: 30_000 }, (from, to) => {
      // An open breaker is the earliest signal of a vendor incident.
      app.log.warn({ from, to, provider: aiProvider.name }, 'ai circuit breaker changed state');
    }),
    moderationTimeoutMs: config.AI_MODERATION_TIMEOUT_MS,
    generationTimeoutMs: config.AI_REQUEST_TIMEOUT_MS,
    temperature: config.AI_TEMPERATURE,
  });

  /* ---------------- Voice ----------------
   * The providers are ports (docs/adr/0004). The mocks are the default in local
   * and ci, so the whole voice loop — including safety — runs on a fresh clone
   * with no API keys and no spend.
   */
  const voice = resolveVoiceProviders({
    sttProvider: config.STT_PROVIDER,
    ttsProvider: config.TTS_PROVIDER,
    deepgramApiKey: config.DEEPGRAM_API_KEY,
    elevenLabsApiKey: config.ELEVENLABS_API_KEY,
    sttModel: config.STT_MODEL,
    ttsModel: config.TTS_MODEL,
    ttsCache: createMemoryTtsCache(),
  });

  /**
   * A vendor was asked for and the mock was served.
   *
   * Logged at boot rather than swallowed, because this is the failure that used
   * to be invisible: the credential check and the vendor check were one
   * expression, so a missing key degraded silently to canned audio. Config
   * validation now catches the common case at parse time; this catches the rest
   * — an unimplemented vendor name, or a key that arrives empty rather than
   * absent — and is the difference between finding it in a startup log and
   * finding it in a support ticket.
   */
  if (voice.fellBackToMock.length > 0) {
    app.log.warn(
      {
        capabilities: voice.fellBackToMock,
        sttProvider: config.STT_PROVIDER,
        ttsProvider: config.TTS_PROVIDER,
      },
      'voice provider unavailable — falling back to the mock, so replies will not be real audio',
    );
  }

  const stt: SpeechToTextProvider = options.sttProvider ?? voice.stt;
  const tts: TextToSpeechProvider = options.ttsProvider ?? voice.tts;

  const clock = options.now
    ? { now: () => options.now!().getTime(), nowIso: () => options.now!().toISOString() as never }
    : systemClock;

  /* Audio storage.
   *
   * ═══════════════════════════════════════════════════════════════════════
   * WHICH ONE IS RUNNING DECIDES WHETHER RETENTION CAN BE SWEPT AT ALL.
   * ═══════════════════════════════════════════════════════════════════════
   *
   * The in-memory store is a real implementation — it enforces expiry on read
   * and bounds its own size — but the bytes live in THIS process. A sweep from
   * the worker would mark the retention ledger while the objects stayed alive
   * in the API's heap, and a record asserting a deletion that did not happen is
   * worse than no sweep, because it is the record somebody would rely on.
   *
   * A shared store removes that gap: the DELETE is the deletion. Production
   * refuses `memory` for exactly this reason. */
  const audioStorage =
    options.audioStorage ??
    (config.STORAGE_PROVIDER === 's3' &&
    config.STORAGE_S3_ENDPOINT !== undefined &&
    config.STORAGE_S3_ACCESS_KEY_ID !== undefined &&
    config.STORAGE_S3_SECRET_ACCESS_KEY !== undefined
      ? createS3AudioStorage({
          clock,
          endpoint: config.STORAGE_S3_ENDPOINT,
          region: config.STORAGE_S3_REGION,
          bucket: config.STORAGE_BUCKET_AUDIO,
          credentials: {
            accessKeyId: config.STORAGE_S3_ACCESS_KEY_ID,
            secretAccessKey: config.STORAGE_S3_SECRET_ACCESS_KEY,
            sessionToken: config.STORAGE_S3_SESSION_TOKEN,
          },
          forcePathStyle: config.STORAGE_S3_FORCE_PATH_STYLE,
          timeoutMs: config.STORAGE_S3_TIMEOUT_MS,
        })
      : createMemoryAudioStorage({ clock }));

  // Pronunciation analysis. The transcription-backed provider is the honest
  // default for a real deployment: it reports `utterance` granularity, which
  // is exactly what a transcript can support. A phoneme-capable vendor plugs
  // in here without touching the scorer (docs/adr/0004, Q-06).
  const speechAnalysis: SpeechAnalysisProvider =
    options.analysisProvider ??
    (config.SPEECH_ANALYSIS_PROVIDER === 'transcription'
      ? createTranscriptionAnalysisProvider(stt)
      : createMockAnalysisProvider());

  await app.register(requestContext);

  /* Metrics before the error boundary, so a request that fails inside another
   * plugin is still counted — an error rate that silently excludes the errors
   * it cannot see is worse than no error rate. */
  const metricsRegistry = options.metricsRegistry ?? createMetricsRegistry();
  await app.register(metricsPlugin, {
    registry: metricsRegistry,
    nowMs: () => clock.now(),
  });

  /* Alerts.
   *
   * ═══════════════════════════════════════════════════════════════════════
   * THE LOG LINE IS THE FLOOR, NOT THE DESTINATION.
   * ═══════════════════════════════════════════════════════════════════════
   *
   * A `fatal` log line is the reliable path — every deployment already ships
   * logs somewhere, and an alerting path with a network dependency fails
   * exactly when the network does. It is kept underneath the webhook rather
   * than replaced by it.
   *
   * But on its own it was never an alert. It was a line something else would
   * have to notice, and nothing did. Production now refuses to boot without a
   * destination, for the same reason it refuses to boot without an escalation
   * endpoint. */
  const logSink = createLogAlertSink(app.log);
  const alertSink =
    config.ALERT_WEBHOOK_URL === undefined
      ? logSink
      : createWebhookAlertSink(logSink, {
          post: createAlertWebhookTransport({
            url: config.ALERT_WEBHOOK_URL,
            timeoutMs: config.ALERT_WEBHOOK_TIMEOUT_MS,
          }),
          logger: app.log,
          format: config.ALERT_WEBHOOK_FORMAT,
        });

  if (config.ALERT_WEBHOOK_URL === undefined) {
    // Logged on every boot rather than left as a silent default, so "alerts go
    // nowhere" is a visible property of the environment.
    app.log.warn(
      { control: 'alert_destination' },
      'no ALERT_WEBHOOK_URL configured: alerts will be log lines only',
    );
  }

  const alertMonitor = createAlertMonitor({
    registry: metricsRegistry,
    sink: alertSink,
    clock,
  });

  /* Error tracking.
   *
   * ═══════════════════════════════════════════════════════════════════════
   * NO SDK, ON PURPOSE.
   * ═══════════════════════════════════════════════════════════════════════
   *
   * `SENTRY_DSN` was declared and read by nothing, so errors reached logs with
   * request ids and nothing aggregated, deduplicated, or correlated them to a
   * release.
   *
   * The reason there is still no Sentry package here is in error-tracking.ts:
   * an error tracker's default integrations capture request bodies, headers and
   * cookies, and the request body on the busiest route in this application is a
   * child speaking. Every field on the event is placed there by hand. */
  const errorTransport =
    config.ERROR_TRACKING_PROVIDER === 'sentry' && config.SENTRY_DSN !== undefined
      ? createSentryTransport({
          dsn: config.SENTRY_DSN,
          release: config.SERVICE_VERSION,
          environment: config.APP_ENV,
          timeoutMs: config.ERROR_TRACKING_TIMEOUT_MS,
        })
      : config.ERROR_TRACKING_PROVIDER === 'webhook' &&
          config.ERROR_TRACKING_WEBHOOK_URL !== undefined
        ? createWebhookTransport({
            url: config.ERROR_TRACKING_WEBHOOK_URL,
            release: config.SERVICE_VERSION,
            environment: config.APP_ENV,
            timeoutMs: config.ERROR_TRACKING_TIMEOUT_MS,
          })
        : undefined;

  if (config.ERROR_TRACKING_PROVIDER === 'sentry' && errorTransport === undefined) {
    // A DSN that does not parse would otherwise fail silently and look
    // configured. Loud, and it does not stop the process: aggregation still
    // works locally and errors still reach the log.
    app.log.error(
      { control: 'error_tracking' },
      'SENTRY_DSN could not be parsed: errors will aggregate locally and be sent nowhere',
    );
  }

  const errorTracker = createErrorTracker({
    clock,
    logger: app.log,
    transport: errorTransport,
    resendAfterMs: config.ERROR_TRACKING_RESEND_AFTER_MS,
  });

  /* ═══════════════════════════════════════════════════════════════════════
   * SOMETHING HAS TO ASK.
   * ═══════════════════════════════════════════════════════════════════════
   *
   * `evaluate()` was called only by the metrics and alerts endpoints, so a
   * deployment with nothing scraping them never evaluated a threshold — the
   * error-rate and latency alerts could not fire at all. It also drives the
   * sweep that clears conditions which have gone quiet.
   */
  /* The producer for three alert conditions that had none. */
  const turnHealth = createTurnHealthReporter(alertMonitor);

  /* Transcript retention.
   *
   * `RETENTION_TRANSCRIPT_DAYS` and the per-child
   * `parental_controls.transcript_retention_days` both existed and neither
   * deleted anything. A retention control a parent can set, that does nothing,
   * is a privacy promise the product does not keep — made to somebody who took
   * it seriously enough to change it. */
  const transcriptRetention = createTranscriptRetention({
    db,
    audit,
    logger: app.log,
    ceilingDays: config.RETENTION_TRANSCRIPT_DAYS,
  });

  const alertTimer = setInterval(() => {
    alertMonitor.evaluate();
  }, config.ALERT_EVALUATION_INTERVAL_MS);
  alertTimer.unref();
  app.addHook('onClose', () => {
    clearInterval(alertTimer);
  });

  await app.register(errorBoundary, { tracker: errorTracker });
  /* Rate limiting, shared across instances.
   *
   * ═══════════════════════════════════════════════════════════════════════
   * WITHOUT THIS, EVERY LIMIT WAS MULTIPLIED BY THE INSTANCE COUNT.
   * ═══════════════════════════════════════════════════════════════════════
   *
   * Including `RATE_LIMIT_AUTH_PER_15_MIN`, which is what makes online
   * password guessing impractical. Redis was already provisioned and already
   * probed by `/ready`; the limiter simply never touched it.
   *
   * Absent Redis, the limiter counts in this process — which is what it did
   * before. The fallback is inside the store rather than here, so an outage
   * mid-flight degrades the same way a missing URL does. */
  const redis =
    config.REDIS_URL === undefined
      ? undefined
      : createRedisClient({
          url: config.REDIS_URL,
          tlsEnabled: config.REDIS_TLS_ENABLED,
          logger: app.log,
        });

  if (redis === undefined) {
    app.log.warn(
      { control: 'rate_limit_store' },
      'no REDIS_URL configured: rate limits are per-instance, so N instances enforce N x the limit',
    );
  }

  app.addHook('onClose', () => {
    redis?.close();
  });

  await app.register(security, {
    config,
    ...(redis
      ? {
          rateLimitStore: createRateLimitStore({
            redis,
            keyPrefix: config.REDIS_KEY_PREFIX,
            logger: app.log,
          }),
        }
      : {}),
  });
  await app.register(authPlugin, { db, tokens, sessions });

  // Multipart is registered ONLY for the voice upload. The byte ceiling is
  // enforced as the body streams, so an oversized upload is cut off at the
  // socket rather than buffered and then measured — measuring after buffering
  // lets an attacker choose how much memory we spend.
  await app.register(multipart, {
    limits: {
      fileSize: config.VOICE_MAX_UPLOAD_BYTES,
      files: 1,
      fields: 4,
      fieldSize: 1_024,
      parts: 6,
    },
  });

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'kids-companion API',
        description:
          'Voice-first AI companion for children. Generated from route schemas — never hand-written.',
        version: config.SERVICE_VERSION,
      },
      servers: [{ url: config.API_PUBLIC_URL }],
    },
    transform: jsonSchemaTransform,
  });

  await app.register(healthRoutes(config, { db, alerts: alertMonitor }));
  await app.register(
    authRoutes({
      auth,
      sessions,
      audit,
      exposeTokens,
      authRateLimitPerWindow: config.RATE_LIMIT_AUTH_PER_15_MIN,
    }),
  );
  await app.register(
    parentAccountRoutes({ auth, db, sessions, audit, providers: providerRegistry }),
  );
  await app.register(childRoutes({ audit }));
  await app.register(consentRoutes({ audit }));
  await app.register(characterRoutes());
  // Mounted under /api, matching the product specification. Everything else in
  // this service is under /v1, so this prefix carries no version — a real
  // inconsistency, recorded in docs/API_CONVENTIONS.md §1.1 rather than quietly
  // resolved in one direction here.
  /**
   * Routing for safety escalations.
   *
   * Built here so it can reach the alert monitor: an escalation that cannot be
   * delivered is a failure of the safety pipeline, and `reportSafetyFailure`
   * is the one alert condition that fires on the FIRST occurrence rather than
   * on a rate. See docs/CHILD_SAFETY.md §6.1 item 5.
   */
  const escalations = createEscalationDelivery({
    db,
    clock,
    logger: app.log,
    webhookUrl: config.SAFETY_ESCALATION_WEBHOOK_URL,
    onDeliveryFailure: (detail) => {
      alertMonitor.reportSafetyFailure(detail);
    },
  });

  /**
   * Records what a child did, so the progress dashboard has something to show.
   *
   * The rollup pipeline was already complete and had no producer; this is it.
   */
  const learning = createLearningRecorder({
    db,
    store: createLearningStore(db),
    clock,
    logger: app.log,
  });

  await app.register(
    conversationRoutes({
      engine,
      providers: providerRegistry,
      db,
      audit,
      maxExchanges: config.AI_CONTEXT_MAX_EXCHANGES,
      dailyTurnLimit: config.AI_PER_CHILD_DAILY_TURN_LIMIT,
      encryptionKeyId: 'placeholder',
      messageRateLimitPerMinute: config.RATE_LIMIT_CONVERSATION_PER_MINUTE,
      startRateLimitPerHour: config.RATE_LIMIT_CONVERSATION_START_PER_HOUR,
      clock,
      escalations,
      learning,
      health: turnHealth,
    }),
    { prefix: '/api' },
  );

  await app.register(
    voiceRoutes({
      engine,
      providers: providerRegistry,
      db,
      audit,
      stt,
      tts,
      storage: audioStorage,
      clock,
      retention: {
        rawAudioDays: config.RETENTION_RAW_AUDIO_DAYS,
        transientSeconds: config.VOICE_TRANSIENT_AUDIO_SECONDS,
      },
      limits: {
        maxBytes: config.VOICE_MAX_UPLOAD_BYTES,
        maxDurationMs: config.VOICE_MAX_DURATION_MS,
        minDurationMs: config.VOICE_MIN_DURATION_MS,
        allowUnknownDuration: config.VOICE_ALLOW_UNKNOWN_DURATION,
      },
      sttTimeoutMs: config.STT_TIMEOUT_MS,
      ttsTimeoutMs: config.TTS_TIMEOUT_MS,
      maxRetries: config.AI_MAX_RETRIES,
      requestTimeoutMs: config.AI_REQUEST_TIMEOUT_MS,
      encryptionKeyId: 'placeholder',
      maxExchanges: config.AI_CONTEXT_MAX_EXCHANGES,
      rateLimitPerMinute: config.RATE_LIMIT_VOICE_PER_MINUTE,
      health: turnHealth,
    }),
    { prefix: '/api' },
  );

  await app.register(
    practiceRoutes({
      db,
      audit,
      learning,
      analysis: speechAnalysis,
      storage: audioStorage,
      clock,
      retention: {
        rawAudioDays: config.RETENTION_RAW_AUDIO_DAYS,
        transientSeconds: config.VOICE_TRANSIENT_AUDIO_SECONDS,
      },
      limits: {
        maxBytes: config.VOICE_MAX_UPLOAD_BYTES,
        maxDurationMs: config.VOICE_MAX_DURATION_MS,
        minDurationMs: config.VOICE_MIN_DURATION_MS,
        allowUnknownDuration: config.VOICE_ALLOW_UNKNOWN_DURATION,
      },
      analysisTimeoutMs: config.SPEECH_ANALYSIS_TIMEOUT_MS,
      rateLimitPerMinute: config.RATE_LIMIT_PRACTICE_PER_MINUTE,
    }),
    { prefix: '/api' },
  );

  /* Payments.
   *
   * The rail is chosen by configuration, and `mock` is refused outright in any
   * deployed environment — its signing key is a documented default, which would
   * make the webhook endpoint a subscription anyone could grant themselves. */
  const subscriptionProvider =
    options.subscriptionProvider ??
    createMockSubscriptionProvider({
      webhookSecret: config.PAYMENTS_MOCK_WEBHOOK_SECRET,
      toleranceSeconds: config.PAYMENTS_WEBHOOK_TOLERANCE_SECONDS,
      now: () => new Date(clock.now()),
    });

  const subscriptionReconciler = createSubscriptionReconciler({ db, audit, clock });

  /* Payment rails.
   *
   * ZERO ENABLED RAILS IS A SUPPORTED STATE, and the default one. Every family
   * is then on the free tier, every child can still talk, and the only visible
   * difference is that checkout says payments are unavailable. Nothing in the
   * conversation path, the safety pipeline, or the dashboard touches this. */
  const railClock = () => new Date(clock.now());

  const jazzcash: JazzCashConfig | undefined =
    config.JAZZCASH_MERCHANT_ID === undefined
      ? undefined
      : {
          merchantId: config.JAZZCASH_MERCHANT_ID,
          password: config.JAZZCASH_PASSWORD ?? '',
          integritySalt: config.JAZZCASH_INTEGRITY_SALT ?? '',
          mode: config.JAZZCASH_MODE,
          sandboxCallbackSecret: config.PAYMENTS_SANDBOX_CALLBACK_SECRET,
          now: railClock,
        };

  const easypaisa: EasypaisaConfig | undefined =
    config.EASYPAISA_STORE_ID === undefined
      ? undefined
      : {
          storeId: config.EASYPAISA_STORE_ID,
          hashKey: config.EASYPAISA_HASH_KEY ?? '',
          mode: config.EASYPAISA_MODE,
          sandboxCallbackSecret: config.PAYMENTS_SANDBOX_CALLBACK_SECRET,
          now: railClock,
        };

  const carrierBilling: CarrierBillingConfig | undefined =
    config.CARRIER_BILLING_MERCHANT_ID === undefined
      ? undefined
      : {
          aggregator: config.CARRIER_BILLING_AGGREGATOR ?? '',
          merchantId: config.CARRIER_BILLING_MERCHANT_ID,
          apiKey: config.CARRIER_BILLING_API_KEY ?? '',
          callbackSecret: config.CARRIER_BILLING_CALLBACK_SECRET ?? '',
          mode: config.CARRIER_BILLING_MODE,
          sandboxCallbackSecret: config.PAYMENTS_SANDBOX_CALLBACK_SECRET,
          now: railClock,
        };

  const card: CardConfig | undefined =
    config.CARD_PROCESSOR === undefined
      ? undefined
      : {
          processor: config.CARD_PROCESSOR,
          secretKey: config.CARD_SECRET_KEY ?? '',
          webhookSecret: config.CARD_WEBHOOK_SECRET ?? '',
          mode: config.CARD_MODE,
          sandboxCallbackSecret: config.PAYMENTS_SANDBOX_CALLBACK_SECRET,
          now: railClock,
        };

  const railRegistry =
    options.railRegistry ??
    createRailRegistry({
      enabled: config.PAYMENTS_ENABLED_RAILS as never,
      ...(jazzcash ? { jazzcash } : {}),
      ...(easypaisa ? { easypaisa } : {}),
      ...(carrierBilling ? { carrierBilling } : {}),
      ...(card ? { card } : {}),
    });

  // Logged once at boot. "Which rails are live, and is any of them unverified?"
  // is the question nobody asks until an incident.
  if (railRegistry.anyAvailable()) {
    app.log.info({ rails: describeRegistry(railRegistry) }, 'payment rails enabled');
  } else {
    app.log.info('no payment rails enabled — the free tier is the only plan');
  }

  const paymentStore = createPaymentStore({
    db,
    registry: railRegistry,
    audit,
    clock,
    reconcileAfterMinutes: config.PAYMENTS_RECONCILE_AFTER_MINUTES,
  });

  await app.register(
    paymentRoutes({
      registry: railRegistry,
      payments: paymentStore,
      audit,
      webhookRateLimitPerMinute: config.RATE_LIMIT_WEBHOOK_PER_MINUTE,
    }),
    { prefix: '/api' },
  );

  /* Mobile store billing.
   *
   * The mock provider is a REAL verification service that can say no — a stub
   * that confirmed everything would make the tests pass while proving the
   * opposite of what they claim. Configuration refuses it in any deployed
   * environment, because there it would grant subscriptions nobody paid for. */
  const storeProviders = new Map<MobileStore, StoreBillingProvider>(options.storeProviders ?? []);

  if (options.storeProviders === undefined) {
    for (const store of config.STORE_BILLING_ENABLED_STORES) {
      if (store !== 'apple_iap' && store !== 'google_play') continue;

      if (config.STORE_BILLING_PROVIDER === 'mock') {
        storeProviders.set(
          store,
          createMockStoreProvider({
            store,
            notificationSecret: config.STORE_BILLING_MOCK_SECRET,
            environment: config.STORE_BILLING_ENVIRONMENT,
            productId: `${store}.monthly`,
            now: () => new Date(clock.now()),
          }),
        );
        continue;
      }

      /* RevenueCat, preferred over the raw Apple/Google adapters below.
       *
       * One account covers both stores, so one config branch does too — see
       * docs/REVENUECAT.md. The direct Apple/Google adapters remain as the
       * escape hatch for whoever eventually verifies them against each
       * store's own API directly (see services/payments/src/stores/adapters.ts). */
      if (config.REVENUECAT_SECRET_API_KEY !== undefined) {
        storeProviders.set(
          store,
          createRevenueCatProvider({
            store,
            secretApiKey: config.REVENUECAT_SECRET_API_KEY,
            webhookSigningSecret: config.REVENUECAT_WEBHOOK_SIGNING_SECRET ?? '',
            entitlementId: config.REVENUECAT_ENTITLEMENT_ID,
            environment: config.STORE_BILLING_ENVIRONMENT,
            clock,
          }),
        );
        continue;
      }

      if (store === 'apple_iap' && config.APPLE_IAP_ISSUER_ID !== undefined) {
        storeProviders.set(
          store,
          createAppleStoreProvider({
            issuerId: config.APPLE_IAP_ISSUER_ID,
            keyId: config.APPLE_IAP_KEY_ID ?? '',
            privateKey: config.APPLE_IAP_PRIVATE_KEY ?? '',
            bundleId: config.APPLE_IAP_BUNDLE_ID ?? '',
            ...(config.APPLE_IAP_SHARED_SECRET === undefined
              ? {}
              : { sharedSecret: config.APPLE_IAP_SHARED_SECRET }),
            environment: config.STORE_BILLING_ENVIRONMENT,
          }),
        );
      }

      if (store === 'google_play' && config.GOOGLE_PLAY_PACKAGE_NAME !== undefined) {
        storeProviders.set(
          store,
          createGooglePlayProvider({
            packageName: config.GOOGLE_PLAY_PACKAGE_NAME,
            serviceAccountJson: config.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON ?? '',
            ...(config.GOOGLE_PLAY_NOTIFICATION_TOPIC === undefined
              ? {}
              : { notificationTopic: config.GOOGLE_PLAY_NOTIFICATION_TOPIC }),
            environment: config.STORE_BILLING_ENVIRONMENT,
          }),
        );
      }
    }
  }

  const storeBilling = createStoreBilling({ db, providers: storeProviders, audit, clock });

  await app.register(
    storeBillingRoutes({ billing: storeBilling, providers: storeProviders, audit }),
    { prefix: '/api' },
  );

  await app.register(
    subscriptionRoutes({
      webhookRateLimitPerMinute: config.RATE_LIMIT_WEBHOOK_PER_MINUTE,
      db,
      provider: subscriptionProvider,
      reconciler: subscriptionReconciler,
      audit,
      clock,
      checkoutRateLimitPerHour: config.RATE_LIMIT_CHECKOUT_PER_HOUR,
    }),
    { prefix: '/api' },
  );

  /* `/metrics` sits outside `/api`: it is scraped by infrastructure and is not
   * part of the product's API surface. The staff endpoints are a SEPARATE
   * plugin under `/api`, registered once — see docs/SECURITY_AUDIT.md for why
   * that separation is structural rather than a flag. */
  await app.register(
    metricsScrapeRoutes({
      registry: metricsRegistry,
      alerts: alertMonitor,
      metricsEnabled: config.METRICS_ENABLED,
    }),
  );

  await app.register(
    observabilityRoutes({
      db,
      registry: metricsRegistry,
      alerts: alertMonitor,
      errors: errorTracker,
      clock,
    }),
    { prefix: '/api' },
  );

  await app.register(learningRoutes({ db }), { prefix: '/api' });
  await app.register(
    parentDashboardRoutes({
      db,
      audit,
      clock,
      transcriptRetentionCeilingDays: config.RETENTION_TRANSCRIPT_DAYS,
    }),
    { prefix: '/api' },
  );

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE SCHEDULED SWEEPS, EXPOSED FOR THE WORKER PROCESS.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * These are backstops, not the primary path. Entitlement is computed from
   * timestamps whenever it is read, so a subscription is expired the moment its
   * window closes whether or not `sweepExpired` has run. What the sweeps buy is
   * stored state that matches reality, and recovery from the two failures that
   * leave it behind: a crash mid-write, and a vendor callback that never came.
   *
   * They are attached here rather than rebuilt in `worker.ts` so there is
   * exactly ONE place that decides which rails are enabled, which store
   * providers are configured, and how they are constructed. A second wiring
   * path would drift from this one, and the first symptom would be a sweep
   * quietly reconciling against a rail the API does not use.
   *
   * `apps/api/src/worker.ts` builds the app solely to obtain these, and never
   * calls `listen` — no route registered above is reachable in that process.
   */
  app.decorate('maintenance', {
    /** Moves elapsed subscriptions to `expired`. Returns rows changed. */
    sweepExpiredSubscriptions: async (): Promise<number> =>
      await subscriptionReconciler.sweepExpired(),

    /**
     * Retries escalations no human has been told about yet.
     *
     * Listed FIRST because it is the only sweep whose backlog is a child
     * waiting rather than a number being stale.
     */
    retryEscalationDelivery: async () => await escalations.retryPending(),

    /**
     * Rebuilds progress rollups for days whose events are newer than them.
     *
     * The dashboard reads the rollups, so a conversation nobody ended shows a
     * parent zeros until this runs.
     */
    rebuildLearningRollups: async () => await learning.rebuildStale(),

    /**
     * Deletes transcripts past their retention.
     *
     * Unlike the audio sweep below, this one CAN run from another process:
     * the content is in the database, not in a heap somewhere, so there is no
     * risk of a ledger claiming a deletion that did not happen.
     */
    expireTranscripts: async () => await transcriptRetention.run(),

    /** Asks each rail about payments we never heard the outcome of. */
    reconcilePayments: async () => await paymentStore.reconcile(),

    /** Re-verifies store purchases whose state may have moved without a notification. */
    synchroniseStorePurchases: async () => await storeBilling.synchronise(),

    /**
     * Whether audio retention can be swept from ANOTHER process.
     *
     * The only `AudioStorage` implementation is in-memory, so the bytes live in
     * whichever process wrote them. A sweep run elsewhere would mark the ledger
     * rows deleted while the objects survived in the API's heap — a retention
     * record asserting a deletion that did not happen, which is worse than not
     * sweeping at all. See DEPLOYMENT.md.
     */
    /**
     * Whether audio retention can be swept from ANOTHER process.
     *
     * True exactly when the object store is shared. With the in-memory store
     * the bytes are in the API's heap and a sweep elsewhere would mark the
     * ledger while the objects survived — so the worker refuses to schedule it
     * and says so on every boot.
     */
    audioSweepIsShared: audioStorage.name !== 'memory',

    /** Deletes audio past its expiry, and the ledger rows that describe it. */
    sweepExpiredAudio: async () => await sweepExpiredAudio(db, audioStorage),
  });

  return app;
};

declare module 'fastify' {
  interface FastifyInstance {
    readonly maintenance: {
      retryEscalationDelivery(): Promise<{ attempted: number; delivered: number }>;
      rebuildLearningRollups(): Promise<{ days: number }>;
      expireTranscripts(): Promise<{ children: number; messages: number }>;
      sweepExpiredSubscriptions(): Promise<number>;
      reconcilePayments(): Promise<{ checked: number; resolved: number; stillUnresolved: number }>;
      synchroniseStorePurchases(): Promise<{ checked: number; changed: number }>;
      sweepExpiredAudio(): Promise<{ ledger: number; objects: number }>;
      readonly audioSweepIsShared: boolean;
    };
  }
}

/** The concrete application type, for callers that need to name it. */
export type App = Awaited<ReturnType<typeof buildApp>>;
