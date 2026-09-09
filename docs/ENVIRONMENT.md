# Environment Variable Specification

Authoritative reference for every variable the system reads. `.env.example` is the template; this document is the contract.

---

## 1. Rules

1. **Every variable is declared in the `@kids/config` Zod schema.** A variable not in the schema is not read — there is no `process.env.X` anywhere outside `@kids/config`. This is what makes the inventory below trustworthy rather than aspirational.
2. **Validation happens once, at boot, and fails hard.** A missing or malformed required variable aborts startup with a message naming the variable. A service that starts with a broken config and fails on the first child request is strictly worse than one that never starts.
3. **No secret has a default.** A default for `AUTH_JWT_SECRET` is a production system running on a value from a README.
4. **Non-secrets should have safe defaults**, so a fresh clone runs with an unedited `.env`.
5. **Changing a variable requires updating three places in the same PR**: `.env.example`, the schema, and this document.
6. **`EXPO_PUBLIC_` / `NEXT_PUBLIC_` prefixed values are compiled into client bundles and are world-readable.** Anything secret behind those prefixes is disclosed, not configured.

### 1.1 Naming

`<DOMAIN>_<SUBJECT>_<UNIT>` in SCREAMING_SNAKE. Durations carry their unit (`_MS`, `_SECONDS`, `_DAYS`); sizes carry `_BYTES`. `STT_TIMEOUT_MS` cannot be misread; `STT_TIMEOUT` can be misread by a factor of 1000.

### 1.1a The template files

| File                       | Purpose                                                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `.env.example`             | The canonical contract. Every variable, with a placeholder. Copy this to `.env` for local work.                    |
| `.env.development.example` | The **delta** for the shared dev deployment                                                                        |
| `.env.staging.example`     | The delta for staging                                                                                              |
| `.env.production.example`  | A **reference only** — no production `.env` file exists anywhere. Every value is injected from the secret manager. |

The three overlay files exist because "development", "staging", and "production" are not just different values — they are different _rule sets_, enforced by `superRefine` in the schema. Reading them side by side makes the tightening visible.

### 1.2 `NODE_ENV` vs `APP_ENV`

`NODE_ENV` has only three meaningful values and is consumed by frameworks. `APP_ENV` is ours and distinguishes `local`, `ci`, `development`, `staging`, `production` — because staging must run production framework behaviour while using non-production secrets, thresholds, and analytics. Conflating them means either staging behaves unlike production, or staging writes to production analytics.

---

## 2. Reference

Legend: **Req** = required in production · **Secret** = never in a file, never in a client bundle.

### Core runtime

| Variable          | Req | Secret | Default              | Notes                                   |
| ----------------- | :-: | :----: | -------------------- | --------------------------------------- |
| `NODE_ENV`        |  ✓  |        | `development`        | `development` \| `test` \| `production` |
| `APP_ENV`         |  ✓  |        | `local`              | Drives our behaviour; see §1.2          |
| `LOG_LEVEL`       |     |        | `info`               | `trace` is never valid in production    |
| `SERVICE_NAME`    |  ✓  |        | `kids-companion-api` | Every log line and metric               |
| `SERVICE_VERSION` |  ✓  |        | `0.0.0`              | Git SHA, injected by CI                 |

### API server

| Variable                 | Req | Secret | Default    | Notes                                                                                                  |
| ------------------------ | :-: | :----: | ---------- | ------------------------------------------------------------------------------------------------------ |
| `API_HOST`               |     |        | `0.0.0.0`  |                                                                                                        |
| `API_PORT`               |     |        | `8080`     |                                                                                                        |
| `API_PUBLIC_URL`         |  ✓  |        | —          | Absolute URLs, OAuth callbacks, webhooks                                                               |
| `API_REQUEST_TIMEOUT_MS` |     |        | `30000`    |                                                                                                        |
| `API_BODY_LIMIT_BYTES`   |     |        | `10485760` | Sized for one audio upload                                                                             |
| `API_TRUST_PROXY`        |     |        | `false`    | **`true` only behind a known LB.** Otherwise a client can spoof its IP and defeat per-IP rate limiting |
| `CORS_ALLOWED_ORIGINS`   |  ✓  |        | —          | Exact origins, comma-separated. Wildcards rejected when `APP_ENV` is staging or production             |

