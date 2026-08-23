#!/usr/bin/env bash
# Production-side, exact-release routing-calibration evidence export.
set -euo pipefail
umask 077

readonly BASE_DIR="$HOME/telegram-hub-bot"
readonly DEPLOY_HOME="$HOME"
readonly STATE_ROOT="$HOME/.local/state/nexus-release/routing-calibration-export"
readonly USER_RELEASE_LOCK="$HOME/.local/state/nexus-release/.release.lock"
readonly ROOT_SONAR_LOCK='/run/lock/nexus-release-sonar.lock'
readonly NODE_BIN='/usr/bin/node'
readonly PYTHON_BIN='/usr/bin/python3'
readonly PM2_BIN='/usr/local/bin/pm2'
readonly TIMEOUT_BIN='/usr/bin/timeout'
readonly SHA256_BIN='/usr/bin/sha256sum'
readonly BACKEND_PORT=8200
readonly CONTENT_PORT=8100

COMMAND="${1:-}"
RUNTIME_SHA="${2:-}"
ARTIFACT_DIGEST="${3:-}"
TRANSACTION_ID="${4:-}"
ACK_PLAN="${5:-}"
EMIT_KIND="${5:-}"

RELEASE_DIR=''
HELPER=''
PRIVATE_DIR_TOOL=''
ENV_FILE=''
DATABASE_PATH=''
PLAN_ROOT=''
CLAIM_ROOT=''
EXPORT_ROOT=''
RECEIPT_ROOT=''
PENDING_PLAN=''
CLAIM_PLAN=''
EXPORT_EVIDENCE=''
PARTIAL_EXPORT=''
FINAL_EXPORT=''
PARTIAL_RECEIPT=''
FINAL_RECEIPT=''
SEQUENCE_FILE=''
TEMP_FILES=()
ATTEMPT_ACTIVE=false
TRANSACTION_STARTED_AT=''

die() {
  printf 'routing calibration export transaction: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  local exit_status=$?
  local file
  trap - EXIT
  set +e
  if [ "$exit_status" -ne 0 ] && [ "$ATTEMPT_ACTIVE" = true ] \
      && [ -n "$HELPER" ] && [ -f "$PENDING_PLAN" ] \
      && [ ! -e "$FINAL_RECEIPT" ] && [ ! -L "$FINAL_RECEIPT" ]; then
    local failed_temp
    local failed_plan="$PENDING_PLAN"
    if [ -f "$CLAIM_PLAN" ] && [ ! -L "$CLAIM_PLAN" ]; then
      failed_plan="$CLAIM_PLAN"
    fi
    failed_temp="$(mktemp "$STATE_ROOT/.routing-export-failed-receipt.XXXXXX")"
    TEMP_FILES+=("$failed_temp")
    local evidence_args=()
    if [ -f "$EXPORT_EVIDENCE" ] && [ ! -L "$EXPORT_EVIDENCE" ]; then
      evidence_args=(--evidence-file="$EXPORT_EVIDENCE")
    fi
    if run_helper 1 partial-receipt --plan-file="$failed_plan" \
        "${evidence_args[@]}" --status=failed \
        --started-at="$TRANSACTION_STARTED_AT" > "$failed_temp"; then
      replace_private_file "$failed_temp" "$PARTIAL_RECEIPT" >/dev/null 2>&1
    fi
  fi
  for file in "${TEMP_FILES[@]:-}"; do
    [ -n "$file" ] && rm -f -- "$file"
  done
  exit "$exit_status"
}
trap cleanup EXIT

case "$COMMAND" in inspect|apply|emit) ;; *) die 'command must be inspect, apply, or emit' ;; esac
[[ "$RUNTIME_SHA" =~ ^[a-f0-9]{40}$ ]] || die 'runtime SHA is invalid'
[[ "$ARTIFACT_DIGEST" =~ ^[a-f0-9]{64}$ ]] || die 'artifact digest is invalid'
[[ "$TRANSACTION_ID" =~ ^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}$ ]] \
  || die 'transaction ID is invalid'
if [ "$COMMAND" = apply ]; then
  [ "${NEXUS_RELEASE_OWNER_AUTHORIZED:-0}" = 1 ] \
    || die 'apply requires NEXUS_RELEASE_OWNER_AUTHORIZED=1'
  [[ "$ACK_PLAN" =~ ^sha256:[a-f0-9]{64}$ ]] \
    || die 'apply requires an exact acknowledged plan'
elif [ "$COMMAND" = inspect ]; then
  [ -z "$ACK_PLAN" ] || die 'inspect does not accept an acknowledged plan'
else
  case "$EMIT_KIND" in receipt|evidence|sqlite|partial) ;;
    *) die 'emit kind must be receipt, evidence, sqlite, or partial' ;;
  esac
fi

