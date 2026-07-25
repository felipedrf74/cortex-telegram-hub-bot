#!/usr/bin/env bash
# Unprivileged production worker for the persistent promotion critical
# section. A root broker streams this root-only script to dominguez only after
# revalidating the signed request and authoritative active digest.
set -euo pipefail
umask 077

COMMAND="${1:-}"
TRANSACTION_ID="${2:-}"
STATE_ROOT="${NEXUS_PROMOTION_STATE_ROOT:-/var/lib/nexus-release-promotion}"
REQUEST_SHA256="${NEXUS_PROMOTION_REQUEST_SHA256:-}"
TIMEOUT_BIN="${NEXUS_PROMOTION_TIMEOUT_BIN:-/usr/bin/timeout}"
CUTOVER_STARTED_AT="${NEXUS_PROMOTION_CUTOVER_STARTED_AT:-}"
CUTOVER_STARTED_MONOTONIC="${NEXUS_PROMOTION_CUTOVER_STARTED_MONOTONIC:-}"
PRE_RECOVERY_DEADLINE_MONOTONIC="${NEXUS_PROMOTION_PRE_RECOVERY_DEADLINE_MONOTONIC:-}"
OUTAGE_DEADLINE_MONOTONIC="${NEXUS_PROMOTION_OUTAGE_DEADLINE_MONOTONIC:-}"
RECOVERY_PHASE="${NEXUS_PROMOTION_RECOVERY_PHASE:-}"
AUTHORIZED_BACKUP_FILE="${NEXUS_PROMOTION_AUTHORIZED_BACKUP_FILE:-}"
AUTHORIZED_BACKUP_SHA256="${NEXUS_PROMOTION_AUTHORIZED_BACKUP_SHA256:-}"
AUTHORIZED_BACKUP_SIZE_BYTES="${NEXUS_PROMOTION_AUTHORIZED_BACKUP_SIZE_BYTES:-}"
AUTHORIZED_BACKUP_DATABASE_SHA256="${NEXUS_PROMOTION_AUTHORIZED_BACKUP_DATABASE_SHA256:-}"
PM2_STATE_DIR="${NEXUS_PROMOTION_PM2_STATE_DIR:-${PM2_HOME:-$HOME/.pm2}}"
PYTHON_BIN="${NEXUS_PROMOTION_PYTHON_BIN:-/usr/bin/python3}"
SELECTOR_SWITCH="${NEXUS_PROMOTION_SELECTOR_SWITCH:-/usr/local/libexec/nexus-release-selector-switch.py}"
if [ "${NEXUS_RELEASE_TEST_MODE:-0}" = "1" ] \
    && [ -z "${NEXUS_PROMOTION_SELECTOR_SWITCH:-}" ]; then
  SELECTOR_SWITCH="$(cd "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/remote-release-selector-switch.py"
fi
[[ "$TRANSACTION_ID" =~ ^[0-9]{8}T[0-9]{6}Z-[0-9]+-[a-f0-9]{12}$ ]] || {
  echo "invalid promotion transaction id" >&2
  exit 64
}
case "$COMMAND" in
  worker-prepare|worker-promote|worker-recover|worker-verify-candidate) ;;
  *) echo "Usage: remote-promotion-transaction.sh <worker-prepare|worker-promote|worker-recover|worker-verify-candidate> <transaction-id>" >&2; exit 64 ;;
esac
[[ "$REQUEST_SHA256" =~ ^[a-f0-9]{64}$ ]] || { echo "promotion request digest is missing" >&2; exit 77; }
[ -x "$TIMEOUT_BIN" ] || { echo "timeout is required by the promotion worker" >&2; exit 1; }

REQUEST="$STATE_ROOT/requests/$TRANSACTION_ID.json"
TRANSACTION_DIR="$STATE_ROOT/transactions/$TRANSACTION_ID"
WORKER_DIR="$TRANSACTION_DIR/worker"
# This progress file is diagnostic only. Root-owned state/journal.json is the
# sole authority for overlap, recovery, and terminal reconciliation.
JOURNAL="$WORKER_DIR/worker-progress.json"
CONTROL_DIR="$TRANSACTION_DIR/control"
BACKUP_ENV="$WORKER_DIR/backup.env"
FINAL_REHEARSAL="$WORKER_DIR/final-rehearsal.json"
RESULT_ENV="$WORKER_DIR/result.env"
RECOVERY_RESULT_ENV="$WORKER_DIR/recovery-result.env"
RECOVERY_ARMED_MARKER="$WORKER_DIR/recovery-armed"
STOPPED_MARKER="$WORKER_DIR/predecessor-stopped"
CANDIDATE_MARKER="$WORKER_DIR/candidate-mutated"
RECOVERY_MARKER="$WORKER_DIR/recovery-complete"

[ -f "$REQUEST" ] && [ ! -L "$REQUEST" ] || { echo "promotion request is missing" >&2; exit 1; }
[ -d "$WORKER_DIR" ] && [ -d "$CONTROL_DIR" ] || { echo "promotion worker state is missing" >&2; exit 1; }
[ -w "$WORKER_DIR" ] || { echo "promotion worker state is not writable" >&2; exit 1; }

IFS=$'\t' read -r PROD_BASE PREVIOUS_RUNTIME PREVIOUS_SHA PREVIOUS_ARTIFACT_DIGEST \
  PREVIOUS_INSTALLED_RUNTIME_DIGEST RELEASE_DIR RUNTIME_SHA SENTRY_RELEASE ARTIFACT_DIGEST \
  INSTALLED_RUNTIME_DIGEST TARGET_VERSION BACKUP_DIR PREPARED_RUNTIME_DIR PM2_BIN PUBLIC_BASE_URL \
  STABILITY_SECONDS GATE_TIMEOUT_SECONDS MIGRATION_REQUIRED REVIEW_EVIDENCE_SHA256 \
  MIGRATION_POLICY_SUBJECT_SHA256 ONLINE_EVIDENCE_SHA256 ONLINE_CLONE_SHA256 \
  ONLINE_MIGRATED_CLONE_SHA256 ONLINE_PENDING_SET_SHA256 ONLINE_SOURCE_DATABASE_SHA256 \
  < <(node - "$REQUEST" "$TRANSACTION_ID" <<'NODE'
const fs = require('fs');
const [file, expectedId] = process.argv.slice(2);
const x = JSON.parse(fs.readFileSync(file, 'utf8'));
if (x.schema !== 'nexus.promotion-transaction-request.v1' || x.transactionId !== expectedId
    || x.ownerAuthorization !== 'explicit') throw new Error('promotion request identity mismatch');
const fields = [
  x.productionBase, x.predecessor.runtime, x.predecessor.sha, x.predecessor.artifactDigest,
  x.predecessor.installedRuntimeDigest, x.target.runtime, x.target.sha, x.target.sentryRelease,
  x.target.artifactDigest, x.target.installedRuntimeDigest, x.target.version, x.backupDir,
  x.preparedRuntimeDir, x.pm2Bin, x.publicBaseUrl, x.stabilitySeconds, x.gateTimeoutSeconds,
  x.migration.required ? 'true' : 'false', x.migration.reviewEvidenceSha256 || '',
  x.migration.policySubjectSha256 || '', x.migration.onlineEvidenceSha256 || '',
  x.migration.onlineCloneSha256 || '', x.migration.onlineMigratedCloneSha256 || '',
  x.migration.onlinePendingSetSha256 || '', x.migration.onlineSourceDatabaseSha256 || '',
];
if (fields.some((entry) => String(entry).includes('\t') || String(entry).includes('\n'))) {
  throw new Error('promotion request contains unsafe delimiters');
}
process.stdout.write(`${fields.join('\t')}\n`);
NODE
)

if [ "${NEXUS_RELEASE_TEST_MODE:-0}" = "1" ] && [ -n "${NEXUS_PROMOTION_TEST_ROOT:-}" ]; then
  TEST_ROOT="$NEXUS_PROMOTION_TEST_ROOT"
  PROD_BASE="$TEST_ROOT/production"
  PREVIOUS_RUNTIME="$PROD_BASE/releases/previous-runtime"
  RELEASE_DIR="$PROD_BASE/releases/target-runtime"
  BACKUP_DIR="$TEST_ROOT/backups"
  PREPARED_RUNTIME_DIR="$BACKUP_DIR/.runtime-stage-test"
  PM2_BIN="$TEST_ROOT/bin/pm2"
  PUBLIC_BASE_URL="https://api.nexushub.test"
fi

