# Runtime image for apps/api — serves the HTTP API, and (with a different
# command) runs the background worker and the migration job.
#
# Build from the repository ROOT, not from this directory:
#   docker build -f infra/docker/api.Dockerfile -t kids-companion-api .
#
# ═══════════════════════════════════════════════════════════════════════════
# ONE IMAGE, THREE ENTRY POINTS
# ═══════════════════════════════════════════════════════════════════════════
#
# The API, the worker and the migration job ship as the SAME image with
# different commands:
#
#   node apps/api/dist/server.js          the API          (default)
#   node apps/api/dist/worker.js          the sweeps
#   node infra/scripts/migrate.mjs        schema migration
#
# One artifact means the schema, the code that reads it, and the code that
# sweeps it are provably the same build. Three images built from three
# pipelines can disagree, and the way you find out is a migration applied by a
# version that no longer matches the API deployed beside it.
#
# ═══════════════════════════════════════════════════════════════════════════
# SECRETS
# ═══════════════════════════════════════════════════════════════════════════
#
# Nothing secret is COPYed, ARGed or ENVed here. `.dockerignore` excludes
# `.env` and `.env.*`, and every credential arrives at RUN time from the
# environment. An ARG would be worse than useless — build args are readable in
# the image history forever, so a secret passed that way is published, not
# hidden.

# ---------------------------------------------------------------------------
# base — pinned toolchain, shared by every later stage
# ---------------------------------------------------------------------------
FROM node:24-alpine AS base
WORKDIR /repo
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

# ---------------------------------------------------------------------------
# manifests — every workspace package.json, and nothing else
# ---------------------------------------------------------------------------
# Copied as its own layer so `pnpm install` is only re-run when a dependency
# actually changes. Editing a .ts file must not re-install node_modules.
#
# EVERY manifest is copied, including apps/web, apps/mobile and tests, because
# `--frozen-lockfile` validates the lockfile against the whole workspace and a
# missing member is a mismatch. The `--filter` below is what keeps the install
# narrow; the manifests are only needed to describe the graph.
FROM base AS manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json          apps/api/
COPY apps/web/package.json          apps/web/
COPY apps/mobile/package.json       apps/mobile/
COPY packages/config/package.json     packages/config/
COPY packages/db/package.json         packages/db/
COPY packages/shared/package.json     packages/shared/
COPY packages/types/package.json      packages/types/
COPY packages/ui/package.json         packages/ui/
COPY packages/validation/package.json packages/validation/
COPY services/ai/package.json        services/ai/
COPY services/analytics/package.json services/analytics/
COPY services/auth/package.json      services/auth/
COPY services/learning/package.json  services/learning/
COPY services/payments/package.json  services/payments/
COPY services/practice/package.json  services/practice/
COPY services/safety/package.json    services/safety/
COPY services/voice/package.json     services/voice/
COPY tests/package.json              tests/

# ---------------------------------------------------------------------------
# deps — dev + prod, for the compiler
# ---------------------------------------------------------------------------
# `@kids/api...` is pnpm's "this package and everything it depends on", so
# Expo and Next are never downloaded for an API image.
#
# `--ignore-scripts`: no third-party postinstall executes during an image
# build. That is the main supply-chain vector and there is no reason to accept
# it here — nothing in the API's dependency closure needs a native build.
FROM manifests AS deps
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts --filter "@kids/api..."

# ---------------------------------------------------------------------------
# build — compile the TypeScript solution
# ---------------------------------------------------------------------------
FROM deps AS build
COPY tsconfig.base.json tsconfig.json ./
COPY packages/ packages/
COPY services/ services/
COPY apps/api/ apps/api/

# `tsc -b` walks the project references, so this builds every workspace package
# the API imports, in dependency order, and fails on the first type error.
RUN pnpm exec tsc -b

# ---------------------------------------------------------------------------
# prod-deps — the runtime dependency closure, installed cleanly
# ---------------------------------------------------------------------------
# A separate install rather than `pnpm prune --prod` on the build stage: prune
# mutates a tree that has already had dev packages hoisted into it, and what
# survives is harder to reason about than a tree that never had them.
FROM manifests AS prod-deps
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts --prod --filter "@kids/api..."

