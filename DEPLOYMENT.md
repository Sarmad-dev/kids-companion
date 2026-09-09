# Deployment

How this application is run in development, staging, and production.

---

## Read this first

**Nothing in this document has been executed.** Docker is not installed on the
machine where these files were written, so the Dockerfiles have never been
built, the compose stack has never been started, and no container has ever run.
Everything here is reviewed and statically checked (`pnpm run verify:deploy`),
which is not the same as working. **The first person to run `pnpm staging:up`
is doing the first real test of it**, and §10 lists what to expect.

**Production is not ready, and this document does not authorise a production
deploy.** Two things in §9 block a multi-instance deployment outright, and
neither is a configuration problem — they are missing implementations.

---

## 1. The shape of it

|            | Development                    | Staging                            | Production                  |
| ---------- | ------------------------------ | ---------------------------------- | --------------------------- |
| `APP_ENV`  | `local`                        | `staging`                          | `production`                |
| `NODE_ENV` | `development`                  | `production`                       | `production`                |
| Runs as    | pnpm processes on your machine | containers on one host             | orchestrated containers     |
| Postgres   | container, port 54322          | container, not published           | managed, TLS required       |
| Redis      | container, port 6379           | container, password, not published | managed, TLS required       |
| Migrations | `pnpm db:migrate` by hand      | `migrate` job before app starts    | job in the release pipeline |
| Worker     | optional, `pnpm dev:worker`    | one container                      | **exactly one** instance    |
| Providers  | mocks                          | real vendors, sandbox billing      | real                        |
| Data       | seeded, synthetic              | **synthetic only**                 | real child data             |

Three processes, from **two images**:

| Process       | Image                | Command                                  |
| ------------- | -------------------- | ---------------------------------------- |
| API           | `kids-companion-api` | `node apps/api/dist/server.js` (default) |
| Worker        | `kids-companion-api` | `node apps/api/dist/worker.js`           |
| Migration job | `kids-companion-api` | `node infra/scripts/migrate.mjs`         |
| Dashboard     | `kids-companion-web` | `node apps/web/server.js` (default)      |

The API, worker, and migration job deliberately share one image. One artifact
means the schema, the code that reads it, and the code that sweeps it are
provably the same build — three images from three pipelines can disagree, and
the way you discover that is a migration applied by a version that no longer
matches the API deployed next to it.

---

## 2. Development

```bash
cp .env.example .env
pnpm install
pnpm docker:up
pnpm db:migrate
pnpm db:seed:dev
pnpm dev
```

`pnpm docker:up` starts Postgres (`localhost:54322`) and Redis
(`localhost:6379`) from [`infra/docker/docker-compose.yml`](infra/docker/docker-compose.yml).
Those credentials are weak and well-known on purpose: they are not secrets, and
nothing resembling them belongs in a deployed environment.

The worker is a separate process and usually unnecessary locally — the sweeps
are backstops, and entitlement is computed from timestamps whenever it is read,
so a subscription expires on time whether or not anything swept. Run it when
working on billing:

```bash
pnpm dev:worker
```

**Every provider defaults to a mock.** No test or dev command contacts a live
vendor, spends real money, or consumes paid AI quota.

---

## 3. Staging

Staging exists to catch what only appears under production configuration: TLS,
real vendor latency, real payment sandboxes, production framework behaviour. It
runs `NODE_ENV=production` for exactly that reason.

**Staging must never contain production data.** Child voice and transcripts
cannot be meaningfully anonymised, so they are never copied out of production
([PRIVACY.md §11](PRIVACY.md)). Staging is seeded with synthetic profiles.

### 3.1 Single-host staging

```bash
cp .env.staging.example .env.staging
# fill it from the secret manager — the file is git-ignored and must stay that way
pnpm run verify:deploy
pnpm staging:up
```

That builds both images and starts Postgres, Redis, the migration job, the API,
the worker, and the dashboard, in that order.

```bash
pnpm staging:ps       # what is running
pnpm staging:logs     # follow everything
pnpm staging:migrate  # apply migrations again, on their own
pnpm staging:down     # stop
```

### 3.2 Two variables the compose file overrides

[`docker-compose.staging.yml`](infra/docker/docker-compose.staging.yml) sets
`DATABASE_SSL_MODE=disable` and `REDIS_TLS_ENABLED=false`, overriding the
template.

