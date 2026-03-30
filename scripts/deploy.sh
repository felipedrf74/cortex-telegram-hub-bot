#!/usr/bin/env bash
# ─────────────────────────────────────────────────────
# deploy.sh — Deploy telegram-hub-bot + content-engine
#              to the Linux server via rsync/scp
#
# PRESERVES on the server (never overwritten):
#   .env, data/, logs/, node_modules/, content-engine/.venv/
#
# Environment:
#   DEPLOY_SERVER   — SSH connection (default: dominguez@serverdominguez)
#   DEPLOY_PATH     — Remote path (default: /home/dominguez/telegram-hub-bot)
#   NOTION_TOKEN    — Notion API token (optional, for release logging)
#   NOTION_RELEASES_DB — Notion Releases DB ID (optional)
#
# Usage:  ./scripts/deploy.sh
# ─────────────────────────────────────────────────────
set -euo pipefail

SERVER="${DEPLOY_SERVER:-dominguez@serverdominguez}"
REMOTE_DIR="${DEPLOY_PATH:-/home/dominguez/telegram-hub-bot}"
LOCAL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PM2="/home/dominguez/.npm-global/bin/pm2"
NOTION_TOKEN="${NOTION_TOKEN:-}"
NOTION_RELEASES_DB="${NOTION_RELEASES_DB:-332ad49d-23e7-8134-b413-d8d3cc3f1a4a}"

echo "🚀 Deploying from: $LOCAL_DIR"
echo "   To: $SERVER:$REMOTE_DIR"
echo ""

VERSION=$(node -p "require('$LOCAL_DIR/package.json').version" 2>/dev/null || echo "unknown")
COMMIT=$(cd "$LOCAL_DIR" && git rev-parse --short HEAD 2>/dev/null || echo "unknown")
DEPLOY_STATUS="✅ Success"

# ── 1. Build TypeScript locally ──────────────────────
echo "📦 Building TypeScript..."
cd "$LOCAL_DIR"
npx tsc --noEmit 2>/dev/null && echo "   ✅ Type check passed" || { echo "   ❌ Type errors — aborting"; exit 1; }
npm run build 2>/dev/null && echo "   ✅ Build complete" || { echo "   ❌ Build failed — aborting"; exit 1; }

# ── 2. Backup on server ─────────────────────────────
echo ""
echo "💾 Creating backup on server..."
ssh "$SERVER" "
  BACKUP_DIR='/home/dominguez/backups/nexushub'
  TIMESTAMP=\$(date +%Y%m%d_%H%M%S)
  mkdir -p \"\$BACKUP_DIR\"
  tar czf \"\$BACKUP_DIR/v${VERSION}_\${TIMESTAMP}.tar.gz\" \
    -C '$REMOTE_DIR' \
    dist/ prompts/ migrations/ package.json package-lock.json ecosystem.config.js 2>/dev/null || true
  ls -t \"\$BACKUP_DIR\"/*.tar.gz 2>/dev/null | tail -n +11 | xargs rm -f 2>/dev/null || true
  echo '   ✅ Backup created'
" || echo "   ⚠️  Backup skipped"

# ── 3. Stop services on server ───────────────────────
echo ""
echo "🛑 Stopping services on server..."
ssh "$SERVER" "export PATH=\$PATH:$(dirname $PM2) && $PM2 stop telegram-hub-bot 2>/dev/null; $PM2 stop content-engine 2>/dev/null; echo '   Stopped.'"

