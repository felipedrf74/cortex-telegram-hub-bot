#!/usr/bin/env bash
# ─────────────────────────────────────────────────────
# deploy-staging.sh — Deploy to the STAGING environment
#
# Quarter audit item: Staging environment + Blue-green deploy.
#
# This script ships the current local working tree to /home/dominguez/
# telegram-hub-bot-staging/ on the same server that runs production. Both
# installs run side-by-side under PM2:
#
#   prod:    nexus-hub                + content-engine          (8200/8100)
#   staging: nexus-hub-staging        + content-engine-staging  (8201/8101)
#
# What it does (and DOES NOT do):
#   ✅ Type-checks + builds locally before touching the server
#   ✅ Rsyncs to the staging install path (NEVER touches the prod path)
#   ✅ Restarts ONLY the staging PM2 apps — prod is untouched
#   ✅ Health-checks staging on port 8201
#   ✅ Bumps NO version number (staging deploys are not releases)
#   ✅ Creates the staging directory if it doesn't exist (first run)
#   ❌ Does NOT update prod
#   ❌ Does NOT modify the staging .env file (managed manually)
#   ❌ Does NOT push to git
#
# First-time setup on the server (one-time, manual):
#   1. mkdir -p /home/dominguez/telegram-hub-bot-staging/{data,logs}
#   2. cp /home/dominguez/telegram-hub-bot/.env /home/dominguez/telegram-hub-bot-staging/.env
#   3. Edit the staging .env:
#        - TELEGRAM_BOT_TOKEN=<a SECOND bot from @BotFather>  (or leave empty)
#        - DATABASE_PATH=/home/dominguez/telegram-hub-bot-staging/data/bot.db
#        - PORTAL_PORT=8201
#        - CONTENT_ENGINE_PORT=8101
#        - PORTAL_TOKEN=<different token than prod, please>
#        - All API keys can be the SAME as prod (Anthropic, Google, etc.)
#          BUT consider lower rate limits or a separate Anthropic project.
#   4. Start the python venv:
#        cd /home/dominguez/telegram-hub-bot-staging/content-engine
#        python3.12 -m venv .venv && source .venv/bin/activate
#        pip install -r requirements.txt
#   5. First deploy: ./scripts/deploy-staging.sh
#   6. pm2 start /home/dominguez/telegram-hub-bot-staging/ecosystem.staging.config.js
#   7. pm2 save
#
# Subsequent deploys are just: ./scripts/deploy-staging.sh
#
# Usage:
#   ./scripts/deploy-staging.sh
# ─────────────────────────────────────────────────────
set -euo pipefail
umask 077

SERVER="${DEPLOY_SERVER:-dominguez@serverdominguez}"
STAGING_DIR="${STAGING_PATH:-/home/dominguez/telegram-hub-bot-staging}"
LOCAL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "$LOCAL_DIR/scripts/lib/release-gates.sh"
PM2="/home/dominguez/.npm-global/bin/pm2"
trap release_cleanup_all_locks EXIT
release_require_git_worktree "$LOCAL_DIR"
release_acquire_local_lock "$LOCAL_DIR" "staging-deploy"

echo "═══════════════════════════════════════════════"
echo "  🚧 Nexus Hub Staging Deploy"
echo "═══════════════════════════════════════════════"
echo "   Local:  $LOCAL_DIR"
echo "   Remote: $SERVER:$STAGING_DIR"
echo ""

# ── 1. Build TypeScript locally ──────────────────────
echo "📦 Building TypeScript..."
cd "$LOCAL_DIR"
npx tsc --noEmit 2>&1 | tail -3 && echo "   ✅ Type check passed" || { echo "   ❌ Type errors — aborting"; exit 1; }
npm run build 2>&1 | tail -3 && echo "   ✅ Build complete" || { echo "   ❌ Build failed — aborting"; exit 1; }
STAGING_BUILD_MANIFEST_DIGEST=$(node scripts/release-artifact-manifest.mjs --digest)
echo "   Artifact digest: $STAGING_BUILD_MANIFEST_DIGEST"

