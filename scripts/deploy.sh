#!/usr/bin/env bash
# ─────────────────────────────────────────────────────
# deploy.sh — Deploy nexus-hub + content-engine
# TODO: Rename server directory /home/dominguez/telegram-hub-bot → /home/dominguez/nexus-hub
#              to the Linux server via rsync/scp
#
# PRESERVES on the server (never overwritten):
#   .env, data/, logs/, node_modules/, content-engine/.venv/
#
# Environment:
#   DEPLOY_SERVER   — SSH connection (default: dominguez@serverdominguez)
#   DEPLOY_PATH     — Remote path (default: /home/dominguez/telegram-hub-bot)  # TODO: rename to nexus-hub
#   NOTION_TOKEN    — Notion API token (optional, for release logging)
#   NOTION_RELEASES_DB — Notion Releases DB ID (optional)
#
# Usage:  ./scripts/deploy.sh
# ─────────────────────────────────────────────────────
set -euo pipefail
umask 077

SERVER="${DEPLOY_SERVER:-dominguez@serverdominguez}"
REMOTE_DIR="${DEPLOY_PATH:-/home/dominguez/telegram-hub-bot}"
LOCAL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "$LOCAL_DIR/scripts/lib/release-gates.sh"
PM2="/home/dominguez/.npm-global/bin/pm2"
NOTION_TOKEN="${NOTION_TOKEN:-}"
NOTION_RELEASES_DB="${NOTION_RELEASES_DB:-332ad49d-23e7-8134-b413-d8d3cc3f1a4a}"
SKIP_MODE="${NEXUS_DEPLOY_SKIP_VERIFY:-0}"
AUDIT_LOG="${NEXUS_RELEASE_AUDIT_LOG:-$LOCAL_DIR/.local/release/override-audit.jsonl}"
DEPLOY_MUTATION_MARKER="${NEXUS_DEPLOY_MUTATION_MARKER:-/tmp/nexus-deploy-prod-mutation-started}"

# release-pipeline-risk-based-optimization (2026-05-03) — Round 3:
# --dry-run mode exercises every gate (env validation, typecheck/verify
# decision, build, version-bump preview, backup plan) WITHOUT actually
# touching the server, the git tree, or PM2. Useful for rehearsing a
# risky deploy or auditing the gate chain.
DRY_RUN="${NEXUS_DEPLOY_DRY_RUN:-0}"
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
  esac
done

if [ "$DRY_RUN" = "1" ]; then
  echo "🟡 DRY RUN — no server, git, or PM2 mutations will occur"
  echo ""
fi

echo "🚀 Deploying from: $LOCAL_DIR"
echo "   To: $SERVER:$REMOTE_DIR"
echo ""

# ── 0. VALIDATE FIRST — before any git operations ────
# This is the safety gate. Historically `deploy.sh` re-ran the full
# `npm run verify` (typecheck + full Vitest) here, even though pre-push
# had already enforced both on the same SHA and `staging-smoke.sh`
# validates the deployed artifact. That redundancy adds ~9 min per
# deploy with zero incremental signal (release-pipeline-risk-based-
# optimization audit, 2026-05-03).
#
# Behavior modes (all preserve the safety contract: nothing risky runs
# until typecheck passes):
#
#   default                                 → full verify (legacy behavior)
#   NEXUS_DEPLOY_SKIP_VERIFY=1              → typecheck only; trust the
#                                             pre-push + staging-smoke
#                                             chain. Saves ~9 min/deploy.
#   NEXUS_DEPLOY_SKIP_VERIFY=auto-when-staged
#                                           → typecheck only IFF the
#                                             local↔staging dist hashes
#                                             match (verified by
#                                             promote-to-prod.sh before
#                                             this script is invoked).
#                                             Falls back to full verify
#                                             otherwise.
#
# Owner approval required to flip the project default to a non-empty
# NEXUS_DEPLOY_SKIP_VERIFY in `.env` or shell config. The script itself
# defaults to legacy behavior so accidental rollouts are safe.
cd "$LOCAL_DIR"
rm -f "$DEPLOY_MUTATION_MARKER"
trap release_cleanup_all_locks EXIT
release_require_git_worktree "$LOCAL_DIR"
release_acquire_local_lock "$LOCAL_DIR" "prod-deploy"

