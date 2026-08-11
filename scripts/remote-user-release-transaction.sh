#!/usr/bin/env bash
# One-shot staging or production transaction executed by `systemd-run --user`.
# It operates only on an already uploaded, checksum-verified runtime bundle.
set -euo pipefail
umask 077

COMMAND="${1:-}"
BASE_DIR="${2:-}"
SOURCE_BUNDLE="${3:-}"
RUNTIME_SHA="${4:-}"
ARTIFACT_DIGEST="${5:-}"
TRANSACTION_ID="${6:-}"
STABILITY_SECONDS="${7:-60}"
EXPECTED_PREDECESSOR_SHA="${8:-}"
EXPECTED_PREDECESSOR_DIGEST="${9:-}"

TRANSFER_ROOT=/home/dominguez/.local/share/nexus-release
STATE_ROOT=/home/dominguez/.local/state/nexus-release
LOCK_FILE="$STATE_ROOT/.release.lock"
MAINTENANCE_LOCK=/run/lock/nexus-release-sonar.lock
PM2_BIN="${NEXUS_RELEASE_PM2_BIN:-/usr/local/bin/pm2}"
NODE_BIN="${NEXUS_RELEASE_NODE_BIN:-/usr/bin/node}"
PYTHON_BIN="${NEXUS_RELEASE_PYTHON_BIN:-/usr/bin/python3.12}"
TIMEOUT_BIN="${NEXUS_RELEASE_TIMEOUT_BIN:-/usr/bin/timeout}"
SYSTEMCTL_BIN="${NEXUS_RELEASE_SYSTEMCTL_BIN:-/usr/bin/systemctl}"
SUDO_BIN=/usr/bin/sudo
STATE_VIEW_BIN=/usr/local/sbin/nexus-release-state-view
FAULT_INJECTION="${NEXUS_RELEASE_FAULT_AFTER_SWITCH:-}"
CANDIDATE_HEALTH_BUDGET_SECONDS=45
ROLLBACK_HEALTH_BUDGET_SECONDS=45
ROLLBACK_OBJECTIVE_SECONDS=120

die() {
  echo "lean release transaction: $*" >&2
  exit 1
}

assert_safe_maintenance_lock() {
  [ -f "$MAINTENANCE_LOCK" ] && [ ! -L "$MAINTENANCE_LOCK" ] \
    || die "shared maintenance mutex is missing or unsafe"
  [ "$(stat -c '%U:%G:%a' -- "$MAINTENANCE_LOCK")" = 'root:dominguez:660' ] \
    || die "shared maintenance mutex owner or mode is unsafe"
}

assert_lock_fd_matches_path() {
  local descriptor="$1"
  local lock_path="$2"
  [ "$(stat -Lc '%d:%i' -- "/proc/$$/fd/$descriptor")" \
      = "$(stat -Lc '%d:%i' -- "$lock_path")" ] \
    || die "shared maintenance mutex changed identity while it was acquired"
}

assert_pm2_fallback_not_retired() {
  local canonical_guard=/etc/systemd/system.control/pm2-dominguez.service
  local retirement_status state_view
  [ -x "$SUDO_BIN" ] && [ -x "$STATE_VIEW_BIN" ] \
    || die "privileged release state view is unavailable"
  if ! state_view="$("$SUDO_BIN" -n "$STATE_VIEW_BIN")"; then
    die "cannot obtain the privileged release state view"
  fi
  retirement_status="$(
    printf '%s' "$state_view" | "$NODE_BIN" -e '
const chunks = [];
let size = 0;
process.stdin.on("data", (chunk) => {
  size += chunk.length;
  if (size > 262144) process.exit(1);
  chunks.push(chunk);
});
process.stdin.on("end", () => {
  try {
    const view = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const expected = [
      "active", "activeReceipt", "authoritative", "blocked", "capturedAt",
      "effective", "generated", "generatedAt", "lastRecovery", "note",
      "pm2FallbackRetired", "pm2FallbackRetirementInProgress", "predecessor",
      "recent", "schema", "sourceSchemas",
    ].sort();
    const keys = Object.keys(view).sort();
    const sourceKeys = Object.keys(view.sourceSchemas ?? {}).sort();
    if (JSON.stringify(keys) !== JSON.stringify(expected)
        || JSON.stringify(sourceKeys) !== JSON.stringify(["receipt", "state"])
        || view.schema !== "nexus.release-state-view.v2"
        || view.generated !== true
        || view.authoritative !== false
        || view.sourceSchemas.state !== "nexus.release-host-state.v1"
        || view.sourceSchemas.receipt !== "nexus.release-receipt.v3"
        || typeof view.pm2FallbackRetirementInProgress !== "boolean"
        || typeof view.pm2FallbackRetired !== "boolean") {
      process.exit(1);
    }
    process.stdout.write(
      view.pm2FallbackRetirementInProgress || view.pm2FallbackRetired
        ? "blocked"
        : "clear",
    );
  } catch {
    process.exit(1);
  }
});
'
  )" || die "privileged release state view contract is invalid"
  [ "$retirement_status" = clear ] \
    || die "PM2 fallback retirement journal or tombstone exists"
  if [ -L "$canonical_guard" ] \
      && [ "$(readlink -- "$canonical_guard")" = /dev/null ]; then
    die "PM2 fallback is barred by its persistent retirement guard"
  fi
  [ -x "$SYSTEMCTL_BIN" ] || die "systemctl is required for PM2 fallback authority proof"
  [ "$($SYSTEMCTL_BIN show pm2-dominguez.service --property=LoadState --value)" = loaded ] \
    && [ "$($SYSTEMCTL_BIN show pm2-dominguez.service --property=FragmentPath --value)" \
      = /etc/systemd/system/pm2-dominguez.service ] \
    && [ "$($SYSTEMCTL_BIN show pm2-dominguez.service --property=CanStart --value)" = yes ] \
    && [ "$($SYSTEMCTL_BIN show pm2-dominguez.service --property=ActiveState --value)" = active ] \
    || die "canonical PM2 fallback authority is not exact and active"
}

assert_no_unresolved_chat_capability_transaction() {
  local capability_base="$1"
  local marker
  marker="$(
    find "$capability_base" -mindepth 1 -maxdepth 1 \
      -name '.env.before-chat-capability-*' -print -quit
  )" || die "cannot inspect chat capability transaction state"
  [ -z "$marker" ] \
    || die "unresolved chat capability transaction blocks release; recover it first"
}

