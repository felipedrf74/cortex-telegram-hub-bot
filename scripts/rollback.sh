#!/usr/bin/env bash
# ─────────────────────────────────────────────────────
# rollback.sh — Rollback Nexus Hub to a previous version
#
# Audit Quarter item: tested rollback procedure. This script is the
# orchestrator that ships on Felipe's Mac; the heavy lifting (extraction,
# integrity check, pre-restore snapshot, file replacement) happens on the
# production server via scripts/restore.sh which was written with both
# dry-run and apply modes in QW-10.
#
# Usage:
#   ./scripts/rollback.sh                     # List available backups (read-only)
#   ./scripts/rollback.sh --dry-run latest    # Dry-run restore of latest backup
#   ./scripts/rollback.sh --dry-run v4.9.20   # Dry-run restore of specific version
#   ./scripts/rollback.sh latest              # Apply rollback to most recent backup
#   ./scripts/rollback.sh v4.9.20             # Apply rollback to specific version
#
# Safety rails this script adds on top of restore.sh:
#   1. Interactive confirmation prompt showing current→target version
#   2. PM2 stop/start orchestration around the restore
#   3. Dependency reinstall (npm ci) in case package.json changed between
#      the current version and the rollback target
#   4. Health check against /health after restart (confirms the bot is
#      actually serving, not just that PM2 thinks it's running)
#   5. Pre-restore snapshot includes data/bot.db (previous version of this
#      script did NOT include it — QW-10 finding)
# ─────────────────────────────────────────────────────
set -euo pipefail

SERVER="${DEPLOY_SERVER:-dominguez@serverdominguez}"
REMOTE_DIR="${DEPLOY_PATH:-/home/dominguez/telegram-hub-bot}"
LOCAL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BACKUP_DIR="/home/dominguez/backups/nexushub"
PM2="/home/dominguez/.npm-global/bin/pm2"

# ── Parse args ───────────────────────────────────────
DRY_RUN=false
VERSION=""

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    -h|--help)
      sed -n '2,28p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *)
      VERSION="$1"
      shift
      ;;
  esac
done

echo "═══════════════════════════════════════════════"
echo "  🔄 Nexus Hub Rollback Tool"
echo "═══════════════════════════════════════════════"
echo ""

# ── List available backups ───────────────────────────
echo "📦 Available backups on server:"
echo ""
BACKUPS=$(ssh "$SERVER" "ls -1t $BACKUP_DIR/v*.tar.gz 2>/dev/null" || true)

if [ -z "$BACKUPS" ]; then
  echo "   ❌ No backups found at $BACKUP_DIR"
  echo "   Run a deploy first to create a backup."
  exit 1
fi

