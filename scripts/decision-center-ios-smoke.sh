#!/usr/bin/env bash
# Decision Center iOS smoke gate.
#
# Runs the local backend Docker sandbox on 127.0.0.1:8200 with an isolated
# Decision Center smoke DB, seeds real iOS auth + Decision Center rows, and
# optionally runs the focused iOS simulator smoke test.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

BACKEND_ONLY=0
NO_CLEANUP=0
RUN_FIXTURE_SUITE="${RUN_DECISION_CENTER_FIXTURE_SUITE:-1}"
RESET_DB="${RESET_DECISION_CENTER_IOS_SMOKE_DB:-1}"
for arg in "$@"; do
  case "$arg" in
    --backend-only) BACKEND_ONLY=1 ;;
    --no-cleanup) NO_CLEANUP=1 ;;
    --skip-fixture-suite) RUN_FIXTURE_SUITE=0 ;;
    *)
      printf 'Unknown argument: %s\n' "$arg" >&2
      exit 64
      ;;
  esac
done

STATE_DIR="$ROOT/.local/decision-center-ios-smoke"
EVIDENCE_DIR="$STATE_DIR/evidence/$(date +%Y%m%d-%H%M%S)"
EVIDENCE_STAMP="$(basename "$EVIDENCE_DIR")"
AUTH_FILE="$STATE_DIR/local-ios-auth.json"
MANIFEST_FILE="$STATE_DIR/manifest.json"
PUSH_FILE="$STATE_DIR/decision-center-push.apns.json"
DB_PATH="$ROOT/data/decision-center-ios-smoke.db"
CONTAINER_AUTH_FILE="/app/.local/decision-center-ios-smoke/local-ios-auth.json"
CONTAINER_MANIFEST_FILE="/app/.local/decision-center-ios-smoke/manifest.json"
CONTAINER_PUSH_FILE="/app/.local/decision-center-ios-smoke/decision-center-push.apns.json"
CONTAINER_DB_PATH="/app/data/decision-center-ios-smoke.db"
BASE_URL="http://127.0.0.1:${NEXUS_LOCAL_PORT_TS:-8200}"
IOS_ROOT="${IOS_ROOT:?IOS_ROOT must be set (path to the Nexus Hub iOS project root)}"
IOS_APP_BUNDLE_ID="${IOS_APP_BUNDLE_ID:-me.nexushub.app}"
IOS_SIM_NAME="${IOS_SIM_NAME:-iPhone 17 Pro}"
IOS_ACTION_TIMEOUT="${IOS_ACTION_TIMEOUT:-120}"
IOS_SCHEME="${IOS_SCHEME:-Nexus Hub Debug UI Smoke}"
IOS_DERIVED_DATA_ROOT="${IOS_DERIVED_DATA_ROOT:-${TMPDIR:-/tmp}/nexus-decision-center-ios-smoke}"

export NEXUS_LOCAL_PORT_TS="${NEXUS_LOCAL_PORT_TS:-8200}"
export NEXUS_LOCAL_PORT_PY="${NEXUS_LOCAL_PORT_PY:-8110}"
export LOCAL_HEALTH_TIMEOUT="${LOCAL_HEALTH_TIMEOUT:-150}"
export IOS_API_JWT_SECRET="${IOS_API_JWT_SECRET:-local-decision-center-ios-smoke-ios-jwt-secret-000000000000000000000}"
export IOS_INVITE_CODE="${IOS_INVITE_CODE:-LOCAL-DECISION-IOS-SMOKE}"
export IOS_OWNER_CODE="${IOS_OWNER_CODE:-LOCAL-DECISION-IOS-OWNER}"
export DATABASE_PATH="$DB_PATH"
export PORTAL_TOKEN="${PORTAL_TOKEN:-local-decision-center-ios-smoke-portal-token}"
export PORTAL_READ_TOKEN="${PORTAL_READ_TOKEN:-$PORTAL_TOKEN}"
export INTERNAL_API_SECRET="${INTERNAL_API_SECRET:-local-decision-center-ios-smoke-internal-secret}"
export OAUTH_ENCRYPTION_KEY="${OAUTH_ENCRYPTION_KEY:-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef}"
export FINANCE_ENCRYPTION_KEY="${FINANCE_ENCRYPTION_KEY:-abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789}"
export OWNER_TELEGRAM_ID="${OWNER_TELEGRAM_ID:-100000001}"
export APNS_ENABLED="false"
export NOTIFICATION_DELIVERY_MODE="mock"
export DECISION_CENTER_COMMAND_BUS_ENABLED="false"
export DECISION_CENTER_GUIDANCE_V1_ENABLED="true"
export DECISION_CENTER_GUIDANCE_V1_SECRETARY_ENABLED="true"
export DECISION_SEMANTIC_DEDUP_ENABLED="false"
export DECISION_SEMANTIC_SUPERSEDE_ENABLED="false"
export IOS_SCHEME

mkdir -p "$STATE_DIR" "$EVIDENCE_DIR" "$ROOT/data" "$IOS_DERIVED_DATA_ROOT"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf 'ERROR: required command not found: %s\n' "$1" >&2
    exit 127
  fi
}

