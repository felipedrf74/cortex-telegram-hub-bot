#!/usr/bin/env bash
# One-time, owner-authorized migration from compatibility /home paths to the
# root-controlled /srv release layout. A durable root journal is written before
# the first PM2 or filesystem mutation. The companion boot unit invokes
# `recover`; ordinary releases remain blocked until the final attestation binds
# the signed authority, concrete drill, terminal journal, and result digests.
set -euo pipefail
umask 077
PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
export PATH

VERSION=nexus-release-layout-migrate.v1
COMMAND="${1:-}"
shift || true
TEST_MODE="${NEXUS_RELEASE_TEST_MODE:-0}"
STATE_ROOT="${NEXUS_PROMOTION_STATE_ROOT:-/var/lib/nexus-release-promotion}"
RELEASE_ROOT="${NEXUS_PROMOTION_RELEASE_ROOT:-/srv/nexus-release}"
OLD_PRODUCTION="${NEXUS_LAYOUT_OLD_PRODUCTION:-/home/dominguez/telegram-hub-bot}"
OLD_STAGING="${NEXUS_LAYOUT_OLD_STAGING:-/home/dominguez/telegram-hub-bot-staging}"
PRODUCTION="${NEXUS_PROMOTION_PRODUCTION_BASE:-$RELEASE_ROOT/production}"
STAGING="${NEXUS_PROMOTION_STAGING_BASE:-$RELEASE_ROOT/staging}"
WORKER_USER="${NEXUS_PROMOTION_WORKER_USER:-dominguez}"
WORKER_HOME="${NEXUS_LAYOUT_WORKER_HOME:-/home/dominguez}"
NODE_BIN="${NEXUS_PROMOTION_NODE_BIN:-/usr/bin/node}"
PM2_BIN="${NEXUS_PROMOTION_PM2_BIN:-/usr/local/bin/pm2}"
CONTROL_BIN="${NEXUS_PROMOTION_CONTROL_BIN:-/usr/local/sbin/nexus-release-promotion-control}"
AUTH_BIN="${NEXUS_LAYOUT_AUTH_BIN:-/usr/local/libexec/nexus-release-layout-authorization.mjs}"
ATTESTOR="${NEXUS_PROMOTION_TRUSTED_ATTESTOR:-/usr/local/libexec/nexus-trusted-release-runtime-attestation.mjs}"
OWNER_PUBLIC_KEY="${NEXUS_PROMOTION_OWNER_PUBLIC_KEY:-/etc/nexus-release/owner-promotion-public-key.pem}"
SETPRIV_BIN="${NEXUS_PROMOTION_SETPRIV_BIN:-/usr/bin/setpriv}"
ENV_BIN="${NEXUS_PROMOTION_ENV_BIN:-/usr/bin/env}"
TIMEOUT_BIN="${NEXUS_PROMOTION_TIMEOUT_BIN:-/usr/bin/timeout}"
CURL_BIN="${NEXUS_PROMOTION_CURL_BIN:-/usr/bin/curl}"
BASH_BIN="${NEXUS_PROMOTION_BASH_BIN:-/usr/bin/bash}"
PYTHON_BIN="${NEXUS_PROMOTION_PYTHON_BIN:-/usr/bin/python3}"
SELECTOR_SWITCH="${NEXUS_PROMOTION_SELECTOR_SWITCH:-/usr/local/libexec/nexus-release-selector-switch.py}"
BOOT_HEALTH_BIN="${NEXUS_PROMOTION_BOOT_HEALTH_BIN:-/usr/local/sbin/nexus-release-boot-health}"
if [ "$TEST_MODE" = 1 ]; then
  PYTHON_BIN="${NEXUS_PROMOTION_PYTHON_BIN:-$(command -v python3)}"
  if [ -z "${NEXUS_PROMOTION_SELECTOR_SWITCH:-}" ]; then
    SELECTOR_SWITCH="$(cd "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/remote-release-selector-switch.py"
  fi
fi
PM2_ATTESTATION="${NEXUS_PROMOTION_PM2_ATTESTATION:-$STATE_ROOT/pm2-root-install.v1.json}"
ACTIVE_JOURNAL="$STATE_ROOT/layout-migration-in-progress.v1.json"
TERMINAL_JOURNAL="$STATE_ROOT/layout-migration-terminal.v1.json"
RESULT="$STATE_ROOT/layout-migration-result.v1.json"
ATTESTATION="$STATE_ROOT/layout-migration.v1.json"
REQUEST_COPY="$STATE_ROOT/layout-migration-request-envelope.v1.json"
DRILL_COPY="$STATE_ROOT/layout-migration-fault-drill-envelope.v1.json"
RECOVERED="$STATE_ROOT/layout-migration-recovered.v1.json"
BOOT_RECOVERY="$STATE_ROOT/boot-recovery-in-progress.v1.json"
LOCK_FILE="${NEXUS_RELEASE_MUTEX:-/run/lock/nexus-release-sonar.lock}"
RECOVERY_DEADLINE_EPOCH=""

die() {
  echo "release layout migration: $*" >&2
  exit 1
}

[ "$EUID" -eq 0 ] || [ "$TEST_MODE" = 1 ] || {
  echo "release layout migration requires root" >&2
  exit 77
}
[ "$RELEASE_ROOT" = /srv/nexus-release ] \
  && [ "$PRODUCTION" = /srv/nexus-release/production ] \
  && [ "$STAGING" = /srv/nexus-release/staging ] || [ "$TEST_MODE" = 1 ] || {
  echo "release layout migration destination must be the authoritative /srv layout" >&2
  exit 64
}
[ "$OLD_PRODUCTION" = /home/dominguez/telegram-hub-bot ] \
  && [ "$OLD_STAGING" = /home/dominguez/telegram-hub-bot-staging ] || [ "$TEST_MODE" = 1 ] || {
  echo "release layout migration source must be the exact compatibility layout" >&2
  exit 64
}
for executable in "$NODE_BIN" "$PM2_BIN" "$AUTH_BIN" "$ATTESTOR" "$PYTHON_BIN" \
  "$SELECTOR_SWITCH" "$BOOT_HEALTH_BIN"; do
  [ -x "$executable" ] || die "required root-controlled executable is unavailable: $executable"
done
for executable in "$SETPRIV_BIN" "$ENV_BIN" "$TIMEOUT_BIN" "$CURL_BIN" "$BASH_BIN"; do
  [ "$TEST_MODE" = 1 ] || [ -x "$executable" ] \
    || die "required migration executable is unavailable: $executable"
done

WORKER_UID="$(id -u "$WORKER_USER")"
WORKER_GID="$(id -g "$WORKER_USER")"

fsync_path() {
  "$NODE_BIN" - "$1" <<'NODE'
const fs=require('fs');const fd=fs.openSync(process.argv[2],'r');
try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
NODE
}

sha256_file() {
  "$NODE_BIN" - "$1" <<'NODE'
const crypto=require('crypto');const fs=require('fs');
const fd=fs.openSync(process.argv[2],fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));
try{
 const before=fs.fstatSync(fd);const body=fs.readFileSync(fd);const after=fs.fstatSync(fd);
 if(!before.isFile()||before.nlink!==1||before.dev!==after.dev||before.ino!==after.ino
  ||before.size!==after.size||before.mtimeMs!==after.mtimeMs)process.exit(1);
 process.stdout.write(crypto.createHash('sha256').update(body).digest('hex'));
}finally{fs.closeSync(fd);}
NODE
}

