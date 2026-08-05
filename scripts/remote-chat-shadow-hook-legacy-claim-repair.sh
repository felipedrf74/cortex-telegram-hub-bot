#!/usr/bin/env bash
# One-time, hash-bound repair for the 4.14.232 shadow-hook private claim gap.
set -euo pipefail
umask 077

readonly BASE_DIR='/home/dominguez/telegram-hub-bot-staging'
readonly STATE_ROOT='/home/dominguez/.local/state/nexus-release/chat-capability-flags'
readonly USER_RELEASE_LOCK='/home/dominguez/.local/state/nexus-release/.release.lock'
readonly ROOT_SONAR_LOCK='/run/lock/nexus-release-sonar.lock'
readonly NODE_BIN='/usr/bin/node'
readonly PLAN_SCHEMA='nexus.chat-shadow-route-hook-legacy-claim-repair-plan.v1'
readonly RECEIPT_SCHEMA='nexus.chat-shadow-route-hook-legacy-claim-repair-receipt.v1'

COMMAND="${1:-}"
RUNTIME_SHA="${2:-}"
ARTIFACT_DIGEST="${3:-}"
TRANSACTION_ID="${4:-}"
TOOL_SHA256="${5:-}"
ACK_PLAN="${6:-}"

die() {
  printf 'legacy shadow-hook claim repair: %s\n' "$*" >&2
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
[[ "$RUNTIME_SHA" =~ ^[0-9a-f]{40}$ ]] || die 'runtime SHA is invalid'
[[ "$ARTIFACT_DIGEST" =~ ^[0-9a-f]{64}$ ]] || die 'artifact digest is invalid'
[[ "$TRANSACTION_ID" =~ ^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}$ ]] \
  || die 'transaction ID is invalid'
[[ "$TOOL_SHA256" =~ ^[0-9a-f]{64}$ ]] || die 'tool SHA-256 is invalid'
if [ "$COMMAND" = apply ]; then
  [ "${NEXUS_RELEASE_OWNER_AUTHORIZED:-0}" = 1 ] \
    || die 'apply requires NEXUS_RELEASE_OWNER_AUTHORIZED=1'
  [[ "$ACK_PLAN" =~ ^sha256:[0-9a-f]{64}$ ]] \
    || die 'apply requires an exact acknowledged repair plan'
else
  [ -z "$ACK_PLAN" ] || die 'inspect does not accept an acknowledged plan'
fi

[ -d "$BASE_DIR" ] && [ ! -L "$BASE_DIR" ] || die 'staging base is unsafe'
[ -d "$STATE_ROOT" ] && [ ! -L "$STATE_ROOT" ] || die 'capability state root is unsafe'
[ "$(stat -c '%U:%a' "$STATE_ROOT")" = "$(id -un):700" ] \
  || die 'capability state root owner or mode is unsafe'
[ -d "$STATE_ROOT/claims" ] && [ ! -L "$STATE_ROOT/claims" ] \
  || die 'capability claims root is unsafe'
[ "$(stat -c '%U:%a' "$STATE_ROOT/claims")" = "$(id -un):700" ] \
  || die 'capability claims root owner or mode is unsafe'
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
  && [ ! -L "$RELEASE_DIR" ] || die 'current staging release differs from the repair target'
[ -f "$RELEASE_DIR/.complete.json" ] && [ ! -L "$RELEASE_DIR/.complete.json" ] \
  || die 'current staging completion marker is unsafe'
"$NODE_BIN" - "$RELEASE_DIR/.complete.json" "$RUNTIME_SHA" "$ARTIFACT_DIGEST" <<'NODE' \
  || die 'current staging completion marker differs from the repair target'
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