compose() {
  docker compose \
    -f docker-compose.local.yml \
    -f docker-compose.decision-center-ios-smoke.yml \
    "$@"
}

cleanup() {
  local status=$?
  compose logs --no-color > "$EVIDENCE_DIR/backend-compose.log" 2>/dev/null || true
  if [[ "$NO_CLEANUP" != "1" ]]; then
    compose down >/dev/null 2>&1 || true
  fi
  if [[ "$status" != "0" ]]; then
    printf '\nDecision Center iOS smoke failed. Evidence: %s\n' "$EVIDENCE_DIR" >&2
  fi
}
trap cleanup EXIT

printf 'Decision Center iOS smoke evidence: %s\n' "$EVIDENCE_DIR"

require_cmd docker
require_cmd curl
require_cmd npx

if [[ "$RESET_DB" == "1" ]]; then
  printf '\n[setup] Resetting isolated Decision Center smoke DB...\n'
  compose down >/dev/null 2>&1 || true
  rm -f "$DB_PATH" "$DB_PATH-wal" "$DB_PATH-shm"
fi

printf '\n[setup] Bootstrapping isolated Decision Center smoke schema...\n'
npx tsx scripts/decision-center-ios-smoke-seed.ts bootstrap-schema \
  --db "$DB_PATH"

printf '\n[1/7] Starting isolated local Docker sandbox...\n'
compose up --build -d
./scripts/wait-for-health.sh

printf '\n[2/7] Running existing local sandbox smoke...\n'
./scripts/local-smoke.sh

printf '\n[3/7] Seeding local iOS auth and Decision Center rows...\n'
compose exec -T nexus-hub npx tsx scripts/decision-center-ios-smoke-seed.ts seed \
  --base-url "$BASE_URL" \
  --db "$CONTAINER_DB_PATH" \
  --auth-file "$CONTAINER_AUTH_FILE" \
  --manifest-file "$CONTAINER_MANIFEST_FILE" \
  --push-file "$CONTAINER_PUSH_FILE" \
  --invite-code "$IOS_INVITE_CODE" \
  | tee "$EVIDENCE_DIR/seed.log"

printf '\n[4/7] Verifying Decision Center backend API routes...\n'
compose exec -T nexus-hub npx tsx scripts/decision-center-ios-smoke-seed.ts assert-backend \
  --base-url "$BASE_URL" \
  --db "$CONTAINER_DB_PATH" \
  --auth-file "$CONTAINER_AUTH_FILE" \
  --manifest-file "$CONTAINER_MANIFEST_FILE" \
  --push-file "$CONTAINER_PUSH_FILE" \
  --invite-code "$IOS_INVITE_CODE" \
  | tee "$EVIDENCE_DIR/backend-assertions.log"

if [[ "$BACKEND_ONLY" == "1" ]]; then
  printf '\nBackend-only Decision Center smoke passed. Evidence: %s\n' "$EVIDENCE_DIR"
  exit 0
fi

require_cmd xcrun
require_cmd xcodebuild

if [[ ! -d "$IOS_ROOT" ]]; then
  printf 'ERROR: iOS repo not found at IOS_ROOT=%s\n' "$IOS_ROOT" >&2
  exit 66
fi

resolve_udid() {
  if [[ -n "${IOS_SIM_UDID:-}" ]]; then
    printf '%s\n' "$IOS_SIM_UDID"
    return
  fi
  local matches
  matches="$(xcrun simctl list devices available | awk -v name="$IOS_SIM_NAME" '
    index($0, "    " name " (") == 1 && $0 ~ /\([0-9A-F-]{36}\)/ {
      match($0, /\([0-9A-F-]{36}\)/);
      print substr($0, RSTART + 1, RLENGTH - 2);
    }
  ')"
  local count
  count="$(printf '%s\n' "$matches" | sed '/^$/d' | wc -l | tr -d ' ')"
  if [[ "$count" != "1" ]]; then
    printf 'Expected exactly one available simulator named "%s", found %s. Set IOS_SIM_UDID explicitly.\n' "$IOS_SIM_NAME" "$count" >&2
    return 65
  fi
  printf '%s\n' "$matches"
}

IOS_SIM_UDID="$(resolve_udid)"
export IOS_SIM_UDID
printf '\nSelected simulator: %s (%s)\n' "$IOS_SIM_NAME" "$IOS_SIM_UDID"

