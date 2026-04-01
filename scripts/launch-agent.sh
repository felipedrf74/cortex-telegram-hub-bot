#!/bin/bash
# ──────────────────────────────────────────────────────────────
# Nexus Hub — Agent Launcher v2 (Self-Orchestrating)
#
# Continuous loop: runs Claude → completes task → auto-chains
# Agents keep working until no tasks remain, then poll for new ones.
#
# Usage: ./scripts/launch-agent.sh <backend|qa|devops|flex>
# ──────────────────────────────────────────────────────────────

AGENT="$1"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
WORKTREE_BASE="$(cd "$REPO_DIR/.." && pwd)/nexushub-worktrees"
POLL_INTERVAL=60  # seconds between idle polls

if [ -z "$AGENT" ]; then
  echo "Usage: $0 <backend|qa|devops|flex>"
  exit 1
fi

WORKTREE="$WORKTREE_BASE/$AGENT"

if [ ! -d "$WORKTREE" ]; then
  echo "❌ Worktree not found: $WORKTREE"
  exit 1
fi

# Export NOTION_TOKEN so agent-complete.js and all child processes have it
if [ -f "$REPO_DIR/.env.agents" ]; then
  export NOTION_TOKEN=$(grep NOTION_TOKEN "$REPO_DIR/.env.agents" | cut -d= -f2)
  echo "🔑 NOTION_TOKEN loaded"
fi

# Also export Telegram vars if present
if grep -q "TELEGRAM_BOT_TOKEN" "$REPO_DIR/.env.agents" 2>/dev/null; then
  export TELEGRAM_BOT_TOKEN=$(grep TELEGRAM_BOT_TOKEN "$REPO_DIR/.env.agents" | cut -d= -f2)
  export TELEGRAM_CHAT_ID=$(grep TELEGRAM_CHAT_ID "$REPO_DIR/.env.agents" | cut -d= -f2)
fi

cd "$WORKTREE" || exit 1

echo ""
echo "╔═══════════════════════════════════════════════╗"
echo "║  🤖 Nexus Hub — $AGENT Agent (auto-loop)      ║"
echo "╚═══════════════════════════════════════════════╝"
echo ""

# ─── Continuous Task Loop ─────────────────────────────────────
IDLE_COUNT=0
MAX_IDLE=30  # Stop after 30 min of no tasks (30 × 60s)

while true; do
  # Check for task
  if [ -f ".agent-prompt.md" ]; then
    IDLE_COUNT=0
    TASK_TITLE=$(python3 -c "
import json
try:
  d = json.load(open('.agent-task.json'))
  print(d.get('title','unknown'))
except: print('unknown')
" 2>/dev/null)
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "🚀 [$AGENT] Starting task: $TASK_TITLE"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""

    # Run Claude with the task prompt
    claude --dangerously-skip-permissions \
      "Read CLAUDE.md first, then read .agent-prompt.md and execute the task described. \
When done: commit, push, then run the auto-chain command from the prompt. \
After auto-chain, check if a new .agent-prompt.md was written. If yes, read and execute it immediately. \
Never stop between tasks — keep chaining until no more .agent-prompt.md exists."

    CLAUDE_EXIT=$?
    echo ""
    echo "🔄 [$AGENT] Claude exited (code: $CLAUDE_EXIT)"

    # Run agent-complete.js if task file still exists (Claude may have already called it)
    if [ -f ".agent-task.json" ]; then
      echo "⚡ [$AGENT] Running auto-complete (Claude didn't chain)..."
      node "$REPO_DIR/scripts/agent-complete.js" --agent "$AGENT" --summary "auto-completed via launcher"
    fi

    # Brief pause before checking for next task
    sleep 3

  else
    # No task — try to fetch one from Notion
    IDLE_COUNT=$((IDLE_COUNT + 1))

    if [ $IDLE_COUNT -eq 1 ]; then
      echo "💤 [$AGENT] No task. Polling every ${POLL_INTERVAL}s..."
    fi

    # Just check if a new prompt appeared (Mission Control auto-assign handles dispatch)
    if [ -f ".agent-prompt.md" ]; then
      echo "📋 [$AGENT] New task found!"
      continue
    fi

    if [ $IDLE_COUNT -ge $MAX_IDLE ]; then
      echo "⏰ [$AGENT] Idle for ${MAX_IDLE} minutes — shutting down."
      echo "    Restart with: ./scripts/launch-agent.sh $AGENT"
      exit 0
    fi

    sleep $POLL_INTERVAL
  fi
done
