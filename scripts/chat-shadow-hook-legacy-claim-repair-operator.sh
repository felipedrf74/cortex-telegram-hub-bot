#!/usr/bin/env bash
# Protected-main operator for the one-time 4.14.232 shadow-hook claim repair.
set -euo pipefail
umask 077

readonly SERVER="${DEPLOY_SERVER:?DEPLOY_SERVER must be set (SSH host for the release server)}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REMOTE_TOOL="$ROOT/scripts/remote-chat-shadow-hook-legacy-claim-repair.sh"

COMMAND="${1:-}"
shift $(( $# > 0 ? 1 : 0 ))
RUNTIME_SHA=''
ARTIFACT_DIGEST=''
TRANSACTION_ID=''
ACK_PLAN=''

die() {
  printf 'legacy shadow-hook claim repair operator: %s\n' "$*" >&2
  exit 1
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --runtime-sha) RUNTIME_SHA="${2:?--runtime-sha requires a value}"; shift 2 ;;
    --artifact-digest) ARTIFACT_DIGEST="${2:?--artifact-digest requires a value}"; shift 2 ;;
    --transaction-id) TRANSACTION_ID="${2:?--transaction-id requires a value}"; shift 2 ;;
    --ack-plan) ACK_PLAN="${2:?--ack-plan requires a value}"; shift 2 ;;
    *) die "unknown argument: $1" ;;
  esac
done

case "$COMMAND" in inspect|apply) ;; *) die 'command must be inspect or apply' ;; esac
[[ "$RUNTIME_SHA" =~ ^[0-9a-f]{40}$ ]] || die '--runtime-sha is invalid'
[[ "$ARTIFACT_DIGEST" =~ ^[0-9a-f]{64}$ ]] || die '--artifact-digest is invalid'
[[ "$TRANSACTION_ID" =~ ^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}$ ]] \
  || die '--transaction-id is invalid'
[ -f "$REMOTE_TOOL" ] && [ ! -L "$REMOTE_TOOL" ] \
  || die 'remote repair tool is unavailable or symbolic'
if [ "$COMMAND" = apply ]; then
  [ "${NEXUS_RELEASE_OWNER_AUTHORIZED:-0}" = 1 ] \
    || die 'apply requires NEXUS_RELEASE_OWNER_AUTHORIZED=1'
  [[ "$ACK_PLAN" =~ ^sha256:[0-9a-f]{64}$ ]] || die 'apply requires exact --ack-plan'
else
  [ -z "$ACK_PLAN" ] || die 'inspect does not accept --ack-plan'
fi

git -C "$ROOT" fetch --quiet --no-tags origin main
[ -z "$(git -C "$ROOT" status --porcelain=v1 --untracked-files=normal)" ] \
  || die 'operator requires a clean protected-main checkout'
LOCAL_HEAD="$(git -C "$ROOT" rev-parse HEAD)"
REMOTE_MAIN="$(git -C "$ROOT" rev-parse origin/main)"
[ "$LOCAL_HEAD" = "$REMOTE_MAIN" ] \
  || die 'operator requires the exact protected origin/main checkout'

LOCAL_ROOT="$ROOT/.local/release/chat-shadow-hook-legacy-claim-repair/$RUNTIME_SHA-${ARTIFACT_DIGEST:0:12}"
PLAN_ROOT="$LOCAL_ROOT/plans"
RECEIPT_ROOT="$LOCAL_ROOT/receipts"
install -d -m 700 "$ROOT/.local" "$ROOT/.local/release" \
  "$ROOT/.local/release/chat-shadow-hook-legacy-claim-repair" \
  "$LOCAL_ROOT" "$PLAN_ROOT" "$RECEIPT_ROOT"
TOOL_SNAPSHOT="$(mktemp "$LOCAL_ROOT/.remote-tool.XXXXXX")"
TEMP_PLAN=''
TEMP_RECEIPT=''
cleanup() {
  rm -f -- "$TOOL_SNAPSHOT" "${TEMP_PLAN:-}" "${TEMP_RECEIPT:-}"
}
trap cleanup EXIT
install -m 600 "$REMOTE_TOOL" "$TOOL_SNAPSHOT"
EXPECTED_TOOL_BLOB="$(git -C "$ROOT" rev-parse "$LOCAL_HEAD:scripts/remote-chat-shadow-hook-legacy-claim-repair.sh")"
OBSERVED_TOOL_BLOB="$(git -C "$ROOT" hash-object "$TOOL_SNAPSHOT")"
[ "$OBSERVED_TOOL_BLOB" = "$EXPECTED_TOOL_BLOB" ] \
  || die 'remote repair tool snapshot differs from protected main'
TOOL_SHA256="$(shasum -a 256 "$TOOL_SNAPSHOT" | awk '{print $1}')"
[[ "$TOOL_SHA256" =~ ^[0-9a-f]{64}$ ]] || die 'cannot hash the remote repair tool snapshot'