assert_safe_lock_file() {
  local lock_path="$1"
  local expected_identity="$2"
  [ -f "$lock_path" ] && [ ! -L "$lock_path" ] \
    && [ "$(stat -c '%h' -- "$lock_path")" = 1 ] \
    && [ "$(stat -c '%U:%G:%a' -- "$lock_path")" = "$expected_identity" ] \
    || die "shared lock is missing or unsafe: $lock_path"
}

assert_lock_fd_matches_path() {
  local descriptor="$1"
  local lock_path="$2"
  local path_identity descriptor_identity
  path_identity="$(stat -Lc '%d:%i' -- "$lock_path")" \
    || die "cannot identify shared lock path: $lock_path"
  descriptor_identity="$(stat -Lc '%d:%i' -- "/proc/$$/fd/$descriptor")" \
    || die "cannot identify shared lock descriptor: $lock_path"
  [ "$path_identity" = "$descriptor_identity" ] \
    || die "shared lock changed while it was opened: $lock_path"
}

acquire_shared_locks() {
  # All release/Sonar-sensitive operations use this order to avoid deadlock.
  assert_safe_lock_file "$USER_RELEASE_LOCK" 'dominguez:dominguez:600'
  exec 9<>"$USER_RELEASE_LOCK"
  assert_safe_lock_file "$USER_RELEASE_LOCK" 'dominguez:dominguez:600'
  assert_lock_fd_matches_path 9 "$USER_RELEASE_LOCK"
  flock -n 9 || die 'another release, flag, or Sonar-sensitive action is active'
  assert_lock_fd_matches_path 9 "$USER_RELEASE_LOCK"

  assert_safe_lock_file "$ROOT_SONAR_LOCK" 'root:dominguez:660'
  exec 8<>"$ROOT_SONAR_LOCK"
  assert_safe_lock_file "$ROOT_SONAR_LOCK" 'root:dominguez:660'
  assert_lock_fd_matches_path 8 "$ROOT_SONAR_LOCK"
  flock -n 8 || die 'a root maintenance or Sonar action is active'
  assert_lock_fd_matches_path 8 "$ROOT_SONAR_LOCK"
}

revalidate_shared_locks() {
  assert_safe_lock_file "$USER_RELEASE_LOCK" 'dominguez:dominguez:600'
  assert_lock_fd_matches_path 9 "$USER_RELEASE_LOCK"
  flock -n 9 || die 'shared release lock was lost during export'
  assert_safe_lock_file "$ROOT_SONAR_LOCK" 'root:dominguez:660'
  assert_lock_fd_matches_path 8 "$ROOT_SONAR_LOCK"
  flock -n 8 || die 'shared root/Sonar lock was lost during export'
}

assert_owner_controlled_directory() {
  local directory="$1"
  local expected_mode="${2:-}"
  "$NODE_BIN" - "$directory" "$expected_mode" <<'NODE' \
    || die "owner-controlled directory contract failed: $directory"
const fs = require('node:fs');
const path = require('node:path');
const [directory, expectedMode] = process.argv.slice(2);
const absolute = path.resolve(directory);
let cursor = path.parse(absolute).root;
for (const component of absolute.slice(cursor.length).split(path.sep).filter(Boolean)) {
  cursor = path.join(cursor, component);
  if (fs.lstatSync(cursor).isSymbolicLink()) process.exit(1);
}
const stat = fs.lstatSync(absolute);
const mode = (stat.mode & 0o777).toString(8);
if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()
    || (stat.mode & 0o022) !== 0 || (expectedMode && mode !== expectedMode)) {
  process.exit(1);
}
NODE
}

assert_owner_single_link_file() {
  local filename="$1"
  local expected_mode="${2:-}"
  "$NODE_BIN" - "$filename" "$expected_mode" <<'NODE' \
    || die "owner-controlled file contract failed: $filename"
const fs = require('node:fs');
const path = require('node:path');
const [filename, expectedMode] = process.argv.slice(2);
const absolute = path.resolve(filename);
let cursor = path.parse(absolute).root;
for (const component of absolute.slice(cursor.length).split(path.sep).filter(Boolean)) {
  cursor = path.join(cursor, component);
  if (fs.lstatSync(cursor).isSymbolicLink()) process.exit(1);
}
const stat = fs.lstatSync(absolute);
const mode = (stat.mode & 0o777).toString(8);
if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
    || stat.uid !== process.getuid()
    || (stat.mode & 0o022) !== 0 || (expectedMode && mode !== expectedMode)) {
  process.exit(1);
}
NODE
}

