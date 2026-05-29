#!/usr/bin/env bash
# local-down.sh — stop the sandbox. Preserves data/ and named volumes.
#
# To wipe data too, use ./scripts/local-reset.sh.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-cortex-telegram-hub-bot}"

docker compose -p "$COMPOSE_PROJECT_NAME" -f docker-compose.local.yml down

echo "Sandbox stopped. Data preserved at: $ROOT/data/"