### Database

| Variable                        | Req | Secret | Default   | Notes                                                                                                                   |
| ------------------------------- | :-: | :----: | --------- | ----------------------------------------------------------------------------------------------------------------------- |
| `SUPABASE_URL`                  |  ✓  |        | —         | Client-safe                                                                                                             |
| `SUPABASE_ANON_KEY`             |  ✓  |        | —         | Client-safe; RLS-constrained                                                                                            |
| `SUPABASE_SERVICE_ROLE_KEY`     |  ✓  |   ✓✓   | —         | **Bypasses RLS.** `apps/api` only. Loading it elsewhere is a build-blocking defect ([SECURITY.md §3.2](../SECURITY.md)) |
| `DATABASE_URL`                  |  ✓  |   ✓    | —         | Migrations and pool                                                                                                     |
| `DATABASE_POOL_MAX`             |     |        | `10`      | Per instance — multiply by instance count against the server limit                                                      |
| `DATABASE_STATEMENT_TIMEOUT_MS` |     |        | `10000`   | Bounds a runaway query in the voice loop                                                                                |
| `DATABASE_SSL_MODE`             |  ✓  |        | `disable` | `require` in every non-local environment                                                                                |

### Redis

| Variable             | Req | Secret | Default     | Notes                                                                                                               |
| -------------------- | :-: | :----: | ----------- | ------------------------------------------------------------------------------------------------------------------- |
| `REDIS_URL`          |  ✓  |   ✓    | —           | Often embeds credentials                                                                                            |
| `REDIS_TLS_ENABLED`  |     |        | `false`     | `true` in production                                                                                                |
| `REDIS_KEY_PREFIX`   |  ✓  |        | `kc:local:` | **Must differ per environment** — a shared instance without distinct prefixes lets staging evict production's cache |
| `QUEUE_CONCURRENCY`  |     |        | `5`         |                                                                                                                     |
| `QUEUE_MAX_ATTEMPTS` |     |        | `3`         | Then dead-letter                                                                                                    |

### Authentication

| Variable                      | Req | Secret | Default      | Notes                                                                                               |
| ----------------------------- | :-: | :----: | ------------ | --------------------------------------------------------------------------------------------------- |
| `AUTH_JWT_SECRET`             |  ✓  |   ✓    | —            | ≥ 32 bytes entropy. Rotating invalidates all sessions                                               |
| `AUTH_JWT_ISSUER`             |  ✓  |        | —            | Validated on every token                                                                            |
| `AUTH_JWT_AUDIENCE`           |  ✓  |        | —            | Validated on every token                                                                            |
| `AUTH_ACCESS_TOKEN_TTL`       |     |        | `15m`        | Longer weakens revocation                                                                           |
| `AUTH_REFRESH_TOKEN_TTL`      |     |        | `30d`        |                                                                                                     |
| `AUTH_REFRESH_TOKEN_ROTATION` |     |        | `true`       | **Never `false` in production.** Rotation + reuse detection is how a stolen refresh token is caught |
| `CHILD_SESSION_TTL`           |     |        | `60m`        | Also the natural session-length ceiling                                                             |
| `PARENT_GATE_MODE`            |     |        | `arithmetic` | A child barrier, not authentication                                                                 |
| `PARENT_GATE_MAX_ATTEMPTS`    |     |        | `5`          |                                                                                                     |
| `PARENT_GATE_LOCKOUT_MINUTES` |     |        | `15`         |                                                                                                     |
| `PASSWORD_HASH_MEMORY_KIB`    |     |        | `19456`      | Argon2id. **Never lower than the default**                                                          |
| `PASSWORD_HASH_ITERATIONS`    |     |        | `2`          |                                                                                                     |
| `PASSWORD_HASH_PARALLELISM`   |     |        | `1`          |                                                                                                     |

### Encryption

