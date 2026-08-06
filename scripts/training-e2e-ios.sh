#!/usr/bin/env bash
# Run focused iOS Training tests against the isolated Training E2E backend.

set -euo pipefail

# Same guard as scripts/ios-single-simulator-test.sh: DerivedData lives
# under the user tree here, where Finder/provenance extended attributes
# land on build products and CodeSign then fails with "resource fork,
# Finder information, or similar detritus not allowed".
export COPYFILE_DISABLE="${COPYFILE_DISABLE:-1}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
# shellcheck source=scripts/training-e2e-env.sh
source "$ROOT/scripts/training-e2e-env.sh"
training_e2e_load_latest_env

IOS_ROOT="${NEXUS_TRAINING_E2E_IOS_ROOT:-/Users/felipedominguez/Desktop/Nexus Hub/ios}"
STATE_DIR="$NEXUS_TRAINING_E2E_ROOT/ios"
IOS_SEED_RUNNER="$ROOT/scripts/training-e2e-run-ios-seed.sh"
mkdir -p "$STATE_DIR"

IOS_SCENARIO="${NEXUS_TRAINING_E2E_IOS_SCENARIO:-active-plan}"
case "$IOS_SCENARIO" in
  active-plan)
    FIXTURE_PREPARE_MODE=prepare
    FIXTURE_VERIFY_MODE=""
    FIXTURE_CLEANUP_MODE=cleanup
    ;;
  clarification)
    FIXTURE_PREPARE_MODE=prepare-clarification
    FIXTURE_VERIFY_MODE=verify-clarification
    FIXTURE_CLEANUP_MODE=cleanup-clarification
    ;;
  *)
    echo "ERROR: unsupported Training iOS E2E scenario '$IOS_SCENARIO' (expected active-plan or clarification)." >&2
    exit 64
    ;;
esac

# Reused state dirs accumulate Finder/provenance extended attributes on
# build products (user-tree DerivedData), which fail CodeSign with
# "resource fork ... detritus not allowed" on incremental re-signs.
if [[ -d "$STATE_DIR/DerivedData/Build/Products" ]]; then
  xattr -cr "$STATE_DIR/DerivedData/Build/Products" 2>/dev/null || true
fi

BASE_URL="$NEXUS_TRAINING_E2E_BASE_URL"
if [[ "$BASE_URL" == "http://127.0.0.1:8200" || "$BASE_URL" == "http://localhost:8200" ]]; then
  echo "ERROR: refusing to run Training E2E iOS tests against default port 8200." >&2
  exit 65
fi

if [[ ! -d "$IOS_ROOT" ]]; then
  echo "ERROR: iOS workspace not found at $IOS_ROOT" >&2
  exit 66
fi

capture_checkout_status() {
  local output
  if ! output="$("$@" status --porcelain=v1 --untracked-files=all)"; then
    return 1
  fi
  if [[ -n "$output" ]]; then
    printf '%s\n' dirty
  else
    printf '%s\n' clean
  fi
}

BACKEND_GIT_SHA="$(training_e2e_git rev-parse HEAD)"
BACKEND_GIT_STATUS="$(capture_checkout_status training_e2e_git)"
IOS_GIT_SHA="$(git -C "$IOS_ROOT" rev-parse HEAD)"
IOS_GIT_STATUS="$(capture_checkout_status git -C "$IOS_ROOT")"

IOS_CONFIG_DIR="$STATE_DIR/config"
IOS_CONFIG_POINTER="$IOS_ROOT/.local/training-e2e/current-config-path.txt"
IOS_CONFIG_PATHS=(
  "$IOS_CONFIG_DIR/training-e2e-config.json"
  "$IOS_CONFIG_DIR/${NEXUS_TRAINING_E2E_RUN_ID}.json"
)

