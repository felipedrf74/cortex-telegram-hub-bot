#!/usr/bin/env bash
# Root broker for the persistent promotion worker. Application operations run
# as dominguez, while authority, recovery intent, terminal status, and escrow
# confirmation remain root-owned and cannot be forged by that account.
set -euo pipefail
umask 077

ACTION="${1:-}"
TRANSACTION_ID="${2:-}"
STATE_ROOT="${NEXUS_PROMOTION_STATE_ROOT:-/var/lib/nexus-release-promotion}"
AUTH_BIN="${NEXUS_PROMOTION_AUTH_BIN:-/usr/local/libexec/nexus-promotion-authorization.mjs}"
OWNER_PUBLIC_KEY="${NEXUS_PROMOTION_OWNER_PUBLIC_KEY:-/etc/nexus-release/owner-promotion-public-key.pem}"
TRANSACTION_SCRIPT="${NEXUS_PROMOTION_TRANSACTION_SCRIPT:-/usr/local/libexec/nexus-release-promotion-transaction}"
WORKER_USER="${NEXUS_PROMOTION_WORKER_USER:-dominguez}"
RUNUSER_BIN="${NEXUS_PROMOTION_RUNUSER_BIN:-/usr/sbin/runuser}"
TIMEOUT_BIN="${NEXUS_PROMOTION_TIMEOUT_BIN:-/usr/bin/timeout}"
FLOCK_BIN="${NEXUS_PROMOTION_FLOCK_BIN:-/usr/bin/flock}"
RELEASE_SONAR_LOCK="${NEXUS_PROMOTION_RELEASE_SONAR_LOCK:-/run/lock/nexus-release-sonar.lock}"
DR_BACKUP_BIN="${NEXUS_PROMOTION_DR_BACKUP_BIN:-/usr/local/libexec/nexus-application-dr/application-dr-backup.sh}"
DR_CONFIG="${NEXUS_PROMOTION_DR_CONFIG:-/etc/nexus-application-dr/backup.env}"
TRUSTED_ATTESTOR="${NEXUS_PROMOTION_TRUSTED_ATTESTOR:-/usr/local/libexec/nexus-trusted-release-runtime-attestation.mjs}"
OUTAGE_BUDGET_SECONDS=120
PRE_RECOVERY_BUDGET_SECONDS=60
SYSTEM_NODE_BIN="${NEXUS_PROMOTION_NODE_BIN:-/usr/bin/node}"

if [ "$EUID" -ne 0 ] && [ "${NEXUS_RELEASE_TEST_MODE:-0}" != "1" ]; then
  echo "promotion worker broker must run as root" >&2
  exit 77
fi
if [ "${NEXUS_RELEASE_TEST_MODE:-0}" = "1" ]; then SYSTEM_NODE_BIN="$(command -v node)"; fi
case "$ACTION" in run|recover) ;; *) echo "Usage: nexus-release-promotion-worker-control <run|recover> <transaction-id>" >&2; exit 64 ;; esac
[[ "$TRANSACTION_ID" =~ ^[0-9]{8}T[0-9]{6}Z-[0-9]+-[a-f0-9]{12}$ ]] || {
  echo "invalid promotion transaction id" >&2
  exit 64
}
[ -x "$FLOCK_BIN" ] || { echo "flock is required by the promotion broker" >&2; exit 1; }
case "$RELEASE_SONAR_LOCK" in
  /run/lock/nexus-release-sonar.lock) ;;
  *) [ "${NEXUS_RELEASE_TEST_MODE:-0}" = "1" ] || { echo "unsafe release/Sonar lock path" >&2; exit 64; } ;;
esac
[ -f "$RELEASE_SONAR_LOCK" ] && [ ! -L "$RELEASE_SONAR_LOCK" ] || {
  echo "precreated shared release/Sonar mutex is unavailable" >&2
  exit 1
}
if [ "${NEXUS_RELEASE_TEST_MODE:-0}" != "1" ]; then
  [ "$(stat -c '%U:%G:%a' "$RELEASE_SONAR_LOCK")" = "root:$WORKER_USER:660" ] || {
    echo "shared release/Sonar mutex ownership or mode is unsafe" >&2
    exit 1
  }
fi
# Read/write open requires the existing inode and does not truncate it. The
# tmpfiles.d contract, not either contender, creates this cross-service lock.
exec 8<>"$RELEASE_SONAR_LOCK"
"$FLOCK_BIN" -n 8 || { echo "shared release/Sonar mutex is unavailable" >&2; exit 75; }