BACKUP_FILE="$BASE_DIR/.env.before-chat-capability-$TRANSACTION_ID"
ENV_FILE="$BASE_DIR/.env"
CLAIM_PLAN="$STATE_ROOT/claims/staging-$TRANSACTION_ID.shadow-hook-plan.json"
CLAIM_PRIVATE="$STATE_ROOT/claims/staging-$TRANSACTION_ID.shadow-hook-private.json"
CLAIM_RECEIPT="$STATE_ROOT/claims/staging-$TRANSACTION_ID.shadow-hook-receipt.json"
EXTERNAL_RECEIPT="$STATE_ROOT/staging.json"
PERMIT_FILE="$STATE_ROOT/staging.runtime-permit.json"
PENDING_PLAN="$STATE_ROOT/staging.legacy-shadow-repair.pending.json"
REPAIR_PLAN="$STATE_ROOT/claims/staging-$TRANSACTION_ID.legacy-shadow-repair-plan.json"
REPAIR_RECEIPT="$STATE_ROOT/claims/staging-$TRANSACTION_ID.legacy-shadow-repair-receipt.json"
EXTERNAL_REPAIR_RECEIPT="$STATE_ROOT/staging.legacy-shadow-repair.json"

CAPABILITY_BACKUPS=()
shopt -s nullglob
CAPABILITY_BACKUPS=("$BASE_DIR"/.env.before-chat-capability-*)
shopt -u nullglob
[ "${#CAPABILITY_BACKUPS[@]}" -eq 1 ] && [ "${CAPABILITY_BACKUPS[0]}" = "$BACKUP_FILE" ] \
  && [ -f "${CAPABILITY_BACKUPS[0]}" ] && [ ! -L "${CAPABILITY_BACKUPS[0]}" ] \
  || die 'legacy repair requires exactly one exact transaction backup'

