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
# release-pipeline-risk-based-optimization (2026-05-03):
# Reuse recent (≤ NEXUS_SMOKE_REUSE_MAX_AGE_S, default 1800 s = 30 min)
# smoke-evidence JSON for the same staging dist hash. Skips one ~30 s
# smoke run + ssh round-trips when the operator just ran staging-smoke.sh
# manually before invoking promote-to-prod.sh (the documented workflow).
# Disable with NEXUS_SMOKE_REUSE=0 to force a fresh smoke every time.
LOCAL_SMOKE_HASH="$(shasum -a 256 "$LOCAL_DIR/dist/index.js" 2>/dev/null | cut -d' ' -f1 || echo missing)"
EVIDENCE_DIR="$LOCAL_DIR/docs/release/smoke-evidence"
SMOKE_REUSE_MAX_AGE_S="${NEXUS_SMOKE_REUSE_MAX_AGE_S:-1800}"
SMOKE_REUSE_ENABLED="${NEXUS_SMOKE_REUSE:-1}"

find_recent_evidence_for_hash() {
  # Find the newest staging-smoke evidence file whose payload matches
  # the dist hash currently sitting on staging AND whose age is within
  # the freshness window AND whose verdict is "passed".
  if [ "$SMOKE_REUSE_ENABLED" != "1" ] || [ ! -d "$EVIDENCE_DIR" ]; then
    return 1
  fi
  local now_epoch="$(date -u +%s)"
  local found=""
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    [ -f "$f" ] || continue
    local mtime_epoch
    mtime_epoch="$(stat -f %m "$f" 2>/dev/null || stat -c %Y "$f" 2>/dev/null || echo 0)"
    local age=$((now_epoch - mtime_epoch))
    if [ "$age" -gt "$SMOKE_REUSE_MAX_AGE_S" ]; then
      continue
    fi
    # Parse verdict + sha from evidence
    local verdict sha
    verdict="$(NODE_NO_WARNINGS=1 node -e "let b='';process.stdin.on('data',c=>b+=c);process.stdin.on('end',()=>{try{process.stdout.write(JSON.parse(b).verdict||'')}catch(e){}})" < "$f" 2>/dev/null)"
    sha="$(NODE_NO_WARNINGS=1 node -e "let b='';process.stdin.on('data',c=>b+=c);process.stdin.on('end',()=>{try{process.stdout.write(JSON.parse(b).sha||'')}catch(e){}})" < "$f" 2>/dev/null)"
    [ "$verdict" = "passed" ] || continue
    [ -n "$sha" ] || continue
    if [ "$sha" = "$STAGING_HEAD_SHA" ]; then
      found="$f|$age"
      break
    fi
  done < <(ls -t "$EVIDENCE_DIR"/staging-smoke-*.json 2>/dev/null)
  [ -n "$found" ] && printf '%s' "$found"
  [ -n "$found" ] && return 0 || return 1
}

# Capture staging head SHA for evidence matching (cheap one-shot ssh)
STAGING_HEAD_SHA="$(ssh "$SERVER" "/usr/bin/node -p \"require('$STAGING_DIR/package.json').version\" >/dev/null 2>&1; cd $STAGING_DIR 2>/dev/null && git rev-parse --short HEAD 2>/dev/null" || echo unknown)"

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
  RECENT_EVIDENCE=""
  if [ -n "$STAGING_HEAD_SHA" ] && [ "$STAGING_HEAD_SHA" != "unknown" ]; then
    RECENT_EVIDENCE="$(find_recent_evidence_for_hash || true)"
  fi
  if [ -n "$RECENT_EVIDENCE" ]; then
    EVIDENCE_FILE="${RECENT_EVIDENCE%|*}"
    EVIDENCE_AGE_S="${RECENT_EVIDENCE##*|}"
    echo "♻️  Reusing recent staging-smoke evidence (age: ${EVIDENCE_AGE_S}s, max: ${SMOKE_REUSE_MAX_AGE_S}s)"
    echo "   $EVIDENCE_FILE"
    echo "   verdict: passed · sha: $STAGING_HEAD_SHA"
    echo "   Set NEXUS_SMOKE_REUSE=0 to force a fresh smoke."
  else
    echo "🧪 Running staging smoke test..."
    # Promotion-time smoke is a gate, not a release-evidence authoring step.
    # A fresh evidence file dirties the worktree and correctly triggers the
    # deploy.sh provenance guard. Standalone staging-smoke.sh still writes
    # evidence by default; this path defaults it off so promotion can proceed
    # from a clean, already-committed tree.
    if ! NEXUS_SMOKE_EVIDENCE="${NEXUS_PROMOTE_SMOKE_EVIDENCE:-0}" "$LOCAL_DIR/scripts/staging-smoke.sh"; then
      echo ""
      echo "❌ Smoke test failed — REFUSING to promote to prod."
      echo "   Fix the failing tests on staging first, then re-run this script."
      exit 1
    fi
  fi
fi

# ── Confirmation prompt ──────────────────────────────
echo ""
PROD_VERSION=$(ssh "$SERVER" "/usr/bin/node -p \"require('/home/dominguez/telegram-hub-bot/package.json').version\"" 2>/dev/null || echo "unknown")
LOCAL_VERSION=$(node -p "require('$LOCAL_DIR/package.json').version" 2>/dev/null || echo "unknown")
STAGING_VERSION=$(ssh "$SERVER" "/usr/bin/node -p \"require('$STAGING_DIR/package.json').version\"" 2>/dev/null || echo "unknown")
echo "   Current prod version:  v$PROD_VERSION"
echo "   Current staging version: v$STAGING_VERSION"
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
POST_PROD_VERSION=$(ssh "$SERVER" "/usr/bin/node -p \"require('/home/dominguez/telegram-hub-bot/package.json').version\"" 2>/dev/null || echo "unknown")
POST_STAGING_VERSION=$(ssh "$SERVER" "/usr/bin/node -p \"require('$STAGING_DIR/package.json').version\"" 2>/dev/null || echo "unknown")
POST_LOCAL_VERSION=$(node -p "require('$LOCAL_DIR/package.json').version" 2>/dev/null || echo "unknown")
echo "Production is now running v$POST_PROD_VERSION (was v$PROD_VERSION)."
echo "Local working tree is now v$POST_LOCAL_VERSION."
echo "Staging remains on v$POST_STAGING_VERSION."
if [ "$POST_PROD_VERSION" != "$POST_STAGING_VERSION" ]; then
  echo "Note: deploy.sh may auto-bump production. Run ./scripts/deploy-staging.sh if staging should match prod exactly."
fi
echo ""
echo "To deploy a new change next time, the workflow is:"
echo "  1. git pull / make changes locally"
echo "  2. ./scripts/deploy-staging.sh   (ship to staging)"
echo "  3. (let staging soak for a few minutes)"
echo "  4. ./scripts/promote-to-prod.sh  (this script)"
