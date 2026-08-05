#!/usr/bin/env bash
# Start an isolated backend/content-engine container pair for Training E2E.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
# shellcheck source=scripts/training-e2e-env.sh
source "$ROOT/scripts/training-e2e-env.sh"

RAW_RUN_ID="${NEXUS_TRAINING_E2E_RUN_ID:-training-e2e-$(date -u +%Y%m%d%H%M%S)-$(training_e2e_git rev-parse --short HEAD)}"
RUN_ID="$(training_e2e_sanitize_id "$RAW_RUN_ID")"
if [[ -z "$RUN_ID" ]]; then
  echo "ERROR: Training E2E run id is empty after sanitization." >&2
  exit 64
fi
PROJECT="nexus-${RUN_ID}"
STATE_PARENT="$ROOT/.local/training-e2e"
STATE_DIR="$STATE_PARENT/$RUN_ID"
RESUME_ENABLED="${NEXUS_TRAINING_E2E_RESUME:-0}"
RUN_POLICY_MODE="fresh"
RUN_POLICY_QUALIFYING="1"
if [[ -e "$STATE_DIR" ]]; then
  if [[ "$RESUME_ENABLED" != "1" ]]; then
    echo "ERROR: Training E2E state already exists at $STATE_DIR." >&2
    echo "Choose a fresh run id, or set NEXUS_TRAINING_E2E_RESUME=1 for non-qualifying debug use." >&2
    exit 66
  fi
  RUN_POLICY_MODE="resume"
  RUN_POLICY_QUALIFYING="0"
fi
PORT_TS="${NEXUS_TRAINING_E2E_PORT_TS:-$(training_e2e_pick_port 18200)}"
PORT_PY="${NEXUS_TRAINING_E2E_PORT_PY:-$(training_e2e_pick_port 18100)}"
BASE_URL="http://127.0.0.1:${PORT_TS}"
AUTH_FILE="$STATE_DIR/local-ios-auth.json"
COMPOSE_FILE="$ROOT/docker-compose.training-e2e.yml"
PORTAL_READ_TOKEN="${NEXUS_TRAINING_E2E_PORTAL_READ_TOKEN:-nexus-training-e2e-read-token-2026-06-strong}"
IOS_API_JWT_SECRET="${NEXUS_TRAINING_E2E_IOS_API_JWT_SECRET:-nexus-training-e2e-ios-jwt-secret-2026-06-strong-48-byte}"
IOS_JWT_SECRET_FILE="$STATE_DIR/quality-ios-jwt-secret"
LIVE_CALENDAR_ENABLED="${NEXUS_TRAINING_E2E_LIVE_CALENDAR:-0}"
RAW_LIVE_CALENDAR_PROVIDERS="${NEXUS_TRAINING_E2E_LIVE_CALENDAR_PROVIDERS:-google,outlook}"
LIVE_CALENDAR_PROVIDERS="$(node --input-type=module -e '
  import("./scripts/lib/training-e2e-contract.mjs")
    .then(({ normalizeLiveCalendarProviders }) => {
      process.stdout.write(normalizeLiveCalendarProviders(process.argv[1].split(",")).join(","));
    });
' "$RAW_LIVE_CALENDAR_PROVIDERS")"
LIVE_CALENDAR_OVERRIDE_FILE="$STATE_DIR/docker-compose.live-calendar.override.yml"
COMPOSE_FILES=(-f "$COMPOSE_FILE")
EXPECTED_NODE_IMAGE="nexus-hub-node:training-e2e-${RUN_ID}"
EXPECTED_CONTENT_IMAGE="nexus-hub-content-engine:training-e2e-${RUN_ID}"
NODE_IMAGE="${NEXUS_TRAINING_E2E_NODE_IMAGE:-$EXPECTED_NODE_IMAGE}"
CONTENT_IMAGE="${NEXUS_TRAINING_E2E_CONTENT_IMAGE:-$EXPECTED_CONTENT_IMAGE}"
if [[ "$NODE_IMAGE" != "$EXPECTED_NODE_IMAGE" || "$CONTENT_IMAGE" != "$EXPECTED_CONTENT_IMAGE" ]]; then
  echo "ERROR: Training E2E qualifying image names must exactly match the run-scoped tags for $RUN_ID." >&2
  exit 64
fi