resolve_exact_release() {
  local releases_real current_real expected_release
  assert_owner_controlled_directory "$DEPLOY_HOME"
  assert_owner_controlled_directory "$BASE_DIR" 755
  assert_owner_controlled_directory "$BASE_DIR/releases" 700
  assert_owner_controlled_directory "$BASE_DIR/data" 700
  [ -L "$BASE_DIR/current" ] || die 'production current selector is not a symlink'
  releases_real="$(cd -P "$BASE_DIR/releases" && pwd -P)"
  current_real="$(readlink -f "$BASE_DIR/current")"
  expected_release="$releases_real/$RUNTIME_SHA-${ARTIFACT_DIGEST:0:12}"
  [ "$current_real" = "$expected_release" ] && [ -d "$current_real" ] \
    && [ ! -L "$current_real" ] \
    || die 'current production selector differs from the exact export target'
  assert_owner_controlled_directory "$current_real" 700
  [ "$(dirname "$current_real")" = "$releases_real" ] \
    || die 'current production release is not one direct child of releases'
  assert_owner_single_link_file "$current_real/.complete.json"
  "$NODE_BIN" - "$current_real/.complete.json" "$current_real" \
    "$RUNTIME_SHA" "$ARTIFACT_DIGEST" <<'NODE' \
    || die 'production completion marker differs from the exact export target'
const fs = require('node:fs');
const path = require('node:path');
const [file, release, runtimeSha, artifactDigest] = process.argv.slice(2);
const stat = fs.lstatSync(file);
const marker = JSON.parse(fs.readFileSync(file, 'utf8'));
if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
    || marker?.schema !== 'nexus.release-bundle.v1'
    || marker.runtimeSha !== runtimeSha || marker.artifactDigest !== artifactDigest
    || path.basename(release) !== `${runtimeSha}-${artifactDigest.slice(0, 12)}`) {
  process.exit(1);
}
NODE
  RELEASE_DIR="$current_real"
  HELPER="$RELEASE_DIR/scripts/lib/routing-calibration-export.mjs"
  PRIVATE_DIR_TOOL="$RELEASE_DIR/scripts/lib/ensure-private-directory.py"
  ENV_FILE="$BASE_DIR/.env"
  DATABASE_PATH="$BASE_DIR/data/bot.db"
  [ "$(readlink -f "${BASH_SOURCE[0]}")" \
      = "$RELEASE_DIR/scripts/remote-routing-calibration-export-transaction.sh" ] \
    || die 'transaction is not executing from the exact installed production release'
  assert_owner_single_link_file "$HELPER"
  assert_owner_single_link_file "$PRIVATE_DIR_TOOL"
  assert_owner_single_link_file "$ENV_FILE" 600
  assert_owner_single_link_file "$DATABASE_PATH" 600
  "$NODE_BIN" "$RELEASE_DIR/scripts/release-artifact-manifest.mjs" \
    --verify-installed-source "$RELEASE_DIR" \
    --expected-runtime-sha "$RUNTIME_SHA" \
    --expected-digest "$ARTIFACT_DIGEST" \
    --require-declared-file scripts/remote-routing-calibration-export-transaction.sh \
    --require-declared-file scripts/lib/routing-calibration-export.mjs \
    --require-declared-file scripts/lib/ensure-private-directory.py \
    >/dev/null || die 'installed production source verification failed'
}

assert_private_directory() {
  local directory="$1"
  [ -d "$directory" ] && [ ! -L "$directory" ] \
    && [ "$(stat -c '%U:%a' "$directory")" = "$(id -un):700" ] \
    || die "private state directory is unsafe: $directory"
}

prepare_state() {
  PLAN_ROOT="$STATE_ROOT/plans"
  CLAIM_ROOT="$STATE_ROOT/claims"
  EXPORT_ROOT="$STATE_ROOT/exports"
  RECEIPT_ROOT="$STATE_ROOT/receipts"
  [ -x "$PYTHON_BIN" ] || die 'required server Python 3 runtime is unavailable'
  "$PYTHON_BIN" -B "$PRIVATE_DIR_TOOL" --anchor "$DEPLOY_HOME" \
    "$DEPLOY_HOME/.local/state/nexus-release" \
    || die 'release-state ancestors are unsafe'
  assert_owner_controlled_directory "$DEPLOY_HOME/.local"
  assert_owner_controlled_directory "$DEPLOY_HOME/.local/state"
  assert_owner_controlled_directory "$DEPLOY_HOME/.local/state/nexus-release"
  "$PYTHON_BIN" -B "$PRIVATE_DIR_TOOL" \
    --anchor "$DEPLOY_HOME/.local/state/nexus-release" --exact-private \
    "$STATE_ROOT" "$PLAN_ROOT" "$CLAIM_ROOT" "$EXPORT_ROOT" "$RECEIPT_ROOT" \
    || die 'routing export state directories are unsafe'
  assert_private_directory "$STATE_ROOT"
  assert_private_directory "$PLAN_ROOT"
  assert_private_directory "$CLAIM_ROOT"
  assert_private_directory "$EXPORT_ROOT"
  assert_private_directory "$RECEIPT_ROOT"
  PENDING_PLAN="$PLAN_ROOT/$TRANSACTION_ID.json"
  CLAIM_PLAN="$CLAIM_ROOT/$TRANSACTION_ID.plan.json"
  EXPORT_EVIDENCE="$CLAIM_ROOT/$TRANSACTION_ID.export-evidence.json"
  PARTIAL_EXPORT="$EXPORT_ROOT/$TRANSACTION_ID.sqlite.partial"
  FINAL_EXPORT="$EXPORT_ROOT/$TRANSACTION_ID.sqlite"
  PARTIAL_RECEIPT="$RECEIPT_ROOT/$TRANSACTION_ID.partial.json"
  FINAL_RECEIPT="$RECEIPT_ROOT/$TRANSACTION_ID.json"
  SEQUENCE_FILE="$STATE_ROOT/sequence.json"
}

