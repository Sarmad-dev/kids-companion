#!/usr/bin/env bash
#
# Takes a verified, encrypted backup of the database.
#
# ═══════════════════════════════════════════════════════════════════════════
# WHAT A DUMP OF THIS DATABASE IS
# ═══════════════════════════════════════════════════════════════════════════
#
# Every conversation every child has had, their names, their ages, their voice
# practice, and their parents' contact details. Message content sits in
# `content_ciphertext`, but the codec is still `placeholder` (DEPLOYMENT.md
# §9.3), so treat the dump as plaintext.
#
# It is therefore the single most sensitive artefact this system produces, and
# it is produced on a schedule, unattended, and copied somewhere else. This
# script refuses to do that unencrypted.
#
# Usage:
#   BACKUP_ENCRYPT_CMD="age -r age1..." infra/scripts/backup.sh
#
# Required:
#   DATABASE_URL          what to dump
#   BACKUP_DIR            where to write it locally
#   BACKUP_ENCRYPT_CMD    a command reading plaintext on stdin, writing ciphertext
#                         to stdout. Refused if unset — see above.
#
# Optional:
#   BACKUP_RETAIN_DAYS    local copies to keep (default 7)
#
set -euo pipefail

fail() { printf '\n  %s\n\n' "$1" >&2; exit 1; }

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${BACKUP_DIR:?BACKUP_DIR is required}"
RETAIN_DAYS="${BACKUP_RETAIN_DAYS:-7}"

# ─────────────────────────────────────────────────────────────────────────────
# Encryption is not optional
# ─────────────────────────────────────────────────────────────────────────────
# Deliberately a hard failure rather than a warning. A warning in an unattended
# nightly job is read by nobody, and the result would be a directory of
# children's conversations in plaintext, retained for a week, on a host chosen
# for having disk space.
if [[ -z "${BACKUP_ENCRYPT_CMD:-}" ]]; then
  fail "BACKUP_ENCRYPT_CMD is required. A dump of this database is every child's
  conversations; it is never written unencrypted. Set it to a command that reads
  plaintext on stdin and writes ciphertext on stdout, e.g.
    BACKUP_ENCRYPT_CMD='age -r age1yourpublickey'
  Server-side encryption at the destination is not a substitute: the file exists
  on this disk first."
fi

command -v pg_dump >/dev/null || fail "pg_dump is not installed."

mkdir -p "$BACKUP_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
PLAIN="${BACKUP_DIR}/kids-companion-${STAMP}.sql"
ENCRYPTED="${PLAIN}.enc"

cleanup() {
  # The plaintext dump must not survive this script under any exit path,
  # including a failure part-way through encryption.
  [[ -f "$PLAIN" ]] && rm -f "$PLAIN"
}
trap cleanup EXIT

printf '\n  Dumping...\n'

# --no-owner / --no-privileges: a restore into a scratch database must not
#   depend on the production role names existing there.
# --clean --if-exists: the restore is idempotent against a non-empty target.
# Plain SQL rather than the custom format on purpose — it can be inspected,
#   grepped, and verified without pg_restore, which is what makes the
#   verification step below possible at all.
pg_dump "$DATABASE_URL" \
  --no-owner \
  --no-privileges \
  --clean \
  --if-exists \
  --quote-all-identifiers \
  --file "$PLAIN"

# ─────────────────────────────────────────────────────────────────────────────
# Verify BEFORE encrypting
# ─────────────────────────────────────────────────────────────────────────────
# Once encrypted the file cannot be inspected without the key, and a nightly job
# that encrypts a truncated dump has produced something worse than nothing: an
# artefact that looks like a backup and is not one.
printf '  Verifying...\n'
node "$(dirname "$0")/verify-backup.mjs" "$PLAIN" \
  || fail "The dump did not verify. NOTHING HAS BEEN KEPT. Investigate before the
  next scheduled run — a backup that fails loudly is the good case."

printf '  Encrypting...\n'
# shellcheck disable=SC2086
if ! ${BACKUP_ENCRYPT_CMD} < "$PLAIN" > "$ENCRYPTED"; then
  rm -f "$ENCRYPTED"
  fail "Encryption failed. Nothing has been kept."
fi

[[ -s "$ENCRYPTED" ]] || { rm -f "$ENCRYPTED"; fail "Encryption produced an empty file."; }

chmod 600 "$ENCRYPTED"

# Local pruning only. The remote copy's lifecycle belongs to the object store,
# where it can outlive this host.
find "$BACKUP_DIR" -name 'kids-companion-*.sql.enc' -mtime "+${RETAIN_DAYS}" -delete

printf '\n  %s\n  %s bytes\n\n' "$ENCRYPTED" "$(wc -c < "$ENCRYPTED" | tr -d ' ')"
printf '  Verified structurally complete and encrypted.\n'
printf '  It is NOT yet proven restorable — only a restore drill proves that.\n'
printf '  See DEPLOYMENT.md §10.3.\n\n'