# ── 2. Ensure staging directory structure exists ─────
# First-run safe: creates the dirs if they don't exist, no-op otherwise.
echo ""
echo "📁 Ensuring staging directory exists..."
ssh "$SERVER" "mkdir -p $STAGING_DIR/data/garmin-tokens $STAGING_DIR/logs $STAGING_DIR/content-engine/data"

# ── 2a. Validate staging .env has all required keys (audit W2-10) ────
# Fails fast if an operator removed/typo'd a required key. Without this
# check, a broken .env ships silently: PM2 starts, the bot fails to
# initialize, and the only signal is the process crash looping in the
# logs — which was only noticed after a promote attempt. We check the
# five keys that the bot refuses to boot without.
echo ""
echo "🔑 Validating staging .env..."
ENV_CHECK=$(ssh "$SERVER" "
  set -e
  if [ ! -f $STAGING_DIR/.env ]; then
    echo 'MISSING_FILE'
    exit 0
  fi
  ENV_MODE=\$(stat -c '%a' $STAGING_DIR/.env 2>/dev/null || stat -f '%Lp' $STAGING_DIR/.env 2>/dev/null || echo unknown)
  case \"\$ENV_MODE\" in
    400|600) ;;
    *) echo \"BAD_MODE:\$ENV_MODE\"; exit 0 ;;
  esac
  ENV_OWNER=\$(stat -c '%U' $STAGING_DIR/.env 2>/dev/null || stat -f '%Su' $STAGING_DIR/.env 2>/dev/null || echo unknown)
  CURRENT_OWNER=\$(id -un)
  if [ \"\$ENV_OWNER\" != \"\$CURRENT_OWNER\" ]; then
    echo \"BAD_OWNER:\$ENV_OWNER:expected:\$CURRENT_OWNER\"
    exit 0
  fi
  MISSING=''
  for KEY in DATABASE_PATH PORTAL_PORT CONTENT_ENGINE_PORT PORTAL_TOKEN OAUTH_ENCRYPTION_KEY INTERNAL_API_SECRET AI_CALL_TIMEOUT_MS; do
    if ! grep -qE \"^\${KEY}=.+\" $STAGING_DIR/.env; then
      MISSING=\"\$MISSING \$KEY\"
    fi
  done
  if ! grep -qE '^NEXUS_BACKEND_BASE_URL=.+' $STAGING_DIR/.env && ! grep -qE '^NEXUS_BACKEND_PORT=.+' $STAGING_DIR/.env; then
    MISSING=\"\$MISSING NEXUS_BACKEND_BASE_URL_OR_NEXUS_BACKEND_PORT\"
  fi
  if ! grep -qE '^GEMINI_API_KEY=.+' $STAGING_DIR/.env && ! grep -qE '^OPENAI_API_KEY=.+' $STAGING_DIR/.env; then
    MISSING=\"\$MISSING GEMINI_API_KEY_OR_OPENAI_API_KEY\"
  fi
  if [ -n \"\$MISSING\" ]; then
    echo \"MISSING_KEYS:\$MISSING\"
  else
    echo OK
  fi
")
case "$ENV_CHECK" in
  MISSING_FILE)
    echo "   ❌ No staging .env file at $STAGING_DIR/.env — see first-time setup in header"
    exit 1
    ;;
  BAD_MODE:*)
    echo "   ❌ Staging .env has unsafe permissions (${ENV_CHECK#BAD_MODE:}); require 400 or 600"
    exit 1
    ;;
  BAD_OWNER:*)
    echo "   ❌ Staging .env has unsafe owner (${ENV_CHECK#BAD_OWNER:})"
    exit 1
    ;;
  MISSING_KEYS:*)
    echo "   ❌ Staging .env is missing required keys:${ENV_CHECK#MISSING_KEYS:}"
    echo "      Edit $STAGING_DIR/.env and ensure each key has a non-empty value."
    exit 1
    ;;
  OK)
    echo "   ✅ All required keys present"
    ;;
  *)
    echo "   ⚠️  Unexpected .env validator output: $ENV_CHECK — proceeding cautiously"
    ;;
esac

