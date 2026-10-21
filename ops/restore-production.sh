#!/usr/bin/env bash
#
# Disaster recovery, from the host, in one command.
#
# ---------------------------------------------------------------------------
# WHY THIS EXISTS BESIDE `ops/backup/restore.sh` RATHER THAN REPLACING IT
# ---------------------------------------------------------------------------
# `restore.sh` runs *inside* the backup container and does the careful part:
# fetch, decrypt, check the archive parses, load it, count what came back. It
# knows nothing about Docker, and it should not — it is the thing you would run
# by hand on a rebuilt machine with the volume mounted somewhere else.
#
# What it cannot do from in there is the part that matters on the day: stop the
# things that are writing to the database, create the target if it is missing,
# and put everything back afterwards. Doing those four steps from memory, at
# speed, is how a recovery turns into a second incident.
#
# ---------------------------------------------------------------------------
# THE ORDER IS THE POINT
# ---------------------------------------------------------------------------
# 1. Stop `backup` FIRST. A scheduled run firing mid-restore dumps a database
#    that is half-loaded and uploads it — and `BACKUP_KEEP` then prunes the good
#    archive to make room. That turns a recoverable outage into an unrecoverable
#    one, quietly, while every log line says success.
# 2. Stop `backend`. `pg_restore` into a database the application is writing to
#    produces constraint violations that read as a corrupt archive, and leaves
#    rows the restore did not put there.
# 3. Create the target database if it does not exist. `restore.sh` does not, and
#    the failure reads as a connection fault: "cannot reach database X".
# 4. Restore.
# 5. Start `backend`, then `backup`, in that order — a backup taken before the
#    application has confirmed it can read the restored schema is worth nothing.
#
# ---------------------------------------------------------------------------
# DEFAULTS ARE THE SAFE THING, NOT THE USEFUL THING
# ---------------------------------------------------------------------------
# With no arguments this performs a DRILL into `restore_drill`, leaving the live
# database untouched. Overwriting production needs `--production`, and then a
# typed confirmation, because there is no undo: the live database is dropped and
# replaced with an archive that is up to BACKUP_INTERVAL_SECONDS old.
#
# Run the drill monthly. A backup nobody has restored is a hypothesis, and the
# thing it is a hypothesis about is the encryption key.
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
cd "$HERE"

# Git Bash on Windows rewrites any argument that starts with `/` into a Windows
# path, so `--entrypoint /usr/local/bin/restore.sh` would reach Docker as
# `C:/Program Files/Git/usr/local/bin/restore.sh` and the container would not
# start. The single-host (Cloudflare Tunnel) deployment runs this from Git Bash.
case "$(uname -s)" in
  MINGW*|MSYS*) export MSYS_NO_PATHCONV=1 ;;
esac

# Which deployment this host is. An explicit APP_ENV_FILE wins; otherwise the
# env file that exists decides, so the same command is right on the VPS and on
# the single-host deployment (docker-compose.laptop.yml) without anybody
# remembering a flag on the day it matters.
if [ -n "${APP_ENV_FILE:-}" ]; then
  ENV_FILE="$APP_ENV_FILE"
elif [ ! -f .env.prod ] && [ -f .env.laptop ]; then
  ENV_FILE=".env.laptop"
else
  ENV_FILE=".env.prod"
fi

COMPOSE=(docker compose --env-file "$ENV_FILE"
         -f docker-compose.yml -f docker-compose.prod.yml)
# The laptop overlay carries cloudflared and the resource ceilings. Without it
# compose would see Caddy as a service again and the stack as a different
# configuration from the one running.
if [ "$(basename "$ENV_FILE")" = ".env.laptop" ]; then
  COMPOSE+=(-f docker-compose.laptop.yml)
fi

TARGET="restore_drill"
MODE="drill"
ARCHIVE=""

log() { printf '%s  %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
die() { log "FATAL: $*"; exit 1; }

usage() {
  cat >&2 <<'EOF'
usage: ops/restore-production.sh [--production] [--archive NAME] [--list]

  (no arguments)   drill: restore into `restore_drill`, live database untouched
  --production     restore into the LIVE database. Destructive. Asks first.
  --archive NAME   restore this archive; default is the newest on the remote
  --list           show what the remote holds and exit

The drill is what you should be running on a schedule. --production is for the
day something has actually gone wrong.
EOF
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --production) MODE="production" ;;
    --archive) shift; [ $# -gt 0 ] || usage; ARCHIVE="$1" ;;
    --list)
      exec "${COMPOSE[@]}" run --rm \
        --entrypoint /usr/local/bin/restore.sh backup --list
      ;;
    -h|--help) usage ;;
    *) log "unknown argument: $1"; usage ;;
  esac
  shift
