import { AI_PROVIDER_NAMES } from '@kids/types';
import { z } from 'zod';

import { appEnvSchema, nodeEnvSchema, type AppEnv } from './app-env.js';
import {
  boolFromEnv,
  csvFromEnv,
  durationSecondsFromEnv,
  intFromEnv,
  optionalString,
  secretFromEnv,
  urlFromEnv,
} from './primitives.js';

/**
 * The environment contract.
 *
 * Every variable the API and the services read is declared here, and
 * `process.env` is touched in exactly one place (`load.ts`).
 *
 * The one exception is the Next.js dashboard, which is a separate deployable
 * with its own runtime and reads a single variable of its own (`API_BASE_URL`,
 * in `apps/web/src/lib/api.ts`). Importing this schema there would drag the
 * whole API contract — database, providers, telemetry — into a server bundle
 * that needs none of it. Both variables live in `.env.example`, which stays the
 * single contract.
 *
 * Sections marked "phase-gated" are typed but optional: the contract is fixed now
 * so `.env.example` and this schema cannot drift, while nothing consumes them
 * until the phase that owns them. See docs/ENVIRONMENT.md.
 */

/* -------------------------------------------------------------------------- */
/* Core runtime                                                                */
/* -------------------------------------------------------------------------- */

const coreSchema = z.object({
  NODE_ENV: nodeEnvSchema.default('development'),
  APP_ENV: appEnvSchema.default('local'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  SERVICE_NAME: z.string().min(1).default('kids-companion-api'),
  SERVICE_VERSION: z.string().min(1).default('0.0.0'),
});

/* -------------------------------------------------------------------------- */
/* API server                                                                  */
/* -------------------------------------------------------------------------- */

const apiSchema = z.object({
  API_HOST: z.string().min(1).default('0.0.0.0'),
  API_PORT: intFromEnv({ min: 1, max: 65_535 }).default(8080),
  API_PUBLIC_URL: urlFromEnv.default('http://localhost:8080'),
  API_REQUEST_TIMEOUT_MS: intFromEnv({ min: 1_000 }).default(30_000),
  API_BODY_LIMIT_BYTES: intFromEnv({ min: 1_024 }).default(10_485_760),
  // `true` only behind a known load balancer. Otherwise a client can spoof its
  // source IP via X-Forwarded-For and defeat per-IP rate limiting entirely.
  API_TRUST_PROXY: boolFromEnv.default(false),
  CORS_ALLOWED_ORIGINS: csvFromEnv.default(['http://localhost:3000', 'http://localhost:8081']),
});

/* -------------------------------------------------------------------------- */
/* Rate limiting                                                               */
/* -------------------------------------------------------------------------- */

const rateLimitSchema = z.object({
  RATE_LIMIT_GLOBAL_PER_MINUTE: intFromEnv({ min: 1 }).default(600),
  RATE_LIMIT_AUTH_PER_15_MIN: intFromEnv({ min: 1 }).default(10),
  RATE_LIMIT_CONVERSATION_PER_MINUTE: intFromEnv({ min: 1 }).default(30),
  // Starting sessions is far rarer than sending messages, and a client
  // looping on start is the shape of a bug rather than a chatty child.
  RATE_LIMIT_CONVERSATION_START_PER_HOUR: intFromEnv({ min: 1 }).default(30),
  // Lower than the text limit: every voice turn costs an STT call and a TTS
  // call on top of the model.
  RATE_LIMIT_VOICE_PER_MINUTE: intFromEnv({ min: 1 }).default(15),
  /**
   * The unauthenticated payment-webhook endpoints.
   *
   * Generous on purpose: a rail catching up after an outage delivers in bursts,
   * and rate-limiting a legitimate backlog into failure is worse than the load.
   * Still bounded, because these endpoints take no credential.
   *
   * Configuration rather than a literal because it was the one limit in the
   * product hard-coded into a route, which meant it could not be lowered during
   * an incident without a release.
   */
  RATE_LIMIT_WEBHOOK_PER_MINUTE: intFromEnv({ min: 1 }).default(600),
  RATE_LIMIT_UPLOAD_PER_MINUTE: intFromEnv({ min: 1 }).default(20),
});

/* -------------------------------------------------------------------------- */
/* Safety — phase-gated (Phase 2), but the production rules below bite now      */
/* -------------------------------------------------------------------------- */

const safetySchema = z.object({
  SAFETY_MODE: z.enum(['strict', 'standard']).default('strict'),
  SAFETY_INPUT_CLASSIFIER_ENABLED: boolFromEnv.default(true),
  SAFETY_OUTPUT_CLASSIFIER_ENABLED: boolFromEnv.default(true),
  SAFETY_BLOCKLIST_VERSION: optionalString,
  // The variable exists so the setting is visible and auditable. `open` is not an
  // accepted value in any environment — see docs/CHILD_SAFETY.md rule S-1.
  SAFETY_FAIL_MODE: z.literal('closed').default('closed'),
  SAFETY_ESCALATION_WEBHOOK_URL: urlFromEnv.optional(),
  SAFETY_REVIEW_QUEUE_ENABLED: boolFromEnv.default(true),
});

/* -------------------------------------------------------------------------- */
/* Retention (days)                                                            */
/* -------------------------------------------------------------------------- */

const retentionSchema = z.object({
  // 0 = discard at transcription. See docs/adr/0006.
  RETENTION_RAW_AUDIO_DAYS: intFromEnv({ min: 0 }).default(0),
  RETENTION_TRANSCRIPT_DAYS: intFromEnv({ min: 0, max: 365 }).default(90),
  RETENTION_ANALYTICS_EVENT_DAYS: intFromEnv({ min: 0 }).default(395),
  RETENTION_AUDIT_LOG_DAYS: intFromEnv({ min: 0 }).default(730),
  RETENTION_DELETED_ACCOUNT_GRACE_DAYS: intFromEnv({ min: 0 }).default(30),
  // Required acknowledgement when raw audio retention is switched on in prod.
  RETENTION_RAW_AUDIO_OPT_IN_ACK: optionalString,
});

/* -------------------------------------------------------------------------- */
/* Phase-gated: database, cache, auth, storage, AI, voice, payments, telemetry  */
/* -------------------------------------------------------------------------- */

const dataSchema = z.object({
  SUPABASE_URL: urlFromEnv.optional(),
  SUPABASE_ANON_KEY: optionalString,
  SUPABASE_SERVICE_ROLE_KEY: optionalString,
  DATABASE_URL: optionalString,
  DATABASE_POOL_MAX: intFromEnv({ min: 1 }).default(10),
  DATABASE_STATEMENT_TIMEOUT_MS: intFromEnv({ min: 100 }).default(10_000),
  DATABASE_SSL_MODE: z.enum(['disable', 'require']).default('disable'),
  /**
   * A root certificate for a database whose chain the system does not trust.
   *
   * A PEM file path, or the PEM text itself. Needed by managed providers with
   * a private root — Supabase’s pooler among them. Verification stays on
   * either way; this only adds what it is checked against. See packages/db/src/tls.ts.
   */
  DATABASE_SSL_ROOT_CERT: optionalString,
  REDIS_URL: optionalString,
  REDIS_TLS_ENABLED: boolFromEnv.default(false),
  REDIS_KEY_PREFIX: z.string().min(1).default('kc:local:'),
  QUEUE_CONCURRENCY: intFromEnv({ min: 1 }).default(5),
  QUEUE_MAX_ATTEMPTS: intFromEnv({ min: 1 }).default(3),

  /**
   * Per-dependency deadline for `GET /ready`.
   *
   * Bounded well below any orchestrator's own probe timeout. A readiness check
   * that can outlast the timeout it is answering turns a slow dependency into a
   * restart loop.
   */
  READINESS_PROBE_TIMEOUT_MS: intFromEnv({ min: 100, max: 10_000 }).default(2_000),

  /* --- Background worker ---------------------------------------------------
   * The sweeps are backstops, not the primary path: entitlement is computed
   * from timestamps on read, and audio is deleted inline when a turn ends. They
   * exist to repair what a crash or a dropped vendor callback left behind, so
   * the intervals are minutes, not seconds. */

  /** A liveness port for the worker. It serves `/health` and nothing else. */
  WORKER_PORT: intFromEnv({ min: 1, max: 65_535 }).default(8081),
  WORKER_SUBSCRIPTION_SWEEP_INTERVAL_MS: intFromEnv({ min: 10_000 }).default(300_000),
  WORKER_PAYMENT_RECONCILE_INTERVAL_MS: intFromEnv({ min: 10_000 }).default(300_000),
  WORKER_STORE_SYNC_INTERVAL_MS: intFromEnv({ min: 10_000 }).default(3_600_000),
  /** The retention backstop. Deletes child audio whose retention has elapsed. */
  WORKER_AUDIO_SWEEP_INTERVAL_MS: intFromEnv({ min: 10_000 }).default(900_000),

  /**
   * Retry interval for safety escalations that could not be routed.
   *
   * Much shorter than the other sweeps, and deliberately so: the others repair
   * a stale number, this one repairs a child whose disclosure has not yet
   * reached a human. Floored at 10 s to stop a misconfiguration turning into a
   * hot loop against an endpoint that is already failing.
   */
  WORKER_ESCALATION_RETRY_INTERVAL_MS: intFromEnv({ min: 10_000 }).default(60_000),

  /**
   * How often to rebuild progress rollups for days whose events are newer.
   *
   * The backstop for conversations nobody ends. Five minutes because a parent
   * checking Progress shortly after a session should see it, and rebuilds
   * recompute rather than increment — sweeping a day twice is a wasted query
   * and nothing worse.
   */
  WORKER_LEARNING_ROLLUP_INTERVAL_MS: intFromEnv({ min: 10_000 }).default(300_000),

  /**
   * How often transcripts past their retention are deleted.
   *
   * Hourly. Retention is expressed in days, so a shorter interval buys nothing
   * except load — and a longer one means a parent who sets retention to zero
   * watches their child's words sit there for the rest of the day.
   */
  WORKER_TRANSCRIPT_RETENTION_INTERVAL_MS: intFromEnv({ min: 60_000 }).default(3_600_000),
});

const authSchema = z.object({
  // Which identity provider backs authentication. `supabase` delegates the
  // credential to GoTrue; `local` manages Argon2id hashes in our own tables and
  // is what local and ci use so the auth surface is testable without a project.
  AUTH_PROVIDER: z.enum(['supabase', 'local']).default('local'),
  AUTH_JWT_SECRET: secretFromEnv().optional(),
  AUTH_JWT_ISSUER: optionalString,
  AUTH_JWT_AUDIENCE: optionalString,
  AUTH_ACCESS_TOKEN_TTL: durationSecondsFromEnv('15m'),
  AUTH_REFRESH_TOKEN_TTL: durationSecondsFromEnv('30d'),
  AUTH_REFRESH_TOKEN_ROTATION: boolFromEnv.default(true),
  CHILD_SESSION_TTL: durationSecondsFromEnv('60m'),
  PARENT_GATE_MODE: z.enum(['arithmetic', 'device_biometric', 'pin']).default('arithmetic'),
  PARENT_GATE_MAX_ATTEMPTS: intFromEnv({ min: 1 }).default(5),
  PARENT_GATE_LOCKOUT_MINUTES: intFromEnv({ min: 1 }).default(15),
  PASSWORD_HASH_MEMORY_KIB: intFromEnv({ min: 19_456 }).default(19_456),
  PASSWORD_HASH_ITERATIONS: intFromEnv({ min: 2 }).default(2),
  PASSWORD_HASH_PARALLELISM: intFromEnv({ min: 1 }).default(1),
  ENCRYPTION_ACTIVE_KEY_ID: z.string().min(1).default('k1'),
});

const providerSchema = z.object({
  /**
   * Where audio actually lives.
   *
   * `memory` is a real implementation — it enforces expiry on read, deletes on
   * sweep, and bounds its own size — but the bytes live in ONE process. That
   * means audio does not survive a restart, is not shared between instances,
   * and the retention sweep cannot run from the worker: it would mark the
   * ledger while the bytes stayed alive in the API's heap, and a retention
   * record asserting a deletion that did not happen is worse than no sweep.
   *
   * `s3` is any S3-compatible endpoint — AWS, Cloudflare R2, MinIO, or Supabase
   * Storage through its S3-compatible endpoint. Refused as `memory` in
   * production for the reasons above.
   *
   * The previous `supabase` value was never read by any code. It is gone rather
   * than aliased, because a name that implies a code path which does not exist
   * is how this key came to be declared and unread in the first place.
   */
  STORAGE_PROVIDER: z.enum(['memory', 's3']).default('memory'),
  STORAGE_BUCKET_AUDIO: z.string().min(1).default('child-audio'),
  STORAGE_BUCKET_MEDIA: z.string().min(1).default('public-media'),
  STORAGE_SIGNED_URL_TTL_SECONDS: intFromEnv({ min: 30, max: 3_600 }).default(300),

  /** e.g. https://s3.eu-west-1.amazonaws.com, an R2 endpoint, or MinIO. */
  STORAGE_S3_ENDPOINT: urlFromEnv.optional(),
  STORAGE_S3_REGION: z.string().min(1).default('us-east-1'),
  /** SECRETS. Never logged, never sent to a device, never in an error message. */
  STORAGE_S3_ACCESS_KEY_ID: optionalString,
  STORAGE_S3_SECRET_ACCESS_KEY: optionalString,
  /** For temporary credentials from STS or a workload identity broker. */
  STORAGE_S3_SESSION_TOKEN: optionalString,
  /**
   * Path-style addressing (`endpoint/bucket/key`) rather than virtual-host.
   *
   * Required by MinIO and most self-hosted gateways; AWS accepts both. Default
   * true because the wrong choice fails as a confusing DNS error rather than a
   * clear rejection.
   */
  STORAGE_S3_FORCE_PATH_STYLE: boolFromEnv.default(true),
  STORAGE_S3_TIMEOUT_MS: intFromEnv({ min: 1_000, max: 60_000 }).default(10_000),

  /**
   * The deployment default, and the fallback for a family whose stored
   * preference names a vendor this deployment has no key for.
   *
   * A parent may choose any provider the deployment can actually reach; this
   * is what they get when they have not chosen, or chose something unusable.
   */
  AI_PROVIDER: z.enum(AI_PROVIDER_NAMES).default('mock'),
  AI_MODEL_CONVERSATION: optionalString,
  AI_MODEL_SAFETY_CLASSIFIER: optionalString,
  AI_MAX_OUTPUT_TOKENS: intFromEnv({ min: 1 }).default(512),
  AI_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.7),
  // Roughly the last ten exchanges, per the product specification. Configurable
  // rather than hard-coded: the right number trades conversational memory
  // against cost and latency, and is an empirical question per age group.
  AI_CONTEXT_MAX_EXCHANGES: intFromEnv({ min: 1, max: 50 }).default(10),
  AI_CONTEXT_MAX_HISTORY_TOKENS: intFromEnv({ min: 100 }).default(2000),
  AI_MODERATION_TIMEOUT_MS: intFromEnv({ min: 500 }).default(4000),
  AI_REQUEST_TIMEOUT_MS: intFromEnv({ min: 1_000 }).default(15_000),
  AI_MAX_RETRIES: intFromEnv({ min: 0, max: 5 }).default(2),
  AI_DAILY_COST_CEILING_USD: intFromEnv({ min: 0 }).default(50),
  AI_PER_CHILD_DAILY_TURN_LIMIT: intFromEnv({ min: 1 }).default(300),
  ANTHROPIC_API_KEY: optionalString,
  OPENAI_API_KEY: optionalString,
  /**
   * A Google AI Studio key, which has a genuine free tier.
   *
   * Present so the loop can be exercised against a real vendor without a bill —
   * see GOOGLE_FREE_TIER_MODELS in `@kids/ai`. Setting this key makes `google`
   * selectable by a parent even when it is not the deployment default, which is
   * the point: a free provider is the one worth having available for testing.
   */
  GOOGLE_AI_API_KEY: optionalString,

  /**
   * Both Deepgram and ElevenLabs serve BOTH halves of the voice loop, so either
   * can be named here and in TTS_PROVIDER — including the same one for both,
   * which is the single-vendor setup.
   *
   * Kept as two variables rather than one VOICE_PROVIDER because the two are
   * chosen on different criteria (Urdu child-speech accuracy against voice
   * character and per-character pricing) and ADR-0004 separates them on
   * purpose. `google`, `azure` and `openai` are listed but not implemented;
   * naming one is reported at boot and falls back to the mock.
   */
  STT_PROVIDER: z
    .enum(['deepgram', 'elevenlabs', 'google', 'azure', 'openai', 'mock'])
    .default('mock'),
  /** Overrides the selected STT vendor's default model. */
  STT_MODEL: optionalString,
  // A child’s turn is a few seconds. The ceiling is deliberately generous for
  // 30 s of any accepted codec and small enough that a hostile upload cannot
  // occupy a request worker for long.
  VOICE_MAX_UPLOAD_BYTES: intFromEnv({ min: 1_024 }).default(8 * 1024 * 1024),
  VOICE_MAX_DURATION_MS: intFromEnv({ min: 500 }).default(30_000),
  VOICE_MIN_DURATION_MS: intFromEnv({ min: 0 }).default(250),
  // Browser MediaRecorder emits WebM with no duration until the stream is
  // finalised, which is normal. Set false where the duration limit must be
  // load-bearing rather than advisory.
  VOICE_ALLOW_UNKNOWN_DURATION: boolFromEnv.default(true),
  // Below this the child is asked to repeat rather than answered. Low
  // confidence on child speech is expected (R-01); replying confidently to
  // something they did not say is the failure this prevents.
  VOICE_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.4),
  // How long synthesised reply audio stays fetchable. A timeout, not a
  // retention period — see docs/adr/0006.
  VOICE_TRANSIENT_AUDIO_SECONDS: intFromEnv({ min: 30, max: 3_600 }).default(300),

  // Pronunciation practice. `transcription` derives a score from a transcript
  // and can say nothing about how a sound was articulated; a phoneme-capable
  // vendor is Q-06 and unresolved, so the port exists and the weak provider
  // is what ships (services/practice/src/scoring.ts).
  SPEECH_ANALYSIS_PROVIDER: z.enum(['transcription', 'mock']).default('mock'),
  SPEECH_ANALYSIS_TIMEOUT_MS: intFromEnv({ min: 1_000 }).default(10_000),
  RATE_LIMIT_PRACTICE_PER_MINUTE: intFromEnv({ min: 1 }).default(30),
  // Opening a checkout is cheap for us and expensive for a rail. Bounded per
  // hour rather than per minute: a parent legitimately retries a failed
  // checkout a few times, and never a hundred.
  RATE_LIMIT_CHECKOUT_PER_HOUR: intFromEnv({ min: 1 }).default(20),
  STT_TIMEOUT_MS: intFromEnv({ min: 1_000 }).default(10_000),
  STT_LANGUAGE_HINTS: csvFromEnv.default(['en-US', 'ur-PK']),
  DEEPGRAM_API_KEY: optionalString,

  TTS_PROVIDER: z.enum(['elevenlabs', 'deepgram', 'google', 'azure', 'mock']).default('mock'),
  /** Overrides the selected TTS vendor's default model, which on Aura is the voice. */
  TTS_MODEL: optionalString,
  TTS_TIMEOUT_MS: intFromEnv({ min: 1_000 }).default(10_000),
  TTS_CACHE_TTL_SECONDS: intFromEnv({ min: 0 }).default(604_800),
  ELEVENLABS_API_KEY: optionalString,

  PAYMENTS_ENABLED: boolFromEnv.default(false),
  // Which rail collects money. `mock` implements the real signature scheme
  // against a local secret; it is refused outright in a deployed environment,
  // because a mock rail in production is a free-subscription button.
  PAYMENTS_PROVIDER: z.enum(['stripe', 'mock']).default('mock'),
  PAYMENTS_DEFAULT_CURRENCY: z.string().length(3).default('PKR'),
  // How old a signed webhook timestamp may be. Stripe's own default is five
  // minutes. Without a window, a request captured once is valid forever.
  PAYMENTS_WEBHOOK_TOLERANCE_SECONDS: intFromEnv({ min: 30, max: 3_600 }).default(300),
  // The mock rail's HMAC key. Not a secret in any meaningful sense — it exists
  // so local and CI exercise signature verification rather than skipping it.
  PAYMENTS_MOCK_WEBHOOK_SECRET: z.string().min(16).default('local-mock-webhook-signing-key'),

  /* --- Rails ---
   *
   * EMPTY IS A SUPPORTED STATE. With no rails enabled every family is on the
   * free tier, every child can still talk, and `POST /subscriptions/create`
   * says payments are unavailable instead of failing. A children's app must not
   * be taken down by an unfinished payment integration.
   */
  PAYMENTS_ENABLED_RAILS: csvFromEnv.default([]),

  /*
   * Rails whose wire format has been VERIFIED against the provider's own
   * documentation and sandbox.
   *
   * This is a human attestation, and it is deliberately separate from
   * "enabled". A rail may be switched on in sandbox for development without
   * anyone claiming it is finished; a deployed environment refuses to run a
   * rail that is enabled but not on this list. That is what makes "do not claim
   * production-ready until verified" a boot failure rather than a comment.
   */
  PAYMENTS_VERIFIED_RAILS: csvFromEnv.default([]),

  /* Sandbox callback signing. Local and CI only — a real rail brings its own. */
  PAYMENTS_SANDBOX_CALLBACK_SECRET: z.string().min(16).default('local-sandbox-rail-signing-key'),
  /* How long a payment may sit without a final answer before we ask the rail. */
  PAYMENTS_RECONCILE_AFTER_MINUTES: intFromEnv({ min: 1, max: 1_440 }).default(15),

  STRIPE_SECRET_KEY: optionalString,
  STRIPE_WEBHOOK_SECRET: optionalString,

  /* --- Pakistan rails ---
   *
   * Credentials only. Nothing here says how a request is signed or where it is
   * sent: those come from each provider's documentation and are unverified.
   * Every value is empty in `.env.example` and comes from the environment.
   */
  JAZZCASH_MERCHANT_ID: optionalString,
  JAZZCASH_PASSWORD: optionalString,
  JAZZCASH_INTEGRITY_SALT: optionalString,
  JAZZCASH_MODE: z.enum(['sandbox', 'live']).default('sandbox'),

  EASYPAISA_STORE_ID: optionalString,
  EASYPAISA_HASH_KEY: optionalString,
  EASYPAISA_MODE: z.enum(['sandbox', 'live']).default('sandbox'),

  /* Carrier billing reaches customers through an aggregator. None chosen yet. */
  CARRIER_BILLING_AGGREGATOR: optionalString,
  CARRIER_BILLING_MERCHANT_ID: optionalString,
  CARRIER_BILLING_API_KEY: optionalString,
  CARRIER_BILLING_CALLBACK_SECRET: optionalString,
  CARRIER_BILLING_MODE: z.enum(['sandbox', 'live']).default('sandbox'),

  /* Cards. The processor is configuration; this application never sees a PAN. */
  CARD_PROCESSOR: optionalString,
  CARD_SECRET_KEY: optionalString,
  CARD_WEBHOOK_SECRET: optionalString,
  CARD_MODE: z.enum(['sandbox', 'live']).default('sandbox'),

  /* --- Mobile store billing ---
   *
   * NONE OF THESE IS EVER SHIPPED IN THE MOBILE APPLICATION. The app receives a
   * purchase token from the store SDK and sends it to this server; the server
   * holds the credentials that verify it. A key in an app bundle is a key an
   * attacker has, and both stores' verification APIs are server-to-server for
   * exactly that reason.
   */
  STORE_BILLING_ENABLED_STORES: csvFromEnv.default([]),
  /* Stores whose adapter has been verified against the store's own current
   * documentation and sandbox. Same attestation model as the payment rails: a
   * deployed environment refuses to run an enabled-but-unverified store. */
  STORE_BILLING_VERIFIED_STORES: csvFromEnv.default([]),
  /* `mock` runs a real verification service locally — one that can say no. */
  STORE_BILLING_PROVIDER: z.enum(['live', 'mock']).default('mock'),
  STORE_BILLING_MOCK_SECRET: z.string().min(16).default('local-store-notification-key'),
  /* Which store environment this deployment accepts purchases from. A sandbox
   * purchase honoured in production is a free subscription for anyone with a
   * test account. */
  STORE_BILLING_ENVIRONMENT: z.enum(['sandbox', 'production']).default('sandbox'),
  /* Notifications are unreliable, not absent. This is how stale a purchase may
   * get before we ask the store again regardless. */
  STORE_BILLING_SYNC_AFTER_HOURS: intFromEnv({ min: 1, max: 168 }).default(24),

  APPLE_IAP_ISSUER_ID: optionalString,
  APPLE_IAP_KEY_ID: optionalString,
  APPLE_IAP_PRIVATE_KEY: optionalString,
  APPLE_IAP_BUNDLE_ID: optionalString,
  APPLE_IAP_SHARED_SECRET: optionalString,

  GOOGLE_PLAY_PACKAGE_NAME: optionalString,
  GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: optionalString,
  GOOGLE_PLAY_NOTIFICATION_TOPIC: optionalString,

  /* RevenueCat — preferred over the raw Apple/Google adapters above, because
   * it is one stable, documented API instead of two unstable ones. Neither
   * key is ever shipped in the mobile app; the app only ever holds a
   * RevenueCat PUBLIC SDK key, which is a different value entirely and lives
   * in EXPO_PUBLIC_REVENUECAT_*_API_KEY. See docs/REVENUECAT.md. */
  REVENUECAT_SECRET_API_KEY: optionalString,
  /* Signs `X-RevenueCat-Webhook-Signature`. Set to the SAME value configured
   * as the webhook's signing secret in the RevenueCat dashboard. */
  REVENUECAT_WEBHOOK_SIGNING_SECRET: optionalString,
  /* The RevenueCat entitlement identifier this deployment grants a
   * subscription for. Configured once in the RC dashboard; see
   * docs/REVENUECAT.md §2. */
  REVENUECAT_ENTITLEMENT_ID: z.string().min(1).default('premium'),
});