That is correct for one host on a private bridge network, where neither service
is published and there is no TLS terminator in front of them. **It is wrong for
anything reachable off-box.** A staging environment backed by managed Postgres
and managed Redis ignores those overrides and uses `require` / `true`, which is
what `.env.staging.example` sets and what production enforces at boot.

### 3.3 What is not published

Postgres and Redis have `expose`, not `ports`. Neither is reachable from outside
the compose network. Staging holds synthetic data, but a database reachable from
the host is a habit that follows people to production.

```bash
docker compose -f infra/docker/docker-compose.staging.yml exec postgres \
  psql -U "$POSTGRES_USER" -d kids_companion
```

---

## 4. Migrations

Forward-only, immutable once merged, tracked in `schema_migrations`, applied by
[`infra/scripts/migrate.mjs`](infra/scripts/migrate.mjs) — the same loader the
integration tests use, so the migrations CI verified are exactly the migrations
this applies.

```bash
pnpm db:status    # what is applied, and what is pending
pnpm db:migrate   # apply everything pending
```

**Migrations are a job that runs to completion before the application starts.**
Not on API boot. Migrating at boot means every instance races the same DDL on
every deploy; `schema_migrations` makes that survivable but not correct, and the
failure mode — a half-migrated schema serving traffic — is the one worth
designing out.

In staging, `depends_on: { migrate: { condition: service_completed_successfully } }`
enforces the ordering. The job is `restart: "no"` deliberately: a migration job
that restarts on failure retries a migration that just failed against a schema
it may have partly changed.

**The deployment order that follows from forward-only migrations:**

1. Apply migrations. They must be backward-compatible with the version currently
   running, because for the next few minutes both versions are live.
2. Deploy the new application version.
3. Only in a **later** release, remove what the old version needed.

A migration that drops a column the running version still selects is an outage
during its own deploy.

---

## 5. Health and readiness

Two endpoints answering two different questions. Conflating them causes outages.

### `GET /health` — liveness

Touches nothing. Returns 200 while the process is running.

```json
{ "status": "ok", "service": "kids-companion-api", "version": "1.4.2" }
```

This is what container `HEALTHCHECK` and an orchestrator's liveness probe use.
**Never point liveness at a dependency check.** Docker and Kubernetes restart a
container whose liveness fails; a liveness probe that queries the database
restarts every healthy container the moment the database slows down, converting
a degraded dependency into an outage.

The worker serves the same route on `WORKER_PORT` (8081) and nothing else — an
orchestrator needs something to probe, or a worker whose timers have silently
stopped looks identical to a working one.

### `GET /ready` — readiness

Probes dependencies. 200 when usable, **503** when not.

```json
{ "status": "ready", "checks": { "database": "ok", "redis": "skipped" } }
```

| Result        | Meaning                         | Effect                                    |
| ------------- | ------------------------------- | ----------------------------------------- |
| `ok`          | probed and answered             | —                                         |
| `unavailable` | probed and failed, or timed out | **503**, withdrawn from the load balancer |
| `skipped`     | not configured, so not examined | no effect on status                       |

`skipped` is not a synonym for healthy. An unconfigured dependency is
unexamined, and reporting it as `ok` would be a lie that reads exactly like the
truth on a dashboard. Redis reports `skipped` wherever `REDIS_URL` is unset,
which is correct today — see §9.2.

Both probes run in parallel, each bounded by `READINESS_PROBE_TIMEOUT_MS`
(default 2000). Sequentially, the endpoint's own worst case would be the sum of
every dependency's, which is how a readiness endpoint becomes the thing that
takes the load balancer down. **Keep this well below the orchestrator's probe
timeout**, or a slow dependency becomes a restart loop rather than a withdrawal.

The Redis probe authenticates and then sends `PING`. Credentials that are
rejected report `unavailable`: the port being open is not the question, and a
plain TCP check calls that case healthy.

Readiness never reports _why_ a dependency failed. It is reachable without
credentials, and a driver error names the host, the database, and the user.

---

## 5a. Alerts

`ALERT_WEBHOOK_URL` is **required in production** — the API refuses to boot
without it. Everything else about alerting has a working default.