# ---------------------------------------------------------------------------
# runtime — no compiler, no test runner, no source
# ---------------------------------------------------------------------------
FROM base AS runtime
WORKDIR /repo

# dumb-init is PID 1: it reaps zombies and forwards SIGTERM, without which
# `close-with-grace` never runs and a deploy cuts off a child mid-sentence.
RUN apk add --no-cache dumb-init

ENV NODE_ENV=production
# Node sees the container's memory limit rather than the host's, so a cgroup
# limit actually bounds the heap instead of being discovered by the OOM killer.
ENV NODE_OPTIONS=--max-old-space-size=384

# Runtime dependencies, then compiled output. Ownership is set on copy so no
# recursive chown of node_modules is needed.
COPY --from=prod-deps --chown=node:node /repo/node_modules ./node_modules
COPY --from=prod-deps --chown=node:node /repo/package.json ./

# Only `dist` and each manifest — never the .ts sources. Shipping source into a
# runtime image gives an attacker who lands a shell the comments explaining how
# every control works.
COPY --from=build --chown=node:node /repo/packages/config/dist      ./packages/config/dist
COPY --from=build --chown=node:node /repo/packages/config/package.json      ./packages/config/
COPY --from=build --chown=node:node /repo/packages/db/dist          ./packages/db/dist
COPY --from=build --chown=node:node /repo/packages/db/package.json          ./packages/db/
COPY --from=build --chown=node:node /repo/packages/shared/dist      ./packages/shared/dist
COPY --from=build --chown=node:node /repo/packages/shared/package.json      ./packages/shared/
COPY --from=build --chown=node:node /repo/packages/types/dist       ./packages/types/dist
COPY --from=build --chown=node:node /repo/packages/types/package.json       ./packages/types/
COPY --from=build --chown=node:node /repo/packages/validation/dist  ./packages/validation/dist
COPY --from=build --chown=node:node /repo/packages/validation/package.json  ./packages/validation/
COPY --from=build --chown=node:node /repo/services/ai/dist          ./services/ai/dist
COPY --from=build --chown=node:node /repo/services/ai/package.json          ./services/ai/
COPY --from=build --chown=node:node /repo/services/analytics/dist   ./services/analytics/dist
COPY --from=build --chown=node:node /repo/services/analytics/package.json   ./services/analytics/
COPY --from=build --chown=node:node /repo/services/auth/dist        ./services/auth/dist
COPY --from=build --chown=node:node /repo/services/auth/package.json        ./services/auth/
COPY --from=build --chown=node:node /repo/services/learning/dist    ./services/learning/dist
COPY --from=build --chown=node:node /repo/services/learning/package.json    ./services/learning/
COPY --from=build --chown=node:node /repo/services/payments/dist    ./services/payments/dist
COPY --from=build --chown=node:node /repo/services/payments/package.json    ./services/payments/
COPY --from=build --chown=node:node /repo/services/practice/dist    ./services/practice/dist
COPY --from=build --chown=node:node /repo/services/practice/package.json    ./services/practice/
COPY --from=build --chown=node:node /repo/services/safety/dist      ./services/safety/dist
COPY --from=build --chown=node:node /repo/services/safety/package.json      ./services/safety/
COPY --from=build --chown=node:node /repo/services/voice/dist       ./services/voice/dist
COPY --from=build --chown=node:node /repo/services/voice/package.json       ./services/voice/
COPY --from=build --chown=node:node /repo/apps/api/dist             ./apps/api/dist
COPY --from=build --chown=node:node /repo/apps/api/package.json     ./apps/api/

# The migration job runs from this image, so it needs the runner and the SQL.
# Migrations are DATA, not code: they are read at run time and are identical in
# every environment, which is what makes "the same migrations CI verified" true.
COPY --chown=node:node infra/scripts/migrate.mjs ./infra/scripts/
COPY --chown=node:node infra/migrations/         ./infra/migrations/

USER node

EXPOSE 8080

# LIVENESS ONLY — never `/ready`.
#
# Docker restarts a container whose healthcheck fails. Pointing that at a probe
# which touches the database means a slow query restarts every healthy
# container, turning a degraded dependency into an outage. Readiness belongs to
# whatever decides where to send traffic, and it is a different question.
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "apps/api/dist/server.js"]