assert_no_unpublished_chat_capability_receipt() {
  local receipt_role="$1"
  local capability_root="$STATE_ROOT/chat-capability-flags"
  local claims_root="$capability_root/claims"
  [ -e "$capability_root" ] || return 0
  [ -d "$capability_root" ] && [ ! -L "$capability_root" ] \
    || die "chat capability state root is unsafe"
  [ "$(stat -c '%U:%a' "$capability_root")" = "$(id -un):700" ] \
    || die "chat capability state root owner or mode is unsafe"
  [ -e "$claims_root" ] || return 0
  [ -d "$claims_root" ] && [ ! -L "$claims_root" ] \
    || die "chat capability claims root is unsafe"
  [ "$(stat -c '%U:%a' "$claims_root")" = "$(id -un):700" ] \
    || die "chat capability claims root owner or mode is unsafe"

  local receipts=()
  shopt -s nullglob
  receipts=(
    "$claims_root/$receipt_role-"*.flag-receipt.json
    "$claims_root/$receipt_role-"*.secret-receipt.json
    "$claims_root/$receipt_role-"*.shadow-hook-receipt.json
  )
  shopt -u nullglob
  [ "${#receipts[@]}" -gt 0 ] || return 0

  local result
  result="$($NODE_BIN - "$receipt_role" "$capability_root/$receipt_role.json" "${receipts[@]}" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [role, externalFile, ...files] = process.argv.slice(2);
const ids = /^\d{8}T\d{6}Z-[0-9a-f]{12}$/u;
const sha = /^[0-9a-f]{40}$/u;
const digest = /^[0-9a-f]{64}$/u;
const timestamp = (value, label) => {
  const parsed = Date.parse(value);
  if (typeof value !== 'string' || !Number.isFinite(parsed)
      || new Date(parsed).toISOString() !== value) throw new Error(`${label} timestamp is invalid`);
  return parsed;
};
const safePrivateFile = (file) => {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
      || stat.uid !== process.getuid()
      || (stat.mode & 0o777) !== 0o600) throw new Error('capability receipt path is unsafe');
};
const claims = files.map((file) => {
  safePrivateFile(file);
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  const kind = file.endsWith('.flag-receipt.json')
    ? 'flag'
    : file.endsWith('.secret-receipt.json')
      ? 'secret'
      : file.endsWith('.shadow-hook-receipt.json')
        ? 'shadow-hook'
        : null;
  const schema = kind === 'flag'
    ? 'nexus.chat-capability-flag-transaction.v1'
    : kind === 'secret'
      ? 'nexus.chat-capability-secret-transaction.v1'
      : kind === 'shadow-hook'
        ? 'nexus.chat-shadow-route-hook-transaction.v1'
        : null;
  if (value?.schema !== schema || value.status !== 'passed' || value.role !== role
      || !ids.test(value.transactionId ?? '') || !sha.test(value.runtimeSha ?? '')
      || !digest.test(value.artifactDigest ?? '')
      || path.basename(file) !== `${role}-${value.transactionId}.${kind}-receipt.json`) {
    throw new Error('capability claim receipt binding is invalid');
  }
  return { transactionId: value.transactionId, completedAt: timestamp(value.completedAt, 'claim') };
}).sort((left, right) => right.completedAt - left.completedAt);
if (claims.length > 1 && claims[0].completedAt === claims[1].completedAt
    && claims[0].transactionId !== claims[1].transactionId) {
  throw new Error('latest capability claim receipt is ambiguous');
}
if (!fs.existsSync(externalFile)) {
  process.stdout.write('unpublished');
  process.exit(0);
}
safePrivateFile(externalFile);
const external = JSON.parse(fs.readFileSync(externalFile, 'utf8'));
if (external?.role !== role || !ids.test(external.transactionId ?? '')) {
  throw new Error('external capability receipt binding is invalid');
}
const externalCompletedAt = timestamp(external.completedAt, 'external');
if (externalCompletedAt === claims[0].completedAt
    && external.transactionId !== claims[0].transactionId) {
  throw new Error('latest capability receipt ordering is ambiguous');
}
process.stdout.write(externalCompletedAt < claims[0].completedAt ? 'unpublished' : 'clear');
NODE
)" || die "cannot inspect committed chat capability receipts"
  case "$result" in
    clear) ;;
    unpublished) die "unpublished chat capability receipt blocks release; recover it first" ;;
    *) die "committed chat capability receipt state is invalid" ;;
  esac
}

assert_no_unpublished_staging_chat_capability_observation() {
  local capability_root="$STATE_ROOT/chat-capability-flags"
  local observations_root="$capability_root/observations"
  local sequence_file="$capability_root/staging.observation.sequence"
  local smoke_root=/home/dominguez/telegram-hub-bot-staging/.local/release/smoke-evidence

  if [ ! -e "$observations_root" ] && [ ! -L "$observations_root" ]; then
    if [ -e "$sequence_file" ] || [ -L "$sequence_file" ]; then
      die "unpublished staging chat capability observation blocks release; recover it first"
    fi
    return 0
  fi
  [ -d "$observations_root" ] && [ ! -L "$observations_root" ] \
    || die "staging chat capability observation root is unsafe"
  [ "$(stat -c '%U:%a' "$observations_root")" = "$(id -un):700" ] \
    || die "staging chat capability observation root owner or mode is unsafe"

  local observation_plans=()
  local observation_receipts=()
  local observation_recovery_receipts=()
  shopt -s nullglob
  observation_plans=("$observations_root"/staging-*.observation-plan.json)
  observation_receipts=("$observations_root"/staging-*.observation-receipt.json)
  observation_recovery_receipts=(
    "$observations_root"/staging-*.observation-recovery-receipt.json
  )
  shopt -u nullglob
  if [ "${#observation_plans[@]}" -eq 0 ] \
      && [ "${#observation_receipts[@]}" -eq 0 ] \
      && [ "${#observation_recovery_receipts[@]}" -eq 0 ] \
      && [ ! -e "$sequence_file" ] && [ ! -L "$sequence_file" ]; then
    return 0
  fi

  local result
  result="$($NODE_BIN - "$sequence_file" "$smoke_root" \
    "${#observation_plans[@]}" "${#observation_receipts[@]}" \
    "${observation_plans[@]}" "${observation_receipts[@]}" \
    "${observation_recovery_receipts[@]}" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const [sequenceFile, smokeRoot, planCountRaw, receiptCountRaw, ...files] = process.argv.slice(2);
const planCount = Number(planCountRaw);
const receiptCount = Number(receiptCountRaw);
if (!Number.isSafeInteger(planCount) || planCount < 0 || planCount > files.length
    || !Number.isSafeInteger(receiptCount) || receiptCount < 0
    || planCount + receiptCount > files.length) {
  throw new Error('staging observation inventory is invalid');
}
const planFiles = files.slice(0, planCount);
const receiptFiles = files.slice(planCount, planCount + receiptCount);
const recoveryReceiptFiles = files.slice(planCount + receiptCount);
const ids = /^\d{8}T\d{6}Z-[0-9a-f]{12}$/u;
const sha = /^[0-9a-f]{40}$/u;
const digest = /^[0-9a-f]{64}$/u;
const planDigest = /^sha256:[0-9a-f]{64}$/u;
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const canonical = (value) => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (!value || typeof value !== 'object') throw new Error('canonical JSON value is invalid');
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
};
const safePrivateFile = (file, label) => {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
      || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600) {
    throw new Error(`${label} is unsafe`);
  }
  return fs.readFileSync(file, 'utf8');
};
const unpublished = () => {
  process.stdout.write('unpublished');
  process.exit(0);
};
if (!fs.existsSync(sequenceFile) || planFiles.length === 0) unpublished();
const sequenceRaw = safePrivateFile(sequenceFile, 'staging observation sequence').trim();
if (!/^[1-9][0-9]*$/u.test(sequenceRaw)) {
  throw new Error('staging observation sequence is invalid');
}
const sequence = Number(sequenceRaw);
if (!Number.isSafeInteger(sequence)) {
  throw new Error('staging observation sequence is outside the safe range');
}

const plans = new Map();
const sequences = new Set();
for (const file of planFiles) {
  const match = path.basename(file).match(
    /^staging-(\d{8}T\d{6}Z-[0-9a-f]{12})\.observation-plan\.json$/u,
  );
  if (!match) throw new Error('staging observation plan filename is invalid');
  const transactionId = match[1];
  const value = JSON.parse(safePrivateFile(file, 'staging observation plan'));
  if (value?.schema !== 'nexus.chat-capability-observation-plan.v1'
      || value.role !== 'staging' || !sha.test(value.runtimeSha ?? '')
      || !digest.test(value.artifactDigest ?? '')
      || !planDigest.test(value.planDigest ?? '')
      || !Number.isSafeInteger(value.observationSequence)
      || value.observationSequence < 1
      || value.previousObservationSequence !== value.observationSequence - 1
      || sequences.has(value.observationSequence)) {
    throw new Error('staging observation plan binding is invalid');
  }
  sequences.add(value.observationSequence);
  plans.set(transactionId, value);
}
if (Math.max(...sequences) !== sequence) unpublished();

