#!/usr/bin/env bash
# ─────────────────────────────────────────────────────
# restore.sh — Restore a Nexus Hub backup tarball.
#
# Audit QW-10. Backups are created by exact promotion into
# /home/dominguez/backups/nexushub/ and contain:
#   dist/ catalog/ prompts/ migrations/ content-engine/ package.json package-lock.json
#   ecosystem.config.js data/bot.db [data/bot.db-wal] [data/bot.db-shm]
#   [data/garmin-tokens/]
#
# This script supports two modes:
#
#   1) DRY RUN (default): extract to a temp directory, run an integrity
#      check on the SQLite DB, print row counts for the most important
#      tables, and report. Does NOT touch production. Safe to run any time.
#
#   Historical APPLY mode is retired. Production restoration is performed only
#   by the signed root-owned promotion recovery transaction.
#
# Usage:
#   ./scripts/restore.sh                              # dry-run latest backup
#   ./scripts/restore.sh /path/to/backup.tar.gz       # dry-run a specific one
#   ./scripts/restore.sh --apply <path>               # refused (retired)
#
# Designed to run BOTH on the production server (where exact promotion creates
# the backups) AND on a developer Mac (where you'd test it offline).
# Detects environment via the BACKUP_DIR + REMOTE_DIR env vars.
# ─────────────────────────────────────────────────────
set -euo pipefail
umask 077

BACKUP_DIR="${BACKUP_DIR:-/home/dominguez/backups/nexushub}"
REMOTE_DIR="${REMOTE_DIR:-/home/dominguez/telegram-hub-bot}"
CATALOG_REQUIRED_FROM_VERSION="4.14.217"

package_version() {
  local package_path="$1"
  local node_bin="${NODE_BIN:-/usr/bin/node}"
  if [ ! -x "$node_bin" ]; then
    node_bin="$(command -v node || true)"
  fi
  if [ -z "$node_bin" ]; then
    printf 'unknown'
    return
  fi
  "$node_bin" -e '
    const fs = require("fs");
    try {
      const parsed = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      process.stdout.write(typeof parsed.version === "string" && parsed.version ? parsed.version : "unknown");
    } catch {
      process.stdout.write("unknown");
    }
  ' "$package_path"
}

