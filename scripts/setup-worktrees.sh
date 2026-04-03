#!/usr/bin/env bash
# ─────────────────────────────────────────────────────
# setup-worktrees.sh — Set up git worktrees for parallel
#                      Claude Code agent development
#
# Creates a worktree directory structure where each
# feature branch gets its own checkout. Multiple Claude
# Code instances can work simultaneously without conflicts.
#
# Usage:
#   ./scripts/setup-worktrees.sh                    # Initial setup
#   ./scripts/setup-worktrees.sh add feature-name   # Add new feature worktree
#   ./scripts/setup-worktrees.sh add-bug name       # Add bugfix worktree (from develop)
#   ./scripts/setup-worktrees.sh add-hotfix name    # Add hotfix worktree (from main)
#   ./scripts/setup-worktrees.sh remove name        # Remove worktree
#   ./scripts/setup-worktrees.sh list                # List active worktrees
#   ./scripts/setup-worktrees.sh clean               # Remove merged worktrees
#
# Structure:
#   ~/Desktop/Custom Connectors/Cortex/
#   ├── nexus-hub/              ← main repo (main branch)
#   └── nexushub-worktrees/
#       ├── feature-aiprovider/               ← feature/NH-001-aiprovider
#       ├── feature-message-adapter/          ← feature/NH-002-message-adapter
#       ├── feature-test-expansion/           ← feature/NH-003-test-expansion
#       ├── bugfix-agent/                     ← bugfix/current (always-on bug agent)
#       └── hotfix-xxx/                       ← hotfix branches (created on demand)
# ─────────────────────────────────────────────────────
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WORKTREE_BASE="$(dirname "$REPO_DIR")/nexushub-worktrees"
COMMAND="${1:-setup}"

create_worktree() {
  local BRANCH="$1"
  local DIR="$2"
  local BASE_BRANCH="${3:-develop}"  # default: branch from develop
  local WORKTREE_PATH="$WORKTREE_BASE/$DIR"
  
  if [ -d "$WORKTREE_PATH" ]; then
    echo "   ⏭️  $DIR already exists"
    return
  fi
  
  # Create branch if it doesn't exist
  if ! git show-ref --verify --quiet "refs/heads/$BRANCH" 2>/dev/null; then
    git branch "$BRANCH" "$BASE_BRANCH" 2>/dev/null || git branch "$BRANCH" main
    echo "   🌿 Created branch: $BRANCH (from $BASE_BRANCH)"
  fi
  
  # Create worktree
  git worktree add "$WORKTREE_PATH" "$BRANCH"
  
  # Install dependencies
  echo "   📦 Installing deps in $DIR..."
  cd "$WORKTREE_PATH"
  npm ci --silent 2>/dev/null || npm install --silent 2>/dev/null
  cd "$REPO_DIR"
  
  echo "   ✅ $DIR → $BRANCH"
}