audit_override() {
  local flag="$1"
  local reason="${NEXUS_EMERGENCY_SKIP_REASON:-}"
  mkdir -p "$(dirname "$AUDIT_LOG")"
  node -e '
    const fs = require("fs");
    const entry = {
      ts: new Date().toISOString(),
      flag: process.argv[1],
      reason: process.argv[2],
      user: process.env.USER || process.env.LOGNAME || "unknown",
      sha: process.argv[3],
      branch: process.argv[4],
      script: "deploy.sh",
    };
    fs.appendFileSync(process.argv[5], JSON.stringify(entry) + "\n");
  ' "$flag" "$reason" "$(git rev-parse HEAD 2>/dev/null || echo unknown)" "$(git branch --show-current 2>/dev/null || echo unknown)" "$AUDIT_LOG"
}

require_emergency_reason() {
  local flag="$1"
  if [ -z "${NEXUS_EMERGENCY_SKIP_REASON:-}" ]; then
    echo "❌ $flag requires NEXUS_EMERGENCY_SKIP_REASON"
    exit 1
  fi
  audit_override "$flag"
}

ensure_clean_deploy_tree() {
  if [ "${NEXUS_DEPLOY_ALLOW_DIRTY:-0}" = "1" ]; then
    require_emergency_reason "NEXUS_DEPLOY_ALLOW_DIRTY"
    case "$SKIP_MODE" in
      1|true|yes|auto-when-staged)
        echo "❌ Dirty production deploys cannot reuse evidence or skip full verification."
        echo "   Set NEXUS_DEPLOY_SKIP_VERIFY=0 for a dirty hotfix deploy."
        exit 1
        ;;
    esac
  else
    local status
    if ! status="$(release_git_status_porcelain "$LOCAL_DIR")"; then
      echo "❌ Could not read git status. Refusing to deploy."
      echo "   Check .git/config; core.bare must be false."
      exit 1
    fi
    if [ -n "$status" ]; then
      echo "❌ Working tree has uncommitted changes. Refusing to deploy."
      echo "   Either commit, stash, or set NEXUS_DEPLOY_ALLOW_DIRTY=1 to override."
      echo "   Override is sometimes correct for hotfixes, but /api/snapshot"
      echo "   GIT_COMMIT will not reflect the deployed code."
      exit 1
    fi
  fi
}

restore_deploy_generated_artifacts() {
  if [ "${NEXUS_DEPLOY_ALLOW_DIRTY:-0}" = "1" ]; then
    return
  fi

  local shadow_parity_report="docs/release/eval-evidence/registry-shadow-parity-latest.json"
  local status
  if ! status="$(release_git_status_porcelain "$LOCAL_DIR" -- "$shadow_parity_report")"; then
    echo "❌ Could not read git status for generated artifacts. Refusing to deploy."
    exit 1
  fi
  if [ -n "$status" ]; then
    echo "♻️  Restoring deploy-generated shadow parity evidence"
    git restore -- "$shadow_parity_report"
  fi
}

restore_deploy_generated_artifacts
ensure_clean_deploy_tree

if [ "${NEXUS_DEPLOY_SKIP_VERIFY:-0}" = "1" ] || [ "${NEXUS_DEPLOY_SKIP_VERIFY:-0}" = "true" ] || [ "${NEXUS_DEPLOY_SKIP_VERIFY:-0}" = "yes" ]; then
  require_emergency_reason "NEXUS_DEPLOY_SKIP_VERIFY"
fi

if [ -d "$LOCAL_DIR/migrations" ]; then
  echo "🗃️  Checking migration safety policy..."
  node scripts/migration-safety-check.mjs --base "${NEXUS_DEPLOY_BASE_REF:-origin/main}" --changed-only
fi

