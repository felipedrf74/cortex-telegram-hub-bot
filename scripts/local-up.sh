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

COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-cortex-telegram-hub-bot}"

if [ ! -f .env.local ]; then
  echo "ERROR: .env.local not found at repo root."
  echo "       Copy the template and fill in your dev keys:"
  echo "       cp .env.local.example .env.local"
  exit 1
fi

mkdir -p data logs

normalize_mount_source() {
  case "$1" in
    /host_mnt/*) printf '/%s' "${1#/host_mnt/}" ;;
    *) printf '%s' "$1" ;;
  esac
}

remove_conflicting_container() {
  local name="$1"
  local expected_destination="$2"
  local expected_source="$3"
  local id project service source normalized_source

  id="$(docker ps -aq --filter "name=^/${name}$" 2>/dev/null || true)"
  if [ -z "$id" ]; then
    return 0
  fi

  project="$(docker inspect "$id" --format '{{ index .Config.Labels "com.docker.compose.project" }}' 2>/dev/null || true)"
  service="$(docker inspect "$id" --format '{{ index .Config.Labels "com.docker.compose.service" }}' 2>/dev/null || true)"

  if [ "$project" = "$COMPOSE_PROJECT_NAME" ]; then
    return 0
  fi

  source="$(docker inspect "$id" --format "{{ range .Mounts }}{{ if eq .Destination \"$expected_destination\" }}{{ .Source }}{{ end }}{{ end }}" 2>/dev/null || true)"
  normalized_source="$(normalize_mount_source "$source")"
  if [ "$project" = "$COMPOSE_PROJECT_NAME" ] && [ -n "$normalized_source" ] && [ "$normalized_source" != "$expected_source" ]; then
    echo "WARN: Removing stale local sandbox container '$name' from the same Compose project but a different worktree." >&2
    echo "      Mounted:  '$normalized_source'" >&2
    echo "      Expected: '$expected_source'" >&2
    docker rm -f "$id" >/dev/null
    return 0
  fi

  case "$service" in
    nexus-hub|content-engine)
      echo "WARN: Removing stale local sandbox container '$name' from Compose project '${project:-unknown}'." >&2
      echo "      Expected project: '$COMPOSE_PROJECT_NAME'. This avoids fixed-name Docker conflicts after branch/restart changes." >&2
      docker rm -f "$id" >/dev/null
      ;;
    *)
      echo "ERROR: Container name '$name' is already in use by non-sandbox container '$id'." >&2
      echo "       Refusing to remove it automatically. Stop/rename that container, then rerun local-up." >&2
      exit 1
      ;;
  esac
}

remove_conflicting_container "nexus-hub-content-engine" "/engine" "$ROOT/content-engine"
remove_conflicting_container "nexus-hub-node" "/app/src" "$ROOT/src"

echo "═══════════════════════════════════════════════"
echo "  Nexus Hub — local Docker sandbox"
echo "═══════════════════════════════════════════════"
echo "Node port:           127.0.0.1:${NEXUS_LOCAL_PORT_TS:-8200}"
echo "Content engine port: 127.0.0.1:${NEXUS_LOCAL_PORT_PY:-8100}"
echo "DB path on host:     $ROOT/data/"
echo ""

if ! docker compose -p "$COMPOSE_PROJECT_NAME" -f docker-compose.local.yml up --build -d; then
  echo ""
  echo "WARN: Docker rebuild failed. This is often a transient npm/Docker network issue." >&2
  echo "      Trying to boot the last known local images without rebuilding..." >&2

  if docker image inspect nexus-hub-node:local >/dev/null 2>&1 \
    && docker image inspect nexus-hub-content-engine:local >/dev/null 2>&1; then
    docker compose -p "$COMPOSE_PROJECT_NAME" -f docker-compose.local.yml up -d --no-build
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
echo "  docker compose -p $COMPOSE_PROJECT_NAME -f docker-compose.local.yml logs -f"
echo "  ./scripts/local-down.sh          — clean shutdown"