case "$PREVIOUS_RUNTIME" in "$PROD_BASE"|"$PROD_BASE"/releases/*) ;; *) echo "unsafe predecessor runtime" >&2; exit 64 ;; esac
[ "$RELEASE_DIR" != "$PREVIOUS_RUNTIME" ] || { echo "target is already the predecessor" >&2; exit 75; }
[[ "$RELEASE_DIR" == "$PROD_BASE"/releases/* ]] || { echo "unsafe target runtime" >&2; exit 64; }
[[ "$PREVIOUS_SHA" =~ ^[a-f0-9]{40}$ && "$RUNTIME_SHA" =~ ^[a-f0-9]{40}$ ]] || { echo "invalid runtime identity" >&2; exit 64; }
[[ "$PREVIOUS_ARTIFACT_DIGEST" =~ ^[a-f0-9]{64}$ \
    && "$PREVIOUS_INSTALLED_RUNTIME_DIGEST" =~ ^[a-f0-9]{64}$ ]] || { echo "invalid predecessor artifact identity" >&2; exit 64; }
[ "$SENTRY_RELEASE" = "$RUNTIME_SHA" ] || { echo "Sentry release identity mismatch" >&2; exit 64; }
[[ "$ARTIFACT_DIGEST" =~ ^[a-f0-9]{64}$ && "$INSTALLED_RUNTIME_DIGEST" =~ ^[a-f0-9]{64}$ ]] || { echo "invalid artifact identity" >&2; exit 64; }
[[ "$STABILITY_SECONDS" =~ ^[0-9]+$ && "$GATE_TIMEOUT_SECONDS" =~ ^[0-9]+$ ]] || { echo "invalid transaction timeout" >&2; exit 64; }
[ "$STABILITY_SECONDS" -eq 60 ] || { echo "production stability soak must be exactly 60 seconds" >&2; exit 64; }
[ "$GATE_TIMEOUT_SECONDS" -ge 30 ] && [ "$GATE_TIMEOUT_SECONDS" -le 60 ] || { echo "local gate timeout is outside the safe range" >&2; exit 64; }
[ -x "$PM2_BIN" ] || { echo "PM2 is unavailable" >&2; exit 1; }
[ -d "$PREVIOUS_RUNTIME" ] && [ -d "$RELEASE_DIR" ] || { echo "promotion runtime is missing" >&2; exit 1; }

monotonic_seconds() {
  local uptime
  if [ -r /proc/uptime ]; then
    IFS=' ' read -r uptime _ < /proc/uptime
    printf '%s\n' "${uptime%%.*}"
    return 0
  fi
  # The production contract is Linux/systemd, where /proc/uptime is the
  # kernel monotonic clock. This fallback exists only for the macOS fixture.
  if [ "${NEXUS_RELEASE_TEST_MODE:-0}" = "1" ]; then
    date +%s
    return 0
  fi
  echo "kernel monotonic clock is unavailable" >&2
  return 1
}

durable_publish_worker_file() {
  local temporary="$1" destination="$2"
  node - "$temporary" "$destination" "$WORKER_DIR" <<'NODE'
const fs = require('fs');
const path = require('path');
const [temporary, destination, workerRoot] = process.argv.slice(2);
const parent = path.dirname(destination);
if (parent !== workerRoot || path.dirname(temporary) !== parent
    || !path.basename(temporary).startsWith(`${path.basename(destination)}.next.`)) {
  throw new Error('unsafe worker durability publication path');
}
const staged = fs.lstatSync(temporary);
if (!staged.isFile() || staged.isSymbolicLink() || staged.nlink !== 1) {
  throw new Error('unsafe worker durability staging file');
}
if (fs.existsSync(destination)) {
  const current = fs.lstatSync(destination);
  if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1) {
    throw new Error('unsafe worker durability destination');
  }
}
let descriptor = fs.openSync(temporary, 'r');
try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
fs.renameSync(temporary, destination);
descriptor = fs.openSync(parent, 'r');
try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
NODE
}

durable_worker_marker() {
  local destination="$1" schema="$2" phase="$3" temporary
  temporary="$(mktemp "${destination}.next.XXXXXXXX")"
  node - "$temporary" "$schema" "$phase" "$TRANSACTION_ID" "$REQUEST_SHA256" <<'NODE'
const fs = require('fs');
const [output, schema, phase, transactionId, requestSha256] = process.argv.slice(2);
fs.writeFileSync(output, `${JSON.stringify({
  schema, phase, transactionId, requestSha256, recordedAt: new Date().toISOString(),
}, null, 2)}\n`, { mode: 0o600, flag: 'w' });
NODE
  chmod 600 "$temporary"
  durable_publish_worker_file "$temporary" "$destination"
}

validate_worker_marker() {
  local marker="$1" schema="$2" phase="$3"
  [ -f "$marker" ] && [ ! -L "$marker" ] || return 1
  node - "$marker" "$schema" "$phase" "$TRANSACTION_ID" "$REQUEST_SHA256" <<'NODE'
const fs = require('fs');
const [file, schema, phase, transactionId, requestSha256] = process.argv.slice(2);
const stat = fs.lstatSync(file);
const value = JSON.parse(fs.readFileSync(file, 'utf8'));
if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
    || value.schema !== schema || value.phase !== phase
    || value.transactionId !== transactionId || value.requestSha256 !== requestSha256
    || typeof value.recordedAt !== 'string' || !Number.isFinite(Date.parse(value.recordedAt))) {
  process.exit(1);
}
NODE
}

read_backup_env() {
  local file="$1"
  node - "$file" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const stat = fs.lstatSync(file);
if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) process.exit(1);
const values = new Map();
for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/u)) {
  if (line === '') continue;
  const match = line.match(/^([A-Z0-9_]+)=(.*)$/u);
  if (!match || values.has(match[1]) || match[2].includes('\t')) process.exit(1);
  values.set(match[1], match[2]);
}
const required = [
  'NEXUS_BACKUP_FILE', 'NEXUS_BACKUP_SHA256', 'NEXUS_BACKUP_SIZE_BYTES',
  'NEXUS_BACKUP_ARCHIVED_VERSION', 'NEXUS_BACKUP_TARGET_VERSION',
  'NEXUS_BACKUP_CREATED_AT', 'NEXUS_BACKUP_DATABASE_SHA256',
];
if (values.size !== required.length || required.some((key) => !values.has(key))) process.exit(1);
process.stdout.write(`${required.map((key) => values.get(key)).join('\t')}\n`);
NODE
}

validate_authorized_backup() {
  case "$AUTHORIZED_BACKUP_FILE" in
    "$BACKUP_DIR"/v*.tar.gz) ;;
    *) echo "authoritative rollback backup path is invalid" >&2; return 1 ;;
  esac
  [[ "$AUTHORIZED_BACKUP_SHA256" =~ ^[a-f0-9]{64}$ \
      && "$AUTHORIZED_BACKUP_DATABASE_SHA256" =~ ^[a-f0-9]{64}$ \
      && "$AUTHORIZED_BACKUP_SIZE_BYTES" =~ ^[1-9][0-9]*$ ]] || {
    echo "authoritative rollback backup identity is invalid" >&2
    return 1
  }
}

pm2_save_durable() {
  local dump_file
  case "$PM2_STATE_DIR" in
    /*) ;;
    *) echo "PM2 state directory is not absolute" >&2; return 1 ;;
  esac
  "$TIMEOUT_BIN" 10s "$PM2_BIN" save >/dev/null || return 1
  dump_file="$PM2_STATE_DIR/dump.pm2"
  node - "$PM2_STATE_DIR" "$dump_file" <<'NODE'
const fs = require('fs');
const path = require('path');
const [directory, dump] = process.argv.slice(2);
const directoryStat = fs.lstatSync(directory);
const dumpStat = fs.lstatSync(dump);
if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()
    || !dumpStat.isFile() || dumpStat.isSymbolicLink() || dumpStat.nlink !== 1
    || path.dirname(dump) !== directory) {
  throw new Error('PM2 saved state is unsafe or incomplete');
}
let descriptor = fs.openSync(dump, 'r');
try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
descriptor = fs.openSync(directory, 'r');
try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
NODE
}

verify_candidate_readiness_snapshot() (
  set -euo pipefail
  local auth_header local_health public_health public_snapshot require_session portal_token
  local backend_ok=false content_ok=false identity_ok=false public_health_ok=false
  local public_snapshot_ok=false
  auth_header="$(mktemp)"; local_health="$(mktemp)"; public_health="$(mktemp)"; public_snapshot="$(mktemp)"
  cleanup_candidate_snapshot() {
    rm -f "$auth_header" "$local_health" "$public_health" "$public_snapshot"
  }
  trap cleanup_candidate_snapshot EXIT
  chmod 600 "$auth_header" "$local_health" "$public_health" "$public_snapshot"
  require_session="$(awk -F= '$1=="PORTAL_REQUIRE_SESSION_AUTH" {print substr($0,index($0,"=")+1); exit}' \
    "$PROD_BASE/.env" 2>/dev/null || true)"
  if [ "$require_session" = true ]; then
    portal_token="$(cd "$RELEASE_DIR" && DOTENV_CONFIG_PATH="$PROD_BASE/.env" node -r dotenv/config \
      dist/tools/portal-session-token.js --actor release-promotion@nexushub.me \
      --scope admin --ttl-ms 300000 --json \
      | node -e 'let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>process.stdout.write(JSON.parse(b).token||""))')"
    [ -n "$portal_token" ] || return 1
    printf 'x-portal-session: %s\n' "$portal_token" >"$auth_header"
  else
    portal_token="$(awk -F= '$1=="PORTAL_TOKEN" {print substr($0,index($0,"=")+1); exit}' \
      "$PROD_BASE/.env" 2>/dev/null || true)"
    [ -n "$portal_token" ] || return 1
    printf 'Authorization: Bearer %s\n' "$portal_token" >"$auth_header"
  fi
  unset portal_token
  for _ in 1 2 3; do
    backend_ok=false; content_ok=false; identity_ok=false
    public_health_ok=false; public_snapshot_ok=false
    if curl --fail --silent --show-error --connect-timeout 1 --max-time 5 \
        http://127.0.0.1:8200/health >"$local_health" \
        && node -e 'const fs=require("fs"),x=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(x.status!=="healthy"||x.server?.status!=="online"||x.database!=="connected")process.exit(1)' \
          "$local_health"; then backend_ok=true; fi
    if curl --fail --silent --show-error --connect-timeout 1 --max-time 5 \
        http://127.0.0.1:8100/health >/dev/null; then content_ok=true; fi
    if [ "$(readlink -f "$PROD_BASE/current")" = "$RELEASE_DIR" ] \
        && "$TIMEOUT_BIN" 3s "$PM2_BIN" jlist | node -e '
          const fs=require("fs"),rows=JSON.parse(fs.readFileSync(0,"utf8"));
          const root=process.argv[1],sha=process.argv[2];
          for(const [name,cwd] of [["nexus-hub",root],["content-engine",`${root}/content-engine`]]){
            const row=rows.find((entry)=>entry?.name===name),env=row?.pm2_env??{};
            if(env.status!=="online"||env.pm_cwd!==cwd
              ||(env.NEXUS_RELEASE_SHA||env.GIT_COMMIT)!==sha
              ||env.SENTRY_RELEASE!==sha)process.exit(1);
          }' "$RELEASE_DIR" "$RUNTIME_SHA"; then identity_ok=true; fi
    if curl --fail --silent --show-error --connect-timeout 2 --max-time 10 \
        "$PUBLIC_BASE_URL/health" >"$public_health" \
        && node -e 'const fs=require("fs"),x=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(x.status!=="healthy"||x.server?.status!=="online"||x.database!=="connected")process.exit(1)' \
          "$public_health"; then public_health_ok=true; fi
    if curl --fail --silent --show-error --connect-timeout 2 --max-time 15 \
        -H @"$auth_header" "$PUBLIC_BASE_URL/api/snapshot" >"$public_snapshot" \
        && node -e 'const fs=require("fs"),x=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(x.version!==process.argv[2])process.exit(1)' \
          "$public_snapshot" "$TARGET_VERSION"; then public_snapshot_ok=true; fi
    if [ "$backend_ok" = true ] && [ "$content_ok" = true ] \
        && [ "$identity_ok" = true ] && [ "$public_health_ok" = true ] \
        && [ "$public_snapshot_ok" = true ]; then
      printf '{"schema":"nexus.candidate-readiness-refresh.v1","status":"passed","transactionId":"%s","runtimeSha":"%s","packageVersion":"%s","verifiedAt":"%s","checks":{"loopbackBackend":true,"contentEngine":true,"pm2Identity":true,"publicHealth":true,"authenticatedSnapshot":true}}\n' \
        "$TRANSACTION_ID" "$RUNTIME_SHA" "$TARGET_VERSION" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
      return 0
    fi
    sleep 2
  done
  echo "candidate failed refreshed exact loopback/public readiness" >&2
  return 1
)

if [ "$COMMAND" = worker-verify-candidate ]; then
  verify_candidate_readiness_snapshot
  exit $?
fi

if [ "$COMMAND" = worker-prepare ] || [ "$COMMAND" = worker-promote ]; then
  [[ "$CUTOVER_STARTED_AT" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ \
      && "$CUTOVER_STARTED_MONOTONIC" =~ ^[0-9]+$ \
      && "$PRE_RECOVERY_DEADLINE_MONOTONIC" =~ ^[0-9]+$ \
      && "$OUTAGE_DEADLINE_MONOTONIC" =~ ^[0-9]+$ ]] || { echo "authoritative cutover timing is missing" >&2; exit 77; }
  [ "$((PRE_RECOVERY_DEADLINE_MONOTONIC - CUTOVER_STARTED_MONOTONIC))" -eq 60 ] \
    && [ "$((OUTAGE_DEADLINE_MONOTONIC - CUTOVER_STARTED_MONOTONIC))" -eq 120 ] || {
    echo "authoritative cutover deadline contract is invalid" >&2
    exit 77
  }
fi

pre_recovery_remaining() {
  local now remaining
  now="$(monotonic_seconds)"
  remaining=$((PRE_RECOVERY_DEADLINE_MONOTONIC - now))
  [ "$remaining" -ge 1 ] || { echo "pre-recovery cutover budget exhausted" >&2; return 1; }
  printf '%s' "$remaining"
}

journal_update() {
  local phase="$1" status="$2" message="$3"
  node - "$REQUEST" "$JOURNAL" "$phase" "$status" "$message" "$BACKUP_ENV" \
    "$STOPPED_MARKER" "$CANDIDATE_MARKER" "$RECOVERY_ARMED_MARKER" "$REQUEST_SHA256" <<'NODE'
const fs = require('fs');
const [requestPath, journalPath, phase, status, message, backupPath, stoppedPath, candidatePath,
  recoveryArmedPath, requestSha256] = process.argv.slice(2);
const request = JSON.parse(fs.readFileSync(requestPath, 'utf8'));
let previous = {};
try { previous = JSON.parse(fs.readFileSync(journalPath, 'utf8')); } catch {}
const backup = {};
try {
  for (const line of fs.readFileSync(backupPath, 'utf8').split(/\r?\n/u)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/u);
    if (match) backup[match[1]] = match[2];
  }
} catch {}
const now = new Date().toISOString();
const terminal = ['completed', 'recovered', 'failed_before_stop'].includes(status);
const journal = {
  schema: 'nexus.promotion-transaction-journal.v1',
  transactionId: request.transactionId,
  requestSha256,
  phase,
  status,
  message,
  startedAt: previous.startedAt || now,
  updatedAt: now,
  completedAt: terminal ? now : null,
  predecessor: request.predecessor,
  target: request.target,
  sentryRelease: request.target.sentryRelease,
  predecessorStopped: fs.existsSync(stoppedPath),
  recoveryArmed: fs.existsSync(recoveryArmedPath),
  candidateMutated: fs.existsSync(candidatePath),
  backup: backup.NEXUS_BACKUP_FILE ? {
    remotePath: backup.NEXUS_BACKUP_FILE,
    sha256: backup.NEXUS_BACKUP_SHA256 || null,
    databaseSha256: backup.NEXUS_BACKUP_DATABASE_SHA256 || null,
  } : null,
};
const temporary = `${journalPath}.${process.pid}.tmp`;
fs.writeFileSync(temporary, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
fs.renameSync(temporary, journalPath);
fs.chmodSync(journalPath, 0o600);
NODE
}

verify_predecessor_identity() {
  if [ "$PREVIOUS_RUNTIME" != "$PROD_BASE" ]; then
    [ "$(readlink -f "$PROD_BASE/current")" = "$PREVIOUS_RUNTIME" ] || { echo "production current symlink drift" >&2; return 1; }
    [ -f "$PREVIOUS_RUNTIME/.complete.json" ] || { echo "predecessor marker is missing" >&2; return 1; }
  else
    [ ! -e "$PROD_BASE/current" ] || { echo "legacy predecessor cannot have a current link" >&2; return 1; }
  fi
  "$TIMEOUT_BIN" 5s "$PM2_BIN" jlist | node -e '
    const fs=require("fs");const rows=JSON.parse(fs.readFileSync(0,"utf8"));
    const root=process.argv[1],sha=process.argv[2];
    for(const [name,cwd] of [["nexus-hub",root],["content-engine",`${root}/content-engine`]]){
      const row=rows.find((entry)=>entry?.name===name),env=row?.pm2_env??{};
      if(env.status!=="online"||env.pm_cwd!==cwd||(env.NEXUS_RELEASE_SHA||env.GIT_COMMIT)!==sha)process.exit(1);
    }' "$PREVIOUS_RUNTIME" "$PREVIOUS_SHA"
}

stop_predecessor() {
  for app in nexus-hub content-engine; do
    if "$TIMEOUT_BIN" 5s "$PM2_BIN" describe "$app" >/dev/null 2>&1; then
      "$TIMEOUT_BIN" 10s "$PM2_BIN" stop "$app" >/dev/null
    fi
  done
  "$TIMEOUT_BIN" 10s "$PM2_BIN" jlist | node -e '
const fs=require("fs");const rows=JSON.parse(fs.readFileSync(0,"utf8"));
for(const name of ["nexus-hub","content-engine"]){const row=rows.find((entry)=>entry?.name===name);
if(row&&(row.pm2_env?.status!=="stopped"||Number(row.pid||0)!==0))throw new Error(`PM2 process did not stop: ${name}`)}'
}

atomic_switch_current() {
  local target="$1" current="$PROD_BASE/current" expected worker_uid worker_gid
  if [ "${NEXUS_RELEASE_TEST_MODE:-0}" != "1" ]; then
    "$TIMEOUT_BIN" 5s node - "$current" "$target" <<'NODE'
const fs=require('fs');const [selector,target]=process.argv.slice(2);
const stat=fs.lstatSync(selector);
if(!stat.isSymbolicLink()||stat.uid!==0||stat.gid!==0
 ||fs.readlinkSync(selector)!==target||fs.realpathSync.native(selector)!==target)process.exit(1);
NODE
    if [ "$?" -ne 0 ]; then
      echo "root production selector was not switched to the exact authorized target" >&2
      return 1
    fi
    return 0
  fi
  if [ "$target" = "$RELEASE_DIR" ]; then expected="$PREVIOUS_RUNTIME"
  elif [ "$target" = "$PREVIOUS_RUNTIME" ]; then expected="$RELEASE_DIR"
  else echo "test selector target is outside the exact transaction" >&2; return 1
  fi
  worker_uid="$(id -u)"; worker_gid="$(id -g)"
  NEXUS_RELEASE_TEST_MODE=1 "$PYTHON_BIN" "$SELECTOR_SWITCH" switch \
    --role production --release-root "$(dirname -- "$PROD_BASE")" \
    --worker-uid "$worker_uid" --worker-gid "$worker_gid" \
    --expected "$expected" --target "$target" --allow-test-owner >/dev/null
}

start_predecessor() {
  for app in nexus-hub content-engine; do
    if "$TIMEOUT_BIN" 5s "$PM2_BIN" describe "$app" >/dev/null 2>&1; then
      "$TIMEOUT_BIN" 10s "$PM2_BIN" delete "$app" >/dev/null
    fi
  done
  if [ "$PREVIOUS_RUNTIME" != "$PROD_BASE" ]; then
    atomic_switch_current "$PREVIOUS_RUNTIME" || return 1
    env -i HOME="$HOME" PATH="$PATH" NEXUS_RELEASE_DIR="$PREVIOUS_RUNTIME" NEXUS_RELEASE_BASE_DIR="$PROD_BASE" \
      NEXUS_RELEASE_ROLE=production NEXUS_RELEASE_SHA="$PREVIOUS_SHA" SENTRY_RELEASE="$PREVIOUS_SHA" \
      "$TIMEOUT_BIN" 15s "$PM2_BIN" start "$PREVIOUS_RUNTIME/ecosystem.release.config.js" --update-env >/dev/null
  else
    echo "legacy production predecessor is unsupported by the root selector broker" >&2
    return 1
    node - "$PROD_BASE" <<'NODE'
const fs=require('fs');const directory=process.argv[2];
const stat=fs.lstatSync(directory);
if(!stat.isDirectory()||stat.isSymbolicLink())process.exit(1);
const descriptor=fs.openSync(directory,'r');
try{fs.fsyncSync(descriptor);}finally{fs.closeSync(descriptor);}
NODE
    cd "$PROD_BASE"
    "$TIMEOUT_BIN" 15s "$PM2_BIN" start "$PROD_BASE/ecosystem.config.js" --update-env >/dev/null
  fi
  health_file="$(mktemp)"
  backend_ok=false; content_ok=false; identity_ok=false
  for _ in $(seq 1 8); do
    backend_ok=false; content_ok=false; identity_ok=false
    if curl --fail --silent --show-error --connect-timeout 1 --max-time 2 \
        http://127.0.0.1:8200/health > "$health_file" \
        && node -e 'const fs=require("fs"),x=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(x.status!=="healthy"||x.server?.status!=="online"||x.database!=="connected")process.exit(1)' "$health_file"; then
      backend_ok=true
    fi
    if curl --fail --silent --show-error --connect-timeout 1 --max-time 2 http://127.0.0.1:8100/health >/dev/null; then
      content_ok=true
    fi
    if "$TIMEOUT_BIN" 3s "$PM2_BIN" jlist | node -e '
      const fs=require("fs");const rows=JSON.parse(fs.readFileSync(0,"utf8"));
      const root=process.argv[1],sha=process.argv[2];
      for(const [name,cwd] of [["nexus-hub",root],["content-engine",`${root}/content-engine`]]){
        const row=rows.find((entry)=>entry?.name===name),env=row?.pm2_env??{};
        if(env.status!=="online"||env.pm_cwd!==cwd||(sha&&(env.NEXUS_RELEASE_SHA||env.GIT_COMMIT)!==sha))process.exit(1);
      }' "$PREVIOUS_RUNTIME" "$PREVIOUS_SHA"; then
      if { [ "$PREVIOUS_RUNTIME" = "$PROD_BASE" ] && [ ! -e "$PROD_BASE/current" ]; } \
          || { [ "$PREVIOUS_RUNTIME" != "$PROD_BASE" ] && [ "$(readlink -f "$PROD_BASE/current")" = "$PREVIOUS_RUNTIME" ]; }; then
        identity_ok=true
      fi
    fi
    if [ "$backend_ok" = true ] && [ "$content_ok" = true ] && [ "$identity_ok" = true ]; then
      rm -f "$health_file"
      pm2_save_durable || return 1
      return 0
    fi
    sleep 1
  done
  rm -f "$health_file"
  echo "predecessor restart failed readiness" >&2
  return 1
}

restore_exact_backup() {
  local backup_file backup_sha backup_size backup_database_sha observed_size stage previous_node_path
  validate_authorized_backup || return 1
  backup_file="$AUTHORIZED_BACKUP_FILE"
  backup_sha="$AUTHORIZED_BACKUP_SHA256"
  backup_size="$AUTHORIZED_BACKUP_SIZE_BYTES"
  backup_database_sha="$AUTHORIZED_BACKUP_DATABASE_SHA256"
  case "$backup_file" in "$BACKUP_DIR"/v*.tar.gz) ;; *) echo "unsafe exact rollback backup" >&2; return 1 ;; esac
  [[ "$backup_sha" =~ ^[a-f0-9]{64}$ && "$backup_database_sha" =~ ^[a-f0-9]{64}$ \
      && "$backup_size" =~ ^[1-9][0-9]*$ ]] || { echo "exact rollback backup evidence is invalid" >&2; return 1; }
  [ -d "$BACKUP_DIR" ] && [ ! -L "$BACKUP_DIR" ] && [ "$(readlink -f "$BACKUP_DIR")" = "$BACKUP_DIR" ] \
    || { echo "exact rollback backup directory is unsafe" >&2; return 1; }
  [ -f "$backup_file" ] && [ ! -L "$backup_file" ] && [ "$(readlink -f "$backup_file")" = "$backup_file" ] \
    || { echo "exact rollback backup is missing or unsafe" >&2; return 1; }
  observed_size="$(stat -c '%s' "$backup_file" 2>/dev/null || stat -f '%z' "$backup_file")"
  [ "$observed_size" = "$backup_size" ] || { echo "exact rollback backup size changed" >&2; return 1; }
  [ "$(sha256sum "$backup_file" | awk '{print $1}')" = "$backup_sha" ] \
    || { echo "exact rollback backup digest changed" >&2; return 1; }
  for app in nexus-hub content-engine; do
    if "$TIMEOUT_BIN" 5s "$PM2_BIN" describe "$app" >/dev/null 2>&1; then
      "$TIMEOUT_BIN" 10s "$PM2_BIN" stop "$app" >/dev/null || {
        echo "failed to stop process before exact rollback: $app" >&2
        return 1
      }
    fi
  done
  stage="$(mktemp -d "$PROD_BASE/data/.exact-rollback-XXXXXX")" || return 1
  "$TIMEOUT_BIN" --signal=TERM --kill-after=5s 20s /usr/bin/python3 - "$backup_file" "$stage" <<'PY'
import os
from pathlib import Path, PurePosixPath
import tarfile
import sys

archive = Path(sys.argv[1])
destination = Path(sys.argv[2])
seen = set()
with tarfile.open(archive, mode="r:gz") as source:
    members = source.getmembers()
    for member in members:
        pure = PurePosixPath(member.name)
        if pure.is_absolute() or not pure.parts or any(part in ("", ".", "..") for part in pure.parts):
            raise SystemExit(f"unsafe rollback archive path: {member.name}")
        normalized = str(pure)
        if normalized in seen:
            raise SystemExit(f"duplicate rollback archive path: {normalized}")
        seen.add(normalized)
        if not (member.isfile() or member.isdir()):
            raise SystemExit(f"unsupported rollback archive entry: {normalized}")
    for member in members:
        pure = PurePosixPath(member.name)
        if not pure.parts or pure.parts[0] != "data":
            continue
        target = destination.joinpath(*pure.parts)
        if member.isdir():
            target.mkdir(parents=True, exist_ok=True, mode=0o700)
            os.chmod(target, 0o700)
            continue
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        extracted = source.extractfile(member)
        if extracted is None:
            raise SystemExit(f"rollback archive file is unreadable: {member.name}")
        with open(target, "xb") as output:
            while True:
                block = extracted.read(1024 * 1024)
                if not block:
                    break
                output.write(block)
        os.chmod(target, 0o600)
PY
  python_status=$?
  if [ "$python_status" -ne 0 ]; then rm -rf "$stage"; return "$python_status"; fi
  [ -f "$stage/data/bot.db" ] || { rm -rf "$stage"; echo "rollback database is missing" >&2; return 1; }
  [ "$(sha256sum "$stage/data/bot.db" | awk '{print $1}')" = "$backup_database_sha" ] || {
    rm -rf "$stage"; echo "rollback database digest does not match stopped-state evidence" >&2; return 1
  }
  previous_node_path="$PREVIOUS_RUNTIME/node_modules"
  NODE_PATH="$previous_node_path" "$TIMEOUT_BIN" 20s node - "$stage/data/bot.db" <<'NODE'
const Database=require('better-sqlite3');
const db=new Database(process.argv[2],{readonly:true,fileMustExist:true});
try {
  const integrity=db.pragma('integrity_check');
  if(integrity.length!==1||integrity[0]?.integrity_check!=='ok')throw new Error('rollback database integrity failed');
  if(db.pragma('foreign_key_check').length!==0)throw new Error('rollback database foreign key check failed');
} finally { db.close(); }
NODE
  database_status=$?
  if [ "$database_status" -ne 0 ]; then rm -rf "$stage"; return "$database_status"; fi
  install -d -m 700 "$PROD_BASE/data" || { rm -rf "$stage"; return 1; }
  for name in bot.db bot.db-wal bot.db-shm; do
    rm -f "$PROD_BASE/data/$name.rollback-next" || { rm -rf "$stage"; return 1; }
    if [ -f "$stage/data/$name" ]; then
      cp -p "$stage/data/$name" "$PROD_BASE/data/$name.rollback-next" || { rm -rf "$stage"; return 1; }
    fi
  done
  rm -f "$PROD_BASE/data/bot.db" "$PROD_BASE/data/bot.db-wal" "$PROD_BASE/data/bot.db-shm" \
    || { rm -rf "$stage"; return 1; }
  for name in bot.db bot.db-wal bot.db-shm; do
    [ ! -f "$PROD_BASE/data/$name.rollback-next" ] \
      || mv "$PROD_BASE/data/$name.rollback-next" "$PROD_BASE/data/$name" \
      || { rm -rf "$stage"; return 1; }
  done
  rm -rf "$PROD_BASE/data/garmin-tokens" || { rm -rf "$stage"; return 1; }
  [ ! -d "$stage/data/garmin-tokens" ] \
    || cp -a "$stage/data/garmin-tokens" "$PROD_BASE/data/garmin-tokens" \
    || { rm -rf "$stage"; return 1; }
  node - "$PROD_BASE/data" <<'NODE'
const fs=require('fs');const path=require('path');const directory=process.argv[2];
const stat=fs.lstatSync(directory);
if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('restored data directory is unsafe');
const fsyncFile=(file)=>{
  const descriptor=fs.openSync(file,'r');
  try{fs.fsyncSync(descriptor);}finally{fs.closeSync(descriptor);}
};
for(const name of ['bot.db','bot.db-wal','bot.db-shm']){
  const file=path.join(directory,name);
  if(!fs.existsSync(file))continue;
  const fileStat=fs.lstatSync(file);
  if(!fileStat.isFile()||fileStat.isSymbolicLink()||fileStat.nlink!==1){
    throw new Error(`restored database file is unsafe: ${name}`);
  }
  fsyncFile(file);
}
const tokenRoot=path.join(directory,'garmin-tokens');
if(fs.existsSync(tokenRoot)){
  const pending=[tokenRoot],directories=[];
  while(pending.length>0){
    const current=pending.pop(),currentStat=fs.lstatSync(current);
    if(!currentStat.isDirectory()||currentStat.isSymbolicLink()){
      throw new Error('restored token directory is unsafe');
    }
    directories.push(current);
    for(const name of fs.readdirSync(current)){
      const child=path.join(current,name),childStat=fs.lstatSync(child);
      if(childStat.isSymbolicLink())throw new Error('restored token symlink is unsafe');
      if(childStat.isDirectory())pending.push(child);
      else if(childStat.isFile()&&childStat.nlink===1)fsyncFile(child);
      else throw new Error('restored token entry is unsafe');
    }
  }
  for(const current of directories.reverse())fsyncFile(current);
}
fsyncFile(directory);
NODE
  rm -rf "$stage" || return 1
  start_predecessor || return 1
}

recover_if_needed() {
  if [ -e "$RECOVERY_ARMED_MARKER" ] || [ -L "$RECOVERY_ARMED_MARKER" ]; then
    validate_worker_marker "$RECOVERY_ARMED_MARKER" \
      nexus.promotion-worker-recovery-armed.v1 pre_candidate || {
      echo "worker recovery marker is unsafe or incomplete" >&2
      return 1
    }
  fi
  case "$RECOVERY_PHASE" in
    pre_candidate)
      if [ -e "$CANDIDATE_MARKER" ] || [ -L "$CANDIDATE_MARKER" ]; then
        echo "authoritative pre-candidate recovery conflicts with candidate mutation state" >&2
        return 1
      fi
      journal_update recovering running restarting_predecessor
      start_predecessor || return 1
      ;;
    candidate_authorized)
      validate_authorized_backup || return 1
      journal_update recovering running restoring_exact_authorized_backup
      restore_exact_backup || return 1
      ;;
    *)
      echo "authoritative recovery phase is missing or invalid" >&2
      return 1
      ;;
  esac
  durable_worker_marker "$RECOVERY_MARKER" \
    nexus.promotion-worker-recovery-complete.v1 "$RECOVERY_PHASE" || return 1
}

transaction_complete=false
exit_handler() {
  local status=$?
  trap - EXIT INT TERM HUP
  if [ "$transaction_complete" != true ]; then
    set +e
    if [ -f "$RECOVERY_ARMED_MARKER" ]; then
      journal_update recovery_required recovery_required broker_must_restore_predecessor
    else
      journal_update failed_before_stop failed_before_stop transaction_failed_before_production_stop
    fi
    set -e
  fi
  exit "$status"
}
trap exit_handler EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

# A restarted worker never guesses where to resume a critical section.
# Persisted recovery intent selects the safest deterministic action.
if [ "$COMMAND" = worker-recover ]; then
  if recover_if_needed; then
    journal_update recovery_complete recovered explicit_or_boot_recovery_completed
    transaction_complete=true
    exit 0
  fi
  journal_update recovery_failed recovery_failed explicit_or_boot_recovery_failed
  transaction_complete=true
  exit 1
fi

if [ "$COMMAND" = worker-prepare ]; then
  for stale in "$RECOVERY_ARMED_MARKER" "$STOPPED_MARKER" "$BACKUP_ENV" \
    "$CANDIDATE_MARKER" "$RECOVERY_MARKER"; do
    [ ! -e "$stale" ] && [ ! -L "$stale" ] || {
      echo "worker preparation state is ambiguous; recovery is required" >&2
      exit 75
    }
  done
  [ ! -f "$CONTROL_DIR/recover" ] || {
    echo "owner requested recovery before worker preparation" >&2
    exit 75
  }
  journal_update verifying_predecessor running verifying_exact_predecessor_identity
  verify_predecessor_identity

  journal_update arming_recovery running persisting_recovery_intent_before_first_stop
  durable_worker_marker "$RECOVERY_ARMED_MARKER" \
    nexus.promotion-worker-recovery-armed.v1 pre_candidate
  journal_update stopping_predecessor running stopping_database_owners
  pre_recovery_remaining >/dev/null
  SERVICE_UNAVAILABLE_STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  SERVICE_UNAVAILABLE_STARTED_MONOTONIC="$(monotonic_seconds)"
  stop_predecessor
  durable_worker_marker "$STOPPED_MARKER" \
    nexus.promotion-worker-predecessor-stopped.v1 pre_candidate
  pre_recovery_remaining >/dev/null
  journal_update predecessor_stopped running predecessor_stopped_and_verified

  journal_update creating_backup running creating_exact_stopped_state_backup
  BACKUP_RAW="$WORKER_DIR/backup.raw"
  backup_temporary="$(mktemp "${BACKUP_ENV}.next.XXXXXXXX")"
  rm -f "$BACKUP_RAW"
  PHASE_TIMEOUT_SECONDS="$(pre_recovery_remaining)"
  "$TIMEOUT_BIN" --signal=TERM --kill-after=5s "${PHASE_TIMEOUT_SECONDS}s" bash "$RELEASE_DIR/scripts/remote-create-release-backup.sh" \
    "$PREVIOUS_RUNTIME" "$BACKUP_DIR" "$TARGET_VERSION" "$PM2_BIN" "nexus-hub,content-engine" "$PREPARED_RUNTIME_DIR" \
    > "$BACKUP_RAW"
  for key in NEXUS_BACKUP_FILE NEXUS_BACKUP_SHA256 NEXUS_BACKUP_SIZE_BYTES NEXUS_BACKUP_ARCHIVED_VERSION \
    NEXUS_BACKUP_TARGET_VERSION NEXUS_BACKUP_CREATED_AT NEXUS_BACKUP_DATABASE_SHA256; do
    value="$(sed -n "s/^${key}=//p" "$BACKUP_RAW" | tail -1)"
    [ -n "$value" ] || { echo "backup output is missing $key" >&2; exit 1; }
    printf '%s=%s\n' "$key" "$value" >> "$backup_temporary"
  done
  chmod 600 "$backup_temporary"
  durable_publish_worker_file "$backup_temporary" "$BACKUP_ENV"
  rm -f "$BACKUP_RAW"
  backup_fields="$(read_backup_env "$BACKUP_ENV")" || {
    echo "durable backup evidence is invalid" >&2
    exit 1
  }
  IFS=$'\t' read -r BACKUP_FILE BACKUP_SHA256 BACKUP_SIZE_BYTES BACKUP_ARCHIVED_VERSION \
    BACKUP_TARGET_VERSION BACKUP_CREATED_AT BACKUP_DATABASE_SHA256 <<<"$backup_fields"
  case "$BACKUP_FILE" in "$BACKUP_DIR"/v*.tar.gz) ;; *) echo "backup helper returned an unsafe path" >&2; exit 1 ;; esac
  [[ "$BACKUP_SHA256" =~ ^[a-f0-9]{64}$ && "$BACKUP_DATABASE_SHA256" =~ ^[a-f0-9]{64}$ ]] || { echo "backup identity is invalid" >&2; exit 1; }
  [[ "$BACKUP_SIZE_BYTES" =~ ^[1-9][0-9]*$ ]] || { echo "backup size identity is invalid" >&2; exit 1; }
  [ "$BACKUP_TARGET_VERSION" = "$TARGET_VERSION" ] || { echo "backup target version is invalid" >&2; exit 1; }
  journal_update backup_created running exact_backup_verified
  BACKUP_WINDOW_SECONDS="$(( $(monotonic_seconds) - SERVICE_UNAVAILABLE_STARTED_MONOTONIC ))"

  if [ "$MIGRATION_REQUIRED" = true ]; then
    journal_update final_migration_rehearsal running automatically_verifying_signed_migration_contract
    PHASE_TIMEOUT_SECONDS="$(pre_recovery_remaining)"
    rehearsal_temporary="$(mktemp "${FINAL_REHEARSAL}.next.XXXXXXXX")"
    "$TIMEOUT_BIN" --signal=TERM --kill-after=5s "${PHASE_TIMEOUT_SECONDS}s" bash "$RELEASE_DIR/scripts/remote-production-shape-migration-rehearsal.sh" \
      "$RELEASE_DIR" "$PROD_BASE" "$PREVIOUS_RUNTIME" "$PM2_BIN" \
      "$PREVIOUS_SHA" "$RUNTIME_SHA" "$TARGET_VERSION" "$ARTIFACT_DIGEST" \
      "$REVIEW_EVIDENCE_SHA256" "$MIGRATION_POLICY_SUBJECT_SHA256" "$TRANSACTION_ID" \
      stopped_final stopped > "$rehearsal_temporary"
    FINAL_VALIDATION="$("$TIMEOUT_BIN" --signal=TERM --kill-after=5s 30s node \
      "$RELEASE_DIR/scripts/validate-production-shape-migration-rehearsal.mjs" \
      --root "$RELEASE_DIR" --evidence "$rehearsal_temporary" \
      --predecessor-runtime-sha "$PREVIOUS_SHA" --target-runtime-sha "$RUNTIME_SHA" \
      --target-version "$TARGET_VERSION" --artifact-digest "$ARTIFACT_DIGEST" \
      --review-evidence-sha256 "$REVIEW_EVIDENCE_SHA256" \
      --migration-policy-subject-sha256 "$MIGRATION_POLICY_SUBJECT_SHA256" \
      --promotion-run-id "$TRANSACTION_ID" --phase stopped_final --database-owner-state stopped)"
    read -r FINAL_PENDING_SET_SHA256 FINAL_SOURCE_DATABASE_SHA256 < <(printf '%s' "$FINAL_VALIDATION" | node -e '
      let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{const x=JSON.parse(b);
        process.stdout.write(`${x.pendingMigrationSetSha256} ${x.sourceDatabaseSha256}\n`)})')
    [ "$FINAL_PENDING_SET_SHA256" = "$ONLINE_PENDING_SET_SHA256" ] || {
      echo "final migration pending set differs from owner-authorized online proof" >&2
      exit 1
    }
    [ "$FINAL_SOURCE_DATABASE_SHA256" = "$BACKUP_DATABASE_SHA256" ] || {
      echo "final migration source does not match exact quiescent backup" >&2
      exit 1
    }
    chmod 600 "$rehearsal_temporary"
    durable_publish_worker_file "$rehearsal_temporary" "$FINAL_REHEARSAL"
    journal_update final_migration_verified running signed_migration_identities_automatically_verified
  fi
  prepare_timing_temporary="$(mktemp "$WORKER_DIR/prepare-timing.next.XXXXXXXX")"
  {
    printf 'NEXUS_SERVICE_UNAVAILABLE_STARTED_AT=%s\n' "$SERVICE_UNAVAILABLE_STARTED_AT"
    printf 'NEXUS_SERVICE_UNAVAILABLE_STARTED_MONOTONIC=%s\n' "$SERVICE_UNAVAILABLE_STARTED_MONOTONIC"
    printf 'NEXUS_BACKUP_WINDOW_SECONDS=%s\n' "$BACKUP_WINDOW_SECONDS"
  } > "$prepare_timing_temporary"
  chmod 600 "$prepare_timing_temporary"
  durable_publish_worker_file "$prepare_timing_temporary" "$WORKER_DIR/prepare-timing"
  journal_update candidate_authorization_required running durable_backup_ready_for_root_authorization
  transaction_complete=true
  exit 0
fi

[ "$COMMAND" = worker-promote ] || { echo "unexpected worker command" >&2; exit 64; }
[ "$RECOVERY_PHASE" = candidate_authorized ] || {
  echo "root candidate authorization is missing" >&2
  exit 77
}
validate_worker_marker "$RECOVERY_ARMED_MARKER" \
  nexus.promotion-worker-recovery-armed.v1 pre_candidate \
  && validate_worker_marker "$STOPPED_MARKER" \
    nexus.promotion-worker-predecessor-stopped.v1 pre_candidate || {
  echo "worker stopped-state evidence is missing or ambiguous" >&2
  exit 75
}
[ ! -e "$CANDIDATE_MARKER" ] && [ ! -L "$CANDIDATE_MARKER" ] || {
  echo "candidate mutation state already exists; recovery is required" >&2
  exit 75
}
backup_fields="$(read_backup_env "$BACKUP_ENV")" || {
  echo "durable backup evidence is invalid before candidate authorization" >&2
  exit 1
}
IFS=$'\t' read -r BACKUP_FILE BACKUP_SHA256 BACKUP_SIZE_BYTES BACKUP_ARCHIVED_VERSION \
  BACKUP_TARGET_VERSION BACKUP_CREATED_AT BACKUP_DATABASE_SHA256 <<<"$backup_fields"
validate_authorized_backup
[ "$BACKUP_FILE" = "$AUTHORIZED_BACKUP_FILE" ] \
  && [ "$BACKUP_SHA256" = "$AUTHORIZED_BACKUP_SHA256" ] \
  && [ "$BACKUP_SIZE_BYTES" = "$AUTHORIZED_BACKUP_SIZE_BYTES" ] \
  && [ "$BACKUP_DATABASE_SHA256" = "$AUTHORIZED_BACKUP_DATABASE_SHA256" ] || {
  echo "worker backup evidence differs from root candidate authorization" >&2
  exit 77
}
[ "$BACKUP_TARGET_VERSION" = "$TARGET_VERSION" ] || {
  echo "worker backup target version differs from candidate authorization" >&2
  exit 77
}
[ -f "$WORKER_DIR/prepare-timing" ] && [ ! -L "$WORKER_DIR/prepare-timing" ] || {
  echo "worker preparation timing is missing" >&2
  exit 75
}
IFS=$'\t' read -r SERVICE_UNAVAILABLE_STARTED_AT SERVICE_UNAVAILABLE_STARTED_MONOTONIC \
  BACKUP_WINDOW_SECONDS < <(node - "$WORKER_DIR/prepare-timing" <<'NODE'
const fs=require('fs');const m=new Map();
for(const line of fs.readFileSync(process.argv[2],'utf8').split(/\r?\n/u)){
  if(line==='')continue;const match=line.match(/^([A-Z0-9_]+)=(.*)$/u);
  if(!match||m.has(match[1]))process.exit(1);m.set(match[1],match[2]);
}
if(m.size!==3||!Number.isSafeInteger(Number(m.get('NEXUS_SERVICE_UNAVAILABLE_STARTED_MONOTONIC')))
  ||!Number.isSafeInteger(Number(m.get('NEXUS_BACKUP_WINDOW_SECONDS'))))process.exit(1);
process.stdout.write(`${m.get('NEXUS_SERVICE_UNAVAILABLE_STARTED_AT')}\t${m.get('NEXUS_SERVICE_UNAVAILABLE_STARTED_MONOTONIC')}\t${m.get('NEXUS_BACKUP_WINDOW_SECONDS')}\n`);
NODE
) || { echo "worker preparation timing is invalid" >&2; exit 75; }
[ ! -f "$CONTROL_DIR/recover" ] || { echo "owner requested recovery before candidate mutation" >&2; exit 75; }
pre_recovery_remaining >/dev/null
journal_update mutating_candidate running switching_to_exact_candidate
durable_worker_marker "$CANDIDATE_MARKER" \
  nexus.promotion-worker-candidate-mutated.v1 candidate_authorized
atomic_switch_current "$RELEASE_DIR"
for app in nexus-hub content-engine; do
  if "$TIMEOUT_BIN" 5s "$PM2_BIN" describe "$app" >/dev/null 2>&1; then
    "$TIMEOUT_BIN" 10s "$PM2_BIN" delete "$app" >/dev/null
  fi
done
PHASE_TIMEOUT_SECONDS="$(pre_recovery_remaining)"
env -i HOME="$HOME" PATH="$PATH" NEXUS_RELEASE_DIR="$RELEASE_DIR" NEXUS_RELEASE_BASE_DIR="$PROD_BASE" \
  NEXUS_RELEASE_ROLE=production NEXUS_RELEASE_SHA="$RUNTIME_SHA" SENTRY_RELEASE="$SENTRY_RELEASE" \
  "$TIMEOUT_BIN" --signal=TERM --kill-after=5s "${PHASE_TIMEOUT_SECONDS}s" \
  "$PM2_BIN" start "$RELEASE_DIR/ecosystem.release.config.js" --update-env

availability_health="$(mktemp)"
candidate_available=false
for _ in $(seq 1 8); do
  pre_recovery_remaining >/dev/null
  local_available=false; content_available=false; identity_available=false; public_available=false
  if curl --fail --silent --show-error --connect-timeout 1 --max-time 2 \
      http://127.0.0.1:8200/health > "$availability_health" \
      && node -e 'const fs=require("fs"),x=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(x.status!=="healthy"||x.server?.status!=="online"||x.database!=="connected")process.exit(1)' "$availability_health"; then
    local_available=true
  fi
  if curl --fail --silent --show-error --connect-timeout 1 --max-time 2 http://127.0.0.1:8100/health >/dev/null; then
    content_available=true
  fi
  if [ "$(readlink -f "$PROD_BASE/current")" = "$RELEASE_DIR" ] \
      && "$TIMEOUT_BIN" 3s "$PM2_BIN" jlist | node -e '
        const fs=require("fs");const rows=JSON.parse(fs.readFileSync(0,"utf8"));const root=process.argv[1],sha=process.argv[2];
        for(const [name,cwd] of [["nexus-hub",root],["content-engine",`${root}/content-engine`]]){
          const row=rows.find((entry)=>entry?.name===name),env=row?.pm2_env??{};
          if(env.status!=="online"||env.pm_cwd!==cwd||(env.NEXUS_RELEASE_SHA||env.GIT_COMMIT)!==sha||env.SENTRY_RELEASE!==sha)process.exit(1);
        }' "$RELEASE_DIR" "$RUNTIME_SHA"; then
    identity_available=true
  fi
  if curl --fail --silent --show-error --connect-timeout 2 --max-time 5 "$PUBLIC_BASE_URL/health" > "$availability_health" \
      && node -e 'const fs=require("fs"),x=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(x.status!=="healthy"||x.server?.status!=="online"||x.database!=="connected")process.exit(1)' "$availability_health"; then
    public_available=true
  fi
  if [ "$local_available" = true ] && [ "$content_available" = true ] \
      && [ "$identity_available" = true ] && [ "$public_available" = true ]; then
    candidate_available=true
    break
  fi
  sleep 1
done
rm -f "$availability_health"
[ "$candidate_available" = true ] || { echo "candidate did not restore customer availability" >&2; exit 1; }
FINAL_UNAVAILABILITY_SECONDS="$(( $(monotonic_seconds) - SERVICE_UNAVAILABLE_STARTED_MONOTONIC ))"
[ "$FINAL_UNAVAILABILITY_SECONDS" -le 60 ] || { echo "candidate availability exceeded the reserved recovery boundary" >&2; exit 1; }
CANDIDATE_AVAILABLE_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
# This is the leading backup portion of the one customer outage. It is useful
# diagnostically but must not be added to total unavailability a second time.
BACKUP_OUTAGE_SECONDS="$BACKUP_WINDOW_SECONDS"
TOTAL_UNAVAILABILITY_SECONDS="$FINAL_UNAVAILABILITY_SECONDS"
journal_update candidate_available running customer_availability_restored_before_60_second_soak

journal_update verifying_candidate running verifying_loopback_public_and_restart_stability
"$TIMEOUT_BIN" --signal=TERM --kill-after=5s 180s bash "$RELEASE_DIR/scripts/remote-release-readiness.sh" \
  --role production --base-dir "$PROD_BASE" --release-dir "$RELEASE_DIR" \
  --runtime-sha "$RUNTIME_SHA" --pm2-bin "$PM2_BIN" --node-bin /usr/bin/node \
  --output "$WORKER_DIR/readiness-production.json" \
  --stability-seconds "$STABILITY_SECONDS"
read -r SOAK_STARTED_AT SOAK_COMPLETED_AT SOAK_OBSERVED_SECONDS < <(node - \
  "$WORKER_DIR/readiness-production.json" "$RUNTIME_SHA" "$STABILITY_SECONDS" <<'NODE'
const fs = require('fs');
const [file, runtimeSha, requiredSecondsRaw] = process.argv.slice(2);
const value = JSON.parse(fs.readFileSync(file, 'utf8'));
const requiredSeconds = Number(requiredSecondsRaw);
const canonical = (timestamp) => typeof timestamp === 'string'
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(timestamp)
  && new Date(Date.parse(timestamp)).toISOString() === timestamp.replace('Z', '.000Z');
if (value.schema !== 'nexus.release-readiness.v1' || value.role !== 'production'
    || value.runtimeSha !== runtimeSha || value.stabilitySeconds !== requiredSeconds
    || !Number.isSafeInteger(value.stabilityObservedSeconds)
    || value.stabilityObservedSeconds < requiredSeconds
    || value.stabilityObservedSeconds > requiredSeconds + 120
    || !canonical(value.stabilityStartedAt) || !canonical(value.stabilityCompletedAt)
    || Date.parse(value.stabilityCompletedAt) < Date.parse(value.stabilityStartedAt)) {
  process.exit(1);
}
process.stdout.write(`${value.stabilityStartedAt} ${value.stabilityCompletedAt} ${value.stabilityObservedSeconds}\n`);
NODE
) || { echo "production readiness did not emit authoritative soak timing" >&2; exit 1; }

auth_header="$(mktemp)"; local_health="$(mktemp)"; public_health="$(mktemp)"; public_snapshot="$(mktemp)"
chmod 600 "$auth_header" "$local_health" "$public_health" "$public_snapshot"
require_session="$(awk -F= '$1=="PORTAL_REQUIRE_SESSION_AUTH" {print substr($0,index($0,"=")+1); exit}' "$PROD_BASE/.env" 2>/dev/null || true)"
if [ "$require_session" = true ]; then
  portal_token="$(cd "$RELEASE_DIR" && DOTENV_CONFIG_PATH="$PROD_BASE/.env" node -r dotenv/config \
    dist/tools/portal-session-token.js --actor release-promotion@nexushub.me --scope admin --ttl-ms 300000 --json \
    | node -e 'let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>process.stdout.write(JSON.parse(b).token||""))')"
  [ -n "$portal_token" ] || { echo "production session token generation failed" >&2; exit 1; }
  printf 'x-portal-session: %s\n' "$portal_token" > "$auth_header"
else
  portal_token="$(awk -F= '$1=="PORTAL_TOKEN" {print substr($0,index($0,"=")+1); exit}' "$PROD_BASE/.env" 2>/dev/null || true)"
  [ -n "$portal_token" ] || { echo "production portal auth credential is missing" >&2; exit 1; }
  printf 'Authorization: Bearer %s\n' "$portal_token" > "$auth_header"
fi
unset portal_token

backend_ok=false; content_ok=false; identity_ok=false; public_health_ok=false; public_snapshot_ok=false
for _ in $(seq 1 15); do
  [ ! -f "$CONTROL_DIR/recover" ] || { echo "owner requested recovery during candidate verification" >&2; exit 75; }
  backend_ok=false; content_ok=false; identity_ok=false; public_health_ok=false; public_snapshot_ok=false
  if curl --fail --silent --show-error --connect-timeout 1 --max-time 5 http://127.0.0.1:8200/health > "$local_health" \
      && node -e 'const fs=require("fs"),x=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(x.status!=="healthy"||x.server?.status!=="online"||x.database!=="connected")process.exit(1)' "$local_health"; then backend_ok=true; fi
  if curl --fail --silent --show-error --connect-timeout 1 --max-time 5 http://127.0.0.1:8100/health >/dev/null; then content_ok=true; fi
  if [ "$(readlink -f "$PROD_BASE/current")" = "$RELEASE_DIR" ] \
      && "$TIMEOUT_BIN" 3s "$PM2_BIN" jlist | node -e '
        const fs=require("fs");const rows=JSON.parse(fs.readFileSync(0,"utf8"));const root=process.argv[1],sha=process.argv[2];
        for(const [name,cwd] of [["nexus-hub",root],["content-engine",`${root}/content-engine`]]){
          const row=rows.find((entry)=>entry?.name===name),env=row?.pm2_env??{};
          if(env.status!=="online"||env.pm_cwd!==cwd||(env.NEXUS_RELEASE_SHA||env.GIT_COMMIT)!==sha
              ||env.SENTRY_RELEASE!==sha)process.exit(1);
        }' "$RELEASE_DIR" "$RUNTIME_SHA"; then identity_ok=true; fi
  if curl --fail --silent --show-error --connect-timeout 2 --max-time 10 "$PUBLIC_BASE_URL/health" > "$public_health" \
      && node -e 'const fs=require("fs"),x=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(x.status!=="healthy"||x.server?.status!=="online"||x.database!=="connected")process.exit(1)' "$public_health"; then public_health_ok=true; fi
  if curl --fail --silent --show-error --connect-timeout 2 --max-time 15 -H @"$auth_header" \
      "$PUBLIC_BASE_URL/api/snapshot" > "$public_snapshot" \
      && node -e 'const fs=require("fs"),x=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(x.version!==process.argv[2])process.exit(1)' "$public_snapshot" "$TARGET_VERSION"; then public_snapshot_ok=true; fi
  if [ "$backend_ok" = true ] && [ "$content_ok" = true ] && [ "$identity_ok" = true ] \
      && [ "$public_health_ok" = true ] && [ "$public_snapshot_ok" = true ]; then break; fi
  sleep 2
done
[ ! -f "$CONTROL_DIR/recover" ] || { echo "owner requested recovery before transaction completion" >&2; exit 75; }
rm -f "$auth_header" "$local_health" "$public_health" "$public_snapshot"
[ "$backend_ok" = true ] && [ "$content_ok" = true ] && [ "$identity_ok" = true ] \
  && [ "$public_health_ok" = true ] && [ "$public_snapshot_ok" = true ] || {
  echo "candidate failed exact loopback/public readiness" >&2
  exit 1
}
pm2_save_durable

CUTOVER_SECONDS="$(( $(monotonic_seconds) - CUTOVER_STARTED_MONOTONIC ))"
result_temporary="$(mktemp "${RESULT_ENV}.next.XXXXXXXX")"
{
  printf 'NEXUS_TRANSACTION_ID=%s\n' "$TRANSACTION_ID"
  printf 'NEXUS_RUNTIME_SHA=%s\n' "$RUNTIME_SHA"
  printf 'NEXUS_ARTIFACT_DIGEST=%s\n' "$ARTIFACT_DIGEST"
  printf 'NEXUS_INSTALLED_RUNTIME_DIGEST=%s\n' "$INSTALLED_RUNTIME_DIGEST"
  printf 'NEXUS_TARGET_VERSION=%s\n' "$TARGET_VERSION"
  printf 'NEXUS_SENTRY_RELEASE=%s\n' "$SENTRY_RELEASE"
  printf 'NEXUS_CUTOVER_STARTED_AT=%s\n' "$CUTOVER_STARTED_AT"
  printf 'NEXUS_SERVICE_UNAVAILABLE_STARTED_AT=%s\n' "$SERVICE_UNAVAILABLE_STARTED_AT"
  printf 'NEXUS_CANDIDATE_AVAILABLE_AT=%s\n' "$CANDIDATE_AVAILABLE_AT"
  printf 'NEXUS_CUTOVER_SECONDS=%s\n' "$CUTOVER_SECONDS"
  printf 'NEXUS_BACKUP_WINDOW_SECONDS=%s\n' "$BACKUP_WINDOW_SECONDS"
  printf 'NEXUS_BACKUP_OUTAGE_SECONDS=%s\n' "$BACKUP_OUTAGE_SECONDS"
  printf 'NEXUS_FINAL_UNAVAILABILITY_SECONDS=%s\n' "$FINAL_UNAVAILABILITY_SECONDS"
  printf 'NEXUS_TOTAL_UNAVAILABILITY_SECONDS=%s\n' "$TOTAL_UNAVAILABILITY_SECONDS"
  printf 'NEXUS_VERIFICATION_SOAK_SECONDS=%s\n' "$STABILITY_SECONDS"
  printf 'NEXUS_SOAK_STARTED_AT=%s\n' "$SOAK_STARTED_AT"
  printf 'NEXUS_SOAK_COMPLETED_AT=%s\n' "$SOAK_COMPLETED_AT"
  printf 'NEXUS_SOAK_OBSERVED_SECONDS=%s\n' "$SOAK_OBSERVED_SECONDS"
  cat "$BACKUP_ENV"
} > "$result_temporary"
chmod 600 "$result_temporary"
durable_publish_worker_file "$result_temporary" "$RESULT_ENV"
journal_update completed completed exact_candidate_verified
transaction_complete=true
exit 0
