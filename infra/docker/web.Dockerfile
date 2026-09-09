# Runtime image for apps/web — the parent dashboard (Next.js 16, App Router).
#
# Build from the repository ROOT:
#   docker build -f infra/docker/web.Dockerfile -t kids-companion-web .
#
# ═══════════════════════════════════════════════════════════════════════════
# THIS IMAGE IS ENVIRONMENT-AGNOSTIC, AND THAT IS DELIBERATE
# ═══════════════════════════════════════════════════════════════════════════
#
# There are no build args, because the dashboard reads no `NEXT_PUBLIC_*`
# variables. Next inlines those into the client bundle at BUILD time, which
# would make the artifact environment-specific — a staging build could not be
# promoted to production, and every value so inlined is world-readable forever.
#
# The dashboard instead reads `API_BASE_URL` on the SERVER at run time
# (apps/web/src/lib/api.ts). Every fetch happens in a Server Component or a
# Server Action, so the parent's session token is attached server-side and
# never enters a browser bundle.
#
# The consequence worth stating: the exact image verified in staging is the
# image that can go to production. Nothing is baked in that would have to change.
#
# Server-side secrets arrive from the environment at run time and never appear
# in a layer.

# ---------------------------------------------------------------------------
# base
# ---------------------------------------------------------------------------
FROM node:24-alpine AS base
WORKDIR /repo
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

# ---------------------------------------------------------------------------
# manifests
# ---------------------------------------------------------------------------
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
# build
# ---------------------------------------------------------------------------
FROM manifests AS build
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts --filter "@kids/web..."

COPY tsconfig.base.json tsconfig.json ./
COPY packages/ packages/
COPY apps/web/ apps/web/

# `@kids/ui`, `@kids/types` and `@kids/validation` are `transpilePackages` in
# next.config.ts, so Next compiles their SOURCE. They still need their declaration
# output for the type check that runs as part of `next build`.
RUN pnpm exec tsc -b packages/types packages/validation

ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @kids/web run build

# ---------------------------------------------------------------------------
# runtime
# ---------------------------------------------------------------------------
FROM base AS runtime
WORKDIR /app

RUN apk add --no-cache dumb-init

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# The standalone bundle carries its own minimal node_modules, traced from what
# the app actually imports. `static` and `public` are not included in it and are
# copied separately — a documented quirk of the standalone output, and the usual
# cause of a deployment that renders unstyled.
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static     ./apps/web/.next/static
COPY --from=build --chown=node:node /repo/apps/web/public           ./apps/web/public

USER node

EXPOSE 3000

# Liveness only, and deliberately a static route: the dashboard's own health
# must not depend on the API being up, or an API blip would restart every web
# container as well.
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "apps/web/server.js"]
