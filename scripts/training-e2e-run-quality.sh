#!/usr/bin/env bash
# Rerun only the Training persona contract inside the backend SQLite lock domain.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
# shellcheck source=scripts/training-e2e-env.sh
source "$ROOT/scripts/training-e2e-env.sh"
training_e2e_load_latest_env

COMPOSE_FILE="${NEXUS_TRAINING_E2E_COMPOSE_FILE:-$ROOT/docker-compose.training-e2e.yml}"
COMPOSE_FILES=(-f "$COMPOSE_FILE")
if [[ "${NEXUS_TRAINING_E2E_LIVE_CALENDAR:-0}" == "1" ]]; then
  COMPOSE_FILES+=(-f "$NEXUS_TRAINING_E2E_LIVE_CALENDAR_OVERRIDE_FILE")
fi
export COMPOSE_DISABLE_ENV_FILE=1
export NEXUS_TRAINING_E2E_SOURCE_ROOT="$ROOT"

node scripts/training-e2e-verify-freshness.mjs
docker compose --project-name "$NEXUS_TRAINING_E2E_PROJECT" "${COMPOSE_FILES[@]}" exec -T \
  -e NEXUS_TRAINING_E2E_IN_CONTAINER=1 \
  -e NEXUS_TRAINING_E2E_ROOT=/app/training-e2e-state \
  -e NEXUS_TRAINING_E2E_AUTH_FILE=/app/training-e2e-state/local-ios-auth.json \
  -e NEXUS_TRAINING_E2E_IOS_JWT_SECRET_FILE=/app/training-e2e-state/quality-ios-jwt-secret \
  -e NEXUS_TRAINING_E2E_BASE_URL="$NEXUS_TRAINING_E2E_BASE_URL" \
  -e NEXUS_TRAINING_E2E_API_BASE_URL=http://127.0.0.1:8200 \
  -e NEXUS_TRAINING_E2E_RUN_ID="$NEXUS_TRAINING_E2E_RUN_ID" \
  nexus-hub npx tsx scripts/training-e2e-quality.ts
node scripts/training-e2e-verify-freshness.mjs