recover_interrupted_private_publications() {
  local candidate
  for candidate in "$SEQUENCE_FILE" "$PENDING_PLAN" "$CLAIM_PLAN" \
      "$EXPORT_EVIDENCE" "$PARTIAL_EXPORT" "$FINAL_EXPORT" \
      "$PARTIAL_RECEIPT" "$FINAL_RECEIPT"; do
    run_helper 0 recover-private-publication --destination="$candidate" >/dev/null \
      || die "private publication recovery requires manual intervention: $candidate"
  done
}

assert_private_file() {
  local file="$1"
  [ -f "$file" ] && [ ! -L "$file" ] \
    && [ "$(stat -c '%U:%a' "$file")" = "$(id -un):600" ] \
    && [ "$(stat -c '%h' "$file")" = 1 ] \
    || die "private state file is unsafe: $file"
}

assert_private_fd_matches_path() {
  local descriptor="$1"
  local file="$2"
  local path_identity descriptor_identity
  assert_private_file "$file"
  path_identity="$(stat -Lc '%U:%a:%h:%d:%i' -- "$file")" \
    || die "cannot identify private artifact path: $file"
  descriptor_identity="$(stat -Lc '%U:%a:%h:%d:%i' -- "/proc/$$/fd/$descriptor")" \
    || die "cannot identify private artifact descriptor: $file"
  [ "$path_identity" = "$descriptor_identity" ] \
    || die "private artifact changed while opened: $file"
}

assert_no_unresolved_export_transaction() {
  run_helper 0 assert-resolved-state --release-dir="$RELEASE_DIR" \
    --plan-root="$PLAN_ROOT" --claim-root="$CLAIM_ROOT" \
    --export-root="$EXPORT_ROOT" --receipt-root="$RECEIPT_ROOT" >/dev/null \
    || die 'an unresolved or malformed routing export transaction blocks inspect'
}

next_plan_sequence() {
  run_helper 0 next-sequence --sequence-file="$SEQUENCE_FILE" \
    --plan-root="$PLAN_ROOT" --claim-root="$CLAIM_ROOT" \
    --export-root="$EXPORT_ROOT" --receipt-root="$RECEIPT_ROOT"
}

emit_validated_artifact() {
  if [ "$EMIT_KIND" = partial ]; then
    [ ! -e "$FINAL_RECEIPT" ] && [ ! -L "$FINAL_RECEIPT" ] \
      || die 'a final receipt exists; partial receipt is no longer authoritative'
    local partial_plan="$PENDING_PLAN"
    if [ -e "$CLAIM_PLAN" ] || [ -L "$CLAIM_PLAN" ]; then
      assert_private_file "$CLAIM_PLAN"
      partial_plan="$CLAIM_PLAN"
    fi
    assert_private_file "$partial_plan"
    assert_private_file "$PARTIAL_RECEIPT"
    run_helper 0 validate-partial --receipt-file="$PARTIAL_RECEIPT" \
      --plan-file="$partial_plan" --require-status=failed >/dev/null \
      || die 'partial routing export receipt is not a terminal failed receipt; manual recovery is required'
    exec 7<"$PARTIAL_RECEIPT"
    assert_private_fd_matches_path 7 "$PARTIAL_RECEIPT"
    run_helper 0 validate-partial --receipt-file="$PARTIAL_RECEIPT" \
      --plan-file="$partial_plan" --require-status=failed >/dev/null \
      || die 'partial routing export receipt changed or is nonterminal before emission'
    assert_private_fd_matches_path 7 "$PARTIAL_RECEIPT"
    cat <&7
    return
  fi
  assert_private_file "$CLAIM_PLAN"
  assert_private_file "$EXPORT_EVIDENCE"
  assert_private_file "$FINAL_EXPORT"
  assert_private_file "$FINAL_RECEIPT"
  run_helper 0 validate-receipt --receipt-file="$FINAL_RECEIPT" \
    --plan-file="$CLAIM_PLAN" --evidence-file="$EXPORT_EVIDENCE" \
    --release-dir="$RELEASE_DIR" --output-path="$FINAL_EXPORT" >/dev/null \
    || die 'final routing export state is invalid'

  local target
  case "$EMIT_KIND" in
    receipt) target="$FINAL_RECEIPT" ;;
    evidence) target="$EXPORT_EVIDENCE" ;;
    sqlite) target="$FINAL_EXPORT" ;;
  esac
  exec 7<"$target"
  assert_private_fd_matches_path 7 "$target"
  # Revalidate the exact state after opening the stream descriptor. The final
  # path identity must still name that descriptor immediately before emission.
  run_helper 0 validate-receipt --receipt-file="$FINAL_RECEIPT" \
    --plan-file="$CLAIM_PLAN" --evidence-file="$EXPORT_EVIDENCE" \
    --release-dir="$RELEASE_DIR" --output-path="$FINAL_EXPORT" >/dev/null \
    || die 'final routing export state changed before emission'
  assert_private_fd_matches_path 7 "$target"
  cat <&7
}