| Variable                   | Req | Secret | Default | Notes                                                               |
| -------------------------- | :-: | :----: | ------- | ------------------------------------------------------------------- |
| `ENCRYPTION_ACTIVE_KEY_ID` |  ✓  |        | `k1`    | Written to each encrypted row; enables online rotation              |
| `ENCRYPTION_KEY_<ID>`      |  ✓  |   ✓    | —       | Base64, 32 bytes. Old keys stay loaded decrypt-only during rotation |

### Storage

| Variable                         | Req | Secret | Default        | Notes                                                                                  |
| -------------------------------- | :-: | :----: | -------------- | -------------------------------------------------------------------------------------- |
| `STORAGE_PROVIDER`               |  ✓  |        | `supabase`     | `supabase` \| `s3`                                                                     |
| `STORAGE_BUCKET_AUDIO`           |  ✓  |        | `child-audio`  | **Private.** Public exposure would be a critical breach                                |
| `STORAGE_BUCKET_MEDIA`           |  ✓  |        | `public-media` | Non-personal assets only                                                               |
| `STORAGE_SIGNED_URL_TTL_SECONDS` |     |        | `300`          | Short — a signed URL to child audio is a bearer credential                             |
| `STORAGE_S3_ENDPOINT`            |     |        | —              | Required when `STORAGE_PROVIDER=s3`. AWS, R2, MinIO, or Supabase Storage's S3 endpoint |
| `STORAGE_S3_REGION`              |     |        | `us-east-1`    |                                                                                        |
| `STORAGE_S3_ACCESS_KEY_ID`       |     |   ✓    | —              | Scoped to a bucket of children's voices. Never leaves the server                       |
| `STORAGE_S3_SECRET_ACCESS_KEY`   |     |   ✓    | —              | As above                                                                               |
| `STORAGE_S3_SESSION_TOKEN`       |     |   ✓    | —              | For temporary credentials                                                              |
| `STORAGE_S3_FORCE_PATH_STYLE`    |     |        | `true`         | Required by MinIO and most self-hosted gateways                                        |
| `STORAGE_S3_TIMEOUT_MS`          |     |        | `10000`        | Per request                                                                            |

### AI

