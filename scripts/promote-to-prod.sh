#!/usr/bin/env bash
# ─────────────────────────────────────────────────────
# promote-to-prod.sh — Promote a verified staging install to production
#
# Quarter audit item: Blue-green-lite "validated promote" pattern.
#
# True blue-green deploy (two parallel prod environments behind a load
# balancer with zero-downtime cutover) is genuinely impossible on this
# system today because:
#   1. Single VPS, no load balancer
#   2. Telegram bot has a UNIQUE long-polling lock per token — you
#      can't run two prod bots on the same token in parallel
#   3. Cron jobs would double-run if both environments were live,
#      corrupting user data (double-charged invoices, double-sent emails)
#
# What's possible AND useful: a "validated promote" pipeline that mirrors
# the spirit of blue-green within these constraints:
#
#   1. Code is built locally and shipped to STAGING via deploy-staging.sh
#   2. The full smoke-test suite runs against staging on port 8201
#   3. ONLY IF all smoke tests pass do we touch prod
#   4. Prod swap is the same fast restart as deploy.sh, but with the
#      knowledge that the EXACT same artifact is already running
#      green on staging
#   5. If prod fails to come up after the swap, rollback.sh is one
#      command away (use the auto-snapshot from restore.sh)
#
# This trades "zero downtime" for "verified-correct downtime". The
# 30-second prod restart window is the same as before, but now you've
# already proven the new code works on a fresh DB schema, against the
# same SQLite version, with the same Node version, etc.
#
# Workflow:
#   1. ./scripts/deploy-staging.sh           # ship code to staging
#   2. (let staging run for ~5 min)          # cron jobs fire at least once
#   3. ./scripts/promote-to-prod.sh          # this script
#      └─ runs staging-smoke.sh first
#      └─ if green, runs deploy.sh
#      └─ if deploy.sh fails health check, prints rollback instructions
#
# Usage:
#   ./scripts/promote-to-prod.sh             # runs the full pipeline
#   ./scripts/promote-to-prod.sh --skip-smoke  # SKIP the smoke test (DANGEROUS)
#   ./scripts/promote-to-prod.sh --dry-run     # show what would happen
# ─────────────────────────────────────────────────────
set -euo pipefail

LOCAL_DIR="$(cd "$(dirname "$0")/.." && pwd)"

SKIP_SMOKE=false
DRY_RUN=false

while [ $# -gt 0 ]; do
  case "$1" in
    --skip-smoke) SKIP_SMOKE=true; shift;;
    --dry-run)    DRY_RUN=true;    shift;;
    -h|--help)
      sed -n '2,55p' "$0" | sed 's/^# \?//'
      exit 0;;
    *)
      echo "Unknown arg: $1" >&2
      exit 1;;
  esac
done

echo "═══════════════════════════════════════════════"
echo "  🚀 Nexus Hub Promote to Production"
echo "═══════════════════════════════════════════════"
echo ""

# ── Prerequisite check: staging exists ──────────────
echo "🔍 Preflight checks..."
SERVER="${DEPLOY_SERVER:-dominguez@serverdominguez}"
STAGING_DIR="${STAGING_PATH:-/home/dominguez/telegram-hub-bot-staging}"
STAGING_EXISTS=$(ssh "$SERVER" "[ -d $STAGING_DIR ] && echo yes || echo no" 2>/dev/null || echo "no")
if [ "$STAGING_EXISTS" != "yes" ]; then
  echo "   ❌ Staging directory not found at $STAGING_DIR"
  echo "      First-time setup required. See STAGING.md."
  exit 1
fi
echo "   ✅ Staging install present"

# Check that the local working tree matches what's deployed to staging.
# We compare the SHA of dist/index.js — if they differ, the operator
# forgot to run deploy-staging.sh first and would be promoting an
# unvalidated artifact.
LOCAL_DIST_HASH=$(shasum -a 256 "$LOCAL_DIR/dist/index.js" 2>/dev/null | cut -d' ' -f1 || echo "missing")
STAGING_DIST_HASH=$(ssh "$SERVER" "shasum -a 256 $STAGING_DIR/dist/index.js 2>/dev/null | cut -d' ' -f1" || echo "missing")
if [ "$LOCAL_DIST_HASH" = "missing" ]; then
  echo "   ⚠️  No local dist/index.js — building..."
  cd "$LOCAL_DIR" && npm run build > /dev/null && LOCAL_DIST_HASH=$(shasum -a 256 dist/index.js | cut -d' ' -f1)
