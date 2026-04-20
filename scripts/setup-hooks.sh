#!/usr/bin/env bash
# ─────────────────────────────────────────────────────
# setup-hooks.sh — Activate committed Git hooks for Nexus Hub
#
# Installs NOTHING into `.git/hooks` anymore — that approach silently
# drifted between contributor machines because the hook lived outside
# version control. Instead this script points `core.hooksPath` at the
# committed `.husky/` directory so every clone runs the same gates.
#
# Activate once per clone:
#   ./scripts/setup-hooks.sh
# ─────────────────────────────────────────────────────
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

if [ ! -d .husky ]; then
  echo "❌ .husky/ directory not found. Are you in the repo root?"
  exit 1
fi

git config core.hooksPath .husky
chmod +x .husky/*

echo "🎉 Git hooks activated (core.hooksPath → .husky)"
echo ""
echo "Committed hooks:"
ls -1 .husky | sed 's/^/  - /'
echo ""
echo "Skip hooks (emergency): git commit --no-verify / git push --no-verify"