write_ios_config() {
  local config_path="$1"
  mkdir -p "$(dirname "$config_path")"
  NEXUS_TRAINING_E2E_IOS_CONFIG_PATH="$config_path" \
  NEXUS_TRAINING_E2E_BACKEND_REPO_PATH="$ROOT" \
  node <<'NODE'
const fs = require('node:fs');

const configPath = process.env.NEXUS_TRAINING_E2E_IOS_CONFIG_PATH;
const config = {
  baseUrl: process.env.NEXUS_TRAINING_E2E_BASE_URL,
  authFile: process.env.NEXUS_TRAINING_E2E_AUTH_FILE,
  backendRepoPath: process.env.NEXUS_TRAINING_E2E_BACKEND_REPO_PATH,
  runId: process.env.NEXUS_TRAINING_E2E_RUN_ID,
};

fs.writeFileSync(`${configPath}.tmp`, `${JSON.stringify(config, null, 2)}\n`);
fs.renameSync(`${configPath}.tmp`, configPath);
NODE
}

resolve_latest_ios_runtime() {
  xcrun simctl list runtimes --json | python3 -c '
import json
import sys

payload = json.load(sys.stdin)
runtimes = [
    runtime for runtime in payload.get("runtimes", [])
    if runtime.get("isAvailable") and "iOS" in str(runtime.get("identifier", ""))
]
runtimes.sort(key=lambda runtime: [int(part) if part.isdigit() else 0 for part in str(runtime.get("version", "0")).split(".")], reverse=True)
if not runtimes:
    raise SystemExit(1)
print(runtimes[0]["identifier"])
'
}

resolve_simulator_runtime() {
  local simulator_udid="$1"
  xcrun simctl list devices --json | python3 -c '
import json
import sys

payload = json.load(sys.stdin)
target_udid = sys.argv[1]
for runtime_id, devices in payload.get("devices", {}).items():
    if any(str(device.get("udid", "")) == target_udid for device in devices):
        print(runtime_id)
        raise SystemExit(0)
raise SystemExit(f"simulator {target_udid} was not found in simctl device inventory")
' "$simulator_udid"
}

resolve_runtime_version() {
  local runtime_id="$1"
  xcrun simctl list runtimes --json | python3 -c '
import json
import sys

payload = json.load(sys.stdin)
target_id = sys.argv[1]
for runtime in payload.get("runtimes", []):
    if str(runtime.get("identifier", "")) == target_id:
        print(runtime.get("version", "unknown"))
        raise SystemExit(0)
raise SystemExit(f"runtime {target_id} was not found in simctl runtime inventory")
' "$runtime_id"
}