| Variable                       | Default   | Notes                                       |
| ------------------------------ | --------- | ------------------------------------------- |
| `ALERT_WEBHOOK_URL`            | —         | **required in production**; treat as secret |
| `ALERT_WEBHOOK_FORMAT`         | `generic` | `generic` or `slack`                        |
| `ALERT_WEBHOOK_TIMEOUT_MS`     | `5000`    | per attempt; three attempts                 |
| `ALERT_EVALUATION_INTERVAL_MS` | `60000`   | how often thresholds are checked            |

Set it to a Slack incoming webhook with `ALERT_WEBHOOK_FORMAT=slack` and a
person sees an alert on their phone; point it at an Alertmanager receiver with
`generic` and it joins whatever routing already exists. The `fatal` log line is
written either way, so a webhook outage does not lose the alert.

**Store it as a secret, not as configuration.** A Slack incoming-webhook URL is
a bearer credential in path form: anyone holding it can post into the channel.
The transport never logs it and never puts it in an error message.

Five conditions fire. `safety_pipeline` is the one to route to a person rather
than a dashboard — it means children are talking while the layer that checks
what reaches them is not working. See [docs/OBSERVABILITY.md §6](docs/OBSERVABILITY.md).

---

## 5b. Error tracking

`ERROR_TRACKING_PROVIDER` is **required in production** and must name a real
destination — the API refuses to boot on `none`.

| Variable                         | Default  | Notes                                 |
| -------------------------------- | -------- | ------------------------------------- |
| `ERROR_TRACKING_PROVIDER`        | `none`   | `none`, `sentry`, `webhook`           |
| `SENTRY_DSN`                     | —        | required when provider is `sentry`    |
| `ERROR_TRACKING_WEBHOOK_URL`     | —        | required when provider is `webhook`   |
| `ERROR_TRACKING_TIMEOUT_MS`      | `5000`   | per attempt; errors are never retried |
| `ERROR_TRACKING_RESEND_AFTER_MS` | `300000` | the gap between sends of the same bug |

**There is no Sentry SDK in this repository, and adding one would be a privacy
regression.** Its default integrations capture request bodies and headers, and
the request body on the busiest route here is a child speaking. The envelope is
written by hand so nothing can attach anything unchosen. See
[docs/OBSERVABILITY.md §7](docs/OBSERVABILITY.md).

Only 5xx responses are captured, deduplicated by fingerprint, and correlated to
`SERVICE_VERSION`. The aggregate is on `GET /api/admin/health/detailed`.

---

## 5c. Object storage

`STORAGE_PROVIDER` must be `s3` in production — the API refuses to boot on
`memory`.

| Variable                       | Default       | Notes                                      |
| ------------------------------ | ------------- | ------------------------------------------ |
| `STORAGE_PROVIDER`             | `memory`      | `memory` or `s3`; `memory` refused in prod |
| `STORAGE_S3_ENDPOINT`          | —             | required when provider is `s3`             |
| `STORAGE_S3_REGION`            | `us-east-1`   |                                            |
| `STORAGE_S3_ACCESS_KEY_ID`     | —             | **secret**                                 |
| `STORAGE_S3_SECRET_ACCESS_KEY` | —             | **secret**                                 |
| `STORAGE_S3_SESSION_TOKEN`     | —             | **secret**; for temporary credentials      |
| `STORAGE_S3_FORCE_PATH_STYLE`  | `true`        | required by MinIO and most gateways        |
| `STORAGE_S3_TIMEOUT_MS`        | `10000`       | per request                                |
| `STORAGE_BUCKET_AUDIO`         | `child-audio` |                                            |

Any S3-compatible endpoint works: AWS, Cloudflare R2, MinIO, or Supabase Storage
through its S3-compatible endpoint. There is **no AWS SDK** in this repository —
SigV4 is written out, for the same reason the Redis probe speaks RESP directly.

**The bucket holds children's voice recordings. Two things follow.**

The credentials are secrets and belong in the secret manager. They never leave
the server: there is no presigned URL anywhere in this codebase and the adapter
exposes no method that could mint one, which is asserted by a test. A mobile app
posts bytes to our API and fetches reply audio from our API.

Give the credential the narrowest policy that works — `GetObject`, `PutObject`,
`DeleteObject`, `ListBucket` on that bucket and nothing else — and make the
bucket private with public access blocked. A **bucket lifecycle rule is not a
substitute for the sweep**: it is provider configuration this application cannot
see, cannot test, and cannot prove ran, and the retention record has to agree
with the bytes. Set one if you like, as a second line.

