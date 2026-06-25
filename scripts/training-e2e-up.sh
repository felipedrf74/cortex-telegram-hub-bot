#!/usr/bin/env bash
# Start an isolated backend/content-engine container pair for Training E2E.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
# shellcheck source=scripts/training-e2e-env.sh
source "$ROOT/scripts/training-e2e-env.sh"

RAW_RUN_ID="${NEXUS_TRAINING_E2E_RUN_ID:-training-e2e-$(date -u +%Y%m%d%H%M%S)-$(training_e2e_git rev-parse --short HEAD)}"
RUN_ID="$(training_e2e_sanitize_id "$RAW_RUN_ID")"
PROJECT="nexus-${RUN_ID}"
STATE_DIR="$ROOT/.local/training-e2e/$RUN_ID"
PORT_TS="${NEXUS_TRAINING_E2E_PORT_TS:-$(training_e2e_pick_port 18200)}"
PORT_PY="${NEXUS_TRAINING_E2E_PORT_PY:-$(training_e2e_pick_port 18100)}"
BASE_URL="http://127.0.0.1:${PORT_TS}"
AUTH_FILE="$STATE_DIR/local-ios-auth.json"
COMPOSE_FILE="$ROOT/docker-compose.training-e2e.yml"
PORTAL_READ_TOKEN="${NEXUS_TRAINING_E2E_PORTAL_READ_TOKEN:-nexus-training-e2e-read-token-2026-06-strong}"
LIVE_CALENDAR_ENABLED="${NEXUS_TRAINING_E2E_LIVE_CALENDAR:-0}"
LIVE_CALENDAR_PROVIDERS="${NEXUS_TRAINING_E2E_LIVE_CALENDAR_PROVIDERS:-google,outlook}"
LIVE_CALENDAR_OVERRIDE_FILE="$STATE_DIR/docker-compose.live-calendar.override.yml"
COMPOSE_FILES=(-f "$COMPOSE_FILE")

if [[ "$PORT_TS" == "8200" || "$PORT_PY" == "8100" ]]; then
  echo "ERROR: Training E2E refuses default local ports 8200/8100." >&2
  exit 64
fi

mkdir -p "$STATE_DIR/data" "$STATE_DIR/logs/backend" "$STATE_DIR/logs/content-engine"

require_live_calendar_env() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "ERROR: live Training calendar E2E requires $name." >&2
    exit 68
  fi
}

require_sandbox_label() {
  local name="$1"
  local value="${!name:-}"
  require_live_calendar_env "$name"
  if [[ "$value" =~ [Pp][Rr][Oo][Dd] || "$value" =~ [Pp][Rr][Oo][Dd][Uu][Cc][Tt][Ii][Oo][Nn] || "$value" =~ [Pp][Rr][Ii][Mm][Aa][Rr][Yy] || "$value" =~ [Pp][Ee][Rr][Ss][Oo][Nn][Aa][Ll] ]]; then
    echo "ERROR: $name appears to identify a production/personal calendar target: $value" >&2
    exit 69
  fi
  if [[ ! "$value" =~ [Ss][Aa][Nn][Dd][Bb][Oo][Xx]|[Ee]2[Ee]|[Qq][Aa]|[Tt][Ee][Ss][Tt]|[Ss][Tt][Aa][Gg][Ii][Nn][Gg]|[Nn][Oo][Nn][Pp][Rr][Oo][Dd] ]]; then
    echo "ERROR: $name must visibly identify a sandbox/test/e2e/staging/nonprod account: $value" >&2
    exit 69
  fi
}