write_ios_run_summary() {
  local pre_cleanup_exit_code="$1"
  local final_exit_code="$2"
  NEXUS_TRAINING_E2E_IOS_SUMMARY_PATH="$IOS_RUN_SUMMARY_PATH" \
  NEXUS_TRAINING_E2E_BACKEND_GIT_SHA="$BACKEND_GIT_SHA" \
  NEXUS_TRAINING_E2E_BACKEND_GIT_STATUS="$BACKEND_GIT_STATUS" \
  NEXUS_TRAINING_E2E_IOS_GIT_SHA="$IOS_GIT_SHA" \
  NEXUS_TRAINING_E2E_IOS_GIT_STATUS="$IOS_GIT_STATUS" \
  NEXUS_TRAINING_E2E_IOS_SIM_UDID_RESOLVED="$SIM_UDID" \
  NEXUS_TRAINING_E2E_IOS_RUNTIME_RESOLVED="$RUNTIME_ID" \
  NEXUS_TRAINING_E2E_IOS_RUNTIME_VERSION_RESOLVED="$RUNTIME_VERSION" \
  NEXUS_TRAINING_E2E_IOS_SCENARIO_RESOLVED="$IOS_SCENARIO" \
  NEXUS_TRAINING_E2E_IOS_PREPARE_STATUS="$FIXTURE_PREPARE_STATUS" \
  NEXUS_TRAINING_E2E_IOS_PREPARE_EXIT_CODE="$FIXTURE_PREPARE_EXIT_CODE" \
  NEXUS_TRAINING_E2E_IOS_TEST_STATUS="$TEST_RESULT_STATUS" \
  NEXUS_TRAINING_E2E_IOS_TEST_EXIT_CODE="$TEST_EXIT_CODE" \
  NEXUS_TRAINING_E2E_IOS_VERIFY_STATUS="$FIXTURE_VERIFY_STATUS" \
  NEXUS_TRAINING_E2E_IOS_VERIFY_EXIT_CODE="$FIXTURE_VERIFY_EXIT_CODE" \
  NEXUS_TRAINING_E2E_IOS_CLEANUP_STATUS="$FIXTURE_CLEANUP_STATUS" \
  NEXUS_TRAINING_E2E_IOS_CLEANUP_EXIT_CODE="$FIXTURE_CLEANUP_EXIT_CODE" \
  NEXUS_TRAINING_E2E_IOS_PRE_CLEANUP_EXIT_CODE="$pre_cleanup_exit_code" \
  NEXUS_TRAINING_E2E_IOS_FINAL_EXIT_CODE="$final_exit_code" \
  NEXUS_TRAINING_E2E_IOS_FIXTURE_PREPARED="$FIXTURE_PREPARED" \
  NEXUS_TRAINING_E2E_IOS_PLAN_SEEDED="$PLAN_SEEDED" \
  NEXUS_TRAINING_E2E_IOS_KEEP_SEEDED_PLAN_RESOLVED="${NEXUS_TRAINING_E2E_IOS_KEEP_SEEDED_PLAN:-0}" \
  NEXUS_TRAINING_E2E_IOS_KEEP_SIM_RESOLVED="${NEXUS_TRAINING_E2E_IOS_KEEP_SIM:-0}" \
  node <<'NODE'
const fs = require('node:fs');

const optionalExitCode = (value) => value === '' ? null : Number(value);
const summaryPath = process.env.NEXUS_TRAINING_E2E_IOS_SUMMARY_PATH;
const summary = {
  schemaVersion: 'training_e2e_ios_run.v2',
  runId: process.env.NEXUS_TRAINING_E2E_RUN_ID,
  scenario: process.env.NEXUS_TRAINING_E2E_IOS_SCENARIO_RESOLVED,
  generatedAt: new Date().toISOString(),
  backend: {
    gitSha: process.env.NEXUS_TRAINING_E2E_BACKEND_GIT_SHA,
    gitStatus: process.env.NEXUS_TRAINING_E2E_BACKEND_GIT_STATUS,
  },
  ios: {
    gitSha: process.env.NEXUS_TRAINING_E2E_IOS_GIT_SHA,
    gitStatus: process.env.NEXUS_TRAINING_E2E_IOS_GIT_STATUS,
  },
  simulator: {
    udid: process.env.NEXUS_TRAINING_E2E_IOS_SIM_UDID_RESOLVED || null,
    runtimeIdentifier: process.env.NEXUS_TRAINING_E2E_IOS_RUNTIME_RESOLVED || null,
    runtimeVersion: process.env.NEXUS_TRAINING_E2E_IOS_RUNTIME_VERSION_RESOLVED || null,
  },
  prepare: {
    status: process.env.NEXUS_TRAINING_E2E_IOS_PREPARE_STATUS,
    exitCode: optionalExitCode(process.env.NEXUS_TRAINING_E2E_IOS_PREPARE_EXIT_CODE),
  },
  test: {
    status: process.env.NEXUS_TRAINING_E2E_IOS_TEST_STATUS,
    exitCode: optionalExitCode(process.env.NEXUS_TRAINING_E2E_IOS_TEST_EXIT_CODE),
  },
  verify: {
    status: process.env.NEXUS_TRAINING_E2E_IOS_VERIFY_STATUS,
    exitCode: optionalExitCode(process.env.NEXUS_TRAINING_E2E_IOS_VERIFY_EXIT_CODE),
  },
  cleanup: {
    status: process.env.NEXUS_TRAINING_E2E_IOS_CLEANUP_STATUS,
    exitCode: optionalExitCode(process.env.NEXUS_TRAINING_E2E_IOS_CLEANUP_EXIT_CODE),
    fixturePrepared: process.env.NEXUS_TRAINING_E2E_IOS_FIXTURE_PREPARED === '1',
    planSeeded: process.env.NEXUS_TRAINING_E2E_IOS_PLAN_SEEDED === '1',
    keepSeededPlanRequested: process.env.NEXUS_TRAINING_E2E_IOS_KEEP_SEEDED_PLAN_RESOLVED === '1',
    simulatorTeardownPolicy: process.env.NEXUS_TRAINING_E2E_IOS_KEEP_SIM_RESOLVED === '1'
      ? 'kept_by_request'
      : 'udid_scoped_best_effort',
  },
  harness: {
    preCleanupExitCode: Number(process.env.NEXUS_TRAINING_E2E_IOS_PRE_CLEANUP_EXIT_CODE),
    finalExitCode: Number(process.env.NEXUS_TRAINING_E2E_IOS_FINAL_EXIT_CODE),
  },
};

fs.writeFileSync(`${summaryPath}.tmp`, `${JSON.stringify(summary, null, 2)}\n`);
fs.renameSync(`${summaryPath}.tmp`, summaryPath);
NODE
}

