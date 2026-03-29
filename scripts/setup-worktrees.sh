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
#   ./scripts/setup-worktrees.sh add feature-name   # Add new worktree
#   ./scripts/setup-worktrees.sh remove feature-name # Remove worktree
#   ./scripts/setup-worktrees.sh list                # List active worktrees
#   ./scripts/setup-worktrees.sh clean               # Remove merged worktrees
#
# Structure created:
#   ~/Desktop/Custom Connectors/Cortex/
#   ├── cortex-telegram-hub-bot/          ← main repo (main branch)
#   └── nexushub-worktrees/
#       ├── feature-aiprovider/           ← feature/NH-001-aiprovider
#       ├── feature-message-adapter/      ← feature/NH-002-message-adapter
#       ├── feature-test-expansion/       ← feature/NH-003-test-expansion
#       └── hotfix-xxx/                   ← hotfix branches
# ─────────────────────────────────────────────────────
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WORKTREE_BASE="$(dirname "$REPO_DIR")/nexushub-worktrees"
COMMAND="${1:-setup}"

case "$COMMAND" in
  setup)
    echo "🌳 Setting up Nexus Hub worktree environment..."
    echo ""
    
    # Ensure we're on main/develop
    cd "$REPO_DIR"
    git fetch origin
    
    # Create worktree base directory
    mkdir -p "$WORKTREE_BASE"
    
    # Create initial feature worktrees from develop
    FEATURES=(
      "feature/NH-001-aiprovider:feature-aiprovider"
      "feature/NH-002-message-adapter:feature-message-adapter"
      "feature/NH-003-test-expansion:feature-test-expansion"
    )
    
    for entry in "${FEATURES[@]}"; do
      BRANCH="${entry%%:*}"
      DIR="${entry##*:}"
      WORKTREE_PATH="$WORKTREE_BASE/$DIR"
      
      if [ -d "$WORKTREE_PATH" ]; then
        echo "   ⏭️  $DIR already exists"
        continue
      fi
      
      # Create branch from develop if it doesn't exist
      if ! git show-ref --verify --quiet "refs/heads/$BRANCH" 2>/dev/null; then
        git branch "$BRANCH" develop 2>/dev/null || git branch "$BRANCH" main
        echo "   🌿 Created branch: $BRANCH"
      fi
      
      # Create worktree
      git worktree add "$WORKTREE_PATH" "$BRANCH"
      
      # Install dependencies in the worktree
      echo "   📦 Installing deps in $DIR..."
      cd "$WORKTREE_PATH"
      npm ci --silent 2>/dev/null || npm install --silent 2>/dev/null
      cd "$REPO_DIR"
      
      echo "   ✅ $DIR → $BRANCH"
    done
    
    echo ""
    echo "═══════════════════════════════════════════════"
    echo "  ✅ Worktree environment ready!"
    echo ""
    echo "  📂 Main repo:  $REPO_DIR"
    echo "  📂 Worktrees:  $WORKTREE_BASE/"
    echo ""
    echo "  To open Claude Code on a feature:"
    echo "    cd $WORKTREE_BASE/feature-aiprovider && claude"
    echo ""
    echo "  To open multiple agents in parallel:"
    echo "    Terminal 1: cd .../feature-aiprovider && claude"
    echo "    Terminal 2: cd .../feature-message-adapter && claude"
    echo "    Terminal 3: cd .../feature-test-expansion && claude"
    echo "═══════════════════════════════════════════════"
    ;;
    
  add)
    FEATURE_NAME="${2:?Usage: $0 add <feature-name>}"
    BRANCH="feature/${FEATURE_NAME}"
    DIR="feature-${FEATURE_NAME}"
    WORKTREE_PATH="$WORKTREE_BASE/$DIR"
    
    cd "$REPO_DIR"
    
    if [ -d "$WORKTREE_PATH" ]; then
      echo "❌ Worktree already exists: $WORKTREE_PATH"
      exit 1
    fi
    
    # Create branch from develop
    if ! git show-ref --verify --quiet "refs/heads/$BRANCH" 2>/dev/null; then
      git branch "$BRANCH" develop 2>/dev/null || git branch "$BRANCH" main
    fi
    
    mkdir -p "$WORKTREE_BASE"
    git worktree add "$WORKTREE_PATH" "$BRANCH"
    
    cd "$WORKTREE_PATH"
    npm ci --silent 2>/dev/null || npm install --silent 2>/dev/null
    
    echo "✅ Created worktree: $DIR → $BRANCH"
    echo "   cd $WORKTREE_PATH && claude"
    ;;
    
  remove)
    FEATURE_NAME="${2:?Usage: $0 remove <feature-name>}"
    DIR="feature-${FEATURE_NAME}"
    WORKTREE_PATH="$WORKTREE_BASE/$DIR"
    
    cd "$REPO_DIR"
    
    if [ ! -d "$WORKTREE_PATH" ]; then
      echo "❌ Worktree not found: $DIR"
      exit 1
    fi
    
    git worktree remove "$WORKTREE_PATH" --force
    echo "✅ Removed worktree: $DIR"
    ;;
    
  list)
    cd "$REPO_DIR"
    echo "🌳 Active worktrees:"
    echo ""
    git worktree list
    ;;
    
  clean)
    cd "$REPO_DIR"
    echo "🧹 Cleaning merged worktrees..."
    git worktree prune
    echo "✅ Pruned stale worktrees"
    git worktree list
    ;;
    
  *)
    echo "Usage: $0 {setup|add|remove|list|clean}"
    exit 1
    ;;
esac