fsync_parent() {
  "$NODE_BIN" - "$1" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const descriptor = fs.openSync(path.dirname(process.argv[2]), 'r');
try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
NODE
}

publish_private_file() {
  local source="$1"
  local destination="$2"
  run_helper 0 publish-private --source="$source" \
    --destination="$destination" >/dev/null \
    || die "cannot durably publish exact private state: $destination"
  assert_private_file "$destination"
}

replace_private_file() {
  local source="$1"
  local destination="$2"
  "$PYTHON_BIN" -B "$PRIVATE_DIR_TOOL" --replace-private-file \
    "$source" "$destination" \
    || die "cannot atomically replace private state: $destination"
  assert_private_file "$destination"
}

sha_file() {
  printf 'sha256:%s' "$("$SHA256_BIN" "$1" | awk '{print $1}')"
}

collect_pm2_evidence() {
  local output="$1"
  local raw
  raw="$(mktemp "$STATE_ROOT/.routing-export-pm2.XXXXXX")"
  TEMP_FILES+=("$raw")
  "$TIMEOUT_BIN" --foreground 10s "$PM2_BIN" jlist > "$raw" \
    || die 'production PM2 state is unavailable'
  "$NODE_BIN" - "$raw" "$output" "$RELEASE_DIR" \
    "$RUNTIME_SHA" "$ARTIFACT_DIGEST" <<'NODE' \
    || die 'production PM2 identity differs from the exact export target'
const fs = require('node:fs');
const [rawFile, output, release, runtimeSha, artifactDigest] = process.argv.slice(2);
const rows = JSON.parse(fs.readFileSync(rawFile, 'utf8'));
const names = ['content-engine', 'nexus-hub'];
const evidence = names.map((name) => {
  const row = rows.find((entry) => entry?.name === name);
  const cwd = row?.pm2_env?.pm_cwd;
  const expectedCwd = name === 'content-engine' ? `${release}/content-engine` : release;
  if (row?.pm2_env?.status !== 'online'
      || (row.pm2_env.NEXUS_RELEASE_SHA ?? row.pm2_env.GIT_COMMIT) !== runtimeSha
      || row.pm2_env.NEXUS_RELEASE_ARTIFACT_SHA256 !== artifactDigest
      || cwd !== expectedCwd) process.exit(1);
  return { name, status: 'online', cwd, runtimeSha, artifactDigest };
});
fs.writeFileSync(output, `${JSON.stringify({
  schema: 'nexus.routing-calibration-export-pm2-evidence.v1',
  role: 'production', runtimeSha, artifactDigest, processes: evidence,
})}\n`, { mode: 0o600 });
NODE
}

collect_health_evidence() {
  local output="$1"
  env -i 'PATH=/usr/local/bin:/usr/bin:/bin' \
    curl --noproxy '*' --fail --silent --show-error --max-time 5 \
    "http://127.0.0.1:$CONTENT_PORT/health" >/dev/null \
    || die 'production content health failed'
  env -i \
    "HOME=$HOME" "USER=$(id -un)" "LOGNAME=$(id -un)" \
    'PATH=/usr/local/bin:/usr/bin:/bin' \
    "$NODE_BIN" --env-file="$ENV_FILE" - "$output" "$BACKEND_PORT" \
      "$RUNTIME_SHA" "$ARTIFACT_DIGEST" <<'NODE' \
    || die 'production detailed health or release attestation failed'
const fs = require('node:fs');
const http = require('node:http');
const [output, portRaw, runtimeSha, artifactDigest] = process.argv.slice(2);
const token = process.env.HEALTH_TOKEN;
if (typeof token !== 'string' || token.length === 0) process.exit(1);
const request = new Promise((resolve, reject) => {
  const req = http.get({
    hostname: '127.0.0.1', port: Number(portRaw), path: '/health/detailed',
    headers: { Authorization: `Bearer ${token}` }, timeout: 5000,
  }, (response) => {
    let body = '';
    response.setEncoding('utf8');
    response.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) req.destroy(new Error('health body too large'));
    });
    response.on('end', () => resolve({ statusCode: response.statusCode, body }));
  });
  req.on('timeout', () => req.destroy(new Error('health timeout')));
  req.on('error', reject);
});
request.then(({ statusCode, body }) => {
  const health = JSON.parse(body);
  const attestation = health?.releaseAttestation;
  if (statusCode !== 200 || health?.status !== 'healthy'
      || health?.database !== 'connected'
      || health?.databaseProbe?.status !== 'connected'
      || attestation?.schema !== 'nexus.chat-capability-release-attestation.v2'
      || attestation.role !== 'production'
      || attestation.runtimeSha !== runtimeSha
      || attestation.artifactDigest !== artifactDigest) process.exit(1);
  fs.writeFileSync(output, `${JSON.stringify({
    schema: 'nexus.routing-calibration-export-health-evidence.v1',
    status: 'healthy', database: 'connected', databaseProbe: 'connected',
    contentHealth: 'passed', role: 'production', runtimeSha, artifactDigest,
    releaseAttestationSchema: attestation.schema,
  })}\n`, { mode: 0o600 });
}).catch(() => process.exit(1));
NODE
}