SIM_UDID="${NEXUS_TRAINING_E2E_IOS_SIM_UDID:-}"
RUNTIME_ID=""
RUNTIME_VERSION=""
CREATED_SIM=0
FIXTURE_PREPARED=0
PLAN_SEEDED=0
FIXTURE_CLEANUP_REQUIRED=0
FIXTURE_PREPARE_STATUS=not_run
FIXTURE_PREPARE_EXIT_CODE=""
TEST_RESULT_STATUS=not_run
TEST_EXIT_CODE=""
FIXTURE_VERIFY_STATUS=not_run
FIXTURE_VERIFY_EXIT_CODE=""
FIXTURE_CLEANUP_STATUS=not_required
FIXTURE_CLEANUP_EXIT_CODE=""
IOS_RUN_SUMMARY_PATH="$STATE_DIR/training-e2e-ios-summary.json"

cleanup() {
  local pre_cleanup_status=$?
  local final_status="$pre_cleanup_status"
  local summary_write_status=0
  trap - EXIT
  set +e
  for config_path in "${IOS_CONFIG_PATHS[@]}"; do
    rm -f "$config_path" "$config_path.tmp" >/dev/null 2>&1 || true
  done
  if [[ -f "$IOS_CONFIG_POINTER" ]]; then
    local pointer_value
    pointer_value="$(cat "$IOS_CONFIG_POINTER" 2>/dev/null || true)"
    if [[ "$pointer_value" == "${IOS_CONFIG_PATHS[0]}" ]]; then
      rm -f "$IOS_CONFIG_POINTER" "$IOS_CONFIG_POINTER.tmp" >/dev/null 2>&1 || true
    fi
  fi
  if [[ "$FIXTURE_CLEANUP_REQUIRED" == "1" && "${NEXUS_TRAINING_E2E_IOS_KEEP_SEEDED_PLAN:-0}" != "1" ]]; then
    "$IOS_SEED_RUNNER" "$FIXTURE_CLEANUP_MODE" >/dev/null 2>&1
    FIXTURE_CLEANUP_EXIT_CODE=$?
    if [[ "$FIXTURE_CLEANUP_EXIT_CODE" == "0" ]]; then
      FIXTURE_CLEANUP_STATUS=passed
    else
      FIXTURE_CLEANUP_STATUS=failed
      echo "ERROR: iOS Training E2E fixture cleanup failed with exit $FIXTURE_CLEANUP_EXIT_CODE (pre-cleanup exit $pre_cleanup_status)." >&2
      if [[ "$pre_cleanup_status" == "0" ]]; then
        final_status="$FIXTURE_CLEANUP_EXIT_CODE"
      fi
    fi
  elif [[ "$FIXTURE_CLEANUP_REQUIRED" == "1" ]]; then
    FIXTURE_CLEANUP_STATUS=skipped_keep_requested
  fi
  if [[ -n "$SIM_UDID" && "${NEXUS_TRAINING_E2E_IOS_KEEP_SIM:-0}" != "1" ]]; then
    xcrun simctl terminate "$SIM_UDID" "${NEXUS_TRAINING_E2E_IOS_BUNDLE_ID:-me.nexushub.app}" >/dev/null 2>&1 || true
    xcrun simctl shutdown "$SIM_UDID" >/dev/null 2>&1 || true
    if [[ "$CREATED_SIM" == "1" && "${NEXUS_TRAINING_E2E_IOS_DELETE_CREATED_SIM:-1}" == "1" ]]; then
      xcrun simctl delete "$SIM_UDID" >/dev/null 2>&1 || true
    fi
  fi

  write_ios_run_summary "$pre_cleanup_status" "$final_status"
  summary_write_status=$?
  if [[ "$summary_write_status" != "0" ]]; then
    echo "ERROR: failed to write iOS Training E2E summary at $IOS_RUN_SUMMARY_PATH (exit $summary_write_status)." >&2
    if [[ "$final_status" == "0" ]]; then
      final_status="$summary_write_status"
    fi
  else
    echo "Unified summary: $IOS_RUN_SUMMARY_PATH"
  fi
  exit "$final_status"
}
trap cleanup EXIT

