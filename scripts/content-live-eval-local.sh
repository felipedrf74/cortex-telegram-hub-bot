#!/usr/bin/env bash
# Governed one-shot Content real-provider evaluation.
# Creates and destroys an isolated local runtime; only the redacted artifact is retained.
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OPT_IN=""
BUDGET_USD=""
OUTPUT=""
ATTESTATION_KEY_FILE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --opt-in) OPT_IN="${2:-}"; shift 2 ;;
    --budget-usd) BUDGET_USD="${2:-}"; shift 2 ;;
    --output) OUTPUT="${2:-}"; shift 2 ;;
    --attestation-key-file) ATTESTATION_KEY_FILE="${2:-}"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

NODE_RUNTIME_VERSION="$(node -p 'process.versions.node' 2>/dev/null || true)"
if [[ ! "$NODE_RUNTIME_VERSION" =~ ^22\.23\.[0-9]+$ ]]; then
  echo "Content live evaluation requires the repository-supported Node 22.23.x runtime; found ${NODE_RUNTIME_VERSION:-unavailable}." >&2
  exit 2
fi
if [[ ! -f "$ROOT/node_modules/tsx/dist/cli.mjs" ]]; then
  echo "Content live evaluation requires the locked local tsx runtime; run the reviewed dependency install first." >&2
  exit 2
fi

if [[ "$OPT_IN" != "I_ACCEPT_LIVE_PROVIDER_COSTS" ]]; then
  echo "Refusing live evaluation without --opt-in I_ACCEPT_LIVE_PROVIDER_COSTS" >&2
  exit 2
fi
if [[ -z "$ATTESTATION_KEY_FILE" || ! -f "$ATTESTATION_KEY_FILE" || -L "$ATTESTATION_KEY_FILE" ]]; then
  echo "--attestation-key-file must identify a separately provisioned regular key file." >&2
  exit 2
fi
KEY_MODE="$(stat -f '%Lp' "$ATTESTATION_KEY_FILE" 2>/dev/null || stat -c '%a' "$ATTESTATION_KEY_FILE" 2>/dev/null || true)"
if [[ "$KEY_MODE" != "600" ]]; then
  echo "The attestation key file must have mode 0600." >&2
  exit 2
fi
if [[ -n "$(git -C "$ROOT" status --porcelain --untracked-files=all -- src scripts content-engine migrations package.json package-lock.json tsconfig.json)" ]]; then
  echo "Live evaluation requires a clean generator surface, including no untracked files, bound to one committed candidate." >&2
  exit 2
fi
SOURCE_COMMIT="$(git -C "$ROOT" rev-parse HEAD)"
if [[ ! "$SOURCE_COMMIT" =~ ^[a-f0-9]{40}$ ]]; then
  echo "Could not resolve the exact source commit for live evaluation." >&2
  exit 2
fi
if [[ "$BUDGET_USD" != "1" && "$BUDGET_USD" != "1.0" && "$BUDGET_USD" != "1.00" ]]; then
  echo "--budget-usd must be exactly 1.00 (five pre-authorized 0.20 accounting ceilings under the reviewed pricing snapshot)." >&2
  exit 2
fi
if [[ "${NODE_ENV:-development}" == "production" ]]; then
  echo "Refusing to start the Content live evaluation with NODE_ENV=production." >&2
  exit 2
fi

RUN_SUFFIX="$(date -u +%Y%m%dT%H%M%SZ)-$$"
RUNTIME_ROOT="$ROOT/.local/content-eval/runtime-$RUN_SUFFIX"
ARTIFACT_ROOT="$ROOT/.local/content-eval/artifacts"
DB_PATH="$RUNTIME_ROOT/content-live-eval-$RUN_SUFFIX.db"
AUTH_FILE="$RUNTIME_ROOT/content-live-eval-auth.json"
OUTPUT="${OUTPUT:-$ARTIFACT_ROOT/content-live-eval-$RUN_SUFFIX.json}"
PORTAL_PORT="${CONTENT_LIVE_EVAL_PORTAL_PORT:-18200}"
CONTENT_PORT="${CONTENT_LIVE_EVAL_ENGINE_PORT:-18102}"
BASE_URL="http://127.0.0.1:$PORTAL_PORT"

mkdir -p "$ROOT/.local/content-eval" "$ARTIFACT_ROOT"
chmod 700 "$ROOT/.local/content-eval" "$ARTIFACT_ROOT"

for stale_root in "$ROOT"/.local/content-eval/runtime-*; do
  [[ -d "$stale_root" ]] || continue
  stale_live=0
  for pid_file in "$stale_root/backend.pid" "$stale_root/content-engine.pid"; do
    [[ -f "$pid_file" ]] || continue
    stale_pid="$(tr -d '[:space:]' < "$pid_file")"
    if [[ -n "$stale_pid" ]] && kill -0 "$stale_pid" 2>/dev/null; then
      stale_live=1
    fi
  done
  if [[ "$stale_live" == "1" ]]; then
    echo "Refusing to start while a stale live-evaluation runtime still owns a process: $stale_root" >&2
    exit 2
  fi
  rm -rf "$stale_root"
