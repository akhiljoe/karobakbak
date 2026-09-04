#!/bin/sh
# Get a backup back. Fetch, decrypt, restore, and count what arrived.
#
# ---------------------------------------------------------------------------
# WHY THIS EXISTS SEPARATELY FROM THE RUNBOOK
# ---------------------------------------------------------------------------
# `OPERATIONS.md` documented a restore as
#
#     cat backup.sql | docker compose exec -T postgres psql ...
#
# which restores a thing this project does not produce. `backup.sh` writes
# `karobakbak-<stamp>.dump.gpg`: PostgreSQL's custom format (`-Fc`), symmetric
# AES256 through gpg, copied to an rclone remote. A plain `psql` cannot read it
# and neither can a person under pressure at the moment they need it.
#
# The launch checklist requires that a restore has actually been *performed*,
# not that a backup ran, and the reason is that every failure mode here is
# silent: a passphrase that was never written down anywhere but this host, a
# dump of the wrong database, a remote path that was writable and turns out not
# to be readable, a `pg_restore` that reports success having restored nothing
# because it was pointed at a database that already had the tables.
#
# So this is a script rather than a paragraph, and it ends by counting rows.
#
# ---------------------------------------------------------------------------
# IT WILL NOT WRITE TO A DATABASE THAT HAS ANYTHING IN IT
# ---------------------------------------------------------------------------
# A restore is run on the worst day, from a terminal, by somebody who has
# already lost something. The dangerous outcome is not a failed restore; it is a
# restore into the live database that half-succeeds and leaves a mixture. This
# refuses to touch a target with user tables unless `--force` is passed, and
# `--force` is spelled out in the failure message rather than hinted at.
#
# The drill target is a throwaway container, which is what `--drill` builds.
set -eu

log() { printf '%s restore: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }
die() { log "FATAL: $*"; exit 1; }

BACKUP_DIR="${BACKUP_DIR:-/backups}"
BACKUP_PASSPHRASE_FILE="${BACKUP_PASSPHRASE_FILE:-/run/secrets/backup-passphrase}"
BACKUP_REMOTE="${BACKUP_REMOTE:-}"
RCLONE_CONFIG="${RCLONE_CONFIG:-/var/lib/backup/rclone/rclone.conf}"
export RCLONE_CONFIG

FORCE=0
LIST=0
ARCHIVE=""
TARGET_DB="${PGDATABASE:-karobakbak}"

usage() {
  cat >&2 <<'USAGE'
usage: restore.sh [--list] [--archive NAME] [--database NAME] [--force]

  --list            show what the remote holds, newest last, and exit
  --archive NAME    restore this file; default is the newest on the remote
  --database NAME   restore into this database (default $PGDATABASE)
  --force           allow restoring into a database that already has tables

Connection comes from the standard PG* variables, as it does for backup.sh.
USAGE
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --list) LIST=1 ;;
    --archive) shift; [ $# -gt 0 ] || usage; ARCHIVE="$1" ;;
    --database) shift; [ $# -gt 0 ] || usage; TARGET_DB="$1" ;;
    --force) FORCE=1 ;;
    -h|--help) usage ;;
    *) log "unknown argument: $1"; usage ;;
  esac
  shift
done

# The same two preflight checks backup.sh makes, and for the same reason: a
# passphrase file that is a directory produced "gpg: invalid passphrase" three
# layers from the cause, and rclone fails on a directory with an error that
# reads like a credentials problem.
if [ ! -f "$BACKUP_PASSPHRASE_FILE" ] || [ ! -s "$BACKUP_PASSPHRASE_FILE" ]; then
  die "${BACKUP_PASSPHRASE_FILE} is missing, empty, or not a file.
       This is the failure that makes a backup worthless. If the passphrase is
       genuinely lost, no part of this script can help — the dumps are AES256."
fi

# The same refusal `backup.sh` makes, and it matters more here. A CR in the
# passphrase file is invisible and becomes part of the key, so a drill that
# reads the same file passes while a real recovery — somebody re-typing the
# passphrase from a password manager onto a clean host — cannot decrypt
# anything. Checked before the archive is fetched, so the message is about the
# file rather than about gpg.
if od -c "$BACKUP_PASSPHRASE_FILE" 2>/dev/null | grep -q '\\r'; then
  die "${BACKUP_PASSPHRASE_FILE} contains a carriage return (CRLF line endings).
       That byte is part of the key, invisibly. Fix it with
         tr -d '\\r' < FILE > FILE.tmp && mv FILE.tmp FILE
       and note that archives written while the CR was present need the CR to
       decrypt — keep a copy of the file until they have aged out."
fi
if [ -n "$BACKUP_REMOTE" ] && [ -e "$RCLONE_CONFIG" ] && [ ! -f "$RCLONE_CONFIG" ]; then
  die "${RCLONE_CONFIG} exists but is not a file"
fi

if [ "$LIST" = "1" ]; then
  [ -n "$BACKUP_REMOTE" ] || die "--list needs BACKUP_REMOTE"
  log "listing ${BACKUP_REMOTE}"
  rclone lsl "$BACKUP_REMOTE" | sort -k2
  exit 0
fi

mkdir -p "$BACKUP_DIR"

