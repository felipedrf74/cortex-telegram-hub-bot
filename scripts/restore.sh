#!/usr/bin/env bash
# ─────────────────────────────────────────────────────
# restore.sh — Restore a Nexus Hub backup tarball.
#
# Audit QW-10. Backups are created by deploy.sh into
# /home/dominguez/backups/nexushub/ and contain:
#   dist/ prompts/ migrations/ package.json package-lock.json
#   ecosystem.config.js data/bot.db [data/bot.db-wal] [data/bot.db-shm]
#   [data/garmin-tokens/]
#
# This script supports two modes:
#
#   1) DRY RUN (default): extract to a temp directory, run an integrity
#      check on the SQLite DB, print row counts for the most important
#      tables, and report. Does NOT touch production. Safe to run any time.
#
#   2) APPLY (--apply): extract over the live install, replacing dist/,
#      bot.db, etc. The bot MUST be stopped first (`pm2 stop nexus-hub`)
#      otherwise the open WAL handle will conflict.
#
# Usage:
#   ./scripts/restore.sh                              # dry-run latest backup
#   ./scripts/restore.sh /path/to/backup.tar.gz       # dry-run a specific one
#   ./scripts/restore.sh --apply <path>               # apply (DESTRUCTIVE)
#
# Designed to run BOTH on the production server (where deploy.sh creates
# the backups) AND on a developer Mac (where you'd test it offline).
# Detects environment via the BACKUP_DIR + REMOTE_DIR env vars.
# ─────────────────────────────────────────────────────
set -euo pipefail
umask 077

BACKUP_DIR="${BACKUP_DIR:-/home/dominguez/backups/nexushub}"
REMOTE_DIR="${REMOTE_DIR:-/home/dominguez/telegram-hub-bot}"

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
echo "   - migrations/          : $([ -d "$TMP/migrations" ] && echo present || echo MISSING) ($(ls "$TMP/migrations" 2>/dev/null | wc -l | xargs) files)"
echo "   - prompts/             : $([ -d "$TMP/prompts" ] && echo present || echo MISSING)"
echo "   - package.json         : $([ -f "$TMP/package.json" ] && echo present || echo MISSING)"
echo "   - ecosystem.config.js  : $([ -f "$TMP/ecosystem.config.js" ] && echo present || echo MISSING)"
echo "   - data/bot.db          : $([ -f "$TMP/data/bot.db" ] && echo "$(du -h "$TMP/data/bot.db" | cut -f1)" || echo "❌ MISSING — backup is code-only")"
echo "   - data/bot.db-wal      : $([ -f "$TMP/data/bot.db-wal" ] && echo "$(du -h "$TMP/data/bot.db-wal" | cut -f1)" || echo none)"
echo "   - data/garmin-tokens/  : $([ -d "$TMP/data/garmin-tokens" ] && echo present || echo none)"

# ── 3. SQLite integrity check ───────────────────────
DB="$TMP/data/bot.db"
if [ ! -f "$DB" ]; then
  echo ""
  echo "⚠️  This backup does NOT contain bot.db. Restoring it would lose"
  echo "    all user data (conversations, tasks, api_usage, etc)."
  echo "    Backups taken before deploy.sh QW-10 fix have this problem."
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
  echo "   To actually restore: ./scripts/restore.sh --apply $TARBALL"
  echo "   ⚠️  Stop the bot first: pm2 stop nexus-hub"
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

# Pre-restore safety: snapshot the CURRENT state into a fallback tarball
# so an aborted restore can be undone.
install -d -m 700 "$BACKUP_DIR"
PRE_RESTORE_SNAPSHOT="$BACKUP_DIR/pre-restore-$(date +%Y%m%d_%H%M%S).tar.gz"
TMP_PRE_RESTORE_SNAPSHOT="$PRE_RESTORE_SNAPSHOT.tmp"
echo "📸 Pre-restore snapshot: $PRE_RESTORE_SNAPSHOT"
rm -f "$TMP_PRE_RESTORE_SNAPSHOT"
PRE_RESTORE_INCLUDES="dist/ data/bot.db"
[ -f "$REMOTE_DIR/data/bot.db-wal" ] && PRE_RESTORE_INCLUDES="$PRE_RESTORE_INCLUDES data/bot.db-wal"
[ -f "$REMOTE_DIR/data/bot.db-shm" ] && PRE_RESTORE_INCLUDES="$PRE_RESTORE_INCLUDES data/bot.db-shm"
if (cd "$REMOTE_DIR" && tar czf "$TMP_PRE_RESTORE_SNAPSHOT" $PRE_RESTORE_INCLUDES 2>/dev/null); then
  chmod 600 "$TMP_PRE_RESTORE_SNAPSHOT"
  mv -f "$TMP_PRE_RESTORE_SNAPSHOT" "$PRE_RESTORE_SNAPSHOT"
else
  rm -f "$TMP_PRE_RESTORE_SNAPSHOT"
  echo "⚠️  Pre-restore snapshot skipped; some expected paths were unavailable."
fi

echo "🔄 Replacing dist/, migrations/, prompts/, package.json, ecosystem.config.js..."
for path in dist migrations prompts package.json package-lock.json ecosystem.config.js; do
  if [ -e "$TMP/$path" ]; then
    rm -rf "$REMOTE_DIR/$path"
    cp -r "$TMP/$path" "$REMOTE_DIR/$path"
  fi
done

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