> **NOT YET VERIFIED.** No request from this codebase has ever reached a real S3
> endpoint. The signing is implemented and structurally tested; conformance is
> proven by the first successful voice turn against a real bucket, and that has
> not happened. A wrong signature 403s immediately rather than failing quietly,
> so this is a step to complete before staging traffic, not a risk to monitor.

---

## 6. The worker

One process running seven scheduled sweeps, six of which are enabled:

| Sweep                            | Default interval | What it does                                                  |
| -------------------------------- | ---------------- | ------------------------------------------------------------- |
| `safety.retryEscalationDelivery` | 1 min            | **a disclosure that has not yet reached a human** — see below |
| `learning.rebuildRollups`        | 5 min            | progress numbers for conversations nobody ended               |
| `subscriptions.sweepExpired`     | 5 min            | stored status that has drifted from an elapsed period         |
| `payments.reconcile`             | 5 min            | payments whose outcome we never heard                         |
| `privacy.expireTranscripts`      | 60 min           | **deletes transcripts past their retention** — see below      |
| `privacy.expireAudio`            | 15 min           | **deletes audio past its expiry** — only with a shared store  |
| `storeBilling.synchronise`       | 60 min           | store purchases whose state moved without a notification      |

**Three of these are not backstops, and the worker not running is a real problem
for all of them.**

`safety.retryEscalationDelivery` is on the shortest interval because it repairs
a child whose disclosure could not be routed when it happened. If the worker is
down, nothing retries it.

`privacy.expireTranscripts` is the only thing that deletes a transcript. If the
worker is down, retention silently stops — data is kept past what a parent was
promised, and nothing else in the system notices. Unlike the audio sweep it CAN
run from this process: the content is in the database, so the statement that
overwrites it IS the deletion, with no gap in which a ledger could claim a
deletion that did not happen.

`RETENTION_TRANSCRIPT_DAYS` is a **ceiling** on the per-child setting, never a
floor — where they differ the shorter wins. Each sweep writes one audit row per
child (`privacy.transcript.redacted`) carrying a count, so the promise is
checkable. See [PRIVACY.md](PRIVACY.md).

`privacy.expireAudio` is scheduled **only when `STORAGE_PROVIDER=s3`**. With the
in-memory store the bytes are in the API's heap, so a sweep from the worker would
mark the ledger while the objects survived — a retention record asserting a
deletion that did not happen, which is worse than no sweep. When storage is
in-memory the worker logs the refusal on every boot instead. See §5c.

The rest are backstops, not the primary path. Entitlement is derived from
timestamps on read, so a subscription is expired the moment its window closes
whether or not a sweep has run. What the sweeps buy is stored state that matches
reality, and recovery from the two failures that leave it behind: a crash
mid-write, and a vendor callback that never arrived.

### Why a separate process

1. A sweep must run **once per interval, not once per instance**. Scheduling
   inside the API means N instances reconcile the same payments simultaneously,
   asking a payment rail the same question N times.
2. Sweeps are unbounded work on a thread that also serves children. The
   performance phase measured what CPU-bound work does to unrelated requests: a
   login burst multiplied an unrelated read's p95 by **21×**
   ([PERFORMANCE_REPORT.md §3](docs/PERFORMANCE_REPORT.md)). A reconciliation
   pass over a backlog would do the same, during an incident.
3. They scale differently — the API with children talking, the sweeps with
   subscriptions and unresolved payments.

### Exactly one instance

**There is no distributed lock.** Two workers would query every payment rail
twice and race on the same rows. Each sweep is individually idempotent, so a
brief overlap during a deploy is survivable; sustained duplication is not, and
nothing in the system would report it.

Enforce `replicas: 1` in the orchestrator. This is a constraint, not a default.

The first pass of each sweep waits a full interval rather than running at boot:
a deploy restarts every instance at once, and sweeping on start means a
thundering herd against the database and every payment rail at exactly the
moment a release is going out.

A failing sweep logs at `error` and does not exit. These are backstops — the
next pass retries, and a crash loop would stop every _other_ sweep too.

---

## 7. Redis

Provisioned in staging, and **not yet on the request path.**

| Use                       | Status                                          |
| ------------------------- | ----------------------------------------------- |
| Readiness probe           | implemented                                     |
| Distributed rate limiting | **not implemented** — the limiter is in-process |
| Worker leader election    | not implemented — hence "exactly one worker"    |