if [[ -z "$SIM_UDID" ]]; then
  RUNTIME_ID="${NEXUS_TRAINING_E2E_IOS_RUNTIME:-$(resolve_latest_ios_runtime)}"
  DEVICE_TYPE="${NEXUS_TRAINING_E2E_IOS_DEVICE_TYPE:-com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro}"
  SIM_NAME="Nexus Training E2E ${NEXUS_TRAINING_E2E_RUN_ID}"
  echo "Creating dedicated simulator: $SIM_NAME"
  SIM_UDID="$(xcrun simctl create "$SIM_NAME" "$DEVICE_TYPE" "$RUNTIME_ID")"
  CREATED_SIM=1
else
  RUNTIME_ID="$(resolve_simulator_runtime "$SIM_UDID")"
fi
RUNTIME_VERSION="$(resolve_runtime_version "$RUNTIME_ID")"

if [[ "${NEXUS_TRAINING_E2E_IOS_PRESEED_PLAN:-1}" == "1" ]]; then
  if [[ "$IOS_SCENARIO" == "clarification" ]]; then
    echo "Preparing incomplete Training profiles for the isolated clarification journey"
  else
    echo "Seeding active Training plan for isolated iOS assertions"
  fi
  # Cleanup is required even when prepare exits nonzero because a partial
  # fixture write is still possible. The cleanup helper is scope- and
  # provenance-fenced, so it is the safe compensating action.
  FIXTURE_CLEANUP_REQUIRED=1
  set +e
  "$IOS_SEED_RUNNER" "$FIXTURE_PREPARE_MODE"
  FIXTURE_PREPARE_EXIT_CODE=$?
  set -e
  if [[ "$FIXTURE_PREPARE_EXIT_CODE" != "0" ]]; then
    FIXTURE_PREPARE_STATUS=failed
    exit "$FIXTURE_PREPARE_EXIT_CODE"
  fi
  FIXTURE_PREPARE_STATUS=passed
  FIXTURE_PREPARED=1
  if [[ "$IOS_SCENARIO" == "active-plan" ]]; then
    PLAN_SEEDED=1
  fi
else
  FIXTURE_PREPARE_STATUS=skipped_disabled
fi

for config_path in "${IOS_CONFIG_PATHS[@]}"; do
  write_ios_config "$config_path"
done
mkdir -p "$(dirname "$IOS_CONFIG_POINTER")"
printf '%s\n' "${IOS_CONFIG_PATHS[0]}" > "$IOS_CONFIG_POINTER.tmp"
mv "$IOS_CONFIG_POINTER.tmp" "$IOS_CONFIG_POINTER"