| Variable                        | Req | Secret | Default | Notes                                                                                                                                             |
| ------------------------------- | :-: | :----: | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AI_PROVIDER`                   |  ✓  |        | `mock`  | `mock` in local and CI so no key is needed                                                                                                        |
| `AI_MODEL_CONVERSATION`         |  ✓  |        | —       | Pinned. Never a floating alias — a silent model swap is a silent safety change                                                                    |
| `AI_MODEL_SAFETY_CLASSIFIER`    |  ✓  |        | —       | Small/fast; runs on every turn in both directions                                                                                                 |
| `AI_MAX_OUTPUT_TOKENS`          |     |        | `512`   | Cost and turn-length control                                                                                                                      |
| `AI_TEMPERATURE`                |     |        | `0.7`   |                                                                                                                                                   |
| `AI_REQUEST_TIMEOUT_MS`         |     |        | `15000` | Bounded by the voice-loop budget                                                                                                                  |
| `AI_MODERATION_TIMEOUT_MS`      |     |        | `4000`  | Runs twice per turn, on input and output. A timeout here BLOCKS the turn — fail closed                                                            |
| `AI_CONTEXT_MAX_EXCHANGES`      |     |        | `10`    | History window, in exchanges (one child message + one reply). The specification calls for ~10; configurable because the right number is empirical |
| `AI_CONTEXT_MAX_HISTORY_TOKENS` |     |        | `2000`  | Second bound on the window. Whichever limit bites first wins                                                                                      |
| `AI_TEMPERATURE`                |     |        | `0.7`   | Conversation only. Classification always runs at 0                                                                                                |
| `AI_MAX_RETRIES`                |     |        | `2`     | Subject to the retry budget ([ERROR_HANDLING.md §7](ERROR_HANDLING.md))                                                                           |
| `ANTHROPIC_API_KEY`             |     |   ✓    | —       | Required when `AI_PROVIDER=anthropic`                                                                                                             |
| `OPENAI_API_KEY`                |     |   ✓    | —       | Required when `AI_PROVIDER=openai`                                                                                                                |
| `AI_DAILY_COST_CEILING_USD`     |  ✓  |        | `50`    | Hard guard. On trip, degrade — never serve an unbounded bill                                                                                      |
| `AI_PER_CHILD_DAILY_TURN_LIMIT` |  ✓  |        | `300`   | Abuse and runaway-loop guard                                                                                                                      |

### Voice

| Variable                                   | Req | Secret | Default       | Notes                                                                                     |
| ------------------------------------------ | :-: | :----: | ------------- | ----------------------------------------------------------------------------------------- |
| `STT_PROVIDER`                             |  ✓  |        | `mock`        | Vendor undecided — [Q-01](OPEN_QUESTIONS.md)                                              |
| `STT_MODEL`                                |     |        | —             |                                                                                           |
| `STT_LANGUAGE_HINTS`                       |  ✓  |        | `en-US,ur-PK` | Constrained hypothesis set, not autodetect ([ARCHITECTURE.md §7.2](../ARCHITECTURE.md))   |
| `STT_TIMEOUT_MS`                           |     |        | `10000`       |                                                                                           |
| `VOICE_MAX_UPLOAD_BYTES`                   |     |        | `8388608`     | Enforced as the body streams, not after buffering                                         |
| `VOICE_MAX_DURATION_MS`                    |     |        | `30000`       | Read from the container, never from a client-reported value                               |
| `VOICE_MIN_DURATION_MS`                    |     |        | `250`         | Below this there is nothing to transcribe                                                 |
| `VOICE_ALLOW_UNKNOWN_DURATION`             |     |        | `true`        | Browser WebM has no duration until finalised; false makes the duration limit load-bearing |
| `VOICE_MIN_CONFIDENCE`                     |     |        | `0.4`         | Below this the child is asked to repeat rather than answered                              |
| `VOICE_TRANSIENT_AUDIO_SECONDS`            |     |        | `300`         | How long reply audio stays fetchable. A timeout, not a retention period                   |
| `SPEECH_ANALYSIS_PROVIDER`                 |     |        | `mock`        | `transcription` scores from a transcript and cannot see phonemes (Q-06)                   |
| `SPEECH_ANALYSIS_TIMEOUT_MS`               |     |        | `10000`       |                                                                                           |
| `RATE_LIMIT_PRACTICE_PER_MINUTE`           |     |        | `30`          |                                                                                           |
| `RATE_LIMIT_VOICE_PER_MINUTE`              |     |        | `15`          | Lower than text: each turn costs an STT call and a TTS call                               |
| `DEEPGRAM_API_KEY`                         |     |   ✓    | —             |                                                                                           |
| `GOOGLE_APPLICATION_CREDENTIALS_JSON`      |     |   ✓    | —             | Base64 of the JSON — never a file path in a container                                     |
| `AZURE_SPEECH_KEY` / `AZURE_SPEECH_REGION` |     |   ✓    | —             |                                                                                           |
| `TTS_PROVIDER`                             |  ✓  |        | `mock`        |                                                                                           |
| `TTS_TIMEOUT_MS`                           |     |        | `10000`       |                                                                                           |
| `TTS_CACHE_TTL_SECONDS`                    |     |        | `604800`      | **The single biggest cost lever** — stock phrases repeat constantly                       |
| `ELEVENLABS_API_KEY`                       |     |   ✓    | —             |                                                                                           |

### Safety

| Variable                           | Req | Secret | Default  | Notes                                                                                                 |
| ---------------------------------- | :-: | :----: | -------- | ----------------------------------------------------------------------------------------------------- |
| `SAFETY_MODE`                      |  ✓  |        | `strict` |                                                                                                       |
| `SAFETY_INPUT_CLASSIFIER_ENABLED`  |  ✓  |        | `true`   | **Schema rejects `false` when `APP_ENV=production`**                                                  |
| `SAFETY_OUTPUT_CLASSIFIER_ENABLED` |  ✓  |        | `true`   | Same                                                                                                  |
| `SAFETY_BLOCKLIST_VERSION`         |  ✓  |        | —        | Pinned and auditable                                                                                  |
| `SAFETY_FAIL_MODE`                 |  ✓  |        | `closed` | **`open` is not an accepted value.** The variable exists only so the setting is visible and auditable |
| `SAFETY_ESCALATION_WEBHOOK_URL`    |  ✓  |   ✓    | —        | Human escalation route. Required in production ([CHILD_SAFETY.md §6](CHILD_SAFETY.md))                |
| `SAFETY_REVIEW_QUEUE_ENABLED`      |  ✓  |        | `true`   |                                                                                                       |

### Payments

> **No payment rail is production-ready.** Every one of the four is
> sandbox-only, and `PAYMENTS_VERIFIED_RAILS` is what stops an unverified rail
> from taking real money. Read [PAYMENT_RAILS.md](PAYMENT_RAILS.md) before
> changing anything below.

| Variable                             | Req | Secret | Default   | Notes                                                                                     |
| ------------------------------------ | :-: | :----: | --------- | ----------------------------------------------------------------------------------------- |
| `PAYMENTS_ENABLED`                   |     |        | `false`   | Off until Phase 6                                                                         |
| `PAYMENTS_PROVIDER`                  |     |        | `mock`    | Subscription checkout rail. `mock` is refused outside local/ci                            |
| `PAYMENTS_ENABLED_RAILS`             |     |        | —         | **Empty is valid** and means payments are off; the app works normally on the free tier    |
| `PAYMENTS_VERIFIED_RAILS`            |     |        | —         | **Human attestation.** A deployed env refuses to boot with an enabled-but-unverified rail |
| `PAYMENTS_SANDBOX_CALLBACK_SECRET`   |     |        | local key | Signs sandbox rail callbacks. Local and CI only                                           |
| `PAYMENTS_RECONCILE_AFTER_MINUTES`   |     |        | `15`      | How long a payment may sit unanswered before we ask the rail                              |
| `PAYMENTS_WEBHOOK_TOLERANCE_SECONDS` |     |        | `300`     | How old a signed webhook may be                                                           |
| `PAYMENTS_DEFAULT_CURRENCY`          |     |        | `PKR`     |                                                                                           |
| `STRIPE_SECRET_KEY`                  |     |   ✓    | —         |                                                                                           |
| `STRIPE_WEBHOOK_SECRET`              |     |   ✓    | —         | **Signature verification is mandatory.** An unverified webhook grants free subscriptions  |
| `STRIPE_PRICE_ID_*`                  |     |        | —         |                                                                                           |
| `JAZZCASH_MERCHANT_ID`               |     |        | —         |                                                                                           |
| `JAZZCASH_PASSWORD`                  |     |   ✓    | —         |                                                                                           |
| `JAZZCASH_INTEGRITY_SALT`            |     |   ✓    | —         | Request/response hashing                                                                  |
| `JAZZCASH_MODE`                      |     |        | `sandbox` | `live` refuses every call until the rail is verified                                      |
| `EASYPAISA_STORE_ID`                 |     |        | —         |                                                                                           |
| `EASYPAISA_HASH_KEY`                 |     |   ✓    | —         |                                                                                           |
| `EASYPAISA_MODE`                     |     |        | `sandbox` | `live` refuses every call until the rail is verified                                      |
| `CARRIER_BILLING_AGGREGATOR`         |     |        | —         | No aggregator chosen — see Q-02                                                           |
| `CARRIER_BILLING_MERCHANT_ID`        |     |        | —         |                                                                                           |
| `CARRIER_BILLING_API_KEY`            |     |   ✓    | —         |                                                                                           |
| `CARRIER_BILLING_CALLBACK_SECRET`    |     |   ✓    | —         |                                                                                           |
| `CARRIER_BILLING_MODE`               |     |        | `sandbox` | Refunds are expected to be impossible on this rail                                        |
| `CARD_PROCESSOR`                     |     |        | —         | No processor chosen                                                                       |
| `CARD_SECRET_KEY`                    |     |   ✓    | —         |                                                                                           |
| `CARD_WEBHOOK_SECRET`                |     |   ✓    | —         |                                                                                           |
| `CARD_MODE`                          |     |        | `sandbox` | This application never receives a card number                                             |
| `APPLE_IAP_SHARED_SECRET`            |     |   ✓    | —         | Receipt validation — server-side only, never trust a client receipt                       |
| `APPLE_IAP_ENVIRONMENT`              |     |        | `sandbox` |                                                                                           |
| `GOOGLE_PLAY_PACKAGE_NAME`           |     |        | —         |                                                                                           |
| `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON`   |     |   ✓    | —         | Base64                                                                                    |

### Quotas

| Variable                         | Req | Secret | Default | Notes                                           |
| -------------------------------- | :-: | :----: | ------- | ----------------------------------------------- |
| `FREE_TIER_DAILY_MINUTES`        |  ✓  |        | `10`    | Pending [S-2](../DEVELOPMENT_PLAN.md) economics |
| `FREE_TIER_CHILD_PROFILE_LIMIT`  |  ✓  |        | `1`     |                                                 |
| `FREE_TIER_STORY_LIMIT_PER_WEEK` |  ✓  |        | `3`     |                                                 |
| `PAID_TIER_CHILD_PROFILE_LIMIT`  |  ✓  |        | `4`     |                                                 |

### Rate limiting

| Variable                                 | Req | Secret | Default | Notes                                             |
| ---------------------------------------- | :-: | :----: | ------- | ------------------------------------------------- |
| `RATE_LIMIT_GLOBAL_PER_MINUTE`           |     |        | `600`   |                                                   |
| `RATE_LIMIT_AUTH_PER_15_MIN`             |     |        | `10`    | Strictest — credential stuffing                   |
| `RATE_LIMIT_CONVERSATION_PER_MINUTE`     |     |        | `30`    | Also a runaway-cost guard                         |
| `RATE_LIMIT_CONVERSATION_START_PER_HOUR` |     |        | `30`    | Starting sessions is rare; looping on it is a bug |
| `RATE_LIMIT_UPLOAD_PER_MINUTE`           |     |        | `20`    |                                                   |

### Observability

| Variable                           | Req | Secret | Default              | Notes                                                          |
| ---------------------------------- | :-: | :----: | -------------------- | -------------------------------------------------------------- |
| `OTEL_EXPORTER_OTLP_ENDPOINT`      |     |        | —                    | Traces disabled when unset                                     |
| `OTEL_SERVICE_NAME`                |     |        | `kids-companion-api` |                                                                |
| `SENTRY_DSN`                       |     |   ✓    | —                    | Scrubbing configured before enabling                           |
| `SENTRY_TRACES_SAMPLE_RATE`        |     |        | `0.1`                |                                                                |
| `METRICS_ENABLED` / `METRICS_PORT` |     |        | `true` / `9464`      | Never publicly exposed                                         |
| `ANALYTICS_PROVIDER`               |     |        | `none`               |                                                                |
| `ANALYTICS_WRITE_KEY`              |     |   ✓    | —                    |                                                                |
| `ANALYTICS_ENABLED`                |     |        | `false`              | Off unless the parent opts in ([PRIVACY.md §4](../PRIVACY.md)) |

### Retention (days)

| Variable                               | Req | Secret | Default | Notes                                                                                                                                                               |
| -------------------------------------- | :-: | :----: | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RETENTION_RAW_AUDIO_DAYS`             |  ✓  |        | `0`     | **`0` = discard at transcription.** Any non-zero value in production requires documented parent opt-in ([ADR-0006](adr/0006-voice-pipeline-and-audio-retention.md)) |
| `RETENTION_TRANSCRIPT_DAYS`            |  ✓  |        | `90`    | A **ceiling** on the per-child setting; where they differ the shorter wins                                                                                          |
| `RETENTION_ANALYTICS_EVENT_DAYS`       |  ✓  |        | `395`   |                                                                                                                                                                     |
| `RETENTION_AUDIT_LOG_DAYS`             |  ✓  |        | `730`   |                                                                                                                                                                     |
| `RETENTION_DELETED_ACCOUNT_GRACE_DAYS` |  ✓  |        | `30`    | Then irreversible hard delete                                                                                                                                       |