Being direct about why it is there at all: staging provisions Redis so that
connectivity, credentials, and TLS are proven _before_ the rate-limiter
migration lands, rather than discovering a networking problem at the same time
as a behaviour change. Readiness is what proves it.

**Until that migration lands, rate limits are per-instance.** Behind _N_
instances the effective limit is _N_ × the configured value. With
`RATE_LIMIT_AUTH_PER_15_MIN=10` and three instances, an attacker gets 30
attempts per IP per window. That is the concrete reason §9 lists multi-instance
deployment as blocked.

`REDIS_KEY_PREFIX` must differ per environment (`kc:staging:`, `kc:prod:`), and
production refuses to boot with the local default — a shared prefix means one
environment evicting another's keys.

---

## 8. Secrets

**No secret is ever baked into an image.**

- `.dockerignore` excludes `.env` and `.env.*`, so no environment file can reach
  a layer even by accident.
- Nothing is passed as a Docker **build arg**. Build args are readable in the
  image history forever — passing a secret that way publishes it rather than
  hiding it.
- Every credential arrives at run time: `env_file` in staging, the secret
  manager in production.
- `pnpm run verify:no-secrets` scans the repository; `pnpm run verify:deploy`
  additionally checks that no compose file or template contains a
  credential-shaped literal.

**The dashboard image is environment-agnostic**, and that is deliberate. It
reads no `NEXT_PUBLIC_*` variables — Next inlines those into the client bundle
at build time, which would both publish them and make the artifact
environment-specific. It reads `API_BASE_URL` on the server at run time instead,
because every dashboard fetch happens in a Server Component or Server Action and
the parent's session token never enters a browser bundle.

The consequence: **the exact web image verified in staging is the one that can
go to production.** Nothing is baked in that would have to change.

The API image is likewise environment-agnostic. Both are promoted, not rebuilt.

### Image hardening

Both images: multi-stage, `node:24-alpine`, non-root (`USER node`), `dumb-init`
as PID 1 so `SIGTERM` reaches the process and in-flight turns finish rather than
being cut off mid-sentence. No compiler, test runner, or `.ts` source in the
runtime layer — source in a runtime image hands an attacker who lands a shell
the comments explaining how every control works. `--ignore-scripts` on every
install, so no third-party `postinstall` executes during a build.

---

## 9. Blockers before any multi-instance deployment

**Both original blockers are resolved in code.** What remains before actually
running more than one instance is verification against real infrastructure — a
real bucket and a real Redis — not more code. See §9.3.

### 9.1 Audio storage is in-memory · ~~**blocker**~~ **RESOLVED in code**

`createMemoryAudioStorage` was the only `AudioStorage` implementation, despite
`STORAGE_PROVIDER` existing in the config schema and being read by nothing.

Consequences at the time:

- **Audio did not survive a restart**, and was not shared between instances.
- **The retention backstop could not run in the worker.** The bytes lived in
  whichever process wrote them, so a sweep from the worker would mark the ledger
  rows deleted while the objects survived in the API's heap — a retention record
  asserting a deletion that did not happen, which is worse than no sweep because
  it is the record someone would rely on.

An S3-compatible adapter now exists (§5c), `STORAGE_PROVIDER` is read, `memory`
is refused in production, and the worker schedules `privacy.expireAudio` exactly
when the store is shared. In-memory remains the default for local and CI, where
the boot-time refusal is still logged and still correct.

**Storage is no longer what keeps this single-instance** — §9.2 is. What has NOT
happened is a request from this codebase reaching a real bucket; see the note in
§5c.

### 9.2 Rate limiting is per-instance · ~~**blocker**~~ **RESOLVED**

Multi-instance deployment multiplied every limit by the instance count,
including the authentication limit that makes online password guessing
impractical. Redis was already provisioned and already probed by `/ready`; the
limiter never touched it.

It does now. `@fastify/rate-limit` is given a Redis-backed store whenever
`REDIS_URL` is set, so N instances enforce one limit. Counter keys are hashed —
the limiter keys on an IP or a parent id, and Redis must not become a record of
who was where.

**If Redis becomes unreachable the limiter counts in the process instead**, which
is what it did before. Not fail-open, which would remove the auth limiter at
exactly the moment an attacker might be why Redis is struggling; not fail-closed,
which turns a cache outage into a total outage for a product a child is
mid-conversation with. An outage costs the improvement, never the protection, and
logs `control: rate_limit_store` at `error` — **worth alerting on in your log
platform**, since it is deliberately not one of the five paging conditions.

