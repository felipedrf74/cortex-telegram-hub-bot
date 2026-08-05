#!/usr/bin/env bash
# One-time, owner-acknowledged publication of the failed 4.14.232 observation.
set -euo pipefail
umask 077

readonly BASE_DIR='/home/dominguez/telegram-hub-bot-staging'
readonly STATE_ROOT='/home/dominguez/.local/state/nexus-release/chat-capability-flags'
readonly USER_RELEASE_LOCK='/home/dominguez/.local/state/nexus-release/.release.lock'
readonly ROOT_SONAR_LOCK='/run/lock/nexus-release-sonar.lock'
readonly NODE_BIN='/usr/bin/node'
readonly EXPECTED_RUNTIME_SHA='39965e357d19a1a44ecb167d213c6ffcf361a21b'
readonly EXPECTED_ARTIFACT_DIGEST='e368f1e15c3b2a84cfb798ad12621932a61fd766db6161259a7bd364cbac1535'
readonly EXPECTED_TRANSACTION_ID='20260805T163302Z-2522779e6416'
readonly EXPECTED_FLAG='AI_ROUTING_MANIFEST_CLASSIFIER'
readonly EXPECTED_OBSERVATION_PLAN_DIGEST='sha256:3a3076c133922d08b941d1853f12c82c7408e7265001dd433b51548c2a4c6130'
readonly PLAN_SCHEMA='nexus.chat-capability-observation-failure-recovery-plan.v1'
readonly RECEIPT_SCHEMA='nexus.chat-capability-observation-failure-recovery-receipt.v1'

COMMAND="${1:-}"
RUNTIME_SHA="${2:-}"
ARTIFACT_DIGEST="${3:-}"
TRANSACTION_ID="${4:-}"
TOOL_SHA256="${5:-}"
ACK_PLAN="${6:-}"

die() {
  printf 'legacy observation failure recovery: %s\n' "$*" >&2
  exit 1
}

fsync_parent() {
  "$NODE_BIN" - "${1:?path is required}" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const descriptor = fs.openSync(path.dirname(process.argv[2]), 'r');
try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
NODE
}

case "$COMMAND" in inspect|apply) ;; *) die 'command must be inspect or apply' ;; esac
[ "$RUNTIME_SHA" = "$EXPECTED_RUNTIME_SHA" ] || die 'runtime SHA is not the one-time recovery target'
[ "$ARTIFACT_DIGEST" = "$EXPECTED_ARTIFACT_DIGEST" ] \
  || die 'artifact digest is not the one-time recovery target'
[ "$TRANSACTION_ID" = "$EXPECTED_TRANSACTION_ID" ] \
  || die 'transaction ID is not the one-time recovery target'
[[ "$TOOL_SHA256" =~ ^[0-9a-f]{64}$ ]] || die 'tool SHA-256 is invalid'
if [ "$COMMAND" = apply ]; then
  [ "${NEXUS_RELEASE_OWNER_AUTHORIZED:-0}" = 1 ] \
    || die 'apply requires NEXUS_RELEASE_OWNER_AUTHORIZED=1'
  [[ "$ACK_PLAN" =~ ^sha256:[0-9a-f]{64}$ ]] \
    || die 'apply requires an exact acknowledged recovery plan'
else
  [ -z "$ACK_PLAN" ] || die 'inspect does not accept an acknowledged plan'
fi

[ -d "$BASE_DIR" ] && [ ! -L "$BASE_DIR" ] || die 'staging base is unsafe'
[ -d "$STATE_ROOT" ] && [ ! -L "$STATE_ROOT" ] || die 'capability state root is unsafe'
[ "$(stat -c '%U:%a' "$STATE_ROOT")" = "$(id -un):700" ] \
  || die 'capability state root owner or mode is unsafe'
[ -f "$USER_RELEASE_LOCK" ] && [ ! -L "$USER_RELEASE_LOCK" ] \
  && [ "$(stat -c '%U:%a' "$USER_RELEASE_LOCK")" = "$(id -un):600" ] \
  || die 'shared release lock is unavailable or unsafe'