# ── 4. Sync files (excluding protected paths) ────────
echo ""
echo "📤 Syncing files to server..."

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
  scp -r "$LOCAL_DIR/dist/" "$SERVER:$REMOTE_DIR/dist/"
  scp -r "$LOCAL_DIR/src/" "$SERVER:$REMOTE_DIR/src/"
  scp -r "$LOCAL_DIR/migrations/" "$SERVER:$REMOTE_DIR/migrations/"
  scp -r "$LOCAL_DIR/prompts/" "$SERVER:$REMOTE_DIR/prompts/"
  scp "$LOCAL_DIR/package.json" "$LOCAL_DIR/package-lock.json" "$LOCAL_DIR/tsconfig.json" "$LOCAL_DIR/ecosystem.config.js" "$SERVER:$REMOTE_DIR/"
  scp "$LOCAL_DIR/CHANGELOG.md" "$SERVER:$REMOTE_DIR/" 2>/dev/null || true
  ssh "$SERVER" "mkdir -p $REMOTE_DIR/content-engine"
  scp -r "$LOCAL_DIR/content-engine/main.py" "$LOCAL_DIR/content-engine/config.py" "$LOCAL_DIR/content-engine/requirements.txt" "$SERVER:$REMOTE_DIR/content-engine/"
  for subdir in models routers searchers services; do
    ssh "$SERVER" "mkdir -p $REMOTE_DIR/content-engine/$subdir"
    find "$LOCAL_DIR/content-engine/$subdir" -name "*.py" -exec scp {} "$SERVER:$REMOTE_DIR/content-engine/$subdir/" \;
  done
  for nested in creative intelligence learning; do
    ssh "$SERVER" "mkdir -p $REMOTE_DIR/content-engine/services/$nested"
    find "$LOCAL_DIR/content-engine/services/$nested" -name "*.py" -exec scp {} "$SERVER:$REMOTE_DIR/content-engine/services/$nested/" \;
  done
  echo "   ✅ scp complete"
fi

# ── 5. Install/update dependencies on server ─────────
echo ""
echo "📥 Installing dependencies..."
ssh "$SERVER" "cd $REMOTE_DIR && npm ci --production 2>&1 | tail -1"
ssh "$SERVER" "cd $REMOTE_DIR/content-engine && source .venv/bin/activate && pip install -q -r requirements.txt 2>&1 | tail -3"
echo "   ✅ Dependencies updated"

