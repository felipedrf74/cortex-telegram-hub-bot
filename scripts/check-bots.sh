#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# Nexus Hub — Bot Token Diagnostic
#
# Verifies both bot tokens and reports which Telegram bot each
# resolves to. Helps diagnose the two-bot architecture:
#
#   @Hlepreguica_bot   — Production user-facing bot (Grammy long polling)
#                         Token in: .env (TELEGRAM_BOT_TOKEN)
#
#   @Nexushub94_bot    — Notification-only bot (agent lifecycle alerts)
#                         Token in: .env.agents (TELEGRAM_BOT_TOKEN)
#                         Does NOT respond to messages — sends only.
#
# Usage:
#   ./scripts/check-bots.sh
# ──────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No color

echo ""
echo "╔═══════════════════════════════════════════════════════╗"
echo "║  🤖 Nexus Hub — Bot Token Diagnostic                  ║"
echo "╚═══════════════════════════════════════════════════════╝"
echo ""

check_token() {
  local label="$1"
  local token="$2"
  local source="$3"

  if [ -z "$token" ]; then
    echo -e "  ${YELLOW}⚠️  $label: not configured${NC}"
    echo "     Source: $source"
    echo ""
    return 1
  fi

  # Mask token for display (show first 5 and last 5 chars)
  local masked="${token:0:5}...${token: -5}"

  local response
  response=$(curl -sf --max-time 10 "https://api.telegram.org/bot${token}/getMe" 2>/dev/null) || {
    echo -e "  ${RED}❌ $label: token INVALID or network error${NC}"
    echo "     Token: $masked"
    echo "     Source: $source"
    echo ""
    return 1
  }

  local ok
  ok=$(echo "$response" | grep -o '"ok":true' || true)
  if [ -z "$ok" ]; then
    local desc
    desc=$(echo "$response" | grep -o '"description":"[^"]*"' | cut -d'"' -f4)
    echo -e "  ${RED}❌ $label: $desc${NC}"
    echo "     Token: $masked"
    echo "     Source: $source"
    echo ""
    return 1
  fi

  local username
  username=$(echo "$response" | grep -o '"username":"[^"]*"' | cut -d'"' -f4)
  local bot_id
  bot_id=$(echo "$response" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)
  local first_name
  first_name=$(echo "$response" | grep -o '"first_name":"[^"]*"' | cut -d'"' -f4)

  echo -e "  ${GREEN}✅ $label${NC}"
  echo -e "     Bot: ${CYAN}@${username}${NC} (ID: ${bot_id})"
  echo "     Name: $first_name"
  echo "     Token: $masked"
  echo "     Source: $source"
  echo ""
  return 0
}

# ─── Check production bot (.env) ─────────────────────────────
PROD_TOKEN=""
if [ -f "$REPO_DIR/.env" ]; then
  PROD_TOKEN=$(grep -E '^TELEGRAM_BOT_TOKEN=' "$REPO_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d ' "'"'" || true)
fi

echo "── Production Bot (user-facing, Grammy long polling) ──"
check_token "Production bot" "$PROD_TOKEN" ".env" || true

# ─── Check notification bot (.env.agents) ────────────────────
NOTIF_TOKEN=""
NOTIF_CHAT=""
if [ -f "$REPO_DIR/.env.agents" ]; then
  NOTIF_TOKEN=$(grep -E '^TELEGRAM_BOT_TOKEN=' "$REPO_DIR/.env.agents" 2>/dev/null | head -1 | cut -d= -f2- | tr -d ' "'"'" || true)
  NOTIF_CHAT=$(grep -E '^TELEGRAM_CHAT_ID=' "$REPO_DIR/.env.agents" 2>/dev/null | head -1 | cut -d= -f2- | tr -d ' "'"'" || true)
fi

echo "── Notification Bot (agent alerts, send-only) ────────"
check_token "Notification bot" "$NOTIF_TOKEN" ".env.agents" || true

if [ -n "$NOTIF_CHAT" ]; then
  echo "  📬 Chat ID: $NOTIF_CHAT"
else
  echo -e "  ${YELLOW}⚠️  TELEGRAM_CHAT_ID not set in .env.agents — notifications disabled${NC}"
fi
echo ""

# ─── Check for token collision ───────────────────────────────
if [ -n "$PROD_TOKEN" ] && [ -n "$NOTIF_TOKEN" ]; then
  if [ "$PROD_TOKEN" = "$NOTIF_TOKEN" ]; then
    echo -e "${YELLOW}⚠️  WARNING: Both bots use the SAME token!${NC}"
    echo "   The production bot and notification bot should use different tokens."
    echo "   The notification bot (@Nexushub94_bot) should have its own token from BotFather."
  else
    echo -e "${GREEN}✅ Tokens are different (correct setup)${NC}"
  fi
  echo ""
fi

# ─── Test sending a notification ─────────────────────────────
if [ -n "$NOTIF_TOKEN" ] && [ -n "$NOTIF_CHAT" ]; then
  echo "── Send Test Notification? ─────────────────────────"
  echo "   Run with --test to send a test message:"
  echo "   ./scripts/check-bots.sh --test"
  echo ""

  for arg in "$@"; do
    if [ "$arg" = "--test" ]; then
      echo "  📤 Sending test notification..."
      TEST_RESP=$(curl -sf --max-time 10 -X POST \
        "https://api.telegram.org/bot${NOTIF_TOKEN}/sendMessage" \
        -H "Content-Type: application/json" \
        -d "{\"chat_id\":\"${NOTIF_CHAT}\",\"text\":\"🧪 <b>Bot diagnostic test</b>\\nNotification bot is working.\",\"parse_mode\":\"HTML\"}" \
        2>/dev/null) || {
        echo -e "  ${RED}❌ Failed to send test message${NC}"
        exit 1
      }
      local_ok=$(echo "$TEST_RESP" | grep -o '"ok":true' || true)
      if [ -n "$local_ok" ]; then
        echo -e "  ${GREEN}✅ Test message sent successfully${NC}"
      else
        local_desc=$(echo "$TEST_RESP" | grep -o '"description":"[^"]*"' | cut -d'"' -f4)
        echo -e "  ${RED}❌ Failed: $local_desc${NC}"
      fi
      echo ""
    fi
  done
fi

echo "── Summary ─────────────────────────────────────────"
echo "  @Hlepreguica_bot  → Production bot (responds to messages)"
echo "  @Nexushub94_bot   → Notification bot (sends alerts only)"
echo "  The notification bot does NOT respond to user messages."
echo "  This is by design — it is not 'unresponsive', it is send-only."
echo ""