run_helper() {
  local owner_authorized="$1"
  shift
  (
    cd -- "$RELEASE_DIR"
    env -i \
      "HOME=$HOME" "USER=$(id -un)" "LOGNAME=$(id -un)" \
      'PATH=/usr/local/bin:/usr/bin:/bin' \
      "NEXUS_RELEASE_OWNER_AUTHORIZED=$owner_authorized" \
      "$NODE_BIN" --env-file="$ENV_FILE" "$HELPER" "$@"
  )
}

acquire_shared_locks
resolve_exact_release
prepare_state
recover_interrupted_private_publications

if [ "$COMMAND" = emit ]; then
  emit_validated_artifact
  exit 0
fi

HEALTH_BEFORE="$(mktemp "$STATE_ROOT/.routing-export-health-before.XXXXXX")"
PM2_BEFORE="$(mktemp "$STATE_ROOT/.routing-export-pm2-before.XXXXXX")"
TEMP_FILES+=("$HEALTH_BEFORE" "$PM2_BEFORE")
collect_health_evidence "$HEALTH_BEFORE"
collect_pm2_evidence "$PM2_BEFORE"
OPERATOR_SHA256="$(sha_file "$RELEASE_DIR/scripts/remote-routing-calibration-export-transaction.sh")"
HELPER_SHA256="$(sha_file "$HELPER")"

if [ "$COMMAND" = inspect ]; then
  assert_no_unresolved_export_transaction
  PLAN_TEMP="$(mktemp "$STATE_ROOT/.routing-export-plan.XXXXXX")"
  TEMP_FILES+=("$PLAN_TEMP")
  if [ -e "$FINAL_RECEIPT" ] || [ -L "$FINAL_RECEIPT" ]; then
    die 'transaction already has a final receipt; choose a new transaction ID'
  fi
  if [ -e "$PENDING_PLAN" ] || [ -L "$PENDING_PLAN" ]; then
    assert_private_file "$PENDING_PLAN"
    assert_private_file "$SEQUENCE_FILE"
    readarray -t PLAN_TIMES < <("$NODE_BIN" - "$PENDING_PLAN" <<'NODE'
const plan = require(process.argv[2]);
if (Date.now() > Date.parse(plan.expiresAt)) process.exit(1);
if (!Number.isSafeInteger(plan.planSequence) || plan.planSequence < 1) process.exit(1);
process.stdout.write(`${plan.generatedAt}\n${plan.expiresAt}\n${plan.planSequence}\n`);
NODE
    ) || die 'pending export plan is invalid or expired'
    GENERATED_AT="${PLAN_TIMES[0]}"
    EXPIRES_AT="${PLAN_TIMES[1]}"
    PLAN_SEQUENCE="${PLAN_TIMES[2]}"
    "$NODE_BIN" - "$SEQUENCE_FILE" "$PLAN_SEQUENCE" <<'NODE' \
      || die 'pending plan is stale because a newer plan sequence was issued'
const state = require(process.argv[2]);
const planSequence = Number(process.argv[3]);
if (state?.schema !== 'nexus.routing-calibration-export-sequence.v1'
    || state.lastIssued !== planSequence) process.exit(1);
NODE
  else
    GENERATED_AT="$($NODE_BIN -e 'process.stdout.write(new Date().toISOString())')"
    EXPIRES_AT="$($NODE_BIN - "$GENERATED_AT" <<'NODE'
