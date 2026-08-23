#!/usr/bin/env bash
# Protected-main operator for the production routing-calibration corpus export.
set -euo pipefail
umask 077

readonly SERVER="${DEPLOY_SERVER:?DEPLOY_SERVER must be set (SSH host for the release server)}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HELPER="$ROOT/scripts/lib/routing-calibration-export.mjs"
PRIVATE_DIR_TOOL="$ROOT/scripts/lib/ensure-private-directory.py"
readonly PYTHON_BIN='/opt/homebrew/bin/python3'

COMMAND="${1:-}"
[ "$#" -eq 0 ] || shift
RUNTIME_SHA=''
ARTIFACT_DIGEST=''
TRANSACTION_ID=''
ACK_PLAN=''

die() {
  printf 'routing calibration export operator: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'USAGE'
Usage:
  npm run release:routing-calibration-export -- inspect \
    --runtime-sha <40-hex> --artifact-digest <64-hex>

  NEXUS_RELEASE_OWNER_AUTHORIZED=1 \
  npm run release:routing-calibration-export -- apply \
    --runtime-sha <40-hex> --artifact-digest <64-hex> \
    --ack-plan sha256:<64-hex>

  npm run release:routing-calibration-export -- collect \
    --runtime-sha <40-hex> --artifact-digest <64-hex> \
    --ack-plan sha256:<64-hex>

Inspect writes a redacted, exact-production-state plan under ignored `.local/`.
Apply consumes that owner-authorized plan once by dispatching one detached user
systemd transaction. If SSH or this process is interrupted after dispatch, use
collect with the same tuple and plan digest. Collect only observes that exact
transaction; it never invokes apply again. Successful collection transfers
only the FD-bound, remotely revalidated sanitized SQLite, evidence, and final
receipt. A failed transaction transfers its terminal partial receipt.
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --runtime-sha) RUNTIME_SHA="${2:?--runtime-sha requires a value}"; shift 2 ;;
    --artifact-digest) ARTIFACT_DIGEST="${2:?--artifact-digest requires a value}"; shift 2 ;;
    --transaction-id) TRANSACTION_ID="${2:?--transaction-id requires a value}"; shift 2 ;;
    --ack-plan) ACK_PLAN="${2:?--ack-plan requires a value}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

case "$COMMAND" in inspect|apply|collect) ;; *) usage >&2; exit 64 ;; esac
[[ "$RUNTIME_SHA" =~ ^[a-f0-9]{40}$ ]] || die '--runtime-sha is invalid'
[[ "$ARTIFACT_DIGEST" =~ ^[a-f0-9]{64}$ ]] || die '--artifact-digest is invalid'
[ -f "$HELPER" ] && [ ! -L "$HELPER" ] || die 'local export helper is unavailable or symbolic'
[ -f "$PRIVATE_DIR_TOOL" ] && [ ! -L "$PRIVATE_DIR_TOOL" ] \
  || die 'local private-directory helper is unavailable or symbolic'
[ -x "$PYTHON_BIN" ] || die 'required local Python 3 runtime is unavailable'
if [ "$COMMAND" = apply ] || [ "$COMMAND" = collect ]; then
  [[ "$ACK_PLAN" =~ ^sha256:[a-f0-9]{64}$ ]] \
    || die "$COMMAND requires exact --ack-plan"
  [ -z "$TRANSACTION_ID" ] \
    || die "$COMMAND derives transaction identity from the reviewed plan"
  if [ "$COMMAND" = apply ]; then
    [ "${NEXUS_RELEASE_OWNER_AUTHORIZED:-0}" = 1 ] \
      || die 'apply requires NEXUS_RELEASE_OWNER_AUTHORIZED=1'
  fi
else
  [ -z "$ACK_PLAN" ] || die 'inspect does not accept --ack-plan'
  if [ -z "$TRANSACTION_ID" ]; then
    TRANSACTION_ID="$(date -u +%Y%m%dT%H%M%SZ)-$(
      node -e 'process.stdout.write(require("node:crypto").randomBytes(6).toString("hex"))'
    )"
  fi
  [[ "$TRANSACTION_ID" =~ ^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}$ ]] \
    || die '--transaction-id is invalid'
fi

git -C "$ROOT" fetch --quiet --no-tags origin main
[ -z "$(git -C "$ROOT" status --porcelain=v1 --untracked-files=normal)" ] \
  || die 'operator requires a clean protected-main checkout'
