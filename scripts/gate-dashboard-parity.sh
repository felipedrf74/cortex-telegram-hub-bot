#!/usr/bin/env bash
# ─────────────────────────────────────────────────────
# gate-dashboard-parity.sh — compare local worktree's cannot-skip gate
# count against origin/main and warn if behind.
#
# Test-infra plan Phase H-4 (2026-05-18). If a new gate lands on main
# and an old worktree never rebases, the worktree's gate dashboard
# count silently drifts (we saw 23 → 35 between Phase 16 and Phase 17).
# This script surfaces the drift so pre-commit can warn.
#
# Usage:
#   ./scripts/gate-dashboard-parity.sh              # human-readable
#   ./scripts/gate-dashboard-parity.sh --json       # JSON for hooks
# ─────────────────────────────────────────────────────
set -euo pipefail

FORMAT="table"
while [ $# -gt 0 ]; do
  case "$1" in
    --json) FORMAT="json"; shift;;
    -h|--help) sed -n '2,15p' "$0" | sed 's/^# \?//'; exit 0;;
    *) echo "Unknown arg: $1" >&2; exit 1;;
  esac
done

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo "")"
if [ -z "$ROOT" ]; then
  echo "Not a git repository" >&2
  exit 1
fi

cd "$ROOT"

# Local gate count.
LOCAL_JSON=$(bash scripts/cannot-skip-gate-dashboard.sh --json --no-evidence 2>/dev/null || echo "{}")
LOCAL_COUNT=$(echo "$LOCAL_JSON" | node -e "let b='';process.stdin.on('data',c=>b+=c);process.stdin.on('end',()=>{try{const d=JSON.parse(b);process.stdout.write(String(d.summary?.total??0))}catch(e){process.stdout.write('0')}})" 2>/dev/null || echo "0")
LOCAL_PASS=$(echo "$LOCAL_JSON" | node -e "let b='';process.stdin.on('data',c=>b+=c);process.stdin.on('end',()=>{try{const d=JSON.parse(b);process.stdout.write(String(d.summary?.pass??0))}catch(e){process.stdout.write('0')}})" 2>/dev/null || echo "0")

# Fetch origin/main quietly.
git fetch origin main --quiet 2>/dev/null || true
MAIN_SHA=$(git rev-parse origin/main 2>/dev/null || git rev-parse main 2>/dev/null || echo "")

# Main gate count — run the dashboard script as it lives at origin/main.
# We `git show origin/main:scripts/cannot-skip-gate-dashboard.sh` and pipe to bash
# but it sources files relative to ROOT, so we use a temp checkout instead.
MAIN_COUNT="?"
if [ -n "$MAIN_SHA" ] && [ "$MAIN_SHA" != "$(git rev-parse HEAD 2>/dev/null)" ]; then
  TMPDIR=$(mktemp -d)
  trap "rm -rf $TMPDIR" EXIT
  # Add a temporary worktree for origin/main to safely run its version of the dashboard.
  if git worktree add -q --detach "$TMPDIR" "$MAIN_SHA" 2>/dev/null; then
    if [ -f "$TMPDIR/scripts/cannot-skip-gate-dashboard.sh" ]; then
      # The dashboard's child processes need node_modules. Reuse local install.
      if [ -d "$ROOT/node_modules" ]; then
        ln -s "$ROOT/node_modules" "$TMPDIR/node_modules" 2>/dev/null || true
      fi
      MAIN_JSON=$(cd "$TMPDIR" && bash scripts/cannot-skip-gate-dashboard.sh --json --no-evidence 2>/dev/null || echo "{}")
      MAIN_COUNT=$(echo "$MAIN_JSON" | node -e "let b='';process.stdin.on('data',c=>b+=c);process.stdin.on('end',()=>{try{const d=JSON.parse(b);process.stdout.write(String(d.summary?.total??0))}catch(e){process.stdout.write('0')}})" 2>/dev/null || echo "0")
    fi
    git worktree remove -f "$TMPDIR" 2>/dev/null || true
  fi
else
  MAIN_COUNT="$LOCAL_COUNT"
fi

DRIFT="false"
if [ "$MAIN_COUNT" != "?" ] && [ "$LOCAL_COUNT" -lt "$MAIN_COUNT" ] 2>/dev/null; then
  DRIFT="true"
fi

if [ "$FORMAT" = "json" ]; then
  printf '{"localCount":%s,"localPass":%s,"mainCount":%s,"drift":%s,"generatedAt":"%s"}\n' \
    "$LOCAL_COUNT" "$LOCAL_PASS" "$MAIN_COUNT" "$DRIFT" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
else
  echo "Cannot-skip gate parity:"
  echo "  local:  $LOCAL_PASS / $LOCAL_COUNT gates passing"
  echo "  main:   $MAIN_COUNT gates"
  if [ "$DRIFT" = "true" ]; then
    echo "  ⚠ drift: this worktree is behind origin/main by $((MAIN_COUNT - LOCAL_COUNT)) gate(s)."
    echo "     suggested: git fetch origin && git rebase origin/main"
  else
    echo "  ✓ parity: no drift detected."
  fi
fi