const value = Date.parse(process.argv[2]);
process.stdout.write(new Date(value + 60 * 60_000).toISOString());
NODE
    )"
    PLAN_SEQUENCE="$(next_plan_sequence)" \
      || die 'routing export plan sequence is missing, corrupt, or reset'
  fi
  run_helper 0 inspect \
    --db="$DATABASE_PATH" \
    --release-dir="$RELEASE_DIR" \
    --output-path="$FINAL_EXPORT" \
    --runtime-sha="$RUNTIME_SHA" \
    --artifact-digest="$ARTIFACT_DIGEST" \
    --transaction-id="$TRANSACTION_ID" \
    --plan-sequence="$PLAN_SEQUENCE" \
    --generated-at="$GENERATED_AT" \
    --expires-at="$EXPIRES_AT" \
    --operator-sha256="$OPERATOR_SHA256" \
    --helper-sha256="$HELPER_SHA256" \
    --production-base-dir="$BASE_DIR" \
    --export-root="$EXPORT_ROOT" \
    --selector="$RELEASE_DIR" \
    --health-evidence-file="$HEALTH_BEFORE" \
    --pm2-evidence-file="$PM2_BEFORE" > "$PLAN_TEMP"
  if [ -e "$PENDING_PLAN" ]; then
    cmp -s "$PLAN_TEMP" "$PENDING_PLAN" \
      || die 'production routing export state changed after the pending plan'
  else
    SEQUENCE_TEMP="$(mktemp "$STATE_ROOT/.routing-export-sequence.XXXXXX")"
    TEMP_FILES+=("$SEQUENCE_TEMP")
    "$NODE_BIN" - "$SEQUENCE_TEMP" "$PLAN_SEQUENCE" <<'NODE'
const fs = require('node:fs');
const [file, sequenceRaw] = process.argv.slice(2);
const lastIssued = Number(sequenceRaw);
if (!Number.isSafeInteger(lastIssued) || lastIssued < 1) process.exit(1);
fs.writeFileSync(file, `${JSON.stringify({
  schema: 'nexus.routing-calibration-export-sequence.v1', lastIssued,
})}\n`, { mode: 0o600 });
NODE
    if [ -e "$SEQUENCE_FILE" ]; then
      replace_private_file "$SEQUENCE_TEMP" "$SEQUENCE_FILE"
    else
      publish_private_file "$SEQUENCE_TEMP" "$SEQUENCE_FILE"
    fi
    # Sequence publication precedes plan publication: a crash may burn one
    # sequence number, but no two owner-review plans can ever reuse it.
    publish_private_file "$PLAN_TEMP" "$PENDING_PLAN"
  fi
  cat "$PENDING_PLAN"
  exit 0
fi

assert_private_file "$PENDING_PLAN"
assert_private_file "$SEQUENCE_FILE"
"$NODE_BIN" --input-type=module - "$HELPER" "$PENDING_PLAN" "$ACK_PLAN" \
  "$RUNTIME_SHA" "$ARTIFACT_DIGEST" "$TRANSACTION_ID" "$RELEASE_DIR" \
  "$FINAL_EXPORT" "$SEQUENCE_FILE" <<'NODE' \
  || die 'pending routing export plan is invalid, expired, or not exactly acknowledged'
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
const [helperPath, planFile, ackPlan, runtimeSha, artifactDigest,
  transactionId, releaseDir, outputPath, sequenceFile] = process.argv.slice(2);
const helper = await import(pathToFileURL(helperPath).href);
const plan = helper.validateRoutingCalibrationExportPlan(
  JSON.parse(fs.readFileSync(planFile, 'utf8')),
);
const sequence = JSON.parse(fs.readFileSync(sequenceFile, 'utf8'));
if (plan.planDigest !== ackPlan || plan.runtimeSha !== runtimeSha
    || plan.artifactDigest !== artifactDigest || plan.transactionId !== transactionId
    || plan.releaseDir !== releaseDir || plan.output?.path !== outputPath
    || sequence?.schema !== 'nexus.routing-calibration-export-sequence.v1'
    || !Number.isSafeInteger(sequence.lastIssued)
    || sequence.lastIssued !== plan.planSequence
    || Date.now() > Date.parse(plan.expiresAt)) process.exit(1);
NODE

for attempted_path in "$CLAIM_PLAN" "$EXPORT_EVIDENCE" "$PARTIAL_EXPORT" \
    "$FINAL_EXPORT" "$PARTIAL_RECEIPT" "$FINAL_RECEIPT"; do
  [ ! -e "$attempted_path" ] && [ ! -L "$attempted_path" ] \
    || die 'this routing export plan was already attempted; observe it by transaction ID and never re-apply'
done

TRANSACTION_STARTED_AT="$($NODE_BIN -e 'process.stdout.write(new Date().toISOString())')"
PARTIAL_TEMP="$(mktemp "$STATE_ROOT/.routing-export-partial-receipt.XXXXXX")"
TEMP_FILES+=("$PARTIAL_TEMP")
run_helper 1 partial-receipt --plan-file="$PENDING_PLAN" \
  --status=started --started-at="$TRANSACTION_STARTED_AT" > "$PARTIAL_TEMP"
ATTEMPT_ACTIVE=true
publish_private_file "$PARTIAL_TEMP" "$PARTIAL_RECEIPT"

# The partial receipt exists before the atomic one-time claim. A failure after
# this publication is terminal: collect the failed partial receipt; never run
# apply again for the same transaction or plan digest.
publish_private_file "$PENDING_PLAN" "$CLAIM_PLAN"