exec 9<>"$USER_RELEASE_LOCK"
flock -n 9 || die 'another release, flag, or Sonar-sensitive action is active'
[ -f "$ROOT_SONAR_LOCK" ] && [ ! -L "$ROOT_SONAR_LOCK" ] \
  && [ "$(stat -c '%U:%G:%a' "$ROOT_SONAR_LOCK")" = 'root:dominguez:660' ] \
  || die 'root/Sonar mutex is unavailable or unsafe'
exec 8<>"$ROOT_SONAR_LOCK"
flock -n 8 || die 'a root maintenance or Sonar action is active'

RELEASE_DIR="$(readlink -f "$BASE_DIR/current")"
EXPECTED_RELEASE="$BASE_DIR/releases/$RUNTIME_SHA-${ARTIFACT_DIGEST:0:12}"
[ "$RELEASE_DIR" = "$EXPECTED_RELEASE" ] && [ -d "$RELEASE_DIR" ] \
  && [ ! -L "$RELEASE_DIR" ] || die 'current staging release differs from the recovery target'
[ -f "$RELEASE_DIR/.complete.json" ] && [ ! -L "$RELEASE_DIR/.complete.json" ] \
  || die 'current staging completion marker is unsafe'
"$NODE_BIN" - "$RELEASE_DIR/.complete.json" "$RUNTIME_SHA" "$ARTIFACT_DIGEST" <<'NODE' \
  || die 'current staging completion marker differs from the recovery target'
const fs = require('node:fs');
const [file, runtimeSha, artifactDigest] = process.argv.slice(2);
const value = JSON.parse(fs.readFileSync(file, 'utf8'));
if (value?.schema !== 'nexus.release-bundle.v1'
    || value.runtimeSha !== runtimeSha || value.artifactDigest !== artifactDigest) process.exit(1);
NODE
"$NODE_BIN" "$RELEASE_DIR/scripts/release-artifact-manifest.mjs" \
  --verify-installed-source "$RELEASE_DIR" \
  --expected-runtime-sha "$RUNTIME_SHA" \
  --expected-digest "$ARTIFACT_DIGEST" >/dev/null \
  || die 'current staging installed source verification failed'

OBSERVATIONS_ROOT="$STATE_ROOT/observations"
SMOKE_ROOT="$BASE_DIR/.local/release/smoke-evidence"
for directory in "$OBSERVATIONS_ROOT" "$SMOKE_ROOT"; do
  [ -d "$directory" ] && [ ! -L "$directory" ] \
    && [ "$(stat -c '%U:%a' "$directory")" = "$(id -un):700" ] \
    || die 'observation evidence root is unavailable or unsafe'
done

OBSERVATION_PLAN="$OBSERVATIONS_ROOT/staging-$TRANSACTION_ID.observation-plan.json"
OBSERVATION_RECEIPT="$OBSERVATIONS_ROOT/staging-$TRANSACTION_ID.observation-receipt.json"
RECOVERY_PLAN="$OBSERVATIONS_ROOT/staging-$TRANSACTION_ID.observation-recovery-plan.json"
RECOVERY_RECEIPT="$OBSERVATIONS_ROOT/staging-$TRANSACTION_ID.observation-recovery-receipt.json"
SMOKE_FILE="$SMOKE_ROOT/chat-capability-$TRANSACTION_ID-staging-smoke.json"
OBSERVATION_SIDECAR="$SMOKE_ROOT/chat-capability-$TRANSACTION_ID-staging-observation.json"
RECOVERY_SIDECAR="$SMOKE_ROOT/chat-capability-$TRANSACTION_ID-staging-observation-recovery.json"
OFF_RECEIPT="$STATE_ROOT/staging.json"
SEQUENCE_FILE="$STATE_ROOT/staging.observation.sequence"
ENV_FILE="$BASE_DIR/.env"
PENDING_PLAN="$STATE_ROOT/staging.observation-failure-recovery.pending.json"