REQUEST_ENVELOPE="$STATE_ROOT/requests/$TRANSACTION_ID.envelope.json"
REQUEST="$STATE_ROOT/requests/$TRANSACTION_ID.json"
TRANSACTION_DIR="$STATE_ROOT/transactions/$TRANSACTION_ID"
AUTHORITY="$TRANSACTION_DIR/authority.json"
ACTIVE="$STATE_ROOT/active.json"
WORKER_DIR="$TRANSACTION_DIR/worker"
CONTROL_DIR="$TRANSACTION_DIR/control"
AUTHORITATIVE_DIR="$TRANSACTION_DIR/state"
JOURNAL="$AUTHORITATIVE_DIR/journal.json"
RECOVERY_INTENT="$AUTHORITATIVE_DIR/recovery-armed"
RECOVERY_RESULT="$AUTHORITATIVE_DIR/recovery-result.json"
ESCROW_CONFIRMATION="$AUTHORITATIVE_DIR/escrow-confirmation.json"
SEALED_RESULT="$AUTHORITATIVE_DIR/result.env"
CUTOVER_TIMING="$AUTHORITATIVE_DIR/cutover-timing.json"
WORKER_RECOVERY_ARMED="$WORKER_DIR/recovery-armed"
RESULT_ENV="$WORKER_DIR/result.env"

root_own() {
  if [ "$EUID" -eq 0 ] && [ "${NEXUS_RELEASE_TEST_MODE:-0}" != "1" ]; then chown root:root "$@"; fi
}

for required in "$REQUEST_ENVELOPE" "$REQUEST" "$AUTHORITY" "$ACTIVE" "$TRANSACTION_SCRIPT" "$AUTH_BIN" "$OWNER_PUBLIC_KEY"; do
  [ -f "$required" ] && [ ! -L "$required" ] || { echo "promotion worker authority is incomplete" >&2; exit 1; }
done
if [ "${NEXUS_RELEASE_TEST_MODE:-0}" != "1" ]; then
  [ -f "$TRUSTED_ATTESTOR" ] && [ ! -L "$TRUSTED_ATTESTOR" ] || {
    echo "root-installed trusted release attestor is unavailable" >&2
    exit 1
  }
fi
[ -d "$WORKER_DIR" ] && [ -d "$CONTROL_DIR" ] && [ -d "$AUTHORITATIVE_DIR" ] || {
  echo "promotion worker state is incomplete" >&2
  exit 1
}
chmod 700 "$AUTHORITATIVE_DIR"
root_own "$AUTHORITATIVE_DIR"

verification="$("$AUTH_BIN" verify-request --input "$REQUEST_ENVELOPE" --public-key "$OWNER_PUBLIC_KEY" --allow-expired)" || {
  echo "promotion worker rejected invalid owner authority" >&2
  exit 77
}
IFS=$'\t' read -r verified_id request_sha envelope_sha < <(printf '%s' "$verification" | node -e '
  let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{
    const x=JSON.parse(b);process.stdout.write(`${x.transactionId}\t${x.payloadSha256}\t${x.envelopeSha256}\n`);
  });')
[ "$verified_id" = "$TRANSACTION_ID" ] || { echo "promotion worker transaction authority mismatch" >&2; exit 77; }
node - "$ACTIVE" "$AUTHORITY" "$TRANSACTION_ID" "$request_sha" "$envelope_sha" <<'NODE'
const fs = require('fs');
const [activePath, authorityPath, transactionId, requestSha256, envelopeSha256] = process.argv.slice(2);
const active = JSON.parse(fs.readFileSync(activePath, 'utf8'));
const authority = JSON.parse(fs.readFileSync(authorityPath, 'utf8'));
for (const value of [active, authority]) {
  if (value.transactionId !== transactionId || value.requestSha256 !== requestSha256
      || value.envelopeSha256 !== envelopeSha256) process.exit(1);
}
NODE

