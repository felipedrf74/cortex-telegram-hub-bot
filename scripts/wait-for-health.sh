#!/usr/bin/env bash
# wait-for-health.sh — block until the local sandbox is responsive.
#
# Polls /health on both compose services until both report healthy, or
# until the timeout elapses. Returns 0 on green, 1 on timeout.
#
# Used by local-up.sh and sim-local.sh.

set -euo pipefail

NEXUS_PORT="${NEXUS_LOCAL_PORT_TS:-8200}"
CONTENT_PORT="${NEXUS_LOCAL_PORT_PY:-8100}"
TIMEOUT_SECONDS="${LOCAL_HEALTH_TIMEOUT:-90}"
COMPOSE_FILE="${NEXUS_HEALTH_COMPOSE_FILE:-docker-compose.local.yml}"

NEXUS_URL="http://127.0.0.1:${NEXUS_PORT}/health"
CONTENT_URL="http://127.0.0.1:${CONTENT_PORT}/health"

echo "Waiting for local sandbox to become healthy (timeout: ${TIMEOUT_SECONDS}s)..."

start_at=$(date +%s)
nexus_ok=0
content_ok=0

while :; do
  if [ "$nexus_ok" -eq 0 ] && curl -fsS "$NEXUS_URL" >/dev/null 2>&1; then
    echo "  ✓ nexus-hub  ($NEXUS_URL)"
    nexus_ok=1
  fi
  if [ "$content_ok" -eq 0 ] && curl -fsS "$CONTENT_URL" >/dev/null 2>&1; then
    echo "  ✓ content-engine ($CONTENT_URL)"
    content_ok=1
  fi

  if [ "$nexus_ok" -eq 1 ] && [ "$content_ok" -eq 1 ]; then
    echo "Sandbox healthy."
    exit 0
  fi

  now=$(date +%s)
  elapsed=$((now - start_at))
  if [ "$elapsed" -ge "$TIMEOUT_SECONDS" ]; then
    echo "ERROR: sandbox not healthy after ${TIMEOUT_SECONDS}s" >&2
    echo "  nexus-hub:      $([ "$nexus_ok" -eq 1 ] && echo green || echo TIMEOUT)" >&2
    echo "  content-engine: $([ "$content_ok" -eq 1 ] && echo green || echo TIMEOUT)" >&2
    echo "Last 30 lines per container:" >&2
    if [ -n "${NEXUS_HEALTH_COMPOSE_PROJECT:-}" ]; then
      docker compose --project-name "$NEXUS_HEALTH_COMPOSE_PROJECT" -f "$COMPOSE_FILE" logs --tail=30 >&2 || true
    else
      docker compose -f "$COMPOSE_FILE" logs --tail=30 >&2 || true
    fi
    exit 1
  fi

  sleep 2
done
