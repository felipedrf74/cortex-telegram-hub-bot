#!/usr/bin/env bash
# Create and verify the stopped-state production backup used by deploy.sh.
# This script is streamed to the server over SSH so the backup behavior is
# independently testable and does not depend on the currently deployed copy.
set -euo pipefail
umask 077

REMOTE_DIR="${1:?remote directory is required}"
BACKUP_DIR="${2:?backup directory is required}"
TARGET_VERSION="${3:?target version is required}"
PM2_BIN="${4:?PM2 binary is required}"
APP_NAMES_CSV="${5:?PM2 app names are required}"
CATALOG_REQUIRED_FROM_VERSION="4.14.217"

catalog_required_for_version() {
  local version="${1#v}"
  local major minor patch
  version="${version%%-*}"
  version="${version%%+*}"
  if [[ ! "$version" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
    # Unknown versions fail closed: a backup may omit catalog only when it is
    # positively identified as predating the catalog-bearing release.
    return 0
  fi
  major="${BASH_REMATCH[1]}"
  minor="${BASH_REMATCH[2]}"
  patch="${BASH_REMATCH[3]}"
  if (( major > 4 )); then return 0; fi
  if (( major < 4 )); then return 1; fi
  if (( minor > 14 )); then return 0; fi
  if (( minor < 14 )); then return 1; fi
  (( patch >= 217 ))
}

if [[ ! "$TARGET_VERSION" =~ ^[0-9A-Za-z.+-]+$ ]]; then
  echo "invalid target version" >&2
  exit 1
fi
if [ ! -d "$REMOTE_DIR" ]; then
  echo "remote directory does not exist: $REMOTE_DIR" >&2
  exit 1
fi

required_paths=(
  "dist"
  "prompts"
  "migrations"
  "package.json"
  "package-lock.json"
  "ecosystem.config.js"
  "content-engine"
  "content-engine/main.py"
  "content-engine/config.py"
  "content-engine/requirements.txt"
  "data/bot.db"
)
for required in "${required_paths[@]}"; do
  if [ ! -e "$REMOTE_DIR/$required" ]; then
    echo "required backup path is missing: $required" >&2
    exit 1
  fi
done

NODE_BIN="${NODE_BIN:-/usr/bin/node}"
if [ ! -x "$NODE_BIN" ]; then
  NODE_BIN="$(command -v node || true)"
fi
if [ -z "$NODE_BIN" ]; then
  echo "node is required to read the archived package version" >&2
  exit 1
fi

ARCHIVED_VERSION="$($NODE_BIN -e '
  const fs = require("fs");
  const parsed = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (typeof parsed.version !== "string" || parsed.version.length === 0) process.exit(1);
  process.stdout.write(parsed.version);
' "$REMOTE_DIR/package.json")"

if [ ! -x "$PM2_BIN" ]; then
  echo "PM2 binary is unavailable: $PM2_BIN" >&2
  exit 1
fi
if [[ ! "$APP_NAMES_CSV" =~ ^[A-Za-z0-9_-]+(,[A-Za-z0-9_-]+)*$ ]]; then
  echo "invalid PM2 app names" >&2
  exit 1
fi

# Independently prove the known database-owning services remain stopped. The
# deploy stop command is also strict, but the backup must defend its own trust
# boundary immediately before checkpointing and archiving.
"$PM2_BIN" jlist | "$NODE_BIN" -e '
  const fs = require("fs");
  const required = process.argv[1].split(",");
  const processes = JSON.parse(fs.readFileSync(0, "utf8"));
  for (const name of required) {
    const processEntry = processes.find(entry => entry?.name === name);
    if (!processEntry) continue;
    if (processEntry.pm2_env?.status !== "stopped" || Number(processEntry.pid || 0) !== 0) {
      throw new Error(`PM2 process is not proved stopped: ${name}`);
    }
  }
' "$APP_NAMES_CSV"

if ! command -v fuser >/dev/null 2>&1; then
  echo "fuser is required for independent database handle proof" >&2
  exit 1
fi

assert_no_database_handles() {
  local path
  for path in "$REMOTE_DIR/data/bot.db" "$REMOTE_DIR/data/bot.db-wal" "$REMOTE_DIR/data/bot.db-shm"; do
    if [ -e "$path" ] && fuser -s -- "$path"; then
      echo "database file still has an open handle: ${path#$REMOTE_DIR/}" >&2
      exit 1
    fi
  done
}

database_fingerprint() {
  local path output=""
  for path in "$REMOTE_DIR/data/bot.db" "$REMOTE_DIR/data/bot.db-wal" "$REMOTE_DIR/data/bot.db-shm"; do
    if [ -e "$path" ]; then
      if stat -c '%n:%i:%s:%Y' "$path" >/dev/null 2>&1; then
        output="$output$(stat -c '%n:%i:%s:%Y' "$path")|"
      else
        output="$output$(stat -f '%N:%i:%z:%m' "$path")|"
      fi
    else
      output="$output${path}:absent|"
    fi
  done
  printf '%s' "$output"
}

assert_no_database_handles
NODE_PATH="$REMOTE_DIR/node_modules${NODE_PATH:+:$NODE_PATH}" "$NODE_BIN" - "$REMOTE_DIR/data/bot.db" <<'NODE'
const Database = require('better-sqlite3');
const db = new Database(process.argv[2], { fileMustExist: true });
try {
  const journalMode = String(db.pragma('journal_mode', { simple: true })).toLowerCase();
  if (journalMode === 'wal') {
    const checkpoint = db.pragma('wal_checkpoint(TRUNCATE)');
    const row = checkpoint[0] || {};
    if (Number(row.busy || 0) !== 0 || Number(row.log || 0) !== 0 || Number(row.checkpointed || 0) !== 0) {
      throw new Error('database WAL checkpoint did not reach a quiescent state');
    }
  }
} finally {
  db.close();
}
NODE
assert_no_database_handles
if [ -s "$REMOTE_DIR/data/bot.db-wal" ]; then
  echo "database WAL is non-empty after stopped-state checkpoint" >&2
  exit 1
fi
FINGERPRINT_BEFORE="$(database_fingerprint)"
sleep 1
FINGERPRINT_AFTER="$(database_fingerprint)"
if [ "$FINGERPRINT_BEFORE" != "$FINGERPRINT_AFTER" ]; then
  echo "database files changed after stopped-state checkpoint" >&2
  exit 1
fi
assert_no_database_handles

catalog_present=false
if [ -d "$REMOTE_DIR/catalog" ]; then
  catalog_present=true
elif catalog_required_for_version "$ARCHIVED_VERSION"; then
  echo "catalog is required for archived version $ARCHIVED_VERSION" >&2
  exit 1
fi

install -d -m 700 "$BACKUP_DIR"
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
ARCHIVE="$BACKUP_DIR/v${TARGET_VERSION}_${TIMESTAMP}.tar.gz"
TMP_ARCHIVE="$ARCHIVE.tmp"
META_DIR="$(mktemp -d "$BACKUP_DIR/.backup-meta-XXXXXX")"
LISTING="$META_DIR/archive.list"

cleanup() {
  rm -f "$TMP_ARCHIVE"
  rm -rf "$META_DIR"
}
trap cleanup EXIT

cat > "$META_DIR/.nexus-backup-manifest.json" <<EOF
{"schema":"nexus.release-backup.v1","archivedVersion":"$ARCHIVED_VERSION","targetVersion":"$TARGET_VERSION","catalogPresent":$catalog_present,"catalogRequiredFromVersion":"$CATALOG_REQUIRED_FROM_VERSION"}
EOF
chmod 600 "$META_DIR/.nexus-backup-manifest.json"

includes=(
  "dist/"
  "prompts/"
  "migrations/"
  "package.json"
  "package-lock.json"
  "ecosystem.config.js"
  "content-engine/"
  "data/bot.db"
)
if [ "$catalog_present" = true ]; then
  includes+=("catalog/")
fi
database_paths=("data/bot.db")
if [ -f "$REMOTE_DIR/data/bot.db-wal" ]; then
  includes+=("data/bot.db-wal")
  database_paths+=("data/bot.db-wal")
fi
if [ -f "$REMOTE_DIR/data/bot.db-shm" ]; then
  includes+=("data/bot.db-shm")
  database_paths+=("data/bot.db-shm")
fi
[ -d "$REMOTE_DIR/data/garmin-tokens" ] && includes+=("data/garmin-tokens/")

rm -f "$TMP_ARCHIVE"
tar czf "$TMP_ARCHIVE" \
  --exclude='content-engine/.env' \
  --exclude='content-engine/.env.*' \
  --exclude='content-engine/.venv' \
  --exclude='content-engine/.venv/*' \
  --exclude='content-engine/.local' \
  --exclude='content-engine/.local/*' \
  --exclude='content-engine/logs' \
  --exclude='content-engine/logs/*' \
  --exclude='content-engine/data' \
  --exclude='content-engine/data/*' \
  --exclude='content-engine/*.db' \
  --exclude='content-engine/.git' \
  --exclude='content-engine/.git/*' \
  --exclude='content-engine/.codex' \
  --exclude='content-engine/.codex/*' \
  --exclude='content-engine/.claude' \
  --exclude='content-engine/.claude/*' \
  --exclude='*/__pycache__' \
  --exclude='*/__pycache__/*' \
  -C "$REMOTE_DIR" "${includes[@]}" \
  -C "$META_DIR" ".nexus-backup-manifest.json"
chmod 600 "$TMP_ARCHIVE"
tar tzf "$TMP_ARCHIVE" > "$LISTING"

archive_has_path() {
  local path="${1%/}"
  awk -v path="$path" '
    $0 == path || index($0, path "/") == 1 { found = 1 }
    END { exit found ? 0 : 1 }
  ' "$LISTING"
}

for required in "${required_paths[@]}"; do
  if ! archive_has_path "$required"; then
    echo "verified archive is missing required path: $required" >&2
    exit 1
  fi
done
if ! archive_has_path ".nexus-backup-manifest.json"; then
  echo "verified archive is missing its backup manifest" >&2
  exit 1
fi
if [ "$catalog_present" = true ] && ! archive_has_path "catalog"; then
  echo "verified archive is missing catalog" >&2
  exit 1
fi

# Verify the archived bytes, rather than only the live source DB. Extract the
# DB together with any WAL/SHM sidecars so SQLite sees the same snapshot that a
# restore would consume.
VERIFY_DIR="$META_DIR/verify"
mkdir -p "$VERIFY_DIR"
tar xzf "$TMP_ARCHIVE" -C "$VERIFY_DIR" "${database_paths[@]}"
NODE_PATH="$REMOTE_DIR/node_modules${NODE_PATH:+:$NODE_PATH}" "$NODE_BIN" - "$VERIFY_DIR/data/bot.db" <<'NODE'
const Database = require('better-sqlite3');
const databasePath = process.argv[2];
const db = new Database(databasePath, { readonly: true, fileMustExist: true });
try {
  const integrity = db.pragma('integrity_check');
  if (!Array.isArray(integrity) || integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') {
    throw new Error('archived database integrity_check failed');
  }
  const foreignKeys = db.pragma('foreign_key_check');
  if (!Array.isArray(foreignKeys) || foreignKeys.length !== 0) {
    throw new Error('archived database foreign_key_check failed');
  }
} finally {
  db.close();
}
NODE

mv -f "$TMP_ARCHIVE" "$ARCHIVE"
trap - EXIT
rm -rf "$META_DIR"

SIZE="$(du -h "$ARCHIVE" | cut -f1)"
echo "   Backup created ($SIZE, archived version $ARCHIVED_VERSION, catalog: $catalog_present)"
echo "NEXUS_BACKUP_FILE=$ARCHIVE"

# Retention: keep the ten most recent deploy backups.
while IFS= read -r stale_backup; do
  [ -n "$stale_backup" ] && rm -f -- "$stale_backup"
done < <(ls -1t "$BACKUP_DIR"/v*.tar.gz 2>/dev/null | tail -n +11 || true)