`RATE_LIMIT_WEBHOOK_PER_MINUTE` also replaces the one limit that was hard-coded
into a route, so it can be lowered during an incident without a release.

### 9.3 Also outstanding

- **Neither shared dependency has been exercised for real.** No request from
  this codebase has reached a real S3 endpoint (§5c) and no limiter has counted
  against a real Redis. Both are implemented and tested against local doubles;
  both fail loudly rather than silently if wrong. Standing up staging once is
  what turns these from implemented into verified.
- **No distributed lock**, so exactly one worker (§6).
- **Message encryption uses a `placeholder` codec.** The column and key-id
  plumbing exist; real AES-GCM does not. Conversation content is protected by
  RLS and database access control, not by application-layer encryption at rest.
- **No CI image build or scan.** Images are built by hand today.
- **`pnpm audit` is not in CI.** Three advisories exist in Expo build tooling
  only, with zero paths from `apps/api`
  ([SECURITY_AUDIT.md F-04](docs/SECURITY_AUDIT.md)).

---

## 10. Production

> **Do not deploy to production.** §9's blockers are resolved in code, but
> nothing here has been exercised against real infrastructure. This section
> documents the target so the gap is legible — it is not a runbook for a deploy
> that should happen now.

### Topology

Managed Postgres (TLS required, automated backups, point-in-time recovery),
managed Redis (TLS required), API behind a load balancer polling `/ready`,
**one** worker, dashboard behind a CDN. Compose is not a production topology:
one host, one database, no replica, volumes on local disk.

### What production enforces at boot

The config schema refuses to start rather than running misconfigured
([`packages/config/src/env.ts`](packages/config/src/env.ts)):

- `PAYMENTS_PROVIDER` must not be `mock` — its signing key is a documented
  default, so a mock rail is a subscription anyone can grant themselves.
- `DATABASE_SSL_MODE=require`; `REDIS_TLS_ENABLED=true`.
- No wildcard in `CORS_ALLOWED_ORIGINS`.
- `LOG_LEVEL` must not be `trace` — it risks logging sensitive payloads.
- Both safety classifiers must be enabled. Neither can be disabled in production.
- `SAFETY_ESCALATION_WEBHOOK_URL` is required: a disclosure must reach a human
  ([CHILD_SAFETY.md §6](docs/CHILD_SAFETY.md)).
- `REDIS_KEY_PREFIX` must differ from the local default.
- Retaining raw child audio requires `RETENTION_RAW_AUDIO_OPT_IN_ACK` —
  deliberate acknowledgement, not a typo.

### Release sequence

1. CI green: `pnpm run check`, full test suite, `pnpm run verify:no-secrets`,
   `pnpm run verify:deploy`, `pnpm run db:types:check`.
2. Build both images, tag with the commit SHA, scan them.
3. Promote the **staging-verified images**. Do not rebuild — a rebuild is a
   different artifact than the one that was tested.
4. Apply migrations as a job. Backward-compatible with the running version (§4).
5. Deploy the API. Watch `/ready` and the error rate.
6. Deploy the worker. **Stop the old one first** — one at a time.
7. Deploy the dashboard.

### Rollback

Redeploy the previous image tag. **Migrations are forward-only and are not
rolled back** — this is why every migration must be compatible with the version
before it. A migration that cannot be rolled forward past needs a new migration,
not a reversal.

---

### 10.3 Backups, and the drill that makes them real

**An untested backup is not a backup.** The failure to design against is not a
backup that never ran — it is one that ran nightly for eighteen months, exited 0
every time, and produced a file that stops halfway through the schema.

| Piece                                | What it does                                              |
| ------------------------------------ | --------------------------------------------------------- |
| `infra/scripts/backup.sh`            | dumps, **verifies, then encrypts**; prunes local copies   |
| `infra/scripts/verify-backup.mjs`    | decides whether a dump is worth keeping                   |
| `infra/scripts/restore.sh`           | restores, with guards against the target being production |
| `.github/workflows/backup-drill.yml` | dumps and restores real Postgres weekly, and checks it    |

#### What a dump of this database is

Every conversation every child has had, their names, their ages, and their
parents' contact details. Message content sits in `content_ciphertext`, but the
codec is still `placeholder` (§9.3) — **treat the dump as plaintext**.

