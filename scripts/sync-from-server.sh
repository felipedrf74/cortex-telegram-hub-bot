#!/usr/bin/env bash
# ─────────────────────────────────────────────────────
# sync-from-server.sh — Safely pull production changes
#                       into a git branch for review
#
# This script:
#   1. Creates a server-sync branch from main
#   2. Pulls changed source files from the server
#   3. Shows you the diff
#   4. Commits the server changes
#   5. You review and merge when ready
#
# SAFE: Never touches main, develop, or the server.
#       Only creates a new branch with server state.
#
# Usage:
#   ./scripts/sync-from-server.sh           # Full sync
#   ./scripts/sync-from-server.sh --dry-run # Preview only
# ─────────────────────────────────────────────────────
set -euo pipefail

SERVER="dominguez@serverdominguez"
REMOTE_DIR="/home/dominguez/telegram-hub-bot"
LOCAL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DRY_RUN="${1:-}"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
SYNC_BRANCH="server-sync/${TIMESTAMP}"
TEMP_DIR="/tmp/nexushub-server-sync-${TIMESTAMP}"

echo ""
echo "═══════════════════════════════════════════════"
echo "  🔄 Nexus Hub — Sync from Production Server"
echo "═══════════════════════════════════════════════"
echo ""

# ── 1. Save current branch ──────────────────────────
cd "$LOCAL_DIR"
ORIGINAL_BRANCH=$(git branch --show-current)
echo "📌 Current branch: $ORIGINAL_BRANCH"
echo "📡 Server: $SERVER:$REMOTE_DIR"
echo ""

# ── 2. Check for uncommitted local changes ──────────
if [ -n "$(git status --porcelain)" ]; then
  echo "⚠️  You have uncommitted local changes:"
  git status --short
  echo ""
  echo "Please commit or stash them first:"
  echo "  git stash    (to save temporarily)"
  echo "  git stash pop (to restore later)"
  exit 1
fi

# ── 3. Fetch server files to temp directory ─────────
echo "📥 Fetching source files from server..."
mkdir -p "$TEMP_DIR"

# Pull only source code (not data, logs, node_modules, .env)
rsync -avz --delete \
  --include='src/***' \
  --include='prompts/***' \
  --include='migrations/***' \
  --include='content-engine/***' \
  --include='package.json' \
  --include='package-lock.json' \
  --include='ecosystem.config.js' \
  --include='tsconfig.json' \
  --include='CHANGELOG.md' \
  --include='DOCUMENTATION.md' \
  --include='DEVELOPMENT.md' \
  --exclude='content-engine/.venv/***' \
  --exclude='content-engine/__pycache__/***' \
  --exclude='content-engine/data/***' \
  --exclude='*' \
  "$SERVER:$REMOTE_DIR/" "$TEMP_DIR/" 2>&1 | tail -5

echo "   ✅ Server files fetched to $TEMP_DIR"
echo ""

# ── 4. Show what's different ────────────────────────
echo "═══════════════════════════════════════════════"
echo "  📊 Changes on server vs local repo"
echo "═══════════════════════════════════════════════"
echo ""

# Compare each synced file against local
CHANGED_FILES=()
NEW_FILES=()
for f in $(cd "$TEMP_DIR" && find . -type f -name '*.ts' -o -name '*.js' -o -name '*.py' -o -name '*.md' -o -name '*.json' -o -name '*.sql' | sort); do
  LOCAL_FILE="$LOCAL_DIR/$f"
  SERVER_FILE="$TEMP_DIR/$f"
  
  if [ ! -f "$LOCAL_FILE" ]; then
    NEW_FILES+=("$f")
    echo "  🆕 NEW: $f"
  elif ! diff -q "$LOCAL_FILE" "$SERVER_FILE" >/dev/null 2>&1; then
    CHANGED_FILES+=("$f")
    echo "  📝 CHANGED: $f"
  fi
done

echo ""
echo "Summary: ${#CHANGED_FILES[@]} changed, ${#NEW_FILES[@]} new files"
echo ""

if [ ${#CHANGED_FILES[@]} -eq 0 ] && [ ${#NEW_FILES[@]} -eq 0 ]; then
  echo "✅ Server and local are in sync. Nothing to do."
  rm -rf "$TEMP_DIR"
  exit 0
fi

# ── 5. Show detailed diffs ─────────────────────────
if [ "$DRY_RUN" = "--dry-run" ]; then
  echo "═══════════════════════════════════════════════"
  echo "  🔍 Detailed Diffs (dry-run mode)"
  echo "═══════════════════════════════════════════════"
  for f in "${CHANGED_FILES[@]}"; do
    echo ""
    echo "── $f ──"
    diff -u "$LOCAL_DIR/$f" "$TEMP_DIR/$f" | head -40 || true
  done
  echo ""
  echo "Dry run complete. Run without --dry-run to apply."
  rm -rf "$TEMP_DIR"
  exit 0
fi

# ── 6. Create sync branch and apply changes ────────
echo "🌿 Creating branch: $SYNC_BRANCH"
git checkout -b "$SYNC_BRANCH" main

# Copy changed files from server
for f in "${CHANGED_FILES[@]}" "${NEW_FILES[@]}"; do
  # Ensure directory exists
  mkdir -p "$(dirname "$LOCAL_DIR/$f")"
  cp "$TEMP_DIR/$f" "$LOCAL_DIR/$f"
done

echo "   ✅ Server files copied to local"

# ── 7. Show git diff ────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════"
echo "  📊 Git Diff Summary"
echo "═══════════════════════════════════════════════"
echo ""
git diff --stat
echo ""

# ── 8. Commit ───────────────────────────────────────
git add .
git commit -m "sync: pull production server changes ($TIMESTAMP)

Server changes synced from $SERVER:$REMOTE_DIR
Changed files: ${#CHANGED_FILES[@]}
New files: ${#NEW_FILES[@]}"

echo ""
echo "═══════════════════════════════════════════════"
echo "  ✅ Server changes committed to: $SYNC_BRANCH"
echo "═══════════════════════════════════════════════"
echo ""
echo "  Next steps:"
echo ""
echo "  1. Review the changes:"
echo "     git log --oneline -5"
echo "     git diff main..${SYNC_BRANCH} --stat"
echo "     git diff main..${SYNC_BRANCH}              # full diff"
echo ""
echo "  2. When satisfied, merge to develop:"
echo "     git checkout develop"
echo "     git merge ${SYNC_BRANCH}"
echo "     git push origin develop"
echo ""
echo "  3. Then merge develop to main when ready:"
echo "     git checkout main"
echo "     git merge develop"
echo "     git push origin main"
echo ""
echo "  4. Return to your working branch:"
echo "     git checkout $ORIGINAL_BRANCH"
echo ""

# Clean up temp
rm -rf "$TEMP_DIR"