atomic_copy() {
  local source="$1" destination="$2" temporary
  [ -f "$source" ] && [ ! -L "$source" ] || die "signed migration input is unsafe"
  [ ! -e "$destination" ] && [ ! -L "$destination" ] \
    || die "migration authority was already staged"
  temporary="$(mktemp "$STATE_ROOT/.layout-authority.next.XXXXXXXX")"
  install -m 600 -- "$source" "$temporary"
  if [ "$TEST_MODE" != 1 ]; then chown root:root "$temporary"; fi
  fsync_path "$temporary"
  mv -T -- "$temporary" "$destination"
  fsync_path "$STATE_ROOT"
}

write_json() {
  local destination="$1" schema="$2" phase="$3" details_file="${4:-}" temporary
  temporary="$(mktemp "$STATE_ROOT/.layout-state.next.XXXXXXXX")"
  "$NODE_BIN" - "$temporary" "$schema" "$phase" "$details_file" <<'NODE'
const fs=require('fs');const [output,schema,phase,detailsFile]=process.argv.slice(2);
const details=detailsFile?JSON.parse(fs.readFileSync(detailsFile,'utf8')):{};
fs.writeFileSync(output,`${JSON.stringify({
 schema,phase,...details,updatedAt:new Date().toISOString(),
},null,2)}\n`,{mode:0o600,flag:'w'});
const fd=fs.openSync(output,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
NODE
  chmod 600 "$temporary"
  if [ "$TEST_MODE" != 1 ]; then chown root:root "$temporary"; fi
  mv -T -- "$temporary" "$destination"
  fsync_path "$STATE_ROOT"
}

write_boot_recovery_origin() {
  local outage_started="$1" recovery_deadline="$2" temporary
  if [ "$TEST_MODE" = 1 ] && [ "${NEXUS_RELEASE_BOOT_RECOVERY:-0}" != 1 ]; then
    return 0
  fi
  temporary="$(mktemp "$STATE_ROOT/.boot-recovery-layout.XXXXXXXX")"
  "$NODE_BIN" - "$temporary" "$BOOT_RECOVERY" "$ACTIVE_JOURNAL" \
    "$outage_started" "$recovery_deadline" <<'NODE'
const fs=require('fs');
const [output,existingFile,journalFile,startedRaw,deadlineRaw]=process.argv.slice(2);
const started=Number(startedRaw),deadline=Number(deadlineRaw),now=Math.floor(Date.now()/1000);
const bootId=fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim();
const monotonic=Math.floor(Number(fs.readFileSync('/proc/uptime','utf8').split(/\s+/u)[0]));
const journal=JSON.parse(fs.readFileSync(journalFile));
if(!Number.isSafeInteger(started)||!Number.isSafeInteger(deadline)
 ||deadline-started!==120||started>now+1)process.exit(1);
let origin={epoch:started,startedAt:new Date(started*1000).toISOString(),
 monotonic:journal.productionOutageStartedEpoch===started
  &&Number.isSafeInteger(journal.productionOutageStartedMonotonic)
   ?journal.productionOutageStartedMonotonic:monotonic,
 outageBootId:journal.productionOutageStartedEpoch===started
  &&typeof journal.productionOutageBootId==='string'
   ?journal.productionOutageBootId:bootId,
 source:'layout_recovery'};
try{
 const current=JSON.parse(fs.readFileSync(existingFile));
 if(current.schema==='nexus.release-boot-recovery.v1'&&current.status==='in_progress'
  &&Number.isSafeInteger(current.outageStartedEpoch)
  &&current.outageStartedEpoch<origin.epoch){
  origin={epoch:current.outageStartedEpoch,startedAt:current.outageStartedAt,
   monotonic:current.outageStartedMonotonic,outageBootId:current.outageBootId,
   source:current.timingSource};
 }
}catch{}
fs.writeFileSync(output,`${JSON.stringify({
 schema:'nexus.release-boot-recovery.v1',status:'in_progress',bootId,
 bootDetectedAt:new Date(now*1000).toISOString(),bootDetectedEpoch:now,
 outageStartedAt:origin.startedAt,outageStartedEpoch:origin.epoch,
 outageStartedMonotonic:origin.monotonic,outageBootId:origin.outageBootId,
 recoveryDeadlineEpoch:origin.epoch+120,timingSource:origin.source,
 activeTransactionId:null,
},null,2)}\n`,{mode:0o600,flag:'w'});
const fd=fs.openSync(output,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
NODE
  chmod 600 "$temporary"
  if [ "$TEST_MODE" != 1 ]; then chown root:root "$temporary"; fi
  mv -T -- "$temporary" "$BOOT_RECOVERY"
  fsync_path "$STATE_ROOT"
}

update_active_phase() {
  local phase="$1" details_file="${2:-}" temporary
  [ -f "$ACTIVE_JOURNAL" ] && [ ! -L "$ACTIVE_JOURNAL" ] \
    || die "layout migration journal is unavailable"
  temporary="$(mktemp "$STATE_ROOT/.layout-journal.next.XXXXXXXX")"
  "$NODE_BIN" - "$ACTIVE_JOURNAL" "$temporary" "$phase" "$details_file" <<'NODE'
const fs=require('fs');const [currentFile,output,phase,detailsFile]=process.argv.slice(2);
const current=JSON.parse(fs.readFileSync(currentFile,'utf8'));
if(current.schema!=='nexus.release-layout-migration-journal.v1')process.exit(1);
const details=detailsFile?JSON.parse(fs.readFileSync(detailsFile,'utf8')):{};
fs.writeFileSync(output,`${JSON.stringify({
 ...current,...details,phase,updatedAt:new Date().toISOString(),
},null,2)}\n`,{mode:0o600,flag:'w'});
const fd=fs.openSync(output,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
NODE
  chmod 600 "$temporary"
  if [ "$TEST_MODE" != 1 ]; then chown root:root "$temporary"; fi
  mv -T -- "$temporary" "$ACTIVE_JOURNAL"
  fsync_path "$STATE_ROOT"
}

run_worker() {
  if [ "$TEST_MODE" = 1 ]; then
    HOME="$WORKER_HOME" PM2_HOME="$WORKER_HOME/.pm2" PATH="$PATH" "$@"
  else
    "$SETPRIV_BIN" --reuid="$WORKER_UID" --regid="$WORKER_GID" \
      --init-groups --no-new-privs \
      "$ENV_BIN" -i HOME="$WORKER_HOME" PM2_HOME="$WORKER_HOME/.pm2" PATH="$PATH" "$@"
  fi
}

bounded_seconds() {
  local requested="$1" now remaining
  if [ -z "$RECOVERY_DEADLINE_EPOCH" ]; then
    printf '%s\n' "$requested"
    return 0
  fi
  now="$(date +%s)"
  remaining="$(( RECOVERY_DEADLINE_EPOCH - now ))"
  if [ "$remaining" -le 0 ]; then
    # Missing the availability objective is an incident, not permission to
    # abandon a provably recoverable predecessor. The root timing marker
    # remains unresolved; recovery continues with bounded per-command timeouts.
    printf '%s\n' "$requested"
    return 0
  fi
  if [ "$remaining" -lt "$requested" ]; then printf '%s\n' "$remaining"
  else printf '%s\n' "$requested"
  fi
}

run_release() {
  local role="$1" base="$2" runtime="$3" sha="$4"
  shift 4
  run_worker "$ENV_BIN" \
    NEXUS_RELEASE_DIR="$runtime" \
    NEXUS_RELEASE_BASE_DIR="$base" \
    NEXUS_RELEASE_ROLE="$role" \
    NEXUS_RELEASE_SHA="$sha" \
    SENTRY_RELEASE="$sha" \
    "$@"
}

current_runtime() {
  local base="$1"
  [ -L "$base/current" ] || return 1
  readlink -f -- "$base/current"
}

verify_runtime() {
  local base="$1" runtime="$2" sha="$3" artifact="$4" installed="$5"
  [ "$runtime" != "$base/releases" ] && [[ "$runtime" == "$base"/releases/* ]] \
    || die "current runtime is outside its exact release base"
  "$NODE_BIN" "$ATTESTOR" verify --root "$runtime" --base "$base" \
    --runtime-sha "$sha" --artifact-digest "$artifact" \
    --installed-runtime-digest "$installed" --group-id "$WORKER_GID" >/dev/null
}

verify_pm2_identity() {
  local production_runtime="$1" production_sha="$2" staging_runtime="$3" staging_sha="$4"
  local baseline final timeout_seconds
  baseline="$(mktemp "$STATE_ROOT/.layout-pm2-baseline.XXXXXXXX")"
  final="$(mktemp "$STATE_ROOT/.layout-pm2-final.XXXXXXXX")"
  timeout_seconds="$(bounded_seconds 10)"
  run_worker "$TIMEOUT_BIN" "${timeout_seconds}s" "$PM2_BIN" jlist >"$baseline"
  sleep 1
  timeout_seconds="$(bounded_seconds 10)"
  run_worker "$TIMEOUT_BIN" "${timeout_seconds}s" "$PM2_BIN" jlist >"$final"
  "$NODE_BIN" - "$baseline" "$final" "$production_runtime" "$production_sha" \
    "$staging_runtime" "$staging_sha" <<'NODE'
const fs=require('fs');const [baselineFile,finalFile,production,productionSha,
 staging,stagingSha]=process.argv.slice(2);
const expected=[
 ['nexus-hub',production,`${production}/dist/index.js`,'node',productionSha],
 ['content-engine',`${production}/content-engine`,
  `${production}/content-engine/.venv/bin/python3.12`,'none',productionSha],
 ['nexus-hub-staging',staging,`${staging}/dist/index.js`,'node',stagingSha],
 ['content-engine-staging',`${staging}/content-engine`,
  `${staging}/content-engine/.venv/bin/python3.12`,'none',stagingSha],
];
const snapshot=(file)=>JSON.parse(fs.readFileSync(file,'utf8'));
const validate=(rows)=>{
 const result=[];
 for(const [name,cwd,executable,interpreter,sha] of expected){
  const matches=rows.filter((entry)=>entry?.name===name);
  const row=matches[0],env=row?.pm2_env??{};
  const identity={name,pid:Number(row?.pid),restartTime:Number(env.restart_time??0),
   unstableRestarts:Number(env.unstable_restarts??0)};
  if(matches.length!==1||env.status!=='online'||env.pm_cwd!==cwd
   ||env.pm_exec_path!==executable||env.exec_interpreter!==interpreter
   ||(env.NEXUS_RELEASE_SHA||env.GIT_COMMIT)!==sha||env.SENTRY_RELEASE!==sha
   ||!Number.isSafeInteger(identity.pid)||identity.pid<=0
   ||!Number.isSafeInteger(identity.restartTime)||identity.restartTime<0
   ||!Number.isSafeInteger(identity.unstableRestarts)||identity.unstableRestarts<0)process.exit(1);
  result.push(identity);
 }
 return result;
};
const before=validate(snapshot(baselineFile)),after=validate(snapshot(finalFile));
for(let index=0;index<before.length;index++){
 const left=before[index],right=after[index];
 if(left.name!==right.name||left.pid!==right.pid||left.restartTime!==right.restartTime
  ||left.unstableRestarts!==right.unstableRestarts)process.exit(1);
}
NODE
  rm -f -- "$baseline" "$final"
}

persist_and_verify_pm2_dump() {
  local production_runtime="$1" production_sha="$2"
  local staging_runtime="$3" staging_sha="$4" result
  # The role identities are intentionally accepted only as a consistency
  # check here. The root helper derives them again from root-owned selectors.
  [ -n "$production_runtime" ] && [ -n "$staging_runtime" ] \
    && [[ "$production_sha" =~ ^[a-f0-9]{40}$ ]] \
    && [[ "$staging_sha" =~ ^[a-f0-9]{40}$ ]] \
    || die "PM2 authority publication inputs are invalid"
  result="$("$BOOT_HEALTH_BIN" publish-current)"
  "$NODE_BIN" -e '
const x=JSON.parse(process.argv[1]);
if(x.schema!=="nexus.pm2-resurrection-authority.v2"
 ||!/^[a-f0-9]{64}$/u.test(x.dumpSha256||""))process.exit(1);
process.stdout.write(x.dumpSha256);
' "$result"
}

stop_all_apps() {
  local app timeout_seconds
  for app in nexus-hub content-engine nexus-hub-staging content-engine-staging; do
    timeout_seconds="$(bounded_seconds 5)"
    if run_worker "$TIMEOUT_BIN" "${timeout_seconds}s" "$PM2_BIN" describe "$app" >/dev/null 2>&1; then
      timeout_seconds="$(bounded_seconds 15)"
      run_worker "$TIMEOUT_BIN" "${timeout_seconds}s" "$PM2_BIN" delete "$app" >/dev/null
    fi
  done
}

stop_role_apps() {
  local role="$1" app timeout_seconds
  if [ "$role" = production ]; then
    set -- nexus-hub content-engine
  else
    set -- nexus-hub-staging content-engine-staging
  fi
  for app in "$@"; do
    timeout_seconds="$(bounded_seconds 5)"
    if run_worker "$TIMEOUT_BIN" "${timeout_seconds}s" "$PM2_BIN" describe "$app" >/dev/null 2>&1; then
      timeout_seconds="$(bounded_seconds 15)"
      run_worker "$TIMEOUT_BIN" "${timeout_seconds}s" "$PM2_BIN" delete "$app" >/dev/null
    fi
  done
}

start_role() {
  local role="$1" base="$2" runtime="$3" sha="$4"
  local timeout_seconds
  timeout_seconds="$(bounded_seconds 60)"
  run_release "$role" "$base" "$runtime" "$sha" \
    "$TIMEOUT_BIN" --signal=TERM --kill-after=5s "${timeout_seconds}s" \
    "$PM2_BIN" start "$runtime/ecosystem.release.config.js" --update-env >/dev/null
}

readiness_role() {
  local role="$1" base="$2" runtime="$3" sha="$4" stability="$5" output="$6"
  local attempts="${7:-30}" fd timeout_seconds
  fd=8
  : >"$output"
  chmod 600 "$output"
  if [ "$TEST_MODE" != 1 ]; then chown root:root "$output"; fi
  exec 8<>"$output"
  timeout_seconds="$(bounded_seconds 190)"
  run_worker "$TIMEOUT_BIN" --signal=TERM --kill-after=5s "${timeout_seconds}s" \
    "$BASH_BIN" "$runtime/scripts/remote-release-readiness.sh" \
    --role "$role" --base-dir "$base" --release-dir "$runtime" \
    --runtime-sha "$sha" --pm2-bin "$PM2_BIN" --node-bin "$NODE_BIN" \
    --curl-bin "$CURL_BIN" --output-fd "$fd" --stability-seconds "$stability" \
    --readiness-attempts "$attempts" --poll-seconds 1 >&2
  exec 8>&-
  [ -s "$output" ] || die "$role readiness did not produce evidence"
}

capture_worker_home() {
  local details="$1"
  "$NODE_BIN" - "$WORKER_HOME" "$details" <<'NODE'
const fs=require('fs');const [home,output]=process.argv.slice(2);
const stat=fs.lstatSync(home);
if(!stat.isDirectory()||stat.isSymbolicLink()||fs.realpathSync.native(home)!==home)process.exit(1);
fs.writeFileSync(output,`${JSON.stringify({
 homeIdentity:{uid:stat.uid,gid:stat.gid,mode:stat.mode&0o7777,dev:String(stat.dev),ino:String(stat.ino)},
},null,2)}\n`,{mode:0o600,flag:'w'});
NODE
}

lock_worker_home() {
  local details="$1"
  [ "$TEST_MODE" = 1 ] && return 0
  "$NODE_BIN" - "$WORKER_HOME" "$details" "$WORKER_UID" "$WORKER_GID" <<'NODE'
const fs=require('fs');const [home,details,uidRaw,gidRaw]=process.argv.slice(2);
const identity=JSON.parse(fs.readFileSync(details,'utf8')).homeIdentity;
const stat=fs.lstatSync(home);
if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==Number(uidRaw)
 ||stat.gid!==Number(gidRaw)||String(stat.dev)!==identity.dev||String(stat.ino)!==identity.ino
 ||(stat.mode&0o7777)!==identity.mode)process.exit(1);
fs.chownSync(home,0,stat.gid);fs.chmodSync(home,0o750);
NODE
}

restore_worker_home() {
  local details="$1"
  [ "$TEST_MODE" = 1 ] && return 0
  "$NODE_BIN" - "$WORKER_HOME" "$details" <<'NODE'
const fs=require('fs');const [home,details]=process.argv.slice(2);
const identity=JSON.parse(fs.readFileSync(details,'utf8')).homeIdentity;
const stat=fs.lstatSync(home);
if(!stat.isDirectory()||stat.isSymbolicLink()
 ||String(stat.dev)!==identity.dev||String(stat.ino)!==identity.ino)process.exit(1);
fs.chownSync(home,identity.uid,identity.gid);fs.chmodSync(home,identity.mode);
NODE
}

layout_selector_switch() {
  local role="$1" expected="$2" target="$3" layout_base="${4:-authoritative}"
  local legacy args
  if [ "$role" = production ]; then legacy="$OLD_PRODUCTION"
  else legacy="$OLD_STAGING"; fi
  args=(
    switch --role "$role" --release-root "$RELEASE_ROOT"
    --worker-uid "$WORKER_UID" --worker-gid "$WORKER_GID"
    --expected "$expected" --target "$target"
    --layout-transition --layout-base "$layout_base"
    --legacy-base "$legacy" --adopt-existing-selector
  )
  if [ "$TEST_MODE" = 1 ]; then args+=(--allow-test-owner); fi
  "$PYTHON_BIN" "$SELECTOR_SWITCH" "${args[@]}" >/dev/null
}

rewrite_runtime_links() {
  local role="$1" base="$2" runtime="$3" previous_runtime="$4"
  "$NODE_BIN" - "$base" "$runtime" <<'NODE'
const fs=require('fs');const path=require('path');const [base,runtime]=process.argv.slice(2);
if(!runtime.startsWith(`${path.join(base,'releases')}${path.sep}`))process.exit(1);
for(const name of ['.env','data','logs']){
 const target=path.join(base,name),link=path.join(runtime,name),next=`${link}.layout-next`;
 if(fs.existsSync(next)||fs.lstatSync(next,{throwIfNoEntry:false})?.isSymbolicLink())fs.unlinkSync(next);
 const current=fs.lstatSync(link);
 if(!current.isSymbolicLink())process.exit(1);
 fs.symlinkSync(target,next);fs.renameSync(next,link);
}
for(const directory of [runtime,base]){
 const fd=fs.openSync(directory,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
}
NODE
  layout_selector_switch "$role" "$previous_runtime" "$runtime"
}

create_compatibility_link() {
  local old="$1" new="$2"
  [ ! -e "$old" ] && [ ! -L "$old" ] || die "compatibility path was unexpectedly occupied"
  ln -s -- "$new" "$old"
  if [ "$TEST_MODE" != 1 ]; then chown -h root:root "$old"; fi
  fsync_path "$(dirname -- "$old")"
}

extract_authority_field() {
  local field="$1" verification="${2:-$STATE_ROOT/layout-authority-verification.v1.json}"
  "$NODE_BIN" - "$verification" "$field" <<'NODE'
const fs=require('fs');const [file,field]=process.argv.slice(2);
let value=JSON.parse(fs.readFileSync(file,'utf8'));
for(const part of field.split('.'))value=value?.[part];
if(typeof value!=='string')process.exit(1);process.stdout.write(value);
NODE
}

publication_is_complete() {
  [ -f "$ATTESTATION" ] && [ ! -L "$ATTESTATION" ] \
    && [ -f "$RESULT" ] && [ ! -L "$RESULT" ] \
    && [ -f "$TERMINAL_JOURNAL" ] && [ ! -L "$TERMINAL_JOURNAL" ]
}

remove_partial_publication() {
  local file
  for file in "$ATTESTATION" "$RESULT" "$TERMINAL_JOURNAL"; do
    if [ -e "$file" ] || [ -L "$file" ]; then
      [ -f "$file" ] && [ ! -L "$file" ] || die "partial layout publication is unsafe"
      rm -f -- "$file"
    fi
  done
  fsync_path "$STATE_ROOT"
}

recover_layout() {
  [ -e "$ACTIVE_JOURNAL" ] || [ -L "$ACTIVE_JOURNAL" ] || {
    printf '{"ok":true,"schema":"%s","status":"idle"}\n' "$VERSION"
    return 0
  }
  [ -f "$ACTIVE_JOURNAL" ] && [ ! -L "$ACTIVE_JOURNAL" ] \
    || die "layout migration recovery journal is unsafe"
  if publication_is_complete; then
    # A crash after the three durable records were published but before the
    # active marker was removed is reconciled without reverting healthy state.
    if "$NODE_BIN" - "$ATTESTATION" "$RESULT" "$TERMINAL_JOURNAL" <<'NODE'
const crypto=require('crypto');const fs=require('fs');const [markerFile,resultFile,journalFile]=process.argv.slice(2);
const digest=(file)=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const marker=JSON.parse(fs.readFileSync(markerFile,'utf8'));
if(marker.schema!=='nexus.release-layout-migration.v1'
 ||marker.resultSha256!==digest(resultFile)||marker.terminalJournalSha256!==digest(journalFile))process.exit(1);
NODE
    then
      rm -f -- "$ACTIVE_JOURNAL"
      fsync_path "$STATE_ROOT"
      printf '{"ok":true,"schema":"%s","status":"completed"}\n' "$VERSION"
      return 0
    fi
  fi
  remove_partial_publication
  local recovery_started outage_started recovery_deadline home_details
  local production_sha staging_sha production_runtime staging_runtime
  recovery_started="$(date +%s)"
  read -r outage_started recovery_deadline < <("$NODE_BIN" - "$ACTIVE_JOURNAL" "$recovery_started" <<'NODE'
const fs=require('fs');const [file,nowRaw]=process.argv.slice(2);const now=Number(nowRaw);
const x=JSON.parse(fs.readFileSync(file,'utf8'));
const candidateHadRestored=Number.isSafeInteger(x.productionAvailabilityRestoredEpoch);
const started=candidateHadRestored?now
 :Number.isSafeInteger(x.productionOutageStartedEpoch)?x.productionOutageStartedEpoch:now;
const deadline=candidateHadRestored?started+120
 :Number.isSafeInteger(x.recoveryDeadlineEpoch)?x.recoveryDeadlineEpoch:started+120;
if(deadline!==started+120||started>now+1)process.exit(1);
process.stdout.write(`${started}\t${deadline}\n`);
NODE
)
  RECOVERY_DEADLINE_EPOCH="$recovery_deadline"
  write_boot_recovery_origin "$outage_started" "$recovery_deadline"
  if [ "${NEXUS_RELEASE_BOOT_RECOVERY:-0}" = 1 ]; then
    # Persist the original outage authority before daemon startup, then create
    # the sole governed temporary daemon before any PM2 CLI operation.
    "$BOOT_HEALTH_BIN" start-temporary
  fi
  home_details="$(mktemp "$STATE_ROOT/.layout-recovery-home.XXXXXXXX")"
  "$NODE_BIN" - "$ACTIVE_JOURNAL" "$home_details" <<'NODE'
const fs=require('fs');const journal=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
if(journal.schema!=='nexus.release-layout-migration-journal.v1'||!journal.homeIdentity)process.exit(1);
fs.writeFileSync(process.argv[3],`${JSON.stringify({homeIdentity:journal.homeIdentity},null,2)}\n`,
 {mode:0o600,flag:'w'});
NODE
  if [ "$TEST_MODE" != 1 ]; then
    chown root:"$WORKER_GID" "$WORKER_HOME"; chmod 750 "$WORKER_HOME"
  fi
  local production_touched
  production_touched="$("$NODE_BIN" - "$ACTIVE_JOURNAL" <<'NODE'
const fs=require('fs');const x=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
process.stdout.write(Number.isSafeInteger(x.productionOutageStartedEpoch)?'true':'false');
NODE
)"
  if [ "$production_touched" = true ]; then stop_all_apps
  else stop_role_apps staging
  fi
  read -r production_sha staging_sha < <("$NODE_BIN" - "$ACTIVE_JOURNAL" <<'NODE'
const fs=require('fs');const x=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const production=x.source?.production?.runtimeSha,staging=x.source?.staging?.runtimeSha;
if(!/^[a-f0-9]{40}$/u.test(production||'')||!/^[a-f0-9]{40}$/u.test(staging||''))process.exit(1);
process.stdout.write(`${production}\t${staging}\n`);
NODE
)
  # Requests intentionally do not carry a separately mutable runtime path;
  # recover derives it from the exact active target stored in the root journal.
  production_runtime="$("$NODE_BIN" - "$ACTIVE_JOURNAL" <<'NODE'
const fs=require('fs');const x=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
process.stdout.write(x.oldRuntime.production);
NODE
)"
  staging_runtime="$("$NODE_BIN" - "$ACTIVE_JOURNAL" <<'NODE'
const fs=require('fs');const x=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
process.stdout.write(x.oldRuntime.staging);
NODE
)"
  local role old new old_runtime new_runtime
  for role in production staging; do
    if [ "$role" = production ]; then
      old="$OLD_PRODUCTION"; new="$PRODUCTION"; old_runtime="$production_runtime"
    else
      old="$OLD_STAGING"; new="$STAGING"; old_runtime="$staging_runtime"
    fi
    new_runtime="$new/releases/$(basename -- "$old_runtime")"
    if [ -d "$new" ] && [ ! -L "$new" ]; then
      if [ -L "$old" ]; then rm -f -- "$old"; fi
      [ ! -e "$old" ] || die "cannot restore occupied compatibility source path"
      # Rewrite runtime links for the old canonical destination before the
      # rename. The current selector itself is switched only after the move,
      # through the pinned root CAS helper, so its target always exists.
      "$NODE_BIN" - "$new" "$new_runtime" "$old" <<'NODE'
const fs=require('fs');const path=require('path');const [base,runtime,oldBase]=process.argv.slice(2);
for(const name of ['.env','data','logs']){
 const link=path.join(runtime,name),next=`${link}.rollback-next`;
 fs.symlinkSync(path.join(oldBase,name),next);fs.renameSync(next,link);
}
NODE
      mv -T -- "$new" "$old"
      fsync_path "$(dirname -- "$new")"
      fsync_path "$(dirname -- "$old")"
      layout_selector_switch "$role" "$new_runtime" "$old_runtime" legacy
    elif [ -L "$old" ]; then
      die "compatibility link exists without its authoritative destination"
    fi
  done
  restore_worker_home "$home_details"
  rm -f -- "$home_details"
  production_runtime="$OLD_PRODUCTION/releases/$(basename -- "$production_runtime")"
  staging_runtime="$OLD_STAGING/releases/$(basename -- "$staging_runtime")"
  if [ "$production_touched" = true ] \
      || [ "${NEXUS_RELEASE_BOOT_RECOVERY:-0}" = 1 ]; then
    start_role production "$OLD_PRODUCTION" "$production_runtime" "$production_sha"
  fi
  start_role staging "$OLD_STAGING" "$staging_runtime" "$staging_sha"
  local production_readiness staging_readiness
  production_readiness="$(mktemp "$STATE_ROOT/.layout-recovery-production.XXXXXXXX")"
  staging_readiness="$(mktemp "$STATE_ROOT/.layout-recovery-staging.XXXXXXXX")"
  readiness_role production "$OLD_PRODUCTION" "$production_runtime" "$production_sha" 0 "$production_readiness" 8
  readiness_role staging "$OLD_STAGING" "$staging_runtime" "$staging_sha" 0 "$staging_readiness" 8
  # Persist and byte-verify the restored exact /home identities before the
  # recovery journal can become terminal. Otherwise a second reboot could
  # resurrect the newer /srv dump after rollback already removed those paths.
  local pm2_dump_sha256
  pm2_dump_sha256="$(persist_and_verify_pm2_dump \
    "$production_runtime" "$production_sha" "$staging_runtime" "$staging_sha")"
  verify_pm2_identity "$production_runtime" "$production_sha" \
    "$staging_runtime" "$staging_sha"
  local recovery_seconds recovery_details recovery_target_met=true
  recovery_seconds="$(( $(date +%s) - outage_started ))"
  if [ "$recovery_seconds" -gt 120 ]; then
    recovery_target_met=false
  fi
  recovery_details="$(mktemp "$STATE_ROOT/.layout-recovered-details.XXXXXXXX")"
  "$NODE_BIN" - "$recovery_details" "$ACTIVE_JOURNAL" "$production_readiness" \
    "$staging_readiness" "$recovery_seconds" "$pm2_dump_sha256" \
    "$recovery_target_met" <<'NODE'
const crypto=require('crypto');const fs=require('fs');
const [output,journal,production,staging,seconds,pm2DumpSha256,targetMetRaw]=process.argv.slice(2);
const digest=(file)=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
if(!/^[a-f0-9]{64}$/u.test(pm2DumpSha256||'')
 ||!['true','false'].includes(targetMetRaw))process.exit(1);
fs.writeFileSync(output,`${JSON.stringify({
 originalJournalSha256:digest(journal),
 readinessSha256:{production:digest(production),staging:digest(staging)},
 pm2DumpSha256,
 recoverySeconds:Number(seconds),recoveryTargetSeconds:120,
 targetMet:targetMetRaw==='true',recoveredAt:new Date().toISOString(),
},null,2)}\n`,{mode:0o600,flag:'w'});
NODE
  write_json "$RECOVERED" nexus.release-layout-migration-recovered.v1 recovered "$recovery_details"
  if [ "$recovery_target_met" = false ] \
      && [ "${NEXUS_RELEASE_BOOT_RECOVERY:-0}" != 1 ]; then
    "$BOOT_HEALTH_BIN" arm-current >/dev/null
    "$BOOT_HEALTH_BIN" postcheck >/dev/null
    "$NODE_BIN" - "$STATE_ROOT/boot-health-proof.v1.json" <<'NODE'
const fs=require('fs');const x=JSON.parse(fs.readFileSync(process.argv[2]));
if(x.schema!=='nexus.release-boot-health-proof.v2'
 ||x.status!=='healthy_sla_missed'||x.targetMet!==false)process.exit(1);
NODE
  fi
  if [ "$recovery_target_met" = true ] \
      && [ "${NEXUS_RELEASE_BOOT_RECOVERY:-0}" != 1 ] \
      && [ -f "$BOOT_RECOVERY" ] && [ ! -L "$BOOT_RECOVERY" ]; then
    # Clear the temporary timing marker while ACTIVE_JOURNAL is still the
    # durable retry authority. A crash after this point repeats exact recovery;
    # it can never leave an unresolvable marker after disarming the journal.
    rm -f -- "$BOOT_RECOVERY"
    fsync_path "$STATE_ROOT"
  fi
  rm -f -- "$production_readiness" "$staging_readiness" "$recovery_details" \
    "$ACTIVE_JOURNAL" "$REQUEST_COPY" "$DRILL_COPY" \
    "$STATE_ROOT/layout-authority-verification.v1.json"
  fsync_path "$STATE_ROOT"
  printf '{"ok":true,"schema":"%s","status":"recovered","recoverySeconds":%s,"targetMet":%s}\n' \
    "$VERSION" "$recovery_seconds" "$recovery_target_met"
}

migrate_layout() {
  [ "$#" -eq 2 ] || {
    echo "Usage: remote-release-layout-migrate.sh migrate <signed-request-envelope> <signed-fault-drill-envelope>" >&2
    exit 64
  }
  local request="$1" drill="$2"
  [ ! -e "$ACTIVE_JOURNAL" ] && [ ! -L "$ACTIVE_JOURNAL" ] \
    || die "an unfinished layout migration requires recovery"
  [ ! -e "$ATTESTATION" ] && [ ! -L "$ATTESTATION" ] \
    || die "release layout migration is already attested"
  [ ! -e "$RESULT" ] && [ ! -L "$RESULT" ] \
    && [ ! -e "$TERMINAL_JOURNAL" ] && [ ! -L "$TERMINAL_JOURNAL" ] \
    || die "partial layout migration publication requires recovery"
  [ ! -e "$REQUEST_COPY" ] && [ ! -e "$DRILL_COPY" ] \
    || die "layout migration authority already exists"
  [ ! -e "$STATE_ROOT/active.json" ] && [ ! -L "$STATE_ROOT/active.json" ] \
    || die "ordinary promotion is active"
  local verification="$STATE_ROOT/layout-authority-verification.v1.json"
  local verification_temporary
  [ ! -e "$verification" ] || die "layout authority verification already exists"
  verification_temporary="$(mktemp "$STATE_ROOT/.layout-authority-verification.next.XXXXXXXX")"
  "$NODE_BIN" "$AUTH_BIN" verify \
    --request-envelope "$request" \
    --fault-drill-envelope "$drill" \
    --public-key "$OWNER_PUBLIC_KEY" >"$verification_temporary"
  chmod 600 "$verification_temporary"
  if [ "$TEST_MODE" != 1 ]; then chown root:root "$verification_temporary"; fi
  fsync_path "$verification_temporary"
  local expected_pm2 observed_pm2
  expected_pm2="$(extract_authority_field request.pm2AttestationSha256 "$verification_temporary")"
  observed_pm2="$(sha256_file "$PM2_ATTESTATION")"
  [ "$observed_pm2" = "$expected_pm2" ] \
    || die "root PM2 installation receipt differs from owner authority"

  local production_sha production_artifact production_installed
  local staging_sha staging_artifact staging_installed
  production_sha="$(extract_authority_field request.source.production.runtimeSha "$verification_temporary")"
  production_artifact="$(extract_authority_field request.source.production.artifactDigest "$verification_temporary")"
  production_installed="$(extract_authority_field request.source.production.installedRuntimeDigest "$verification_temporary")"
  staging_sha="$(extract_authority_field request.source.staging.runtimeSha "$verification_temporary")"
  staging_artifact="$(extract_authority_field request.source.staging.artifactDigest "$verification_temporary")"
  staging_installed="$(extract_authority_field request.source.staging.installedRuntimeDigest "$verification_temporary")"
  local old_production_runtime old_staging_runtime
  old_production_runtime="$(current_runtime "$OLD_PRODUCTION")"
  old_staging_runtime="$(current_runtime "$OLD_STAGING")"
  verify_runtime "$OLD_PRODUCTION" "$old_production_runtime" \
    "$production_sha" "$production_artifact" "$production_installed"
  verify_runtime "$OLD_STAGING" "$old_staging_runtime" \
    "$staging_sha" "$staging_artifact" "$staging_installed"
  verify_pm2_identity "$old_production_runtime" "$production_sha" \
    "$old_staging_runtime" "$staging_sha"
  [ "$(stat -c '%d' "$OLD_PRODUCTION")" = "$(stat -c '%d' "$RELEASE_ROOT")" ] \
    && [ "$(stat -c '%d' "$OLD_STAGING")" = "$(stat -c '%d' "$RELEASE_ROOT")" ] \
    || die "layout migration requires same-device atomic renames"
  [ ! -e "$PRODUCTION" ] && [ ! -L "$PRODUCTION" ] \
    && [ ! -e "$STAGING" ] && [ ! -L "$STAGING" ] \
    || die "authoritative destination is not empty"

  local home_details initial_details
  home_details="$(mktemp "$STATE_ROOT/.layout-home-identity.XXXXXXXX")"
  capture_worker_home "$home_details"
  initial_details="$(mktemp "$STATE_ROOT/.layout-initial.XXXXXXXX")"
  "$NODE_BIN" - "$initial_details" "$verification_temporary" "$home_details" \
    "$old_production_runtime" "$old_staging_runtime" "$observed_pm2" <<'NODE'
const fs=require('fs');const [output,verification,home,production,staging,pm2Sha]=process.argv.slice(2);
const authority=JSON.parse(fs.readFileSync(verification,'utf8'));
const homeIdentity=JSON.parse(fs.readFileSync(home,'utf8')).homeIdentity;
fs.writeFileSync(output,`${JSON.stringify({
 migrationId:authority.request.migrationId,
 requestEnvelopeSha256:authority.requestEnvelopeSha256,
 faultDrillEnvelopeSha256:authority.faultDrillEnvelopeSha256,
 pm2AttestationSha256:pm2Sha,homeIdentity,
 source:authority.request.source,
 oldRuntime:{production,staging},
 startedAt:new Date().toISOString(),
},null,2)}\n`,{mode:0o600,flag:'w'});
NODE
  write_json "$ACTIVE_JOURNAL" nexus.release-layout-migration-journal.v1 prepared "$initial_details"
  rm -f -- "$initial_details"
  layout_failure_recovery() {
    local status=$? recovery_status=0
    trap - EXIT
    if [ "$status" -ne 0 ] && [ -f "$ACTIVE_JOURNAL" ]; then
      # A function invoked on the left side of `||` or in an `if` condition
      # loses errexit semantics throughout its body. Run recovery as a
      # standalone strict subshell and inspect its status only afterwards.
      set +e
      (
        set -euo pipefail
        recover_layout
      )
      recovery_status=$?
      set -e
      if [ "$recovery_status" -ne 0 ]; then
        echo "automatic layout recovery failed; durable journal retained" >&2
      fi
    fi
    exit "$status"
  }
  trap layout_failure_recovery EXIT
  atomic_copy "$request" "$REQUEST_COPY"
  atomic_copy "$drill" "$DRILL_COPY"
  mv -T -- "$verification_temporary" "$verification"
  fsync_path "$STATE_ROOT"

  # Recheck while the /home parent is root-locked. From this point every
  # failure is handled by the durable recovery command or its boot unit.
  lock_worker_home "$home_details"
  verify_runtime "$OLD_PRODUCTION" "$old_production_runtime" \
    "$production_sha" "$production_artifact" "$production_installed"
  verify_runtime "$OLD_STAGING" "$old_staging_runtime" \
    "$staging_sha" "$staging_artifact" "$staging_installed"
  verify_pm2_identity "$old_production_runtime" "$production_sha" \
    "$old_staging_runtime" "$staging_sha"
  update_active_phase home_locked
  stop_role_apps staging
  update_active_phase staging_apps_stopped
  mv -T -- "$OLD_STAGING" "$STAGING"
  fsync_path "$RELEASE_ROOT"; fsync_path "$WORKER_HOME"
  update_active_phase staging_moved

  local new_production_runtime new_staging_runtime
  new_production_runtime="$PRODUCTION/releases/$(basename -- "$old_production_runtime")"
  new_staging_runtime="$STAGING/releases/$(basename -- "$old_staging_runtime")"
  rewrite_runtime_links staging "$STAGING" "$new_staging_runtime" "$old_staging_runtime"
  create_compatibility_link "$OLD_STAGING" "$STAGING"
  update_active_phase staging_compatibility_installed
  restore_worker_home "$home_details"
  update_active_phase staging_home_restored
  verify_runtime "$STAGING" "$new_staging_runtime" \
    "$staging_sha" "$staging_artifact" "$staging_installed"

  local production_readiness staging_readiness
  production_readiness="$(mktemp "$STATE_ROOT/.layout-production-readiness.XXXXXXXX")"
  staging_readiness="$(mktemp "$STATE_ROOT/.layout-staging-readiness.XXXXXXXX")"
  run_worker "$BASH_BIN" "$new_staging_runtime/scripts/remote-release-preflight.sh" \
    --role staging --base-dir "$STAGING" --release-dir "$new_staging_runtime" \
    --node-bin "$NODE_BIN" >&2
  start_role staging "$STAGING" "$new_staging_runtime" "$staging_sha"
  update_active_phase staging_started
  readiness_role staging "$STAGING" "$new_staging_runtime" \
    "$staging_sha" 60 "$staging_readiness"
  update_active_phase staging_ready
  verify_pm2_identity "$old_production_runtime" "$production_sha" \
    "$new_staging_runtime" "$staging_sha"

  # Reacquire the short /home parent lock and reverify the still-live exact
  # production predecessor immediately before its atomic rename.
  lock_worker_home "$home_details"
  verify_runtime "$OLD_PRODUCTION" "$old_production_runtime" \
    "$production_sha" "$production_artifact" "$production_installed"
  verify_pm2_identity "$old_production_runtime" "$production_sha" \
    "$new_staging_runtime" "$staging_sha"
  local outage_details outage_started outage_monotonic outage_boot_id
  outage_started="$(date +%s)"
  outage_monotonic="$(cut -d. -f1 </proc/uptime 2>/dev/null || printf 0)"
  outage_boot_id="$(cat /proc/sys/kernel/random/boot_id 2>/dev/null || printf test-boot)"
  outage_details="$(mktemp "$STATE_ROOT/.layout-outage-details.XXXXXXXX")"
  "$NODE_BIN" - "$outage_details" "$outage_started" "$outage_monotonic" \
    "$outage_boot_id" <<'NODE'
const fs=require('fs');
const [output,startedRaw,monotonicRaw,bootId]=process.argv.slice(2);
const started=Number(startedRaw),monotonic=Number(monotonicRaw);
fs.writeFileSync(output,`${JSON.stringify({
 productionOutageStartedEpoch:started,recoveryDeadlineEpoch:started+120,
 productionOutageStartedAt:new Date(started*1000).toISOString(),
 productionOutageStartedMonotonic:monotonic,productionOutageBootId:bootId,
},null,2)}\n`,{mode:0o600,flag:'w'});
NODE
  update_active_phase production_outage_armed "$outage_details"
  rm -f -- "$outage_details"
  RECOVERY_DEADLINE_EPOCH="$(( outage_started + 120 ))"
  stop_role_apps production
  update_active_phase production_apps_stopped
  mv -T -- "$OLD_PRODUCTION" "$PRODUCTION"
  fsync_path "$RELEASE_ROOT"; fsync_path "$WORKER_HOME"
  update_active_phase production_moved
  rewrite_runtime_links production "$PRODUCTION" "$new_production_runtime" "$old_production_runtime"
  create_compatibility_link "$OLD_PRODUCTION" "$PRODUCTION"
  update_active_phase production_compatibility_installed
  restore_worker_home "$home_details"
  rm -f -- "$home_details"
  update_active_phase home_restored
  verify_runtime "$PRODUCTION" "$new_production_runtime" \
    "$production_sha" "$production_artifact" "$production_installed"
  local production_preflight_timeout
  production_preflight_timeout="$(bounded_seconds 30)"
  run_worker "$TIMEOUT_BIN" --signal=TERM --kill-after=5s "${production_preflight_timeout}s" \
    "$BASH_BIN" "$new_production_runtime/scripts/remote-release-preflight.sh" \
    --role production --base-dir "$PRODUCTION" --release-dir "$new_production_runtime" \
    --node-bin "$NODE_BIN" >&2
  start_role production "$PRODUCTION" "$new_production_runtime" "$production_sha"
  update_active_phase production_started
  local availability_readiness availability_details availability_epoch
  availability_readiness="$(mktemp "$STATE_ROOT/.layout-production-availability.XXXXXXXX")"
  readiness_role production "$PRODUCTION" "$new_production_runtime" \
    "$production_sha" 0 "$availability_readiness" 8
  availability_epoch="$(date +%s)"
  [ "$(( availability_epoch - outage_started ))" -le 120 ] \
    || die "production availability was not restored within 120 seconds"
  availability_details="$(mktemp "$STATE_ROOT/.layout-availability-details.XXXXXXXX")"
  "$NODE_BIN" - "$availability_details" "$availability_epoch" "$outage_started" \
    "$availability_readiness" <<'NODE'
const crypto=require('crypto');const fs=require('fs');
const [output,availableRaw,startedRaw,evidence]=process.argv.slice(2);
const available=Number(availableRaw),started=Number(startedRaw);
fs.writeFileSync(output,`${JSON.stringify({
 productionAvailabilityRestoredEpoch:available,
 productionAvailabilityRestoredAt:new Date(available*1000).toISOString(),
 productionUnavailabilitySeconds:available-started,
 productionAvailabilityReadinessSha256:crypto.createHash('sha256')
  .update(fs.readFileSync(evidence)).digest('hex'),
},null,2)}\n`,{mode:0o600,flag:'w'});
NODE
  update_active_phase production_available "$availability_details"
  rm -f -- "$availability_details" "$availability_readiness"
  # Customer availability has been restored. A later soak failure starts a
  # fresh, explicitly journaled recovery window in recover_layout.
  RECOVERY_DEADLINE_EPOCH=""
  readiness_role production "$PRODUCTION" "$new_production_runtime" \
    "$production_sha" 60 "$production_readiness"
  update_active_phase production_ready
  verify_pm2_identity "$new_production_runtime" "$production_sha" \
    "$new_staging_runtime" "$staging_sha"
  local pm2_dump_sha256
  pm2_dump_sha256="$(persist_and_verify_pm2_dump \
    "$new_production_runtime" "$production_sha" \
    "$new_staging_runtime" "$staging_sha")"
  verify_pm2_identity "$new_production_runtime" "$production_sha" \
    "$new_staging_runtime" "$staging_sha"

  local terminal_details
  terminal_details="$(mktemp "$STATE_ROOT/.layout-terminal-details.XXXXXXXX")"
  "$NODE_BIN" - "$terminal_details" "$verification" "$PM2_ATTESTATION" \
    "$production_readiness" "$staging_readiness" \
    "$PRODUCTION" "$STAGING" "$new_production_runtime" "$new_staging_runtime" \
    "$pm2_dump_sha256" <<'NODE'
const crypto=require('crypto');const fs=require('fs');const path=require('path');
const [output,verification,pm2,productionReadiness,stagingReadiness,
 productionBase,stagingBase,productionRuntime,stagingRuntime,
 pm2DumpSha256]=process.argv.slice(2);
const authority=JSON.parse(fs.readFileSync(verification,'utf8'));
const digest=(file)=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
if(!/^[a-f0-9]{64}$/u.test(pm2DumpSha256||''))process.exit(1);
const identity=(base,runtime)=>{
 const root=fs.lstatSync(path.dirname(base)),baseStat=fs.lstatSync(base);
 const releases=fs.lstatSync(path.join(base,'releases')),runtimeStat=fs.lstatSync(runtime);
 const item=(entryPath,stat)=>({path:entryPath,dev:String(stat.dev),ino:String(stat.ino)});
 const selectorPath=path.join(base,'current'),selectorStat=fs.lstatSync(selectorPath);
 if(!selectorStat.isSymbolicLink()||fs.readlinkSync(selectorPath)!==runtime
  ||fs.realpathSync.native(selectorPath)!==runtime)process.exit(1);
 return {releaseRoot:item(path.dirname(base),root),base:item(base,baseStat),
  releases:item(path.join(base,'releases'),releases),runtime:item(runtime,runtimeStat),
  currentSelector:{schema:'nexus.release-current-selector-identity.v1',
   ...item(selectorPath,selectorStat),target:runtime,uid:selectorStat.uid,gid:selectorStat.gid}};
};
fs.writeFileSync(output,`${JSON.stringify({
 migrationId:authority.request.migrationId,
 requestEnvelopeSha256:authority.requestEnvelopeSha256,
 faultDrillEnvelopeSha256:authority.faultDrillEnvelopeSha256,
 pm2AttestationSha256:digest(pm2),
 source:authority.request.source,
 runtime:{production:productionRuntime,staging:stagingRuntime},
 filesystem:{
  production:identity(productionBase,productionRuntime),
  staging:identity(stagingBase,stagingRuntime),
 },
 pm2DumpSha256,
 readinessSha256:{production:digest(productionReadiness),staging:digest(stagingReadiness)},
 completedAt:new Date().toISOString(),
},null,2)}\n`,{mode:0o600,flag:'w'});
NODE
  write_json "$TERMINAL_JOURNAL" nexus.release-layout-migration-terminal-journal.v1 completed "$terminal_details"
  local terminal_sha result_details result_sha marker_details
  terminal_sha="$(sha256_file "$TERMINAL_JOURNAL")"
  result_details="$(mktemp "$STATE_ROOT/.layout-result-details.XXXXXXXX")"
  "$NODE_BIN" - "$result_details" "$TERMINAL_JOURNAL" "$terminal_sha" <<'NODE'
const fs=require('fs');const [output,journalFile,journalSha]=process.argv.slice(2);
const journal=JSON.parse(fs.readFileSync(journalFile,'utf8'));
fs.writeFileSync(output,`${JSON.stringify({
 migrationId:journal.migrationId,terminalJournalSha256:journalSha,
 requestEnvelopeSha256:journal.requestEnvelopeSha256,
 faultDrillEnvelopeSha256:journal.faultDrillEnvelopeSha256,
 pm2AttestationSha256:journal.pm2AttestationSha256,
 source:journal.source,runtime:journal.runtime,filesystem:journal.filesystem,
 pm2DumpSha256:journal.pm2DumpSha256,
 readinessSha256:journal.readinessSha256,completedAt:journal.completedAt,
},null,2)}\n`,{mode:0o600,flag:'w'});
NODE
  write_json "$RESULT" nexus.release-layout-migration-result.v1 passed "$result_details"
  result_sha="$(sha256_file "$RESULT")"
  marker_details="$(mktemp "$STATE_ROOT/.layout-marker-details.XXXXXXXX")"
  "$NODE_BIN" - "$marker_details" "$RESULT" "$terminal_sha" "$result_sha" \
    "$RELEASE_ROOT" "$PRODUCTION" "$STAGING" "$OLD_PRODUCTION" "$OLD_STAGING" <<'NODE'
const fs=require('fs');const [output,resultFile,terminalSha,resultSha,releaseRoot,
 productionBase,stagingBase,oldProduction,oldStaging]=process.argv.slice(2);
const result=JSON.parse(fs.readFileSync(resultFile,'utf8'));
fs.writeFileSync(output,`${JSON.stringify({
 releaseRoot,productionBase,stagingBase,
 previous:{production:oldProduction,staging:oldStaging},
 requestEnvelopeSha256:result.requestEnvelopeSha256,
 faultDrillEnvelopeSha256:result.faultDrillEnvelopeSha256,
 pm2AttestationSha256:result.pm2AttestationSha256,
 terminalJournalSha256:terminalSha,resultSha256:resultSha,
 production:{...result.source.production,currentRuntime:result.runtime.production,
  filesystem:result.filesystem.production},
 staging:{...result.source.staging,currentRuntime:result.runtime.staging,
  filesystem:result.filesystem.staging},
 pm2DumpSha256:result.pm2DumpSha256,
 readinessSha256:result.readinessSha256,soakSeconds:60,
 completedAt:result.completedAt,
},null,2)}\n`,{mode:0o600,flag:'w'});
NODE
  write_json "$ATTESTATION" nexus.release-layout-migration.v1 passed "$marker_details"
  rm -f -- "$production_readiness" "$staging_readiness" "$terminal_details" \
    "$result_details" "$marker_details" "$ACTIVE_JOURNAL"
  fsync_path "$STATE_ROOT"
  trap - EXIT
  printf '{"ok":true,"schema":"%s","status":"completed","attestationSha256":"%s"}\n' \
    "$VERSION" "$(sha256_file "$ATTESTATION")"
}

install -d -m 700 "$STATE_ROOT"
if [ "$TEST_MODE" != 1 ]; then chown root:root "$STATE_ROOT"; fi
if [ "$COMMAND" = migrate ]; then
  # Ordinary releases are still fail-closed because no layout attestation
  # exists. Validate the PM2 closure under the control lock, then acquire that
  # same lock for the one-shot migration without recursive flock deadlock.
  "$CONTROL_BIN" assert-root-pm2-ready >/dev/null
fi
exec 9>"$STATE_ROOT/.control.lock"
chmod 600 "$STATE_ROOT/.control.lock"
flock -x 9
if [ "$TEST_MODE" = 1 ] && [ ! -e "$LOCK_FILE" ]; then
  install -d -m 700 "$(dirname -- "$LOCK_FILE")"
  : >"$LOCK_FILE"
fi
[ -f "$LOCK_FILE" ] && [ ! -L "$LOCK_FILE" ] || die "shared release/Sonar mutex is unavailable"
exec 8>"$LOCK_FILE"
flock -x 8

case "$COMMAND" in
  version) printf '%s\n' "$VERSION" ;;
  status)
    if [ -f "$ATTESTATION" ] && [ ! -L "$ATTESTATION" ]; then
      printf '{"ok":true,"schema":"%s","status":"completed"}\n' "$VERSION"
    elif [ -f "$ACTIVE_JOURNAL" ] && [ ! -L "$ACTIVE_JOURNAL" ]; then
      "$NODE_BIN" - "$ACTIVE_JOURNAL" <<'NODE'
const fs=require('fs');const x=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
process.stdout.write(`${JSON.stringify({ok:true,schema:'nexus-release-layout-migrate.v1',
 status:'in_progress',phase:x.phase})}\n`);
NODE
    else printf '{"ok":true,"schema":"%s","status":"not_started"}\n' "$VERSION"
    fi
    ;;
  migrate) migrate_layout "$@" ;;
  recover) recover_layout ;;
  *) echo "Usage: remote-release-layout-migrate.sh <version|status|migrate|recover>" >&2; exit 64 ;;
esac