PRE_RSYNC_MANIFEST_DIGEST=$(node scripts/release-artifact-manifest.mjs --digest)
if [ "$PRE_RSYNC_MANIFEST_DIGEST" != "$STAGING_BUILD_MANIFEST_DIGEST" ]; then
  echo "   ❌ Artifact digest changed after build:"
  echo "      post-build: $STAGING_BUILD_MANIFEST_DIGEST"
  echo "      pre-rsync:   $PRE_RSYNC_MANIFEST_DIGEST"
  exit 1
fi

release_acquire_remote_lock "$SERVER" "$STAGING_DIR" "staging-deploy"

# ── 3. Stop staging services (if running) ────────────
# Use `|| true` because the apps may not be registered with PM2 yet on
# first deploy. We never touch prod (nexus-hub / content-engine).
echo ""
echo "🛑 Stopping staging services (if running)..."
ssh "$SERVER" "export PATH=\$PATH:$(dirname $PM2) && $PM2 stop nexus-hub-staging 2>/dev/null || true; $PM2 stop content-engine-staging 2>/dev/null || true"

# ── 4. Sync files to staging path ────────────────────
# Same exclusions as prod deploy, except:
#   - We DO copy the ecosystem.staging.config.js (prod deploy doesn't need it)
#   - The destination is the staging path, not the prod path
#   - We preserve .env, data/, logs/, .venv (managed manually on staging)
echo ""
echo "📤 Syncing files to staging..."
  rsync -avz --delete \
    --exclude='.env' \
    --exclude='.env.*' \
    --exclude='.local/' \
    --exclude='.local/**' \
    --exclude='.deploy.lock' \
    --exclude='.DS_Store' \
    --exclude='.db.sqlite' \
    --exclude='*.db' \
    --exclude='data/' \
    --exclude='logs/' \
    --exclude='node_modules' \
    --exclude='node_modules/' \
    --exclude='content-engine/.venv/' \
    --exclude='content-engine/data/' \
    --exclude='content-engine/__pycache__/' \
    --exclude='**/__pycache__/' \
    --exclude='.claude/' \
    --exclude='.claude/**' \
    --exclude='.claude/worktrees/' \
    --exclude='.claude/worktrees/**' \
    --exclude='.codex/' \
    --exclude='.codex/**' \
    --exclude='.git' \
    --exclude='.git/' \
    --exclude='ecosystem.config.js' \
  "$LOCAL_DIR/" "$SERVER:$STAGING_DIR/" 2>&1 | tail -5
echo "   ✅ rsync complete"

# ── 5. Install dependencies on staging install ───────
# Each install has its OWN node_modules and .venv — NO sharing with prod.
echo ""
echo "📥 Installing dependencies..."
ssh "$SERVER" "set -euo pipefail; cd $STAGING_DIR && npm ci --production 2>&1 | tail -1"
ssh "$SERVER" "set -euo pipefail; cd $STAGING_DIR/content-engine && if [ -d .venv ]; then source .venv/bin/activate && pip install -q -r requirements.txt 2>&1 | tail -1; else echo '   ⚠️  No staging .venv yet — see first-time setup in deploy-staging.sh header'; fi"
echo "   ✅ Dependencies updated"

# ── 5a. Owner bootstrap preflight (warn-only) ────────
# Staging can run without a production-ready owner bootstrap, but we still
# want the signal visible before restart.
echo ""
echo "🧭 Verifying owner bootstrap on staging..."
ssh "$SERVER" "cd $STAGING_DIR && node dist/tools/owner-bootstrap-preflight.js || true"

# ── 6. Rebuild native modules against system Node ────
# Same reason as prod deploy: PM2 daemon runs under brew Node but child
# processes run under /usr/bin/node, so better-sqlite3 must be rebuilt
# against the child Node version.
echo ""
echo "🔧 Rebuilding native modules..."
ssh "$SERVER" "
  if [ -x /usr/bin/node ]; then
    set -euo pipefail
    cd $STAGING_DIR && PATH=/usr/bin:\$PATH /usr/bin/npm rebuild better-sqlite3 2>&1 | tail -1
    echo '   ✅ Native modules rebuilt'
  fi
"