snapshot_plan() {
  local output="$1"
  local generated_at="$2"
  "$NODE_BIN" - "$output" "$generated_at" "$TOOL_SHA256" \
    "$RUNTIME_SHA" "$ARTIFACT_DIGEST" "$TRANSACTION_ID" "$RELEASE_DIR" \
    "$BACKUP_FILE" "$ENV_FILE" "$CLAIM_PLAN" "$CLAIM_PRIVATE" \
    "$CLAIM_RECEIPT" "$EXTERNAL_RECEIPT" "$PERMIT_FILE" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const [output,generatedAt,toolSha256,runtimeSha,artifactDigest,transactionId,
  releaseDir,backupFile,envFile,claimPlanFile,claimPrivateFile,claimReceiptFile,
  externalReceiptFile,permitFile] = process.argv.slice(2);
const governedFlags = [
  'AI_ROUTING_MANIFEST_CLASSIFIER', 'AI_ROUTING_MANIFEST_ORCHESTRATOR',
  'AI_ROUTING_MANIFEST_SHADOW', 'AI_ROUTING_MANIFEST_REGISTRY',
  'AI_ROUTING_CLARIFY', 'AI_CLASSIFY_MANIFEST_PROMPT',
  'AI_CROSS_SKILL_EXECUTION', 'AI_ROUTING_MANIFEST_KILL',
];
const exactKeys = (value, keys, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join('\n') !== [...keys].sort().join('\n')) {
    throw new Error(`${label} schema is invalid`);
  }
};
const safeFile = (file, label) => {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
      || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600) {
    throw new Error(`${label} is unsafe`);
  }
  return fs.readFileSync(file);
};
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const canonical = (value) => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (!value || typeof value !== 'object') throw new Error('canonical JSON value is invalid');
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
};
const parseTimestamp = (value, label) => {
  const parsed = Date.parse(value);
  if (typeof value !== 'string' || !Number.isFinite(parsed)
      || new Date(parsed).toISOString() !== value) throw new Error(`${label} timestamp is invalid`);
  return parsed;
};
const backupRaw = safeFile(backupFile, 'rollback backup');
const envRaw = safeFile(envFile, 'staging environment');
const claimPlanRaw = safeFile(claimPlanFile, 'shadow-hook claim plan');
const claimPrivateRaw = safeFile(claimPrivateFile, 'shadow-hook private claim');
const externalRaw = safeFile(externalReceiptFile, 'external rollback receipt');
const permitRaw = safeFile(permitFile, 'runtime permit');
if (fs.existsSync(claimReceiptFile)) throw new Error('shadow-hook claim receipt already exists');
const plan = JSON.parse(claimPlanRaw);
const privateState = JSON.parse(claimPrivateRaw);
const external = JSON.parse(externalRaw);
const permit = JSON.parse(permitRaw);
exactKeys(privateState, [
  'schema', 'planDigest', 'release', 'dedicatedTenantId',
  'environmentPrecondition', 'pm2', 'configuredFlags', 'mutation',
], 'legacy private claim');
exactKeys(privateState.configuredFlags, governedFlags, 'legacy configured flags');
for (const flag of governedFlags) {
  if (typeof privateState.configuredFlags[flag] !== 'boolean') throw new Error('legacy configured flag is invalid');
}
exactKeys(privateState.mutation, ['preimageSha256', 'mutatedSha256'], 'legacy mutation');
if (privateState.schema !== 'nexus.chat-shadow-route-hook-private.v1'
    || privateState.planDigest !== plan.planDigest
    || privateState.release !== releaseDir
    || privateState.dedicatedTenantId !== plan.dedicatedTenantId
    || plan.schema !== 'nexus.chat-shadow-route-hook-plan.v1'
    || plan.role !== 'staging' || plan.runtimeSha !== runtimeSha
    || plan.artifactDigest !== artifactDigest
    || plan.desiredValue !== true || plan.recorderBefore?.user !== false
    || plan.recorderBefore?.tenant !== false) {
  throw new Error('legacy shadow-hook claim binding is invalid');
}
const backupSha256 = sha256(backupRaw);
const environmentSha256 = sha256(envRaw);
if (backupSha256 !== environmentSha256
    || privateState.environmentPrecondition?.sha256 !== backupSha256
    || privateState.mutation.preimageSha256 !== backupSha256) {
  throw new Error('restored environment does not match the exact rollback preimage');
}
if (external.schema !== 'nexus.chat-shadow-route-hook-transaction.v1'
    || external.status !== 'rollback_failed' || external.role !== 'staging'
    || external.transactionId !== transactionId || external.runtimeSha !== runtimeSha
    || external.artifactDigest !== artifactDigest || external.planDigest !== plan.planDigest
    || external.rollback?.status !== 'rollback_failed') {
  throw new Error('external rollback-failed receipt binding is invalid');
}
if (permit.schema !== 'nexus.chat-capability-runtime-permit.v1'
    || permit.phase !== 'rollback' || permit.role !== 'staging'
    || permit.transactionId !== transactionId || permit.runtimeSha !== runtimeSha
    || permit.artifactDigest !== artifactDigest || permit.planDigest !== plan.planDigest
    || permit.environmentSha256 !== environmentSha256
    || Date.now() <= parseTimestamp(permit.expiresAt, 'permit expiry')) {
  throw new Error('expired rollback permit binding is invalid');
}
const effectiveFlags = { ...privateState.configuredFlags };
if (effectiveFlags.AI_ROUTING_MANIFEST_KILL) {
  for (const flag of governedFlags) {
    if (flag !== 'AI_ROUTING_MANIFEST_KILL') effectiveFlags[flag] = false;
  }
}
const repaired = { ...privateState, effectiveFlags };
const repairedRaw = Buffer.from(`${JSON.stringify(repaired)}\n`);
const generatedMs = parseTimestamp(generatedAt, 'generatedAt');
const body = {
  schema: 'nexus.chat-shadow-route-hook-legacy-claim-repair-plan.v1',
  role: 'staging', runtimeSha, artifactDigest, transactionId,
  claimPlanDigest: plan.planDigest,
  action: 'add_effective_flags_master_kill_projection',
  toolSha256,
  backupSha256,
  environmentSha256,
  claimPlanSha256: sha256(claimPlanRaw),
  externalReceiptSha256: sha256(externalRaw),
  permitSha256: sha256(permitRaw),
  claimPrivateBeforeSha256: sha256(claimPrivateRaw),
  claimPrivateAfterSha256: sha256(repairedRaw),
  generatedAt,
  expiresAt: new Date(generatedMs + 60 * 60_000).toISOString(),
};
const repairPlanDigest = `sha256:${sha256(canonical(body))}`;
fs.writeFileSync(output, `${JSON.stringify({ ...body, repairPlanDigest }, null, 2)}\n`, { mode: 0o600 });
NODE
}

GENERATED_AT="$($NODE_BIN -e 'process.stdout.write(new Date().toISOString())')"

