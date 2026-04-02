#!/usr/bin/env bash
# Health check script for PM2 / Docker HEALTHCHECK / cron monitoring.
# Exits 0 on healthy, 1 on degraded/unreachable.
#
# Usage:
#   ./scripts/health-check.sh              # default: localhost:8200
#   PORTAL_PORT=9000 ./scripts/health-check.sh
#   ./scripts/health-check.sh --verbose    # prints response body

set -euo pipefail

PORT="${PORTAL_PORT:-8200}"
URL="http://127.0.0.1:${PORT}/health"
TIMEOUT=5
VERBOSE=false

for arg in "$@"; do
  case "$arg" in
    --verbose|-v) VERBOSE=true ;;
  esac
done

RESPONSE=$(curl -sf --max-time "$TIMEOUT" "$URL" 2>/dev/null) || {
  echo "FAIL: health endpoint unreachable at $URL"
  exit 1
}

STATUS=$(echo "$RESPONSE" | grep -o '"status":"[^"]*"' | head -1 | cut -d'"' -f4)

if [ "$VERBOSE" = true ]; then
  echo "$RESPONSE"
fi

if [ "$STATUS" = "healthy" ]; then
  exit 0
else
  echo "FAIL: status=$STATUS"
  exit 1
fi