run_full_verify() {
  echo "🔍 Running full validation (typecheck + tests)..."
  # Deploy validation must not refresh tracked observational evidence files.
  # Those artifacts are intentionally updated by explicit QA/evidence runs, not
  # by the release transport path after the clean-tree guard has passed.
  if NEXUS_SKIP_SHADOW_PARITY_WRITE="${NEXUS_SKIP_SHADOW_PARITY_WRITE:-1}" npm run verify 2>&1; then
    echo ""
    echo "═══════════════════════════════════════════════"
    echo "  ✅ VALIDATION PASSED — proceeding with deploy"
    echo "═══════════════════════════════════════════════"
    echo ""
  else
    echo ""
    echo "═══════════════════════════════════════════════"
    echo "  ❌ VALIDATION FAILED — deploy aborted"
    echo "  Fix type errors or failing tests, then retry."
    echo "═══════════════════════════════════════════════"
    exit 1
  fi
}

run_typecheck_only() {
  echo "🔍 Running typecheck-only validation (NEXUS_DEPLOY_SKIP_VERIFY=$SKIP_MODE)..."
  if npx tsc --noEmit; then
    echo ""
    echo "═══════════════════════════════════════════════"
    echo "  ✅ TYPECHECK PASSED — skipping full vitest"
    echo "  (pre-push + staging-smoke already validated this SHA)"
    echo "═══════════════════════════════════════════════"
    echo ""
  else
    echo ""
    echo "═══════════════════════════════════════════════"
    echo "  ❌ TYPECHECK FAILED — deploy aborted"
    echo "═══════════════════════════════════════════════"
    exit 1
  fi
}

require_current_rollback_drill() {
  echo "🧯 Checking current rollback drill evidence before release evidence reuse..."
  node scripts/rollback-drill-check.mjs --json > /tmp/nexus-rollback-drill-check.json
  cat /tmp/nexus-rollback-drill-check.json
}

case "$SKIP_MODE" in
  1|true|yes)
    run_typecheck_only
    ;;
  auto-when-staged)
    if [ "${NEXUS_RELEASE_EVIDENCE_REUSE_ENABLED:-0}" != "1" ]; then
      echo "🟡 auto-when-staged requested, but evidence reuse is still in shadow."
      echo "   Set NEXUS_RELEASE_EVIDENCE_REUSE_ENABLED=1 only after 3 clean RCs."
      if node scripts/release-evidence.mjs validate --json > /tmp/nexus-release-evidence-shadow.json 2>/tmp/nexus-release-evidence-shadow.err; then
        echo "   Shadow evidence check: MATCH"
        cat /tmp/nexus-release-evidence-shadow.json
      else
        echo "   Shadow evidence check: no match"
        cat /tmp/nexus-release-evidence-shadow.err 2>/dev/null || true
        cat /tmp/nexus-release-evidence-shadow.json 2>/dev/null || true
      fi
      run_full_verify
    elif node scripts/release-evidence.mjs validate --json > /tmp/nexus-release-evidence-validate.json 2>/tmp/nexus-release-evidence-validate.err; then
      require_current_rollback_drill
      echo "🔁 NEXUS_DEPLOY_SKIP_VERIFY=auto-when-staged: release evidence matches SHA + manifest digest — typecheck only"
      cat /tmp/nexus-release-evidence-validate.json
      run_typecheck_only
    else
      echo "🔁 NEXUS_DEPLOY_SKIP_VERIFY=auto-when-staged: no matching release evidence — full verify"
      cat /tmp/nexus-release-evidence-validate.err 2>/dev/null || true
      cat /tmp/nexus-release-evidence-validate.json 2>/dev/null || true
      run_full_verify
    fi
    ;;
  0|false|no|"")
    if node scripts/release-evidence.mjs validate --json > /tmp/nexus-release-evidence-shadow.json 2>/tmp/nexus-release-evidence-shadow.err; then
      echo "🟡 Release evidence shadow check: MATCH (strict deploy still runs full verify during shadow period)"
      cat /tmp/nexus-release-evidence-shadow.json
    else
      echo "🟡 Release evidence shadow check: no reusable evidence yet (expected during shadow period)"
      cat /tmp/nexus-release-evidence-shadow.err 2>/dev/null || true
      cat /tmp/nexus-release-evidence-shadow.json 2>/dev/null || true
    fi
    run_full_verify
    ;;
  *)
    echo "⚠️  Unrecognized NEXUS_DEPLOY_SKIP_VERIFY='$SKIP_MODE' — defaulting to full verify"
    run_full_verify
    ;;
