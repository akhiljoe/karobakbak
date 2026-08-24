#!/bin/sh
# Take a backup, encrypt it, prune old ones, and say so.
#
# ---------------------------------------------------------------------------
# WHY THIS IS A LOOP AND NOT CRON
# ---------------------------------------------------------------------------
# One less moving part. cron in a container needs a daemon, its own logging
# path, and its own failure mode where the daemon is alive and the job is not.
# A shell loop puts every failure on this container's stdout, where `docker
# compose logs backup` finds it, and makes the restart policy the supervisor.
#
# The cost is that the schedule drifts by however long a run takes. For a
# nightly database dump that does not matter.
#
# ---------------------------------------------------------------------------
# ENCRYPTED, BECAUSE A DUMP IS EVERY CONVERSATION
# ---------------------------------------------------------------------------
# `DESIGN.md` §8.1 requires it, and the reason is worth restating: message
# bodies are plaintext inside the trusted boundary, so a dump is the whole
# retained corpus in one file. That file then travels — to object storage, to a
# laptop during a restore drill — which is exactly the boundary I8 says text
# must not cross unprotected.
#
# Symmetric GPG with a passphrase from a file. The passphrase is never an
# argument, because arguments are visible in `ps`.
#
# ---------------------------------------------------------------------------
# THE THING THAT WILL BITE YOU
# ---------------------------------------------------------------------------
# An encrypted backup you cannot decrypt is not a backup. Store the passphrase
# somewhere that survives losing this host — a password manager, not this
# machine, and not only this machine. Restoring is `docs/OPERATIONS.md` §7c;
# do it once before you need it.

set -eu

: "${PGHOST:?PGHOST is required}"
: "${PGUSER:?PGUSER is required}"
: "${PGDATABASE:?PGDATABASE is required}"
: "${PGPASSWORD:?PGPASSWORD is required}"

BACKUP_DIR="${BACKUP_DIR:-/backups}"
BACKUP_INTERVAL_SECONDS="${BACKUP_INTERVAL_SECONDS:-86400}"
BACKUP_KEEP="${BACKUP_KEEP:-7}"
BACKUP_PASSPHRASE_FILE="${BACKUP_PASSPHRASE_FILE:-/run/secrets/backup-passphrase}"
BACKUP_REPORT_URL="${BACKUP_REPORT_URL:-}"
BACKUP_REPORT_TOKEN_FILE="${BACKUP_REPORT_TOKEN_FILE:-}"

log() { echo "[backup] $(date -u +%Y-%m-%dT%H:%M:%SZ) $*"; }

# Tell the application what happened. Its `BackupMonitor` reports `unknown`
# until something does, and `unknown` is deliberately not `ok` — a process that
# has never been told about a backup has no evidence that any exist.
report() {
  ok="$1"
  [ -n "$BACKUP_REPORT_URL" ] || return 0
  [ -n "$BACKUP_REPORT_TOKEN_FILE" ] || return 0
  [ -r "$BACKUP_REPORT_TOKEN_FILE" ] || { log "report token unreadable; not reporting"; return 0; }

  token=$(cat "$BACKUP_REPORT_TOKEN_FILE")
  # Failure to report is logged and never fatal: a backup that was taken and
  # not announced is still a backup, and the staleness alert covers the silence.
  if curl --silent --show-error --fail --max-time 10 \
      -X POST "$BACKUP_REPORT_URL" \
      -H "authorization: Bearer ${token}" \
      -H 'content-type: application/json' \
      -d "{\"ok\":${ok}}" >/dev/null 2>&1; then
    log "reported ok=${ok}"
  else
    log "could not reach ${BACKUP_REPORT_URL} to report ok=${ok}"
  fi
}

run_once() {
  # `-f -s`, not `-r`. Docker creates a *directory* for a bind mount whose host
  # path is missing, and a directory is readable — so `-r` passed, `cat` failed
  # with "Is a directory", and gpg reported an invalid passphrase three layers
  # from the actual cause.
  if [ ! -f "$BACKUP_PASSPHRASE_FILE" ] || [ ! -s "$BACKUP_PASSPHRASE_FILE" ]; then
    log "FATAL: ${BACKUP_PASSPHRASE_FILE} is missing, empty, or not a file"
    log "       copy ops/backup/passphrase.example and put a real passphrase in it"
    return 1
  fi

  mkdir -p "$BACKUP_DIR"
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  target="${BACKUP_DIR}/karobakbak-${stamp}.dump.gpg"
  partial="${target}.partial"

  log "starting dump of ${PGDATABASE} on ${PGHOST}"

  # `-Fc` is PostgreSQL's compressed custom format, which `pg_restore` can read
  # selectively — one table, one schema — rather than replaying a whole SQL
  # file. Written to `.partial` first so an interrupted run never leaves
  # something that looks like a usable backup.
  if ! pg_dump --format=custom --no-owner --no-privileges \
      | gpg --batch --yes --symmetric --cipher-algo AES256 \
            --passphrase-file "$BACKUP_PASSPHRASE_FILE" \
            --output "$partial"; then
    log "dump or encryption failed"
    rm -f "$partial"
    return 1
  fi

  # An empty or absurdly small file means something failed quietly upstream in
  # the pipe, where `set -e` cannot see it.
  size=$(wc -c < "$partial" | tr -d ' ')
  if [ "$size" -lt 1024 ]; then
    log "refusing a ${size}-byte backup; treating as failure"
    rm -f "$partial"
    return 1
  fi

  mv "$partial" "$target"
  log "wrote ${target} (${size} bytes)"

  # Retention. Newest kept, oldest removed, and only ever files this script
  # produced — the glob is deliberately specific so nothing else in a shared
  # volume is ever a candidate for deletion.
  count=$(find "$BACKUP_DIR" -maxdepth 1 -name 'karobakbak-*.dump.gpg' | wc -l | tr -d ' ')
  if [ "$count" -gt "$BACKUP_KEEP" ]; then
    find "$BACKUP_DIR" -maxdepth 1 -name 'karobakbak-*.dump.gpg' \
      | sort | head -n "$((count - BACKUP_KEEP))" \
      | while read -r old; do
          log "pruning $(basename "$old")"
          rm -f "$old"
        done
  fi

  return 0
}

log "backup loop starting: every ${BACKUP_INTERVAL_SECONDS}s, keeping ${BACKUP_KEEP}"

while :; do
  if run_once; then
    report true
  else
    # Reported rather than swallowed, so `chat_backup_failures_total` moves and
    # "running and failing" is distinguishable from "stopped".
    report false
  fi
  sleep "$BACKUP_INTERVAL_SECONDS"
done