### Feature flags

All default `false` and are flipped per environment: `FEATURE_MULTILINGUAL_URDU`, `FEATURE_PRONUNCIATION_PRACTICE`, `FEATURE_STORY_MODE`, `FEATURE_ROLEPLAY_MODE`, `FEATURE_PARENT_DASHBOARD`, `FEATURE_OFFLINE_MODE`.

A flag is removed once its feature is permanent. Flags that outlive their rollout become untested code paths.

### Client-side (PUBLIC — world-readable)

`EXPO_PUBLIC_API_URL`, `EXPO_PUBLIC_APP_ENV`, `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_APP_ENV`.

**These end up in a bundle any user can read.** Adding a secret here discloses it. CI greps for suspicious names on these prefixes.

---

## 3. Cross-field rules

The schema enforces relationships, not just individual values. Each of these is a real misconfiguration that a per-field schema would accept:

| Condition                                               | Requirement                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `AI_PROVIDER=anthropic`                                 | `ANTHROPIC_API_KEY` present                                                                                                                                                                                                                                                                                                                            |
| `STT_PROVIDER=deepgram`                                 | `DEEPGRAM_API_KEY` present                                                                                                                                                                                                                                                                                                                             |
| `STORAGE_PROVIDER=s3`                                   | `STORAGE_S3_ENDPOINT`, `STORAGE_S3_ACCESS_KEY_ID` and `STORAGE_S3_SECRET_ACCESS_KEY` present                                                                                                                                                                                                                                                           |
| `APP_ENV=production`                                    | `DATABASE_SSL_MODE=require`, `REDIS_TLS_ENABLED=true`, `API_TRUST_PROXY` explicitly set, no wildcard in `CORS_ALLOWED_ORIGINS`, `LOG_LEVEL` not `trace`, all `SAFETY_*_ENABLED=true`, `SAFETY_ESCALATION_WEBHOOK_URL` present, `ALERT_WEBHOOK_URL` present, `ERROR_TRACKING_PROVIDER` not `none`, `STORAGE_PROVIDER` not `memory`, `REDIS_URL` present |
| `PAYMENTS_ENABLED=true`                                 | At least one payment provider fully configured, with its webhook secret                                                                                                                                                                                                                                                                                |
| `RETENTION_RAW_AUDIO_DAYS > 0` and `APP_ENV=production` | Boot fails without an explicit `RETENTION_RAW_AUDIO_OPT_IN_ACK` acknowledgement                                                                                                                                                                                                                                                                        |
| `ANALYTICS_ENABLED=true`                                | `ANALYTICS_WRITE_KEY` present                                                                                                                                                                                                                                                                                                                          |