snapshot_plan() {
  local output="$1"
  local generated_at="$2"
  "$NODE_BIN" - "$output" "$generated_at" "$TOOL_SHA256" \
    "$RUNTIME_SHA" "$ARTIFACT_DIGEST" "$TRANSACTION_ID" \
    "$EXPECTED_FLAG" "$EXPECTED_OBSERVATION_PLAN_DIGEST" \
    "$OBSERVATION_PLAN" "$OBSERVATION_RECEIPT" "$SMOKE_FILE" \
    "$OBSERVATION_SIDECAR" "$OFF_RECEIPT" "$SEQUENCE_FILE" "$ENV_FILE" <<'NODE'
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const [output,generatedAt,toolSha256,runtimeSha,artifactDigest,transactionId,
  expectedFlag,expectedObservationPlanDigest,observationPlanFile,observationReceiptFile,
  smokeFile,observationSidecarFile,offReceiptFile,sequenceFile,environmentFile]
  = process.argv.slice(2);
const governed = [
  'AI_ROUTING_MANIFEST_CLASSIFIER', 'AI_ROUTING_MANIFEST_ORCHESTRATOR',
  'AI_ROUTING_MANIFEST_SHADOW', 'AI_ROUTING_MANIFEST_REGISTRY',
  'AI_ROUTING_CLARIFY', 'AI_CLASSIFY_MANIFEST_PROMPT',
  'AI_CROSS_SKILL_EXECUTION', 'AI_ROUTING_MANIFEST_KILL',
  'CHAT_CORE_V2_SHADOW_ROUTE_HOOK_ENABLED', 'CHAT_CORE_V2_SHADOW_PLANNER_ENABLED',
];
const safeFile = (file, label) => {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
      || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600) {
    throw new Error(`${label} is unsafe`);
  }
  return fs.readFileSync(file);
};
const absent = (file, label) => {
  try {
    fs.lstatSync(file);
    throw new Error(`${label} already exists`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
};
const sha256 = (raw) => createHash('sha256').update(raw).digest('hex');
const canonical = (value) => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (!value || typeof value !== 'object') throw new Error('canonical JSON value is invalid');
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
};
const timestamp = (value, label) => {
  const parsed = Date.parse(value);
  if (typeof value !== 'string' || !Number.isFinite(parsed)
      || new Date(parsed).toISOString() !== value) throw new Error(`${label} is invalid`);
  return parsed;
};
const observationPlanRaw = safeFile(observationPlanFile, 'observation plan');
const smokeRaw = safeFile(smokeFile, 'observation smoke');
const offReceiptRaw = safeFile(offReceiptFile, 'staging OFF receipt');
const sequenceRaw = safeFile(sequenceFile, 'observation sequence').toString('utf8').trim();
const environmentRaw = safeFile(environmentFile, 'staging environment');
absent(observationReceiptFile, 'successful observation receipt');
absent(observationSidecarFile, 'successful observation sidecar');
const observation = JSON.parse(observationPlanRaw);
const offReceipt = JSON.parse(offReceiptRaw);
if (observation?.schema !== 'nexus.chat-capability-observation-plan.v1'
    || observation.role !== 'staging' || observation.runtimeSha !== runtimeSha
    || observation.artifactDigest !== artifactDigest || observation.flag !== expectedFlag
    || observation.planDigest !== expectedObservationPlanDigest
    || observation.observationSequence !== Number(sequenceRaw)
    || Date.now() <= timestamp(observation.expiresAt, 'observation expiry')) {
  throw new Error('expired observation plan binding is invalid');
}
if (offReceipt?.schema !== 'nexus.chat-capability-flag-transaction.v1'
    || offReceipt.status !== 'passed' || offReceipt.role !== 'staging'
    || offReceipt.runtimeSha !== runtimeSha || offReceipt.artifactDigest !== artifactDigest
    || offReceipt.flag !== expectedFlag || offReceipt.desiredValue !== false
    || timestamp(offReceipt.completedAt, 'OFF completion')
      <= timestamp(observation.generatedAt, 'observation generation')) {
  throw new Error('later exact staging OFF receipt binding is invalid');
}
const assignments = new Map();
for (const sourceLine of environmentRaw.toString('utf8').split(/\r?\n/u)) {
  const line = sourceLine.trim();
  if (!line || line.startsWith('#')) continue;
  const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u);
  if (!match) continue;
  assignments.set(match[1], match[2].trim().replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/u, '$1$2'));
}
for (const key of governed) {
  const value = assignments.get(key);
  if (value !== undefined && !['0', 'false', 'off', 'no', ''].includes(value.toLowerCase())) {
    throw new Error(`${key} must be OFF before observation failure recovery`);
  }
}
const generatedMs = timestamp(generatedAt, 'generatedAt');
const body = {
  schema: 'nexus.chat-capability-observation-failure-recovery-plan.v1',
  action: 'acknowledge_failed_observation_without_receipt',
  role: 'staging', runtimeSha, artifactDigest, transactionId,
  flag: expectedFlag,
  observationSequence: observation.observationSequence,
  observationPlanDigest: observation.planDigest,
  observationPlanSha256: sha256(observationPlanRaw),
  smokeSha256: sha256(smokeRaw),
  offReceiptTransactionId: offReceipt.transactionId,
  offReceiptSha256: sha256(offReceiptRaw),
  environmentSha256: sha256(environmentRaw),
  reasonCode: 'observation_failed_before_receipt',
  toolSha256,
  generatedAt,
  expiresAt: new Date(generatedMs + 60 * 60_000).toISOString(),
};
const recoveryPlanDigest = `sha256:${sha256(canonical(body))}`;
fs.writeFileSync(output, `${JSON.stringify({ ...body, recoveryPlanDigest }, null, 2)}\n`, {
  mode: 0o600,
});
NODE
}

