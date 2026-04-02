#!/usr/bin/env bash
# PM2 Health Watchdog — restarts the bot after N consecutive health check failures.
#
# Designed to run as a cron job every minute:
#   * * * * * /path/to/scripts/pm2-health-watchdog.sh
#
# Environment:
#   PM2_APP_NAME    — PM2 process name (default: telegram-hub-bot)
#   PORTAL_PORT     — portal port (default: 8200)
#   MAX_FAILURES    — consecutive failures before restart (default: 3)

set -euo pipefail

APP_NAME="${PM2_APP_NAME:-telegram-hub-bot}"
PORT="${PORTAL_PORT:-8200}"
MAX_FAILURES="${MAX_FAILURES:-3}"
COUNTER_FILE="/tmp/nexushub-health-failures"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Run the health check
if "$SCRIPT_DIR/health-check.sh" >/dev/null 2>&1; then
  # Healthy — reset counter
  echo 0 > "$COUNTER_FILE"
  exit 0
fi

# Failed — increment counter
CURRENT=$(cat "$COUNTER_FILE" 2>/dev/null || echo 0)
CURRENT=$((CURRENT + 1))
echo "$CURRENT" > "$COUNTER_FILE"

if [ "$CURRENT" -ge "$MAX_FAILURES" ]; then
  echo "$(date '+%Y-%m-%d %H:%M:%S') WATCHDOG: $CURRENT consecutive failures — restarting $APP_NAME"
  pm2 restart "$APP_NAME" 2>/dev/null || true
  echo 0 > "$COUNTER_FILE"
else
  echo "$(date '+%Y-%m-%d %H:%M:%S') WATCHDOG: health check failed ($CURRENT/$MAX_FAILURES)"
fi
