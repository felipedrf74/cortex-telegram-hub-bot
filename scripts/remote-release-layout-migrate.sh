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
SQLITE_HELPER="${NEXUS_LAYOUT_SQLITE_HELPER:-/usr/local/libexec/nexus-release-layout-sqlite.py}"
LAYOUT_PREFLIGHT="${NEXUS_LAYOUT_PREFLIGHT:-/usr/local/libexec/nexus-release-layout-preflight.sh}"
CP_BIN="${NEXUS_LAYOUT_CP_BIN:-/usr/bin/cp}"
MOUNT_BIN="${NEXUS_LAYOUT_MOUNT_BIN:-/usr/bin/mount}"
UMOUNT_BIN="${NEXUS_LAYOUT_UMOUNT_BIN:-/usr/bin/umount}"
FINDMNT_BIN="${NEXUS_LAYOUT_FINDMNT_BIN:-/usr/bin/findmnt}"
FLOCK_BIN="${NEXUS_LAYOUT_FLOCK_BIN:-/usr/bin/flock}"
SELECTOR_SWITCH="${NEXUS_PROMOTION_SELECTOR_SWITCH:-/usr/local/libexec/nexus-release-selector-switch.py}"
BOOT_HEALTH_BIN="${NEXUS_PROMOTION_BOOT_HEALTH_BIN:-/usr/local/sbin/nexus-release-boot-health}"
if [ "$TEST_MODE" = 1 ]; then
  PYTHON_BIN="${NEXUS_PROMOTION_PYTHON_BIN:-$(command -v python3)}"
  if [ -z "${NEXUS_PROMOTION_SELECTOR_SWITCH:-}" ]; then
    SELECTOR_SWITCH="$(cd "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/remote-release-selector-switch.py"
  fi
  if [ -z "${NEXUS_LAYOUT_SQLITE_HELPER:-}" ]; then
    SQLITE_HELPER="$(cd "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/release-layout-sqlite.py"
  fi
  if [ -z "${NEXUS_LAYOUT_FINDMNT_BIN:-}" ] && [ ! -x "$FINDMNT_BIN" ]; then
    FINDMNT_BIN="/usr/bin/true"
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
PREDECESSOR_ROOT="$RELEASE_ROOT/layout-predecessors"
RECOVERY_POINT_ROOT="$STATE_ROOT/layout-recovery-points"
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
  "$SELECTOR_SWITCH" "$BOOT_HEALTH_BIN" "$SQLITE_HELPER" "$LAYOUT_PREFLIGHT" \
  "$CP_BIN" "$MOUNT_BIN" "$UMOUNT_BIN" "$FINDMNT_BIN" "$FLOCK_BIN"; do
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

timing_sample() {
  "$NODE_BIN" - <<'NODE'
const fs=require('fs');
const epochMs=Date.now();
const seconds=Number(fs.readFileSync('/proc/uptime','utf8').trim().split(/\s+/u)[0]);
const bootId=fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim();
if(!Number.isFinite(seconds)||seconds<0
 ||!/^[0-9a-f-]{36}$/u.test(bootId)&&process.env.NEXUS_RELEASE_TEST_MODE!=='1')process.exit(1);
process.stdout.write(`${epochMs}\t${Math.floor(seconds*1000)}\t${bootId}\n`);
NODE
}