# Batch the size + has_db checks into a single ssh call instead of 2 per
# backup (which would be 2N round trips). This runs O(1) ssh invocations
# regardless of backup count, and sidesteps the classic "ssh inside a
# while-read loop consumes stdin" bug where ssh drains the loop's here-string
# because its stdin is inherited — the loop then exits after one iteration.
# We produce a pipe-delimited table ("path|size|has_db") and parse locally.
METADATA=$(ssh "$SERVER" "
  for f in \$(ls -1t $BACKUP_DIR/v*.tar.gz 2>/dev/null); do
    sz=\$(du -h \"\$f\" | cut -f1)
    hd=0
    if tar tzf \"\$f\" 2>/dev/null | grep -q 'data/bot.db\$'; then hd=1; fi
    echo \"\$f|\$sz|\$hd\"
  done
")

i=1
while IFS='|' read -r backup size has_db; do
  [ -z "$backup" ] && continue
  fname=$(basename "$backup")
  if [ "$has_db" = "1" ]; then
    db_flag=" [includes data]"
  else
    db_flag=" [code only ⚠️]"
  fi
  echo "   [$i] $fname ($size)$db_flag"
  i=$((i + 1))
done <<< "$METADATA"
echo ""

# ── If no version specified, just list and exit ──────
if [ -z "$VERSION" ]; then
  echo "Usage:"
  echo "  ./scripts/rollback.sh --dry-run latest      # Validate backup without applying"
  echo "  ./scripts/rollback.sh latest                # Apply latest rollback"
  echo "  ./scripts/rollback.sh v4.9.20               # Apply specific version"
  echo ""
  echo "⚠️  Backups marked [code only] do NOT contain bot.db and will fail --apply."
  echo "   Use them only for code rollbacks by manually running:"
  echo "     ssh $SERVER 'cd $REMOTE_DIR && tar xzf <backup>'"
  exit 0
fi

# ── Find the backup file ────────────────────────────
if [ "$VERSION" = "latest" ]; then
  BACKUP_FILE=$(echo "$BACKUPS" | head -1)
else
  # Match version prefix (e.g., "4.9.20" matches "v4.9.20_20260407_...")
  CLEAN_VERSION="${VERSION#v}"  # Strip leading 'v'
  BACKUP_FILE=$(echo "$BACKUPS" | grep "/v${CLEAN_VERSION}_" | head -1 || true)

  if [ -z "$BACKUP_FILE" ]; then
    echo "❌ No backup found for version $VERSION"
    echo "   Available versions:"
    echo "$BACKUPS" | xargs -I{} basename {} | sed -E 's/_[0-9]+_[0-9]+\.tar\.gz$//' | sort -u | sed 's/^/   - /'
    exit 1
  fi
fi

BACKUP_NAME=$(basename "$BACKUP_FILE")
echo "🎯 Selected: $BACKUP_NAME"
echo ""

# ── DRY-RUN mode: just run restore.sh dry-run remotely ───
if [ "$DRY_RUN" = true ]; then
  echo "🔍 Dry-run mode — extracting backup to a temp dir, running integrity check."
  echo "   No changes will be made to production."
  echo ""
  ssh "$SERVER" "cd $REMOTE_DIR && bash scripts/restore.sh $(printf '%q' "$BACKUP_FILE")"
  RESTORE_EXIT=$?
  echo ""
  if [ $RESTORE_EXIT -eq 0 ]; then
    echo "═══════════════════════════════════════════════"
    echo "  ✅ Dry-run complete — backup is restorable"
    echo "═══════════════════════════════════════════════"
    echo ""
    echo "To apply this rollback for real:"
    echo "  ./scripts/rollback.sh $VERSION"
  else
    echo "❌ Dry-run failed — this backup is NOT safe to restore"
    exit 1
  fi
  exit 0
fi

# ── APPLY mode: confirmation prompt ───────────────────
CURRENT_VERSION=$(ssh "$SERVER" "/usr/bin/node -p \"require('$REMOTE_DIR/package.json').version\"" 2>/dev/null || echo "unknown")
echo "⚠️  This will rollback from v${CURRENT_VERSION} to ${BACKUP_NAME}"
echo "   Pre-restore snapshot will be saved automatically."
if [ "${NEXUS_ROLLBACK_AUTO_CONFIRM:-0}" = "1" ]; then
  echo "   NEXUS_ROLLBACK_AUTO_CONFIRM=1 — confirmation supplied by caller"
  CONFIRM="YES"
else
  read -p "   Continue? (type YES to confirm) " CONFIRM
fi
echo ""

if [ "$CONFIRM" != "YES" ]; then
  echo "❌ Rollback cancelled"
  exit 0
fi

# ── 1. Stop services ────────────────────────────────
echo ""
echo "🛑 Stopping services..."
ssh "$SERVER" "export PATH=\$PATH:$(dirname $PM2) && $PM2 stop nexus-hub 2>/dev/null; $PM2 stop content-engine 2>/dev/null; echo '   Stopped.'"

# ── 2. Wait for port 8200 to release ────────────────
echo "   Waiting for port 8200 to release..."
ssh "$SERVER" '
  for i in $(seq 1 30); do
    if ! ss -tln 2>/dev/null | grep -q ":8200 "; then
      echo "   ✅ Port 8200 free (after ${i}s)"
      exit 0
    fi
    sleep 1
  done
  echo "   ⚠️  Port 8200 still bound after 30s — proceeding anyway"
'

# ── 3. Run restore.sh --apply on the server ─────────
# The restore script handles:
#   - Pre-restore snapshot of current dist + catalog + bot.db (for undo)
#   - Integrity check on the backup DB before replacing
#   - Atomic file swap (dist, catalog, migrations, prompts, bot.db, garmin-tokens)
# We pipe "YES" to confirm non-interactively since we already prompted above.
echo ""
echo "📥 Restoring from $BACKUP_NAME..."
ssh "$SERVER" "cd $REMOTE_DIR && echo YES | bash scripts/restore.sh --apply $(printf '%q' "$BACKUP_FILE")"

# ── 4. Install dependencies ─────────────────────────
# package.json / package-lock.json may differ between current and target.
echo ""
echo "📦 Installing dependencies..."
ssh "$SERVER" "cd $REMOTE_DIR && npm ci --production 2>&1 | tail -1"
echo "   ✅ Dependencies installed"

# ── 5. Rebuild native modules ───────────────────────
# Must be rebuilt against system Node (the version PM2 spawns under).
# Same pattern as deploy.sh — see the comment there for the full rationale.
echo ""
echo "🔧 Rebuilding native modules..."
ssh "$SERVER" "
  SYSTEM_NODE=/usr/bin/node
  if [ -x \"\$SYSTEM_NODE\" ]; then
    cd $REMOTE_DIR && PATH=/usr/bin:\$PATH /usr/bin/npm rebuild better-sqlite3 2>&1 | tail -1
    echo '   ✅ Native modules rebuilt'
  fi
"

# ── 6. Recreate services without resurrecting historical PM2 secrets ──
echo ""
echo "🟢 Starting services..."
ROLLBACK_RUNTIME_CONFIG="rollback-ecosystem.runtime.config.js"
scp "$LOCAL_DIR/ecosystem.config.js" "$SERVER:$REMOTE_DIR/$ROLLBACK_RUNTIME_CONFIG"
ssh "$SERVER" "chmod 600 $REMOTE_DIR/$ROLLBACK_RUNTIME_CONFIG"
if ssh "$SERVER" bash -s -- \
  "$REMOTE_DIR" \
  "$PM2" \
  "rollback-unknown" \
  "$ROLLBACK_RUNTIME_CONFIG" \
  "nexus-hub,content-engine" \
  "NODE_ENV,ENV,GIT_COMMIT" \
  < "$LOCAL_DIR/scripts/remote-start-sanitized-pm2.sh"
then
  ssh "$SERVER" "rm -f $REMOTE_DIR/$ROLLBACK_RUNTIME_CONFIG"
  echo "   ✅ Running with sanitized PM2 state"
else
  ssh "$SERVER" "rm -f $REMOTE_DIR/$ROLLBACK_RUNTIME_CONFIG" || true
  echo "   ❌ Sanitized PM2 bootstrap failed after restore"
  exit 1
fi

# ── 7. Health check with retries ────────────────────
echo ""
echo "🏥 Health check (waiting 10s for startup)..."
sleep 10

HEALTH_OK=false
for attempt in 1 2 3; do
  STATUS=$(ssh "$SERVER" "export PATH=\$PATH:$(dirname $PM2) && $PM2 jlist 2>/dev/null | /usr/bin/node -pe \"JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).find(p=>p.name==='nexus-hub')?.pm2_env?.status\" 2>/dev/null" || echo "unknown")
  if [ "$STATUS" = "online" ]; then
    # Additional check: hit /health endpoint to confirm bot is actually serving
    HEALTH=$(ssh "$SERVER" "curl -sf http://localhost:8200/api/snapshot 2>/dev/null | head -c 50 || echo ''")
    if [ -n "$HEALTH" ]; then
      HEALTH_OK=true
      break
    fi
  fi
  echo "   ⏳ Attempt $attempt: not ready yet (status=$STATUS), retrying in 5s..."
  sleep 5
done

RESTORED_VERSION=$(ssh "$SERVER" "/usr/bin/node -p \"require('$REMOTE_DIR/package.json').version\"" 2>/dev/null || echo "unknown")
ssh "$SERVER" "export PATH=\$PATH:$(dirname $PM2) && $PM2 list | grep -E 'nexus-hub|content-engine'"

echo ""
echo "═══════════════════════════════════════════════"
if [ "$HEALTH_OK" = true ]; then
  echo "  ✅ Rollback complete!"
  echo "  📦 Version: v${CURRENT_VERSION} → v${RESTORED_VERSION}"
  echo "  💾 Pre-restore snapshot saved by restore.sh"
else
  echo "  ⚠️  Rollback completed but health check FAILED"
  echo "  📦 Version: v${CURRENT_VERSION} → v${RESTORED_VERSION}"
  echo "  🔍 Check logs: ssh $SERVER '$PM2 logs nexus-hub --lines 50 --nostream'"
  echo "  🔙 To undo: find pre-restore-*.tar.gz in $BACKUP_DIR and run"
  echo "     ssh $SERVER 'cd $REMOTE_DIR && bash scripts/restore.sh --apply <snapshot>'"
fi
echo "═══════════════════════════════════════════════"

if [ "$HEALTH_OK" != true ]; then
  exit 1
fi