esac

restore_deploy_generated_artifacts
ensure_clean_deploy_tree

# ── 1. Build TypeScript locally ──────────────────────
echo "📦 Building TypeScript..."
npm run build 2>/dev/null && echo "   ✅ Build complete" || { echo "   ❌ Build failed — aborting"; exit 1; }
POST_BUILD_MANIFEST_DIGEST=$(node scripts/release-artifact-manifest.mjs --digest)
echo "   Artifact digest: $POST_BUILD_MANIFEST_DIGEST"
if [ "$SKIP_MODE" = "auto-when-staged" ] && [ "${NEXUS_RELEASE_EVIDENCE_REUSE_ENABLED:-0}" = "1" ]; then
  echo "🔁 Re-validating signed release evidence against post-build artifact..."
  node scripts/release-evidence.mjs validate --expect-sha "$(git rev-parse HEAD)" --json >/tmp/nexus-release-evidence-post-build.json
  cat /tmp/nexus-release-evidence-post-build.json
fi

# Dry-run early-exit: everything below this line touches the server, the
# git tree, or PM2. Stop here for the rehearsal mode.
if [ "$DRY_RUN" = "1" ]; then
  echo ""
  echo "═══════════════════════════════════════════════"
  echo "  🟡 DRY RUN — would now do:"
  echo "       1a) ssh validate prod .env"
  echo "       1b) confirm package version already prepared by scripts/release-prep.sh"
  echo "       2)  ssh \$SERVER pm2 stop nexus-hub + content-engine"
  echo "       2b) ssh \$SERVER tar backup of dist + bot.db"
  echo "       3b) ssh \$SERVER drain port 8200"
  echo "       4)  rsync to \$SERVER:$REMOTE_DIR"
  echo "       5)  ssh \$SERVER npm ci + pip install"
  echo "       5a) ssh \$SERVER owner-bootstrap-preflight --strict"
  echo "       5b) ssh \$SERVER rebuild native modules"
  echo "       6)  ssh \$SERVER mkdir protected dirs"
  echo "       7)  ssh \$SERVER pm2 start"
  echo "       8)  health checks (curl + pm2 jlist)"
  echo "       9)  Notion log (if NOTION_TOKEN set)"
  echo ""
  echo "  ✅ Validation/build phase passed; no server mutations performed."
  echo "  Re-run without --dry-run (or unset NEXUS_DEPLOY_DRY_RUN) to deploy."
  echo "═══════════════════════════════════════════════"
  release_cleanup_all_locks
  exit 0
fi