# --- 1. get the archive -----------------------------------------------------
#
# Newest by name, which is safe because the stamp is ISO-8601 basic UTC and
# therefore sorts lexically. That is a property of `backup.sh`'s naming, so if
# the naming ever changes this has to change with it.
if [ -z "$ARCHIVE" ]; then
  [ -n "$BACKUP_REMOTE" ] || die "no --archive given and BACKUP_REMOTE is unset"
  ARCHIVE=$(rclone lsf "$BACKUP_REMOTE" --include 'karobakbak-*.dump.gpg' | sort | tail -n 1)
  [ -n "$ARCHIVE" ] || die "no karobakbak-*.dump.gpg found at ${BACKUP_REMOTE}"
  log "newest on the remote is ${ARCHIVE}"
fi

local_copy="${BACKUP_DIR}/${ARCHIVE}"
if [ ! -f "$local_copy" ]; then
  [ -n "$BACKUP_REMOTE" ] || die "${local_copy} not found and BACKUP_REMOTE is unset"
  log "fetching ${ARCHIVE} from ${BACKUP_REMOTE}"
  rclone copy --no-traverse "${BACKUP_REMOTE}/${ARCHIVE}" "$BACKUP_DIR" \
    || die "could not fetch ${ARCHIVE}. A remote that accepted writes is not
       proof it will serve reads — this is exactly what the drill is for."
else
  log "using local ${local_copy}"
fi

size=$(wc -c < "$local_copy" | tr -d ' ')
[ "$size" -ge 1024 ] || die "${ARCHIVE} is ${size} bytes; that is not a backup"
log "archive is ${size} bytes"

# --- 2. decrypt -------------------------------------------------------------
plain="${local_copy}.dump"
log "decrypting"
gpg --batch --yes --quiet --decrypt \
    --passphrase-file "$BACKUP_PASSPHRASE_FILE" \
    --output "$plain" "$local_copy" \
  || die "decryption failed. The passphrase in ${BACKUP_PASSPHRASE_FILE} is not
       the one this archive was written with."

# `pg_restore --list` parses the custom-format header, so it fails on anything
# that is not really a dump. Checking here means a corrupt archive is found
# before the target database has been touched rather than half way through.
pg_restore --list "$plain" > /dev/null \
  || die "decrypted, but this is not a readable pg_dump custom-format archive"
log "decrypted to a valid custom-format archive"

# --- 3. refuse a target that is not empty -----------------------------------
existing=$(psql -d "$TARGET_DB" -tAc \
  "select count(*) from information_schema.tables where table_schema = 'public'" \
  2>/dev/null || echo "unreachable")

[ "$existing" != "unreachable" ] || die "cannot reach database ${TARGET_DB} as ${PGUSER:-\$PGUSER}"

if [ "$existing" != "0" ] && [ "$FORCE" != "1" ]; then
  die "${TARGET_DB} already has ${existing} table(s) in public.
       Refusing, because a restore over a populated database is how a bad day
       becomes an unrecoverable one: pg_restore would report success having
       merged two states. Restore into a throwaway database instead, or pass
       --force if you have decided this database is to be overwritten."
fi

# --- 4. restore -------------------------------------------------------------
#
# `--no-owner --no-privileges` to match how the dump was taken: the roles on the
# machine being restored onto are not necessarily the roles that existed when it
# was written, and a restore that fails on a missing role has failed for a
# reason that has nothing to do with the data.
#
# NOT `--exit-on-error`: a restore that stops at the first complaint leaves a
# partial database and tells you about one problem. Errors are counted below and
# a non-zero count fails the run, so nothing is being hidden — the difference is
# that you learn all of it at once.
log "restoring into ${TARGET_DB}"
restore_log="${BACKUP_DIR}/restore-$(date -u +%Y%m%dT%H%M%SZ).log"
if pg_restore --no-owner --no-privileges --dbname "$TARGET_DB" "$plain" \
     > "$restore_log" 2>&1; then
  log "pg_restore completed cleanly"
else
  errors=$(grep -c "^pg_restore: error" "$restore_log" || true)
  log "pg_restore reported ${errors} error(s); see ${restore_log}"
  [ "$errors" = "0" ] || die "restore failed with ${errors} error(s)"
fi

# --- 5. count what arrived --------------------------------------------------
#
# The step that makes this a drill rather than a command that exited zero. A
# restore can succeed structurally and bring back nothing — an empty dump, the
# wrong database, a schema restored without data. Row counts are the only
# statement worth making afterwards.
log "counting what came back:"
psql -d "$TARGET_DB" -P pager=off -c "
  select relname as table_name, n_live_tup as approx_rows
    from pg_stat_user_tables
   order by n_live_tup desc, relname
   limit 20;" >&2

total=$(psql -d "$TARGET_DB" -tAc "select coalesce(sum(n_live_tup), 0) from pg_stat_user_tables")
tables=$(psql -d "$TARGET_DB" -tAc \
  "select count(*) from information_schema.tables where table_schema = 'public'")

log "restored ${tables} table(s), approximately ${total} row(s)"

if [ "$tables" = "0" ]; then
  die "the restore produced no tables. It exited cleanly and achieved nothing,
       which is the failure this count exists to catch."
fi

rm -f "$plain"
log "done. The plaintext dump has been removed; ${local_copy} is still encrypted."