GIT_DIR="$(training_e2e_git_dir)"
BACKEND_COMMIT="$(training_e2e_git rev-parse HEAD)"
if [[ ! "$BACKEND_COMMIT" =~ ^[0-9a-f]{40}$ ]]; then
  echo "ERROR: Training E2E could not resolve an exact backend commit." >&2
  exit 71
fi
if [[ -n "${NEXUS_TRAINING_E2E_BASE_COMMIT:-}" ]]; then
  if ! BASE_COMMIT="$(training_e2e_git rev-parse "${NEXUS_TRAINING_E2E_BASE_COMMIT}^{commit}" 2>/dev/null)"; then
    echo "ERROR: NEXUS_TRAINING_E2E_BASE_COMMIT is not a valid commit." >&2
    exit 71
  fi
elif ! BASE_COMMIT="$(training_e2e_git merge-base HEAD origin/main 2>/dev/null)"; then
  echo "ERROR: Training E2E requires an exact base commit; set NEXUS_TRAINING_E2E_BASE_COMMIT or fetch origin/main." >&2
  exit 71
fi
if [[ ! "$BASE_COMMIT" =~ ^[0-9a-f]{40}$ ]] \
  || ! training_e2e_git merge-base --is-ancestor "$BASE_COMMIT" "$BACKEND_COMMIT"; then
  echo "ERROR: Training E2E base commit must be an exact ancestor of backend HEAD." >&2
  exit 71
fi

training_e2e_dirty_tree_digest() {
  node --input-type=module -e '
    import("./scripts/lib/training-e2e-contract.mjs")
      .then(({ computeTrainingE2EDirtyTreeDigest }) => {
        process.stdout.write(computeTrainingE2EDirtyTreeDigest({
          repoRoot: process.argv[1],
          gitDir: process.argv[2],
        }));
      });
  ' "$ROOT" "$GIT_DIR"
}
DIRTY_TREE_DIFF_SHA256="$(training_e2e_dirty_tree_digest)"
if [[ ! "$DIRTY_TREE_DIFF_SHA256" =~ ^[0-9a-f]{64}$ ]]; then
  echo "ERROR: Training E2E could not resolve the dirty-tree source digest." >&2
  exit 71
fi

if [[ "$PORT_TS" == "8200" || "$PORT_PY" == "8100" ]]; then
  echo "ERROR: Training E2E refuses default local ports 8200/8100." >&2
  exit 64
fi

mkdir -p "$STATE_DIR/data" "$STATE_DIR/logs/backend" "$STATE_DIR/logs/content-engine"
(umask 077; printf '%s' "$IOS_API_JWT_SECRET" > "$IOS_JWT_SECRET_FILE")
chmod 600 "$IOS_JWT_SECRET_FILE"

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

  node --input-type=module -e '
    import fs from "node:fs";
    import("./scripts/lib/training-e2e-contract.mjs")
      .then(({ buildLiveCalendarComposeOverride }) => {
        fs.writeFileSync(process.argv[1], buildLiveCalendarComposeOverride(process.argv[2].split(",")), { mode: 0o600 });
      });
  ' "$LIVE_CALENDAR_OVERRIDE_FILE" "$LIVE_CALENDAR_PROVIDERS"
  COMPOSE_FILES+=(-f "$LIVE_CALENDAR_OVERRIDE_FILE")
fi