IOS_TEST_ARGS=("$@")
if [[ ${#IOS_TEST_ARGS[@]} -eq 0 ]]; then
  if [[ "$IOS_SCENARIO" == "clarification" ]]; then
    IOS_TEST_ARGS=(
      -only-testing:"Nexus HubUITests/TrainingIsolatedBackendE2EUITests/test_isolatedBackendClarificationWritesProfileRepreviewsAndCreatesExactlyOnce"
    )
  else
    IOS_TEST_ARGS=(
      -only-testing:"Nexus HubUITests/TrainingIsolatedBackendE2EUITests"
      -only-testing:"Nexus HubUITests/TrainingFixtureBypassUITests"
      -only-testing:"Nexus HubUITests/TrainingValidationUITests"
    )
  fi
fi

echo "Running iOS Training E2E on dedicated simulator"
echo "  simulator: $SIM_UDID"
echo "  backend:   $BASE_URL"
echo "  auth file: $NEXUS_TRAINING_E2E_AUTH_FILE"
echo "  iOS config: ${IOS_CONFIG_PATHS[0]}"

# DerivedData must live OUTSIDE the user tree: macOS provenance/Finder
# extended attributes land nondeterministically on freshly built products
# under ~/Desktop-rooted paths and CodeSign then fails with "resource
# fork ... detritus not allowed" (2026-07-02 lane runs 1/3/4; run 2 got
# lucky). /private/tmp is not provenance-tagged — the xcresult/evidence
# stays in STATE_DIR.
DERIVED_DATA_DIR="${NEXUS_TRAINING_E2E_DERIVED_DATA:-/private/tmp/nexus-training-e2e/${NEXUS_TRAINING_E2E_RUN_ID}/DerivedData}"
mkdir -p "$DERIVED_DATA_DIR"
echo "  derived data: $DERIVED_DATA_DIR"

set +e
(
  cd "$IOS_ROOT"
  NEXUS_TRAINING_E2E_BASE_URL="$BASE_URL" \
  NEXUS_TRAINING_E2E_RUN_ID="$NEXUS_TRAINING_E2E_RUN_ID" \
  NEXUS_LOCAL_AUTH_IMPORT_PATH="$NEXUS_TRAINING_E2E_AUTH_FILE" \
  NEXUS_BACKEND_REPO_PATH="$ROOT" \
  NEXUS_TRAINING_E2E_CONFIG_PATH="${IOS_CONFIG_PATHS[0]}" \
  IOS_SCHEME="${NEXUS_TRAINING_E2E_IOS_SCHEME:-Nexus Hub Debug UI Smoke}" \
  IOS_SIM_UDID="$SIM_UDID" \
  IOS_REQUIRE_UDID=1 \
  IOS_SHUTDOWN_OTHER_SIMS=0 \
  IOS_ALLOW_MULTIPLE_BOOTED=1 \
  IOS_QUIT_SIMULATOR_APP=0 \
  IOS_TRIM_SIMULATOR_PROCESSES=0 \
  IOS_DERIVED_DATA_PATH="$DERIVED_DATA_DIR" \
  IOS_RESULT_BUNDLE_PATH="$STATE_DIR/TrainingE2E.xcresult" \
  IOS_TEST_SUMMARY_JSON="$STATE_DIR/test-summary.json" \
    scripts/ios-single-simulator-test.sh "${IOS_TEST_ARGS[@]}"
)
TEST_EXIT_CODE=$?
set -e

if [[ "$TEST_EXIT_CODE" != "0" ]]; then
  TEST_RESULT_STATUS=failed
else
  TEST_RESULT_STATUS=passed
fi

# A passing UI process is not authoritative evidence that the compatibility
# flow wrote the two allowlisted profiles and created exactly one plan. The
# isolated backend verifier proves those durable facts (and is deliberately
# still run after a UI failure so the summary distinguishes app failure from
# backend postconditions).
if [[ -n "$FIXTURE_VERIFY_MODE" ]]; then
  set +e
  "$IOS_SEED_RUNNER" "$FIXTURE_VERIFY_MODE"
  FIXTURE_VERIFY_EXIT_CODE=$?
  set -e
  if [[ "$FIXTURE_VERIFY_EXIT_CODE" == "0" ]]; then
    FIXTURE_VERIFY_STATUS=passed
  else
    FIXTURE_VERIFY_STATUS=failed
  fi
else
  FIXTURE_VERIFY_STATUS=not_required
fi

if [[ "$TEST_EXIT_CODE" != "0" ]]; then
  exit "$TEST_EXIT_CODE"
fi
if [[ -n "$FIXTURE_VERIFY_EXIT_CODE" && "$FIXTURE_VERIFY_EXIT_CODE" != "0" ]]; then
  exit "$FIXTURE_VERIFY_EXIT_CODE"
fi

echo "iOS Training E2E finished."
echo "Result bundle: $STATE_DIR/TrainingE2E.xcresult"
echo "Summary JSON:   $STATE_DIR/test-summary.json"