`backup.sh` therefore **refuses to run without `BACKUP_ENCRYPT_CMD`**. Not a
warning: a warning in an unattended nightly job is read by nobody, and the result
would be a directory of children's conversations in the clear, retained for a
week, on a host chosen for having disk space. Server-side encryption at the
destination is not a substitute, because the file exists on local disk first —
and the script deletes the plaintext on every exit path, including failure.

#### The check that matters most

A restore that comes back **without the RLS policies**.

Every table is `ENABLE` plus `FORCE` row-level security, and 85 policies are what
stop one family reading another's conversations. A dump missing them restores
into a database that starts, serves traffic, passes a smoke test — and has no
tenant isolation at all. That is a total confidentiality failure that looks
exactly like a successful recovery.

So the policies are counted in the dump before it is kept, counted again in the
target after a restore, and the drill compares both against the source. `ENABLE`
without `FORCE` is checked separately: without `FORCE`, the table owner — which
is the role the application connects as — bypasses every policy.

#### The drill

Weekly, and on any change to the machinery itself, `backup-drill.yml` builds a
Postgres from the migrations, puts a row in it, runs the real `backup.sh` with
real encryption, restores into a **second** database with the real `restore.sh`,
and then asserts:

- table count, policy count and row count match the source exactly;
- no restored table enables RLS without forcing it;
- the migration ledger came back, so the next deploy does not replay everything;
- no plaintext dump was left on disk.

Running it by hand is `workflow_dispatch`. Restoring **production** needs
`I_UNDERSTAND_THIS_OVERWRITES_PRODUCTION=yes-restore-production`, because the
realistic accident is not carelessness — it is somebody restoring into staging
at 3 a.m. during an incident with production's URL still in their shell.

#### Managed Postgres is not exempt

Point-in-time recovery from the provider covers a different failure — the host
dying — and not this one: a bad migration, a bad deploy, or an account being
closed. Enable PITR **and** take these dumps; they are independent of the
provider and restorable somewhere else.

> **NOT YET VERIFIED.** The scripts have never been run: this machine has no
> Postgres, and no production database exists to back up. The drill is a real
> mechanism rather than a written procedure, but until it has run green once,
> "a restore has been performed" is still false. Running it is one
> `workflow_dispatch` click, and it is the step that closes F-02 properly.

---

## 11. Verifying this before trusting it

Docker was unavailable when these files were written, so the following has
**never run**. Expect to fix things.

```bash
pnpm run verify:deploy
```

Static only: interpolated variables are documented, referenced Dockerfiles
exist, no credential-shaped literal is committed, deployment keys appear in
every template.

### What has actually been verified

- **The readiness logic**, by tests that run today: unit tests drive the probes
  against a real TCP server — including a Redis that accepts the connection and
  then rejects the credentials — and integration tests take the database away
  and assert the 503 and the recovery.
- **The worker's sweeps**, through the same wiring the worker uses.
- **`output: 'standalone'`**, by running `pnpm run build`. It produces
  `apps/web/.next/standalone/apps/web/server.js`, which is the path
  `web.Dockerfile` copies and the command it runs.
- **The deployment contract**, by `pnpm run verify:deploy`.

That last build also caught a real defect in the Dockerfile: it copied
`apps/web/public`, which did not exist, and Docker fails the entire build when a
`COPY` source is missing. The directory is now kept deliberately.

### What has not

The images themselves. In the order they are most likely to break:

1. `docker build -f infra/docker/api.Dockerfile .` — the filtered pnpm install
   (`--filter "@kids/api..."`) against a hoisted workspace is the least certain
   step, along with whether `--frozen-lockfile` accepts a context carrying every
   manifest but only some source trees.
2. `docker build -f infra/docker/web.Dockerfile .` — the standalone output is
   confirmed, but tracing across pnpm's hoisted workspace symlinks into
   `@kids/ui` is not.
3. `pnpm staging:up`, then:
   - `curl localhost:8080/health` → 200
   - `curl localhost:8080/ready` → 200, `database: "ok"`, `redis: "ok"`
   - stop Redis, poll `/ready` again → **503** with `redis: "unavailable"`
   - `pnpm staging:logs` → the worker's `sweep scheduled` lines, and its
     `warn` about the audio sweep

In short: the behaviour is tested, the packaging is not.
