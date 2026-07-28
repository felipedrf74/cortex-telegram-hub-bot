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
ROOT_SONAR_LOCK=/run/lock/nexus-release-sonar.lock
PM2_BIN="${NEXUS_RELEASE_PM2_BIN:-/usr/local/bin/pm2}"
NODE_BIN="${NEXUS_RELEASE_NODE_BIN:-/usr/bin/node}"
PYTHON_BIN="${NEXUS_RELEASE_PYTHON_BIN:-/usr/bin/python3.12}"
TIMEOUT_BIN="${NEXUS_RELEASE_TIMEOUT_BIN:-/usr/bin/timeout}"
SONAR_RELEASE_STATE_BIN=/usr/local/sbin/quality-sonar-release-state
FAULT_INJECTION="${NEXUS_RELEASE_FAULT_AFTER_SWITCH:-}"
CANDIDATE_HEALTH_BUDGET_SECONDS=45
ROLLBACK_HEALTH_BUDGET_SECONDS=45
ROLLBACK_OBJECTIVE_SECONDS=120

die() {
  echo "lean release transaction: $*" >&2
  exit 1
}

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
[ -x "$SONAR_RELEASE_STATE_BIN" ] \
  || die "Sonar release-state monitor is unavailable at $SONAR_RELEASE_STATE_BIN"
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
flock -n 9 || die "another staging, production, or Sonar-sensitive release action is active"
[ -f "$ROOT_SONAR_LOCK" ] && [ ! -L "$ROOT_SONAR_LOCK" ] \
  && [ "$(stat -c '%U:%G:%a' "$ROOT_SONAR_LOCK")" = root:dominguez:660 ] \
  || die "shared root release/Sonar lock is missing or unsafe"
exec 8<>"$ROOT_SONAR_LOCK"
flock -n 8 || die "a Sonar backup, restore, or root maintenance action is active"

# The shared user lock prevents a new advisory scan from starting. Check the
# server-side CE queue while holding it as well, so a scan whose client exited
# after submission cannot overlap artifact extraction, staging, or promotion.
SONAR_RELEASE_STATE="$(
  sudo -n "$SONAR_RELEASE_STATE_BIN" --project nexus-hub-backend --json
)" || die "Sonar Compute Engine state is unavailable"
"$NODE_BIN" - "$SONAR_RELEASE_STATE" <<'NODE' \
  || die "Sonar Compute Engine is processing an advisory scan"
const value = JSON.parse(process.argv[2]);
if (value?.schema !== 'nexus.sonarqube-release-state.v1'
    || value.status !== 'passed'
    || value.projectKey !== 'nexus-hub-backend'
    || value.activeTasks !== 0) {
  process.exit(1);
}
NODE
unset SONAR_RELEASE_STATE

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
      verify-extracted --root "$runtime" --python-bin "$PYTHON_BIN" \
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
  [ -f "$runtime/ecosystem.release.config.js" ] || die "runtime ecosystem configuration is missing"
  pm2_env "$runtime" "$sha" "$digest" startOrReload "$runtime/ecosystem.release.config.js" \
    --only "$(IFS=,; echo "${APP_NAMES[*]}")" --update-env
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
      "$NODE_BIN" dist/tools/portal-session-token.js \
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