const quotaSchema = z.object({
  FREE_TIER_DAILY_MINUTES: intFromEnv({ min: 0 }).default(10),
  FREE_TIER_CHILD_PROFILE_LIMIT: intFromEnv({ min: 1 }).default(1),
  FREE_TIER_STORY_LIMIT_PER_WEEK: intFromEnv({ min: 0 }).default(3),
  PAID_TIER_CHILD_PROFILE_LIMIT: intFromEnv({ min: 1 }).default(4),
});

const telemetrySchema = z.object({
  OTEL_EXPORTER_OTLP_ENDPOINT: urlFromEnv.optional(),
  /**
   * Where captured errors go.
   *
   * `none` still aggregates in-process and still exposes the summary on the
   * operator console — it only means nothing leaves the building.
   */
  ERROR_TRACKING_PROVIDER: z.enum(['none', 'sentry', 'webhook']).default('none'),

  /**
   * The Sentry DSN, when `ERROR_TRACKING_PROVIDER=sentry`.
   *
   * NOTE: there is deliberately no Sentry SDK in this repository. An error
   * tracker's default integrations capture request bodies, headers and cookies,
   * and the request body on the busiest route here is a child speaking. The
   * envelope is written by hand so that nothing can attach anything that was
   * not chosen. See apps/api/src/error-tracking.ts.
   */
  SENTRY_DSN: optionalString,

  /** A plain JSON endpoint, when `ERROR_TRACKING_PROVIDER=webhook`. */
  ERROR_TRACKING_WEBHOOK_URL: urlFromEnv.optional(),

  /** Per attempt. Errors are never retried: the log line is the durable record. */
  ERROR_TRACKING_TIMEOUT_MS: intFromEnv({ min: 500, max: 30_000 }).default(5_000),

  /**
   * The shortest gap between two transmissions of the same fingerprint.
   *
   * The first occurrence always goes. After that, a failure repeating a
   * thousand times a minute is still one bug, and forwarding each occurrence
   * turns our incident into the error tracker's incident too.
   */
  ERROR_TRACKING_RESEND_AFTER_MS: intFromEnv({ min: 1_000 }).default(300_000),
  METRICS_ENABLED: boolFromEnv.default(true),
  METRICS_PORT: intFromEnv({ min: 1, max: 65_535 }).default(9_464),
  ANALYTICS_PROVIDER: z.enum(['posthog', 'none']).default('none'),
  ANALYTICS_WRITE_KEY: optionalString,
  ANALYTICS_ENABLED: boolFromEnv.default(false),

  /**
   * Where a firing alert goes, beyond the log line.
   *
   * The log line is the reliable path and is never removed — every deployment
   * already ships logs somewhere, and an alerting path with a network
   * dependency fails exactly when the network does. This is the fast path, and
   * without it "alerting" means a `fatal` line that something else would have
   * to notice.
   *
   * TREAT AS A SECRET. A Slack incoming-webhook URL is a bearer credential in
   * path form: anyone holding it can post into the channel. It is redacted in
   * the config summary and never written to a log.
   */
  ALERT_WEBHOOK_URL: urlFromEnv.optional(),

  /**
   * `generic` posts a JSON object — point an Alertmanager receiver, an Opsgenie
   * custom webhook, or anything in-house at it. `slack` posts the
   * incoming-webhook `text` shape, which Mattermost and others also accept.
   */
  ALERT_WEBHOOK_FORMAT: z.enum(['generic', 'slack']).default('generic'),

  /** Per attempt. Three attempts, briefly spaced, then the log line stands alone. */
  ALERT_WEBHOOK_TIMEOUT_MS: intFromEnv({ min: 500, max: 30_000 }).default(5_000),

  /**
   * How often alert conditions are evaluated.
   *
   * Evaluation used to happen only when something scraped `/metrics` or
   * `/alerts`, which meant a deployment with no scraper never evaluated a
   * threshold at all.
   */
  ALERT_EVALUATION_INTERVAL_MS: intFromEnv({ min: 5_000 }).default(60_000),
});

