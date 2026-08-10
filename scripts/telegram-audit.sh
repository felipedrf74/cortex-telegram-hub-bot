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
echo "M21 STAGE B-C END-STATE (2026-07). Purged:"
echo "  [x] config/env: src/config.ts comments, .env.example TELEGRAM_*,"
echo "      ecosystem*.config.js comments, package.json eval:training wrapper"
echo "      + telegram keyword"
echo "  [x] JWT-userId telegram-id fallbacks: dashboard-home-input.ts,"
echo "      skills.ts getCaller, onboarding.ts (verified-JWT rationale, as M9)"
echo "  [x] notification-out Telegram channel: registry-cross-tenant-alert-"
echo "      channels.ts, registry-channel-smoke-builder.ts, routing-policy"
echo "      defaults, notification-contracts 'legacy_telegram' (live paging is"
echo "      operator-alerts.ts -> OPERATOR_ALERT_WEBHOOK_URL; error-monitor"
echo "      routes every alertable error through recordOperatorAlert)"
echo "  [x] Stage C: migrations/259_telegram_identity_archive.sql archives"
echo "      users.telegram_id (archive-first; live column KEPT; one-release"
echo "      soak documented before any future NULL/DROP)"
echo "  [x] Legacy TELEGRAM_* eval/smoke disable sentinels replaced by the"
echo "      transport-neutral NEXUS_CONTENT_LIVE_EVAL_DELIVERY_DISABLED guard;"
echo "      local, Compose, training, and release-verifier placeholders removed"
echo
echo "DELIBERATE REMNANTS (blocked on the owner-gated identity migration):"
echo "  [ ] Owner bootstrap identity: OWNER_TELEGRAM_ID + users.telegram_id"
echo "      reads in src/services/user-service.ts (seedOwnerUser & co.),"
echo "      src/services/owner-bootstrap-preflight.ts, src/tools/owner-"
echo "      bootstrap-preflight.ts, src/services/database-bootstrap.ts comment."
echo "  [ ] getUserByTelegramId remains exported for: owner bootstrap, the"
echo "      owner-gated skills.ts override target contract, and the"
echo "      garmin-session-store legacy resolution fallback."
echo "  [ ] Telegram-era users columns/records + scattered historical comments"
echo "      elsewhere in src/ (scheduler, i18n, request-context, collectors,"
echo "      user-data-export, secretary-fastpath, snapshot-builder, ...):"
echo "      these reference the telegram_id column or telegram-era history and"
echo "      converge to zero with the identity migration, not before."
echo "  Gate: __tests__/scripts/telegram-purge-gate.test.ts pins Stage A+B"
echo "  files at zero live refs and pins migration 259 as archive-first."

echo
echo "Detail (grep -rin telegram src/):"
grep -rin 'telegram' src/ || true