IFS=$'\t' read -r PROD_BASE PREDECESSOR_RUNTIME PREDECESSOR_SHA PREDECESSOR_ARTIFACT_DIGEST \
  PREDECESSOR_INSTALLED_RUNTIME_DIGEST TARGET_RUNTIME TARGET_SHA SENTRY_RELEASE ARTIFACT_DIGEST \
  INSTALLED_RUNTIME_DIGEST BACKUP_DIR PM2_BIN < <(node - "$REQUEST" <<'NODE'
const fs=require('fs');const x=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const values=[x.productionBase,x.predecessor.runtime,x.predecessor.sha,x.predecessor.artifactDigest,
  x.predecessor.installedRuntimeDigest,x.target.runtime,x.target.sha,x.target.sentryRelease,
  x.target.artifactDigest,x.target.installedRuntimeDigest,x.backupDir,x.pm2Bin];
if(values.some((v)=>typeof v!=='string'||v.includes('\t')||v.includes('\n')))process.exit(1);
process.stdout.write(`${values.join('\t')}\n`);
NODE
)
if [ "${NEXUS_RELEASE_TEST_MODE:-0}" = "1" ] && [ -n "${NEXUS_PROMOTION_TEST_ROOT:-}" ]; then
  PROD_BASE="$NEXUS_PROMOTION_TEST_ROOT/production"
  PREDECESSOR_RUNTIME="$PROD_BASE/releases/previous-runtime"
  TARGET_RUNTIME="$PROD_BASE/releases/target-runtime"
  BACKUP_DIR="$NEXUS_PROMOTION_TEST_ROOT/backups"
  PM2_BIN="$NEXUS_PROMOTION_TEST_ROOT/bin/pm2"
fi

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

trusted_attest() {
  local mode="$1" runtime="$2" sha="$3" artifact="$4" installed="$5" args group_id
  if [ "${NEXUS_RELEASE_TEST_MODE:-0}" = "1" ]; then return 0; fi
  group_id="$(id -g "$WORKER_USER")"
  args=("$mode" --root "$runtime" --base "$PROD_BASE" --runtime-sha "$sha" \
    --artifact-digest "$artifact" --installed-runtime-digest "$installed" --group-id "$group_id")
  "$SYSTEM_NODE_BIN" "$TRUSTED_ATTESTOR" "${args[@]}" >/dev/null
}

prepare_exact_runtimes() {
  if [ "${NEXUS_RELEASE_TEST_MODE:-0}" = "1" ]; then return 0; fi
  # Seal first, then attest again from root-owned code. Candidate code cannot
  # change between this boundary and the sequential worker execution.
  trusted_attest seal "$PREDECESSOR_RUNTIME" "$PREDECESSOR_SHA" \
    "$PREDECESSOR_ARTIFACT_DIGEST" "$PREDECESSOR_INSTALLED_RUNTIME_DIGEST"
  trusted_attest seal "$TARGET_RUNTIME" "$TARGET_SHA" "$ARTIFACT_DIGEST" "$INSTALLED_RUNTIME_DIGEST"
  "$RUNUSER_BIN" -u "$WORKER_USER" -- /bin/bash "$TARGET_RUNTIME/scripts/remote-release-capacity.sh" \
    --role production --base-dir "$PROD_BASE" --pm2-bin "$PM2_BIN"
  "$RUNUSER_BIN" -u "$WORKER_USER" -- /bin/bash "$TARGET_RUNTIME/scripts/remote-release-preflight.sh" \
    --role production --base-dir "$PROD_BASE" --release-dir "$TARGET_RUNTIME" --node-bin /usr/bin/node
}

write_cutover_timing() {
  local started_monotonic started_at boot_id output="$CUTOVER_TIMING.next"
  started_monotonic="$(monotonic_seconds)"
  started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  boot_id="$(cat /proc/sys/kernel/random/boot_id 2>/dev/null || printf test-boot)"
  rm -f "$output"
  node - "$output" "$started_at" "$started_monotonic" "$boot_id" \
    "$PRE_RECOVERY_BUDGET_SECONDS" "$OUTAGE_BUDGET_SECONDS" <<'NODE'
const fs=require('fs');const [output,startedAt,startedRaw,bootId,phaseRaw,budgetRaw]=process.argv.slice(2);
const started=Number(startedRaw),phase=Number(phaseRaw),budget=Number(budgetRaw);
fs.writeFileSync(output,`${JSON.stringify({schema:'nexus.promotion-cutover-timing.v1',startedAt,
 startedMonotonicSeconds:started,preRecoveryDeadlineMonotonicSeconds:started+phase,
 outageDeadlineMonotonicSeconds:started+budget,bootId},null,2)}\n`,{mode:0o600,flag:'wx'});
NODE
  chmod 600 "$output"; root_own "$output"; mv -f "$output" "$CUTOVER_TIMING"
}