if [[ "$LIVE_CALENDAR_ENABLED" == "1" ]]; then
  if [[ "${NEXUS_TRAINING_E2E_LIVE_CALENDAR_ACK:-}" != "sandbox-non-prod-calendar" ]]; then
    echo "ERROR: live Training calendar E2E requires NEXUS_TRAINING_E2E_LIVE_CALENDAR_ACK=sandbox-non-prod-calendar." >&2
    exit 67
  fi

  require_live_calendar_env OAUTH_ENCRYPTION_KEY
  export NEXUS_TRAINING_E2E_OAUTH_KEY="$OAUTH_ENCRYPTION_KEY"

  if [[ "$LIVE_CALENDAR_PROVIDERS" == *google* ]]; then
    require_live_calendar_env GOOGLE_CLIENT_ID
    require_live_calendar_env GOOGLE_CLIENT_SECRET
    require_live_calendar_env NEXUS_TRAINING_E2E_GOOGLE_REFRESH_TOKEN
    require_sandbox_label NEXUS_TRAINING_E2E_GOOGLE_ACCOUNT_LABEL
  fi

  if [[ "$LIVE_CALENDAR_PROVIDERS" == *outlook* ]]; then
    require_live_calendar_env OUTLOOK_CLIENT_ID
    require_live_calendar_env OUTLOOK_CLIENT_SECRET
    require_live_calendar_env OUTLOOK_TENANT_ID
    require_live_calendar_env NEXUS_TRAINING_E2E_OUTLOOK_REFRESH_TOKEN
    require_sandbox_label NEXUS_TRAINING_E2E_OUTLOOK_ACCOUNT_LABEL
  fi

  cat > "$LIVE_CALENDAR_OVERRIDE_FILE" <<'EOF'
services:
  nexus-hub:
    environment:
      TRAINING_CALENDAR_WRITES_ENABLED: "true"
      TRAINING_CALENDAR_SYNC_ENABLED: "true"
      GOOGLE_CLIENT_ID: ${GOOGLE_CLIENT_ID:?GOOGLE_CLIENT_ID required for live Training calendar E2E}
      GOOGLE_CLIENT_SECRET: ${GOOGLE_CLIENT_SECRET:?GOOGLE_CLIENT_SECRET required for live Training calendar E2E}
      GOOGLE_REFRESH_TOKEN: ""
      OUTLOOK_CLIENT_ID: ${OUTLOOK_CLIENT_ID:?OUTLOOK_CLIENT_ID required for live Training calendar E2E}
      OUTLOOK_CLIENT_SECRET: ${OUTLOOK_CLIENT_SECRET:?OUTLOOK_CLIENT_SECRET required for live Training calendar E2E}
      OUTLOOK_TENANT_ID: ${OUTLOOK_TENANT_ID:?OUTLOOK_TENANT_ID required for live Training calendar E2E}
      OUTLOOK_REFRESH_TOKEN: ""
EOF
  COMPOSE_FILES+=(-f "$LIVE_CALENDAR_OVERRIDE_FILE")
fi

export COMPOSE_PROJECT_NAME="$PROJECT"
export NEXUS_TRAINING_E2E_RUN_ID="$RUN_ID"
export NEXUS_TRAINING_E2E_ROOT="$STATE_DIR"
export NEXUS_TRAINING_E2E_PORT_TS="$PORT_TS"
export NEXUS_TRAINING_E2E_PORT_PY="$PORT_PY"
export NEXUS_TRAINING_E2E_PORTAL_READ_TOKEN="$PORTAL_READ_TOKEN"
export NEXUS_TRAINING_E2E_GIT_DIR="$(training_e2e_git_dir)"
export NEXUS_TRAINING_E2E_LIVE_CALENDAR="$LIVE_CALENDAR_ENABLED"
export NEXUS_TRAINING_E2E_LIVE_CALENDAR_PROVIDERS="$LIVE_CALENDAR_PROVIDERS"

echo "Starting isolated Training E2E containers"
echo "  run id:     $RUN_ID"
echo "  project:    $PROJECT"
echo "  backend:    $BASE_URL"
echo "  content:    http://127.0.0.1:${PORT_PY}"
echo "  state dir:  $STATE_DIR"
if [[ "$LIVE_CALENDAR_ENABLED" == "1" ]]; then
  echo "  calendar:   live sandbox providers (${LIVE_CALENDAR_PROVIDERS}); fixture-safe defaults overridden for this run only"
  echo "  override:   $LIVE_CALENDAR_OVERRIDE_FILE"