let smokeRootReady = true;
for (const directory of [path.dirname(path.dirname(smokeRoot)), path.dirname(smokeRoot), smokeRoot]) {
  if (!fs.existsSync(directory)) {
    smokeRootReady = false;
    break;
  }
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()
      || (stat.mode & 0o777) !== 0o700) {
    throw new Error('staging observation evidence root is unsafe');
  }
}

const published = new Set();
let publicationIncomplete = false;
for (const file of receiptFiles) {
  const match = path.basename(file).match(
    /^staging-(\d{8}T\d{6}Z-[0-9a-f]{12})\.observation-receipt\.json$/u,
  );
  if (!match) throw new Error('staging observation receipt filename is invalid');
  const transactionId = match[1];
  const raw = safePrivateFile(file, 'staging observation receipt');
  const value = JSON.parse(raw);
  const plan = plans.get(transactionId);
  if (!plan || value?.schema !== 'nexus.chat-capability-observation-receipt.v1'
      || value.status !== 'passed' || value.role !== 'staging'
      || value.transactionId !== transactionId || !ids.test(value.transactionId ?? '')
      || value.runtimeSha !== plan.runtimeSha
      || value.artifactDigest !== plan.artifactDigest
      || value.observationSequence !== plan.observationSequence
      || value.planDigest !== plan.planDigest
      || JSON.stringify(value.plan) !== JSON.stringify(plan)) {
    throw new Error('staging observation receipt binding is invalid');
  }
  const sidecar = path.join(
    smokeRoot,
    `chat-capability-${transactionId}-staging-observation.json`,
  );
  if (!smokeRootReady || !fs.existsSync(sidecar)) {
    publicationIncomplete = true;
  } else if (safePrivateFile(sidecar, 'staging observation sidecar') !== raw) {
    throw new Error('staging observation receipt and sidecar bytes differ');
  }
  published.add(transactionId);
}
for (const file of recoveryReceiptFiles) {
  const match = path.basename(file).match(
    /^staging-(\d{8}T\d{6}Z-[0-9a-f]{12})\.observation-recovery-receipt\.json$/u,
  );
  if (!match) throw new Error('staging observation recovery receipt filename is invalid');
  const transactionId = match[1];
  const raw = safePrivateFile(file, 'staging observation recovery receipt');
  const value = JSON.parse(raw);
  const plan = plans.get(transactionId);
  const planFile = planFiles.find((candidate) => path.basename(candidate)
    === `staging-${transactionId}.observation-plan.json`);
  const recoveryPlanFile = path.join(
    path.dirname(planFile ?? ''),
    `staging-${transactionId}.observation-recovery-plan.json`,
  );
  const recoveryPlanRaw = fs.existsSync(recoveryPlanFile)
    ? safePrivateFile(recoveryPlanFile, 'staging observation recovery plan')
    : '';
  const recoveryPlan = recoveryPlanRaw ? JSON.parse(recoveryPlanRaw) : null;
  const { recoveryPlanDigest: recordedRecoveryPlanDigest, ...recoveryPlanBody }
    = recoveryPlan ?? {};
  const computedRecoveryPlanDigest = recoveryPlan
    ? `sha256:${sha256(canonical(recoveryPlanBody))}`
    : null;
  if (!plan || !planFile || published.has(transactionId) || !recoveryPlan
      || recoveryPlan.schema
        !== 'nexus.chat-capability-observation-failure-recovery-plan.v1'
      || recoveryPlan.action !== 'acknowledge_failed_observation_without_receipt'
      || recoveryPlan.role !== 'staging'
      || recoveryPlan.runtimeSha !== plan.runtimeSha
      || recoveryPlan.artifactDigest !== plan.artifactDigest
      || recoveryPlan.transactionId !== transactionId
      || recoveryPlan.flag !== plan.flag
      || recoveryPlan.observationSequence !== plan.observationSequence
      || recoveryPlan.observationPlanDigest !== plan.planDigest
      || recoveryPlan.reasonCode !== 'observation_failed_before_receipt'
      || recordedRecoveryPlanDigest !== computedRecoveryPlanDigest
      || value?.schema
        !== 'nexus.chat-capability-observation-failure-recovery-receipt.v1'
      || value.status !== 'failure_acknowledged'
      || value.action !== 'acknowledge_failed_observation_without_receipt'
      || value.reasonCode !== 'observation_failed_before_receipt'
      || value.role !== 'staging' || value.transactionId !== transactionId
      || !ids.test(value.transactionId ?? '')
      || value.runtimeSha !== plan.runtimeSha
      || value.artifactDigest !== plan.artifactDigest
      || value.flag !== plan.flag
      || value.observationSequence !== plan.observationSequence
      || value.observationPlanDigest !== plan.planDigest
      || value.observationPlanSha256
        !== sha256(safePrivateFile(planFile, 'recovered staging observation plan'))
      || !digest.test(value.smokeSha256 ?? '')
      || !digest.test(value.offReceiptSha256 ?? '')
      || !digest.test(value.environmentSha256 ?? '')
      || !digest.test(value.toolSha256 ?? '')
      || !planDigest.test(value.recoveryPlanDigest ?? '')
      || value.recoveryPlanDigest !== recoveryPlan.recoveryPlanDigest
      || value.toolSha256 !== recoveryPlan.toolSha256
      || value.observationPlanSha256 !== recoveryPlan.observationPlanSha256
      || value.smokeSha256 !== recoveryPlan.smokeSha256
      || value.offReceiptSha256 !== recoveryPlan.offReceiptSha256
      || value.environmentSha256 !== recoveryPlan.environmentSha256
      || !Number.isFinite(Date.parse(value.completedAt ?? ''))
      || new Date(Date.parse(value.completedAt)).toISOString() !== value.completedAt
      || !Number.isFinite(Date.parse(recoveryPlan.generatedAt ?? ''))
      || new Date(Date.parse(recoveryPlan.generatedAt)).toISOString()
        !== recoveryPlan.generatedAt
      || Date.parse(value.completedAt) < Date.parse(recoveryPlan.generatedAt ?? '')) {
    throw new Error('staging observation recovery receipt binding is invalid');
  }
  const smoke = path.join(
    smokeRoot,
    `chat-capability-${transactionId}-staging-smoke.json`,
  );
  const sidecar = path.join(
    smokeRoot,
    `chat-capability-${transactionId}-staging-observation-recovery.json`,
  );
  if (!smokeRootReady || !fs.existsSync(smoke) || !fs.existsSync(sidecar)) {
    publicationIncomplete = true;
  } else if (sha256(safePrivateFile(smoke, 'recovered staging observation smoke'))
      !== value.smokeSha256) {
    throw new Error('staging observation recovery smoke binding is invalid');
  } else if (safePrivateFile(sidecar, 'staging observation recovery sidecar') !== raw) {
    throw new Error('staging observation recovery receipt and sidecar bytes differ');
  }
  published.add(transactionId);
}
for (const transactionId of plans.keys()) {
  if (!published.has(transactionId)) publicationIncomplete = true;
}
process.stdout.write(publicationIncomplete ? 'unpublished' : 'clear');
NODE
)" || die "cannot inspect staging chat capability observation publication"
  case "$result" in
    clear) ;;
    unpublished)
      die "unpublished staging chat capability observation blocks release; recover it first"
      ;;
    *) die "staging chat capability observation publication state is invalid" ;;
  esac
}