done

mkdir -p "$RUNTIME_ROOT"
chmod 700 "$RUNTIME_ROOT"

export FULL_NEXUS_STATE_DIR="$RUNTIME_ROOT"
export FULL_NEXUS_AUTH_FILE="$AUTH_FILE"
export FULL_NEXUS_ENV_FILE=/dev/null
export DATABASE_PATH="$DB_PATH"
export PORTAL_BIND=127.0.0.1
export PORTAL_PORT
export FULL_NEXUS_BASE_URL="$BASE_URL"
export CONTENT_ENGINE_PORT="$CONTENT_PORT"
export NEXUS_LOCAL_START_CONTENT_ENGINE=1
export NEXUS_LOCAL_ALLOW_MODEL_CALLS=1
export CONTENT_ENGINE_ENABLED=true
export CONTENT_LIVE_EVAL_ENABLED=1
export PAID_AI_COST_CONTROLS_ENFORCEMENT_ENABLED=true
export GLOBAL_DAILY_COST_LIMIT=1.00
export NEXUS_LOCAL_RUN_AUTH_SMOKE=0
export FULL_NEXUS_RESET_DB=1
export NEXUS_CONTENT_LIVE_EVAL_RUNTIME=1
export NEXUS_BACKGROUND_JOBS_ENABLED=0
export NEXUS_CONTENT_LIVE_EVAL_DELIVERY_DISABLED=1
export BACKUP_ENABLED=false
export NODE_ENV=development
export ENV=development
export STAGING=false
# Never inherit a weak developer placeholder into this disposable runtime.
# The value exists only in the evaluator process tree and dies with cleanup.
export IOS_API_JWT_SECRET="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(48).toString("base64url"))')"

cleanup() {
  "$ROOT/scripts/full-nexus-local-engine.sh" cleanup >/dev/null 2>&1 || true
  rm -rf "$RUNTIME_ROOT"
}
trap cleanup EXIT INT TERM

"$ROOT/scripts/full-nexus-local-engine.sh" start
for private_file in "$DB_PATH" "$DB_PATH-shm" "$DB_PATH-wal" "$RUNTIME_ROOT"/*.pid "$RUNTIME_ROOT"/logs/*.log; do
  [[ -f "$private_file" ]] && chmod 600 "$private_file"
done

env -i HOME="${HOME:-/tmp}" PATH="$PATH" TMPDIR="${TMPDIR:-/tmp}" \
  NODE_ENV=development \
  NEXUS_LOCAL_DB_PATH="$DB_PATH" \
  NEXUS_LOCAL_BASE_URL="$BASE_URL" \
  NEXUS_LOCAL_IOS_EMAIL="content-live-eval-$RUN_SUFFIX@synthetic.invalid" \
  NEXUS_LOCAL_IOS_FIRST_NAME="Content Evaluation" \
  NEXUS_LOCAL_IOS_DEVICE_ID="content-live-eval-$RUN_SUFFIX" \
  NEXUS_LOCAL_AUTH_IMPORT_PATH="$AUTH_FILE" \
  IOS_INVITE_CODE="${IOS_INVITE_CODE:-LOCAL-BETA-2026}" \
  node "$ROOT/scripts/local-ios-debug-auth.mjs"
chmod 600 "$AUTH_FILE" "$DB_PATH"

env -i HOME="${HOME:-/tmp}" PATH="$PATH" TMPDIR="${TMPDIR:-/tmp}" \
  NODE_ENV=development NEXUS_CONTENT_LIVE_EVAL_RUNTIME=1 \
  CONTENT_LIVE_EVAL_ENABLED=1 NEXUS_LOCAL_ALLOW_MODEL_CALLS=1 \
  PAID_AI_COST_CONTROLS_ENFORCEMENT_ENABLED=true \
  CONTENT_EVAL_TRUSTED_ATTESTATION_KEY_SHA256="${CONTENT_EVAL_TRUSTED_ATTESTATION_KEY_SHA256:-}" \
  node "$ROOT/node_modules/tsx/dist/cli.mjs" "$ROOT/scripts/run-content-eval-live.ts" \
  --opt-in "$OPT_IN" \
  --budget-usd "$BUDGET_USD" \
  --base-url "$BASE_URL" \
  --database-path "$DB_PATH" \
  --auth-file "$AUTH_FILE" \
  --output "$OUTPUT" \
  --attestation-key-file "$ATTESTATION_KEY_FILE"

echo "Validated redacted artifact retained at: $OUTPUT"
if [[ -n "${CONTENT_EVAL_TRUSTED_ATTESTATION_KEY_SHA256:-}" ]]; then
  echo "Operator-attestation fingerprint was supplied independently; the release evaluator must verify it again."
else
  echo "No trusted operator key fingerprint was supplied. This artifact is advisory integrity evidence and cannot release-gate."
fi