read_cutover_timing() {
  node - "$CUTOVER_TIMING" <<'NODE'
const fs=require('fs');const x=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
if(x.schema!=='nexus.promotion-cutover-timing.v1'||!Number.isSafeInteger(x.startedMonotonicSeconds)
 ||!Number.isSafeInteger(x.preRecoveryDeadlineMonotonicSeconds)||!Number.isSafeInteger(x.outageDeadlineMonotonicSeconds)
 ||x.preRecoveryDeadlineMonotonicSeconds-x.startedMonotonicSeconds!==60
 ||x.outageDeadlineMonotonicSeconds-x.startedMonotonicSeconds!==120)process.exit(1);
process.stdout.write(`${x.startedAt}\t${x.startedMonotonicSeconds}\t${x.preRecoveryDeadlineMonotonicSeconds}\t${x.outageDeadlineMonotonicSeconds}\t${x.bootId}\n`);
NODE
}

journal_status() {
  [ -f "$JOURNAL" ] || return 1
  node - "$JOURNAL" "$TRANSACTION_ID" "$request_sha" <<'NODE'
const fs=require('fs');const [file,id,digest]=process.argv.slice(2);const x=JSON.parse(fs.readFileSync(file,'utf8'));
if(x.schema!=='nexus.promotion-transaction-journal.v1'||x.transactionId!==id||x.requestSha256!==digest)process.exit(1);
process.stdout.write(String(x.status||''));
NODE
}

write_journal() {
  local phase="$1" status="$2" message="$3" previous_started="" output="$JOURNAL.next"
  if [ -f "$JOURNAL" ]; then
    previous_started="$(node -e 'const x=require(process.argv[1]);process.stdout.write(x.startedAt||"")' "$JOURNAL")"
  fi
  rm -f "$output"
  node - "$output" "$REQUEST" "$request_sha" "$phase" "$status" "$message" "$previous_started" \
    "$RECOVERY_INTENT" "$ESCROW_CONFIRMATION" "$RECOVERY_RESULT" <<'NODE'
const fs=require('fs');
const [output,requestPath,requestSha256,phase,status,message,previousStarted,recoveryPath,escrowPath,recoveryResultPath]=process.argv.slice(2);
const request=JSON.parse(fs.readFileSync(requestPath,'utf8'));const now=new Date().toISOString();
const terminal=['completed','recovered','failed_before_stop','recovery_failed'].includes(status);
let recovery=null;try{recovery=JSON.parse(fs.readFileSync(recoveryResultPath,'utf8'));}catch{}
fs.writeFileSync(output,`${JSON.stringify({
  schema:'nexus.promotion-transaction-journal.v1',transactionId:request.transactionId,requestSha256,
  phase,status,message,startedAt:previousStarted||now,updatedAt:now,completedAt:terminal?now:null,
  predecessor:request.predecessor,target:request.target,sentryRelease:request.target.sentryRelease,
  recoveryArmed:fs.existsSync(recoveryPath),escrowConfirmed:fs.existsSync(escrowPath),recovery,
},null,2)}\n`,{mode:0o600,flag:'wx'});
NODE
  chmod 600 "$output"
  root_own "$output"
  mv -f "$output" "$JOURNAL"
}

invoke_worker() {
  local mode="$1"
  local timing started_at started_mono phase_deadline outage_deadline boot_id
  timing="$(read_cutover_timing)" || { echo "authoritative cutover timing is invalid" >&2; return 1; }
  IFS=$'\t' read -r started_at started_mono phase_deadline outage_deadline boot_id <<<"$timing"
  if [ "${NEXUS_RELEASE_TEST_MODE:-0}" = "1" ]; then
    NEXUS_PROMOTION_STATE_ROOT="$STATE_ROOT" NEXUS_PROMOTION_REQUEST_SHA256="$request_sha" \
      NEXUS_PROMOTION_CUTOVER_STARTED_AT="$started_at" \
      NEXUS_PROMOTION_CUTOVER_STARTED_MONOTONIC="$started_mono" \
      NEXUS_PROMOTION_PRE_RECOVERY_DEADLINE_MONOTONIC="$phase_deadline" \
      NEXUS_PROMOTION_OUTAGE_DEADLINE_MONOTONIC="$outage_deadline" \
      bash "$TRANSACTION_SCRIPT" "$mode" "$TRANSACTION_ID"
  else
    "$RUNUSER_BIN" -u "$WORKER_USER" -- /usr/bin/env \
      NEXUS_PROMOTION_STATE_ROOT="$STATE_ROOT" \
      NEXUS_PROMOTION_REQUEST_SHA256="$request_sha" \
      NEXUS_PROMOTION_CUTOVER_STARTED_AT="$started_at" \
      NEXUS_PROMOTION_CUTOVER_STARTED_MONOTONIC="$started_mono" \
      NEXUS_PROMOTION_PRE_RECOVERY_DEADLINE_MONOTONIC="$phase_deadline" \
      NEXUS_PROMOTION_OUTAGE_DEADLINE_MONOTONIC="$outage_deadline" \
      /bin/bash -s -- "$mode" "$TRANSACTION_ID" < "$TRANSACTION_SCRIPT"
  fi
}