const featureFlagSchema = z.object({
  FEATURE_MULTILINGUAL_URDU: boolFromEnv.default(false),
  FEATURE_PRONUNCIATION_PRACTICE: boolFromEnv.default(false),
  FEATURE_STORY_MODE: boolFromEnv.default(false),
  FEATURE_ROLEPLAY_MODE: boolFromEnv.default(false),
  FEATURE_PARENT_DASHBOARD: boolFromEnv.default(false),
  FEATURE_OFFLINE_MODE: boolFromEnv.default(false),
});

/* -------------------------------------------------------------------------- */
/* Assembled schema, with cross-field rules                                    */
/* -------------------------------------------------------------------------- */

const baseSchema = coreSchema
  .extend(apiSchema.shape)
  .extend(rateLimitSchema.shape)
  .extend(safetySchema.shape)
  .extend(retentionSchema.shape)
  .extend(dataSchema.shape)
  .extend(authSchema.shape)
  .extend(providerSchema.shape)
  .extend(quotaSchema.shape)
  .extend(telemetrySchema.shape)
  .extend(featureFlagSchema.shape);

export type RawEnv = z.infer<typeof baseSchema>;

/**
 * Cross-field rules.
 *
 * A per-field schema accepts every one of the misconfigurations below, because
 * each individual value is valid in isolation. These are the ones that actually
 * cause incidents — most importantly, a production deploy cannot start with the
 * safety classifiers switched off.
 */
