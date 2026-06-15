#!/usr/bin/env bash
# sim-local.sh — boot the sandbox AND the iOS Simulator pointed at it.
#
# This is the "one command, get me running end-to-end" helper. Requires
# Xcode + xcrun simctl. The iOS app source must be at the workspace path
# (~/Desktop/Nexus Hub IOS/Nexus Hub/).
#
# What it does:
#   1. Boot the Docker sandbox (idempotent via local-up.sh).
#   2. Wait for /health green.
#   3. Boot an available iPhone Simulator device.
#   4. Build the iOS app for the simulator using the Debug scheme.
#   5. Install the .app on the simulator.
#   6. Launch with launch args that point NexusConfig at 127.0.0.1:8200.
#
# Override env vars:
#   NEXUS_SIM_DEVICE          — preferred iOS Simulator device name
#   NEXUS_SIM_UDID            — exact simulator UDID override
#   NEXUS_IOS_PROJECT_PATH    — path to the .xcodeproj directory
#   NEXUS_LOCAL_PORT_TS       — host port for Node (default: 8200)
#   NEXUS_SIM_AUTH_INVITE_CODE — local sandbox auth invite code override
#   NEXUS_SIM_DEBUG_AUTH_IMPORT — set to 1 to launch logged in via local auth JSON
#   NEXUS_SIM_DEBUG_AUTH_EMAIL  — local auth email (default nexushubbot@gmail.com)
#   NEXUS_SIM_CONSOLE         — set to 1 to attach simctl --console-pty
#   NEXUS_SIM_RESOLVE_ONLY    — set to 1 to print selected simulator and exit
#
# If xcrun simctl or xcodebuild are missing (CI/headless environment),
# the script skips and prints a manual-run instruction.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ -f "$ROOT/.env.local" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env.local"
  set +a
fi

IOS_PROJECT_PATH="${NEXUS_IOS_PROJECT_PATH:-/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub/Nexus Hub.xcodeproj}"
IOS_SCHEME="${NEXUS_IOS_SCHEME:-Nexus Hub}"
IOS_BUNDLE_ID="${NEXUS_IOS_BUNDLE_ID:-me.nexushub.app}"
SIM_DEVICE="${NEXUS_SIM_DEVICE:-}"
SIM_UDID_OVERRIDE="${NEXUS_SIM_UDID:-}"
PORT="${NEXUS_LOCAL_PORT_TS:-8200}"
LOCAL_AUTH_INVITE_CODE="${NEXUS_SIM_AUTH_INVITE_CODE:-${IOS_INVITE_CODE:-LOCAL-DEV-INVITE}}"
DEBUG_AUTH_IMPORT="${NEXUS_SIM_DEBUG_AUTH_IMPORT:-0}"
DEBUG_AUTH_EMAIL="${NEXUS_SIM_DEBUG_AUTH_EMAIL:-nexushubbot@gmail.com}"
DEBUG_AUTH_FILE="${NEXUS_SIM_DEBUG_AUTH_FILE:-$ROOT/.local/full-nexus/local-ios-auth.json}"

# ──────────────────────────────────────────────────────────────────────
# Step 0 — preflight
if ! command -v xcrun >/dev/null 2>&1; then
  cat <<EOF
ERROR: xcrun not found. This script requires Xcode command line tools.

You can still test the sandbox without the simulator wiring:
  ./scripts/local-up.sh
  ./scripts/local-smoke.sh

Then manually open the iOS app in Xcode and add these launch args to
your scheme (Product → Scheme → Edit Scheme → Run → Arguments):
  -nexus_allow_local_backend YES
  -nexus_base_url http://127.0.0.1:${PORT}
  -nexus_local_auth_invite_code ${LOCAL_AUTH_INVITE_CODE}
EOF
  exit 1
fi

if [ ! -d "$IOS_PROJECT_PATH" ]; then
  echo "ERROR: iOS project not found at:"
  echo "  $IOS_PROJECT_PATH"
  echo "Set NEXUS_IOS_PROJECT_PATH to override."
  exit 1
fi

# ──────────────────────────────────────────────────────────────────────
# Step 1 — boot sandbox
if [ "${NEXUS_SIM_RESOLVE_ONLY:-0}" != "1" ]; then
  echo "═══════════════════════════════════════════════"
  echo "  Step 1/5: boot Docker sandbox"
  echo "═══════════════════════════════════════════════"
  "$ROOT/scripts/local-up.sh"

  if [ "$DEBUG_AUTH_IMPORT" = "1" ]; then
    echo ""
    echo "Preparing local iOS debug auth for $DEBUG_AUTH_EMAIL"
    NEXUS_LOCAL_BASE_URL="http://127.0.0.1:${PORT}" \
      NEXUS_LOCAL_IOS_EMAIL="$DEBUG_AUTH_EMAIL" \
      NEXUS_LOCAL_IOS_INVITE_CODE="$LOCAL_AUTH_INVITE_CODE" \
      NEXUS_LOCAL_AUTH_IMPORT_PATH="$DEBUG_AUTH_FILE" \
      node "$ROOT/scripts/local-ios-debug-auth.mjs"
  fi