invoke_recovery() {
  local timing started_at started_mono phase_deadline outage_deadline boot_id current_boot current_mono remaining timeout_seconds
  timing="$(read_cutover_timing)" || { echo "authoritative cutover timing is invalid" >&2; return 1; }
  IFS=$'\t' read -r started_at started_mono phase_deadline outage_deadline boot_id <<<"$timing"
  current_boot="$(cat /proc/sys/kernel/random/boot_id 2>/dev/null || printf test-boot)"
  current_mono="$(monotonic_seconds)"
  if [ "$current_boot" = "$boot_id" ] && [ "$current_mono" -lt "$outage_deadline" ]; then
    remaining=$((outage_deadline - current_mono))
    timeout_seconds="$remaining"
  else
    # A reboot resets the monotonic clock, and an already-breached deadline must
    # never suppress recovery. The journal remains non-compliant until a drill
    # proves observed outage-to-healthy time.
    timeout_seconds=120
  fi
  [ "$timeout_seconds" -ge 1 ] || timeout_seconds=1
  trusted_attest verify "$PREDECESSOR_RUNTIME" "$PREDECESSOR_SHA" \
    "$PREDECESSOR_ARTIFACT_DIGEST" "$PREDECESSOR_INSTALLED_RUNTIME_DIGEST" || return 1
  if [ "${NEXUS_RELEASE_TEST_MODE:-0}" = "1" ]; then
    "$TIMEOUT_BIN" --signal=TERM --kill-after=5s "${timeout_seconds}s" \
      env NEXUS_PROMOTION_STATE_ROOT="$STATE_ROOT" NEXUS_PROMOTION_REQUEST_SHA256="$request_sha" \
      NEXUS_PROMOTION_CUTOVER_STARTED_AT="$started_at" \
      NEXUS_PROMOTION_CUTOVER_STARTED_MONOTONIC="$started_mono" \
      NEXUS_PROMOTION_OUTAGE_DEADLINE_MONOTONIC="$outage_deadline" \
      bash "$TRANSACTION_SCRIPT" worker-recover "$TRANSACTION_ID"
  else
    "$TIMEOUT_BIN" --signal=TERM --kill-after=5s "${timeout_seconds}s" \
      "$RUNUSER_BIN" -u "$WORKER_USER" -- /usr/bin/env \
      NEXUS_PROMOTION_STATE_ROOT="$STATE_ROOT" \
      NEXUS_PROMOTION_REQUEST_SHA256="$request_sha" \
      NEXUS_PROMOTION_CUTOVER_STARTED_AT="$started_at" \
      NEXUS_PROMOTION_CUTOVER_STARTED_MONOTONIC="$started_mono" \
      NEXUS_PROMOTION_OUTAGE_DEADLINE_MONOTONIC="$outage_deadline" \
      /bin/bash -s -- worker-recover "$TRANSACTION_ID" < "$TRANSACTION_SCRIPT"
  fi
}

seal_recovery_result() {
  local timing started_at started_mono phase_deadline outage_deadline boot_id current_boot current_mono healthy_at elapsed source output
  timing="$(read_cutover_timing)" || return 1
  IFS=$'\t' read -r started_at started_mono phase_deadline outage_deadline boot_id <<<"$timing"
  current_boot="$(cat /proc/sys/kernel/random/boot_id 2>/dev/null || printf test-boot)"
  current_mono="$(monotonic_seconds)"
  healthy_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  if [ "$current_boot" = "$boot_id" ] && [ "$current_mono" -ge "$started_mono" ]; then
    elapsed=$((current_mono - started_mono)); source=monotonic
  else
    elapsed="$(node -e 'const a=Date.parse(process.argv[1]),b=Date.parse(process.argv[2]);process.stdout.write(String(Math.max(0,Math.floor((b-a)/1000))))' "$started_at" "$healthy_at")"
    source=wall_clock_after_reboot
  fi
  output="$RECOVERY_RESULT.next"; rm -f "$output"
  node - "$output" "$started_at" "$healthy_at" "$elapsed" "$source" <<'NODE'
const fs=require('fs');const [output,outageStartedAt,predecessorHealthyAt,elapsedRaw,timingSource]=process.argv.slice(2);
const elapsed=Number(elapsedRaw);fs.writeFileSync(output,`${JSON.stringify({
 schema:'nexus.promotion-recovery-result.v1',outageStartedAt,predecessorHealthyAt,
 outageToHealthySeconds:elapsed,targetSeconds:120,targetMet:elapsed<=120,timingSource,
},null,2)}\n`,{mode:0o600,flag:'wx'});
NODE
  chmod 600 "$output"; root_own "$output"; mv -f "$output" "$RECOVERY_RESULT"
}