# ── 1a. Validate production .env before deploy ─────────
# The Python content-engine calls the TS AI proxy for script synthesis.
# If INTERNAL_API_SECRET or the backend URL/port is missing, script
# generation silently degrades into fallback templates. Fail fast here.
echo ""
echo "🔑 Validating production .env..."
ENV_CHECK=$(ssh "$SERVER" "
  set -e
  if [ ! -f $REMOTE_DIR/.env ]; then
    echo 'MISSING_FILE'
    exit 0
  fi
  ENV_MODE=\$(stat -c '%a' $REMOTE_DIR/.env 2>/dev/null || stat -f '%Lp' $REMOTE_DIR/.env 2>/dev/null || echo unknown)
  case \"\$ENV_MODE\" in
    400|600) ;;
    *) echo \"BAD_MODE:\$ENV_MODE\"; exit 0 ;;
  esac
  ENV_OWNER=\$(stat -c '%U' $REMOTE_DIR/.env 2>/dev/null || stat -f '%Su' $REMOTE_DIR/.env 2>/dev/null || echo unknown)
  CURRENT_OWNER=\$(id -un)
  if [ \"\$ENV_OWNER\" != \"\$CURRENT_OWNER\" ]; then
    echo \"BAD_OWNER:\$ENV_OWNER:expected:\$CURRENT_OWNER\"
    exit 0
  fi
  MISSING=''
  WARNINGS=''
  for KEY in DATABASE_PATH CONTENT_ENGINE_PORT PORTAL_TOKEN OAUTH_ENCRYPTION_KEY INTERNAL_API_SECRET AI_CALL_TIMEOUT_MS; do
    if ! grep -qE \"^\${KEY}=.+\" $REMOTE_DIR/.env; then
      MISSING=\"\$MISSING \$KEY\"
    fi
  done
  NODE_ENV_VALUE=\$(grep -oE '^NODE_ENV=.+' $REMOTE_DIR/.env 2>/dev/null | tail -1 | cut -d= -f2- || true)
  if [ \"\$NODE_ENV_VALUE\" = \"production\" ] && ! grep -qE '^SENTRY_DSN=.+' $REMOTE_DIR/.env; then
    WARNINGS=\"\$WARNINGS SENTRY_DSN\"
  fi
  if ! grep -qE '^NEXUS_BACKEND_BASE_URL=.+' $REMOTE_DIR/.env && ! grep -qE '^NEXUS_BACKEND_PORT=.+' $REMOTE_DIR/.env; then
    MISSING=\"\$MISSING NEXUS_BACKEND_BASE_URL_OR_NEXUS_BACKEND_PORT\"
  fi
  if ! grep -qE '^GEMINI_API_KEY=.+' $REMOTE_DIR/.env && ! grep -qE '^OPENAI_API_KEY=.+' $REMOTE_DIR/.env; then
    MISSING=\"\$MISSING GEMINI_API_KEY_OR_OPENAI_API_KEY\"
  fi
  if [ -n \"\$MISSING\" ]; then
    echo \"MISSING_KEYS:\$MISSING\"
  elif [ -n \"\$WARNINGS\" ]; then
    echo \"WARNING_KEYS:\$WARNINGS\"
  else
    echo OK
  fi
")
case "$ENV_CHECK" in
  MISSING_FILE)
    echo "   ❌ No production .env file at $REMOTE_DIR/.env"
    exit 1
    ;;
  BAD_MODE:*)
    echo "   ❌ Production .env has unsafe permissions (${ENV_CHECK#BAD_MODE:}); require 400 or 600"
    exit 1
    ;;
  BAD_OWNER:*)
    echo "   ❌ Production .env has unsafe owner (${ENV_CHECK#BAD_OWNER:})"
    exit 1
    ;;
  MISSING_KEYS:*)
    echo "   ❌ Production .env is missing required keys:${ENV_CHECK#MISSING_KEYS:}"
    echo "      Add them before deploying so content scripts use the AI synthesis bridge."
    exit 1
    ;;
  OK)
    echo "   ✅ All required production keys present"
    ;;
  WARNING_KEYS:*)
    echo "   ⚠️  Production .env is missing recommended keys:${ENV_CHECK#WARNING_KEYS:}"
    echo "      Sentry is warning-only for this pass; add SENTRY_DSN before making it a hard deploy gate."
    ;;
  *)
    echo "   ⚠️  Unexpected .env validator output: $ENV_CHECK — proceeding cautiously"
    ;;
esac

# ── 1b. Version identity (release-prep owns version bumps) ─
VERSION=$(node -p "require('./package.json').version" 2>/dev/null || echo "unknown")
echo "📌 Version: $VERSION"
echo "   Version bumps are prepared before staging via scripts/release-prep.sh"

COMMIT=$(git rev-parse --short HEAD)
DEPLOY_STATUS="✅ Success"

