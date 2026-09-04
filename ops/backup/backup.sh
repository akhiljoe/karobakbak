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
# OFF THE HOST, OR IT IS NOT A BACKUP
# ---------------------------------------------------------------------------
# A dump sitting on a volume attached to the machine running the database
# protects against exactly one thing: somebody deleting rows. It protects
# against nothing that takes the host with it, which is most of what actually
# happens.
#
# So when `BACKUP_REMOTE` is set, each dump is copied there after it is written,
# and a copy that fails makes the whole run a failure -- the alert has to fire,
# because a local-only backup is the state this exists to leave behind.
#
# The remote is deliberately not a provider. Configure rclone once, name the
# remote here, and the destination stays a hosting decision rather than
# something baked into an image.
#
# When it is *unset*, every run says so. That is not noise: it is a launch
# blocker sitting in the log where somebody will read it, and it is quieter than
# discovering it during a restore.

# ---------------------------------------------------------------------------
# THE THING THAT WILL BITE YOU
# ---------------------------------------------------------------------------
# An encrypted backup you cannot decrypt is not a backup. Store the passphrase
# somewhere that survives losing this host — a password manager, not this
# machine, and not only this machine. Restoring is `docs/operations/OPERATIONS.md` §7c;
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
BACKUP_REMOTE="${BACKUP_REMOTE:-}"
# Set by the image, defaulted here so the script is still runnable outside it —
# `set -u` would otherwise make an unset value a crash rather than a fallback.
RCLONE_CONFIG="${RCLONE_CONFIG:-/var/lib/backup/rclone/rclone.conf}"
export RCLONE_CONFIG
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

# Refuse a secret file with a carriage return in it, and say which file.
#
# ---------------------------------------------------------------------------
# WHY THIS REFUSES RATHER THAN STRIPS
# ---------------------------------------------------------------------------
# Found by running the restore drill on 2026-09-04. A secret file created on
# Windows — `openssl rand ... > ops/backup/passphrase` in Git Bash — is written
# CRLF. `.gitattributes` forces LF across this repository, but these files are
# gitignored, so nothing normalises them.
#
# Both consequences are quiet, and the second is the dangerous one:
#
#   * The report token gains a trailing CR, which makes the Authorization
#     header malformed. The backend answers 400, `report()` logs "could not
#     reach", and it reads as a network problem. `BackupMonitor` then never
#     observes a successful backup and `BackupsStale` sits red forever.
#
#   * The passphrase gains a trailing CR, and **nothing appears to be wrong at
#     all**. Backup and restore read the same file, so the drill passes. It
#     fails on the day somebody re-types the passphrase from a password manager
#     onto a Linux host and cannot decrypt a single archive — which is the one
#     day it must not fail.
#
# Stripping it silently would be worse than refusing. For the passphrase it
# would change the key, so archives already written with the CR would stop
# decrypting with no explanation. A refusal names the file and the fix while
# there is still nothing at stake.
check_secret_file() {
  path="$1"
  what="$2"
  if od -c "$path" 2>/dev/null | grep -q '\\r'; then
    log "FATAL: ${path} contains a carriage return (CRLF line endings)"
    log "       ${what}"
    log "       Fix on the host, then restart this container:"
    log "         tr -d '\\r' < ${path} > ${path}.tmp && mv ${path}.tmp ${path}"
    log "       Created on Windows? Write it with printf and no trailing newline:"
    log "         printf %s \"\$SECRET\" > ${path}"
    return 1
  fi
  return 0
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

  check_secret_file "$BACKUP_PASSPHRASE_FILE" \
    "A CR here becomes part of the encryption key, silently. Every archive
       written with it can only be decrypted by a passphrase carrying the same
       invisible byte." || return 1

  if [ -n "$BACKUP_REPORT_TOKEN_FILE" ] && [ -f "$BACKUP_REPORT_TOKEN_FILE" ]; then
    check_secret_file "$BACKUP_REPORT_TOKEN_FILE" \
      "A CR here malforms the Authorization header, so reporting fails with a
       message that reads as a network fault and the staleness alert never
       clears." || return 1
  fi

  # Same trap as the passphrase, and worth checking before spending a minute on
  # a dump: Docker creates a *directory* for a bind mount whose host path is
  # missing, and rclone fails on a directory with an error that reads like a
  # credential problem rather than a missing file.
  if [ -n "$BACKUP_REMOTE" ] && [ -e "$RCLONE_CONFIG" ] && [ ! -f "$RCLONE_CONFIG" ]; then
    log "FATAL: ${RCLONE_CONFIG} exists but is not a file"
    log "       copy ops/backup/rclone.conf.example to ops/backup/rclone.conf"
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

  # Off the host. Fatal when it fails, unlike the inward report: a dump that was
  # taken and not announced is still a dump, but a dump that never left this
  # machine has not achieved what a backup is for.
  if [ -n "$BACKUP_REMOTE" ]; then
    log "copying to ${BACKUP_REMOTE}"
    if rclone copy --no-traverse "$target" "$BACKUP_REMOTE"; then
      log "copied $(basename "$target") to ${BACKUP_REMOTE}"
    else
      log "FAILED to copy $(basename "$target") to ${BACKUP_REMOTE}"
      log "       the local copy is kept; this run counts as a failure"
      return 1
    fi
  else
    log "WARNING: BACKUP_REMOTE is unset, so this backup exists only on this host"
    log "         a host failure loses the database and its backups together"
  fi

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

if [ -n "$BACKUP_REMOTE" ]; then
  destination="$BACKUP_REMOTE"
else
  destination="LOCAL ONLY (BACKUP_REMOTE unset)"
fi
log "backup loop starting: every ${BACKUP_INTERVAL_SECONDS}s, keeping ${BACKUP_KEEP}, to ${destination}"

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