fi

# ──────────────────────────────────────────────────────────────────────
# Step 2 — boot simulator
echo ""
echo "═══════════════════════════════════════════════"
echo "  Step 2/5: boot iOS Simulator"
echo "═══════════════════════════════════════════════"
SIM_SELECTION="$(xcrun simctl list devices --json 2>/dev/null \
  | node -e '
let b = "";
process.stdin.on("data", c => b += c).on("end", () => {
  const preferredName = process.argv[1] || "";
  const preferredUdid = process.argv[2] || "";
  const j = JSON.parse(b || "{}");
  const rows = [];

  function runtimeVersion(runtime) {
    const match = String(runtime).match(/iOS[- ]([0-9-]+)/);
    if (!match) return [0];
    return match[1].split("-").map((n) => Number(n) || 0);
  }

  function compareVersionDesc(a, b) {
    const av = runtimeVersion(a.runtime);
    const bv = runtimeVersion(b.runtime);
    const len = Math.max(av.length, bv.length);
    for (let i = 0; i < len; i += 1) {
      const delta = (bv[i] || 0) - (av[i] || 0);
      if (delta) return delta;
    }
    return 0;
  }

  for (const [runtime, devices] of Object.entries(j.devices || {})) {
    if (!String(runtime).includes(".iOS-") && !String(runtime).includes("iOS ")) continue;
    for (const d of devices || []) {
      if (!d.isAvailable || !String(d.name || "").startsWith("iPhone")) continue;
      rows.push({ name: d.name, udid: d.udid, state: d.state, runtime });
    }
  }

  if (preferredUdid) {
    const match = rows.find((d) => d.udid === preferredUdid);
    if (!match) process.exit(2);
    console.log([match.udid, match.name, match.runtime, "udid"].join("\t"));
    return;
  }

  if (preferredName) {
    const matches = rows.filter((d) => d.name === preferredName).sort(compareVersionDesc);
    if (!matches.length) process.exit(3);
    const booted = matches.find((d) => d.state === "Booted");
    const chosen = booted || matches[0];
    console.log([chosen.udid, chosen.name, chosen.runtime, "requested-name"].join("\t"));
    return;
  }

  const preferredOrder = ["iPhone 17 Pro", "iPhone 17", "iPhone 17 Pro Max", "iPhone Air", "iPhone 17e"];
  const priority = (name) => {
    const index = preferredOrder.indexOf(name);
    return index >= 0 ? index : 99;
  };
  const booted = rows
    .filter((d) => d.state === "Booted")
    .sort((a, b) => priority(a.name) - priority(b.name) || compareVersionDesc(a, b))[0];
  if (booted) {
    console.log([booted.udid, booted.name, booted.runtime, "booted"].join("\t"));
    return;
  }

  const sorted = rows.sort((a, b) => {
    return priority(a.name) - priority(b.name) || compareVersionDesc(a, b) || a.name.localeCompare(b.name);
  });
  if (!sorted.length) process.exit(4);
  const chosen = sorted[0];
  console.log([chosen.udid, chosen.name, chosen.runtime, "auto"].join("\t"));
});' "$SIM_DEVICE" "$SIM_UDID_OVERRIDE" 2>/dev/null || true)"

if [ -z "$SIM_SELECTION" ]; then
  if [ -n "$SIM_UDID_OVERRIDE" ]; then
    echo "ERROR: no available iPhone simulator with UDID '$SIM_UDID_OVERRIDE'."
  elif [ -n "$SIM_DEVICE" ]; then
    echo "ERROR: no available iPhone simulator named '$SIM_DEVICE'."
  else
    echo "ERROR: no available iPhone simulator found."
  fi
  echo "List available devices: xcrun simctl list devices available"
  echo "Override with NEXUS_SIM_DEVICE='iPhone 17 Pro' or NEXUS_SIM_UDID='<UDID>'"
  exit 1
fi

IFS=$'\t' read -r SIM_UDID SIM_DEVICE_NAME SIM_RUNTIME SIM_SELECTION_REASON <<< "$SIM_SELECTION"
echo "Simulator: $SIM_DEVICE_NAME"
echo "Runtime:   $SIM_RUNTIME"
echo "UDID:      $SIM_UDID"
echo "Selected:  $SIM_SELECTION_REASON"

