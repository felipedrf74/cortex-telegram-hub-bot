#!/usr/bin/env bash
# ─────────────────────────────────────────────────────
# rollback.sh — Rollback Nexus Hub to a previous version
# TODO: Rename server directory /home/dominguez/telegram-hub-bot → /home/dominguez/nexus-hub
#
# Usage:
#   ./scripts/rollback.sh              # List available backups
#   ./scripts/rollback.sh v4.4.1       # Rollback to specific version
#   ./scripts/rollback.sh latest       # Rollback to most recent backup
#
# This script:
#   1. Lists available backups on the server
#   2. Stops services
#   3. Restores the selected backup
#   4. Reinstalls dependencies
#   5. Starts services
#   6. Runs health check
# ─────────────────────────────────────────────────────
set -euo pipefail

SERVER="dominguez@serverdominguez"
REMOTE_DIR="/home/dominguez/telegram-hub-bot"
BACKUP_DIR="/home/dominguez/backups/nexushub"
PM2="/home/dominguez/.npm-global/bin/pm2"
VERSION="${1:-}"

echo "═══════════════════════════════════════════════"
echo "  🔄 Nexus Hub Rollback Tool"
echo "═══════════════════════════════════════════════"
echo ""

# ── List available backups ───────────────────────────
echo "📦 Available backups on server:"
echo ""
BACKUPS=$(ssh "$SERVER" "ls -1t $BACKUP_DIR/*.tar.gz 2>/dev/null" || true)

if [ -z "$BACKUPS" ]; then
  echo "   ❌ No backups found at $BACKUP_DIR"
  echo "   Run a deploy first to create a backup."
  exit 1
fi

i=1
while IFS= read -r backup; do
  fname=$(basename "$backup")
  size=$(ssh "$SERVER" "du -h '$backup' | cut -f1")
  echo "   [$i] $fname ($size)"
  i=$((i + 1))
done <<< "$BACKUPS"
echo ""

# ── If no version specified, just list and exit ──────
if [ -z "$VERSION" ]; then
  echo "Usage: ./scripts/rollback.sh <version|latest>"
  echo "       ./scripts/rollback.sh v4.4.1"
  echo "       ./scripts/rollback.sh latest"
  exit 0
fi

# ── Find the backup file ────────────────────────────
if [ "$VERSION" = "latest" ]; then
  BACKUP_FILE=$(echo "$BACKUPS" | head -1)
else
  # Match version prefix (e.g., "4.4.1" matches "4.4.1_20260329_120000.tar.gz")
  CLEAN_VERSION="${VERSION#v}"  # Strip leading 'v'
  BACKUP_FILE=$(echo "$BACKUPS" | grep "^.*/${CLEAN_VERSION}_" | head -1 || true)
  
  if [ -z "$BACKUP_FILE" ]; then
    echo "❌ No backup found for version $VERSION"
    echo "   Available versions:"
    echo "$BACKUPS" | xargs -I{} basename {} | sed 's/_[0-9]*_[0-9]*.tar.gz//' | sort -u | sed 's/^/   - v/'
    exit 1
  fi
fi

BACKUP_NAME=$(basename "$BACKUP_FILE")
echo "🎯 Selected: $BACKUP_NAME"
echo ""

# ── Confirm ──────────────────────────────────────────
CURRENT_VERSION=$(ssh "$SERVER" "node -p \"require('$REMOTE_DIR/package.json').version\"" 2>/dev/null || echo "unknown")
echo "⚠️  This will rollback from v${CURRENT_VERSION} to ${BACKUP_NAME}"
read -p "   Continue? (y/N) " -n 1 -r
echo ""

if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  echo "❌ Rollback cancelled"
  exit 0
fi

# ── 1. Backup current state (pre-rollback safety) ────
echo ""
echo "💾 Creating pre-rollback backup..."
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
ssh "$SERVER" "cd $REMOTE_DIR && tar czf $BACKUP_DIR/pre-rollback_${CURRENT_VERSION}_${TIMESTAMP}.tar.gz dist/ prompts/ migrations/ package.json package-lock.json ecosystem.config.js 2>/dev/null || true"
echo "   ✅ Pre-rollback backup saved"

# ── 2. Stop services ────────────────────────────────
echo ""
echo "🛑 Stopping services..."
ssh "$SERVER" "export PATH=\$PATH:$(dirname $PM2) && $PM2 stop nexus-hub 2>/dev/null; $PM2 stop content-engine 2>/dev/null; echo '   Stopped.'"

# ── 3. Restore backup ───────────────────────────────
echo ""
echo "📥 Restoring from $BACKUP_NAME..."
ssh "$SERVER" "cd $REMOTE_DIR && tar xzf $BACKUP_FILE"
echo "   ✅ Files restored"

# ── 4. Install dependencies ─────────────────────────
echo ""
echo "📦 Installing dependencies..."
ssh "$SERVER" "cd $REMOTE_DIR && npm ci --production 2>&1 | tail -1"
echo "   ✅ Dependencies installed"

# ── 5. Start services ───────────────────────────────
echo ""
echo "🟢 Starting services..."
ssh "$SERVER" "export PATH=\$PATH:$(dirname $PM2) && $PM2 start content-engine 2>/dev/null; $PM2 start nexus-hub; $PM2 save; echo '   ✅ Running'"

# ── 6. Health check ─────────────────────────────────
echo ""
echo "🏥 Health check..."
sleep 5
RESTORED_VERSION=$(ssh "$SERVER" "node -p \"require('$REMOTE_DIR/package.json').version\"" 2>/dev/null || echo "unknown")
ssh "$SERVER" "export PATH=\$PATH:$(dirname $PM2) && $PM2 list | grep -E 'nexus-hub|content-engine'"

echo ""
echo "═══════════════════════════════════════════════"
echo "  ✅ Rollback complete!"
echo "  📦 Version: v${CURRENT_VERSION} → v${RESTORED_VERSION}"
echo "  💾 Pre-rollback backup saved"
echo "═══════════════════════════════════════════════"