if [ "$COMMAND" = inspect ]; then
  TEMP_PLAN="$(mktemp "$STATE_ROOT/.legacy-shadow-repair-plan.XXXXXX")"
  trap 'rm -f -- "${TEMP_PLAN:-}"' EXIT
  snapshot_plan "$TEMP_PLAN" "$GENERATED_AT"
  if [ -e "$PENDING_PLAN" ] || [ -L "$PENDING_PLAN" ]; then
    set +e
    EXISTING_PLAN="$($NODE_BIN - "$PENDING_PLAN" "$TEMP_PLAN" <<'NODE'
const fs = require('node:fs');
const [pendingFile, candidateFile] = process.argv.slice(2);
const stat = fs.lstatSync(pendingFile);
if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
    || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600) process.exit(1);
const pending = JSON.parse(fs.readFileSync(pendingFile, 'utf8'));
const candidate = JSON.parse(fs.readFileSync(candidateFile, 'utf8'));
if (Date.now() <= Date.parse(pending.expiresAt)) {
  const ignored = new Set(['generatedAt', 'expiresAt', 'repairPlanDigest']);
  const stable = (value) => Object.fromEntries(Object.entries(value).filter(([key]) => !ignored.has(key)));
  if (JSON.stringify(stable(pending)) !== JSON.stringify(stable(candidate))) process.exit(1);
  process.stdout.write(JSON.stringify(pending, null, 2) + '\n');
  process.exit(0);
}
process.exit(2);
NODE
    )"
    status=$?
    set -e
    if [ "$status" -eq 0 ]; then
      printf '%s\n' "$EXISTING_PLAN"
      exit 0
    fi
    [ "$status" -eq 2 ] || die 'a different unconsumed legacy repair plan already exists'
    mv "$PENDING_PLAN" "$STATE_ROOT/expired-legacy-shadow-repair-${TRANSACTION_ID}-$(date -u +%s).json"
  fi
  install -m 600 "$TEMP_PLAN" "$PENDING_PLAN.next-$$"
  mv "$PENDING_PLAN.next-$$" "$PENDING_PLAN"
  fsync_parent "$PENDING_PLAN"
  cat "$PENDING_PLAN"
  exit 0
fi

if { [ -e "$EXTERNAL_REPAIR_RECEIPT" ] || [ -L "$EXTERNAL_REPAIR_RECEIPT" ]; } \
    && [ ! -e "$REPAIR_RECEIPT" ] && [ ! -L "$REPAIR_RECEIPT" ]; then
  die 'orphan external repair receipt blocks claim mutation'
fi

if [ -e "$REPAIR_RECEIPT" ] || [ -L "$REPAIR_RECEIPT" ]; then
  "$NODE_BIN" - "$CLAIM_PRIVATE" "$REPAIR_PLAN" "$REPAIR_RECEIPT" \
    "$EXTERNAL_REPAIR_RECEIPT" "$PENDING_PLAN" "$ACK_PLAN" "$TOOL_SHA256" \
    "$RUNTIME_SHA" "$ARTIFACT_DIGEST" "$TRANSACTION_ID" <<'NODE' \
    || die 'existing repair receipt cannot complete exact idempotent publication'
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const [claimFile,planFile,receiptFile,externalReceiptFile,pendingFile,
  repairPlanDigest,toolSha256,runtimeSha,artifactDigest,transactionId] = process.argv.slice(2);