fi

docker compose --project-name "$PROJECT" "${COMPOSE_FILES[@]}" up --build -d

NEXUS_LOCAL_PORT_TS="$PORT_TS" \
NEXUS_LOCAL_PORT_PY="$PORT_PY" \
NEXUS_HEALTH_COMPOSE_PROJECT="$PROJECT" \
NEXUS_HEALTH_COMPOSE_FILE="$COMPOSE_FILE" \
  "$ROOT/scripts/wait-for-health.sh"

if [[ "${NEXUS_TRAINING_E2E_PREPARE_IOS_AUTH:-1}" == "1" ]]; then
  echo "Preparing local iOS debug auth for isolated Training E2E backend"
  NEXUS_LOCAL_BASE_URL="$BASE_URL" \
  NEXUS_LOCAL_DB_PATH="$STATE_DIR/data/training-e2e.db" \
  NEXUS_LOCAL_AUTH_IMPORT_PATH="$AUTH_FILE" \
  NEXUS_LOCAL_IOS_EMAIL="${NEXUS_TRAINING_E2E_IOS_EMAIL:-nexus-training-e2e@example.test}" \
  NEXUS_LOCAL_IOS_DEVICE_ID="${NEXUS_TRAINING_E2E_DEVICE_ID:-training-e2e-${RUN_ID}}" \
  NEXUS_LOCAL_IOS_INVITE_CODE="${NEXUS_TRAINING_E2E_IOS_INVITE_CODE:-LOCAL-TRAINING-E2E}" \
    node "$ROOT/scripts/local-ios-debug-auth.mjs"
fi

docker compose --project-name "$PROJECT" -f "$COMPOSE_FILE" ps --format json > "$STATE_DIR/compose-ps.json" || true

node - "$STATE_DIR/metadata.json" <<'NODE'
const fs = require('fs');
const { execSync } = require('child_process');

