#!/usr/bin/env bash
# ─────────────────────────────────────────────────────
# deploy.sh — Deploy telegram-hub-bot + content-engine
#              to the Linux server via scp
#
# PRESERVES on the server (never overwritten):
#   .env, data/, logs/, node_modules/, content-engine/.venv/
#
# Usage:  ./scripts/deploy.sh
# ─────────────────────────────────────────────────────
set -euo pipefail

SERVER="dominguez@serverdominguez"
REMOTE_DIR="/home/dominguez/telegram-hub-bot"
LOCAL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PM2="/home/dominguez/.npm-global/bin/pm2"

echo "🚀 Deploying from: $LOCAL_DIR"
echo "   To: $SERVER:$REMOTE_DIR"
echo ""

# ── 1. Build TypeScript locally ──────────────────────
echo "📦 Building TypeScript..."
cd "$LOCAL_DIR"
npx tsc --noEmit 2>/dev/null && echo "   ✅ Type check passed" || { echo "   ❌ Type errors — aborting"; exit 1; }
npm run build 2>/dev/null && echo "   ✅ Build complete" || { echo "   ❌ Build failed — aborting"; exit 1; }

# ── 2. Stop services on server ───────────────────────
echo ""
echo "🛑 Stopping services on server..."
ssh "$SERVER" "export PATH=\$PATH:$PM2 && $PM2 stop telegram-hub-bot 2>/dev/null; $PM2 stop content-engine 2>/dev/null; echo '   Stopped.'"

# ── 3. Sync files (excluding protected paths) ────────
echo ""
echo "📤 Syncing files to server..."

# Use rsync if available, fallback to scp
if command -v rsync &>/dev/null; then
  rsync -avz --delete \
    --exclude='.env' \
    --exclude='data/' \
    --exclude='logs/' \
    --exclude='node_modules/' \
    --exclude='content-engine/.venv/' \
    --exclude='content-engine/data/' \
    --exclude='content-engine/__pycache__/' \
    --exclude='**/__pycache__/' \
    --exclude='.git/' \
    "$LOCAL_DIR/" "$SERVER:$REMOTE_DIR/"
  echo "   ✅ rsync complete"
else
  echo "   ⚠️  rsync not found — using scp (slower)"
  # Sync key directories individually
  scp -r "$LOCAL_DIR/dist/" "$SERVER:$REMOTE_DIR/dist/"
  scp -r "$LOCAL_DIR/src/" "$SERVER:$REMOTE_DIR/src/"
  scp -r "$LOCAL_DIR/migrations/" "$SERVER:$REMOTE_DIR/migrations/"
  scp -r "$LOCAL_DIR/prompts/" "$SERVER:$REMOTE_DIR/prompts/"
  scp "$LOCAL_DIR/package.json" "$LOCAL_DIR/package-lock.json" "$LOCAL_DIR/tsconfig.json" "$LOCAL_DIR/ecosystem.config.js" "$SERVER:$REMOTE_DIR/"
  scp "$LOCAL_DIR/CHANGELOG.md" "$SERVER:$REMOTE_DIR/" 2>/dev/null || true

  # Content engine (excluding .venv and data)
  ssh "$SERVER" "mkdir -p $REMOTE_DIR/content-engine"
  scp -r "$LOCAL_DIR/content-engine/main.py" "$LOCAL_DIR/content-engine/config.py" "$LOCAL_DIR/content-engine/requirements.txt" "$SERVER:$REMOTE_DIR/content-engine/"
  for subdir in models routers searchers services; do
    ssh "$SERVER" "mkdir -p $REMOTE_DIR/content-engine/$subdir"
    # Only copy .py files, skip __pycache__
    find "$LOCAL_DIR/content-engine/$subdir" -name "*.py" -exec scp {} "$SERVER:$REMOTE_DIR/content-engine/$subdir/" \;
  done
  # Handle nested service dirs
  for nested in creative intelligence learning; do
    ssh "$SERVER" "mkdir -p $REMOTE_DIR/content-engine/services/$nested"
    find "$LOCAL_DIR/content-engine/services/$nested" -name "*.py" -exec scp {} "$SERVER:$REMOTE_DIR/content-engine/services/$nested/" \;
  done
  echo "   ✅ scp complete"
fi

# ── 4. Install/update dependencies on server ─────────
echo ""
echo "📥 Installing dependencies..."
ssh "$SERVER" "cd $REMOTE_DIR && npm ci --production 2>&1 | tail -1"
ssh "$SERVER" "cd $REMOTE_DIR/content-engine && source .venv/bin/activate && pip install -q -r requirements.txt 2>&1 | tail -3"
echo "   ✅ Dependencies updated"

# ── 5. Ensure protected directories exist ────────────
ssh "$SERVER" "mkdir -p $REMOTE_DIR/data/garmin-tokens $REMOTE_DIR/logs $REMOTE_DIR/content-engine/data"

# ── 6. Start services ────────────────────────────────
echo ""
echo "🟢 Starting services..."
ssh "$SERVER" "export PATH=\$PATH:$(dirname $PM2) && $PM2 start content-engine 2>/dev/null && $PM2 start telegram-hub-bot 2>/dev/null && $PM2 save && echo '   ✅ All services running'"

# ── 7. Health check ──────────────────────────────────
echo ""
echo "🏥 Health check..."
sleep 3
ssh "$SERVER" "curl -sf http://localhost:8100/health 2>/dev/null && echo ' ✅ Content engine OK' || echo ' ❌ Content engine FAIL'"
PORTAL_TOKEN=$(ssh "$SERVER" "grep -oP '(?<=^PORTAL_TOKEN=).+' $REMOTE_DIR/.env 2>/dev/null" || true)
if [ -n "$PORTAL_TOKEN" ]; then
  ssh "$SERVER" "curl -sf -H 'Authorization: Bearer $PORTAL_TOKEN' http://localhost:8200/api/snapshot 2>/dev/null | head -c 100 && echo ' ✅ Status portal OK' || echo ' ⚠️  Status portal not responding'"
else
  ssh "$SERVER" "curl -sf http://localhost:8200/api/snapshot 2>/dev/null | head -c 100 && echo ' ✅ Status portal OK' || echo ' ⚠️  Status portal not responding'"
fi
ssh "$SERVER" "export PATH=\$PATH:$(dirname $PM2) && $PM2 list | grep -E 'online|stopped'"

echo ""
echo "✅ Deploy complete!"