# Last local provenance guard before production is stopped. Any generated
# artifact drift or build/version side effect must abort here while prod is
# still online; after this point the script must continue through rsync/start.
restore_deploy_generated_artifacts
ensure_clean_deploy_tree
PRE_RSYNC_MANIFEST_DIGEST=$(node scripts/release-artifact-manifest.mjs --digest)
if [ "$PRE_RSYNC_MANIFEST_DIGEST" != "$POST_BUILD_MANIFEST_DIGEST" ]; then
  echo "   ❌ Artifact digest changed after build:"
  echo "      post-build: $POST_BUILD_MANIFEST_DIGEST"
  echo "      pre-rsync:   $PRE_RSYNC_MANIFEST_DIGEST"
  exit 1
fi

# Acquire the remote production lock immediately before any server mutation.
release_acquire_remote_lock "$SERVER" "$REMOTE_DIR" "prod-deploy"

# ── 2. Stop services on server ───────────────────────
# (Moved BEFORE backup so the SQLite WAL is checkpointed and bot.db is in
# a consistent state when we copy it. Audit QW-10 found that the previous
# backup ordering produced backups WITHOUT user data — see below.)
echo ""
echo "🛑 Stopping services on server..."
printf '%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$DEPLOY_MUTATION_MARKER"
# ── Handle PM2 process rename (one-time migration) ──
ssh "$SERVER" "export PATH=\$PATH:$(dirname $PM2) && $PM2 delete telegram-hub-bot 2>/dev/null || true"
ssh "$SERVER" "export PATH=\$PATH:$(dirname $PM2) && $PM2 stop nexus-hub 2>/dev/null; $PM2 stop content-engine 2>/dev/null; echo '   Stopped.'"

