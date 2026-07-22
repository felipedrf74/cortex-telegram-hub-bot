#!/usr/bin/env bash
# local-up.sh — boot the local Docker sandbox.
#
# Idempotent. If containers are already running this just rebuilds and
# restarts them.
#
# Side effects:
#   - Creates ./data/ and ./logs/ on the host if missing.
#   - Builds (or reuses cached) images nexus-hub-node:local and
#     nexus-hub-content-engine:local.
#   - Starts two containers bound to 127.0.0.1:8200 and 127.0.0.1:8100.
#   - Waits for both to report /health green (default timeout 90s).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

COMPOSE_ARGS=(-f docker-compose.local.yml)
if [ "${NEXUS_CHAT_EVAL_ZERO_CLOUD_PROFILE:-0}" = "1" ]; then
  COMPOSE_ARGS+=(-f docker-compose.chat-eval-local.yml)
fi

if [ ! -f .env.local ]; then
  echo "ERROR: .env.local not found at repo root."
  echo "       Copy the template and fill in your dev keys:"
  echo "       cp .env.local.example .env.local"
  exit 1
fi

mkdir -p data logs

echo "═══════════════════════════════════════════════"
echo "  Nexus Hub — local Docker sandbox"
echo "═══════════════════════════════════════════════"
echo "Node port:           127.0.0.1:${NEXUS_LOCAL_PORT_TS:-8200}"
echo "Content engine port: 127.0.0.1:${NEXUS_LOCAL_PORT_PY:-8100}"
echo "DB path on host:     $ROOT/data/"
echo ""

if ! docker compose "${COMPOSE_ARGS[@]}" up --build -d; then
  echo ""
  echo "WARN: Docker rebuild failed. This is often a transient npm/Docker network issue." >&2
  echo "      Trying to boot the last known local images without rebuilding..." >&2

  if docker image inspect nexus-hub-node:local >/dev/null 2>&1 \
    && docker image inspect nexus-hub-content-engine:local >/dev/null 2>&1; then
    docker compose "${COMPOSE_ARGS[@]}" up -d --no-build
    echo "WARN: Sandbox started from existing local images." >&2
    echo "      If package.json or Dockerfile changed, rerun local-up once the network is stable." >&2
  else
    echo "ERROR: No existing local images are available for fallback startup." >&2
    exit 1
  fi
fi

"$ROOT/scripts/wait-for-health.sh"

echo ""
echo "Sandbox is up. Next steps:"
echo "  ./scripts/local-smoke.sh         — run the 5-check contract"
echo "  ./scripts/sim-local.sh           — boot the iOS Simulator against it"
echo "  docker compose -f docker-compose.local.yml logs -f"
echo "  ./scripts/local-down.sh          — clean shutdown"