done

[ -f "$ENV_FILE" ] || die "$ENV_FILE not found. Run this from the deployment host."

# The live database name comes from the environment rather than being assumed,
# so a deployment that renamed it does not get a drill reported as a recovery.
LIVE_DB="$(grep -E '^POSTGRES_DB=' "$ENV_FILE" | cut -d= -f2- || true)"
LIVE_DB="${LIVE_DB:-karobakbak}"

if [ "$MODE" = "production" ]; then
  TARGET="$LIVE_DB"
  cat >&2 <<EOF

  ─────────────────────────────────────────────────────────────────
  This will DROP the live database "${TARGET}" and replace it with a
  backup. Everything written since that backup was taken is lost —
  up to BACKUP_INTERVAL_SECONDS of conversations, reports and bans.

  The drill (no arguments) does the same work into "restore_drill"
  and changes nothing. If you are not certain, run that first.
  ─────────────────────────────────────────────────────────────────

EOF
  printf 'Type the database name to continue: ' >&2
  read -r typed
  [ "$typed" = "$TARGET" ] || die "not confirmed; nothing was changed"
fi

log "mode: ${MODE}, target: ${TARGET}"

# --- 1. stop the backup job, before anything else --------------------------
log "stopping backup (so a scheduled run cannot overwrite the good archive)"
"${COMPOSE[@]}" stop backup >/dev/null 2>&1 || true

# --- 2. stop the application ------------------------------------------------
if [ "$MODE" = "production" ]; then
  log "stopping backend (nothing may write while the schema is being replaced)"
  "${COMPOSE[@]}" stop backend >/dev/null 2>&1 || true
fi

restart_services() {
  if [ "$MODE" = "production" ]; then
    log "starting backend"
    "${COMPOSE[@]}" start backend >/dev/null 2>&1 || true
  fi
  log "starting backup"
  "${COMPOSE[@]}" start backup >/dev/null 2>&1 || true
}
# Whatever happens below, the stack comes back. A failed restore that also
# leaves the site down is two outages.
trap restart_services EXIT

# --- 3. make sure the target exists ----------------------------------------
if [ "$MODE" = "production" ]; then
  log "dropping and recreating ${TARGET}"
  "${COMPOSE[@]}" exec -T postgres psql -U "${POSTGRES_USER:-karobakbak}" -d postgres \
    -c "drop database if exists \"${TARGET}\";" \
    -c "create database \"${TARGET}\";" >/dev/null \
    || die "could not recreate ${TARGET}"
else
  log "recreating ${TARGET} so the drill starts from empty"
  "${COMPOSE[@]}" exec -T postgres psql -U "${POSTGRES_USER:-karobakbak}" -d postgres \
    -c "drop database if exists \"${TARGET}\";" \
    -c "create database \"${TARGET}\";" >/dev/null \
    || die "could not recreate ${TARGET}"
fi

# --- 4. restore -------------------------------------------------------------
args=(--database "$TARGET")
[ -n "$ARCHIVE" ] && args+=(--archive "$ARCHIVE")

log "restoring"
"${COMPOSE[@]}" run --rm --entrypoint /usr/local/bin/restore.sh backup "${args[@]}" \
  || die "restore failed. The stack is being started again; the database
       \"${TARGET}\" is in whatever state pg_restore left it. Read the log
       named above before retrying, and do not take a backup until you have."

# --- 5. and the application role, which the dump does not carry a password for
if [ "$MODE" = "production" ]; then
  cat >&2 <<'EOF'

  ─────────────────────────────────────────────────────────────────
  One thing this script deliberately does NOT do.

  `002_roles.sql` creates `karobakbak_app` with no password, because
  credentials never live in a migration. A restored database is no
  different: the role exists with its grants and cannot log in.

  If the backend now logs authentication failures, set it again --
  the value is already in DATABASE_URL:

    grep '^DATABASE_URL=' .env.prod      # .env.laptop on the single host

    docker exec -i karobakbak-live-postgres-1 \
      psql -U karobakbak -d karobakbak \
      -c "alter role karobakbak_app with login password 'THAT_VALUE';"
  ─────────────────────────────────────────────────────────────────

EOF
fi

log "done. Services are being started again."