# ── 5b. Rebuild native modules for PM2's Node ────────
# PM2 daemon runs under Linuxbrew Node (25.x) while system node is 22.x.
# npm ci compiles native addons against system node, so we must rebuild
# for the Node version PM2 actually uses to spawn child processes.
echo ""
echo "🔧 Rebuilding native modules for PM2 Node..."
ssh "$SERVER" "
  PM2_PID=\$(cat ~/.pm2/pm2.pid 2>/dev/null)
  PM2_NODE=\$(readlink /proc/\$PM2_PID/exe 2>/dev/null)
  SYSTEM_NODE=\$(which node)
  if [ -n \"\$PM2_NODE\" ] && [ \"\$PM2_NODE\" != \"\$SYSTEM_NODE\" ]; then
    PM2_NODE_DIR=\$(dirname \"\$PM2_NODE\")
    echo \"   PM2 uses: \$PM2_NODE\"
    echo \"   System:   \$SYSTEM_NODE\"
    cd $REMOTE_DIR && PATH=\"\$PM2_NODE_DIR:\$PATH\" npm rebuild better-sqlite3 2>&1 | tail -1
    echo '   ✅ Native modules rebuilt for PM2 Node'
  else
    echo '   ✅ PM2 and system Node match — no rebuild needed'
  fi
"

# ── 6. Ensure protected directories exist ────────────
ssh "$SERVER" "mkdir -p $REMOTE_DIR/data/garmin-tokens $REMOTE_DIR/logs $REMOTE_DIR/content-engine/data"

# ── 7. Start services ────────────────────────────────
echo ""
echo "🟢 Starting services..."
ssh "$SERVER" "export PATH=\$PATH:$(dirname $PM2) && $PM2 start content-engine 2>/dev/null && $PM2 start telegram-hub-bot 2>/dev/null && $PM2 save && echo '   ✅ All services running'"

# ── 8. Health check (with retry) ─────────────────────
echo ""
echo "🏥 Health check (waiting 10s for startup)..."
sleep 10

HEALTH_OK=true

# Content engine
ssh "$SERVER" "curl -sf http://localhost:8100/health 2>/dev/null && echo ' ✅ Content engine OK' || echo ' ⚠️  Content engine not responding'"

# Portal
PORTAL_TOKEN=$(ssh "$SERVER" "grep -oP '(?<=^PORTAL_TOKEN=).+' $REMOTE_DIR/.env 2>/dev/null" || true)
if [ -n "$PORTAL_TOKEN" ]; then
  ssh "$SERVER" "curl -sf -H 'Authorization: Bearer $PORTAL_TOKEN' http://localhost:8200/api/snapshot 2>/dev/null | head -c 100 && echo ' ✅ Status portal OK' || echo ' ⚠️  Status portal not responding'"
else
  ssh "$SERVER" "curl -sf http://localhost:8200/api/snapshot 2>/dev/null | head -c 100 && echo ' ✅ Status portal OK' || echo ' ⚠️  Status portal not responding'"
fi

# Bot status with retry
BOT_STATUS=$(ssh "$SERVER" "export PATH=\$PATH:$(dirname $PM2) && $PM2 jlist 2>/dev/null | node -pe \"JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).find(p=>p.name==='telegram-hub-bot')?.pm2_env?.status\"" 2>/dev/null || echo "unknown")

if [ "$BOT_STATUS" != "online" ]; then
  echo " ⏳ Bot not ready yet, retrying in 5s..."
  sleep 5
  BOT_STATUS=$(ssh "$SERVER" "export PATH=\$PATH:$(dirname $PM2) && $PM2 jlist 2>/dev/null | node -pe \"JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).find(p=>p.name==='telegram-hub-bot')?.pm2_env?.status\"" 2>/dev/null || echo "unknown")
fi

if [ "$BOT_STATUS" = "online" ]; then
  echo " ✅ Bot: online"
else
  echo " ❌ Bot: $BOT_STATUS"
  echo "    Check logs: ssh $SERVER '$PM2 logs telegram-hub-bot --lines 30 --nostream'"
  DEPLOY_STATUS="❌ Failed"
  HEALTH_OK=false
fi

ssh "$SERVER" "export PATH=\$PATH:$(dirname $PM2) && $PM2 list | grep -E 'online|stopped'"

# ── 9. Log to Notion Releases DB ─────────────────────
echo ""
if [ -n "$NOTION_TOKEN" ]; then
  echo "📋 Logging deploy to Notion..."
  DEPLOY_DATE=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  AUTHOR=$(git config user.name 2>/dev/null || echo "Felipe")

  curl -s -X POST "https://api.notion.com/v1/pages" \
    -H "Authorization: Bearer $NOTION_TOKEN" \
    -H "Content-Type: application/json" \
    -H "Notion-Version: 2022-06-28" \
    -d "{
      \"parent\": { \"database_id\": \"$NOTION_RELEASES_DB\" },
      \"properties\": {
        \"Release\": { \"title\": [{ \"text\": { \"content\": \"v${VERSION}\" } }] },
        \"Status\": { \"select\": { \"name\": \"$DEPLOY_STATUS\" } },
        \"Type\": { \"select\": { \"name\": \"Deploy\" } },
        \"Environment\": { \"select\": { \"name\": \"Production\" } },
        \"Date\": { \"date\": { \"start\": \"$DEPLOY_DATE\" } },
        \"Commit\": { \"rich_text\": [{ \"text\": { \"content\": \"$COMMIT\" } }] },
        \"Author\": { \"rich_text\": [{ \"text\": { \"content\": \"$AUTHOR\" } }] },
        \"Notes\": { \"rich_text\": [{ \"text\": { \"content\": \"Manual deploy from Mac via deploy.sh\" } }] }
      }
    }" > /dev/null 2>&1 && echo "   ✅ Notion Releases DB updated" || echo "   ⚠️  Notion update failed"
else
  echo "📋 Skipping Notion log (set NOTION_TOKEN to enable)"
  echo "   NOTION_TOKEN=ntn_xxx ./scripts/deploy.sh"
fi

echo ""
echo "═══════════════════════════════════════════════"
if [ "$HEALTH_OK" = true ]; then
  echo "  ✅ Deploy complete! v${VERSION} (${COMMIT})"
else
  echo "  ⚠️  Deploy completed with warnings. Check services."
fi
echo "═══════════════════════════════════════════════"
