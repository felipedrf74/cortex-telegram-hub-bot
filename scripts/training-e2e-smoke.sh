#!/usr/bin/env bash
# Verify that the latest isolated Training E2E backend is the one under test.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
# shellcheck source=scripts/training-e2e-env.sh
source "$ROOT/scripts/training-e2e-env.sh"
training_e2e_load_latest_env

BASE_URL="$NEXUS_TRAINING_E2E_BASE_URL"
METADATA="$NEXUS_TRAINING_E2E_ROOT/metadata.json"

echo "Training E2E backend smoke"
echo "  run id:  $NEXUS_TRAINING_E2E_RUN_ID"
echo "  backend: $BASE_URL"

if [[ "$BASE_URL" == "http://127.0.0.1:8200" || "$BASE_URL" == "http://localhost:8200" ]]; then
  echo "ERROR: refusing to accept default local backend port as Training E2E evidence." >&2
  exit 65
fi

curl -fsS "$BASE_URL/health" >/dev/null
SNAPSHOT_PATH="$(mktemp)"
cleanup() {
  rm -f -- "$SNAPSHOT_PATH"
}
trap cleanup EXIT

curl -fsS \
  -H "Authorization: Bearer ${NEXUS_TRAINING_E2E_PORTAL_READ_TOKEN}" \
  --output "$SNAPSHOT_PATH" \
  "$BASE_URL/api/snapshot"

node - "$METADATA" "$SNAPSHOT_PATH" <<'NODE'
const fs = require('fs');
const metadata = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const snapshot = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
const summary = {
  runId: metadata.runId,
  composeProject: metadata.composeProject,
  backendBaseUrl: metadata.backendBaseUrl,
  dbPath: metadata.dbPath,
  gitCommit: metadata.git?.shortCommit,
  snapshotVersion: snapshot.version ?? null,
  snapshotUptime: snapshot.uptime ?? null,
};
if (!metadata.backendBaseUrl || metadata.backendBaseUrl.includes(':8200')) {
  throw new Error('metadata backendBaseUrl is not isolated');
}
if (!String(metadata.dbPath || '').includes('/.local/training-e2e/')) {
  throw new Error('metadata dbPath is not under .local/training-e2e');
}
console.log(JSON.stringify(summary, null, 2));
NODE

echo "Training E2E backend smoke passed."