if [ "${NEXUS_SIM_RESOLVE_ONLY:-0}" = "1" ]; then
  echo "Resolve-only requested; skipping sandbox boot, build, install, and launch."
  exit 0
fi

# Boot if not already booted (simctl errors are non-fatal when "already booted")
xcrun simctl boot "$SIM_UDID" 2>/dev/null || true

# Open the Simulator UI so Felipe can see it (no-op if already open)
open -a Simulator || true

# ──────────────────────────────────────────────────────────────────────
# Step 3 — build for the simulator
echo ""
echo "═══════════════════════════════════════════════"
echo "  Step 3/5: build iOS app for simulator"
echo "═══════════════════════════════════════════════"
DERIVED_DATA="$(mktemp -d -t nexus-sim-local-XXXXXX)"
echo "DerivedData: $DERIVED_DATA"

xcodebuild \
  -project "$IOS_PROJECT_PATH" \
  -scheme "$IOS_SCHEME" \
  -configuration Debug \
  -destination "platform=iOS Simulator,id=$SIM_UDID" \
  -derivedDataPath "$DERIVED_DATA" \
  build \
  | tail -40

APP_PATH="$(find "$DERIVED_DATA/Build/Products" -maxdepth 4 -name 'Nexus Hub.app' -print -quit 2>/dev/null || true)"
if [ -z "$APP_PATH" ] || [ ! -d "$APP_PATH" ]; then
  echo "ERROR: could not locate the built .app under $DERIVED_DATA"
  exit 1
fi
echo "Built .app: $APP_PATH"

# ──────────────────────────────────────────────────────────────────────
# Step 4 — install
echo ""
echo "═══════════════════════════════════════════════"
echo "  Step 4/5: install on simulator"
echo "═══════════════════════════════════════════════"
xcrun simctl install "$SIM_UDID" "$APP_PATH"

# ──────────────────────────────────────────────────────────────────────
# Step 5 — launch with local-backend launch args
echo ""
echo "═══════════════════════════════════════════════"
echo "  Step 5/5: launch with local-backend args"
echo "═══════════════════════════════════════════════"
LAUNCH_OPTIONS=(--terminate-running-process)
LAUNCH_ARGS=(
  "$SIM_UDID"
  "$IOS_BUNDLE_ID"
  -nexus_allow_local_backend YES
  -nexus_base_url "http://127.0.0.1:${PORT}"
  -nexus_local_auth_invite_code "$LOCAL_AUTH_INVITE_CODE"
)
if [ "$DEBUG_AUTH_IMPORT" = "1" ]; then
  if [ ! -s "$DEBUG_AUTH_FILE" ]; then
    echo "ERROR: expected local auth JSON at $DEBUG_AUTH_FILE" >&2
    exit 1
  fi
  export SIMCTL_CHILD_NEXUS_LOCAL_AUTH_IMPORT_PATH="$DEBUG_AUTH_FILE"
  LAUNCH_ARGS+=(
    -nexus_debug_local_auth_import YES
  )
  echo "Debug auth: $DEBUG_AUTH_EMAIL"
  echo "Auth file:  $DEBUG_AUTH_FILE"
fi
if [ "${NEXUS_SIM_CONSOLE:-0}" = "1" ]; then
  LAUNCH_OPTIONS=(--console-pty "${LAUNCH_OPTIONS[@]}")
fi

xcrun simctl launch "${LAUNCH_OPTIONS[@]}" "${LAUNCH_ARGS[@]}" || {
    echo ""
    echo "WARN: simctl launch returned non-zero. The app may still be"
    echo "running — check the Simulator window. You can manually launch with:"
    if [ "$DEBUG_AUTH_IMPORT" = "1" ]; then
      echo "  SIMCTL_CHILD_NEXUS_LOCAL_AUTH_IMPORT_PATH='$DEBUG_AUTH_FILE' \\"
    fi
    echo "  xcrun simctl launch --terminate-running-process $SIM_UDID $IOS_BUNDLE_ID \\"
    echo "    -nexus_allow_local_backend YES \\"
    echo "    -nexus_base_url http://127.0.0.1:${PORT} \\"
    if [ "$DEBUG_AUTH_IMPORT" = "1" ]; then
      echo "    -nexus_local_auth_invite_code '$LOCAL_AUTH_INVITE_CODE' \\"
      echo "    -nexus_debug_local_auth_import YES"
    else
      echo "    -nexus_local_auth_invite_code '$LOCAL_AUTH_INVITE_CODE'"
    fi
  }