[ "$(git -C "$ROOT" rev-parse HEAD)" = "$RUNTIME_SHA" ] \
  || die 'checkout does not match the exact runtime SHA'
[ "$(git -C "$ROOT" rev-parse origin/main)" = "$RUNTIME_SHA" ] \
  || die 'operator requires the exact protected origin/main checkout'

RELEASE_NAME="$RUNTIME_SHA-${ARTIFACT_DIGEST:0:12}"
REMOTE_SCRIPT="\$HOME/telegram-hub-bot/releases/$RELEASE_NAME/scripts/remote-routing-calibration-export-transaction.sh"
REMOTE_STATE_ROOT='$HOME/.local/state/nexus-release/routing-calibration-export'
LOCAL_ROOT="$ROOT/.local/release/routing-calibration-export/$RELEASE_NAME"
PLAN_ROOT="$LOCAL_ROOT/plans"
EVIDENCE_ROOT="$LOCAL_ROOT/evidence"
EXPORT_ROOT="$LOCAL_ROOT/exports"
RECEIPT_ROOT="$LOCAL_ROOT/receipts"
"$PYTHON_BIN" -B "$PRIVATE_DIR_TOOL" --anchor "$ROOT" --exact-private \
  "$PLAN_ROOT" "$EVIDENCE_ROOT" "$EXPORT_ROOT" "$RECEIPT_ROOT" \
  || die 'local evidence directories are unsafe'

TEMP_FILES=()
cleanup() {
  local file
  for file in "${TEMP_FILES[@]:-}"; do
    [ -n "$file" ] && rm -f -- "$file"
  done
}
trap cleanup EXIT

publish_private() {
  node "$HELPER" publish-private --source="$1" --destination="$2" >/dev/null \
    || die "cannot publish exact private evidence: $2"
}

validate_local_plan() {
  local plan_file="$1"
  local expected_transaction="$2"
  node --input-type=module - "$HELPER" "$plan_file" "$RUNTIME_SHA" \
    "$ARTIFACT_DIGEST" "$expected_transaction" <<'NODE'
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
const [helperPath, planFile, runtimeSha, artifactDigest, transactionId]
  = process.argv.slice(2);
const helper = await import(pathToFileURL(helperPath).href);
const stat = fs.lstatSync(planFile);
if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
    || (stat.mode & 0o777) !== 0o600) process.exit(1);
const plan = helper.validateRoutingCalibrationExportPlan(
  JSON.parse(fs.readFileSync(planFile, 'utf8')),
);
if (plan.runtimeSha !== runtimeSha || plan.artifactDigest !== artifactDigest
    || plan.transactionId !== transactionId) process.exit(1);
process.stdout.write(plan.planDigest);
NODE
}

if [ "$COMMAND" = inspect ]; then
  PLAN_TEMP="$(mktemp "$PLAN_ROOT/.inspect.XXXXXX")"
  TEMP_FILES+=("$PLAN_TEMP")
  ssh "$SERVER" /bin/bash "$REMOTE_SCRIPT" inspect "$RUNTIME_SHA" \
    "$ARTIFACT_DIGEST" "$TRANSACTION_ID" < /dev/null > "$PLAN_TEMP"
  PLAN_DIGEST="$(validate_local_plan "$PLAN_TEMP" "$TRANSACTION_ID")" \
    || die 'remote inspect returned an invalid export plan'
  PLAN_FILE="$PLAN_ROOT/${PLAN_DIGEST#sha256:}.json"
  publish_private "$PLAN_TEMP" "$PLAN_FILE"
  validate_local_plan "$PLAN_FILE" "$TRANSACTION_ID" >/dev/null \
    || die 'published local plan failed revalidation'
  cat "$PLAN_FILE"
  exit 0
fi

PLAN_FILE="$PLAN_ROOT/${ACK_PLAN#sha256:}.json"
[ -f "$PLAN_FILE" ] && [ ! -L "$PLAN_FILE" ] \
  || die "$COMMAND requires the locally retained exact inspected plan"