export COMPOSE_PROJECT_NAME="$PROJECT"
# Docker Compose otherwise auto-loads a project-level .env for interpolation
# even when services declare no env_file. Qualifying runs accept only the
# explicit variables exported by this harness (and the gated live override).
export COMPOSE_DISABLE_ENV_FILE=1
export NEXUS_TRAINING_E2E_RUN_ID="$RUN_ID"
export NEXUS_TRAINING_E2E_ROOT="$STATE_DIR"
export NEXUS_TRAINING_E2E_SOURCE_ROOT="$ROOT"
export NEXUS_TRAINING_E2E_PORT_TS="$PORT_TS"
export NEXUS_TRAINING_E2E_PORT_PY="$PORT_PY"
export NEXUS_TRAINING_E2E_PORTAL_READ_TOKEN="$PORTAL_READ_TOKEN"
export NEXUS_TRAINING_E2E_IOS_API_JWT_SECRET="$IOS_API_JWT_SECRET"
export NEXUS_TRAINING_E2E_GIT_DIR="$GIT_DIR"
export NEXUS_TRAINING_E2E_BACKEND_COMMIT="$BACKEND_COMMIT"
export NEXUS_TRAINING_E2E_BASE_COMMIT="$BASE_COMMIT"
export NEXUS_TRAINING_E2E_DIRTY_TREE_DIFF_SHA256="$DIRTY_TREE_DIFF_SHA256"
export NEXUS_TRAINING_E2E_LIVE_CALENDAR="$LIVE_CALENDAR_ENABLED"
export NEXUS_TRAINING_E2E_LIVE_CALENDAR_PROVIDERS="$LIVE_CALENDAR_PROVIDERS"
export NEXUS_TRAINING_E2E_NODE_IMAGE="$NODE_IMAGE"
export NEXUS_TRAINING_E2E_CONTENT_IMAGE="$CONTENT_IMAGE"
export NEXUS_TRAINING_E2E_RUN_POLICY_MODE="$RUN_POLICY_MODE"
export NEXUS_TRAINING_E2E_RUN_POLICY_QUALIFYING="$RUN_POLICY_QUALIFYING"

CONTAINERS_STARTED=0
READY=0
cleanup_failed_start() {
  local status=$?
  if [[ "$status" != "0" && "$CONTAINERS_STARTED" == "1" && "$READY" != "1" ]]; then
    echo "Training E2E startup failed; stopping isolated project $PROJECT" >&2
    docker compose --project-name "$PROJECT" "${COMPOSE_FILES[@]}" down >/dev/null 2>&1 || true
  fi
  exit "$status"
}
trap cleanup_failed_start EXIT

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

CONTAINERS_STARTED=1
docker compose --project-name "$PROJECT" "${COMPOSE_FILES[@]}" up --build -d

NEXUS_LOCAL_PORT_TS="$PORT_TS" \
NEXUS_LOCAL_PORT_PY="$PORT_PY" \
NEXUS_HEALTH_COMPOSE_PROJECT="$PROJECT" \
NEXUS_HEALTH_COMPOSE_FILE="$COMPOSE_FILE" \
  "$ROOT/scripts/wait-for-health.sh"

if [[ "${NEXUS_TRAINING_E2E_PREPARE_IOS_AUTH:-1}" == "1" ]]; then
  echo "Preparing local iOS debug auth for isolated Training E2E backend"
  docker compose --project-name "$PROJECT" "${COMPOSE_FILES[@]}" exec -T \
    -e NEXUS_LOCAL_BASE_URL="http://127.0.0.1:8200" \
    -e NEXUS_LOCAL_DB_PATH="/app/training-e2e-state/data/training-e2e.db" \
    -e NEXUS_LOCAL_AUTH_IMPORT_PATH="/app/training-e2e-state/local-ios-auth.json" \
    -e NEXUS_LOCAL_IOS_EMAIL="${NEXUS_TRAINING_E2E_IOS_EMAIL:-nexus-training-e2e@example.test}" \
    -e NEXUS_LOCAL_IOS_DEVICE_ID="${NEXUS_TRAINING_E2E_DEVICE_ID:-training-e2e-${RUN_ID}}" \
    -e NEXUS_LOCAL_IOS_INVITE_CODE="${NEXUS_TRAINING_E2E_IOS_INVITE_CODE:-LOCAL-TRAINING-E2E}" \
    nexus-hub node scripts/local-ios-debug-auth.mjs
fi

docker compose --project-name "$PROJECT" "${COMPOSE_FILES[@]}" ps --format json > "$STATE_DIR/compose-ps.json"
BACKEND_CONTAINER_ID="$(docker compose --project-name "$PROJECT" "${COMPOSE_FILES[@]}" ps -q nexus-hub)"
CONTENT_CONTAINER_ID="$(docker compose --project-name "$PROJECT" "${COMPOSE_FILES[@]}" ps -q content-engine)"
if [[ -z "$BACKEND_CONTAINER_ID" || -z "$CONTENT_CONTAINER_ID" ]]; then
  echo "ERROR: Training E2E could not resolve running container ids." >&2
  exit 70