case "$COMMAND" in
  setup)
    echo "🌳 Setting up Nexus Hub worktree environment..."
    echo ""
    
    cd "$REPO_DIR"
    git fetch origin
    mkdir -p "$WORKTREE_BASE"
    
    # Feature agents (branch from develop)
    FEATURES=(
      "feature/NH-001-aiprovider:feature-aiprovider:develop"
      "feature/NH-002-message-adapter:feature-message-adapter:develop"
      "feature/NH-003-test-expansion:feature-test-expansion:develop"
    )
    
    for entry in "${FEATURES[@]}"; do
      IFS=':' read -r BRANCH DIR BASE <<< "$entry"
      create_worktree "$BRANCH" "$DIR" "$BASE"
    done
    
    # Bug agent (always-on, branches from develop)
    create_worktree "bugfix/current" "bugfix-agent" "develop"
    
    echo ""
    echo "═══════════════════════════════════════════════"
    echo "  ✅ Worktree environment ready!"
    echo ""
    echo "  📂 Main repo:  $REPO_DIR"
    echo "  📂 Worktrees:  $WORKTREE_BASE/"
    echo ""
    echo "  Launch agents:"
    echo "    Terminal 1: cd .../feature-aiprovider && claude"
    echo "    Terminal 2: cd .../feature-message-adapter && claude"
    echo "    Terminal 3: cd .../feature-test-expansion && claude"
    echo "    Terminal 4: cd .../bugfix-agent && claude"
    echo ""
    echo "  Bug agent prompt:"
    echo "    \"You are the Bug Agent. See CLAUDE.md for your role."
    echo "     Check pm2 logs, error patterns, and edge cases."
    echo "     For each bug: write failing test → fix → verify.\""
    echo "═══════════════════════════════════════════════"
    ;;
    
  add)
    FEATURE_NAME="${2:?Usage: $0 add <feature-name>}"
    cd "$REPO_DIR"
    mkdir -p "$WORKTREE_BASE"
    create_worktree "feature/${FEATURE_NAME}" "feature-${FEATURE_NAME}" "develop"
    echo ""
    echo "Launch: cd $WORKTREE_BASE/feature-${FEATURE_NAME} && claude"
    ;;
    
  add-bug)
    BUG_NAME="${2:?Usage: $0 add-bug <bug-name>}"
    cd "$REPO_DIR"
    mkdir -p "$WORKTREE_BASE"
    create_worktree "bugfix/${BUG_NAME}" "bugfix-${BUG_NAME}" "develop"
    echo ""
    echo "Launch: cd $WORKTREE_BASE/bugfix-${BUG_NAME} && claude"
    ;;
    
  add-hotfix)
    HOTFIX_NAME="${2:?Usage: $0 add-hotfix <hotfix-name>}"
    cd "$REPO_DIR"
    mkdir -p "$WORKTREE_BASE"
    # CRITICAL: hotfixes branch from main (production), not develop
    create_worktree "hotfix/${HOTFIX_NAME}" "hotfix-${HOTFIX_NAME}" "main"
    echo ""
    echo "⚠️  HOTFIX: Branched from main (production code)"
    echo "Launch: cd $WORKTREE_BASE/hotfix-${HOTFIX_NAME} && claude"
    echo ""
    echo "Tell the agent:"
    echo "  \"You are a Hotfix Agent. See CLAUDE.md. This is PRODUCTION code."
    echo "   Fix ONLY the specific bug described. Minimal changes only.\""
    ;;
    
  remove)
    NAME="${2:?Usage: $0 remove <name>}"
    cd "$REPO_DIR"
    
    # Try multiple directory patterns
    for prefix in "feature-" "bugfix-" "hotfix-"; do
      WORKTREE_PATH="$WORKTREE_BASE/${prefix}${NAME}"
      if [ -d "$WORKTREE_PATH" ]; then
        git worktree remove "$WORKTREE_PATH" --force
        echo "✅ Removed worktree: ${prefix}${NAME}"
        exit 0
      fi
    done
    
    echo "❌ Worktree not found for: $NAME"
    echo "   Available worktrees:"
    ls -1 "$WORKTREE_BASE/" 2>/dev/null || echo "   (none)"
    exit 1
    ;;
    
  list)
    cd "$REPO_DIR"
    echo "🌳 Active worktrees:"
    echo ""
    git worktree list
    ;;
    
  clean)
    cd "$REPO_DIR"
    echo "🧹 Cleaning stale worktrees..."
    git worktree prune
    echo "✅ Pruned"
    git worktree list
    ;;
    
  *)
    echo "Usage: $0 {setup|add|add-bug|add-hotfix|remove|list|clean}"
    echo ""
    echo "  setup              Create all default worktrees"
    echo "  add <name>         Add feature worktree (from develop)"
    echo "  add-bug <name>     Add bugfix worktree (from develop)"
    echo "  add-hotfix <name>  Add hotfix worktree (from main)"
    echo "  remove <name>      Remove a worktree"
    echo "  list               List all worktrees"
    echo "  clean              Prune stale worktrees"
    exit 1
    ;;
esac
