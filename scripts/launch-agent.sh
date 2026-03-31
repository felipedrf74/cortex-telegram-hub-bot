#!/bin/bash
# Nexus Hub — Agent Launcher
# Usage: ./scripts/launch-agent.sh <agent-name>

AGENT="$1"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
WORKTREE_BASE="$(cd "$REPO_DIR/.." && pwd)/nexushub-worktrees"

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

cd "$WORKTREE" || exit 1

if [ -f ".agent-prompt.md" ]; then
  echo "📋 Task found for $AGENT agent"
  echo "🚀 Launching in autonomous mode..."
  exec claude --dangerously-skip-permissions "Read CLAUDE.md first, then read .agent-prompt.md and execute the task described. When you finish, run the auto-chain command from CLAUDE.md Step 3 to hand off to QA and get your next task. Then check for a new .agent-prompt.md and continue working. Never stop between tasks."
else
  echo "⚠️  No .agent-prompt.md — launching idle"
  exec claude --dangerously-skip-permissions
fi