validate_plan() {
  local file="$1"
  node - "$file" "$RUNTIME_SHA" "$ARTIFACT_DIGEST" "$TRANSACTION_ID" "$TOOL_SHA256" <<'NODE'
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const [file,runtimeSha,artifactDigest,transactionId,toolSha256] = process.argv.slice(2);
const value = JSON.parse(fs.readFileSync(file, 'utf8'));
const canonical = (input) => {
  if (input === null || typeof input === 'string' || typeof input === 'boolean') return JSON.stringify(input);
  if (typeof input === 'number' && Number.isFinite(input)) return JSON.stringify(input);
  if (Array.isArray(input)) return `[${input.map(canonical).join(',')}]`;
  if (!input || typeof input !== 'object') throw new Error('invalid canonical value');
  return `{${Object.keys(input).sort().map((key) => `${JSON.stringify(key)}:${canonical(input[key])}`).join(',')}}`;
};
const { repairPlanDigest, ...body } = value;
const expected = `sha256:${createHash('sha256').update(canonical(body)).digest('hex')}`;
if (value.schema !== 'nexus.chat-shadow-route-hook-legacy-claim-repair-plan.v1'
    || value.role !== 'staging' || value.runtimeSha !== runtimeSha
    || value.artifactDigest !== artifactDigest || value.transactionId !== transactionId
    || value.toolSha256 !== toolSha256 || value.action !== 'add_effective_flags_master_kill_projection'
    || repairPlanDigest !== expected) process.exit(1);
process.stdout.write(repairPlanDigest.slice(7));
NODE
}

if [ "$COMMAND" = inspect ]; then
  TEMP_PLAN="$(mktemp "$PLAN_ROOT/.inspect.XXXXXX")"
  ssh "$SERVER" /bin/bash -s -- inspect "$RUNTIME_SHA" "$ARTIFACT_DIGEST" \
    "$TRANSACTION_ID" "$TOOL_SHA256" < "$TOOL_SNAPSHOT" > "$TEMP_PLAN"
  PLAN_DIGEST="$(validate_plan "$TEMP_PLAN")" || die 'remote inspect returned an invalid repair plan'
  install -m 600 "$TEMP_PLAN" "$PLAN_ROOT/$PLAN_DIGEST.json.next-$$"
  mv "$PLAN_ROOT/$PLAN_DIGEST.json.next-$$" "$PLAN_ROOT/$PLAN_DIGEST.json"
  cat "$TEMP_PLAN"
  exit 0
fi

LOCAL_PLAN="$PLAN_ROOT/${ACK_PLAN#sha256:}.json"
[ -f "$LOCAL_PLAN" ] && [ ! -L "$LOCAL_PLAN" ] \
  || die 'apply requires the locally retained exact inspected repair plan'
[ "$(validate_plan "$LOCAL_PLAN")" = "${ACK_PLAN#sha256:}" ] \
  || die 'local repair plan is invalid, expired, or changed'
TEMP_RECEIPT="$(mktemp "$RECEIPT_ROOT/.apply.XXXXXX")"
ssh "$SERVER" env NEXUS_RELEASE_OWNER_AUTHORIZED=1 /bin/bash -s -- apply \
  "$RUNTIME_SHA" "$ARTIFACT_DIGEST" "$TRANSACTION_ID" "$TOOL_SHA256" \
  "$ACK_PLAN" < "$TOOL_SNAPSHOT" > "$TEMP_RECEIPT"
node - "$TEMP_RECEIPT" "$RUNTIME_SHA" "$ARTIFACT_DIGEST" "$TRANSACTION_ID" \
  "$ACK_PLAN" "$TOOL_SHA256" "$LOCAL_PLAN" <<'NODE' \
  || die 'remote apply returned an invalid repair receipt'
const fs = require('node:fs');
const [file,runtimeSha,artifactDigest,transactionId,repairPlanDigest,toolSha256,
  planFile] = process.argv.slice(2);
const stat = fs.lstatSync(file);
const value = JSON.parse(fs.readFileSync(file, 'utf8'));
const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
if (!stat.isFile() || stat.isSymbolicLink()
    || value.schema !== 'nexus.chat-shadow-route-hook-legacy-claim-repair-receipt.v1'
    || value.status !== 'claim_repaired' || value.role !== 'staging'
    || value.runtimeSha !== runtimeSha || value.artifactDigest !== artifactDigest
    || value.transactionId !== transactionId || value.repairPlanDigest !== repairPlanDigest
    || value.toolSha256 !== toolSha256 || value.action !== plan.action
    || value.claimPlanDigest !== plan.claimPlanDigest
    || value.claimPrivateBeforeSha256 !== plan.claimPrivateBeforeSha256
    || value.claimPrivateAfterSha256 !== plan.claimPrivateAfterSha256) process.exit(1);
NODE
install -m 600 "$TEMP_RECEIPT" "$RECEIPT_ROOT/$TRANSACTION_ID.json.next-$$"
mv "$RECEIPT_ROOT/$TRANSACTION_ID.json.next-$$" "$RECEIPT_ROOT/$TRANSACTION_ID.json"
cat "$TEMP_RECEIPT"