assert_release_candidate_chat_capabilities_off() {
  local environment_file="$1"
  [ -f "$environment_file" ] && [ ! -L "$environment_file" ] \
    || die "release environment must be a regular non-symbolic file"
  [ "$(stat -c '%U:%a' "$environment_file")" = "$(id -un):600" ] \
    || die "release environment owner or mode is unsafe"
  "$NODE_BIN" - "$environment_file" <<'NODE'
const fs = require('node:fs');
const environmentFile = process.argv[2];
const capabilityFlags = [
  'AI_ROUTING_MANIFEST_CLASSIFIER',
  'AI_ROUTING_MANIFEST_ORCHESTRATOR',
  'AI_ROUTING_MANIFEST_SHADOW',
  'AI_ROUTING_MANIFEST_REGISTRY',
  'AI_ROUTING_CLARIFY',
  'AI_CLASSIFY_MANIFEST_PROMPT',
  'AI_CROSS_SKILL_EXECUTION',
];
const masterKill = 'AI_ROUTING_MANIFEST_KILL';
const shadowRuntimePolicies = [
  'CHAT_CORE_V2_SHADOW_ROUTE_HOOK_ENABLED',
  'CHAT_CORE_V2_SHADOW_PLANNER_ENABLED',
];
const stat = fs.lstatSync(environmentFile);
if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
  throw new Error('release environment is not a single-link ordinary file');
}
const lines = fs.readFileSync(environmentFile, 'utf8').split(/\r?\n/u);
const escapedKeys = [...capabilityFlags, masterKill]
  .map((key) => key.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'))
  .join('|');
const governedAssignment = new RegExp(
  `^\\s*(?:export[ \\t]+)?(${escapedKeys})[ \\t]*=`,
  'u',
);
const assignmentsByKey = new Map(
  [...capabilityFlags, masterKill].map((key) => [key, []]),
);
for (const line of lines) {
  const candidate = line.match(governedAssignment);
  if (candidate) assignmentsByKey.get(candidate[1]).push(line);
}
for (const key of [...capabilityFlags, masterKill]) {
  const assignments = assignmentsByKey.get(key);
  if (assignments.length === 0) continue;
  if (assignments.length !== 1) {
    throw new Error(`release environment has duplicate ${key} assignments`);
  }
  if (key === masterKill) {
    if (!new RegExp(`^${key}=(?:true|false)$`, 'u').test(assignments[0])) {
      throw new Error(`release environment requires canonical ${key}=true or ${key}=false`);
    }
  } else if (assignments[0] !== `${key}=false`) {
    throw new Error(`release candidate requires omitted ${key} or canonical ${key}=false`);
  }
}

const escapedShadowPolicies = shadowRuntimePolicies
  .map((key) => key.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'))
  .join('|');
const shadowAssignment = new RegExp(
  `^\\s*(?:export[ \\t]+)?((?:${escapedShadowPolicies})(?:_(?:USER|TENANT)_[A-Za-z0-9_-]+)?)[ \\t]*=(.*)$`,
  'u',
);
const enabledShadowValues = new Set(['true', 'on', '1', 'shadow']);
const disabledShadowValues = new Set(['false', 'off', '0']);
const normalizeDotenvValue = (raw) => {
  const trimmed = raw.trim();
  const quoted = trimmed.match(/^(["'`])([\s\S]*)\1(?:[ \\t]*#.*)?$/u);
  if (quoted) return quoted[2].trim().toLowerCase();
  return trimmed.replace(/#.*$/u, '').trim().toLowerCase();
};
const seenShadowAssignments = new Set();
for (const line of lines) {
  const assignment = line.match(shadowAssignment);
  if (!assignment) continue;
  const key = assignment[1];
  if (seenShadowAssignments.has(key)) {
    throw new Error(`release environment has duplicate ${key} assignments`);
  }
  seenShadowAssignments.add(key);
  const normalized = normalizeDotenvValue(assignment[2]);
  if (enabledShadowValues.has(normalized)) {
    throw new Error(`release candidate requires ${key} effectively off`);
  }
  if (!disabledShadowValues.has(normalized)) {
    throw new Error(`release environment has non-canonical ${key} value`);
  }
}
NODE
}

# There is no rollback-safe bootstrap transaction. Staging and production must
# both enter this script with a verified predecessor. Refuse the retired opt-in
# before command dispatch, host probes, selector changes, or PM2 operations so a
# stale owner environment cannot revive the removed first-install path.
case "${NEXUS_RELEASE_ALLOW_FIRST_INSTALL:-0}" in
  0) ;;
  *) die "first install is unsupported; stage against a verified predecessor" ;;
esac

case "$COMMAND" in
  stage)
    ROLE=staging
    EXPECTED_BASE=/home/dominguez/telegram-hub-bot-staging
    APP_NAMES=(nexus-hub-staging content-engine-staging)
    BACKEND_PORT=8201
    CONTENT_PORT=8101
    RETAIN_RELEASES=3
    ;;
  promote)
    ROLE=production
    EXPECTED_BASE=/home/dominguez/telegram-hub-bot
    APP_NAMES=(nexus-hub content-engine)
    BACKEND_PORT=8200
    CONTENT_PORT=8100
    RETAIN_RELEASES=5
    ;;
  *)
    die "usage: remote-user-release-transaction.sh <stage|promote> <base> <bundle> <sha> <digest> <transaction-id> [stability-seconds] <expected-predecessor-sha> <expected-predecessor-digest>"
    ;;
esac