validate_existing_receipt() {
  "$NODE_BIN" - "$RECOVERY_PLAN" "$RECOVERY_RECEIPT" "$RECOVERY_SIDECAR" \
    "$ACK_PLAN" "$TOOL_SHA256" <<'NODE'
const fs = require('node:fs');
const [planFile,receiptFile,sidecarFile,ack,toolSha256] = process.argv.slice(2);
const safe = (file) => {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
      || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600) process.exit(1);
  return fs.readFileSync(file);
};
const plan = JSON.parse(safe(planFile));
const receiptRaw = safe(receiptFile);
const sidecarRaw = safe(sidecarFile);
const receipt = JSON.parse(receiptRaw);
if (!receiptRaw.equals(sidecarRaw)
    || receipt.schema !== 'nexus.chat-capability-observation-failure-recovery-receipt.v1'
    || receipt.status !== 'failure_acknowledged'
    || receipt.recoveryPlanDigest !== ack || plan.recoveryPlanDigest !== ack
    || receipt.toolSha256 !== toolSha256
    || receipt.observationPlanSha256 !== plan.observationPlanSha256
    || receipt.smokeSha256 !== plan.smokeSha256
    || receipt.offReceiptSha256 !== plan.offReceiptSha256) process.exit(1);
process.stdout.write(receiptRaw);
NODE
}

if [ "$COMMAND" = apply ] && [ -e "$RECOVERY_RECEIPT" ]; then
  validate_existing_receipt || die 'existing recovery receipt is unsafe or not exact'
  exit 0
fi
[ ! -e "$RECOVERY_RECEIPT" ] && [ ! -L "$RECOVERY_RECEIPT" ] \
  && [ ! -e "$RECOVERY_SIDECAR" ] && [ ! -L "$RECOVERY_SIDECAR" ] \
  || die 'partial observation recovery publication requires exact replay'

GENERATED_AT="$($NODE_BIN -e 'process.stdout.write(new Date().toISOString())')"
if [ "$COMMAND" = inspect ]; then
  TEMP_PLAN="$(mktemp "$STATE_ROOT/.observation-recovery-plan.XXXXXX")"
  trap 'rm -f -- "${TEMP_PLAN:-}"' EXIT
  snapshot_plan "$TEMP_PLAN" "$GENERATED_AT"
  "$NODE_BIN" - "$TEMP_PLAN" "$PENDING_PLAN" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [source,pending] = process.argv.slice(2);
const raw = fs.readFileSync(source);
if (fs.existsSync(pending)) {
  const stat = fs.lstatSync(pending);
  const existing = JSON.parse(fs.readFileSync(pending, 'utf8'));
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
      || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600
      || Date.now() <= Date.parse(existing.expiresAt)) {
    throw new Error('another unexpired observation recovery plan is pending');
  }
  fs.unlinkSync(pending);
}
const temporary = `${pending}.next-${process.pid}`;
const descriptor = fs.openSync(temporary, 'wx', 0o600);
try { fs.writeFileSync(descriptor, raw); fs.fsyncSync(descriptor); }
finally { fs.closeSync(descriptor); }
fs.renameSync(temporary, pending);
const parent = fs.openSync(path.dirname(pending), 'r');
try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
process.stdout.write(raw);
NODE
  exit 0