catalog_required_for_version() {
  local version="${1#v}"
  local major minor patch
  version="${version%%-*}"
  version="${version%%+*}"
  if [[ ! "$version" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
    # Unknown versions fail closed.
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

# ── Parse args ──────────────────────────────────────
APPLY=false
TARBALL=""

while [ $# -gt 0 ]; do
  case "$1" in
    --apply)
      APPLY=true
      shift
      ;;
    -h|--help)
      sed -n '2,30p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *)
      TARBALL="$1"
      shift
      ;;
  esac
done

# Fail before archive extraction, PM2 interaction, filesystem replacement, or
# database mutation. There is deliberately no test/owner/environment bypass:
# the signed root-owned transaction is the sole production recovery writer.
if [ "$APPLY" = true ]; then
  echo "❌ Direct restore apply is retired. Use the signed root-owned promotion recovery transaction." >&2
  exit 77
fi

# Default: latest backup in BACKUP_DIR
if [ -z "$TARBALL" ]; then
  TARBALL=$(ls -t "$BACKUP_DIR"/*.tar.gz 2>/dev/null | head -1 || true)
  if [ -z "$TARBALL" ]; then
    echo "❌ No backups found in $BACKUP_DIR"
    exit 1
  fi
  echo "ℹ️  Using latest backup: $TARBALL"
fi

if [ ! -f "$TARBALL" ]; then
  echo "❌ Backup file not found: $TARBALL"
  exit 1
fi

SIZE=$(du -h "$TARBALL" | cut -f1)
echo "📦 Backup: $TARBALL ($SIZE)"

# ── 1. Extract to a temp dir ────────────────────────
TMP=$(mktemp -d -t nexus-restore-XXXXXX)
trap 'rm -rf "$TMP"' EXIT

echo "📤 Extracting to $TMP..."
tar xzf "$TARBALL" -C "$TMP"

# ── 2. Inventory ────────────────────────────────────
echo ""
echo "📋 Backup contents:"
echo "   - dist/                : $([ -d "$TMP/dist" ] && echo present || echo MISSING)"
echo "   - catalog/             : $([ -d "$TMP/catalog" ] && echo present || echo MISSING)"
echo "   - content-engine/      : $([ -d "$TMP/content-engine" ] && echo present || echo MISSING)"
echo "   - migrations/          : $([ -d "$TMP/migrations" ] && echo present || echo MISSING) ($(ls "$TMP/migrations" 2>/dev/null | wc -l | xargs) files)"
echo "   - prompts/             : $([ -d "$TMP/prompts" ] && echo present || echo MISSING)"
echo "   - package.json         : $([ -f "$TMP/package.json" ] && echo present || echo MISSING)"
echo "   - ecosystem.config.js  : $([ -f "$TMP/ecosystem.config.js" ] && echo present || echo MISSING)"
echo "   - data/bot.db          : $([ -f "$TMP/data/bot.db" ] && echo "$(du -h "$TMP/data/bot.db" | cut -f1)" || echo "❌ MISSING — backup is code-only")"
echo "   - data/bot.db-wal      : $([ -f "$TMP/data/bot.db-wal" ] && echo "$(du -h "$TMP/data/bot.db-wal" | cut -f1)" || echo none)"
echo "   - data/garmin-tokens/  : $([ -d "$TMP/data/garmin-tokens" ] && echo present || echo none)"

# Treat archive contents as hostile even when the normal backup producer
# excludes Content Engine secrets and state. A crafted or historical archive
# must never be able to copy protected entries (or symlinks to entries outside
# the extracted tree) over the live Content Engine directory.
CONTENT_ENGINE_VALIDATION_NODE="${NODE_BIN:-/usr/bin/node}"
if [ ! -x "$CONTENT_ENGINE_VALIDATION_NODE" ]; then
  CONTENT_ENGINE_VALIDATION_NODE="$(command -v node || true)"
fi
if [ -z "$CONTENT_ENGINE_VALIDATION_NODE" ]; then
  echo "❌ Node is required to validate Content Engine archive paths."
  exit 1
fi
if [ -d "$TMP/content-engine" ]; then
  "$CONTENT_ENGINE_VALIDATION_NODE" - "$TMP/content-engine" <<'NODE'
const fs = require('fs');
const path = require('path');

const root = process.argv[2];
const protectedNames = new Set([
  '.venv',
  '.local',
  'logs',
  'data',
  '.git',
  '.codex',
  '.claude',
  '__pycache__',
]);
const violations = [];

function inspect(directory, relativeDirectory = '') {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
    const absolute = path.join(directory, entry.name);
    const components = relative.split('/');
    const protectedComponent = components.find(component =>
      component === '.env'
      || component.startsWith('.env.')
      || protectedNames.has(component)
      || component.endsWith('.db'));
    if (protectedComponent) violations.push(`protected archive path: ${relative}`);

    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      violations.push(`symlink archive path: ${relative}`);
      continue;
    }
    if (stat.isDirectory()) inspect(absolute, relative);
  }
}

inspect(root);
if (violations.length > 0) {
  for (const violation of [...new Set(violations)].sort()) console.error(violation);
  process.exit(1);
}
NODE
fi

# Applying a partial code archive would combine an older dist/package/DB with
# whatever runtime metadata happened to remain on disk. Media catalog metadata
# is release-bound from v4.14.217 onward. Earlier production backups legitimately
# omit it; restoring one must remove any newer live catalog rather than leaving a
# hybrid runtime.
BACKUP_VERSION="$(package_version "$TMP/package.json")"
MISSING_RUNTIME_PATHS=""
for required in \
  dist \
  migrations \
  prompts \
  content-engine \
  content-engine/main.py \
  content-engine/config.py \
  content-engine/requirements.txt \
  package.json \
  package-lock.json \
  ecosystem.config.js
do
  if [ ! -e "$TMP/$required" ]; then
    MISSING_RUNTIME_PATHS="$MISSING_RUNTIME_PATHS $required"
  fi
done
if [ ! -d "$TMP/catalog" ] && catalog_required_for_version "$BACKUP_VERSION"; then
  MISSING_RUNTIME_PATHS="$MISSING_RUNTIME_PATHS catalog"
fi
if [ "$APPLY" = true ] && [ -n "$MISSING_RUNTIME_PATHS" ]; then
  echo "❌ Refusing --apply: backup is missing required runtime paths:$MISSING_RUNTIME_PATHS"
  exit 1
fi
if [ ! -d "$TMP/catalog" ]; then
  echo "ℹ️  Legacy pre-v$CATALOG_REQUIRED_FROM_VERSION backup ($BACKUP_VERSION): catalog will be removed on apply."
fi

# ── 3. SQLite integrity check ───────────────────────
DB="$TMP/data/bot.db"
if [ ! -f "$DB" ]; then
  echo ""
  echo "⚠️  This backup does NOT contain bot.db. Restoring it would lose"
  echo "    all user data (conversations, tasks, api_usage, etc)."
  echo "    Backups taken before the QW-10 backup-format fix have this problem."
  echo ""
  if [ "$APPLY" = true ]; then
    echo "❌ Refusing --apply on a code-only backup. Use this only for code rollbacks."
    exit 1
  fi
  echo "Dry-run only — exiting."
  exit 0
fi

echo ""
echo "🔍 Running SQLite integrity check..."
# Use better-sqlite3 via node since the sqlite3 CLI isn't installed.
# Look for the local node + better-sqlite3 install. On the production
# server it's in $REMOTE_DIR/node_modules; on a dev Mac it depends on cwd.
NODE_BIN="${NODE_BIN:-/usr/bin/node}"
if [ ! -x "$NODE_BIN" ]; then
  NODE_BIN=$(command -v node || echo "")
fi
if [ -z "$NODE_BIN" ]; then
  echo "⚠️  No node binary found — skipping integrity check"
else
  NODE_PATH_LOCAL="${NODE_PATH_LOCAL:-$REMOTE_DIR/node_modules}"
  if [ ! -d "$NODE_PATH_LOCAL/better-sqlite3" ]; then
    NODE_PATH_LOCAL="$(dirname "$0")/../node_modules"
  fi
  NODE_PATH="$NODE_PATH_LOCAL" "$NODE_BIN" -e "
    const Database = require('better-sqlite3');
    const db = new Database('$DB', { readonly: true });
    const result = db.pragma('integrity_check');
    const ok = Array.isArray(result) && result[0] && result[0].integrity_check === 'ok';
    if (!ok) {
      console.error('❌ Integrity check FAILED:', JSON.stringify(result));
      process.exit(1);
    }
    console.log('   ✅ integrity_check: ok');

    // Row counts for the most important tables — proves the backup has data
    const tables = [
      'users', 'conversations', 'api_usage', 'audit_trail', 'client_errors',
      'invoice_filings', 'job_history', 'reminders', 'todos',
      'unified_tasks', 'user_oauth_tokens', 'ios_devices', 'error_log',
    ];
    console.log('');
    console.log('📊 Row counts (tables that exist in backup):');
    for (const t of tables) {
      try {
        const n = db.prepare('SELECT COUNT(*) as n FROM ' + t).get().n;
        console.log('   ' + t.padEnd(25) + n);
      } catch { /* table may not exist in older backups */ }
    }
    db.close();
  " || { echo "❌ Integrity check failed"; exit 1; }
fi

# ── 4. Apply or finish ──────────────────────────────
if [ "$APPLY" != true ]; then
  echo ""
  echo "✅ Dry-run complete. Backup is healthy and restorable."
  echo "   Production recovery requires the exact signed root-owned transaction."
  exit 0
fi

# APPLY mode — must run on the live server with bot stopped
echo ""
echo "⚠️  APPLY MODE — about to overwrite $REMOTE_DIR with backup contents."
echo "    The bot MUST be stopped (pm2 stop nexus-hub) to release bot.db."
echo ""
read -r -p "Type 'YES' to continue: " CONFIRM
if [ "$CONFIRM" != "YES" ]; then
  echo "Cancelled."
  exit 0
fi

if [ ! -d "$REMOTE_DIR" ]; then
  echo "❌ REMOTE_DIR does not exist: $REMOTE_DIR"
  exit 1
fi

# Pre-restore safety: snapshot the complete CURRENT state that this script may
# replace, so an aborted restore can be undone.
install -d -m 700 "$BACKUP_DIR"
PRE_RESTORE_SNAPSHOT="$BACKUP_DIR/pre-restore-$(date +%Y%m%d_%H%M%S).tar.gz"
TMP_PRE_RESTORE_SNAPSHOT="$PRE_RESTORE_SNAPSHOT.tmp"
echo "📸 Pre-restore snapshot: $PRE_RESTORE_SNAPSHOT"
rm -f "$TMP_PRE_RESTORE_SNAPSHOT"
CURRENT_VERSION="$(package_version "$REMOTE_DIR/package.json")"
PRE_RESTORE_INCLUDES=(
  "dist/"
  "migrations/"
  "prompts/"
  "content-engine/"
  "package.json"
  "package-lock.json"
  "ecosystem.config.js"
  "data/bot.db"
)
if [ -d "$REMOTE_DIR/catalog" ]; then
  PRE_RESTORE_INCLUDES+=("catalog/")
elif catalog_required_for_version "$CURRENT_VERSION"; then
  echo "❌ Refusing restore: current v$CURRENT_VERSION runtime is missing its required catalog."
  exit 1
fi
[ -f "$REMOTE_DIR/data/bot.db-wal" ] && PRE_RESTORE_INCLUDES+=("data/bot.db-wal")
[ -f "$REMOTE_DIR/data/bot.db-shm" ] && PRE_RESTORE_INCLUDES+=("data/bot.db-shm")
[ -d "$REMOTE_DIR/data/garmin-tokens" ] && PRE_RESTORE_INCLUDES+=("data/garmin-tokens/")
if (cd "$REMOTE_DIR" && tar czf "$TMP_PRE_RESTORE_SNAPSHOT" \
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
  "${PRE_RESTORE_INCLUDES[@]}"); then
  chmod 600 "$TMP_PRE_RESTORE_SNAPSHOT"
  mv -f "$TMP_PRE_RESTORE_SNAPSHOT" "$PRE_RESTORE_SNAPSHOT"
else
  rm -f "$TMP_PRE_RESTORE_SNAPSHOT"
  echo "❌ Pre-restore snapshot failed; refusing to replace production files."
  exit 1
fi

echo "🔄 Replacing dist/, catalog/, migrations/, prompts/, content-engine code, package.json, ecosystem.config.js..."
for path in dist catalog migrations prompts package.json package-lock.json ecosystem.config.js; do
  rm -rf "$REMOTE_DIR/$path"
  if [ -e "$TMP/$path" ]; then
    cp -r "$TMP/$path" "$REMOTE_DIR/$path"
  fi
done

# Replace Content Engine code while preserving exactly the state/secrets that
# production deploy rsync excludes.
mkdir -p "$REMOTE_DIR/content-engine"
(
  shopt -s dotglob nullglob
  for live_path in "$REMOTE_DIR/content-engine"/*; do
    live_name="$(basename "$live_path")"
    case "$live_name" in
      .env|.env.*|.venv|.local|logs|data|.git|.codex|.claude|*.db) continue ;;
    esac
    rm -rf "$live_path"
  done
)
cp -R "$TMP/content-engine/." "$REMOTE_DIR/content-engine/"

echo "🔄 Replacing data/bot.db (and sidecars if present)..."
mkdir -p "$REMOTE_DIR/data"
# Remove old WAL/SHM so the restored DB starts clean
rm -f "$REMOTE_DIR/data/bot.db" "$REMOTE_DIR/data/bot.db-wal" "$REMOTE_DIR/data/bot.db-shm"
cp "$TMP/data/bot.db" "$REMOTE_DIR/data/bot.db"
[ -f "$TMP/data/bot.db-wal" ] && cp "$TMP/data/bot.db-wal" "$REMOTE_DIR/data/bot.db-wal"
[ -f "$TMP/data/bot.db-shm" ] && cp "$TMP/data/bot.db-shm" "$REMOTE_DIR/data/bot.db-shm"

if [ -d "$TMP/data/garmin-tokens" ]; then
  rm -rf "$REMOTE_DIR/data/garmin-tokens"
  cp -r "$TMP/data/garmin-tokens" "$REMOTE_DIR/data/garmin-tokens"
fi

echo ""
echo "✅ Restore complete from $TARBALL"
echo "   Pre-restore snapshot saved at $PRE_RESTORE_SNAPSHOT"
echo "   Start the bot: pm2 start nexus-hub"
