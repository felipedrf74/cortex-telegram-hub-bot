#!/usr/bin/env bash
# Create and verify the stopped-state production backup used by exact promotion.
# This script is streamed to the server over SSH so the backup behavior is
# independently testable and does not depend on the currently deployed copy.
set -euo pipefail
umask 077

REMOTE_DIR="${1:?remote directory is required}"
BACKUP_DIR="${2:?backup directory is required}"
TARGET_VERSION="${3:?target version is required}"
PM2_BIN="${4:?PM2 binary is required}"
APP_NAMES_CSV="${5:?PM2 app names are required}"
PREPARED_RUNTIME_DIR="${6:-}"
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

if [ -n "$PREPARED_RUNTIME_DIR" ]; then
  case "$PREPARED_RUNTIME_DIR" in
    "$BACKUP_DIR"/.runtime-stage-*) ;;
    *) echo "unsafe prepared runtime directory" >&2; exit 1 ;;
  esac
  [ -f "$PREPARED_RUNTIME_DIR/.nexus-runtime-prestage.json" ] || {
    echo "prepared runtime manifest is missing" >&2
    exit 1
  }
  cleanup_prepared_failure() {
    local exit_code=$?
    trap - EXIT
    if [ "$exit_code" -ne 0 ]; then rm -rf "$PREPARED_RUNTIME_DIR"; fi
    exit "$exit_code"
  }
  trap cleanup_prepared_failure EXIT
  # Revalidate the live source after writes drain. The prepared runtime is
  # accepted only if every copied byte still matches the stopped source.
  "$NODE_BIN" - "$REMOTE_DIR" "$PREPARED_RUNTIME_DIR" <<'NODE'
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const [sourceRoot, preparedRoot] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(path.join(preparedRoot, '.nexus-runtime-prestage.json'), 'utf8'));
if (manifest.schema !== 'nexus.runtime-backup-prestage.v1' || !Array.isArray(manifest.files)) {
  throw new Error('prepared runtime manifest schema is invalid');
}
for (const entry of manifest.files) {
  const sourceBody = fs.readFileSync(path.join(sourceRoot, entry.path));
  const preparedBody = fs.readFileSync(path.join(preparedRoot, entry.path));
  const digest = (body) => crypto.createHash('sha256').update(body).digest('hex');
  if (sourceBody.length !== entry.size || preparedBody.length !== entry.size
      || digest(sourceBody) !== entry.sha256 || digest(preparedBody) !== entry.sha256) {
    throw new Error(`prepared runtime drift: ${entry.path}`);
  }
}
NODE
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
    # procps fuser (used on production) does not accept the generic `--`
    # separator; the path is already an absolute value controlled by this
    # script, so pass it directly.
    if [ -e "$path" ] && fuser -s "$path"; then
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
DATABASE_SHA256="$(sha256sum "$REMOTE_DIR/data/bot.db" | awk '{print $1}')"
[[ "$DATABASE_SHA256" =~ ^[a-f0-9]{64}$ ]] || { echo "database SHA-256 is invalid" >&2; exit 1; }

catalog_present=false
if [ -d "$REMOTE_DIR/catalog" ]; then
  catalog_present=true
elif catalog_required_for_version "$ARCHIVED_VERSION"; then
  echo "catalog is required for archived version $ARCHIVED_VERSION" >&2
  exit 1
fi

install -d -m 700 "$BACKUP_DIR"
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
# Name the archive for the runtime it actually contains.  The release being
# installed is a separate part of the identity: this backup is the archived
# version taken immediately before that target.  Older archives named only for
# TARGET_VERSION remain readable by rollback.sh through their package/manifest
# metadata.
ARCHIVE="$BACKUP_DIR/v${ARCHIVED_VERSION}_before-v${TARGET_VERSION}_${TIMESTAMP}.tar.gz"
TMP_ARCHIVE="$ARCHIVE.tmp"
META_DIR="$(mktemp -d "$BACKUP_DIR/.backup-meta-XXXXXX")"
LISTING="$META_DIR/archive.list"

cleanup() {
  rm -f "$TMP_ARCHIVE"
  rm -rf "$META_DIR"
  [ -z "$PREPARED_RUNTIME_DIR" ] || rm -rf "$PREPARED_RUNTIME_DIR"
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
if [ -n "$PREPARED_RUNTIME_DIR" ]; then
  install -d -m 700 "$PREPARED_RUNTIME_DIR/data"
  for database_path in "${database_paths[@]}"; do
    cp -p "$REMOTE_DIR/$database_path" "$PREPARED_RUNTIME_DIR/$database_path"
  done
  if [ -d "$REMOTE_DIR/data/garmin-tokens" ]; then
    cp -a "$REMOTE_DIR/data/garmin-tokens" "$PREPARED_RUNTIME_DIR/data/garmin-tokens"
  fi
  cp -p "$META_DIR/.nexus-backup-manifest.json" "$PREPARED_RUNTIME_DIR/.nexus-backup-manifest.json"
  tar czf "$TMP_ARCHIVE" -C "$PREPARED_RUNTIME_DIR" "${includes[@]}" ".nexus-backup-manifest.json"
else
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
fi
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
ARCHIVED_DATABASE_SHA256="$(sha256sum "$VERIFY_DIR/data/bot.db" | awk '{print $1}')"
[ "$ARCHIVED_DATABASE_SHA256" = "$DATABASE_SHA256" ] || {
  echo "archived database digest does not match the stopped source" >&2
  exit 1
}

mv -f "$TMP_ARCHIVE" "$ARCHIVE"
trap - EXIT
rm -rf "$META_DIR"
[ -z "$PREPARED_RUNTIME_DIR" ] || rm -rf "$PREPARED_RUNTIME_DIR"

SIZE="$(du -h "$ARCHIVE" | cut -f1)"
if stat -c '%s' "$ARCHIVE" >/dev/null 2>&1; then
  SIZE_BYTES="$(stat -c '%s' "$ARCHIVE")"
else
  SIZE_BYTES="$(stat -f '%z' "$ARCHIVE")"
fi
ARCHIVE_SHA256="$(sha256sum "$ARCHIVE" | awk '{print $1}')"
BACKUP_CREATED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
[[ "$SIZE_BYTES" =~ ^[1-9][0-9]*$ ]] || { echo "backup byte size is invalid" >&2; exit 1; }
[[ "$ARCHIVE_SHA256" =~ ^[a-f0-9]{64}$ ]] || { echo "backup SHA-256 is invalid" >&2; exit 1; }
echo "   Backup created ($SIZE, archived version $ARCHIVED_VERSION, catalog: $catalog_present)"
echo "NEXUS_BACKUP_FILE=$ARCHIVE"
echo "NEXUS_BACKUP_SHA256=$ARCHIVE_SHA256"
echo "NEXUS_BACKUP_SIZE_BYTES=$SIZE_BYTES"
echo "NEXUS_BACKUP_ARCHIVED_VERSION=$ARCHIVED_VERSION"
echo "NEXUS_BACKUP_TARGET_VERSION=$TARGET_VERSION"
echo "NEXUS_BACKUP_CREATED_AT=$BACKUP_CREATED_AT"
echo "NEXUS_BACKUP_DATABASE_SHA256=$DATABASE_SHA256"

# Local retention is intentionally not performed here. Promotion first proves
# encrypted off-host escrow of this exact digest; only that root-owned control
# boundary may prune older local rollback bundles.