const target = process.argv[2];
function cmd(command) {
  try { return execSync(command, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return null; }
}
const repoRoot = process.cwd();
const gitDir = JSON.stringify(process.env.NEXUS_TRAINING_E2E_GIT_DIR || `${repoRoot}/.git`);
const workTree = JSON.stringify(repoRoot);
const backendImageName = process.env.NEXUS_TRAINING_E2E_NODE_IMAGE || 'nexus-hub-node:training-e2e';
const contentImageName = process.env.NEXUS_TRAINING_E2E_CONTENT_IMAGE || 'nexus-hub-content-engine:training-e2e';
function git(args) {
  return cmd(`git --git-dir=${gitDir} --work-tree=${workTree} ${args}`);
}

const metadata = {
  schemaVersion: 'training_e2e_environment.v1',
  runId: process.env.NEXUS_TRAINING_E2E_RUN_ID,
  composeProject: process.env.COMPOSE_PROJECT_NAME,
  composeFile: 'docker-compose.training-e2e.yml',
  composeFiles: process.env.NEXUS_TRAINING_E2E_LIVE_CALENDAR === '1'
    ? ['docker-compose.training-e2e.yml', `${process.env.NEXUS_TRAINING_E2E_ROOT}/docker-compose.live-calendar.override.yml`]
    : ['docker-compose.training-e2e.yml'],
  backendBaseUrl: `http://127.0.0.1:${process.env.NEXUS_TRAINING_E2E_PORT_TS}`,
  contentEngineBaseUrl: `http://127.0.0.1:${process.env.NEXUS_TRAINING_E2E_PORT_PY}`,
  backendPort: Number(process.env.NEXUS_TRAINING_E2E_PORT_TS),
  contentEnginePort: Number(process.env.NEXUS_TRAINING_E2E_PORT_PY),
  dbPath: `${process.env.NEXUS_TRAINING_E2E_ROOT}/data/training-e2e.db`,
  authImportPath: `${process.env.NEXUS_TRAINING_E2E_ROOT}/local-ios-auth.json`,
  liveCalendar: {
    enabled: process.env.NEXUS_TRAINING_E2E_LIVE_CALENDAR === '1',
    providers: String(process.env.NEXUS_TRAINING_E2E_LIVE_CALENDAR_PROVIDERS || 'google,outlook')
      .split(',')
      .map((provider) => provider.trim())
      .filter(Boolean),
    writesEnabled: process.env.NEXUS_TRAINING_E2E_LIVE_CALENDAR === '1',
    syncEnabled: process.env.NEXUS_TRAINING_E2E_LIVE_CALENDAR === '1',
    overrideFile: process.env.NEXUS_TRAINING_E2E_LIVE_CALENDAR === '1'
      ? `${process.env.NEXUS_TRAINING_E2E_ROOT}/docker-compose.live-calendar.override.yml`
      : null,
  },
  sqlite: {
    journalMode: 'DELETE',
    reason: 'host/container helper DB evidence must read the same file as the running backend',
  },
  git: {
    branch: git('branch --show-current') || null,
    commit: git('rev-parse HEAD'),
    shortCommit: git('rev-parse --short HEAD'),
    statusShort: git('status --short --branch'),
  },
  images: {
    backend: {
      name: backendImageName,
      id: cmd(`docker image inspect ${JSON.stringify(backendImageName)} --format {{.Id}}`),
      repoDigests: cmd(`docker image inspect ${JSON.stringify(backendImageName)} --format '{{json .RepoDigests}}'`),
    },
    contentEngine: {
      name: contentImageName,
      id: cmd(`docker image inspect ${JSON.stringify(contentImageName)} --format {{.Id}}`),
      repoDigests: cmd(`docker image inspect ${JSON.stringify(contentImageName)} --format '{{json .RepoDigests}}'`),
    },
  },
  generatedAt: new Date().toISOString(),
};

fs.writeFileSync(target, JSON.stringify(metadata, null, 2) + '\n');
console.log(JSON.stringify(metadata, null, 2));
NODE

cat > "$ROOT/.local/training-e2e/latest.env" <<EOF
export NEXUS_TRAINING_E2E_RUN_ID='$RUN_ID'
export NEXUS_TRAINING_E2E_PROJECT='$PROJECT'
export NEXUS_TRAINING_E2E_ROOT='$STATE_DIR'
export NEXUS_TRAINING_E2E_PORT_TS='$PORT_TS'
export NEXUS_TRAINING_E2E_PORT_PY='$PORT_PY'
export NEXUS_TRAINING_E2E_BASE_URL='$BASE_URL'
export NEXUS_TRAINING_E2E_AUTH_FILE='$AUTH_FILE'
export NEXUS_TRAINING_E2E_COMPOSE_FILE='$COMPOSE_FILE'
export NEXUS_TRAINING_E2E_LIVE_CALENDAR='$LIVE_CALENDAR_ENABLED'
export NEXUS_TRAINING_E2E_LIVE_CALENDAR_PROVIDERS='$LIVE_CALENDAR_PROVIDERS'
export NEXUS_TRAINING_E2E_LIVE_CALENDAR_OVERRIDE_FILE='$LIVE_CALENDAR_OVERRIDE_FILE'
export NEXUS_TRAINING_E2E_PORTAL_READ_TOKEN='$PORTAL_READ_TOKEN'
export NEXUS_TRAINING_E2E_GIT_DIR='$NEXUS_TRAINING_E2E_GIT_DIR'
EOF

echo "Training E2E environment is ready."
echo "Metadata: $STATE_DIR/metadata.json"
echo "Stop with: scripts/training-e2e-down.sh"