fi
if [ "$STAGING_DIST_HASH" = "missing" ]; then
  echo "   ❌ Staging has no dist/index.js — run ./scripts/deploy-staging.sh first"
  exit 1
fi
if [ "$LOCAL_DIST_HASH" != "$STAGING_DIST_HASH" ]; then
  echo "   ⚠️  Local and staging dist/ hashes differ:"
  echo "        local:   $LOCAL_DIST_HASH"
  echo "        staging: $STAGING_DIST_HASH"
  echo ""
  echo "   You're about to promote an artifact different from what's on staging."
  echo "   Run ./scripts/deploy-staging.sh first to sync them, OR continue if"
  echo "   you intentionally want to promote a different build."
  read -p "   Continue anyway? (type YES) " CONFIRM
  if [ "$CONFIRM" != "YES" ]; then
    echo "❌ Promote cancelled"
    exit 0
  fi
else
  echo "   ✅ Local and staging dist/ hashes match"
fi

# ── Smoke test gate ──────────────────────────────────
if [ "$SKIP_SMOKE" = true ]; then
  echo ""
  echo "⚠️  Skipping smoke test (--skip-smoke)"
  echo "   This is DANGEROUS — you're promoting unverified code to prod."
  read -p "   Are you sure? (type YES to continue) " CONFIRM
  if [ "$CONFIRM" != "YES" ]; then
    echo "❌ Promote cancelled"
    exit 0
  fi
else
  echo ""
  echo "🧪 Running staging smoke test..."
  if ! "$LOCAL_DIR/scripts/staging-smoke.sh"; then
    echo ""
    echo "❌ Smoke test failed — REFUSING to promote to prod."
    echo "   Fix the failing tests on staging first, then re-run this script."
    exit 1
  fi
fi

# ── Confirmation prompt ──────────────────────────────
echo ""
PROD_VERSION=$(ssh "$SERVER" "/usr/bin/node -p \"require('/home/dominguez/telegram-hub-bot/package.json').version\"" 2>/dev/null || echo "unknown")
LOCAL_VERSION=$(node -p "require('$LOCAL_DIR/package.json').version" 2>/dev/null || echo "unknown")
echo "   Current prod version:  v$PROD_VERSION"
echo "   Local working tree:    v$LOCAL_VERSION  ← will become prod"
echo ""
read -p "   Promote to production? (type YES to confirm) " CONFIRM
if [ "$CONFIRM" != "YES" ]; then
  echo "❌ Promote cancelled"
  exit 0
fi

if [ "$DRY_RUN" = true ]; then
  echo ""
  echo "🔍 [DRY RUN] Would now run ./scripts/deploy.sh"
  echo "   Skipping actual deploy."
  exit 0
fi

# ── Run the actual prod deploy ──────────────────────
# We delegate to deploy.sh because it already does everything correctly:
#   - npm version patch
#   - typecheck + build
#   - pm2 stop, backup (now includes bot.db post-QW-10)
#   - rsync to prod path
#   - npm ci, rebuild native modules
#   - pm2 start, health check
# The only thing promote-to-prod.sh adds on top is the smoke-test gate
# and the local↔staging hash check.
echo ""
echo "📦 Promoting to production via deploy.sh..."
echo ""
"$LOCAL_DIR/scripts/deploy.sh"
DEPLOY_EXIT=$?

if [ $DEPLOY_EXIT -ne 0 ]; then
  echo ""
  echo "═══════════════════════════════════════════════"
  echo "  ❌ PROMOTE FAILED"
  echo "═══════════════════════════════════════════════"
  echo ""
  echo "Production deploy failed. Rollback instructions:"
  echo "  ./scripts/rollback.sh                    # list available backups"
  echo "  ./scripts/rollback.sh --dry-run latest   # validate the latest backup"
  echo "  ./scripts/rollback.sh latest             # apply the latest backup"
  exit $DEPLOY_EXIT
fi

echo ""
echo "═══════════════════════════════════════════════"
echo "  ✅ PROMOTE COMPLETE"
echo "═══════════════════════════════════════════════"
echo ""
echo "Production is now running v$LOCAL_VERSION (was v$PROD_VERSION)."
echo "Staging is still on v$LOCAL_VERSION too — they're in sync."
echo ""
echo "To deploy a new change next time, the workflow is:"
echo "  1. git pull / make changes locally"
echo "  2. ./scripts/deploy-staging.sh   (ship to staging)"
echo "  3. (let staging soak for a few minutes)"
echo "  4. ./scripts/promote-to-prod.sh  (this script)"
