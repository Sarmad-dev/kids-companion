#!/usr/bin/env bash
#
# Confirms a released environment is actually serving, after the rollout.
#
# ═══════════════════════════════════════════════════════════════════════════
# WHY BOTH PROBES, AND WHY READINESS IS THE ONE THAT MATTERS HERE
# ═══════════════════════════════════════════════════════════════════════════
#
# `/health` proves the process started. It touches nothing, so it would answer
# 200 with the database on fire — which is correct for liveness and useless as
# a deployment gate on its own.
#
# `/ready` is the gate. It probes the database and Redis, so a deploy that
# started but cannot reach its dependencies fails here rather than being
# discovered by a parent. A green deploy whose readiness is 503 is a rollback,
# not a success.
#
# Never prints a response body: an error body can carry more than a status, and
# this output is a public build log.

set -euo pipefail

BASE_URL="${BASE_URL:?BASE_URL is not set — point it at the environment just released}"
ATTEMPTS="${ATTEMPTS:-30}"
INTERVAL="${INTERVAL:-5}"

echo "Verifying ${BASE_URL}"

# ---------------------------------------------------------------------------
# Liveness — is anything there at all?
# ---------------------------------------------------------------------------
for attempt in $(seq 1 "${ATTEMPTS}"); do
  status=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "${BASE_URL}/health" || echo "000")
  if [ "${status}" = "200" ]; then
    echo "liveness  : 200 (after ${attempt} attempt(s))"
    break
  fi
  if [ "${attempt}" -eq "${ATTEMPTS}" ]; then
    echo >&2 "::error::/health never returned 200 (last status ${status})."
    exit 1
  fi
  sleep "${INTERVAL}"
done

# ---------------------------------------------------------------------------
# Readiness — can it serve?
# ---------------------------------------------------------------------------
for attempt in $(seq 1 "${ATTEMPTS}"); do
  status=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "${BASE_URL}/ready" || echo "000")
  if [ "${status}" = "200" ]; then
    echo "readiness : 200 (after ${attempt} attempt(s))"
    echo
    echo "Deployment verified."
    exit 0
  fi
  if [ "${attempt}" -eq "${ATTEMPTS}" ]; then
    echo >&2 "::error::/ready never returned 200 (last status ${status})."
    echo >&2 "The process is running but cannot reach a dependency it needs."
    echo >&2 "Roll back: see CI_CD.md §8."
    exit 1
  fi
  sleep "${INTERVAL}"
done