timing_evidence() {
  local start_epoch_ms="$1" start_monotonic_ms="$2" start_boot_id="$3"
  local end_epoch_ms="$4" end_monotonic_ms="$5" end_boot_id="$6" output="$7"
  "$NODE_BIN" - "$start_epoch_ms" "$start_monotonic_ms" "$start_boot_id" \
    "$end_epoch_ms" "$end_monotonic_ms" "$end_boot_id" "$output" <<'NODE'
const fs=require('fs');
const [startEpochRaw,startMonoRaw,startBootId,endEpochRaw,endMonoRaw,endBootId,output]=process.argv.slice(2);
const startEpochMs=Number(startEpochRaw),startMonotonicMs=Number(startMonoRaw);
const endEpochMs=Number(endEpochRaw),endMonotonicMs=Number(endMonoRaw);
if(![startEpochMs,startMonotonicMs,endEpochMs,endMonotonicMs].every(Number.isSafeInteger)
 ||endEpochMs<startEpochMs)process.exit(1);
const sameBoot=startBootId===endBootId;
const durationMs=sameBoot?endMonotonicMs-startMonotonicMs:endEpochMs-startEpochMs;
if(durationMs<0)process.exit(1);
const value={
 schema:'nexus.release-layout-unavailability.v1',
 targetMilliseconds:120000,
 targetMet:sameBoot&&durationMs<=120000,
 timingBasis:sameBoot?'same_boot_monotonic':'cross_boot_wall_diagnostic',
 start:{epochMs:startEpochMs,monotonicMs:startMonotonicMs,bootId:startBootId},
 end:{epochMs:endEpochMs,monotonicMs:endMonotonicMs,bootId:endBootId},
 durationMilliseconds:durationMs,
};
fs.writeFileSync(output,`${JSON.stringify(value,null,2)}\n`,{mode:0o600,flag:'w'});
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
  &&(Number.isSafeInteger(journal.productionOutageStartedMonotonicMs)
    ||Number.isSafeInteger(journal.productionOutageStartedMonotonic))
   ?Number.isSafeInteger(journal.productionOutageStartedMonotonicMs)
     ?Math.floor(journal.productionOutageStartedMonotonicMs/1000)
     :journal.productionOutageStartedMonotonic
   :monotonic,
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

verify_legacy_runtime() {
  local base="$1" runtime="$2" sha="$3" artifact="$4" installed="$5"
  [ "$runtime" != "$base/releases" ] && [[ "$runtime" == "$base"/releases/* ]] \
    || die "legacy current runtime is outside its exact release base"
  if [ "$TEST_MODE" = 1 ]; then
    NODE_ENV=test NEXUS_LAYOUT_TEST_LEGACY_BASE="$base" \
      "$NODE_BIN" "$ATTESTOR" legacy-intake --root "$runtime" --base "$base" \
      --runtime-sha "$sha" --artifact-digest "$artifact" \
      --installed-runtime-digest "$installed" --group-id "$WORKER_GID" \
      --owner-id "$WORKER_UID" >/dev/null
  else
    "$NODE_BIN" "$ATTESTOR" legacy-intake --root "$runtime" --base "$base" \
      --runtime-sha "$sha" --artifact-digest "$artifact" \
      --installed-runtime-digest "$installed" --group-id "$WORKER_GID" \
      --owner-id "$WORKER_UID" >/dev/null
  fi
}

seal_runtime() {
  local base="$1" runtime="$2" sha="$3" artifact="$4" installed="$5"
  "$NODE_BIN" "$ATTESTOR" seal --root "$runtime" --base "$base" \
    --runtime-sha "$sha" --artifact-digest "$artifact" \
    --installed-runtime-digest "$installed" --group-id "$WORKER_GID" >/dev/null
  verify_runtime "$base" "$runtime" "$sha" "$artifact" "$installed"
}

rewrite_runtime_links_only() {
  local base="$1" runtime="$2"
  "$NODE_BIN" - "$base" "$runtime" <<'NODE'
const fs=require('fs');const path=require('path');const [base,runtime]=process.argv.slice(2);
if(!runtime.startsWith(`${path.join(base,'releases')}${path.sep}`))process.exit(1);
for(const name of ['.env','data','logs']){
 const link=path.join(runtime,name),next=`${link}.layout-next`;
 const current=fs.lstatSync(link);
 if(!current.isSymbolicLink())process.exit(1);
 if(fs.lstatSync(next,{throwIfNoEntry:false}))fs.unlinkSync(next);
 fs.symlinkSync(path.join(base,name),next);fs.renameSync(next,link);
}
const descriptor=fs.openSync(runtime,'r');
try{fs.fsyncSync(descriptor);}finally{fs.closeSync(descriptor);}
NODE
}

prepare_destination_runtime() {
  local role="$1" old_base="$2" new_base="$3" old_runtime="$4"
  local sha="$5" artifact="$6" installed="$7" new_runtime
  new_runtime="$new_base/releases/$(basename -- "$old_runtime")"
  [ ! -e "$new_base" ] && [ ! -L "$new_base" ] \
    || die "$role authoritative destination already exists"
  if [ "$TEST_MODE" = 1 ]; then
    install -d -m 700 "$new_base"
    install -d -m 700 "$new_base/releases"
    "$CP_BIN" -a -- "$old_runtime" "$new_runtime"
  else
    install -d -o root -g root -m 700 "$new_base"
    install -d -o root -g root -m 700 "$new_base/releases"
    "$CP_BIN" -a --reflink=never -- "$old_runtime" "$new_runtime"
  fi
  rewrite_runtime_links_only "$new_base" "$new_runtime"
  fsync_path "$new_base/releases"; fsync_path "$new_base"
  seal_runtime "$new_base" "$new_runtime" "$sha" "$artifact" "$installed"
  printf '%s\n' "$new_runtime"
}

safe_remove_prepared_base() {
  local base="$1"
  case "$base" in "$PRODUCTION"|"$STAGING") ;; *) die "prepared-base cleanup target is unsafe" ;; esac
  [ -e "$base" ] || [ -L "$base" ] || return 0
  [ -d "$base" ] && [ ! -L "$base" ] || die "prepared-base cleanup identity is unsafe"
  rm -rf --one-file-system -- "$base"
  fsync_path "$RELEASE_ROOT"
}

normalize_authoritative_environment() {
  local role="$1" destination="$2"
  "$NODE_BIN" - "$ACTIVE_JOURNAL" "$destination/.env" "$role" \
    "$WORKER_GID" "$TEST_MODE" <<'NODE'
const crypto=require('crypto');const fs=require('fs');
const [journalFile,environmentFile,role,workerGidRaw,testMode]=process.argv.slice(2);
const expected=JSON.parse(fs.readFileSync(journalFile)).legacyMutable?.[role]?.environment;
const stat=fs.lstatSync(environmentFile);
const digest=crypto.createHash('sha256').update(fs.readFileSync(environmentFile)).digest('hex');
if(!expected||!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1
 ||String(stat.dev)!==expected.dev||String(stat.ino)!==expected.ino
 ||stat.uid!==expected.uid||stat.gid!==expected.gid
 ||(stat.mode&0o7777)!==expected.mode||stat.size!==expected.sizeBytes
 ||digest!==expected.sha256)process.exit(1);
const authorityUid=testMode==='1'?process.getuid():0;
const authorityGid=testMode==='1'?process.getgid():Number(workerGidRaw);
const descriptor=fs.openSync(environmentFile,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));
try{
 fs.fchownSync(descriptor,authorityUid,authorityGid);fs.fchmodSync(descriptor,0o440);
 fs.fsyncSync(descriptor);
 const sealed=fs.fstatSync(descriptor);
 if(sealed.uid!==authorityUid||sealed.gid!==authorityGid
  ||(sealed.mode&0o7777)!==0o440||String(sealed.dev)!==expected.dev
  ||String(sealed.ino)!==expected.ino)process.exit(1);
}finally{fs.closeSync(descriptor);}
NODE
  fsync_path "$destination"
}

restore_legacy_environment_metadata() {
  local role="$1" destination="$2"
  "$NODE_BIN" - "$ACTIVE_JOURNAL" "$destination/.env" "$role" <<'NODE'
const crypto=require('crypto');const fs=require('fs');
const [journalFile,environmentFile,role]=process.argv.slice(2);
const expected=JSON.parse(fs.readFileSync(journalFile)).legacyMutable?.[role]?.environment;
if(!expected)process.exit(1);
const descriptor=fs.openSync(environmentFile,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));
try{
 const stat=fs.fstatSync(descriptor);
 const digest=crypto.createHash('sha256').update(fs.readFileSync(descriptor)).digest('hex');
 if(!stat.isFile()||stat.nlink!==1||String(stat.dev)!==expected.dev
  ||String(stat.ino)!==expected.ino||stat.size!==expected.sizeBytes
  ||digest!==expected.sha256)process.exit(1);
 fs.fchownSync(descriptor,expected.uid,expected.gid);fs.fchmodSync(descriptor,expected.mode);
 fs.fsyncSync(descriptor);
}finally{fs.closeSync(descriptor);}
NODE
  fsync_path "$destination"
}

restore_legacy_base_metadata() {
  local role="$1" base="$2"
  "$NODE_BIN" - "$ACTIVE_JOURNAL" "$base" "$role" <<'NODE'
const fs=require('fs');const [journalFile,base,role]=process.argv.slice(2);
const expected=JSON.parse(fs.readFileSync(journalFile)).legacyMutable?.[role]?.base;
if(!expected)process.exit(1);
const descriptor=fs.openSync(base,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY
 |(fs.constants.O_NOFOLLOW??0));
try{
 const stat=fs.fstatSync(descriptor);
 if(String(stat.dev)!==expected.dev||String(stat.ino)!==expected.ino)process.exit(1);
 fs.fchownSync(descriptor,expected.uid,expected.gid);fs.fchmodSync(descriptor,expected.mode);
 fs.fsyncSync(descriptor);
}finally{fs.closeSync(descriptor);}
NODE
  fsync_path "$WORKER_HOME"
}

pin_recovered_legacy_base() {
  local role="$1" base="$2"
  "$NODE_BIN" - "$ACTIVE_JOURNAL" "$base" "$role" "$TEST_MODE" <<'NODE'
const fs=require('fs');const [journalFile,base,role,testMode]=process.argv.slice(2);
const expected=JSON.parse(fs.readFileSync(journalFile)).legacyMutable?.[role]?.base;
if(!expected)process.exit(1);
const authorityUid=testMode==='1'?process.getuid():0;
const authorityGid=testMode==='1'?process.getgid():0;
const descriptor=fs.openSync(base,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY
 |(fs.constants.O_NOFOLLOW??0));
try{
 const stat=fs.fstatSync(descriptor);
 if(String(stat.dev)!==expected.dev||String(stat.ino)!==expected.ino
  ||!((stat.uid===expected.uid&&stat.gid===expected.gid
     &&(stat.mode&0o7777)===expected.mode)
    ||(stat.uid===authorityUid&&stat.gid===authorityGid
     &&(stat.mode&0o7777)===0o700)))process.exit(1);
 fs.fchownSync(descriptor,authorityUid,authorityGid);fs.fchmodSync(descriptor,0o700);
 fs.fsyncSync(descriptor);
 const pinned=fs.fstatSync(descriptor),live=fs.lstatSync(base);
 if(pinned.uid!==authorityUid||pinned.gid!==authorityGid
  ||(pinned.mode&0o7777)!==0o700||String(live.dev)!==expected.dev
  ||String(live.ino)!==expected.ino)process.exit(1);
}finally{fs.closeSync(descriptor);}
NODE
  fsync_path "$WORKER_HOME"
  if [ "$TEST_MODE" != 1 ]; then
    if ! "$FINDMNT_BIN" --mountpoint "$base" --noheadings --output TARGET >/dev/null 2>&1; then
      "$MOUNT_BIN" --bind "$base" "$base"
    fi
    [ "$("$FINDMNT_BIN" --mountpoint "$base" --noheadings --output TARGET)" = "$base" ] \
      || die "$role recovered legacy root is not mount-pinned"
  fi
}

move_mutable_state() {
  local role="$1" source="$2" destination="$3" name
  for name in .env data logs; do
    [ -e "$source/$name" ] && [ ! -L "$source/$name" ] \
      || die "legacy mutable state is missing or symbolic: $name"
    [ ! -e "$destination/$name" ] && [ ! -L "$destination/$name" ] \
      || die "authoritative mutable-state target is occupied: $name"
    mv -T -- "$source/$name" "$destination/$name"
    fsync_path "$source"; fsync_path "$destination"
  done
  normalize_authoritative_environment "$role" "$destination"
}

restore_mutable_state() {
  local role="$1" source="$2" destination="$3" name
  for name in .env data logs; do
    if [ -e "$source/$name" ] || [ -L "$source/$name" ]; then
      [ -e "$source/$name" ] && [ ! -L "$source/$name" ] \
        || die "authoritative mutable state is unsafe during recovery: $name"
      [ ! -e "$destination/$name" ] && [ ! -L "$destination/$name" ] \
        || die "predecessor mutable-state target is occupied during recovery: $name"
      mv -T -- "$source/$name" "$destination/$name"
      fsync_path "$source"; fsync_path "$destination"
    fi
  done
  if [ -f "$destination/.env" ] && [ ! -L "$destination/.env" ]; then
    restore_legacy_environment_metadata "$role" "$destination"
  fi
}

move_role_to_authoritative() {
  local role="$1" old="$2" new="$3" old_runtime="$4" new_runtime="$5"
  local migration_id predecessor predecessor_runtime
  migration_id="$(extract_authority_field request.migrationId)"
  predecessor="$PREDECESSOR_ROOT/$migration_id/$role"
  [ -d "$predecessor" ] && [ ! -L "$predecessor" ] \
    || die "$role protected predecessor is missing"
  [ ! -e "$old" ] && [ ! -L "$old" ] \
    || die "$role legacy path was reoccupied after protected rename"
  predecessor_runtime="$predecessor/releases/$(basename -- "$old_runtime")"
  assert_moved_predecessor "$role" "$predecessor_runtime"
  move_mutable_state "$role" "$predecessor" "$new"
  layout_selector_initialize "$role" "$new_runtime"
  create_compatibility_link "$old" "$new"
}

rollback_role_layout() {
  local role="$1" old="$2" new="$3"
  local migration_id predecessor
  migration_id="$("$NODE_BIN" - "$ACTIVE_JOURNAL" <<'NODE'
const fs=require('fs');const x=JSON.parse(fs.readFileSync(process.argv[2]));
if(!/^[0-9a-f-]{36}$/u.test(x.migrationId||''))process.exit(1);
process.stdout.write(x.migrationId);
NODE
  )"
  predecessor="$PREDECESSOR_ROOT/$migration_id/$role"
  if [ -d "$predecessor" ] && [ ! -L "$predecessor" ]; then
    remove_compatibility_mount "$old" "$new"
    if [ -d "$new" ] && [ ! -L "$new" ]; then
      restore_mutable_state "$role" "$new" "$predecessor"
    elif [ -e "$new" ] || [ -L "$new" ]; then
      die "$role authoritative base is unsafe during recovery"
    fi
    [ ! -e "$old" ] && [ ! -L "$old" ] \
      || die "$role compatibility source is occupied during recovery"
    mv -T -- "$predecessor" "$old"
    fsync_path "$(dirname -- "$predecessor")"; fsync_path "$WORKER_HOME"
    safe_remove_prepared_base "$new"
  elif [ -d "$old" ] && [ ! -L "$old" ]; then
    safe_remove_prepared_base "$new"
  else
    die "$role layout has no exact recoverable predecessor"
  fi
}

prepare_database_recovery_point() {
  local migration_id database directory recovery_point snapshot_evidence details
  migration_id="$(extract_authority_field request.migrationId)"
  database="$OLD_PRODUCTION/data/bot.db"
  [ -f "$database" ] && [ ! -L "$database" ] \
    || die "production database is missing or symbolic"
  directory="$RECOVERY_POINT_ROOT/$migration_id"
  if [ "$TEST_MODE" = 1 ]; then install -d -m 700 "$RECOVERY_POINT_ROOT" "$directory"
  else install -d -o root -g root -m 700 "$RECOVERY_POINT_ROOT" "$directory"; fi
  recovery_point="$directory/pre-outage.sqlite"
  [ ! -e "$recovery_point" ] && [ ! -L "$recovery_point" ] \
    || die "layout database recovery point already exists"
  snapshot_evidence="$directory/pre-outage.evidence.json"
  "$PYTHON_BIN" "$SQLITE_HELPER" snapshot "$database" "$recovery_point" >"$snapshot_evidence"
  chmod 600 "$recovery_point" "$snapshot_evidence"
  if [ "$TEST_MODE" != 1 ]; then chown root:root "$recovery_point" "$snapshot_evidence"; fi
  fsync_path "$recovery_point"; fsync_path "$snapshot_evidence"; fsync_path "$directory"
  details="$(mktemp "$STATE_ROOT/.layout-database-recovery.XXXXXXXX")"
  "$NODE_BIN" - "$database" "$recovery_point" "$snapshot_evidence" "$details" <<'NODE'
const crypto=require('crypto');const fs=require('fs');
const [database,recoveryPoint,evidenceFile,output]=process.argv.slice(2);
const source=fs.lstatSync(database),point=fs.lstatSync(recoveryPoint);
const evidence=JSON.parse(fs.readFileSync(evidenceFile,'utf8'));
const digest=(file)=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
if(!source.isFile()||source.isSymbolicLink()||source.nlink!==1
 ||!point.isFile()||point.isSymbolicLink()||point.nlink!==1
 ||point.size<=0||point.size>2*1024*1024*1024
 ||evidence.schema!=='nexus.release-layout-sqlite-recovery-point.v1'
 ||evidence.sha256!==digest(recoveryPoint)||evidence.sizeBytes!==point.size
 ||evidence.integrityCheck!=='ok'||evidence.foreignKeyCheck!=='ok')process.exit(1);
fs.writeFileSync(output,`${JSON.stringify({databaseRecovery:{
 schema:'nexus.release-layout-database-recovery.v1',
 recoveryPointPath:recoveryPoint,recoveryPointSha256:evidence.sha256,
 recoveryPointSizeBytes:evidence.sizeBytes,
 source:{device:String(source.dev),inode:String(source.ino),sizeBytes:source.size,
  uid:source.uid,gid:source.gid,mode:source.mode&0o7777},
 snapshotEvidenceSha256:digest(evidenceFile),
}},null,2)}\n`,{mode:0o600,flag:'w'});
NODE
  update_active_phase database_recovery_ready "$details"
  rm -f -- "$details" "$snapshot_evidence"
}

assert_database_stopped() {
  local base="$1"
  # `fuser` exit 1 conflates "no users" with inspection failure. The root
  # /proc scan is authoritative and covers FDs, cwd/root/exe, and mmaps.
  assert_no_process_references "$base"
}

capture_database_boundary() {
  local base="$1" database evidence details directory stopped_copy copy_evidence path_entry
  local stopped_sha stopped_size
  database="$base/data/bot.db"
  assert_database_stopped "$base"
  directory="$("$NODE_BIN" - "$ACTIVE_JOURNAL" <<'NODE'
const fs=require('fs');const path=require('path');
const value=JSON.parse(fs.readFileSync(process.argv[2])).databaseRecovery?.recoveryPointPath;
if(typeof value!=='string'||!path.isAbsolute(value))process.exit(1);
process.stdout.write(path.dirname(value));
NODE
)"
  [ -d "$directory" ] && [ ! -L "$directory" ] \
    || die "database recovery directory is unsafe"
  evidence="$directory/stopped-boundary.observed.json"
  stopped_copy="$directory/stopped-boundary.sqlite"
  copy_evidence="$directory/stopped-boundary.copy-evidence.json"
  for path_entry in "$evidence" "$stopped_copy" "$copy_evidence"; do
    [ ! -e "$path_entry" ] && [ ! -L "$path_entry" ] \
      || die "stopped-boundary recovery target already exists"
  done
  "$PYTHON_BIN" "$SQLITE_HELPER" stopped-boundary "$database" >"$evidence"
  chmod 600 "$evidence"
  if [ "$TEST_MODE" != 1 ]; then chown root:root "$evidence"; fi
  fsync_path "$evidence"; fsync_path "$directory"
  read -r stopped_sha stopped_size < <(
    "$NODE_BIN" - "$evidence" <<'NODE'
const fs=require('fs');const value=JSON.parse(fs.readFileSync(process.argv[2]));
if(value.schema!=='nexus.release-layout-sqlite-stopped-boundary.v1'
 ||!/^[a-f0-9]{64}$/u.test(value.sha256||'')
 ||!Number.isSafeInteger(value.sizeBytes)||value.sizeBytes<=0)process.exit(1);
process.stdout.write(`${value.sha256}\t${value.sizeBytes}`);
NODE
  )
  "$PYTHON_BIN" "$SQLITE_HELPER" copy-stopped-boundary \
    "$database" "$stopped_copy" --sha256 "$stopped_sha" --size "$stopped_size" \
    >"$copy_evidence"
  chmod 600 "$stopped_copy" "$copy_evidence"
  if [ "$TEST_MODE" != 1 ]; then chown root:root "$stopped_copy" "$copy_evidence"; fi
  fsync_path "$stopped_copy"; fsync_path "$copy_evidence"; fsync_path "$directory"
  details="$(mktemp "$STATE_ROOT/.layout-database-boundary-details.XXXXXXXX")"
  "$NODE_BIN" - "$ACTIVE_JOURNAL" "$evidence" "$stopped_copy" \
    "$copy_evidence" "$details" <<'NODE'
const crypto=require('crypto');const fs=require('fs');
const [journalFile,evidenceFile,stoppedCopy,copyEvidenceFile,output]=process.argv.slice(2);
const journal=JSON.parse(fs.readFileSync(journalFile));
const evidence=JSON.parse(fs.readFileSync(evidenceFile));
const copyEvidence=JSON.parse(fs.readFileSync(copyEvidenceFile));
const source=journal.databaseRecovery?.source;
const digest=(file)=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const stoppedStat=fs.lstatSync(stoppedCopy);
if(evidence.schema!=='nexus.release-layout-sqlite-stopped-boundary.v1'
 ||evidence.device!==source?.device||evidence.inode!==source?.inode
 ||!/^[a-f0-9]{64}$/u.test(evidence.sha256||'')
 ||!Number.isSafeInteger(evidence.sizeBytes)||evidence.sizeBytes<=0
 ||evidence.sizeBytes>2*1024*1024*1024||evidence.walCheckpoint!=='truncate'
 ||evidence.integrityCheck!=='ok'||evidence.foreignKeyCheck!=='ok'
 ||copyEvidence.schema!=='nexus.release-layout-sqlite-stopped-copy.v1'
 ||copyEvidence.sha256!==evidence.sha256||copyEvidence.sizeBytes!==evidence.sizeBytes
 ||copyEvidence.sourceDevice!==source.device||copyEvidence.sourceInode!==source.inode
 ||copyEvidence.integrityCheck!=='ok'||copyEvidence.foreignKeyCheck!=='ok'
 ||!stoppedStat.isFile()||stoppedStat.isSymbolicLink()||stoppedStat.nlink!==1
 ||stoppedStat.size!==evidence.sizeBytes||digest(stoppedCopy)!==evidence.sha256
 ||stoppedStat.uid!==process.getuid()||(stoppedStat.mode&0o7777)!==0o600)process.exit(1);
fs.writeFileSync(output,`${JSON.stringify({databaseRecovery:{...journal.databaseRecovery,
 stoppedBoundary:{path:stoppedCopy,sha256:evidence.sha256,sizeBytes:evidence.sizeBytes,
  device:evidence.device,inode:evidence.inode,
  evidenceSha256:digest(evidenceFile),copyEvidenceSha256:digest(copyEvidenceFile),
  walCheckpoint:'truncate',integrityCheck:'ok',foreignKeyCheck:'ok'},
 }},null,2)}\n`,{mode:0o600,flag:'w'});
NODE
  update_active_phase production_database_stopped "$details"
  rm -f -- "$details"
}

ensure_recovered_database() {
  local output="$1" database recovery_point recovery_sha recovery_size owner_uid owner_gid
  local stopped_path stopped_sha stopped_size selected_path selected_sha selected_size
  local restored_from live_evidence live_status=0
  database="$OLD_PRODUCTION/data/bot.db"
  IFS=$'\t' read -r recovery_point recovery_sha recovery_size owner_uid owner_gid \
    stopped_path stopped_sha stopped_size < <(
    "$NODE_BIN" - "$ACTIVE_JOURNAL" <<'NODE'
const fs=require('fs');const x=JSON.parse(fs.readFileSync(process.argv[2])).databaseRecovery;
if(typeof x?.recoveryPointPath!=='string'||!/^[a-f0-9]{64}$/u.test(x.recoveryPointSha256||'')
 ||!Number.isSafeInteger(x.recoveryPointSizeBytes)||x.recoveryPointSizeBytes<=0
 ||!Number.isSafeInteger(x.source?.uid)||!Number.isSafeInteger(x.source?.gid)
 ||typeof x.source?.device!=='string'||typeof x.source?.inode!=='string'
 ||(x.stoppedBoundary!==undefined
   &&(typeof x.stoppedBoundary?.path!=='string'
     ||!/^[a-f0-9]{64}$/u.test(x.stoppedBoundary?.sha256||'')
     ||!Number.isSafeInteger(x.stoppedBoundary?.sizeBytes)
     ||x.stoppedBoundary.sizeBytes<=0)))process.exit(1);
process.stdout.write([x.recoveryPointPath,x.recoveryPointSha256,x.recoveryPointSizeBytes,
 x.source.uid,x.source.gid,x.stoppedBoundary?.path??'none',
 x.stoppedBoundary?.sha256??'none',
 x.stoppedBoundary?.sizeBytes??0].join('\t'));
NODE
  )
  # The layout transaction does not change schema. If the exact database inode
  # remains healthy after rollback, retain it so writes accepted after
  # customer availability returned are not erased by a later soak failure.
  # Only a failed integrity/identity check falls back to the pre-cutover
  # stopped boundary (or the earlier online point when that boundary was never
  # completed).
  assert_database_stopped "$OLD_PRODUCTION"
  live_evidence="$(mktemp "$STATE_ROOT/.layout-live-database-verification.XXXXXXXX")"
  set +e
  "$PYTHON_BIN" "$SQLITE_HELPER" stopped-boundary "$database" >"$live_evidence"
  live_status=$?
  set -e
  if [ "$live_status" -eq 0 ] && "$NODE_BIN" - "$ACTIVE_JOURNAL" \
      "$live_evidence" "$database" "$output" <<'NODE'
const fs=require('fs');
const [journalFile,evidenceFile,databaseFile,output]=process.argv.slice(2);
const recovery=JSON.parse(fs.readFileSync(journalFile)).databaseRecovery;
const evidence=JSON.parse(fs.readFileSync(evidenceFile));
const database=fs.lstatSync(databaseFile),source=recovery.source;
if(evidence.schema!=='nexus.release-layout-sqlite-stopped-boundary.v1'
 ||!database.isFile()||database.isSymbolicLink()||database.nlink!==1
 ||String(database.dev)!==source?.device||String(database.ino)!==source?.inode
 ||database.uid!==source?.uid||database.gid!==source?.gid
 ||evidence.device!==source.device||evidence.inode!==source.inode
 ||!/^[a-f0-9]{64}$/u.test(evidence.sha256||'')
 ||!Number.isSafeInteger(evidence.sizeBytes)||evidence.sizeBytes<=0
 ||evidence.sizeBytes>2*1024*1024*1024
 ||evidence.walCheckpoint!=='truncate'
 ||evidence.integrityCheck!=='ok'||evidence.foreignKeyCheck!=='ok')process.exit(1);
fs.writeFileSync(output,`${JSON.stringify({databaseRecovery:{
 recoveryPointSha256:recovery.recoveryPointSha256,
 recoveryPointSizeBytes:recovery.recoveryPointSizeBytes,
 stoppedBoundarySha256:recovery.stoppedBoundary?.sha256??null,
 stoppedBoundarySizeBytes:recovery.stoppedBoundary?.sizeBytes??null,
 stoppedBoundaryCopyEvidenceSha256:recovery.stoppedBoundary?.copyEvidenceSha256??null,
 restoredFromRecoveryPoint:false,restoredFromStoppedBoundary:false,
 retainedLiveDatabase:true,finalSha256:evidence.sha256,
 finalSizeBytes:evidence.sizeBytes,integrityCheck:'ok',foreignKeyCheck:'ok',
}},null,2)}\n`,{mode:0o600,flag:'w'});
NODE
  then
    rm -f -- "$live_evidence"
    return 0
  fi
  rm -f -- "$live_evidence"
  if [ "$stopped_path" != none ]; then
    selected_path="$stopped_path"
    selected_sha="$stopped_sha"
    selected_size="$stopped_size"
    restored_from=stopped_boundary
  else
    selected_path="$recovery_point"
    selected_sha="$recovery_sha"
    selected_size="$recovery_size"
    restored_from=online_recovery_point
  fi
  local verification
  verification="$(mktemp "$STATE_ROOT/.layout-database-recovery-verification.XXXXXXXX")"
  "$PYTHON_BIN" "$SQLITE_HELPER" restore "$selected_path" "$database" \
    --sha256 "$selected_sha" --size "$selected_size" \
    --uid "$owner_uid" --gid "$owner_gid" >"$verification"
  "$NODE_BIN" - "$ACTIVE_JOURNAL" "$verification" "$restored_from" "$output" <<'NODE'
const fs=require('fs');const [journalFile,evidenceFile,restoredFrom,output]=process.argv.slice(2);
const recovery=JSON.parse(fs.readFileSync(journalFile)).databaseRecovery;
const evidence=JSON.parse(fs.readFileSync(evidenceFile));
if(!/^[a-f0-9]{64}$/u.test(evidence.sha256||'')
 ||!Number.isSafeInteger(evidence.sizeBytes)||evidence.sizeBytes<=0
 ||evidence.integrityCheck!=='ok'||evidence.foreignKeyCheck!=='ok'
 ||!['stopped_boundary','online_recovery_point'].includes(restoredFrom))process.exit(1);
const stopped=restoredFrom==='stopped_boundary';
const expectedSha=stopped?recovery.stoppedBoundary?.sha256:recovery.recoveryPointSha256;
const expectedSize=stopped?recovery.stoppedBoundary?.sizeBytes:recovery.recoveryPointSizeBytes;
if(evidence.sha256!==expectedSha||evidence.sizeBytes!==expectedSize)process.exit(1);
fs.writeFileSync(output,`${JSON.stringify({databaseRecovery:{
 recoveryPointSha256:recovery.recoveryPointSha256,
 recoveryPointSizeBytes:recovery.recoveryPointSizeBytes,
 stoppedBoundarySha256:recovery.stoppedBoundary?.sha256??null,
 stoppedBoundarySizeBytes:recovery.stoppedBoundary?.sizeBytes??null,
 stoppedBoundaryCopyEvidenceSha256:recovery.stoppedBoundary?.copyEvidenceSha256??null,
 restoredFromRecoveryPoint:!stopped,restoredFromStoppedBoundary:stopped,
 retainedLiveDatabase:false,
 finalSha256:evidence.sha256,finalSizeBytes:evidence.sizeBytes,
 integrityCheck:'ok',foreignKeyCheck:'ok',
}},null,2)}\n`,{mode:0o600,flag:'w'});
NODE
  rm -f -- "$verification"
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
  "$NODE_BIN" - "$WORKER_HOME" "$OLD_PRODUCTION" "$OLD_STAGING" \
    "$WORKER_UID" "$WORKER_GID" "$details" <<'NODE'
const crypto=require('crypto');const fs=require('fs');const path=require('path');
const [home,production,staging,uidRaw,gidRaw,output]=process.argv.slice(2);
const workerUid=Number(uidRaw),workerGid=Number(gidRaw);
const homeStat=fs.lstatSync(home);
if(!homeStat.isDirectory()||homeStat.isSymbolicLink()
 ||fs.realpathSync.native(home)!==home||homeStat.uid!==workerUid
 ||homeStat.gid!==workerGid||(homeStat.mode&0o0022)!==0)process.exit(1);
const digest=(file)=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const directoryIdentity=(entry)=>{
 const stat=fs.lstatSync(entry);
 if(!stat.isDirectory()||stat.isSymbolicLink()
  ||fs.realpathSync.native(entry)!==entry)process.exit(1);
 return {dev:String(stat.dev),ino:String(stat.ino),uid:stat.uid,gid:stat.gid,
  mode:stat.mode&0o7777};
};
const mutableIdentity=(base)=>{
 const baseIdentity=directoryIdentity(base);
 if(baseIdentity.uid!==workerUid||baseIdentity.gid!==workerGid
  ||baseIdentity.mode!==0o755)process.exit(1);
 const environmentPath=path.join(base,'.env');
 const environment=fs.lstatSync(environmentPath);
 if(!environment.isFile()||environment.isSymbolicLink()||environment.nlink!==1
  ||environment.size<1||environment.size>256*1024
  ||![0,workerUid].includes(environment.uid)
  ||![0,workerGid].includes(environment.gid)
  ||![0o400,0o440,0o600,0o640].includes(environment.mode&0o7777))process.exit(1);
 return {base:baseIdentity,environment:{
   dev:String(environment.dev),ino:String(environment.ino),uid:environment.uid,
   gid:environment.gid,mode:environment.mode&0o7777,sizeBytes:environment.size,
   sha256:digest(environmentPath),
  },data:directoryIdentity(path.join(base,'data')),
  logs:directoryIdentity(path.join(base,'logs'))};
};
fs.writeFileSync(output,`${JSON.stringify({
 homeIdentity:{uid:homeStat.uid,gid:homeStat.gid,mode:homeStat.mode&0o7777,
  dev:String(homeStat.dev),ino:String(homeStat.ino)},
 legacyMutable:{production:mutableIdentity(production),staging:mutableIdentity(staging)},
},null,2)}\n`,{mode:0o600,flag:'w'});
NODE
}

assert_worker_home_identity() {
  local details="$1"
  "$NODE_BIN" - "$WORKER_HOME" "$details" <<'NODE'
const fs=require('fs');const [home,details]=process.argv.slice(2);
const identity=JSON.parse(fs.readFileSync(details,'utf8')).homeIdentity;
const stat=fs.lstatSync(home);
if(!stat.isDirectory()||stat.isSymbolicLink()
 ||String(stat.dev)!==identity.dev||String(stat.ino)!==identity.ino
 ||stat.uid!==identity.uid||stat.gid!==identity.gid
 ||(stat.mode&0o7777)!==identity.mode)process.exit(1);
NODE
}

verify_frozen_legacy_runtime() {
  local base="$1" runtime="$2" sha="$3" artifact="$4" installed="$5"
  local legacy_base="$6"
  [ "$runtime" != "$base/releases" ] && [[ "$runtime" == "$base"/releases/* ]] \
    || die "frozen legacy runtime is outside its exact release base"
  if [ "$TEST_MODE" = 1 ]; then
    NODE_ENV=test NEXUS_LAYOUT_TEST_LEGACY_BASE="$legacy_base" \
      NEXUS_LAYOUT_TEST_PROTECTED_PREDECESSOR="$base" \
      "$NODE_BIN" "$ATTESTOR" legacy-frozen-intake \
      --root "$runtime" --base "$base" --runtime-sha "$sha" \
      --artifact-digest "$artifact" --installed-runtime-digest "$installed" \
      --group-id "$WORKER_GID" --owner-id "$WORKER_UID" \
      --legacy-link-base "$legacy_base" >/dev/null
  else
    "$NODE_BIN" "$ATTESTOR" legacy-frozen-intake \
      --root "$runtime" --base "$base" --runtime-sha "$sha" \
      --artifact-digest "$artifact" --installed-runtime-digest "$installed" \
      --group-id "$WORKER_GID" --owner-id "$WORKER_UID" \
      --legacy-link-base "$legacy_base" >/dev/null
  fi
}

runtime_tree_digest() {
  "$NODE_BIN" - "$1" <<'NODE'
const crypto=require('crypto');const fs=require('fs');const path=require('path');
const root=process.argv[2],entries=[];
const sha=(value)=>crypto.createHash('sha256').update(value).digest('hex');
const walk=(directory)=>{
 for(const name of fs.readdirSync(directory).sort()){
  const absolute=path.join(directory,name),relative=path.relative(root,absolute).split(path.sep).join('/');
  const stat=fs.lstatSync(absolute);
  const common={path:relative,dev:String(stat.dev),ino:String(stat.ino),
   uid:stat.uid,gid:stat.gid,mode:stat.mode&0o7777};
  if(stat.isDirectory()){entries.push({...common,type:'directory'});walk(absolute);}
  else if(stat.isFile()){
   if(stat.nlink!==1)process.exit(1);
   entries.push({...common,type:'file',sizeBytes:stat.size,sha256:sha(fs.readFileSync(absolute))});
  }else if(stat.isSymbolicLink())entries.push({...common,type:'symlink',target:fs.readlinkSync(absolute)});
  else process.exit(1);
 }
};
walk(root);
process.stdout.write(sha(Buffer.from(JSON.stringify({
 schema:'nexus.release-layout-runtime-tree-identity.v1',entries,
}))));
NODE
}

record_frozen_runtime() {
  local role="$1" runtime="$2" digest details
  digest="$(runtime_tree_digest "$runtime")"
  details="$(mktemp "$STATE_ROOT/.layout-frozen-runtime.XXXXXXXX")"
  "$NODE_BIN" - "$ACTIVE_JOURNAL" "$details" "$role" "$digest" <<'NODE'
const fs=require('fs');const [journalFile,output,role,digest]=process.argv.slice(2);
const journal=JSON.parse(fs.readFileSync(journalFile));
if(!['production','staging'].includes(role)||!/^[a-f0-9]{64}$/u.test(digest))process.exit(1);
fs.writeFileSync(output,`${JSON.stringify({frozenSource:{
 ...(journal.frozenSource??{}),[role]:{runtimeTreeSha256:digest},
}},null,2)}\n`,{mode:0o600,flag:'w'});
NODE
  update_active_phase "${role}_source_frozen" "$details"
  rm -f -- "$details"
}

assert_moved_predecessor() {
  local role="$1" runtime="$2" expected observed
  expected="$("$NODE_BIN" - "$ACTIVE_JOURNAL" "$role" <<'NODE'
const fs=require('fs');const [file,role]=process.argv.slice(2);
const value=JSON.parse(fs.readFileSync(file)).frozenSource?.[role]?.runtimeTreeSha256;
if(!/^[a-f0-9]{64}$/u.test(value??''))process.exit(1);process.stdout.write(value);
NODE
)"
  observed="$(runtime_tree_digest "$runtime")"
  [ "$observed" = "$expected" ] \
    || die "$role predecessor runtime changed across the atomic rename"
}

assert_no_process_references() {
  local base="$1" proc_root="${NEXUS_LAYOUT_PROC_ROOT:-/proc}"
  if [ "$TEST_MODE" = 1 ] && [ ! -d "$proc_root" ]; then return 0; fi
  "$PYTHON_BIN" - "$base" "$proc_root" <<'PY'
import os
import pathlib
import re
import sys

base_value, proc_value = sys.argv[1:]
base = pathlib.Path(base_value)
proc = pathlib.Path(proc_value)
if (
    not base.is_absolute()
    or base == pathlib.Path("/")
    or base.is_symlink()
    or not base.is_dir()
    or not proc.is_dir()
    or proc.is_symlink()
):
    raise SystemExit("process-reference scan roots are unsafe")
base_prefix = f"{base}{os.sep}"
self_pid = os.getpid()
references = []

def under_base(value: str) -> bool:
    value = value.removesuffix(" (deleted)")
    return value == str(base) or value.startswith(base_prefix)

for process in proc.iterdir():
    if not re.fullmatch(r"[0-9]+", process.name) or int(process.name) == self_pid:
        continue
    try:
        for name in ("cwd", "root", "exe"):
            candidate = process / name
            try:
                target = os.readlink(candidate)
            except FileNotFoundError:
                continue
            except PermissionError as error:
                raise SystemExit(f"process-reference scan denied for pid {process.name}") from error
            if under_base(target):
                references.append((process.name, name))
        fd_root = process / "fd"
        try:
            descriptors = list(fd_root.iterdir())
        except FileNotFoundError:
            descriptors = []
        except PermissionError as error:
            raise SystemExit(f"process-reference FD scan denied for pid {process.name}") from error
        for descriptor in descriptors:
            try:
                target = os.readlink(descriptor)
            except FileNotFoundError:
                continue
            except PermissionError as error:
                raise SystemExit(f"process-reference FD read denied for pid {process.name}") from error
            if under_base(target):
                references.append((process.name, f"fd:{descriptor.name}"))
        maps = process / "maps"
        try:
            rows = maps.read_text(errors="strict").splitlines()
        except FileNotFoundError:
            rows = []
        except (PermissionError, UnicodeError) as error:
            raise SystemExit(f"process-reference map scan failed for pid {process.name}") from error
        for row in rows:
            fields = row.split(maxsplit=5)
            if len(fields) == 6 and fields[5].startswith("/") and under_base(
                fields[5].replace("\\040", " ")
            ):
                references.append((process.name, "mmap"))
                break
    except ProcessLookupError:
        continue
if references:
    raise SystemExit(
        "legacy base still has retained process references: "
        + ",".join(f"{pid}:{kind}" for pid, kind in references[:16])
    )
PY
}

freeze_legacy_role() {
  local role="$1" base="$2" runtime="$3" sha="$4" artifact="$5" installed="$6"
  local details="$7" migration_id predecessor predecessor_runtime
  migration_id="$(extract_authority_field request.migrationId)"
  predecessor="$PREDECESSOR_ROOT/$migration_id/$role"
  predecessor_runtime="$predecessor/releases/$(basename -- "$runtime")"
  [ ! -e "$predecessor" ] && [ ! -L "$predecessor" ] \
    || die "$role predecessor path is already occupied"
  verify_legacy_runtime "$base" "$runtime" "$sha" "$artifact" "$installed"
  assert_no_process_references "$base"
  "$NODE_BIN" - "$base" "$predecessor" "$WORKER_HOME" "$details" "$role" \
    "$WORKER_UID" "$WORKER_GID" "$TEST_MODE" <<'NODE'
const crypto=require('crypto');const fs=require('fs');const path=require('path');
const [base,predecessor,home,detailsFile,role,workerUidRaw,workerGidRaw,
 testMode]=process.argv.slice(2);
const state=JSON.parse(fs.readFileSync(detailsFile));
const expected=state.legacyMutable?.[role],homeExpected=state.homeIdentity;
const authorityUid=testMode==='1'?process.getuid():0;
const authorityGid=testMode==='1'?process.getgid():0;
if(!expected||!homeExpected)process.exit(1);
const homeFd=fs.openSync(home,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|(fs.constants.O_NOFOLLOW??0));
const baseFd=fs.openSync(base,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|(fs.constants.O_NOFOLLOW??0));
const predecessorParentFd=fs.openSync(path.dirname(predecessor),
 fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|(fs.constants.O_NOFOLLOW??0));
try{
 const homeBefore=fs.fstatSync(homeFd),baseBefore=fs.fstatSync(baseFd);
 if(String(homeBefore.dev)!==homeExpected.dev||String(homeBefore.ino)!==homeExpected.ino
  ||homeBefore.uid!==homeExpected.uid||homeBefore.gid!==homeExpected.gid
  ||(homeBefore.mode&0o7777)!==homeExpected.mode
  ||String(baseBefore.dev)!==expected.base.dev||String(baseBefore.ino)!==expected.base.ino
  ||baseBefore.uid!==Number(workerUidRaw)||baseBefore.gid!==Number(workerGidRaw)
  ||(baseBefore.mode&0o7777)!==expected.base.mode)process.exit(1);
 fs.renameSync(base,predecessor);
 fs.fsyncSync(homeFd);fs.fsyncSync(predecessorParentFd);
 const moved=fs.lstatSync(predecessor);
 if(String(moved.dev)!==expected.base.dev||String(moved.ino)!==expected.base.ino
  ||fs.lstatSync(base,{throwIfNoEntry:false}))process.exit(1);
 fs.fchownSync(baseFd,authorityUid,authorityGid);fs.fchmodSync(baseFd,0o700);
 fs.fsyncSync(baseFd);fs.fsyncSync(predecessorParentFd);
 const baseAfter=fs.lstatSync(predecessor),homeAfter=fs.lstatSync(home);
 if(String(baseAfter.dev)!==expected.base.dev||String(baseAfter.ino)!==expected.base.ino
  ||baseAfter.uid!==authorityUid||baseAfter.gid!==authorityGid
  ||(baseAfter.mode&0o7777)!==0o700
  ||String(homeAfter.dev)!==homeExpected.dev||String(homeAfter.ino)!==homeExpected.ino
  ||homeAfter.uid!==homeExpected.uid||homeAfter.gid!==homeExpected.gid
  ||(homeAfter.mode&0o7777)!==homeExpected.mode)process.exit(1);
}finally{fs.closeSync(predecessorParentFd);fs.closeSync(baseFd);fs.closeSync(homeFd);}
const digest=(file)=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const environment=fs.lstatSync(path.join(predecessor,'.env'));
if(String(environment.dev)!==expected.environment.dev
 ||String(environment.ino)!==expected.environment.ino
 ||environment.uid!==expected.environment.uid||environment.gid!==expected.environment.gid
 ||(environment.mode&0o7777)!==expected.environment.mode
 ||environment.size!==expected.environment.sizeBytes
 ||digest(path.join(predecessor,'.env'))!==expected.environment.sha256)process.exit(1);
for(const name of ['data','logs']){
 const observed=fs.lstatSync(path.join(predecessor,name)),identity=expected[name];
 if(!observed.isDirectory()||observed.isSymbolicLink()
  ||String(observed.dev)!==identity.dev||String(observed.ino)!==identity.ino
  ||observed.uid!==identity.uid||observed.gid!==identity.gid
  ||(observed.mode&0o7777)!==identity.mode)process.exit(1);
}
NODE
  fsync_path "$WORKER_HOME"; fsync_path "$(dirname -- "$predecessor")"
  assert_worker_home_identity "$details"
  assert_no_process_references "$predecessor"
  verify_frozen_legacy_runtime "$predecessor" "$predecessor_runtime" \
    "$sha" "$artifact" "$installed" "$base"
  record_frozen_runtime "$role" "$predecessor_runtime"
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

layout_selector_initialize() {
  local role="$1" target="$2"
  local legacy args
  if [ "$role" = production ]; then legacy="$OLD_PRODUCTION"
  else legacy="$OLD_STAGING"; fi
  args=(
    initialize --role "$role" --release-root "$RELEASE_ROOT"
    --worker-uid "$WORKER_UID" --worker-gid "$WORKER_GID"
    --target "$target"
    --layout-transition --layout-base authoritative
    --legacy-base "$legacy"
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
  if [ "$TEST_MODE" = 1 ]; then
    ln -s -- "$new" "$old"
  else
    install -d -o root -g root -m 755 -- "$old"
    "$MOUNT_BIN" --bind "$new" "$old"
    local target source_identity target_identity
    target="$("$FINDMNT_BIN" --mountpoint "$old" --noheadings --output TARGET)"
    [ "$target" = "$old" ] || die "compatibility bind mount is not authoritative"
    source_identity="$(stat -c '%d:%i' -- "$new")"
    target_identity="$(stat -c '%d:%i' -- "$old")"
    [ "$source_identity" = "$target_identity" ] \
      || die "compatibility bind mount does not expose the authoritative base"
  fi
  fsync_path "$(dirname -- "$old")"
}

remove_compatibility_mount() {
  local old="$1" new="$2"
  if [ "$TEST_MODE" = 1 ]; then
    if [ -L "$old" ]; then rm -f -- "$old"; fi
  elif [ -d "$old" ] && [ ! -L "$old" ]; then
    if "$FINDMNT_BIN" --mountpoint "$old" --noheadings --output TARGET >/dev/null 2>&1; then
      [ "$(stat -c '%d:%i' -- "$old")" = "$(stat -c '%d:%i' -- "$new")" ] \
        || die "compatibility mount identity changed before recovery"
      "$UMOUNT_BIN" -- "$old"
    fi
    rmdir -- "$old"
  elif [ -e "$old" ] || [ -L "$old" ]; then
    die "compatibility recovery path is unsafe"
  fi
  fsync_path "$WORKER_HOME"
}

reconcile_published_compatibility_mounts() {
  publication_is_complete || die "layout publication is incomplete"
  "$NODE_BIN" - "$ATTESTATION" "$WORKER_HOME" "$OLD_PRODUCTION" \
    "$OLD_STAGING" "$PRODUCTION" "$STAGING" "$WORKER_UID" "$WORKER_GID" \
    "$TEST_MODE" <<'NODE'
const fs=require('fs');
const [file,home,oldProduction,oldStaging,production,staging,
 workerUidRaw,workerGidRaw,testMode]=process.argv.slice(2);
const value=JSON.parse(fs.readFileSync(file)),stat=fs.lstatSync(home);
if(value.schema!=='nexus.release-layout-migration.v1'
 ||value.status!=='passed'||!stat.isDirectory()||stat.isSymbolicLink()
 ||stat.uid!==Number(workerUidRaw)||stat.gid!==Number(workerGidRaw)
 ||(stat.mode&0o0022)!==0
 ||value.compatibility?.home?.dev!==String(stat.dev)
 ||value.compatibility?.home?.ino!==String(stat.ino)
 ||value.compatibility?.home?.uid!==stat.uid
 ||value.compatibility?.home?.gid!==stat.gid
 ||value.compatibility?.home?.mode!==(stat.mode&0o7777))process.exit(1);
for(const [role,mountPath,target] of [
 ['production',oldProduction,production],['staging',oldStaging,staging],
]){
 const record=value.compatibility?.[role];
 const expectedKind=testMode==='1'?'test-symlink-equivalent':'bind-mount';
 if(record?.kind!==expectedKind||record.path!==mountPath||record.target!==target)
  process.exit(1);
}
NODE
  local old target observed
  while IFS=$'\t' read -r old target; do
    if [ "$TEST_MODE" = 1 ]; then
      if [ -L "$old" ]; then
        [ "$(readlink -- "$old")" = "$target" ] \
          && [ "$(realpath -e -- "$old")" = "$target" ] \
          || die "test compatibility equivalent changed"
      elif [ ! -e "$old" ]; then
        ln -s -- "$target" "$old"
      else
        die "test compatibility equivalent is occupied"
      fi
      continue
    fi
    if "$FINDMNT_BIN" --mountpoint "$old" --noheadings --output TARGET \
        >/dev/null 2>&1; then
      [ "$(stat -c '%d:%i' -- "$old")" = "$(stat -c '%d:%i' -- "$target")" ] \
        || die "published compatibility mount points at the wrong inode"
      continue
    fi
    if [ -e "$old" ] || [ -L "$old" ]; then
      [ -d "$old" ] && [ ! -L "$old" ] \
        && [ -z "$(find "$old" -mindepth 1 -maxdepth 1 -print -quit)" ] \
        && [ "$(stat -c '%U:%G:%a' -- "$old")" = root:root:755 ] \
        || die "published compatibility mountpoint is unsafe"
    else
      install -d -o root -g root -m 755 -- "$old"
    fi
    "$MOUNT_BIN" --bind "$target" "$old"
    observed="$("$FINDMNT_BIN" --mountpoint "$old" --noheadings --output TARGET)"
    [ "$observed" = "$old" ] \
      && [ "$(stat -c '%d:%i' -- "$old")" = "$(stat -c '%d:%i' -- "$target")" ] \
      || die "published compatibility bind mount reconciliation failed"
  done <<EOF
$OLD_PRODUCTION	$PRODUCTION
$OLD_STAGING	$STAGING
EOF
  fsync_path "$WORKER_HOME"
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
    if publication_is_complete; then
      reconcile_published_compatibility_mounts
      printf '{"ok":true,"schema":"%s","status":"reconciled"}\n' "$VERSION"
    else
      printf '{"ok":true,"schema":"%s","status":"idle"}\n' "$VERSION"
    fi
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
      # Bind mounts are not persistent across reboot. Reconstruct and attest
      # them before clearing the last retry authority; otherwise this unit
      # could report success while the PM2 boot guard correctly remains
      # blocked on missing compatibility paths.
      reconcile_published_compatibility_mounts
      rm -f -- "$ACTIVE_JOURNAL"
      fsync_path "$STATE_ROOT"
      printf '{"ok":true,"schema":"%s","status":"completed"}\n' "$VERSION"
      return 0
    fi
  fi
  remove_partial_publication
  local recovery_started outage_started recovery_deadline home_details
  local production_sha production_artifact production_installed
  local staging_sha staging_artifact staging_installed production_runtime staging_runtime
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
  assert_worker_home_identity "$home_details"
  local production_touched
  production_touched="$("$NODE_BIN" - "$ACTIVE_JOURNAL" <<'NODE'
const fs=require('fs');const x=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
process.stdout.write(Number.isSafeInteger(x.productionOutageStartedEpoch)?'true':'false');
NODE
)"
  if [ "$production_touched" = true ]; then stop_all_apps
  else stop_role_apps staging
  fi
  IFS=$'\t' read -r production_sha production_artifact production_installed \
    staging_sha staging_artifact staging_installed < <(
    "$NODE_BIN" - "$ACTIVE_JOURNAL" <<'NODE'
const fs=require('fs');const x=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const p=x.source?.production,s=x.source?.staging;
if(!/^[a-f0-9]{40}$/u.test(p?.runtimeSha||'')
 ||!/^[a-f0-9]{64}$/u.test(p?.artifactDigest||'')
 ||!/^[a-f0-9]{64}$/u.test(p?.installedRuntimeDigest||'')
 ||!/^[a-f0-9]{40}$/u.test(s?.runtimeSha||'')
 ||!/^[a-f0-9]{64}$/u.test(s?.artifactDigest||'')
 ||!/^[a-f0-9]{64}$/u.test(s?.installedRuntimeDigest||''))process.exit(1);
process.stdout.write([
 p.runtimeSha,p.artifactDigest,p.installedRuntimeDigest,
 s.runtimeSha,s.artifactDigest,s.installedRuntimeDigest,
].join('\t'));
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
  rollback_role_layout production "$OLD_PRODUCTION" "$PRODUCTION"
  rollback_role_layout staging "$OLD_STAGING" "$STAGING"
  pin_recovered_legacy_base production "$OLD_PRODUCTION"
  pin_recovered_legacy_base staging "$OLD_STAGING"
  local database_recovery_details
  database_recovery_details="$(mktemp "$STATE_ROOT/.layout-recovered-database.XXXXXXXX")"
  if [ "$production_touched" = true ]; then
    ensure_recovered_database "$database_recovery_details"
  else
    printf '{"databaseRecovery":null}\n' >"$database_recovery_details"
  fi
  assert_worker_home_identity "$home_details"
  local migration_id predecessor_transaction_root
  migration_id="$("$NODE_BIN" - "$ACTIVE_JOURNAL" <<'NODE'
const fs=require('fs');const x=JSON.parse(fs.readFileSync(process.argv[2]));
process.stdout.write(x.migrationId);
NODE
)"
  predecessor_transaction_root="$PREDECESSOR_ROOT/$migration_id"
  if [ -d "$predecessor_transaction_root" ] && [ ! -L "$predecessor_transaction_root" ]; then
    rmdir "$predecessor_transaction_root"
    fsync_path "$PREDECESSOR_ROOT"
  fi
  production_runtime="$OLD_PRODUCTION/releases/$(basename -- "$production_runtime")"
  staging_runtime="$OLD_STAGING/releases/$(basename -- "$staging_runtime")"
  assert_no_process_references "$OLD_PRODUCTION"
  assert_no_process_references "$OLD_STAGING"
  verify_frozen_legacy_runtime "$OLD_PRODUCTION" "$production_runtime" \
    "$production_sha" "$production_artifact" "$production_installed" "$OLD_PRODUCTION"
  verify_frozen_legacy_runtime "$OLD_STAGING" "$staging_runtime" \
    "$staging_sha" "$staging_artifact" "$staging_installed" "$OLD_STAGING"
  restore_legacy_base_metadata production "$OLD_PRODUCTION"
  restore_legacy_base_metadata staging "$OLD_STAGING"
  assert_worker_home_identity "$home_details"
  verify_legacy_runtime "$OLD_PRODUCTION" "$production_runtime" \
    "$production_sha" "$production_artifact" "$production_installed"
  verify_legacy_runtime "$OLD_STAGING" "$staging_runtime" \
    "$staging_sha" "$staging_artifact" "$staging_installed"
  rm -f -- "$home_details"
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
  local outage_epoch_ms outage_monotonic_ms outage_boot_id
  local recovery_epoch_ms recovery_monotonic_ms recovery_boot_id recovery_timing
  if [ "$production_touched" = true ]; then
    IFS=$'\t' read -r outage_epoch_ms outage_monotonic_ms outage_boot_id < <(
      "$NODE_BIN" - "$ACTIVE_JOURNAL" <<'NODE'
const fs=require('fs');const x=JSON.parse(fs.readFileSync(process.argv[2]));
const epochMs=Number.isSafeInteger(x.productionOutageStartedEpochMs)
 ?x.productionOutageStartedEpochMs:x.productionOutageStartedEpoch*1000;
const monotonicMs=Number.isSafeInteger(x.productionOutageStartedMonotonicMs)
 ?x.productionOutageStartedMonotonicMs:(x.productionOutageStartedMonotonic??0)*1000;
if(!Number.isSafeInteger(epochMs)||!Number.isSafeInteger(monotonicMs)
 ||typeof x.productionOutageBootId!=='string')process.exit(1);
process.stdout.write(`${epochMs}\t${monotonicMs}\t${x.productionOutageBootId}`);
NODE
    )
  else
    IFS=$'\t' read -r outage_epoch_ms outage_monotonic_ms outage_boot_id < <(timing_sample)
  fi
  IFS=$'\t' read -r recovery_epoch_ms recovery_monotonic_ms recovery_boot_id < <(timing_sample)
  recovery_timing="$(mktemp "$STATE_ROOT/.layout-recovery-timing.XXXXXXXX")"
  timing_evidence "$outage_epoch_ms" "$outage_monotonic_ms" "$outage_boot_id" \
    "$recovery_epoch_ms" "$recovery_monotonic_ms" "$recovery_boot_id" "$recovery_timing"
  read -r recovery_seconds recovery_target_met < <(
    "$NODE_BIN" - "$recovery_timing" <<'NODE'
const fs=require('fs');const x=JSON.parse(fs.readFileSync(process.argv[2]));
process.stdout.write(`${Math.ceil(x.durationMilliseconds/1000)} ${x.targetMet?'true':'false'}\n`);
NODE
  )
  recovery_details="$(mktemp "$STATE_ROOT/.layout-recovered-details.XXXXXXXX")"
  "$NODE_BIN" - "$recovery_details" "$ACTIVE_JOURNAL" "$production_readiness" \
    "$staging_readiness" "$recovery_seconds" "$pm2_dump_sha256" \
    "$recovery_target_met" "$recovery_timing" "$database_recovery_details" <<'NODE'
const crypto=require('crypto');const fs=require('fs');
const [output,journal,production,staging,seconds,pm2DumpSha256,targetMetRaw,
 timingFile,databaseFile]=process.argv.slice(2);
const digest=(file)=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const timing=JSON.parse(fs.readFileSync(timingFile));
const databaseRecovery=JSON.parse(fs.readFileSync(databaseFile)).databaseRecovery;
if(!/^[a-f0-9]{64}$/u.test(pm2DumpSha256||'')
 ||!['true','false'].includes(targetMetRaw)
 ||timing.schema!=='nexus.release-layout-unavailability.v1'
 ||timing.targetMet!==(targetMetRaw==='true'))process.exit(1);
fs.writeFileSync(output,`${JSON.stringify({
 originalJournalSha256:digest(journal),
 readinessSha256:{production:digest(production),staging:digest(staging)},
 pm2DumpSha256,
 recoverySeconds:Number(seconds),recoveryTargetSeconds:120,
 targetMet:targetMetRaw==='true',unavailability:timing,databaseRecovery,
 recoveredAt:new Date().toISOString(),
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
    "$recovery_timing" "$database_recovery_details" \
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
  verify_legacy_runtime "$OLD_PRODUCTION" "$old_production_runtime" \
    "$production_sha" "$production_artifact" "$production_installed"
  verify_legacy_runtime "$OLD_STAGING" "$old_staging_runtime" \
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
const legacyState=JSON.parse(fs.readFileSync(home,'utf8'));
fs.writeFileSync(output,`${JSON.stringify({
 migrationId:authority.request.migrationId,
 requestEnvelopeSha256:authority.requestEnvelopeSha256,
 faultDrillEnvelopeSha256:authority.faultDrillEnvelopeSha256,
 pm2AttestationSha256:pm2Sha,...legacyState,
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
  local migration_id predecessor_transaction_root
  migration_id="$(extract_authority_field request.migrationId)"
  predecessor_transaction_root="$PREDECESSOR_ROOT/$migration_id"
  if [ "$TEST_MODE" = 1 ]; then
    install -d -m 700 "$PREDECESSOR_ROOT" "$predecessor_transaction_root"
  else
    install -d -o root -g root -m 700 "$PREDECESSOR_ROOT" "$predecessor_transaction_root"
  fi
  fsync_path "$PREDECESSOR_ROOT"; fsync_path "$RELEASE_ROOT"
  prepare_database_recovery_point
  local new_production_runtime new_staging_runtime destination_details
  new_staging_runtime="$(prepare_destination_runtime staging \
    "$OLD_STAGING" "$STAGING" "$old_staging_runtime" \
    "$staging_sha" "$staging_artifact" "$staging_installed")"
  new_production_runtime="$(prepare_destination_runtime production \
    "$OLD_PRODUCTION" "$PRODUCTION" "$old_production_runtime" \
    "$production_sha" "$production_artifact" "$production_installed")"
  destination_details="$(mktemp "$STATE_ROOT/.layout-destination-details.XXXXXXXX")"
  "$NODE_BIN" - "$destination_details" "$new_production_runtime" \
    "$new_staging_runtime" "$predecessor_transaction_root" <<'NODE'
const fs=require('fs');const [output,production,staging,predecessorRoot]=process.argv.slice(2);
fs.writeFileSync(output,`${JSON.stringify({
 rematerializedRuntime:{production,staging},predecessorRoot,
},null,2)}\n`,{mode:0o600,flag:'w'});
NODE
  update_active_phase destinations_rematerialized "$destination_details"
  rm -f -- "$destination_details"

  # Preserve the SSH and PM2 traversal contract of the worker home. Each
  # stopped legacy application root is instead atomically renamed into the
  # root-only predecessor transaction before it is frozen.
  assert_worker_home_identity "$home_details"
  verify_legacy_runtime "$OLD_PRODUCTION" "$old_production_runtime" \
    "$production_sha" "$production_artifact" "$production_installed"
  verify_legacy_runtime "$OLD_STAGING" "$old_staging_runtime" \
    "$staging_sha" "$staging_artifact" "$staging_installed"
  verify_pm2_identity "$old_production_runtime" "$production_sha" \
    "$old_staging_runtime" "$staging_sha"
  update_active_phase home_identity_rechecked
  stop_role_apps staging
  update_active_phase staging_apps_stopped
  freeze_legacy_role staging "$OLD_STAGING" "$old_staging_runtime" \
    "$staging_sha" "$staging_artifact" "$staging_installed" "$home_details"
  update_active_phase staging_source_frozen
  move_role_to_authoritative staging "$OLD_STAGING" "$STAGING" \
    "$old_staging_runtime" "$new_staging_runtime"
  update_active_phase staging_compatibility_installed
  assert_worker_home_identity "$home_details"
  update_active_phase staging_predecessor_protected
  verify_runtime "$STAGING" "$new_staging_runtime" \
    "$staging_sha" "$staging_artifact" "$staging_installed"

  local production_readiness staging_readiness
  production_readiness="$(mktemp "$STATE_ROOT/.layout-production-readiness.XXXXXXXX")"
  staging_readiness="$(mktemp "$STATE_ROOT/.layout-staging-readiness.XXXXXXXX")"
  run_worker "$BASH_BIN" "$LAYOUT_PREFLIGHT" \
    --role staging --base-dir "$STAGING" --release-dir "$new_staging_runtime" \
    --node-bin "$NODE_BIN" \
    --environment-contract authoritative-root-group-readonly >&2
  start_role staging "$STAGING" "$new_staging_runtime" "$staging_sha"
  update_active_phase staging_started
  readiness_role staging "$STAGING" "$new_staging_runtime" \
    "$staging_sha" 60 "$staging_readiness"
  update_active_phase staging_ready
  verify_pm2_identity "$old_production_runtime" "$production_sha" \
    "$new_staging_runtime" "$staging_sha"

  # Reverify the unchanged worker home and still-live production predecessor
  # immediately before its protected atomic rename.
  assert_worker_home_identity "$home_details"
  verify_legacy_runtime "$OLD_PRODUCTION" "$old_production_runtime" \
    "$production_sha" "$production_artifact" "$production_installed"
  verify_pm2_identity "$old_production_runtime" "$production_sha" \
    "$new_staging_runtime" "$staging_sha"
  local outage_details outage_started_ms outage_monotonic_ms outage_boot_id outage_started
  IFS=$'\t' read -r outage_started_ms outage_monotonic_ms outage_boot_id < <(timing_sample)
  outage_started="$(( outage_started_ms / 1000 ))"
  outage_details="$(mktemp "$STATE_ROOT/.layout-outage-details.XXXXXXXX")"
  "$NODE_BIN" - "$outage_details" "$outage_started_ms" "$outage_monotonic_ms" \
    "$outage_boot_id" <<'NODE'
const fs=require('fs');
const [output,startedMsRaw,monotonicRaw,bootId]=process.argv.slice(2);
const startedMs=Number(startedMsRaw),monotonic=Number(monotonicRaw);
fs.writeFileSync(output,`${JSON.stringify({
 productionOutageStartedEpoch:Math.floor(startedMs/1000),
 recoveryDeadlineEpoch:Math.floor(startedMs/1000)+120,
 productionOutageStartedAt:new Date(startedMs).toISOString(),
 productionOutageStartedEpochMs:startedMs,
 productionOutageStartedMonotonicMs:monotonic,productionOutageBootId:bootId,
},null,2)}\n`,{mode:0o600,flag:'w'});
NODE
  update_active_phase production_outage_armed "$outage_details"
  rm -f -- "$outage_details"
  RECOVERY_DEADLINE_EPOCH="$(( outage_started + 120 ))"
  stop_role_apps production
  update_active_phase production_apps_stopped
  freeze_legacy_role production "$OLD_PRODUCTION" "$old_production_runtime" \
    "$production_sha" "$production_artifact" "$production_installed" "$home_details"
  update_active_phase production_source_frozen
  capture_database_boundary "$PREDECESSOR_ROOT/$migration_id/production"
  move_role_to_authoritative production "$OLD_PRODUCTION" "$PRODUCTION" \
    "$old_production_runtime" "$new_production_runtime"
  update_active_phase production_compatibility_installed
  assert_worker_home_identity "$home_details"
  rm -f -- "$home_details"
  update_active_phase compatibility_mounts_installed
  verify_runtime "$PRODUCTION" "$new_production_runtime" \
    "$production_sha" "$production_artifact" "$production_installed"
  local production_preflight_timeout
  production_preflight_timeout="$(bounded_seconds 30)"
  run_worker "$TIMEOUT_BIN" --signal=TERM --kill-after=5s "${production_preflight_timeout}s" \
    "$BASH_BIN" "$LAYOUT_PREFLIGHT" \
    --role production --base-dir "$PRODUCTION" --release-dir "$new_production_runtime" \
    --node-bin "$NODE_BIN" \
    --environment-contract authoritative-root-group-readonly >&2
  start_role production "$PRODUCTION" "$new_production_runtime" "$production_sha"
  update_active_phase production_started
  local availability_readiness availability_details availability_epoch
  local availability_epoch_ms availability_monotonic_ms availability_boot_id timing_file
  availability_readiness="$(mktemp "$STATE_ROOT/.layout-production-availability.XXXXXXXX")"
  readiness_role production "$PRODUCTION" "$new_production_runtime" \
    "$production_sha" 0 "$availability_readiness" 8
  IFS=$'\t' read -r availability_epoch_ms availability_monotonic_ms \
    availability_boot_id < <(timing_sample)
  availability_epoch="$(( availability_epoch_ms / 1000 ))"
  timing_file="$(mktemp "$STATE_ROOT/.layout-unavailability.XXXXXXXX")"
  timing_evidence "$outage_started_ms" "$outage_monotonic_ms" "$outage_boot_id" \
    "$availability_epoch_ms" "$availability_monotonic_ms" "$availability_boot_id" \
    "$timing_file"
  "$NODE_BIN" - "$timing_file" <<'NODE' \
    || die "production availability was not restored within 120 seconds"
const fs=require('fs');const x=JSON.parse(fs.readFileSync(process.argv[2]));
if(x.schema!=='nexus.release-layout-unavailability.v1'||x.targetMet!==true
 ||x.timingBasis!=='same_boot_monotonic'||x.durationMilliseconds>120000)process.exit(1);
NODE
  availability_details="$(mktemp "$STATE_ROOT/.layout-availability-details.XXXXXXXX")"
  "$NODE_BIN" - "$availability_details" "$availability_epoch_ms" \
    "$availability_readiness" "$timing_file" <<'NODE'
const crypto=require('crypto');const fs=require('fs');
const [output,availableRaw,evidence,timingFile]=process.argv.slice(2);
const available=Number(availableRaw),timing=JSON.parse(fs.readFileSync(timingFile));
fs.writeFileSync(output,`${JSON.stringify({
 productionAvailabilityRestoredEpoch:Math.floor(available/1000),
 productionAvailabilityRestoredEpochMs:available,
 productionAvailabilityRestoredAt:new Date(available).toISOString(),
 productionUnavailabilitySeconds:timing.durationMilliseconds/1000,
 unavailability:timing,
 productionAvailabilityReadinessSha256:crypto.createHash('sha256')
  .update(fs.readFileSync(evidence)).digest('hex'),
},null,2)}\n`,{mode:0o600,flag:'w'});
NODE
  update_active_phase production_available "$availability_details"
  rm -f -- "$availability_details" "$availability_readiness" "$timing_file"
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
  if [ "$TEST_MODE" != 1 ]; then
    local compatibility_path compatibility_target compatibility_mount_target
    while IFS=$'\t' read -r compatibility_path compatibility_target; do
      compatibility_mount_target="$("$FINDMNT_BIN" --mountpoint "$compatibility_path" \
        --noheadings --output TARGET)"
      [ "$compatibility_mount_target" = "$compatibility_path" ] \
        || die "compatibility path is not an exact bind mount"
      [ "$(stat -c '%d:%i' -- "$compatibility_path")" \
          = "$(stat -c '%d:%i' -- "$compatibility_target")" ] \
        || die "compatibility bind mount identity changed before publication"
    done <<EOF
$OLD_PRODUCTION	$PRODUCTION
$OLD_STAGING	$STAGING
EOF
  fi
  "$NODE_BIN" - "$terminal_details" "$verification" "$PM2_ATTESTATION" \
    "$production_readiness" "$staging_readiness" \
    "$PRODUCTION" "$STAGING" "$new_production_runtime" "$new_staging_runtime" \
    "$pm2_dump_sha256" "$ACTIVE_JOURNAL" "$WORKER_HOME" \
    "$OLD_PRODUCTION" "$OLD_STAGING" "$WORKER_UID" "$WORKER_GID" "$TEST_MODE" \
    "$FINDMNT_BIN" <<'NODE'
const crypto=require('crypto');const fs=require('fs');const path=require('path');
const {execFileSync}=require('child_process');
const [output,verification,pm2,productionReadiness,stagingReadiness,
 productionBase,stagingBase,productionRuntime,stagingRuntime,
 pm2DumpSha256,activeJournalFile,workerHome,oldProduction,oldStaging,
 workerUidRaw,workerGidRaw,testMode,findmntBin]=process.argv.slice(2);
const authority=JSON.parse(fs.readFileSync(verification,'utf8'));
const activeJournal=JSON.parse(fs.readFileSync(activeJournalFile,'utf8'));
const digest=(file)=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const canonical=(value)=>value===null||typeof value!=='object'?JSON.stringify(value)
 :Array.isArray(value)?`[${value.map(canonical).join(',')}]`
 :`{${Object.keys(value).sort().map((key)=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
if(!/^[a-f0-9]{64}$/u.test(pm2DumpSha256||''))process.exit(1);
const database=activeJournal.databaseRecovery;
const unavailability=activeJournal.unavailability;
if(!database||!/^[a-f0-9]{64}$/u.test(database.recoveryPointSha256||'')
 ||!Number.isSafeInteger(database.recoveryPointSizeBytes)
 ||!/^[a-f0-9]{64}$/u.test(database.stoppedBoundary?.sha256||'')
 ||!Number.isSafeInteger(database.stoppedBoundary?.sizeBytes)
 ||unavailability?.schema!=='nexus.release-layout-unavailability.v1'
 ||unavailability.targetMet!==true
 ||unavailability.timingBasis!=='same_boot_monotonic'
 ||unavailability.durationMilliseconds>120000)process.exit(1);
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
const home=fs.lstatSync(workerHome);
const expectedHome=activeJournal.homeIdentity;
if(!expectedHome||!home.isDirectory()||home.isSymbolicLink()
 ||String(home.dev)!==expectedHome.dev||String(home.ino)!==expectedHome.ino
 ||home.uid!==expectedHome.uid||home.gid!==expectedHome.gid
 ||home.uid!==Number(workerUidRaw)||home.gid!==Number(workerGidRaw)
 ||(home.mode&0o7777)!==expectedHome.mode
 ||(home.mode&0o0022)!==0)process.exit(1);
const compatibilityMount=(mountPath,target)=>{
 const stat=fs.lstatSync(mountPath),targetStat=fs.lstatSync(target);
 let record;
 if(testMode==='1'){
  if(!stat.isSymbolicLink()||fs.readlinkSync(mountPath)!==target
   ||fs.realpathSync.native(mountPath)!==target)process.exit(1);
  record={kind:'test-symlink-equivalent',path:mountPath,target,
   findmnt:{source:'test-equivalent',target:mountPath,options:['bind']},
   mountIdentity:{dev:String(targetStat.dev),ino:String(targetStat.ino)},
   targetIdentity:{dev:String(targetStat.dev),ino:String(targetStat.ino)}};
 }else{
  if(!stat.isDirectory()||stat.isSymbolicLink()
   ||String(stat.dev)!==String(targetStat.dev)
   ||String(stat.ino)!==String(targetStat.ino))process.exit(1);
  const mount=JSON.parse(execFileSync(findmntBin,
   ['--json','--mountpoint',mountPath,'--output','SOURCE,TARGET,OPTIONS'],
   {encoding:'utf8'})).filesystems;
  if(!Array.isArray(mount)||mount.length!==1||mount[0].target!==mountPath
   ||typeof mount[0].source!=='string'||typeof mount[0].options!=='string')process.exit(1);
  record={kind:'bind-mount',path:mountPath,target,
   findmnt:{source:mount[0].source,target:mount[0].target,
    options:mount[0].options.split(',').filter(Boolean).sort()},
   mountIdentity:{dev:String(stat.dev),ino:String(stat.ino)},
   targetIdentity:{dev:String(targetStat.dev),ino:String(targetStat.ino)}};
 }
 return {...record,identitySha256:crypto.createHash('sha256')
  .update(canonical(record)).digest('hex')};
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
 compatibility:{
  home:{path:workerHome,dev:String(home.dev),ino:String(home.ino),uid:home.uid,
   gid:home.gid,mode:home.mode&0o7777},
  production:compatibilityMount(oldProduction,productionBase),
  staging:compatibilityMount(oldStaging,stagingBase),
 },
 pm2DumpSha256,
 readinessSha256:{production:digest(productionReadiness),staging:digest(stagingReadiness)},
 unavailability,
 databaseRecovery:{
  recoveryPointSha256:database.recoveryPointSha256,
  recoveryPointSizeBytes:database.recoveryPointSizeBytes,
  snapshotEvidenceSha256:database.snapshotEvidenceSha256,
  stoppedBoundarySha256:database.stoppedBoundary.sha256,
  stoppedBoundarySizeBytes:database.stoppedBoundary.sizeBytes,
  stoppedBoundaryEvidenceSha256:database.stoppedBoundary.evidenceSha256,
  stoppedBoundaryCopyEvidenceSha256:database.stoppedBoundary.copyEvidenceSha256,
  restoredFromRecoveryPoint:false,integrityCheck:'ok',foreignKeyCheck:'ok',
 },
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
	 readinessSha256:journal.readinessSha256,
	 compatibility:journal.compatibility,
	 unavailability:journal.unavailability,databaseRecovery:journal.databaseRecovery,
	 completedAt:journal.completedAt,
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
	 readinessSha256:result.readinessSha256,
	 compatibility:result.compatibility,
	 unavailability:result.unavailability,databaseRecovery:result.databaseRecovery,
	 soakSeconds:60,
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
exec 9>"$STATE_ROOT/.control.lock"
chmod 600 "$STATE_ROOT/.control.lock"
"$FLOCK_BIN" -x 9
if [ "$TEST_MODE" = 1 ] && [ ! -e "$LOCK_FILE" ]; then
  install -d -m 700 "$(dirname -- "$LOCK_FILE")"
  : >"$LOCK_FILE"
fi
[ -f "$LOCK_FILE" ] && [ ! -L "$LOCK_FILE" ] || die "shared release/Sonar mutex is unavailable"
exec 8>"$LOCK_FILE"
"$FLOCK_BIN" -x 8
if [ "$COMMAND" = migrate ]; then
  # Reuse the exact inherited control-lock file description so the PM2 closure
  # is verified inside the one-shot migration's serialization boundary without
  # recursively blocking on a second open description.
  NEXUS_PROMOTION_INHERITED_CONTROL_LOCK_FD=9 \
    "$CONTROL_BIN" assert-root-pm2-ready >/dev/null
fi

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
