#!/bin/bash
# Nexus Hub — Agent Launcher
# Usage: ./scripts/launch-agent.sh <agent-name>

AGENT="$1"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORKTREE_BASE="$(cd "$SCRIPT_DIR/../.." && pwd)/nexushub-worktrees"

if [ -z "$AGENT" ]; then
  echo "Usage: $0 <backend|qa|devops|flex>"
  exit 1
fi

WORKTREE="$WORKTREE_BASE/$AGENT"

if [ ! -d "$WORKTREE" ]; then
  echo "❌ Worktree not found: $WORKTREE"
  exit 1
fi

cd "$WORKTREE" || exit 1

PROMPT="Read CLAUDE.md first, then read .agent-prompt.md and execute the task described. When you finish, run the auto-chain command from CLAUDE.md Step 3 to hand off to QA and get your next task. Then check for a new .agent-prompt.md and continue working. Never stop between tasks."

if [ -f ".agent-prompt.md" ]; then
  echo "📋 Task found for $AGENT agent"
  echo "🚀 Launching in autonomous mode..."
  exec claude --dangerously-skip-permissions "$PROMPT"
else
  echo "⚠️  No .agent-prompt.md — launching idle"
  exec claude --dangerously-skip-permissions
fi