PLAN_IDENTITY="$(node --input-type=module - "$HELPER" "$PLAN_FILE" <<'NODE'
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
const [helperPath, planFile] = process.argv.slice(2);
const helper = await import(pathToFileURL(helperPath).href);
const plan = helper.validateRoutingCalibrationExportPlan(
  JSON.parse(fs.readFileSync(planFile, 'utf8')),
);
process.stdout.write(`${plan.transactionId} ${plan.planDigest}`);
NODE
)" || die 'locally retained export plan is invalid'
IFS=' ' read -r TRANSACTION_ID PLAN_IDENTITY_DIGEST <<< "$PLAN_IDENTITY"
[ "$PLAN_IDENTITY_DIGEST" = "$ACK_PLAN" ] \
  || die 'locally retained export plan does not match --ack-plan'
validate_local_plan "$PLAN_FILE" "$TRANSACTION_ID" >/dev/null \
  || die 'locally retained export plan differs from the exact release'

UNIT="nexus-routing-calibration-export-${RUNTIME_SHA:0:12}-${TRANSACTION_ID##*-}"
REMOTE_CLAIM="$REMOTE_STATE_ROOT/claims/$TRANSACTION_ID.plan.json"
REMOTE_PARTIAL="$REMOTE_STATE_ROOT/receipts/$TRANSACTION_ID.partial.json"
REMOTE_FINAL="$REMOTE_STATE_ROOT/receipts/$TRANSACTION_ID.json"
LOCAL_EXPORT="$EXPORT_ROOT/$TRANSACTION_ID.sqlite"
LOCAL_EVIDENCE="$EVIDENCE_ROOT/$TRANSACTION_ID.json"
LOCAL_PARTIAL="$RECEIPT_ROOT/$TRANSACTION_ID.partial.json"
LOCAL_RECEIPT="$RECEIPT_ROOT/$TRANSACTION_ID.json"

remote_file_exists() {
  ssh "$SERVER" test -f "$1"
}

collect_final() {
  local export_temp evidence_temp receipt_temp
  export_temp="$(mktemp "$EXPORT_ROOT/.collect-export.XXXXXX")"
  evidence_temp="$(mktemp "$EVIDENCE_ROOT/.collect-evidence.XXXXXX")"
  receipt_temp="$(mktemp "$RECEIPT_ROOT/.collect-receipt.XXXXXX")"
  TEMP_FILES+=("$export_temp" "$evidence_temp" "$receipt_temp")
  ssh "$SERVER" /bin/bash "$REMOTE_SCRIPT" emit "$RUNTIME_SHA" \
    "$ARTIFACT_DIGEST" "$TRANSACTION_ID" sqlite < /dev/null > "$export_temp"
  ssh "$SERVER" /bin/bash "$REMOTE_SCRIPT" emit "$RUNTIME_SHA" \
    "$ARTIFACT_DIGEST" "$TRANSACTION_ID" evidence < /dev/null > "$evidence_temp"
  ssh "$SERVER" /bin/bash "$REMOTE_SCRIPT" emit "$RUNTIME_SHA" \
    "$ARTIFACT_DIGEST" "$TRANSACTION_ID" receipt < /dev/null > "$receipt_temp"
  chmod 600 "$export_temp" "$evidence_temp" "$receipt_temp"
  node "$HELPER" validate-receipt --receipt-file="$receipt_temp" \
    --plan-file="$PLAN_FILE" --evidence-file="$evidence_temp" \
    --release-dir="$ROOT" --output-path="$export_temp" --copied-export >/dev/null \
    || die 'collected export receipt or SQLite evidence is invalid'

  # Crash-safe and retry-safe: immutable data/evidence publish first; the
  # authoritative receipt is fsynced and published last.
  publish_private "$export_temp" "$LOCAL_EXPORT"
  publish_private "$evidence_temp" "$LOCAL_EVIDENCE"
  publish_private "$receipt_temp" "$LOCAL_RECEIPT"
  node "$HELPER" validate-receipt --receipt-file="$LOCAL_RECEIPT" \
    --plan-file="$PLAN_FILE" --evidence-file="$LOCAL_EVIDENCE" \
    --release-dir="$ROOT" --output-path="$LOCAL_EXPORT" --copied-export >/dev/null \
    || die 'published local export evidence failed revalidation'
  cat "$LOCAL_RECEIPT"
  printf 'Sanitized routing SQLite: %s\n' "$LOCAL_EXPORT" >&2
}