[ "$BASE_DIR" = "$EXPECTED_BASE" ] || die "unexpected $ROLE base directory"
[[ "$SOURCE_BUNDLE" == "$TRANSFER_ROOT"/incoming/* ]] || die "source bundle is outside the incoming store"
[[ "$RUNTIME_SHA" =~ ^[0-9a-f]{40}$ ]] || die "runtime SHA is invalid"
[[ "$ARTIFACT_DIGEST" =~ ^[0-9a-f]{64}$ ]] || die "artifact digest is invalid"
[[ "$TRANSACTION_ID" =~ ^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}$ ]] || die "transaction ID is invalid"
[[ "$STABILITY_SECONDS" =~ ^[0-9]+$ ]] || die "stability seconds is invalid"
[ "$STABILITY_SECONDS" -ge 1 ] && [ "$STABILITY_SECONDS" -le 300 ] \
  || die "stability seconds must be between 1 and 300"
[ "$ROLE" != production ] || [ "$STABILITY_SECONDS" -ge 60 ] \
  || die "production stability seconds must be at least 60"
[[ "$EXPECTED_PREDECESSOR_SHA" =~ ^[0-9a-f]{40}$ ]] \
  || die "expected $ROLE predecessor SHA is invalid"
[[ "$EXPECTED_PREDECESSOR_DIGEST" =~ ^[0-9a-f]{64}$ ]] \
  || die "expected $ROLE predecessor digest is invalid"
case "$FAULT_INJECTION" in
  "") ;;
  staging-health)
    [ "$ROLE" = staging ] || die "fault injection is staging-only"
    ;;
  *) die "unsupported release fault injection" ;;
esac
[ -x "$PM2_BIN" ] || die "PM2 is unavailable at $PM2_BIN"
[ -x "$NODE_BIN" ] || die "Node is unavailable at $NODE_BIN"
[ -x "$PYTHON_BIN" ] || die "Python is unavailable at $PYTHON_BIN"
[ -x "$TIMEOUT_BIN" ] || die "timeout is unavailable at $TIMEOUT_BIN"
[ -d "$SOURCE_BUNDLE" ] && [ ! -L "$SOURCE_BUNDLE" ] || die "source bundle is unavailable"

RELEASE_NAME="${RUNTIME_SHA}-${ARTIFACT_DIGEST:0:12}"
RELEASE_DIR="$BASE_DIR/releases/$RELEASE_NAME"
STATE_FILE="$STATE_ROOT/$ROLE.json"
CURRENT_LINK="$BASE_DIR/current"
PREDECESSOR=""
PREDECESSOR_SHA=""
PREDECESSOR_DIGEST=""
PHASE=starting
ROLLBACK_ARMED=false
MUTATED=false
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)"
COMPLETED_AT=""
HEALTH_RESULT=pending
ROLLBACK_RESULT=""
ROLLBACK_DURATION_MS=""
ARTIFACT_PARITY=pending
MIGRATION_STARTUP=pending
AUTHENTICATED_SMOKE=pending
DATABASE_INTEGRITY=pending
PRE_PROMOTION_BACKUP="$([ "$ROLE" = production ] && printf pending || printf skipped)"
ROLLBACK_READINESS=pending
SOAK_STARTED_AT=""
SOAK_COMPLETED_AT=""
CANDIDATE_REMOVED=false

[ -d "$BASE_DIR" ] && [ ! -L "$BASE_DIR" ] \
  || die "$ROLE base directory is missing or symbolic"
install -d -m 700 "$STATE_ROOT"
for persistent_directory in "$BASE_DIR/releases" "$BASE_DIR/data" "$BASE_DIR/logs"; do
  if [ -e "$persistent_directory" ] || [ -L "$persistent_directory" ]; then
    [ -d "$persistent_directory" ] && [ ! -L "$persistent_directory" ] \
      || die "$ROLE persistent directory is unsafe: $persistent_directory"
  else
    install -d -m 700 "$persistent_directory"
  fi
done
touch "$LOCK_FILE"
chmod 600 "$LOCK_FILE"
exec 9<>"$LOCK_FILE"
flock -n 9 || die "another staging or production release action is active"
assert_safe_maintenance_lock
exec 8<>"$MAINTENANCE_LOCK"
assert_safe_maintenance_lock
assert_lock_fd_matches_path 8 "$MAINTENANCE_LOCK"
flock -n 8 || die "another root maintenance or container release action is active"
assert_safe_maintenance_lock
assert_lock_fd_matches_path 8 "$MAINTENANCE_LOCK"
assert_pm2_fallback_not_retired

# The chat capability operator holds the same user release lock while it
# mutates .env. A surviving preimage means that transaction was interrupted;
# changing the selected release would invalidate its exact-runtime recovery.
assert_no_unresolved_chat_capability_transaction "$BASE_DIR"
assert_no_unpublished_chat_capability_receipt "$ROLE"
if [ "$ROLE" = staging ]; then
  assert_no_unpublished_staging_chat_capability_observation
fi
assert_release_candidate_chat_capabilities_off "$BASE_DIR/.env"
if [ "$ROLE" = production ]; then
  assert_no_unresolved_chat_capability_transaction /home/dominguez/telegram-hub-bot-staging
  assert_no_unpublished_chat_capability_receipt staging
  assert_no_unpublished_staging_chat_capability_observation
  assert_release_candidate_chat_capabilities_off /home/dominguez/telegram-hub-bot-staging/.env
fi

write_state() {
  local phase="$1"
  local status="$2"
  local message="${3:-}"
  "$NODE_BIN" - "$STATE_FILE" "$ROLE" "$TRANSACTION_ID" "$RUNTIME_SHA" \
    "$ARTIFACT_DIGEST" "$RELEASE_DIR" "$PREDECESSOR" "$PREDECESSOR_SHA" \
    "$PREDECESSOR_DIGEST" "$phase" "$status" "$message" \
    "$STARTED_AT" "$COMPLETED_AT" "$HEALTH_RESULT" "$ROLLBACK_RESULT" \
    "$ROLLBACK_DURATION_MS" "$ARTIFACT_PARITY" "$MIGRATION_STARTUP" \
    "$AUTHENTICATED_SMOKE" "$DATABASE_INTEGRITY" "$ROLLBACK_READINESS" \
    "$PRE_PROMOTION_BACKUP" \
    "$STABILITY_SECONDS" "$SOAK_STARTED_AT" "$SOAK_COMPLETED_AT" \
    "$CANDIDATE_HEALTH_BUDGET_SECONDS" "$ROLLBACK_HEALTH_BUDGET_SECONDS" \
    "$ROLLBACK_OBJECTIVE_SECONDS" "$FAULT_INJECTION" "$CANDIDATE_REMOVED" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [
 file,role,id,runtimeSha,artifactDigest,releaseDir,predecessor,predecessorSha,
 predecessorDigest,phase,status,message,
 startedAt,completedAt,healthResult,rollbackResult,rollbackDurationMs,
 artifactParity,migrationStartup,authenticatedSmoke,databaseIntegrity,rollbackReadiness,
 prePromotionBackup,
 stabilitySeconds,soakStartedAt,soakCompletedAt,candidateHealthBudgetSeconds,
 rollbackHealthBudgetSeconds,rollbackObjectiveSeconds,faultInjection,candidateRemoved,
]=process.argv.slice(2);
const body = Buffer.from(`${JSON.stringify({
  schema:'nexus.lean-release-transaction.v1',
  role,transactionId:id,runtimeSha,artifactDigest,releaseDir,
  predecessor:predecessor||null,
  predecessorSha:predecessorSha||null,
  predecessorDigest:predecessorDigest||null,
  phase,status,message:message||null,
  startedAt,completedAt:completedAt||null,
  healthResult,
  rollbackResult:rollbackResult||null,
  rollbackDurationMs:rollbackDurationMs?Number(rollbackDurationMs):null,
  stabilitySeconds:Number(stabilitySeconds),
  soakStartedAt:soakStartedAt||null,
  soakCompletedAt:soakCompletedAt||null,
  candidateHealthBudgetSeconds:Number(candidateHealthBudgetSeconds),
  rollbackHealthBudgetSeconds:Number(rollbackHealthBudgetSeconds),
  rollbackObjectiveSeconds:Number(rollbackObjectiveSeconds),
  faultInjection:faultInjection||null,
  candidateRemoved:candidateRemoved==='true',
  checks:{
    artifactParity,migrationStartup,authenticatedSmoke,databaseIntegrity,
    prePromotionBackup,rollbackReadiness,
  },
  updatedAt:new Date().toISOString(),
},null,2)}\n`);
const temporary = `${file}.next-${process.pid}`;
const descriptor = fs.openSync(temporary,'wx',0o600);
try { fs.writeFileSync(descriptor,body); fs.fsyncSync(descriptor); }
finally { fs.closeSync(descriptor); }
fs.renameSync(temporary,file);
const parent = fs.openSync(path.dirname(file),'r');
try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
NODE
}

verify_pristine_bundle() {
  "$NODE_BIN" "$SOURCE_BUNDLE/scripts/release-artifact-manifest.mjs" \
    --verify-bundle "$SOURCE_BUNDLE" \
    --expected-runtime-sha "$RUNTIME_SHA" \
    --expected-digest "$ARTIFACT_DIGEST" >/dev/null
}

read_installed_release_identity() {
  local runtime="$1"
  "$NODE_BIN" - "$runtime/.complete.json" "$(basename "$runtime")" <<'NODE'
const fs=require('node:fs');
const [markerPath,directoryName]=process.argv.slice(2);
const stat=fs.lstatSync(markerPath);
const marker=JSON.parse(fs.readFileSync(markerPath,'utf8'));
if(!stat.isFile()||stat.isSymbolicLink()
  ||marker?.schema!=='nexus.release-bundle.v1'
  ||!/^[0-9a-f]{40}$/.test(marker.runtimeSha||'')
  ||!/^[0-9a-f]{64}$/.test(marker.artifactDigest||'')
  ||directoryName!==`${marker.runtimeSha}-${marker.artifactDigest.slice(0,12)}`){
  process.exit(1);
}
process.stdout.write(`${marker.runtimeSha} ${marker.artifactDigest}\n`);
NODE
}

verify_installed_runtime() {
  local runtime="$1"
  local sha="$2"
  local digest="$3"
  local verified_sha verified_digest
  [ -d "$runtime" ] && [ ! -L "$runtime" ] \
    && [ -f "$runtime/ecosystem.release.config.js" ] \
    && [ ! -L "$runtime/ecosystem.release.config.js" ] \
    || return 1
  if [ -e "$runtime/.nexus-installed-runtime.json" ] \
      || [ -L "$runtime/.nexus-installed-runtime.json" ] \
      || [ -e "$runtime/scripts/release-installed-tree-attestation.mjs" ] \
      || [ -L "$runtime/scripts/release-installed-tree-attestation.mjs" ]; then
    [ -f "$runtime/.nexus-installed-runtime.json" ] \
      && [ ! -L "$runtime/.nexus-installed-runtime.json" ] \
      && [ -f "$runtime/scripts/release-installed-tree-attestation.mjs" ] \
      && [ ! -L "$runtime/scripts/release-installed-tree-attestation.mjs" ] \
      || return 1
    "$NODE_BIN" "$SOURCE_BUNDLE/scripts/release-artifact-manifest.mjs" \
      --verify-installed-source "$runtime" \
      --expected-runtime-sha "$sha" \
      --expected-digest "$digest" \
      --require-declared-file scripts/release-installed-tree-attestation.mjs \
      >/dev/null || return 1
    "$NODE_BIN" "$runtime/scripts/release-installed-tree-attestation.mjs" validate \
      --root "$runtime" --runtime-sha "$sha" --artifact-digest "$digest" \
      >/dev/null || return 1
  else
    "$NODE_BIN" "$SOURCE_BUNDLE/scripts/release-artifact-manifest.mjs" \
      --verify-installed-source "$runtime" \
      --expected-runtime-sha "$sha" \
      --expected-digest "$digest" >/dev/null || return 1
    "$NODE_BIN" "$SOURCE_BUNDLE/scripts/release-runtime-dependencies.mjs" \
      verify-predecessor-extracted --root "$runtime" --python-bin "$PYTHON_BIN" \
      >/dev/null || return 1
  fi
  read -r verified_sha verified_digest < <(
    read_installed_release_identity "$runtime"
  )
  [ "$verified_sha" = "$sha" ] && [ "$verified_digest" = "$digest" ]
}

pm2_env() {
  "$TIMEOUT_BIN" --foreground 30s env -i \
    "HOME=$HOME" \
    "USER=$(id -un)" \
    "LOGNAME=$(id -un)" \
    "PATH=/usr/local/bin:/usr/bin:/bin" \
    "PM2_HOME=$HOME/.pm2" \
    "NEXUS_RELEASE_DIR=$1" \
    "NEXUS_RELEASE_BASE_DIR=$BASE_DIR" \
    "NEXUS_RELEASE_ROLE=$ROLE" \
    "NEXUS_RELEASE_SHA=$2" \
    "NEXUS_RELEASE_ARTIFACT_SHA256=$3" \
    "GIT_COMMIT=$2" \
    "$PM2_BIN" "${@:4}"
}

start_runtime() {
  local runtime="$1"
  local sha="$2"
  local digest="$3"
  local app_csv
  [ -f "$runtime/ecosystem.release.config.js" ] \
    && [ ! -L "$runtime/ecosystem.release.config.js" ] \
    || die "runtime ecosystem configuration is missing or unsafe"
  app_csv="$(IFS=,; echo "${APP_NAMES[*]}")"
  # PM2 reload commands can update environment variables while retaining the
  # prior process working directory and executable path. Recreate only the
  # selected apps so candidate activation and rollback both execute the exact
  # runtime whose SHA and artifact digest are recorded in PM2.
  pm2_env "$runtime" "$sha" "$digest" delete "${APP_NAMES[@]}" \
    >/dev/null 2>&1 || true
  pm2_env "$runtime" "$sha" "$digest" start \
    "$runtime/ecosystem.release.config.js" --only "$app_csv"
  "$TIMEOUT_BIN" --foreground 10s "$PM2_BIN" save --force >/dev/null
}

health_once() {
  local runtime="${1:-$RELEASE_DIR}"
  local sha="${2:-$RUNTIME_SHA}"
  local digest="${3:-$ARTIFACT_DIGEST}"
  local digest_mode="${4:-strict}"
  local pm2_snapshot
  case "$digest_mode" in strict|allow-missing) ;; *) return 1 ;; esac
  curl --fail --silent --show-error --max-time 5 \
    "http://127.0.0.1:$BACKEND_PORT/health" >/dev/null || return 1
  curl --fail --silent --show-error --max-time 5 \
    "http://127.0.0.1:$CONTENT_PORT/health" >/dev/null || return 1
  pm2_snapshot="$(mktemp)"
  if ! "$TIMEOUT_BIN" --foreground 10s "$PM2_BIN" jlist >"$pm2_snapshot"; then
    rm -f "$pm2_snapshot"
    return 1
  fi
  if ! "$NODE_BIN" - "$pm2_snapshot" "$runtime" "$sha" "$digest" "$digest_mode" \
      "$(IFS=,; echo "${APP_NAMES[*]}")" <<'NODE'
const fs=require('node:fs');
const [snapshot,runtime,sha,digest,digestMode,names]=process.argv.slice(2);
const rows=JSON.parse(fs.readFileSync(snapshot,'utf8'));
for(const name of names.split(',')){
 const row=rows.find((entry)=>entry?.name===name);
 const observedDigest=row?.pm2_env?.NEXUS_RELEASE_ARTIFACT_SHA256;
 if(row?.pm2_env?.status!=='online'
   ||(row.pm2_env.NEXUS_RELEASE_SHA??row.pm2_env.GIT_COMMIT)!==sha
   ||(digestMode==='strict'
     ? observedDigest!==digest
     : observedDigest!==undefined&&observedDigest!==digest)
   ||!(row.pm2_env.pm_cwd===runtime||row.pm2_env.pm_cwd===`${runtime}/content-engine`)){
  process.exit(1);
 }
}
NODE
  then
    rm -f "$pm2_snapshot"
    return 1
  fi
  rm -f "$pm2_snapshot"
}

wait_healthy() {
  local runtime="${1:-$RELEASE_DIR}"
  local sha="${2:-$RUNTIME_SHA}"
  local digest="${3:-$ARTIFACT_DIGEST}"
  local budget_seconds="${4:-45}"
  local digest_mode="${5:-strict}"
  local deadline=$((SECONDS + budget_seconds))
  until health_once "$runtime" "$sha" "$digest" "$digest_mode"; do
    [ "$SECONDS" -lt "$deadline" ] || return 1
    sleep 2
  done
}

authenticated_runtime_smoke() {
  local header_file snapshot auth_mode token header_name expected_version
  expected_version="$(
    "$NODE_BIN" - "$RELEASE_DIR/.complete.json" "$RUNTIME_SHA" \
      "$ARTIFACT_DIGEST" <<'NODE'
const fs=require('node:fs');
const [markerPath,expectedSha,expectedDigest]=process.argv.slice(2);
const marker=JSON.parse(fs.readFileSync(markerPath,'utf8'));
if(marker?.schema!=='nexus.release-bundle.v1'
  ||marker.runtimeSha!==expectedSha
  ||marker.artifactDigest!==expectedDigest
  ||typeof marker.packageVersion!=='string'
  ||marker.packageVersion.length===0){
  process.exit(1);
}
process.stdout.write(marker.packageVersion);
NODE
  )" || return 1
  [ "$(readlink -f "$CURRENT_LINK")" = "$RELEASE_DIR" ] || return 1
  auth_mode="$(grep -E '^PORTAL_REQUIRE_SESSION_AUTH=' "$BASE_DIR/.env" \
    | tail -n 1 | cut -d= -f2- || true)"
  if [ "$auth_mode" = true ]; then
    token="$(
      cd "$RELEASE_DIR"
      # The user systemd transaction runs with a deliberately minimal
      # environment. Let Node parse the base environment for this one
      # subprocess instead of shell-sourcing a secret-bearing file.
      "$NODE_BIN" --env-file="$BASE_DIR/.env" \
        dist/tools/portal-session-token.js \
        --actor "$ROLE-release-smoke@nexushub.me" \
        --scope admin \
        --ttl-ms 300000 \
        --json \
        | "$NODE_BIN" -e '
let body="";process.stdin.on("data",chunk=>body+=chunk);process.stdin.on("end",()=>{
 const value=JSON.parse(body).token;
 if(typeof value!=="string"||value.length<16)process.exit(1);
 process.stdout.write(value);
});'
    )"
    header_name=x-portal-session
  else
    token="$(grep -E '^PORTAL_TOKEN=' "$BASE_DIR/.env" | tail -n 1 | cut -d= -f2- || true)"
    [ -n "$token" ] || return 1
    header_name=Authorization
    token="Bearer $token"
  fi
  header_file="$(mktemp)"
  chmod 600 "$header_file"
  printf '%s: %s\n' "$header_name" "$token" > "$header_file"
  if ! snapshot="$(curl --fail --silent --show-error --max-time 10 \
    -H @"$header_file" "http://127.0.0.1:$BACKEND_PORT/api/snapshot")"; then
    rm -f "$header_file"
    return 1
  fi
  rm -f "$header_file"
  [ "$(readlink -f "$CURRENT_LINK")" = "$RELEASE_DIR" ] || return 1
  printf '%s' "$snapshot" | "$NODE_BIN" -e '
let body="";process.stdin.on("data",chunk=>body+=chunk);process.stdin.on("end",()=>{
 const value=JSON.parse(body);
 if(value.version!==process.argv[1]
   ||typeof value.uptime!=="object"
   ||!Number.isFinite(value.uptime.seconds))process.exit(1);
});' "$expected_version"
  [ "$(readlink -f "$CURRENT_LINK")" = "$RELEASE_DIR" ] || return 1
}

readonly_database_integrity() {
  [ -f "$BASE_DIR/data/bot.db" ] && [ ! -L "$BASE_DIR/data/bot.db" ] || return 1
  NODE_PATH="$RELEASE_DIR/node_modules" "$NODE_BIN" - "$BASE_DIR/data/bot.db" <<'NODE'
const Database=require('better-sqlite3');
const database=new Database(process.argv[2],{readonly:true,fileMustExist:true});
try{
 const integrity=database.pragma('integrity_check');
 const foreignKeys=database.pragma('foreign_key_check');
 if(integrity.length!==1
   ||integrity[0]?.integrity_check!=='ok'
   ||foreignKeys.length!==0)process.exit(1);
}finally{database.close();}
NODE
}

soak_healthy() {
  local runtime="${1:-$RELEASE_DIR}"
  local sha="${2:-$RUNTIME_SHA}"
  local digest="${3:-$ARTIFACT_DIGEST}"
  local deadline=$((SECONDS + STABILITY_SECONDS))
  while [ "$SECONDS" -lt "$deadline" ]; do
    health_once "$runtime" "$sha" "$digest" || return 1
    sleep 5
  done
  health_once "$runtime" "$sha" "$digest"
}

switch_current() {
  local target="$1"
  local temporary="$BASE_DIR/.current-$TRANSACTION_ID"
  ln -s "$target" "$temporary"
  mv -Tf "$temporary" "$CURRENT_LINK"
}

restore_predecessor() {
  [ "$MUTATED" = true ] || return 0
  [ -n "$PREDECESSOR" ] && [ -d "$PREDECESSOR" ] || return 1
  local predecessor_sha predecessor_digest
  read -r predecessor_sha predecessor_digest < <(
    "$NODE_BIN" -e '
const x=require(process.argv[1]);
process.stdout.write(`${x.runtimeSha||""} ${x.artifactDigest||""}\n`);
' "$PREDECESSOR/.complete.json"
  )
  [[ "$predecessor_sha" =~ ^[0-9a-f]{40}$ ]] || return 1
  [[ "$predecessor_digest" =~ ^[0-9a-f]{64}$ ]] || return 1
  local rollback_deadline=$(( $(date +%s) + ROLLBACK_OBJECTIVE_SECONDS ))
  switch_current "$PREDECESSOR"
  start_runtime "$PREDECESSOR" "$predecessor_sha" "$predecessor_digest"
  [ "$(date +%s)" -le "$rollback_deadline" ] || return 1
  wait_healthy "$PREDECESSOR" "$predecessor_sha" "$predecessor_digest" \
    "$ROLLBACK_HEALTH_BUDGET_SECONDS" allow-missing
  [ "$(date +%s)" -le "$rollback_deadline" ]
}

on_exit() {
  local status=$?
  local rollback_started_ms rollback_finished_ms
  trap - EXIT
  if [ -n "${TEMP_RELEASE:-}" ] && [ -d "$TEMP_RELEASE" ] \
      && [[ "$TEMP_RELEASE" == "$BASE_DIR"/releases/.*.preparing-* ]]; then
    rm -rf -- "$TEMP_RELEASE"
  fi
  if [ "$status" -ne 0 ] && [ "$ROLLBACK_ARMED" = true ]; then
    PHASE=rollback
    HEALTH_RESULT=failed
    ROLLBACK_RESULT=running
    write_state "$PHASE" running "candidate failed; restoring predecessor"
    rollback_started_ms="$(date +%s%3N)"
    if restore_predecessor; then
      rollback_finished_ms="$(date +%s%3N)"
      ROLLBACK_DURATION_MS=$((rollback_finished_ms - rollback_started_ms))
      if [ "$ROLLBACK_DURATION_MS" -le $((ROLLBACK_OBJECTIVE_SECONDS * 1000)) ]; then
        ROLLBACK_RESULT=restored
        if [ "$ROLE" = staging ] && [ "$FAULT_INJECTION" = staging-health ] \
            && [ "$(readlink -f "$CURRENT_LINK")" = "$PREDECESSOR" ] \
            && [[ "$RELEASE_DIR" == "$BASE_DIR"/releases/* ]]; then
          rm -rf -- "$RELEASE_DIR"
          CANDIDATE_REMOVED=true
        fi
        COMPLETED_AT="$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)"
        write_state rolled_back failed "candidate failed and predecessor was restored"
      else
        ROLLBACK_RESULT=failed
        COMPLETED_AT="$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)"
        write_state rollback_failed failed "predecessor recovered after the rollback deadline"
      fi
    else
      rollback_finished_ms="$(date +%s%3N)"
      ROLLBACK_DURATION_MS=$((rollback_finished_ms - rollback_started_ms))
      ROLLBACK_RESULT=failed
      COMPLETED_AT="$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)"
      write_state rollback_failed failed "candidate and automatic predecessor recovery failed"
    fi
  elif [ "$status" -ne 0 ]; then
    COMPLETED_AT="$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)"
    write_state "$PHASE" failed "transaction stopped before runtime mutation"
  fi
  exit "$status"
}
trap on_exit EXIT

verify_pristine_bundle
PHASE=preparing
write_state "$PHASE" running

if [ -L "$CURRENT_LINK" ]; then
  PREDECESSOR="$(readlink -f "$CURRENT_LINK")"
  case "$PREDECESSOR" in "$BASE_DIR"/releases/*) ;; *) die "current $ROLE selector is unsafe" ;; esac
fi
[ -n "$PREDECESSOR" ] || die "$ROLE predecessor is unavailable"
read -r PREDECESSOR_SHA PREDECESSOR_DIGEST < <(
  read_installed_release_identity "$PREDECESSOR"
) || die "$ROLE predecessor marker identity is not rollback-ready"
[ "$PREDECESSOR_SHA" = "$EXPECTED_PREDECESSOR_SHA" ] \
  || die "observed $ROLE predecessor SHA does not match protected release state"
[ "$PREDECESSOR_DIGEST" = "$EXPECTED_PREDECESSOR_DIGEST" ] \
  || die "observed $ROLE predecessor digest does not match protected release state"
verify_installed_runtime "$PREDECESSOR" "$PREDECESSOR_SHA" "$PREDECESSOR_DIGEST" \
  || die "$ROLE predecessor artifact or dependency identity is not rollback-ready"
# The first predecessor may be the exact pre-lean release, whose PM2
# environment predates the digest variable. Its installed bytes and dependency
# receipt are verified above; reject a wrong digest but bridge one absent value.
health_once "$PREDECESSOR" "$PREDECESSOR_SHA" "$PREDECESSOR_DIGEST" allow-missing \
  || die "$ROLE predecessor health or PM2 identity is not rollback-ready"
ROLLBACK_READINESS=passed

if [ -e "$RELEASE_DIR" ] || [ -L "$RELEASE_DIR" ]; then
  die "exact $ROLE release directory already exists"
fi
TEMP_RELEASE="$BASE_DIR/releases/.${RELEASE_NAME}.preparing-$TRANSACTION_ID"
[ ! -e "$TEMP_RELEASE" ] && [ ! -L "$TEMP_RELEASE" ] || die "temporary release directory already exists"
mkdir "$TEMP_RELEASE"
cp -a "$SOURCE_BUNDLE/." "$TEMP_RELEASE/"
"$NODE_BIN" "$TEMP_RELEASE/scripts/release-artifact-manifest.mjs" \
  --verify-bundle "$TEMP_RELEASE" \
  --expected-runtime-sha "$RUNTIME_SHA" \
  --expected-digest "$ARTIFACT_DIGEST" >/dev/null
ARTIFACT_PARITY=passed

ln -s "$BASE_DIR/.env" "$TEMP_RELEASE/.env"
ln -s "$BASE_DIR/data" "$TEMP_RELEASE/data"
ln -s "$BASE_DIR/logs" "$TEMP_RELEASE/logs"
(
  cd "$TEMP_RELEASE"
  "$NODE_BIN" scripts/release-runtime-dependencies.mjs extract-runtime \
    --root "$TEMP_RELEASE" --python-bin "$PYTHON_BIN"
  "$NODE_BIN" scripts/release-runtime-dependencies.mjs verify-extracted \
    --root "$TEMP_RELEASE" --python-bin "$PYTHON_BIN"
)
mv "$TEMP_RELEASE" "$RELEASE_DIR"
TEMP_RELEASE=
PHASE=prepared
write_state "$PHASE" running

if [ "$ROLE" = production ]; then
  [ -f "$BASE_DIR/data/bot.db" ] || die "production database is unavailable"
  # Backup data and encryption keys stay inside the narrow root-owned backup
  # service. This exact sudo command is the only privileged operation in the
  # user-owned release transaction; failure aborts before PM2 or `current`.
  sudo -n /usr/bin/systemctl start nexus-local-backup-pre-promotion.service \
    || die "root-owned pre-promotion backup did not complete"
  PRE_PROMOTION_BACKUP=passed
fi

PHASE=switching
write_state "$PHASE" running
ROLLBACK_ARMED=true
switch_current "$RELEASE_DIR"
MUTATED=true
start_runtime "$RELEASE_DIR" "$RUNTIME_SHA" "$ARTIFACT_DIGEST"
if [ "$FAULT_INJECTION" = staging-health ]; then
  die "explicit staging fault drill after runtime switch"
fi
PHASE=health
write_state "$PHASE" running
wait_healthy "$RELEASE_DIR" "$RUNTIME_SHA" "$ARTIFACT_DIGEST" \
  "$CANDIDATE_HEALTH_BUDGET_SECONDS"
HEALTH_RESULT=passed
MIGRATION_STARTUP=passed
authenticated_runtime_smoke
AUTHENTICATED_SMOKE=passed
readonly_database_integrity
DATABASE_INTEGRITY=passed
PHASE=soak
SOAK_STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)"
write_state "$PHASE" running
soak_healthy "$RELEASE_DIR" "$RUNTIME_SHA" "$ARTIFACT_DIGEST"
SOAK_COMPLETED_AT="$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)"

ROLLBACK_ARMED=false
ROLLBACK_RESULT=not_required
COMPLETED_AT="$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)"
PHASE=completed
write_state "$PHASE" passed

# Pruning is deliberately after availability. Keep the active target even if
# an unexpected directory name sorts into the retention window. Once the
# passing journal is durable, housekeeping must never rewrite customer-ready
# state as a failed release.
trap - EXIT
PRUNE_STATUS=passed
old_releases=()
if ! mapfile -t old_releases < <(
  find "$BASE_DIR/releases" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' \
    | sort -nr \
    | awk -v keep="$RETAIN_RELEASES" \
      '$2 ~ /\/[0-9a-f]{40}-[0-9a-f]{12}$/ {seen++; if(seen>keep){sub(/^[^ ]+ /,""); print}}'
); then
  PRUNE_STATUS=warning
  old_releases=()
  echo "lean release transaction: post-availability release inventory pruning was skipped" >&2
fi
CURRENT_TARGET="$(readlink -f "$CURRENT_LINK")"
for old_release in "${old_releases[@]}"; do
  if [ "$old_release" = "$RELEASE_DIR" ] \
      || [ "$old_release" = "$PREDECESSOR" ] \
      || [ "$old_release" = "$CURRENT_TARGET" ]; then
    continue
  fi
  if ! "$NODE_BIN" - "$old_release/.complete.json" "$(basename "$old_release")" <<'NODE'
const fs=require('node:fs');
const [markerPath,name]=process.argv.slice(2);
const stat=fs.lstatSync(markerPath);
const marker=JSON.parse(fs.readFileSync(markerPath,'utf8'));
if(!stat.isFile()||stat.isSymbolicLink()
  ||marker?.schema!=='nexus.release-bundle.v1'
  ||`${marker.runtimeSha}-${String(marker.artifactDigest||'').slice(0,12)}`!==name){
  process.exit(1);
}
NODE
  then
    PRUNE_STATUS=warning
    echo "lean release transaction: skipped untrusted old release $old_release" >&2
    continue
  fi
  if ! rm -rf -- "$old_release"; then
    PRUNE_STATUS=warning
    echo "lean release transaction: could not prune old release $old_release" >&2
  fi
done

printf '{"ok":true,"role":"%s","runtimeSha":"%s","artifactDigest":"%s","transactionId":"%s","pruneStatus":"%s"}\n' \
  "$ROLE" "$RUNTIME_SHA" "$ARTIFACT_DIGEST" "$TRANSACTION_ID" "$PRUNE_STATUS"