fi
export NEXUS_TRAINING_E2E_BACKEND_CONTAINER_ID="$BACKEND_CONTAINER_ID"
export NEXUS_TRAINING_E2E_CONTENT_CONTAINER_ID="$CONTENT_CONTAINER_ID"
export NEXUS_TRAINING_E2E_BACKEND_ACTUAL_IMAGE_ID="$(docker inspect "$BACKEND_CONTAINER_ID" --format '{{.Image}}')"
export NEXUS_TRAINING_E2E_CONTENT_ACTUAL_IMAGE_ID="$(docker inspect "$CONTENT_CONTAINER_ID" --format '{{.Image}}')"
export NEXUS_TRAINING_E2E_BACKEND_BUILT_IMAGE_ID="$(docker image inspect "$NODE_IMAGE" --format '{{.Id}}')"
export NEXUS_TRAINING_E2E_CONTENT_BUILT_IMAGE_ID="$(docker image inspect "$CONTENT_IMAGE" --format '{{.Id}}')"
if [[ "$NEXUS_TRAINING_E2E_BACKEND_ACTUAL_IMAGE_ID" != "$NEXUS_TRAINING_E2E_BACKEND_BUILT_IMAGE_ID" \
  || "$NEXUS_TRAINING_E2E_CONTENT_ACTUAL_IMAGE_ID" != "$NEXUS_TRAINING_E2E_CONTENT_BUILT_IMAGE_ID" ]]; then
  echo "ERROR: Running Training E2E containers do not match the run-scoped images built for this run." >&2
  exit 72
fi
POST_BUILD_DIRTY_TREE_DIFF_SHA256="$(training_e2e_dirty_tree_digest)"
if [[ "$POST_BUILD_DIRTY_TREE_DIFF_SHA256" != "$DIRTY_TREE_DIFF_SHA256" ]]; then
  echo "ERROR: Backend source changed while Training E2E images were building; start a fresh run from stable source." >&2
  exit 73
fi

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
const backendImageName = process.env.NEXUS_TRAINING_E2E_NODE_IMAGE;
const contentImageName = process.env.NEXUS_TRAINING_E2E_CONTENT_IMAGE;
function git(args) {
  return cmd(`git --git-dir=${gitDir} --work-tree=${workTree} ${args}`);
}

const metadata = {
  schemaVersion: 'training_e2e_environment.v2',
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
    synchronous: 'FULL',
    mmapSize: 0,
    fixtureLockDomain: 'container',
    reason: 'all live fixture readers and writers execute inside the backend container Linux lock domain',
  },
  runPolicy: {
    mode: process.env.NEXUS_TRAINING_E2E_RUN_POLICY_MODE,
    qualifying: process.env.NEXUS_TRAINING_E2E_RUN_POLICY_QUALIFYING === '1',
  },
  git: {
    branch: git('branch --show-current') || null,
    commit: process.env.NEXUS_TRAINING_E2E_BACKEND_COMMIT,
    shortCommit: process.env.NEXUS_TRAINING_E2E_BACKEND_COMMIT?.slice(0, 12),
    baseCommit: process.env.NEXUS_TRAINING_E2E_BASE_COMMIT,
    dirtyTreeDiffSha256: process.env.NEXUS_TRAINING_E2E_DIRTY_TREE_DIFF_SHA256,
    statusShort: git('status --short --branch'),
  },
  images: {
    backend: {
      name: backendImageName,
      containerId: process.env.NEXUS_TRAINING_E2E_BACKEND_CONTAINER_ID,
      actualContainerImageId: process.env.NEXUS_TRAINING_E2E_BACKEND_ACTUAL_IMAGE_ID,
      builtImageId: process.env.NEXUS_TRAINING_E2E_BACKEND_BUILT_IMAGE_ID,
      id: process.env.NEXUS_TRAINING_E2E_BACKEND_BUILT_IMAGE_ID,
      repoDigests: cmd(`docker image inspect ${JSON.stringify(backendImageName)} --format '{{json .RepoDigests}}'`),
    },
    contentEngine: {
      name: contentImageName,
      containerId: process.env.NEXUS_TRAINING_E2E_CONTENT_CONTAINER_ID,
      actualContainerImageId: process.env.NEXUS_TRAINING_E2E_CONTENT_ACTUAL_IMAGE_ID,
      builtImageId: process.env.NEXUS_TRAINING_E2E_CONTENT_BUILT_IMAGE_ID,
      id: process.env.NEXUS_TRAINING_E2E_CONTENT_BUILT_IMAGE_ID,
      repoDigests: cmd(`docker image inspect ${JSON.stringify(contentImageName)} --format '{{json .RepoDigests}}'`),
    },
  },
  generatedAt: new Date().toISOString(),
};