recover_and_record() {
  invoke_recovery || return 1
  seal_recovery_result
}

read_and_validate_result() {
  local result_path="${1:-$SEALED_RESULT}"
  [ -f "$result_path" ] && [ ! -L "$result_path" ] || { echo "promotion worker result is missing" >&2; return 1; }
  node - "$result_path" "$TRANSACTION_ID" "$TARGET_SHA" "$SENTRY_RELEASE" "$ARTIFACT_DIGEST" "$INSTALLED_RUNTIME_DIGEST" "$BACKUP_DIR" <<'NODE'
const fs=require('fs');const [file,id,sha,sentry,artifact,installedDigest,backupDir]=process.argv.slice(2);const m=new Map();
for(const line of fs.readFileSync(file,'utf8').split(/\r?\n/u)){
 if(line==='')continue;const x=line.match(/^([A-Z0-9_]+)=(.*)$/u);
 if(!x||m.has(x[1]))process.exit(1);m.set(x[1],x[2]);
}
const integer=(key)=>/^(0|[1-9][0-9]*)$/u.test(m.get(key)||'');
const timestamp=(key)=>/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(m.get(key)||'')
  && Number.isFinite(Date.parse(m.get(key)));
if(m.get('NEXUS_TRANSACTION_ID')!==id||m.get('NEXUS_RUNTIME_SHA')!==sha
  ||m.get('NEXUS_SENTRY_RELEASE')!==sentry||m.get('NEXUS_ARTIFACT_DIGEST')!==artifact
  ||m.get('NEXUS_INSTALLED_RUNTIME_DIGEST')!==installedDigest
  ||m.get('NEXUS_VERIFICATION_SOAK_SECONDS')!=='60'
  ||!['NEXUS_CUTOVER_SECONDS','NEXUS_BACKUP_WINDOW_SECONDS','NEXUS_FINAL_UNAVAILABILITY_SECONDS','NEXUS_TOTAL_UNAVAILABILITY_SECONDS','NEXUS_SOAK_OBSERVED_SECONDS'].every(integer)
  ||m.get('NEXUS_BACKUP_OUTAGE_SECONDS')!==m.get('NEXUS_BACKUP_WINDOW_SECONDS')
  ||m.get('NEXUS_FINAL_UNAVAILABILITY_SECONDS')!==m.get('NEXUS_TOTAL_UNAVAILABILITY_SECONDS')
  ||Number(m.get('NEXUS_SOAK_OBSERVED_SECONDS'))<60
  ||Number(m.get('NEXUS_SOAK_OBSERVED_SECONDS'))>180
  ||Number(m.get('NEXUS_TOTAL_UNAVAILABILITY_SECONDS'))>60
  ||!['NEXUS_CUTOVER_STARTED_AT','NEXUS_SERVICE_UNAVAILABLE_STARTED_AT','NEXUS_CANDIDATE_AVAILABLE_AT','NEXUS_SOAK_STARTED_AT','NEXUS_SOAK_COMPLETED_AT'].every(timestamp)
  ||Date.parse(m.get('NEXUS_SOAK_COMPLETED_AT'))<Date.parse(m.get('NEXUS_SOAK_STARTED_AT')))process.exit(1);
const backup=m.get('NEXUS_BACKUP_FILE')||'',digest=m.get('NEXUS_BACKUP_SHA256')||'';
if(!backup.startsWith(`${backupDir}/v`)||!backup.endsWith('.tar.gz')||!/^[a-f0-9]{64}$/u.test(digest))process.exit(1);
process.stdout.write(`${backup}\t${digest}\n`);
NODE
}

seal_worker_result() {
  local output="$SEALED_RESULT.next"
  [ -f "$RESULT_ENV" ] && [ ! -L "$RESULT_ENV" ] || { echo "promotion worker result is missing" >&2; return 1; }
  rm -f "$output"
  install -m 600 "$RESULT_ENV" "$output"
  root_own "$output"
  read_and_validate_result "$output" >/dev/null || { rm -f "$output"; return 1; }
  mv -f "$output" "$SEALED_RESULT"
}

