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
mkdir -p "$STATE_DIR"

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

SIM_UDID="${NEXUS_TRAINING_E2E_IOS_SIM_UDID:-}"
CREATED_SIM=0
SEEDED_IOS_PLAN=0
if [[ -z "$SIM_UDID" ]]; then
  RUNTIME_ID="${NEXUS_TRAINING_E2E_IOS_RUNTIME:-$(resolve_latest_ios_runtime)}"
  DEVICE_TYPE="${NEXUS_TRAINING_E2E_IOS_DEVICE_TYPE:-com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro}"
  SIM_NAME="Nexus Training E2E ${NEXUS_TRAINING_E2E_RUN_ID}"
  echo "Creating dedicated simulator: $SIM_NAME"
  SIM_UDID="$(xcrun simctl create "$SIM_NAME" "$DEVICE_TYPE" "$RUNTIME_ID")"
  CREATED_SIM=1
fi

cleanup() {
  local status=$?
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
  if [[ "$SEEDED_IOS_PLAN" == "1" && "${NEXUS_TRAINING_E2E_IOS_KEEP_SEEDED_PLAN:-0}" != "1" ]]; then
    node "$ROOT/scripts/training-e2e-ios-seed.mjs" cleanup >/dev/null 2>&1 || true
  fi
  if [[ "${NEXUS_TRAINING_E2E_IOS_KEEP_SIM:-0}" != "1" ]]; then
    xcrun simctl terminate "$SIM_UDID" "${NEXUS_TRAINING_E2E_IOS_BUNDLE_ID:-me.nexushub.app}" >/dev/null 2>&1 || true
    xcrun simctl shutdown "$SIM_UDID" >/dev/null 2>&1 || true
    if [[ "$CREATED_SIM" == "1" && "${NEXUS_TRAINING_E2E_IOS_DELETE_CREATED_SIM:-1}" == "1" ]]; then
      xcrun simctl delete "$SIM_UDID" >/dev/null 2>&1 || true
    fi
  fi
  exit "$status"
}
trap cleanup EXIT

if [[ "${NEXUS_TRAINING_E2E_IOS_PRESEED_PLAN:-1}" == "1" ]]; then
  echo "Seeding active Training plan for isolated iOS assertions"
  node "$ROOT/scripts/training-e2e-ios-seed.mjs" prepare
  SEEDED_IOS_PLAN=1
fi

for config_path in "${IOS_CONFIG_PATHS[@]}"; do
  write_ios_config "$config_path"
done
mkdir -p "$(dirname "$IOS_CONFIG_POINTER")"
printf '%s\n' "${IOS_CONFIG_PATHS[0]}" > "$IOS_CONFIG_POINTER.tmp"
mv "$IOS_CONFIG_POINTER.tmp" "$IOS_CONFIG_POINTER"

IOS_TEST_ARGS=("$@")
if [[ ${#IOS_TEST_ARGS[@]} -eq 0 ]]; then
  IOS_TEST_ARGS=(
    -only-testing:"Nexus HubUITests/TrainingIsolatedBackendE2EUITests"
    -only-testing:"Nexus HubUITests/TrainingFixtureBypassUITests"
    -only-testing:"Nexus HubUITests/TrainingValidationUITests"
  )
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

echo "iOS Training E2E finished."
echo "Result bundle: $STATE_DIR/TrainingE2E.xcresult"
echo "Summary JSON:   $STATE_DIR/test-summary.json"