fi

[ -f "$PENDING_PLAN" ] && [ ! -L "$PENDING_PLAN" ] \
  || die 'apply requires the exact pending recovery plan'
PENDING_GENERATED_AT="$($NODE_BIN -e 'const p=require(process.argv[1]);process.stdout.write(p.generatedAt)' "$PENDING_PLAN")"
TEMP_CURRENT="$(mktemp "$STATE_ROOT/.observation-recovery-current.XXXXXX")"
trap 'rm -f -- "${TEMP_CURRENT:-}"' EXIT
snapshot_plan "$TEMP_CURRENT" "$PENDING_GENERATED_AT"
"$NODE_BIN" - "$PENDING_PLAN" "$TEMP_CURRENT" "$ACK_PLAN" "$TOOL_SHA256" <<'NODE' \
  || die 'pending recovery plan expired, changed, or was not exactly acknowledged'
const fs = require('node:fs');
const [pendingFile,currentFile,ack,toolSha256] = process.argv.slice(2);
const stat = fs.lstatSync(pendingFile);
const pendingRaw = fs.readFileSync(pendingFile);
const currentRaw = fs.readFileSync(currentFile);
const plan = JSON.parse(pendingRaw);
if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
    || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600
    || !pendingRaw.equals(currentRaw) || plan.recoveryPlanDigest !== ack
    || plan.toolSha256 !== toolSha256 || Date.now() > Date.parse(plan.expiresAt)) process.exit(1);
NODE

if [ -e "$RECOVERY_PLAN" ]; then
  cmp -s "$PENDING_PLAN" "$RECOVERY_PLAN" \
    || die 'committed recovery plan differs from the acknowledged plan'
else
  install -m 600 "$PENDING_PLAN" "$RECOVERY_PLAN.next-$$"
  mv "$RECOVERY_PLAN.next-$$" "$RECOVERY_PLAN"
  fsync_parent "$RECOVERY_PLAN"
fi

"$NODE_BIN" - "$RECOVERY_PLAN" "$RECOVERY_RECEIPT" "$RECOVERY_SIDECAR" \
  "$PENDING_PLAN" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [planFile,receiptFile,sidecarFile,pendingFile] = process.argv.slice(2);
const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
const receipt = {
  schema: 'nexus.chat-capability-observation-failure-recovery-receipt.v1',
  status: 'failure_acknowledged',
  action: plan.action,
  role: plan.role,
  runtimeSha: plan.runtimeSha,
  artifactDigest: plan.artifactDigest,
  transactionId: plan.transactionId,
  flag: plan.flag,
  observationSequence: plan.observationSequence,
  observationPlanDigest: plan.observationPlanDigest,
  observationPlanSha256: plan.observationPlanSha256,
  smokeSha256: plan.smokeSha256,
  offReceiptTransactionId: plan.offReceiptTransactionId,
  offReceiptSha256: plan.offReceiptSha256,
  environmentSha256: plan.environmentSha256,
  reasonCode: plan.reasonCode,
  toolSha256: plan.toolSha256,
  recoveryPlanDigest: plan.recoveryPlanDigest,
  completedAt: new Date().toISOString(),
};
const raw = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
for (const destination of [receiptFile, sidecarFile]) {
  if (fs.existsSync(destination)) {
    const stat = fs.lstatSync(destination);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
        || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600
        || !fs.readFileSync(destination).equals(raw)) {
      throw new Error('existing recovery publication is unsafe or not byte-exact');
    }
    continue;
  }
  const temporary = `${destination}.next-${process.pid}`;
  const descriptor = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(descriptor, raw); fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }
  fs.renameSync(temporary, destination);
  const parent = fs.openSync(path.dirname(destination), 'r');
  try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
}
if (fs.existsSync(pendingFile)) {
  fs.unlinkSync(pendingFile);
  const parent = fs.openSync(path.dirname(pendingFile), 'r');
  try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
}
process.stdout.write(raw);
NODE
