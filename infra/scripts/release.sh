#!/usr/bin/env bash
#
# Hands the built images to whatever runs them.
#
# ═══════════════════════════════════════════════════════════════════════════
# THIS IS THE ONE STEP THAT IS NOT WRITTEN YET, AND IT SAYS SO
# ═══════════════════════════════════════════════════════════════════════════
#
# There is no hosting account, no cluster, and no orchestrator for this project
# yet. Rather than invent one, this script refuses to run until a target is
# configured, and explains what to configure.
#
# The alternative — a step that logs "deployed!" and exits 0 — would make every
# deployment workflow green while nothing shipped. A pipeline that reports
# success for work it did not do is worse than no pipeline, because people stop
# checking.
#
# TO MAKE THIS REAL: set the environment variable named below on the matching
# GitHub Environment, and replace the `case` body with the command that actually
# rolls the images out. Everything around it — build, digest pinning, migration
# ordering, approval, verification, rollback — is already in place.
#
# Never echo a secret. The images and the target are not secrets; the database
# URL and provider keys reaching the running service are, and they are passed by
# the platform, not printed here.

set -euo pipefail

ENVIRONMENT="${1:?usage: release.sh <development|staging|production>}"

: "${API_IMAGE:?API_IMAGE is not set — the build job should have provided it}"
: "${WEB_IMAGE:?WEB_IMAGE is not set — the build job should have provided it}"

echo "Environment : ${ENVIRONMENT}"
echo "API image   : ${API_IMAGE}"
echo "Web image   : ${WEB_IMAGE}"

if [ -z "${DEPLOY_TARGET:-}" ]; then
  cat >&2 <<EOF

═══════════════════════════════════════════════════════════════════════════
NO DEPLOYMENT TARGET IS CONFIGURED FOR "${ENVIRONMENT}".
═══════════════════════════════════════════════════════════════════════════

The images above were built and pushed successfully. Nothing was released,
because there is nowhere to release to yet.

To finish this:

  1. Create the hosting target (cluster, host, or platform app).
  2. Set the repository variable for this environment:
       ${ENVIRONMENT^^}_DEPLOY_TARGET
  3. Replace the placeholder in infra/scripts/release.sh with the command
     that rolls out \$API_IMAGE and \$WEB_IMAGE.

This step fails on purpose. A deployment workflow that reported success
without deploying would be worse than one that does not exist.

EOF
  exit 1
fi

# ---------------------------------------------------------------------------
# Replace this with the real rollout.
# ---------------------------------------------------------------------------
case "${ENVIRONMENT}" in
  development | staging | production)
    echo "Releasing to ${DEPLOY_TARGET}..."
    echo >&2 "release.sh: DEPLOY_TARGET is set but no rollout command is implemented."
    echo >&2 "Implement it here before relying on this workflow."
    exit 1
    ;;
  *)
    echo >&2 "Unknown environment: ${ENVIRONMENT}"
    exit 2
    ;;
esac
