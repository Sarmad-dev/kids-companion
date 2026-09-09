#!/usr/bin/env bash
#
# Restores a dump into a target database.
#
# ═══════════════════════════════════════════════════════════════════════════
# THIS IS A DATA-DESTRUCTION TOOL POINTED THE OTHER WAY
# ═══════════════════════════════════════════════════════════════════════════
#
# The dump is taken with --clean --if-exists, so running this drops every table
# in the target before recreating it. Pointed at the wrong database it does not
# fail — it succeeds, quickly, and replaces live data with a snapshot.
#
# The realistic way that happens is not carelessness. It is somebody restoring
# into staging at 3 a.m. during an incident with production's URL still in their
# shell. So the guards below are deliberately annoying, and the confirmation
# cannot be supplied by an environment variable that might already be set.
#
# Usage:
#   RESTORE_TARGET_URL=postgresql://... infra/scripts/restore.sh <dump-file>
#
# The dump must be decrypted first. This script does not hold the key.
#
set -euo pipefail

fail() { printf '\n  %s\n\n' "$1" >&2; exit 1; }

DUMP="${1:-}"
[[ -n "$DUMP" ]] || fail "usage: restore.sh <dump-file>"
[[ -f "$DUMP" ]] || fail "No such file: $DUMP"
: "${RESTORE_TARGET_URL:?RESTORE_TARGET_URL is required}"

command -v psql >/dev/null || fail "psql is not installed."

# ─────────────────────────────────────────────────────────────────────────────
# Guard 1: never the production database
# ─────────────────────────────────────────────────────────────────────────────
# A name check, not an authorisation check — anyone could rename a database
# around it. It exists to stop the mistake, not the attack, and the mistake is
# the thing that actually happens.
if [[ "$RESTORE_TARGET_URL" == *prod* ]]; then
  if [[ "${I_UNDERSTAND_THIS_OVERWRITES_PRODUCTION:-}" != "yes-restore-production" ]]; then
    fail "The target looks like production.

  Restoring over production is a decision with a person's name on it, not a
  script's. If that is genuinely what you are doing — a real recovery, agreed
  with whoever owns the incident — re-run with:

    I_UNDERSTAND_THIS_OVERWRITES_PRODUCTION=yes-restore-production

  If you are rehearsing, point RESTORE_TARGET_URL at a scratch database."
  fi
fi

# ─────────────────────────────────────────────────────────────────────────────
# Guard 2: the file is a dump of THIS schema
# ─────────────────────────────────────────────────────────────────────────────
# Restoring a truncated dump with --clean drops everything and then fails part
# way through recreating it, which is strictly worse than not having started.
printf '\n  Verifying the dump before touching the target...\n'
node "$(dirname "$0")/verify-backup.mjs" "$DUMP" \
  || fail "The dump did not verify. The target has NOT been touched.
  Restoring a truncated dump would drop every table and then fail part way
  through recreating them."

# ─────────────────────────────────────────────────────────────────────────────
# Guard 3: say what is about to happen, and wait
# ─────────────────────────────────────────────────────────────────────────────
# Host and database only. A connection string carries a password, and this text
# ends up in a terminal, a screen share, and an incident channel.
TARGET_DESC="$(printf '%s' "$RESTORE_TARGET_URL" | sed -E 's#^[^:]+://[^@]*@#>#; s#\?.*$##')"

printf '\n  About to DROP AND REPLACE every table in:\n\n    %s\n\n' "$TARGET_DESC"

if [[ -t 0 ]]; then
  read -r -p "  Type the database name to continue: " TYPED
  EXPECTED="$(printf '%s' "$RESTORE_TARGET_URL" | sed -E 's#.*/##; s#\?.*$##')"
  [[ "$TYPED" == "$EXPECTED" ]] || fail "That is not the database name. Nothing has been done."
else
  # Non-interactive is how the CI drill runs. It must be explicit rather than
  # implied by the absence of a terminal.
  [[ "${RESTORE_NON_INTERACTIVE:-}" == "yes" ]] \
    || fail "Not a terminal. Set RESTORE_NON_INTERACTIVE=yes if this is an automated drill."
fi

printf '\n  Restoring...\n'

# ON_ERROR_STOP: without it psql reports success having skipped every statement
# that failed, which is how a half-restored database gets declared recovered.
psql "$RESTORE_TARGET_URL" \
  --set ON_ERROR_STOP=on \
  --quiet \
  --file "$DUMP"

# ─────────────────────────────────────────────────────────────────────────────
# Confirm what came back
# ─────────────────────────────────────────────────────────────────────────────
# The check that matters most. A restore missing its policies starts, serves
# traffic, and has no tenant isolation — one family able to read another's
# conversations, with nothing visibly wrong.
printf '\n  Checking what actually landed...\n'

read -r TABLES POLICIES FORCED <<<"$(psql "$RESTORE_TARGET_URL" -tA -F' ' -c "
  select
    (select count(*) from pg_tables where schemaname = 'public'),
    (select count(*) from pg_policies where schemaname = 'public'),
    (select count(*) from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and c.relforcerowsecurity);
")"

printf '    %s tables · %s policies · %s tables forcing RLS\n' "$TABLES" "$POLICIES" "$FORCED"

[[ "$POLICIES" -ge 60 ]] || fail "Only ${POLICIES} RLS policies came back. This database has
  NO TENANT ISOLATION. Do not put it in front of traffic."

[[ "$FORCED" -ge "$TABLES" ]] || fail "Only ${FORCED} of ${TABLES} tables force RLS. The
  application role would bypass policies on the rest."

printf '\n  Restored, with tenant isolation intact.\n'
printf '  Row counts have NOT been checked — compare them against what you expect\n'
printf '  before treating this as a recovery. See DEPLOYMENT.md §10.3.\n\n'