const safeFile = (file, label) => {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
      || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600) {
    throw new Error(`${label} is unsafe`);
  }
  return fs.readFileSync(file);
};
const atomicWrite = (destination, contents) => {
  const temporary = `${destination}.next-${process.pid}`;
  const descriptor = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(descriptor, contents); fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }
  fs.renameSync(temporary, destination);
  const parent = fs.openSync(path.dirname(destination), 'r');
  try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
};
const claimRaw = safeFile(claimFile, 'repaired private claim');
const planRaw = safeFile(planFile, 'committed repair plan');
const receiptRaw = safeFile(receiptFile, 'internal repair receipt');
const plan = JSON.parse(planRaw);
const receipt = JSON.parse(receiptRaw);
const claimHash = createHash('sha256').update(claimRaw).digest('hex');
if (plan.schema !== 'nexus.chat-shadow-route-hook-legacy-claim-repair-plan.v1'
    || plan.role !== 'staging' || plan.runtimeSha !== runtimeSha
    || plan.artifactDigest !== artifactDigest || plan.transactionId !== transactionId
    || plan.repairPlanDigest !== repairPlanDigest || plan.toolSha256 !== toolSha256
    || receipt.schema !== 'nexus.chat-shadow-route-hook-legacy-claim-repair-receipt.v1'
    || receipt.status !== 'claim_repaired' || receipt.role !== 'staging'
    || receipt.runtimeSha !== runtimeSha || receipt.artifactDigest !== artifactDigest
    || receipt.transactionId !== transactionId
    || receipt.repairPlanDigest !== repairPlanDigest
    || receipt.claimPlanDigest !== plan.claimPlanDigest
    || receipt.toolSha256 !== toolSha256
    || receipt.claimPrivateBeforeSha256 !== plan.claimPrivateBeforeSha256
    || receipt.claimPrivateAfterSha256 !== plan.claimPrivateAfterSha256
    || claimHash !== plan.claimPrivateAfterSha256) process.exit(1);
if (fs.existsSync(externalReceiptFile)) {
  const externalRaw = safeFile(externalReceiptFile, 'external repair receipt');
  if (!externalRaw.equals(receiptRaw)) process.exit(1);
} else {
  atomicWrite(externalReceiptFile, receiptRaw);
}
if (fs.existsSync(pendingFile) || (() => {
  try { return fs.lstatSync(pendingFile).isSymbolicLink(); } catch { return false; }
})()) {
  const pendingRaw = safeFile(pendingFile, 'pending repair plan');
  if (!pendingRaw.equals(planRaw)) process.exit(1);
  fs.unlinkSync(pendingFile);
  const parent = fs.openSync(path.dirname(pendingFile), 'r');
  try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
}
process.stdout.write(receiptRaw);
NODE
  exit 0
fi
[ -f "$PENDING_PLAN" ] && [ ! -L "$PENDING_PLAN" ] \
  || die 'apply requires the exact pending repair plan'
TEMP_CURRENT="$(mktemp "$STATE_ROOT/.legacy-shadow-repair-current.XXXXXX")"
trap 'rm -f -- "${TEMP_CURRENT:-}"' EXIT
PENDING_GENERATED_AT="$($NODE_BIN -e 'const p=require(process.argv[1]);process.stdout.write(p.generatedAt)' "$PENDING_PLAN")"
set +e
REPAIRED_GAP="$($NODE_BIN - "$PENDING_PLAN" "$REPAIR_PLAN" "$CLAIM_PRIVATE" \
  "$ACK_PLAN" "$TOOL_SHA256" <<'NODE'
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const [pendingFile,repairPlanFile,claimFile,ackPlan,toolSha256] = process.argv.slice(2);
if (!fs.existsSync(repairPlanFile)) process.exit(2);
const safePlan = (file) => {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
      || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600) process.exit(1);
  return fs.readFileSync(file, 'utf8');
};
const pendingRaw = safePlan(pendingFile);
const repairRaw = safePlan(repairPlanFile);
const plan = JSON.parse(pendingRaw);
const claimHash = createHash('sha256').update(fs.readFileSync(claimFile)).digest('hex');
if (pendingRaw !== repairRaw || plan.repairPlanDigest !== ackPlan
    || plan.toolSha256 !== toolSha256) process.exit(1);
if (claimHash === plan.claimPrivateBeforeSha256) process.stdout.write('ready');
else if (claimHash === plan.claimPrivateAfterSha256) process.stdout.write('repaired');
else process.exit(1);
NODE
)"
GAP_STATUS=$?
set -e
if [ "$GAP_STATUS" -eq 2 ]; then
  snapshot_plan "$TEMP_CURRENT" "$PENDING_GENERATED_AT"
  "$NODE_BIN" - "$PENDING_PLAN" "$TEMP_CURRENT" "$ACK_PLAN" "$TOOL_SHA256" <<'NODE' \
    || die 'pending repair plan is expired, changed, or not exactly acknowledged'
const fs = require('node:fs');
const [pendingFile,currentFile,ackPlan,toolSha256] = process.argv.slice(2);
const stat = fs.lstatSync(pendingFile);
if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
    || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600) process.exit(1);