# ── 7. Start staging services ────────────────────────
# If the PM2 entries already exist, restart them. If not (first deploy),
# the user has to run `pm2 start ecosystem.staging.config.js` manually
# from the staging dir — see the header comment.
echo ""
echo "🟢 Starting staging services..."
ssh "$SERVER" "
  export PATH=\$PATH:$(dirname $PM2)
  if $PM2 describe nexus-hub-staging > /dev/null 2>&1; then
    $PM2 start content-engine-staging 2>/dev/null || true
    $PM2 start nexus-hub-staging
    $PM2 save
    echo '   ✅ Staging running'
  else
    echo '   ⚠️  PM2 entries not registered yet.'
    echo '   First-time setup: ssh in and run:'
    echo '     cd $STAGING_DIR && pm2 start ecosystem.staging.config.js && pm2 save'
  fi
"

# ── 8. Health check ──────────────────────────────────
# IMPORTANT: do NOT pipe curl into `head` here — `head` always succeeds
# even on empty input, which would mask curl's failure exit code via the
# && chain and the script would print "OK" when nothing is actually
# listening. We use curl -o /dev/null and check $? directly instead.
echo ""
echo "🏥 Health check (waiting 10s for startup)..."
sleep 10

# Content engine
ssh "$SERVER" "
  if curl -sf -o /dev/null http://localhost:8101/health 2>/dev/null; then
    echo ' ✅ Staging content engine OK'
  else
    echo ' ⚠️  Staging content engine not responding (port 8101)'
  fi
"

# Portal — staging may require signed portal sessions instead of the legacy
# PORTAL_TOKEN. Hit /api/snapshot (not /health) because /health returns 503
# when status is "degraded", which is expected for staging-without-bot.
PORTAL_REQUIRE_SESSION_AUTH=$(ssh "$SERVER" "grep -oP '(?<=^PORTAL_REQUIRE_SESSION_AUTH=).+' $STAGING_DIR/.env 2>/dev/null" || true)
if [ "$PORTAL_REQUIRE_SESSION_AUTH" = "true" ]; then
  STAGING_SESSION=$(ssh "$SERVER" "
    set -e
    cd $STAGING_DIR
    set -a
    . ./.env
    set +a
    node dist/tools/portal-session-token.js --actor deploy-staging@nexushub.me --scope admin --ttl-ms 600000 --json \
      | node -e \"let b=''; process.stdin.on('data', c => b += c); process.stdin.on('end', () => { const j = JSON.parse(b); process.stdout.write(j.token || ''); });\"
  " 2>/dev/null || true)
  ssh "$SERVER" "
    if curl -sf -o /dev/null -H 'x-portal-session: ${STAGING_SESSION:-x}' http://localhost:8201/api/snapshot 2>/dev/null; then
      echo ' ✅ Staging portal OK'
    else
      echo ' ⚠️  Staging portal not responding (port 8201)'
    fi
  "
else
  STAGING_TOKEN=$(ssh "$SERVER" "grep -oP '(?<=^PORTAL_TOKEN=).+' $STAGING_DIR/.env 2>/dev/null" || true)
  ssh "$SERVER" "
    if curl -sf -o /dev/null -H 'Authorization: Bearer ${STAGING_TOKEN:-x}' http://localhost:8201/api/snapshot 2>/dev/null; then
      echo ' ✅ Staging portal OK'
    else
      echo ' ⚠️  Staging portal not responding (port 8201)'
    fi
  "
fi

echo ""
echo "🧭 Staging readiness check..."
"$LOCAL_DIR/scripts/deploy-readiness-check.sh" --target staging --server "$SERVER" --remote-dir "$STAGING_DIR"

echo ""
echo "═══════════════════════════════════════════════"
echo "  ✅ Staging deploy complete"
echo "═══════════════════════════════════════════════"
echo ""
echo "URLs (from inside the server):"
echo "  Staging portal:        http://localhost:8201"
echo "  Staging content-engine: http://localhost:8101"
echo ""
echo "PM2 commands:"
echo "  pm2 logs nexus-hub-staging --nostream --lines 50"
echo "  pm2 restart nexus-hub-staging"
echo "  pm2 stop nexus-hub-staging"
echo ""
echo "Production was NOT touched. To deploy to prod, run ./scripts/deploy.sh"