export const envSchema = baseSchema.superRefine((env, ctx) => {
  const issue = (path: keyof RawEnv, message: string) => {
    ctx.addIssue({ code: 'custom', path: [path], message });
  };

  const isProd = env.APP_ENV === 'production';
  const isDeployed: boolean =
    env.APP_ENV === 'production' || env.APP_ENV === 'staging' || env.APP_ENV === 'development';

  /* --- Provider credentials must be present when the provider is selected --- */
  if (env.AI_PROVIDER === 'anthropic' && !env.ANTHROPIC_API_KEY) {
    issue('ANTHROPIC_API_KEY', 'is required when AI_PROVIDER=anthropic');
  }
  if (env.AI_PROVIDER === 'openai' && !env.OPENAI_API_KEY) {
    issue('OPENAI_API_KEY', 'is required when AI_PROVIDER=openai');
  }
  if (env.AI_PROVIDER === 'google' && !env.GOOGLE_AI_API_KEY) {
    issue('GOOGLE_AI_API_KEY', 'is required when AI_PROVIDER=google');
  }
  /* Each vendor now serves either capability, so the credential is required by
   * the VENDOR named, on whichever side names it. Without this pairing, setting
   * TTS_PROVIDER=deepgram with only an ElevenLabs key boots clean and answers
   * every child in the mock voice. */
  if (env.STT_PROVIDER === 'deepgram' && !env.DEEPGRAM_API_KEY) {
    issue('DEEPGRAM_API_KEY', 'is required when STT_PROVIDER=deepgram');
  }
  if (env.TTS_PROVIDER === 'deepgram' && !env.DEEPGRAM_API_KEY) {
    issue('DEEPGRAM_API_KEY', 'is required when TTS_PROVIDER=deepgram');
  }
  if (env.TTS_PROVIDER === 'elevenlabs' && !env.ELEVENLABS_API_KEY) {
    issue('ELEVENLABS_API_KEY', 'is required when TTS_PROVIDER=elevenlabs');
  }
  if (env.STT_PROVIDER === 'elevenlabs' && !env.ELEVENLABS_API_KEY) {
    issue('ELEVENLABS_API_KEY', 'is required when STT_PROVIDER=elevenlabs');
  }
  /* --- Mobile stores ---
   *
   * The same attestation gate as the payment rails, and it matters more here: a
   * store adapter that misbehaves does not merely fail a payment, it fails app
   * review — and app review is not a retry loop.
   */
  {
    const knownStores = new Set(['apple_iap', 'google_play']);

    for (const store of env.STORE_BILLING_ENABLED_STORES) {
      if (!knownStores.has(store)) {
        issue('STORE_BILLING_ENABLED_STORES', `"${store}" is not a mobile store`);
      }
    }

    if (isDeployed) {
      if (env.STORE_BILLING_PROVIDER === 'mock' && env.STORE_BILLING_ENABLED_STORES.length > 0) {
        issue(
          'STORE_BILLING_PROVIDER',
          `must not be "mock" when APP_ENV=${env.APP_ENV} — it grants subscriptions nobody paid for`,
        );
      }

      const verifiedStores = new Set(env.STORE_BILLING_VERIFIED_STORES);
      for (const store of env.STORE_BILLING_ENABLED_STORES) {
        if (!verifiedStores.has(store)) {
          issue(
            'STORE_BILLING_ENABLED_STORES',
            `"${store}" is enabled but not listed in STORE_BILLING_VERIFIED_STORES — ` +
              'its integration has not been verified against the store’s own ' +
              'documentation and sandbox',
          );
        }
      }

      if (
        env.STORE_BILLING_ENABLED_STORES.length > 0 &&
        env.STORE_BILLING_ENVIRONMENT !== 'production'
      ) {
        issue(
          'STORE_BILLING_ENVIRONMENT',
          `must be "production" when APP_ENV=${env.APP_ENV} — honouring sandbox ` +
            'purchases in production is a free subscription for anyone with a test account',
        );
      }
    }

    /* An API key with no webhook secret can verify a purchase but can never
     * receive a renewal, cancellation, or refund — the subscription silently
     * goes stale the moment the store's next event fires. */
    if (env.REVENUECAT_SECRET_API_KEY !== undefined && !env.REVENUECAT_WEBHOOK_SIGNING_SECRET) {
      issue(
        'REVENUECAT_WEBHOOK_SIGNING_SECRET',
        'is required when REVENUECAT_SECRET_API_KEY is set — without it, renewals, ' +
          'cancellations, and refunds are never applied',
      );
    }
  }

  /* --- Rails ---
   *
   * A rail switched on must be a rail we know about, and a rail running live in
   * a deployed environment must have been verified by a person. The alternative
   * is an integration built from guesswork taking real money.
   */
  {
    const known = new Set([
      'card',
      'stripe',
      'jazzcash',
      'easypaisa',
      'carrier_billing',
      'apple_iap',
      'google_play',
      'mock',
    ]);

    for (const rail of env.PAYMENTS_ENABLED_RAILS) {
      if (!known.has(rail)) issue('PAYMENTS_ENABLED_RAILS', `"${rail}" is not a payment rail`);
    }

    if (isDeployed) {
      const verified = new Set(env.PAYMENTS_VERIFIED_RAILS);
      for (const rail of env.PAYMENTS_ENABLED_RAILS) {
        if (rail === 'mock') {
          issue('PAYMENTS_ENABLED_RAILS', `"mock" must not be enabled when APP_ENV=${env.APP_ENV}`);
          continue;
        }
        if (!verified.has(rail)) {
          issue(
            'PAYMENTS_ENABLED_RAILS',
            `"${rail}" is enabled but not listed in PAYMENTS_VERIFIED_RAILS — ` +
              'its wire format has not been verified against the provider’s own ' +
              'documentation and sandbox, and it must not take real money',
          );
        }
      }
    }
  }

  if (env.PAYMENTS_PROVIDER === 'stripe' && !env.STRIPE_WEBHOOK_SECRET) {
    issue(
      'STRIPE_WEBHOOK_SECRET',
      'is required when PAYMENTS_PROVIDER=stripe — an unverified webhook endpoint grants free subscriptions',
    );
  }
  if (env.PAYMENTS_PROVIDER === 'stripe' && !env.STRIPE_SECRET_KEY) {
    issue('STRIPE_SECRET_KEY', 'is required when PAYMENTS_PROVIDER=stripe');
  }
  if (env.ANALYTICS_ENABLED && !env.ANALYTICS_WRITE_KEY) {
    issue('ANALYTICS_WRITE_KEY', 'is required when ANALYTICS_ENABLED=true');
  }
  // A named provider with no destination is a silent no-op, which is the state
  // error tracking was already in for months. Refused in every environment.
  if (env.STORAGE_PROVIDER === 's3') {
    if (!env.STORAGE_S3_ENDPOINT) {
      issue('STORAGE_S3_ENDPOINT', 'is required when STORAGE_PROVIDER=s3');
    }
    if (!env.STORAGE_S3_ACCESS_KEY_ID || !env.STORAGE_S3_SECRET_ACCESS_KEY) {
      issue(
        'STORAGE_S3_ACCESS_KEY_ID',
        'and STORAGE_S3_SECRET_ACCESS_KEY are required when STORAGE_PROVIDER=s3',
      );
    }
  }
  if (env.ERROR_TRACKING_PROVIDER === 'sentry' && !env.SENTRY_DSN) {
    issue('SENTRY_DSN', 'is required when ERROR_TRACKING_PROVIDER=sentry');
  }
  if (env.ERROR_TRACKING_PROVIDER === 'webhook' && !env.ERROR_TRACKING_WEBHOOK_URL) {
    issue('ERROR_TRACKING_WEBHOOK_URL', 'is required when ERROR_TRACKING_PROVIDER=webhook');
  }

  /* --- Transport security in any deployed environment --- */
  if (isDeployed) {
    // A mock payment rail outside local and ci is a subscription anyone can
    // grant themselves: its signing key is a documented default.
    if (env.PAYMENTS_PROVIDER === 'mock') {
      issue('PAYMENTS_PROVIDER', `must not be "mock" when APP_ENV=${env.APP_ENV}`);
    }
    if (env.DATABASE_SSL_MODE !== 'require') {
      issue('DATABASE_SSL_MODE', `must be "require" when APP_ENV=${env.APP_ENV}`);
    }
    if (env.CORS_ALLOWED_ORIGINS.some((o) => o.includes('*'))) {
      issue('CORS_ALLOWED_ORIGINS', 'must not contain a wildcard in a deployed environment');
    }
  }

  /* --- Production-only rules --- */
  if (isProd) {
    if (!env.REDIS_TLS_ENABLED) {
      issue('REDIS_TLS_ENABLED', 'must be true in production');
    }
    if (env.LOG_LEVEL === 'trace') {
      issue('LOG_LEVEL', 'must not be "trace" in production — it risks logging sensitive payloads');
    }
    if (!env.SAFETY_INPUT_CLASSIFIER_ENABLED) {
      issue('SAFETY_INPUT_CLASSIFIER_ENABLED', 'cannot be disabled in production');
    }
    if (!env.SAFETY_OUTPUT_CLASSIFIER_ENABLED) {
      issue('SAFETY_OUTPUT_CLASSIFIER_ENABLED', 'cannot be disabled in production');
    }
    if (!env.SAFETY_ESCALATION_WEBHOOK_URL) {
      issue(
        'SAFETY_ESCALATION_WEBHOOK_URL',
        'is required in production — disclosures must reach a human (docs/CHILD_SAFETY.md §6)',
      );
    }
    if (!env.REDIS_URL) {
      issue(
        'REDIS_URL',
        'is required in production — without it every rate limit is per-instance, so N instances enforce N x the limit, including the auth one that makes password guessing impractical',
      );
    }
    if (env.STORAGE_PROVIDER === 'memory') {
      issue(
        'STORAGE_PROVIDER',
        'cannot be memory in production — audio would not survive a restart, would not be shared between instances, and the retention sweep could not run',
      );
    }
    if (env.ERROR_TRACKING_PROVIDER === 'none') {
      issue(
        'ERROR_TRACKING_PROVIDER',
        'is required in production — errors otherwise aggregate in one process and are lost when it restarts',
      );
    }
    if (!env.ALERT_WEBHOOK_URL) {
      issue(
        'ALERT_WEBHOOK_URL',
        'is required in production — without it every alert, including safety_pipeline, is a log line nothing is watching',
      );
    }
    if (env.REDIS_KEY_PREFIX === 'kc:local:') {
      issue('REDIS_KEY_PREFIX', 'must differ per environment to avoid cross-environment eviction');
    }
    // Retaining a child's voice is the highest-risk data decision available to
    // us. Turning it on requires deliberate acknowledgement, not a typo.
    if (env.RETENTION_RAW_AUDIO_DAYS > 0 && !env.RETENTION_RAW_AUDIO_OPT_IN_ACK) {
      issue(
        'RETENTION_RAW_AUDIO_DAYS',
        'is greater than 0 in production without RETENTION_RAW_AUDIO_OPT_IN_ACK — see docs/adr/0006',
      );
    }
  }
});

export type ValidatedEnv = z.infer<typeof envSchema>;
export type { AppEnv };