const pendingRaw = fs.readFileSync(pendingFile, 'utf8');
const currentRaw = fs.readFileSync(currentFile, 'utf8');
const pending = JSON.parse(pendingRaw);
if (pendingRaw !== currentRaw || pending.repairPlanDigest !== ackPlan
    || pending.toolSha256 !== toolSha256 || Date.now() > Date.parse(pending.expiresAt)) process.exit(1);
NODE
  install -m 600 "$PENDING_PLAN" "$REPAIR_PLAN.next-$$"
  mv "$REPAIR_PLAN.next-$$" "$REPAIR_PLAN"
  fsync_parent "$REPAIR_PLAN"
elif [ "$GAP_STATUS" -ne 0 ]; then
  die 'repaired claim publication gap does not match the exact pending plan'
elif [ "$REPAIRED_GAP" != ready ] && [ "$REPAIRED_GAP" != repaired ]; then
  die 'repaired claim publication gap does not match the exact pending plan'
fi
"$NODE_BIN" - "$CLAIM_PRIVATE" "$REPAIR_PLAN" "$REPAIR_RECEIPT" \
  "$EXTERNAL_REPAIR_RECEIPT" "$PENDING_PLAN" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const [claimFile,planFile,receiptFile,externalReceiptFile,pendingFile] = process.argv.slice(2);
const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
const beforeRaw = fs.readFileSync(claimFile);
const beforeHash = createHash('sha256').update(beforeRaw).digest('hex');
let repairedRaw;
if (beforeHash === plan.claimPrivateBeforeSha256) {
  const state = JSON.parse(beforeRaw);
  const effectiveFlags = { ...state.configuredFlags };
  if (effectiveFlags.AI_ROUTING_MANIFEST_KILL) {
    for (const flag of Object.keys(effectiveFlags)) {
      if (flag !== 'AI_ROUTING_MANIFEST_KILL') effectiveFlags[flag] = false;
    }
  }
  repairedRaw = Buffer.from(`${JSON.stringify({ ...state, effectiveFlags })}\n`);
  if (createHash('sha256').update(repairedRaw).digest('hex') !== plan.claimPrivateAfterSha256) {
    throw new Error('repaired private claim bytes differ from the reviewed plan');
  }
  const temporary = `${claimFile}.next-${process.pid}`;
  const descriptor = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(descriptor, repairedRaw); fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }
  fs.renameSync(temporary, claimFile);
  const parent = fs.openSync(path.dirname(claimFile), 'r');
  try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
} else if (beforeHash !== plan.claimPrivateAfterSha256) {
  throw new Error('private claim changed outside the reviewed repair plan');
}
const receipt = {
  schema: 'nexus.chat-shadow-route-hook-legacy-claim-repair-receipt.v1',
  status: 'claim_repaired', role: plan.role, runtimeSha: plan.runtimeSha,
  artifactDigest: plan.artifactDigest, transactionId: plan.transactionId,
  claimPlanDigest: plan.claimPlanDigest, repairPlanDigest: plan.repairPlanDigest,
  action: plan.action, toolSha256: plan.toolSha256,
  claimPrivateBeforeSha256: plan.claimPrivateBeforeSha256,
  claimPrivateAfterSha256: plan.claimPrivateAfterSha256,
  completedAt: new Date().toISOString(),
};
const body = `${JSON.stringify(receipt, null, 2)}\n`;
for (const destination of [receiptFile, externalReceiptFile]) {
  if (fs.existsSync(destination)) {
    const stat = fs.lstatSync(destination);
    const existingRaw = fs.readFileSync(destination);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
        || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600
        || !existingRaw.equals(Buffer.from(body))) {
      throw new Error('existing repair receipt is unsafe or not byte-exact');
    }
    continue;
  }
  const temporary = `${destination}.next-${process.pid}`;
  const descriptor = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(descriptor, body); fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }
  fs.renameSync(temporary, destination);
  const parent = fs.openSync(path.dirname(destination), 'r');
  try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
}
if (fs.existsSync(pendingFile)) fs.unlinkSync(pendingFile);
process.stdout.write(body);
NODE