printf '\n[5/7] Running focused iOS local-engine Decision Center smoke...\n'
(
  cd "$IOS_ROOT"
  export NEXUS_LOCAL_AUTH_IMPORT_PATH="$AUTH_FILE"
  export NEXUS_DECISION_CENTER_SMOKE_BASE_URL="$BASE_URL"
  export NEXUS_DECISION_CENTER_SMOKE_EXPECTED_TITLE="Local smoke schedule conflict"
  export NEXUS_DECISION_CENTER_SMOKE_BLOCKED_TITLE="Local smoke dependency blocked"
  export NEXUS_DECISION_CENTER_SMOKE_HANDLED_TITLE="Local smoke handled by Nexus"
  export NEXUS_DECISION_CENTER_SMOKE_ACTION_TIMEOUT="$IOS_ACTION_TIMEOUT"
  export SIMCTL_CHILD_NEXUS_LOCAL_AUTH_IMPORT_PATH="$NEXUS_LOCAL_AUTH_IMPORT_PATH"
  export SIMCTL_CHILD_NEXUS_DECISION_CENTER_SMOKE_BASE_URL="$NEXUS_DECISION_CENTER_SMOKE_BASE_URL"
  export SIMCTL_CHILD_NEXUS_DECISION_CENTER_SMOKE_EXPECTED_TITLE="$NEXUS_DECISION_CENTER_SMOKE_EXPECTED_TITLE"
  export SIMCTL_CHILD_NEXUS_DECISION_CENTER_SMOKE_BLOCKED_TITLE="$NEXUS_DECISION_CENTER_SMOKE_BLOCKED_TITLE"
  export SIMCTL_CHILD_NEXUS_DECISION_CENTER_SMOKE_HANDLED_TITLE="$NEXUS_DECISION_CENTER_SMOKE_HANDLED_TITLE"
  export SIMCTL_CHILD_NEXUS_DECISION_CENTER_SMOKE_ACTION_TIMEOUT="$NEXUS_DECISION_CENTER_SMOKE_ACTION_TIMEOUT"
  export IOS_KEEP_SIM_BOOTED=1
  export IOS_QUIT_SIMULATOR_APP=0
  export IOS_SHUTDOWN_OTHER_SIMS="${IOS_SHUTDOWN_OTHER_SIMS:-1}"
  export IOS_DERIVED_DATA_PATH="$IOS_DERIVED_DATA_ROOT/$EVIDENCE_STAMP-local-engine"
  export IOS_RESULT_BUNDLE_PATH="$EVIDENCE_DIR/DecisionCenterLocalEngineSmoke.xcresult"
  export IOS_TEST_SUMMARY_JSON="$EVIDENCE_DIR/DecisionCenterLocalEngineSmoke.summary.json"
  ./scripts/ios-single-simulator-test.sh \
    -only-testing:"Nexus HubUITests/NotificationDecisionCenterUITests/test_localEngineDecisionCenterSmokeMatchesSeededBackend"
)

printf '\n[6/7] Injecting scoped simulator push payload...\n'
xcrun simctl boot "$IOS_SIM_UDID" >/dev/null 2>&1 || true
xcrun simctl bootstatus "$IOS_SIM_UDID" -b >/dev/null
xcrun simctl spawn "$IOS_SIM_UDID" launchctl setenv NEXUS_LOCAL_AUTH_IMPORT_PATH "$AUTH_FILE" >/dev/null 2>&1 || true
xcrun simctl launch "$IOS_SIM_UDID" "$IOS_APP_BUNDLE_ID" \
  -nexus_allow_local_backend YES \
  -nexus_base_url "$BASE_URL" \
  -nexus_debug_local_auth_import YES \
  >/dev/null
sleep 2
xcrun simctl push "$IOS_SIM_UDID" "$IOS_APP_BUNDLE_ID" "$PUSH_FILE" \
  | tee "$EVIDENCE_DIR/simctl-push.log"

printf '\n[7/7] Verifying post-iOS action DB ledger...\n'
compose exec -T nexus-hub npx tsx scripts/decision-center-ios-smoke-seed.ts assert-ios-action \
  --base-url "$BASE_URL" \
  --db "$CONTAINER_DB_PATH" \
  --auth-file "$CONTAINER_AUTH_FILE" \
  --manifest-file "$CONTAINER_MANIFEST_FILE" \
  --push-file "$CONTAINER_PUSH_FILE" \
  --invite-code "$IOS_INVITE_CODE" \
  | tee "$EVIDENCE_DIR/post-ios-action-assertions.log"

if [[ "$RUN_FIXTURE_SUITE" == "1" ]]; then
  printf '\n[extra] Running existing NotificationDecisionCenterUITests fixture suite...\n'
  (
    cd "$IOS_ROOT"
    export IOS_KEEP_SIM_BOOTED=0
    export IOS_QUIT_SIMULATOR_APP=1
    export IOS_DERIVED_DATA_PATH="$IOS_DERIVED_DATA_ROOT/$EVIDENCE_STAMP-fixture-suite"
    export IOS_RESULT_BUNDLE_PATH="$EVIDENCE_DIR/NotificationDecisionCenterFixtureSuite.xcresult"
    export IOS_TEST_SUMMARY_JSON="$EVIDENCE_DIR/NotificationDecisionCenterFixtureSuite.summary.json"
    ./scripts/ios-single-simulator-test.sh \
      -only-testing:"Nexus HubUITests/NotificationDecisionCenterUITests" \
      -skip-testing:"Nexus HubUITests/NotificationDecisionCenterUITests/test_localEngineDecisionCenterSmokeMatchesSeededBackend"
  )
fi

printf '\nDecision Center iOS smoke passed. Evidence: %s\n' "$EVIDENCE_DIR"