collect_partial() {
  local partial_temp
  partial_temp="$(mktemp "$RECEIPT_ROOT/.collect-partial.XXXXXX")"
  TEMP_FILES+=("$partial_temp")
  ssh "$SERVER" /bin/bash "$REMOTE_SCRIPT" emit "$RUNTIME_SHA" \
    "$ARTIFACT_DIGEST" "$TRANSACTION_ID" partial < /dev/null > "$partial_temp"
  chmod 600 "$partial_temp"
  node "$HELPER" validate-partial --receipt-file="$partial_temp" \
    --plan-file="$PLAN_FILE" --require-status=failed >/dev/null \
    || die 'remote terminal partial receipt is invalid'
  publish_private "$partial_temp" "$LOCAL_PARTIAL"
  node "$HELPER" validate-partial --receipt-file="$LOCAL_PARTIAL" \
    --plan-file="$PLAN_FILE" --require-status=failed >/dev/null \
    || die 'published local terminal partial receipt failed revalidation'
  cat "$LOCAL_PARTIAL" >&2
}

poll_transaction() {
  local deadline=$((SECONDS + 600))
  while [ "$SECONDS" -lt "$deadline" ]; do
    local unit_state active_state='' sub_state='' result='' exec_status='' load_state=''
    unit_state="$(ssh "$SERVER" systemctl --user show "$UNIT" \
      --property LoadState --property ActiveState --property SubState \
      --property Result --property ExecMainStatus 2>/dev/null)" \
      || die "cannot inspect detached export unit; rerun collect for $TRANSACTION_ID"
    while IFS='=' read -r key value; do
      case "$key" in
        LoadState) load_state="$value" ;;
        ActiveState) active_state="$value" ;;
        SubState) sub_state="$value" ;;
        Result) result="$value" ;;
        ExecMainStatus) exec_status="$value" ;;
      esac
    done <<< "$unit_state"

    if [ "$load_state" = not-found ]; then
      if remote_file_exists "$REMOTE_FINAL"; then
        collect_final
        return 0
      fi
      if remote_file_exists "$REMOTE_PARTIAL"; then
        collect_partial || die 'nonterminal partial receipt requires manual recovery; never re-apply this plan'
      fi
      die 'detached export unit is absent and has no terminal receipt; manual recovery is required and this plan must never be re-applied'
    fi
    if { [ "$active_state" = active ] && [ "$sub_state" = exited ]; } \
        || [ "$active_state" = failed ]; then
      if [ "$active_state" = active ] && [ "$sub_state" = exited ] \
          && [ "$result" = success ] && [ "$exec_status" = 0 ] \
          && remote_file_exists "$REMOTE_FINAL"; then
        collect_final
        ssh "$SERVER" systemctl --user stop "$UNIT" >/dev/null 2>&1 || true
        return 0
      fi
      if remote_file_exists "$REMOTE_PARTIAL"; then
        collect_partial || die 'nonterminal partial receipt requires manual recovery; never re-apply this plan'
      fi
      printf '%s\n' "$unit_state" >&2
      die 'detached export transaction failed or ended without its exact final receipt'
    fi
    sleep 2
  done
  die "detached export transaction is still running; rerun collect for $TRANSACTION_ID"
}

if [ "$COMMAND" = apply ]; then
  if remote_file_exists "$REMOTE_CLAIM" \
      || remote_file_exists "$REMOTE_PARTIAL" \
      || remote_file_exists "$REMOTE_FINAL"; then
    die 'this exact plan already has remote attempt state; use collect and never re-apply'
  fi
  EXISTING_LOAD_STATE="$(ssh "$SERVER" systemctl --user show "$UNIT" \
    --property LoadState --value 2>/dev/null || true)"
  [ -z "$EXISTING_LOAD_STATE" ] || [ "$EXISTING_LOAD_STATE" = not-found ] \
    || die 'the detached export unit already exists; use collect'
  if ! ssh "$SERVER" systemd-run --user --quiet --collect --remain-after-exit \
      --unit "$UNIT" \
      --property Type=oneshot \
      --property TimeoutStartSec=10min \
      --setenv=NEXUS_RELEASE_OWNER_AUTHORIZED=1 \
      /bin/bash "$REMOTE_SCRIPT" apply "$RUNTIME_SHA" "$ARTIFACT_DIGEST" \
      "$TRANSACTION_ID" "$ACK_PLAN"; then
    printf 'Detached dispatch result is uncertain; observing exact transaction %s.\n' \
      "$TRANSACTION_ID" >&2
  fi
fi

poll_transaction
