#!/usr/bin/env bash
# Stop the latest or selected isolated Training E2E container pair.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
# shellcheck source=scripts/training-e2e-env.sh
source "$ROOT/scripts/training-e2e-env.sh"

if [[ -z "${NEXUS_TRAINING_E2E_PROJECT:-}" ]]; then
  training_e2e_load_latest_env
fi

COMPOSE_FILE="${NEXUS_TRAINING_E2E_COMPOSE_FILE:-$ROOT/docker-compose.training-e2e.yml}"

echo "Stopping isolated Training E2E containers"
echo "  project: ${NEXUS_TRAINING_E2E_PROJECT}"
docker compose --project-name "$NEXUS_TRAINING_E2E_PROJECT" -f "$COMPOSE_FILE" down

echo "State preserved at: ${NEXUS_TRAINING_E2E_ROOT:-unknown}"