verify_candidate_live() {
  [ "$(readlink -f "$PROD_BASE/current")" = "$TARGET_RUNTIME" ] || { echo "candidate current identity changed before escrow" >&2; return 1; }
  if [ "${NEXUS_RELEASE_TEST_MODE:-0}" = "1" ]; then
    "$PM2_BIN" jlist
  else
    "$RUNUSER_BIN" -u "$WORKER_USER" -- "$PM2_BIN" jlist
  fi | node -e '
const fs=require("fs");const rows=JSON.parse(fs.readFileSync(0,"utf8"));const root=process.argv[1],sha=process.argv[2];
for(const [name,cwd] of [["nexus-hub",root],["content-engine",`${root}/content-engine`]]){
 const row=rows.find((x)=>x?.name===name),env=row?.pm2_env??{};
 if(env.status!=="online"||env.pm_cwd!==cwd||(env.NEXUS_RELEASE_SHA||env.GIT_COMMIT)!==sha||env.SENTRY_RELEASE!==sha)process.exit(1);
}' "$TARGET_RUNTIME" "$TARGET_SHA"
  trusted_attest verify "$TARGET_RUNTIME" "$TARGET_SHA" "$ARTIFACT_DIGEST" "$INSTALLED_RUNTIME_DIGEST"
}

prune_local_backups_as_application_user() {
  local script
  script='const fs=require("fs"),path=require("path");const root=path.resolve(process.argv[1]);
const stat=fs.lstatSync(root);if(!stat.isDirectory()||stat.isSymbolicLink()||fs.realpathSync(root)!==root)process.exit(1);
const files=fs.readdirSync(root).filter((name)=>/^v[A-Za-z0-9._+-]+\.tar\.gz$/u.test(name)).map((name)=>{
 const file=path.join(root,name),s=fs.lstatSync(file);if(!s.isFile()||s.isSymbolicLink())process.exit(1);
 return {file,mtime:s.mtimeMs};}).sort((a,b)=>b.mtime-a.mtime||a.file.localeCompare(b.file));
for(const entry of files.slice(10))fs.unlinkSync(entry.file);'
  if [ "${NEXUS_RELEASE_TEST_MODE:-0}" = "1" ]; then
    node -e "$script" "$BACKUP_DIR"
  else
    "$RUNUSER_BIN" -u "$WORKER_USER" -- "$SYSTEM_NODE_BIN" -e "$script" "$BACKUP_DIR"
  fi
}

escrow_exact_backup() {
  local backup_file="$1" backup_sha="$2" observed_sha dr_output confirmation_json output
  [ -f "$backup_file" ] && [ ! -L "$backup_file" ] || { echo "promotion backup file is unavailable" >&2; return 1; }
  observed_sha="$(node -e 'const fs=require("fs"),c=require("crypto");process.stdout.write(c.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"))' "$backup_file")"
  [ "$observed_sha" = "$backup_sha" ] || { echo "promotion backup digest changed before escrow" >&2; return 1; }
  [ -x "$DR_BACKUP_BIN" ] || { echo "application DR backup tooling is unavailable" >&2; return 1; }
  [ -f "$DR_CONFIG" ] && [ ! -L "$DR_CONFIG" ] || { echo "application DR configuration is unavailable" >&2; return 1; }
  dr_output="$("$TIMEOUT_BIN" --signal=TERM --kill-after=5s 300s \
    "$DR_BACKUP_BIN" --config "$DR_CONFIG" --require-release "$backup_file" --json)" || {
    echo "encrypted off-host rollback escrow failed" >&2
    return 1
  }
  confirmation_json="$(printf '%s\n' "$dr_output" | tail -n 1)"
  node - "$confirmation_json" "$backup_file" "$backup_sha" <<'NODE'
const [raw,path,sha]=process.argv.slice(2);const x=JSON.parse(raw),r=x.requiredRelease;
if(x.schema!=='nexus.application-dr-backup-result.v1'||x.status!=='passed'||x.encrypted!==true
 ||r?.confirmed!==true||r?.path!==path||r?.plaintextSha256!==sha
 ||typeof r?.objectKey!=='string'||!r.objectKey.endsWith(`.${sha}.age`)||r.objectKey.includes('..'))process.exit(1);