[ ! -e "$PARTIAL_EXPORT" ] && [ ! -L "$PARTIAL_EXPORT" ] \
  && [ ! -e "$FINAL_EXPORT" ] && [ ! -L "$FINAL_EXPORT" ] \
  || die 'orphan routing export bytes exist at first claim; transaction quarantined'
EVIDENCE_TEMP="$(mktemp "$STATE_ROOT/.routing-export-evidence.XXXXXX")"
TEMP_FILES+=("$EVIDENCE_TEMP")
run_helper 1 apply \
  --db="$DATABASE_PATH" \
  --release-dir="$RELEASE_DIR" \
  --output-path="$FINAL_EXPORT" \
  --partial-output-path="$PARTIAL_EXPORT" \
  --runtime-sha="$RUNTIME_SHA" \
  --artifact-digest="$ARTIFACT_DIGEST" \
  --transaction-id="$TRANSACTION_ID" \
  --production-base-dir="$BASE_DIR" \
  --export-root="$EXPORT_ROOT" \
  --plan-file="$CLAIM_PLAN" \
  --ack-plan="$ACK_PLAN" > "$EVIDENCE_TEMP"
publish_private_file "$EVIDENCE_TEMP" "$EXPORT_EVIDENCE"
PARTIAL_EXPORTED_TEMP="$(mktemp "$STATE_ROOT/.routing-export-partial-exported.XXXXXX")"
TEMP_FILES+=("$PARTIAL_EXPORTED_TEMP")
run_helper 1 partial-receipt --plan-file="$CLAIM_PLAN" \
  --evidence-file="$EXPORT_EVIDENCE" \
  --status=exported_pending_post_health --started-at="$TRANSACTION_STARTED_AT" \
  > "$PARTIAL_EXPORTED_TEMP"
replace_private_file "$PARTIAL_EXPORTED_TEMP" "$PARTIAL_RECEIPT"

assert_private_file "$PARTIAL_EXPORT"
run_helper 1 verify --plan-file="$CLAIM_PLAN" \
  --evidence-file="$EXPORT_EVIDENCE" --release-dir="$RELEASE_DIR" \
  --output-path="$PARTIAL_EXPORT" >/dev/null

# A final receipt is impossible until post-export production health passes.
HEALTH_AFTER="$(mktemp "$STATE_ROOT/.routing-export-health-after.XXXXXX")"
PM2_AFTER="$(mktemp "$STATE_ROOT/.routing-export-pm2-after.XXXXXX")"
TEMP_FILES+=("$HEALTH_AFTER" "$PM2_AFTER")
collect_health_evidence "$HEALTH_AFTER"
collect_pm2_evidence "$PM2_AFTER"

# Re-resolve the exact installed release as the post-export selector gate.
resolve_exact_release
revalidate_shared_locks
run_helper 1 verify-source \
  --db="$DATABASE_PATH" --release-dir="$RELEASE_DIR" \
  --output-path="$FINAL_EXPORT" --runtime-sha="$RUNTIME_SHA" \
  --artifact-digest="$ARTIFACT_DIGEST" --transaction-id="$TRANSACTION_ID" \
  --production-base-dir="$BASE_DIR" --export-root="$EXPORT_ROOT" \
  --plan-file="$CLAIM_PLAN" >/dev/null

if [ -e "$PARTIAL_EXPORT" ]; then
  # Immutable no-replace publication: a concurrently created final path wins
  # and fails the transaction instead of being overwritten by mv/rename. The
  # already-fsynced SQLite inode is retained instead of copied.
  ln -- "$PARTIAL_EXPORT" "$FINAL_EXPORT" \
    || die 'final routing export destination won its publication race'
  fsync_parent "$FINAL_EXPORT"
  rm -f -- "$PARTIAL_EXPORT"
  fsync_parent "$FINAL_EXPORT"
fi
assert_private_file "$FINAL_EXPORT"
run_helper 1 verify --plan-file="$CLAIM_PLAN" \
  --evidence-file="$EXPORT_EVIDENCE" --release-dir="$RELEASE_DIR" \
  --output-path="$FINAL_EXPORT" >/dev/null

COMPLETED_AT="$($NODE_BIN -e 'process.stdout.write(new Date().toISOString())')"
FINAL_TEMP="$(mktemp "$STATE_ROOT/.routing-export-final-receipt.XXXXXX")"
TEMP_FILES+=("$FINAL_TEMP")
run_helper 1 final-receipt --plan-file="$CLAIM_PLAN" \
  --evidence-file="$EXPORT_EVIDENCE" --completed-at="$COMPLETED_AT" \
  --selector="$RELEASE_DIR" --health-evidence-file="$HEALTH_AFTER" \
  --pm2-evidence-file="$PM2_AFTER" > "$FINAL_TEMP"
publish_private_file "$FINAL_TEMP" "$FINAL_RECEIPT"
cat "$FINAL_RECEIPT"
