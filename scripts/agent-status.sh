#!/usr/bin/env bash
# ─────────────────────────────────────────────────────
# agent-status.sh — Check status of all development agents
#
# Shows what each worktree/agent is working on, their
# git status, and any completion notifications.
#
# Usage:
#   ./scripts/agent-status.sh           # Full status
#   ./scripts/agent-status.sh summary   # Quick summary
#   ./scripts/agent-status.sh notify    # Send Telegram notification
# ─────────────────────────────────────────────────────
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WORKTREE_BASE="$(dirname "$REPO_DIR")/nexushub-worktrees"
LOG_FILE="$HOME/Desktop/nexushub-agent-log.md"
COMMAND="${1:-status}"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

case "$COMMAND" in
  status)
    echo ""
    echo "═══════════════════════════════════════════════"
    echo -e "  ${BLUE}🤖 Nexus Hub — Agent Status${NC}"
    echo "═══════════════════════════════════════════════"
    echo ""
    
    # Main repo status
    echo -e "${GREEN}📂 Main Repo${NC} ($REPO_DIR)"
    cd "$REPO_DIR"
    BRANCH=$(git branch --show-current)
    CHANGES=$(git status --porcelain | wc -l | tr -d ' ')
    LAST_COMMIT=$(git log --oneline -1)
    echo "   Branch:  $BRANCH"
    echo "   Changes: $CHANGES uncommitted files"
    echo "   Last:    $LAST_COMMIT"
    echo ""
    
    # Worktree statuses
    if [ -d "$WORKTREE_BASE" ]; then
      for wt_dir in "$WORKTREE_BASE"/*/; do
        [ -d "$wt_dir" ] || continue
        NAME=$(basename "$wt_dir")
        cd "$wt_dir"
        
        BRANCH=$(git branch --show-current 2>/dev/null || echo "detached")
        CHANGES=$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')
        LAST_COMMIT=$(git log --oneline -1 2>/dev/null || echo "no commits")
        AHEAD=$(git rev-list --count develop..HEAD 2>/dev/null || echo "?")
        
        if [ "$CHANGES" -gt 0 ]; then
          STATUS="${YELLOW}⚡ Working${NC}"
        elif [ "$AHEAD" -gt 0 ] 2>/dev/null; then
          STATUS="${GREEN}✅ Ready (${AHEAD} commits ahead)${NC}"
        else
          STATUS="${BLUE}💤 Idle${NC}"
        fi
        
        echo -e "${GREEN}📂 $NAME${NC}"
        echo -e "   Branch:  $BRANCH"
        echo -e "   Status:  $STATUS"
        echo "   Changes: $CHANGES uncommitted files"
        echo "   Ahead:   $AHEAD commits vs develop"
        echo "   Last:    $LAST_COMMIT"
        echo ""
      done
    else
      echo "   No worktrees found. Run: ./scripts/setup-worktrees.sh"
      echo ""
    fi
    
    # Agent log
    if [ -f "$LOG_FILE" ]; then
      echo "═══════════════════════════════════════════════"
      echo -e "  ${BLUE}📋 Agent Completion Log${NC}"
      echo "═══════════════════════════════════════════════"
      echo ""
      tail -20 "$LOG_FILE"
      echo ""
    fi
    ;;
    
  summary)
    cd "$REPO_DIR"
    echo "🤖 Nexus Hub Agents:"
    git worktree list --porcelain | grep -E "^worktree|^branch" | paste - - | while IFS=$'\t' read -r wt branch; do
      DIR="${wt#worktree }"
      BR="${branch#branch refs/heads/}"
      NAME=$(basename "$DIR")
      CHANGES=$(cd "$DIR" && git status --porcelain 2>/dev/null | wc -l | tr -d ' ')
      if [ "$CHANGES" -gt 0 ]; then
        echo "  ⚡ $NAME ($BR) — $CHANGES changes"
      else
        echo "  💤 $NAME ($BR) — clean"
      fi
    done
    ;;
    
  notify)
    # Read the agent log and send via the bot (if running)
    if [ ! -f "$LOG_FILE" ]; then
      echo "No agent log found."
      exit 0
    fi
    
    echo "📬 Recent agent completions:"
    cat "$LOG_FILE"
    echo ""
    echo "Clear the log? (y/N)"
    read -r REPLY
    if [[ "$REPLY" =~ ^[Yy]$ ]]; then
      > "$LOG_FILE"
      echo "✅ Log cleared"
    fi
    ;;
    
  *)
    echo "Usage: $0 {status|summary|notify}"
    ;;
esac
