#!/usr/bin/env bash
# telegram-audit.sh — inventory of live Telegram references in src/.
#
# Telegram inbound was removed upstream (src/bot.ts / src/handlers/ no longer
# exist). This script prints a checklist of every remaining case-insensitive
# "telegram" reference in src/ so the staged purge (M9 chat-path code,
# M21 config/env/DB) can be tracked to zero.
#
# Usage: scripts/telegram-audit.sh [--counts-only]
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

MODE="${1:-full}"

FILES="$(grep -ril 'telegram' src/ 2>/dev/null | sort || true)"
TOTAL_REFS="$(grep -rio 'telegram' src/ 2>/dev/null | wc -l | tr -d ' ')"
TOTAL_FILES="$(printf '%s\n' "$FILES" | sed '/^$/d' | wc -l | tr -d ' ')"

echo "Telegram reference audit — src/"
echo "  files with references : $TOTAL_FILES"
echo "  total references      : $TOTAL_REFS"
echo

if [ "$MODE" = "--counts-only" ]; then
  exit 0
fi

echo "Checklist (per-file occurrence counts):"
if [ -n "$FILES" ]; then
  printf '%s\n' "$FILES" | while IFS= read -r f; do
    [ -n "$f" ] || continue
    COUNT="$(grep -io 'telegram' "$f" | wc -l | tr -d ' ')"
    printf '  [ ] %-70s %s\n' "$f" "$COUNT"
  done
else
  echo "  (none — purge complete)"
fi

echo
echo "M21 FOLLOW-UPS (telegram-id identity fallbacks OUTSIDE the chat path):"
echo "  The chat-path fallback in src/api/routes/chat-message-tier-gate.ts was"
echo "  removed in M9 (iOS JWT userId is keyed to users.id). These remaining"
echo "  getUserById(...) || getUserByTelegramId(...) sites are NOT chat-path and"
echo "  are owned by the M21 config/DB migration — audit them before Stage B/C:"
echo "  [ ] src/api/routes/dashboard-home-input.ts (getUserByTelegramId fallback)"
echo "  [ ] src/api/routes/skills.ts (getUserByTelegramId fallback + target lookups)"
echo "  [ ] src/services/onboarding.ts (getUserByTelegramId fallback)"

echo
echo "Detail (grep -rin telegram src/):"
grep -rin 'telegram' src/ || true