The last one in the production row is worth noting: it means a deploy that accidentally disables the safety classifiers **will not start**. That is the intended behaviour.

---

## 4. Per-environment posture

|              | local     | ci         | staging         | production     |
| ------------ | --------- | ---------- | --------------- | -------------- |
| Providers    | `mock`    | `mock`     | real (sandbox)  | real           |
| Secrets from | `.env`    | CI secrets | secret manager  | secret manager |
| `LOG_LEVEL`  | `debug`   | `warn`     | `info`          | `info`         |
| TLS          | off       | off        | on              | on             |
| Analytics    | off       | off        | staging project | on (opt-in)    |
| Data         | synthetic | synthetic  | **synthetic**   | real           |
| Payments     | off       | off        | sandbox         | live           |

**Staging uses synthetic data.** No production data is copied to any non-production environment, ever — child voice and transcripts cannot be meaningfully anonymised ([PRIVACY.md §11](../PRIVACY.md)).

---

## 5. Local setup

```bash
cp .env.example .env
```

```bash
pnpm env:check
```

The defaults work as-is: every provider is `mock`, so a fresh clone runs the full loop with **no API keys**. Real keys are needed only to deliberately exercise a real provider.

**Never paste a real credential into `.env.example`.** Rotate immediately if it happens — the file is committed, and history is forever.