NODE
  output="$ESCROW_CONFIRMATION.next"
  rm -f "$output"
  node - "$output" "$TRANSACTION_ID" "$request_sha" "$confirmation_json" <<'NODE'
const fs=require('fs');const [output,transactionId,requestSha256,raw]=process.argv.slice(2);const dr=JSON.parse(raw);
fs.writeFileSync(output,`${JSON.stringify({schema:'nexus.promotion-rollback-escrow.v1',status:'passed',
 transactionId,requestSha256,confirmedAt:new Date().toISOString(),requiredRelease:dr.requiredRelease},null,2)}\n`,
 {mode:0o600,flag:'wx'});
NODE
  chmod 600 "$output"; root_own "$output"; mv -f "$output" "$ESCROW_CONFIRMATION"
  # Count retention is legal only after this exact plaintext digest is proved
  # present in encrypted off-host storage.
  prune_local_backups_as_application_user
}

finish_escrow() {
  local result backup_file backup_sha
  result="$(read_and_validate_result "$SEALED_RESULT")" || return 1
  IFS=$'\t' read -r backup_file backup_sha <<<"$result"
  verify_candidate_live || return 1
  if ! escrow_exact_backup "$backup_file" "$backup_sha"; then
    write_journal awaiting_rollback_escrow escrow_pending candidate_available_escrow_retry_required
    return 1
  fi
  write_journal completed completed exact_candidate_verified_and_rollback_escrowed
}

existing_status="$(journal_status 2>/dev/null || true)"
case "$existing_status" in
  completed|recovered|failed_before_stop) exit 0 ;;
  escrow_pending)
    if [ "$ACTION" = recover ] || [ -f "$CONTROL_DIR/recover" ]; then
      write_journal recovering running explicit_recovery_from_escrow_pending
      if recover_and_record; then
        rm -f "$RECOVERY_INTENT"
        write_journal recovery_complete recovered escrow_pending_candidate_recovered
        exit 0
      fi
      write_journal recovery_failed recovery_failed escrow_pending_candidate_recovery_failed
      exit 1
    fi
    finish_escrow
    exit $?
    ;;
esac

if [ "$ACTION" = recover ] || [ -f "$CONTROL_DIR/recover" ]; then
  if [ ! -f "$CUTOVER_TIMING" ] && [ ! -f "$RECOVERY_INTENT" ]; then
    write_journal failed_before_stop failed_before_stop recovery_requested_before_cutover_was_armed
    exit 0
  fi
  write_journal recovering running explicit_or_boot_recovery_started
  if recover_and_record; then
    rm -f "$RECOVERY_INTENT"
    write_journal recovery_complete recovered explicit_or_boot_recovery_completed
    exit 0
  fi
  write_journal recovery_failed recovery_failed explicit_or_boot_recovery_failed
  exit 1
fi

# Persist root-owned recovery intent before the unprivileged worker can reach
# its first PM2 stop. Every non-zero worker exit therefore takes recovery.
prepare_exact_runtimes
write_cutover_timing
printf '%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$RECOVERY_INTENT.next"
chmod 600 "$RECOVERY_INTENT.next"; root_own "$RECOVERY_INTENT.next"; mv -f "$RECOVERY_INTENT.next" "$RECOVERY_INTENT"
write_journal executing running durable_worker_started

set +e
invoke_worker worker-run
worker_status=$?
set -e
if [ "$worker_status" -ne 0 ]; then
  echo "promotion worker failed; restoring predecessor" >&2
  write_journal recovery_required recovery_required broker_restoring_predecessor
  if recover_and_record; then
    rm -f "$RECOVERY_INTENT"
    write_journal recovery_complete recovered automatic_recovery_completed
    exit 0
  fi
  write_journal recovery_failed recovery_failed automatic_recovery_failed
  exit 1
fi

if ! seal_worker_result || ! verify_candidate_live; then
  echo "promotion worker returned without authoritative candidate proof; restoring predecessor" >&2
  write_journal recovery_required recovery_required invalid_worker_completion
  if recover_and_record; then
    rm -f "$RECOVERY_INTENT"
    write_journal recovery_complete recovered invalid_completion_recovered
    exit 0
  fi
  write_journal recovery_failed recovery_failed invalid_completion_recovery_failed
  exit 1
fi

# Customer availability and the exact 60-second post-candidate soak are now
# proved. Network escrow may retry, but can no longer extend unavailability.
rm -f "$RECOVERY_INTENT"
write_journal awaiting_rollback_escrow escrow_pending candidate_available_before_network_escrow
finish_escrow