# ── 2b. Backup on server (now includes data/bot.db) ───
# Audit QW-10 finding: previous backups only contained code (dist/, prompts/,
# migrations/, package.json, package-lock.json, ecosystem.config.js) — bot.db
# was excluded entirely. There was no point-in-time data recovery at all.
# This step now also includes the SQLite DB plus its WAL/SHM sidecars; the
# sidecars are usually empty after a clean pm2 stop (graceful shutdown
# closes the DB which checkpoints WAL into the main file), but we include
# them defensively in case shutdown was abrupt.
echo ""
echo "💾 Creating backup on server (now WITH bot.db)..."
ssh "$SERVER" "
  BACKUP_DIR='/home/dominguez/backups/nexushub'
  TIMESTAMP=\$(date +%Y%m%d_%H%M%S)
  mkdir -p \"\$BACKUP_DIR\"
  cd '$REMOTE_DIR'
  # Build the include list dynamically: code paths + DB + sidecars (if present)
  INCLUDES='dist/ prompts/ migrations/ package.json package-lock.json ecosystem.config.js data/bot.db'
  [ -f data/bot.db-wal ] && INCLUDES=\"\$INCLUDES data/bot.db-wal\"
  [ -f data/bot.db-shm ] && INCLUDES=\"\$INCLUDES data/bot.db-shm\"
  [ -d data/garmin-tokens ] && INCLUDES=\"\$INCLUDES data/garmin-tokens/\"
  tar czf \"\$BACKUP_DIR/v${VERSION}_\${TIMESTAMP}.tar.gz\" \$INCLUDES 2>/dev/null || {
    echo '   ⚠️  Backup tar failed'; exit 1;
  }
  # Show resulting size + verify bot.db is actually in there
  SIZE=\$(du -h \"\$BACKUP_DIR/v${VERSION}_\${TIMESTAMP}.tar.gz\" | cut -f1)
  HAS_DB=\$(tar tzf \"\$BACKUP_DIR/v${VERSION}_\${TIMESTAMP}.tar.gz\" 2>/dev/null | grep -c 'bot.db\$' || echo 0)
  echo \"   ✅ Backup created (\$SIZE, bot.db included: \$HAS_DB)\"
  # Retention: keep 10 most recent
  ls -t \"\$BACKUP_DIR\"/*.tar.gz 2>/dev/null | tail -n +11 | xargs rm -f 2>/dev/null || true
" || echo "   ⚠️  Backup skipped"

# ── 3b. Drain ports before restart (audit P0-4) ──────
# pm2 stop returns when the process is gone, but the OS may keep port 8200
# in TIME_WAIT for up to 60 seconds if the previous instance crashed
# without calling portalServer.close() (e.g. uncaughtException). The next
# pm2 start would then fail with EADDRINUSE — exactly what produced the
# silent restart loop on April 3 that the audit caught. We poll for the
# port to be released; if it isn't free after 30s, we warn and proceed
# (PM2 will retry via exp_backoff_restart_delay).
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

# ── 4. Sync files (excluding protected paths) ────────
echo ""
echo "📤 Syncing files to server..."

if command -v rsync &>/dev/null; then
  rsync -avz --delete \
    --exclude='.env' \
    --exclude='.env.*' \
    --exclude='.env.agents' \
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
    --exclude='.claude' \
    --exclude='.claude/' \
    --exclude='.claude/**' \
    --exclude='.claude/worktrees/' \
    --exclude='.claude/worktrees/**' \
    --exclude='.codex/' \
    --exclude='.codex/**' \
    --exclude='.git' \
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

# ── 5a. Owner bootstrap preflight (strict) ───────────
# Production must not restart into an ambiguous owner/bootstrap state.
echo ""
echo "🧭 Verifying owner bootstrap on server..."
ssh "$SERVER" "cd $REMOTE_DIR && node dist/tools/owner-bootstrap-preflight.js --strict"
echo "   ✅ Owner bootstrap preflight passed"

# ── 5b. Rebuild native modules for the Node version PM2 spawns child processes with ──
# IMPORTANT: PM2 daemon runs under Linuxbrew Node (25.x) but the bot child
# processes are spawned via /usr/bin/node (22.x). We must rebuild against the
# child Node version, NOT the daemon's. The previous logic checked the daemon
# Node and rebuilt against the wrong version, leaving the bot in a crash loop.
echo ""
echo "🔧 Rebuilding native modules for system Node (used by spawned bot processes)..."
ssh "$SERVER" "
  SYSTEM_NODE=/usr/bin/node
  if [ -x \"\$SYSTEM_NODE\" ]; then
    echo \"   System Node: \$(\$SYSTEM_NODE --version)\"
    cd $REMOTE_DIR && PATH=/usr/bin:\$PATH /usr/bin/npm rebuild better-sqlite3 2>&1 | tail -1
    echo '   ✅ Native modules rebuilt for system Node'
  else
    echo '   ⚠️  System Node not found at /usr/bin/node — skipping rebuild'
  fi
"

# ── 6. Ensure protected directories exist ────────────
ssh "$SERVER" "mkdir -p $REMOTE_DIR/data/garmin-tokens $REMOTE_DIR/logs $REMOTE_DIR/content-engine/data"

# ── 7. Start services ────────────────────────────────
echo ""
echo "🟢 Starting services..."
ssh "$SERVER" "export PATH=\$PATH:$(dirname $PM2) && $PM2 set nexus-hub env GIT_COMMIT $COMMIT 2>/dev/null; $PM2 start content-engine 2>/dev/null && $PM2 start nexus-hub 2>/dev/null && $PM2 save && echo '   ✅ All services running'"

# ── 8. Health check (with retry) ─────────────────────
echo ""
echo "🏥 Health check (waiting 10s for startup)..."
sleep 10

HEALTH_OK=true

# Content engine
if ssh "$SERVER" "curl -sf http://localhost:8100/health 2>/dev/null" >/dev/null; then
  echo " ✅ Content engine OK"
else
  echo " ❌ Content engine not responding"
  DEPLOY_STATUS="❌ Failed"
  HEALTH_OK=false
fi

# Portal — production may require signed portal sessions instead of legacy
# PORTAL_TOKEN. Use the same auth strategy as staging smoke/deploy.
PORTAL_REQUIRE_SESSION_AUTH=$(ssh "$SERVER" "grep -oP '(?<=^PORTAL_REQUIRE_SESSION_AUTH=).+' $REMOTE_DIR/.env 2>/dev/null" || true)
if [ "$PORTAL_REQUIRE_SESSION_AUTH" = "true" ]; then
  PROD_SESSION=$(ssh "$SERVER" "
    set -e
    cd $REMOTE_DIR
    set -a
    . ./.env
    set +a
    node dist/tools/portal-session-token.js --actor deploy-production@nexushub.me --scope admin --ttl-ms 600000 --json \
      | node -e \"let b=''; process.stdin.on('data', c => b += c); process.stdin.on('end', () => { const j = JSON.parse(b); process.stdout.write(j.token || ''); });\"
  " 2>/dev/null || true)
  if ssh "$SERVER" "curl -sf -H 'x-portal-session: ${PROD_SESSION:-x}' http://localhost:8200/api/snapshot 2>/dev/null | head -c 100" >/dev/null; then
    echo " ✅ Status portal OK"
  else
    echo " ❌ Status portal not responding"
    DEPLOY_STATUS="❌ Failed"
    HEALTH_OK=false
  fi
else
  PORTAL_TOKEN=$(ssh "$SERVER" "grep -oP '(?<=^PORTAL_TOKEN=).+' $REMOTE_DIR/.env 2>/dev/null" || true)
  if [ -n "$PORTAL_TOKEN" ]; then
    if ssh "$SERVER" "curl -sf -H 'Authorization: Bearer $PORTAL_TOKEN' http://localhost:8200/api/snapshot 2>/dev/null | head -c 100" >/dev/null; then
      echo " ✅ Status portal OK"
    else
      echo " ❌ Status portal not responding"
      DEPLOY_STATUS="❌ Failed"
      HEALTH_OK=false
    fi
  else
    if ssh "$SERVER" "curl -sf http://localhost:8200/api/snapshot 2>/dev/null | head -c 100" >/dev/null; then
      echo " ✅ Status portal OK"
    else
      echo " ❌ Status portal not responding"
      DEPLOY_STATUS="❌ Failed"
      HEALTH_OK=false
    fi
  fi
fi

# Bot status with retry
BOT_STATUS=$(ssh "$SERVER" "export PATH=\$PATH:$(dirname $PM2) && $PM2 jlist 2>/dev/null | node -pe \"JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).find(p=>p.name==='nexus-hub')?.pm2_env?.status\"" 2>/dev/null || echo "unknown")

if [ "$BOT_STATUS" != "online" ]; then
  echo " ⏳ Bot not ready yet, retrying in 5s..."
  sleep 5
  BOT_STATUS=$(ssh "$SERVER" "export PATH=\$PATH:$(dirname $PM2) && $PM2 jlist 2>/dev/null | node -pe \"JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).find(p=>p.name==='nexus-hub')?.pm2_env?.status\"" 2>/dev/null || echo "unknown")
fi

if [ "$BOT_STATUS" = "online" ]; then
  echo " ✅ Bot: online"
else
  echo " ❌ Bot: $BOT_STATUS"
  echo "    Check logs: ssh $SERVER '$PM2 logs nexus-hub --lines 30 --nostream'"
  DEPLOY_STATUS="❌ Failed"
  HEALTH_OK=false
fi

ssh "$SERVER" "export PATH=\$PATH:$(dirname $PM2) && $PM2 list | grep -E 'online|stopped'"

echo ""
echo "🧭 Production readiness check..."
"$LOCAL_DIR/scripts/deploy-readiness-check.sh" --target prod --server "$SERVER" --remote-dir "$REMOTE_DIR"

# ── 9. Log to Notion Releases DB ─────────────────────
echo ""
if [ -n "$NOTION_TOKEN" ]; then
  echo "📋 Logging deploy to Notion..."
  DEPLOY_DATE=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  AUTHOR="Felipe Dominguez"

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

if [ "$HEALTH_OK" != true ]; then
  exit 1
fi

rm -f "$DEPLOY_MUTATION_MARKER"