fs.writeFileSync(target, JSON.stringify(metadata, null, 2) + '\n');
console.log(JSON.stringify(metadata, null, 2));
NODE

node --input-type=module -e '
  import fs from "node:fs";
  import("./scripts/lib/training-e2e-contract.mjs")
    .then(({ assertTrainingE2ERunProvenance }) => {
      const metadata = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      assertTrainingE2ERunProvenance(metadata);
    });
' "$STATE_DIR/metadata.json"

# Metadata equality is necessary but not sufficient: re-resolve HEAD, the
# complete dirty source digest, the current compose-service containers, and
# both run-scoped image tags before publishing this run as available.
node --input-type=module -e '
  import fs from "node:fs";
  import("./scripts/lib/training-e2e-run-freshness.mjs")
    .then(({ assertTrainingE2ERunFreshness }) => {
      const metadata = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      assertTrainingE2ERunFreshness({
        metadata,
        repoRoot: process.argv[2],
        gitDir: process.argv[3],
      });
    });
' "$STATE_DIR/metadata.json" "$ROOT" "$GIT_DIR"

cat > "$ROOT/.local/training-e2e/latest.env" <<EOF
export NEXUS_TRAINING_E2E_RUN_ID='$RUN_ID'
export NEXUS_TRAINING_E2E_PROJECT='$PROJECT'
export NEXUS_TRAINING_E2E_ROOT='$STATE_DIR'
export NEXUS_TRAINING_E2E_SOURCE_ROOT='$ROOT'
export NEXUS_TRAINING_E2E_PORT_TS='$PORT_TS'
export NEXUS_TRAINING_E2E_PORT_PY='$PORT_PY'
export NEXUS_TRAINING_E2E_BASE_URL='$BASE_URL'
export NEXUS_TRAINING_E2E_AUTH_FILE='$AUTH_FILE'
export NEXUS_TRAINING_E2E_COMPOSE_FILE='$COMPOSE_FILE'
export NEXUS_TRAINING_E2E_LIVE_CALENDAR='$LIVE_CALENDAR_ENABLED'
export NEXUS_TRAINING_E2E_LIVE_CALENDAR_PROVIDERS='$LIVE_CALENDAR_PROVIDERS'
export NEXUS_TRAINING_E2E_LIVE_CALENDAR_OVERRIDE_FILE='$LIVE_CALENDAR_OVERRIDE_FILE'
export NEXUS_TRAINING_E2E_PORTAL_READ_TOKEN='$PORTAL_READ_TOKEN'
export NEXUS_TRAINING_E2E_IOS_JWT_SECRET_FILE='$IOS_JWT_SECRET_FILE'
export NEXUS_TRAINING_E2E_GIT_DIR='$NEXUS_TRAINING_E2E_GIT_DIR'
export NEXUS_TRAINING_E2E_BACKEND_COMMIT='$BACKEND_COMMIT'
export NEXUS_TRAINING_E2E_BASE_COMMIT='$BASE_COMMIT'
export NEXUS_TRAINING_E2E_DIRTY_TREE_DIFF_SHA256='$DIRTY_TREE_DIFF_SHA256'
export NEXUS_TRAINING_E2E_NODE_IMAGE='$NODE_IMAGE'
export NEXUS_TRAINING_E2E_CONTENT_IMAGE='$CONTENT_IMAGE'
export NEXUS_TRAINING_E2E_BACKEND_BUILT_IMAGE_ID='$NEXUS_TRAINING_E2E_BACKEND_BUILT_IMAGE_ID'
export NEXUS_TRAINING_E2E_CONTENT_BUILT_IMAGE_ID='$NEXUS_TRAINING_E2E_CONTENT_BUILT_IMAGE_ID'
export NEXUS_TRAINING_E2E_RUN_POLICY_MODE='$RUN_POLICY_MODE'
export NEXUS_TRAINING_E2E_RUN_POLICY_QUALIFYING='$RUN_POLICY_QUALIFYING'
EOF

READY=1
trap - EXIT
echo "Training E2E environment is ready."
echo "Metadata: $STATE_DIR/metadata.json"
echo "Stop with: scripts/training-e2e-down.sh"
