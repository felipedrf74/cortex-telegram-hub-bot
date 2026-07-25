#!/usr/bin/env bash
# Sequential boot bridge: temporary recovery PM2 -> root canonical dump ->
# real pm2-dominguez resurrect -> exact root postcheck.
set -euo pipefail
umask 077
PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
export PATH

COMMAND="${1:-}"
TEST_MODE="${NEXUS_RELEASE_TEST_MODE:-0}"
STATE_ROOT="${NEXUS_PROMOTION_STATE_ROOT:-/var/lib/nexus-release-promotion}"
RELEASE_ROOT="${NEXUS_PROMOTION_RELEASE_ROOT:-/srv/nexus-release}"
OLD_PRODUCTION="${NEXUS_LAYOUT_OLD_PRODUCTION:-/home/dominguez/telegram-hub-bot}"
OLD_STAGING="${NEXUS_LAYOUT_OLD_STAGING:-/home/dominguez/telegram-hub-bot-staging}"
WORKER_USER="${NEXUS_PROMOTION_WORKER_USER:-dominguez}"
WORKER_HOME="${NEXUS_PROMOTION_WORKER_HOME:-/home/dominguez}"
PM2_HOME="${NEXUS_PROMOTION_PM2_HOME:-$WORKER_HOME/.pm2}"
PM2_BIN="${NEXUS_PROMOTION_PM2_BIN:-/usr/local/bin/pm2}"
NODE_BIN="${NEXUS_PROMOTION_NODE_BIN:-/usr/bin/node}"
PYTHON_BIN="${NEXUS_PROMOTION_PYTHON_BIN:-/usr/bin/python3}"
BASH_BIN="${NEXUS_PROMOTION_BASH_BIN:-/usr/bin/bash}"
CURL_BIN="${NEXUS_PROMOTION_CURL_BIN:-/usr/bin/curl}"
TIMEOUT_BIN="${NEXUS_PROMOTION_TIMEOUT_BIN:-/usr/bin/timeout}"
SETPRIV_BIN="${NEXUS_PROMOTION_SETPRIV_BIN:-/usr/bin/setpriv}"
ENV_BIN="${NEXUS_PROMOTION_ENV_BIN:-/usr/bin/env}"
DUMP_AUTHORITY_BIN="${NEXUS_PROMOTION_DUMP_AUTHORITY_BIN:-/usr/local/libexec/nexus-pm2-dump-authority.py}"
CAPTURE_AUTHORITY_BIN="${NEXUS_PROMOTION_CAPTURE_AUTHORITY_BIN:-/usr/local/libexec/nexus-capture-pm2-dump-authority.mjs}"
PM2_ATTESTATION="${NEXUS_PROMOTION_PM2_ATTESTATION:-$STATE_ROOT/pm2-root-install.v1.json}"
SYSTEMCTL_BIN="${NEXUS_PROMOTION_SYSTEMCTL_BIN:-/usr/bin/systemctl}"
TEMP_PM2_UNIT="${NEXUS_PROMOTION_TEMP_PM2_UNIT:-nexus-release-pm2-recovery-daemon.service}"
AUTHORITY_DIR="$STATE_ROOT/pm2-authority"
CANONICAL_DUMP="$AUTHORITY_DIR/dump.pm2"
AUTHORITY_RECEIPT="$AUTHORITY_DIR/receipt.json"
BOOT_RECOVERY="$STATE_ROOT/boot-recovery-in-progress.v1.json"
BOOT_PENDING="$STATE_ROOT/boot-health-pending.v1.json"
BOOT_PROOF="$STATE_ROOT/boot-health-proof.v1.json"

if [ "$TEST_MODE" = 1 ]; then
  NODE_BIN="${NEXUS_PROMOTION_NODE_BIN:-$(command -v node)}"
  PYTHON_BIN="${NEXUS_PROMOTION_PYTHON_BIN:-$(command -v python3)}"
  if [ -z "${NEXUS_PROMOTION_DUMP_AUTHORITY_BIN:-}" ]; then
    DUMP_AUTHORITY_BIN="$(cd "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/remote-pm2-dump-authority.py"
  fi
  if [ -z "${NEXUS_PROMOTION_CAPTURE_AUTHORITY_BIN:-}" ]; then
    CAPTURE_AUTHORITY_BIN="$(cd "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/capture-pm2-dump-authority.mjs"
  fi
fi

[ "$EUID" -eq 0 ] || [ "$TEST_MODE" = 1 ] || {
  echo "release boot health bridge requires root" >&2
  exit 77
}
case "$COMMAND" in start-temporary|publish-current|arm-current|prepare|postcheck) ;;
  *) echo "Usage: nexus-release-boot-health <start-temporary|publish-current|arm-current|prepare|postcheck>" >&2; exit 64 ;;
esac
for executable in "$PM2_BIN" "$NODE_BIN" "$PYTHON_BIN" "$BASH_BIN" \
  "$CURL_BIN" "$TIMEOUT_BIN" "$SYSTEMCTL_BIN" "$DUMP_AUTHORITY_BIN" \
  "$CAPTURE_AUTHORITY_BIN"; do
  [ -x "$executable" ] || {
    echo "release boot health executable is unavailable: $executable" >&2
    exit 1
  }
done
if [ "$TEST_MODE" != 1 ]; then
  [ -x "$SETPRIV_BIN" ] && [ -x "$ENV_BIN" ] || {
    echo "release boot health privilege-drop toolchain is unavailable" >&2
    exit 1
  }
fi

WORKER_UID="$(id -u "$WORKER_USER")"
WORKER_GID="$(id -g "$WORKER_USER")"
PM2_ROOT=""
PM2_CLOSURE_ROOT=""
PM2_DAEMON_TITLE=""

root_own() {
  if [ "$TEST_MODE" != 1 ]; then chown root:root "$@"; fi
}

fsync_path() {
  "$NODE_BIN" - "$1" <<'NODE'
const fs=require('fs');const fd=fs.openSync(process.argv[2],'r');
try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
NODE
}

run_worker() {
  if [ "$TEST_MODE" = 1 ]; then
    HOME="$WORKER_HOME" PM2_HOME="$PM2_HOME" PATH="$PATH" \
      PM2_DAEMON_TITLE="$PM2_DAEMON_TITLE" "$@"
  else
    "$SETPRIV_BIN" --reuid="$WORKER_UID" --regid="$WORKER_GID" \
      --init-groups --no-new-privs \
      "$ENV_BIN" -i HOME="$WORKER_HOME" PM2_HOME="$PM2_HOME" PATH="$PATH" \
      PM2_DAEMON_TITLE="$PM2_DAEMON_TITLE" "$@"
  fi
}

load_pm2_authority() {
  read -r PM2_CLOSURE_ROOT PM2_ROOT < <("$NODE_BIN" - "$PM2_ATTESTATION" \
    "$NODE_BIN" "$TEST_MODE" <<'NODE'
const fs=require('fs');const path=require('path');
const [file,nodeBin,testMode]=process.argv.slice(2);
const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));
try{
 const stat=fs.fstatSync(fd),x=JSON.parse(fs.readFileSync(fd));
 const rootUid=testMode==='1'?process.getuid():0,rootGid=testMode==='1'?process.getgid():0;
 if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.uid!==rootUid
  ||stat.gid!==rootGid||(stat.mode&0o7777)!==0o600
  ||x.schema!=='nexus.pm2-root-install.v1'||x.version!=='6.0.14'
  ||x.node?.path!==nodeBin||x.node?.version!=='v22.23.1'
  ||!/^[a-f0-9]{64}$/u.test(x.node?.sha256||'')
  ||!/^[a-f0-9]{64}$/u.test(x.closureDigest||'')
  ||x.entrypoint!==path.join(x.closureRoot,'node_modules/pm2/bin/pm2'))process.exit(1);
 process.stdout.write(`${x.closureRoot}\t${path.join(x.closureRoot,'node_modules/pm2')}\n`);
}finally{fs.closeSync(fd);}
NODE
  )
  [ -n "$PM2_CLOSURE_ROOT" ] && [ -n "$PM2_ROOT" ] || {
    echo "root PM2 closure authority is unavailable" >&2
    return 1
  }
  PM2_DAEMON_TITLE="NexusPM2:$PM2_CLOSURE_ROOT"
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

role_fields() {
  local role="$1" authoritative legacy
  if [ "$role" = production ]; then
    authoritative="$RELEASE_ROOT/production"; legacy="$OLD_PRODUCTION"
  else
    authoritative="$RELEASE_ROOT/staging"; legacy="$OLD_STAGING"
  fi
  "$NODE_BIN" - "$role" "$authoritative" "$legacy" "$WORKER_GID" "$TEST_MODE" <<'NODE'
const fs=require('fs');const path=require('path');
const [role,authoritative,legacy,workerGidRaw,testMode]=process.argv.slice(2);
const workerGid=Number(workerGidRaw),rootUid=testMode==='1'?process.getuid():0;
const candidates=[authoritative,legacy];
for(const base of candidates){
 let baseStat;try{baseStat=fs.lstatSync(base);}catch(error){if(error?.code==='ENOENT')continue;throw error;}
 if(!baseStat.isDirectory()||baseStat.isSymbolicLink()||fs.realpathSync.native(base)!==base)continue;
 const selector=path.join(base,'current');
 let selectorStat;try{selectorStat=fs.lstatSync(selector);}catch(error){if(error?.code==='ENOENT')continue;throw error;}
 const runtime=fs.readlinkSync(selector);
 if(!selectorStat.isSymbolicLink()||selectorStat.uid!==rootUid
  ||path.dirname(runtime)!==path.join(base,'releases')
  ||fs.realpathSync.native(selector)!==runtime)continue;
 const runtimeStat=fs.lstatSync(runtime);
 if(!runtimeStat.isDirectory()||runtimeStat.isSymbolicLink()
  ||runtimeStat.uid!==rootUid||runtimeStat.gid!==workerGid
  ||(runtimeStat.mode&0o7777)!==0o550)continue;
 const markerPath=path.join(runtime,'.complete.json');
 const fd=fs.openSync(markerPath,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));
 try{
  const before=fs.fstatSync(fd),body=fs.readFileSync(fd),after=fs.fstatSync(fd);
  const marker=JSON.parse(body);
  if(!before.isFile()||before.nlink!==1||before.dev!==after.dev||before.ino!==after.ino
   ||before.size!==after.size||before.mtimeMs!==after.mtimeMs
   ||!/^[a-f0-9]{40}$/u.test(marker.runtimeSha||''))continue;
  process.stdout.write(`${base}\t${runtime}\t${marker.runtimeSha}\n`);
  process.exit(0);
 }finally{fs.closeSync(fd);}
}
process.exit(1);
NODE
}

load_roles() {
  IFS=$'\t' read -r PRODUCTION_BASE PRODUCTION_RUNTIME PRODUCTION_SHA \
    < <(role_fields production)
  IFS=$'\t' read -r STAGING_BASE STAGING_RUNTIME STAGING_SHA \
    < <(role_fields staging)
}

exact_pm2_snapshot() {
  local output="$1"
  run_worker "$TIMEOUT_BIN" --signal=TERM --kill-after=2s 10s \
    "$PM2_BIN" jlist >"$output"
}

verify_exact_pm2_stable() {
  local before after authority_unit authority_fields authority_pid authority_control_group
  if [ "$("$SYSTEMCTL_BIN" show "$TEMP_PM2_UNIT" -p ActiveState --value)" = active ]; then
    authority_unit="$TEMP_PM2_UNIT"
  else
    authority_unit=pm2-dominguez.service
  fi
  authority_fields="$(systemd_pm2_authority "$authority_unit")"
  IFS=$'\t' read -r authority_pid authority_control_group <<<"$authority_fields"
  before="$(mktemp "$STATE_ROOT/.boot-pm2-before.XXXXXXXX")"
  after="$(mktemp "$STATE_ROOT/.boot-pm2-after.XXXXXXXX")"
  exact_pm2_snapshot "$before"
  sleep 1
  exact_pm2_snapshot "$after"
  "$NODE_BIN" - "$before" "$after" "$PRODUCTION_RUNTIME" "$PRODUCTION_SHA" \
    "$STAGING_RUNTIME" "$STAGING_SHA" "$authority_control_group" "$TEST_MODE" <<'NODE'
const fs=require('fs');const [beforeFile,afterFile,production,productionSha,
 staging,stagingSha,controlGroup,testMode]=process.argv.slice(2);
const expected=[
 ['nexus-hub',production,`${production}/dist/index.js`,'node',productionSha],
 ['content-engine',`${production}/content-engine`,
  `${production}/content-engine/.venv/bin/python3.12`,'none',productionSha],
 ['nexus-hub-staging',staging,`${staging}/dist/index.js`,'node',stagingSha],
 ['content-engine-staging',`${staging}/content-engine`,
  `${staging}/content-engine/.venv/bin/python3.12`,'none',stagingSha],
];
const validate=(rows)=>{
 if(!Array.isArray(rows)||rows.length!==4)process.exit(1);
 return expected.map(([name,cwd,executable,interpreter,sha])=>{
  const matches=rows.filter((row)=>row?.name===name),row=matches[0],env=row?.pm2_env??{};
  if(matches.length!==1||env.status!=='online'||env.pm_cwd!==cwd
   ||env.pm_exec_path!==executable||env.exec_interpreter!==interpreter
   ||(env.NEXUS_RELEASE_SHA||env.GIT_COMMIT)!==sha||env.SENTRY_RELEASE!==sha
   ||!Number.isSafeInteger(Number(row.pid))||Number(row.pid)<=0
   ||!Number.isSafeInteger(Number(env.restart_time??0))
   ||!Number.isSafeInteger(Number(env.unstable_restarts??0)))process.exit(1);
  if(testMode!=='1'){
   const groups=fs.readFileSync(`/proc/${row.pid}/cgroup`,'utf8').trim().split('\n');
   if(!groups.some((entry)=>entry.endsWith(controlGroup)))process.exit(1);
  }
  return {name,pid:Number(row.pid),restart:Number(env.restart_time??0),
   unstable:Number(env.unstable_restarts??0)};
 });
};
const before=validate(JSON.parse(fs.readFileSync(beforeFile,'utf8')));
const after=validate(JSON.parse(fs.readFileSync(afterFile,'utf8')));
if(JSON.stringify(before)!==JSON.stringify(after))process.exit(1);
NODE
  rm -f -- "$before" "$after"
}

role_readiness() {
  local role="$1" base="$2" runtime="$3" sha="$4" output
  output="$(mktemp "$STATE_ROOT/.boot-${role}-readiness.XXXXXXXX")"
  chmod 600 "$output"; root_own "$output"
  exec 7<>"$output"
  run_worker "$TIMEOUT_BIN" --signal=TERM --kill-after=5s 60s \
    "$BASH_BIN" "$runtime/scripts/remote-release-readiness.sh" \
    --role "$role" --base-dir "$base" --release-dir "$runtime" \
    --runtime-sha "$sha" --pm2-bin "$PM2_BIN" --node-bin "$NODE_BIN" \
    --curl-bin "$CURL_BIN" --output-fd 7 --stability-seconds 0 \
    --readiness-attempts 8 --poll-seconds 1 >&2
  exec 7>&-
  rm -f -- "$output"
}

remove_untrusted_pm2_runtime_files() {
  "$PYTHON_BIN" - "$PM2_HOME" "$WORKER_UID" "$WORKER_GID" <<'PY'
import os, stat, sys
home, uid_raw, gid_raw = sys.argv[1:]
uid, gid = int(uid_raw), int(gid_raw)
if os.path.realpath(home) != home:
    raise SystemExit("PM2 home is not canonical")
flags = os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_NOFOLLOW", 0)
directory = os.open(home, flags)
try:
    identity = os.fstat(directory)
    if not stat.S_ISDIR(identity.st_mode) or identity.st_uid != uid or identity.st_gid != gid:
        raise SystemExit("PM2 home identity is unsafe")
    for name in ("pm2.pid", "rpc.sock", "pub.sock"):
        try:
            os.stat(name, dir_fd=directory, follow_symlinks=False)
        except FileNotFoundError:
            continue
        os.unlink(name, dir_fd=directory)
    os.fsync(directory)
finally:
    os.close(directory)
PY
}

assert_no_ungoverned_pm2_daemon() {
  [ "$TEST_MODE" = 1 ] && return 0
  "$PYTHON_BIN" - "$WORKER_UID" "$PM2_HOME" <<'PY'
import os, pathlib, re, sys

worker_uid, pm2_home = int(sys.argv[1]), sys.argv[2]
for entry in pathlib.Path("/proc").iterdir():
    if not entry.name.isdigit():
        continue
    try:
        status = (entry / "status").read_text()
        uid_line = re.search(r"^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$", status, re.M)
        if not uid_line or any(int(value) != worker_uid for value in uid_line.groups()):
            continue
        environment = (entry / "environ").read_bytes().split(b"\0")
        if f"PM2_HOME={pm2_home}".encode() not in environment:
            continue
        command = (entry / "cmdline").read_bytes().split(b"\0")[0].decode(
            errors="replace"
        )
        if command.startswith("PM2 v") or command.startswith("NexusPM2:"):
            raise SystemExit(
                f"ungoverned PM2 daemon exists before temporary unit start: {entry.name}"
            )
    except (FileNotFoundError, ProcessLookupError):
        continue
PY
}

systemd_pm2_authority() {
  local unit="$1" main_pid control_group active_state sub_state
  active_state="$("$SYSTEMCTL_BIN" show "$unit" -p ActiveState --value)"
  sub_state="$("$SYSTEMCTL_BIN" show "$unit" -p SubState --value)"
  main_pid="$("$SYSTEMCTL_BIN" show "$unit" -p MainPID --value)"
  control_group="$("$SYSTEMCTL_BIN" show "$unit" -p ControlGroup --value)"
  [ "$active_state" = active ] && [ "$sub_state" = running ] \
    && [[ "$main_pid" =~ ^[1-9][0-9]*$ ]] || {
    echo "PM2 daemon is not owned by the expected root systemd unit: $unit" >&2
    return 1
  }
  case "$unit:$control_group" in
    pm2-dominguez.service:/system.slice/pm2-dominguez.service) ;;
    nexus-release-pm2-recovery-daemon.service:/system.slice/nexus-release-pm2-recovery-daemon.service) ;;
    *) echo "PM2 systemd control group is not exact: $unit" >&2; return 1 ;;
  esac
  printf '%s\t%s\n' "$main_pid" "$control_group"
}

ensure_temporary_pm2() {
  [ "$("$SYSTEMCTL_BIN" show pm2-dominguez.service -p ActiveState --value)" != active ] || {
    echo "real pm2-dominguez started before sequential boot recovery" >&2
    return 1
  }
  if [ "$("$SYSTEMCTL_BIN" show "$TEMP_PM2_UNIT" -p ActiveState --value)" = active ]; then
    systemd_pm2_authority "$TEMP_PM2_UNIT" >/dev/null
    return 0
  fi
  # Worker-owned PID/socket files are never signal authority. The root unit is
  # inactive here, so remove only the three pinned stale runtime names through
  # an already-open PM2_HOME descriptor.
  assert_no_ungoverned_pm2_daemon
  remove_untrusted_pm2_runtime_files
  "$SYSTEMCTL_BIN" start "$TEMP_PM2_UNIT"
  systemd_pm2_authority "$TEMP_PM2_UNIT" >/dev/null
}

start_exact_roles() {
  ensure_temporary_pm2
  run_release production "$PRODUCTION_BASE" "$PRODUCTION_RUNTIME" "$PRODUCTION_SHA" \
    "$TIMEOUT_BIN" --signal=TERM --kill-after=3s 25s \
    "$PM2_BIN" start "$PRODUCTION_RUNTIME/ecosystem.release.config.js" --update-env >/dev/null
  run_release staging "$STAGING_BASE" "$STAGING_RUNTIME" "$STAGING_SHA" \
    "$TIMEOUT_BIN" --signal=TERM --kill-after=3s 25s \
    "$PM2_BIN" start "$STAGING_RUNTIME/ecosystem.release.config.js" --update-env >/dev/null
  role_readiness production "$PRODUCTION_BASE" "$PRODUCTION_RUNTIME" "$PRODUCTION_SHA"
  role_readiness staging "$STAGING_BASE" "$STAGING_RUNTIME" "$STAGING_SHA"
  verify_exact_pm2_stable
}

authority_args() {
  printf '%s\0' \
    --canonical "$CANONICAL_DUMP" --receipt "$AUTHORITY_RECEIPT" \
    --production-base "$PRODUCTION_BASE" \
    --production-runtime "$PRODUCTION_RUNTIME" --production-sha "$PRODUCTION_SHA" \
    --staging-base "$STAGING_BASE" \
    --staging-runtime "$STAGING_RUNTIME" --staging-sha "$STAGING_SHA" \
    --worker-home "$WORKER_HOME" --pm2-home "$PM2_HOME" \
    --worker-uid "$WORKER_UID" --worker-gid "$WORKER_GID"
}

run_dump_authority() {
  local command="$1"
  shift
  local -a args=()
  while IFS= read -r -d '' item; do args+=("$item"); done < <(authority_args)
  if [ "$TEST_MODE" = 1 ]; then args+=(--allow-test-owner); fi
  "$PYTHON_BIN" "$DUMP_AUTHORITY_BIN" "$command" "${args[@]}" "$@"
}

publish_current_dump() {
  verify_exact_pm2_stable
  install -d -o root -g "$WORKER_GID" -m 0750 "$AUTHORITY_DIR"
  local capture_root canonical metadata result authority_fields
  local authority_pid authority_control_group authority_unit
  if [ "$("$SYSTEMCTL_BIN" show "$TEMP_PM2_UNIT" -p ActiveState --value)" = active ]; then
    authority_unit="$TEMP_PM2_UNIT"
  else
    authority_unit=pm2-dominguez.service
  fi
  authority_fields="$(systemd_pm2_authority "$authority_unit")"
  IFS=$'\t' read -r authority_pid authority_control_group <<<"$authority_fields"
  capture_root="$(mktemp -d "$AUTHORITY_DIR/.capture.XXXXXXXX")"
  chmod 700 "$capture_root"; root_own "$capture_root"
  canonical="$capture_root/canonical.pm2"
  metadata="$capture_root/metadata.json"
  local -a capture_args=(
    --pm2-root "$PM2_ROOT" --pm2-home "$PM2_HOME"
    --install-attestation "$PM2_ATTESTATION"
    --output "$canonical" --metadata-output "$metadata"
    --node-bin "$NODE_BIN" --setpriv-bin "$SETPRIV_BIN" --env-bin "$ENV_BIN"
    --worker-home "$WORKER_HOME" --worker-uid "$WORKER_UID" --worker-gid "$WORKER_GID"
    --production-base "$PRODUCTION_BASE" --production-runtime "$PRODUCTION_RUNTIME"
    --production-sha "$PRODUCTION_SHA"
    --staging-base "$STAGING_BASE" --staging-runtime "$STAGING_RUNTIME"
    --staging-sha "$STAGING_SHA" --daemon-title "$PM2_DAEMON_TITLE"
    --expected-daemon-pid "$authority_pid"
    --expected-control-group "$authority_control_group"
  )
  if [ "$TEST_MODE" = 1 ]; then capture_args+=(--allow-test-owner 1); fi
  "$NODE_BIN" "$CAPTURE_AUTHORITY_BIN" "${capture_args[@]}" >/dev/null
  result="$(run_dump_authority publish --source "$canonical" --metadata "$metadata")"
  rm -f -- "$canonical" "$metadata"
  rmdir -- "$capture_root"
  fsync_path "$AUTHORITY_DIR"
  printf '%s\n' "$result"
}

kill_temporary_pm2() {
  local authority_fields daemon_pid control_group
  authority_fields="$(systemd_pm2_authority "$TEMP_PM2_UNIT")"
  IFS=$'\t' read -r daemon_pid control_group <<<"$authority_fields"
  "$SYSTEMCTL_BIN" stop "$TEMP_PM2_UNIT"
  [ "$("$SYSTEMCTL_BIN" show "$TEMP_PM2_UNIT" -p ActiveState --value)" = inactive ] \
    && [ "$("$SYSTEMCTL_BIN" show "$TEMP_PM2_UNIT" -p MainPID --value)" = 0 ] || {
    echo "temporary recovery PM2 systemd authority did not stop" >&2
    return 1
  }
  if [ -e "/sys/fs/cgroup$control_group/cgroup.procs" ] \
      && [ -n "$(tr -d '[:space:]' <"/sys/fs/cgroup$control_group/cgroup.procs")" ]; then
    echo "temporary recovery PM2 cgroup is not empty after stop" >&2
    return 1
  fi
  if kill -0 "$daemon_pid" 2>/dev/null; then
    echo "temporary recovery PM2 MainPID survived root cgroup stop" >&2
    return 1
  fi
}

write_pending() {
  local authority_json="$1" temporary
  [ -f "$BOOT_RECOVERY" ] && [ ! -L "$BOOT_RECOVERY" ] || {
    echo "boot recovery timing authority is unavailable" >&2
    return 1
  }
  temporary="$(mktemp "$STATE_ROOT/.boot-health-pending.XXXXXXXX")"
  "$NODE_BIN" - "$temporary" "$authority_json" "$BOOT_RECOVERY" \
    "$PRODUCTION_BASE" "$PRODUCTION_RUNTIME" "$PRODUCTION_SHA" \
    "$STAGING_BASE" "$STAGING_RUNTIME" "$STAGING_SHA" <<'NODE'
const crypto=require('crypto');const fs=require('fs');
const [output,authorityRaw,recoveryFile,productionBase,productionRuntime,productionSha,
 stagingBase,stagingRuntime,stagingSha]=process.argv.slice(2);
const authority=JSON.parse(authorityRaw);
const recoveryBody=fs.readFileSync(recoveryFile),recovery=JSON.parse(recoveryBody);
if(authority.schema!=='nexus.pm2-resurrection-authority.v2'
 ||!/^[a-f0-9]{64}$/u.test(authority.dumpSha256||''))process.exit(1);
if(recovery.schema!=='nexus.release-boot-recovery.v1'||recovery.status!=='in_progress'
 ||typeof recovery.bootId!=='string'||!recovery.bootId
 ||typeof recovery.outageStartedAt!=='string'||!Number.isFinite(Date.parse(recovery.outageStartedAt))
 ||!Number.isSafeInteger(recovery.outageStartedEpoch)
 ||!Number.isSafeInteger(recovery.recoveryDeadlineEpoch)
 ||recovery.recoveryDeadlineEpoch-recovery.outageStartedEpoch!==120
 ||!Number.isSafeInteger(recovery.outageStartedMonotonic)
 ||typeof recovery.outageBootId!=='string')process.exit(1);
fs.writeFileSync(output,`${JSON.stringify({
 schema:'nexus.release-boot-health-pending.v2',status:'pending',
 production:{base:productionBase,runtime:productionRuntime,runtimeSha:productionSha},
 staging:{base:stagingBase,runtime:stagingRuntime,runtimeSha:stagingSha},
 canonicalDumpSha256:authority.dumpSha256,
 pm2ClosureDigest:authority.pm2ClosureDigest,nodeSha256:authority.nodeSha256,
 recoveryAuthoritySha256:crypto.createHash('sha256').update(recoveryBody).digest('hex'),
 bootId:recovery.bootId,outageBootId:recovery.outageBootId,
 outageStartedAt:recovery.outageStartedAt,
 outageStartedEpoch:recovery.outageStartedEpoch,
 outageStartedMonotonic:recovery.outageStartedMonotonic,
 recoveryDeadlineEpoch:recovery.recoveryDeadlineEpoch,
 temporaryPreparedAt:new Date().toISOString(),
},null,2)}\n`,{mode:0o600,flag:'w'});
const fd=fs.openSync(output,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
NODE
  chmod 600 "$temporary"; root_own "$temporary"
  mv -T -- "$temporary" "$BOOT_PENDING"
  fsync_path "$STATE_ROOT"
}

prepare_boot() {
  load_roles
  start_exact_roles
  local authority_json
  authority_json="$(publish_current_dump)"
  write_pending "$authority_json"
  kill_temporary_pm2
}

arm_current() {
  # Used after a non-boot recovery that has already proved both roles and
  # published the canonical dump. It arms the same root proof chain without
  # restarting or mutating the exact healthy real PM2 service.
  load_roles
  local authority_json
  authority_json="$(run_dump_authority validate)"
  write_pending "$authority_json"
}

validate_pending() {
  "$NODE_BIN" - "$BOOT_PENDING" "$PRODUCTION_BASE" "$PRODUCTION_RUNTIME" \
    "$PRODUCTION_SHA" "$STAGING_BASE" "$STAGING_RUNTIME" "$STAGING_SHA" <<'NODE'
const fs=require('fs');const [file,productionBase,productionRuntime,productionSha,
 stagingBase,stagingRuntime,stagingSha]=process.argv.slice(2);
const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));
try{
 const before=fs.fstatSync(fd),body=fs.readFileSync(fd),after=fs.fstatSync(fd),x=JSON.parse(body);
 if(!before.isFile()||before.nlink!==1||(before.mode&0o7777)!==0o600
  ||before.dev!==after.dev||before.ino!==after.ino||before.size!==after.size
  ||before.mtimeMs!==after.mtimeMs
  ||x.schema!=='nexus.release-boot-health-pending.v2'||x.status!=='pending'
  ||JSON.stringify(x.production)!==JSON.stringify(
   {base:productionBase,runtime:productionRuntime,runtimeSha:productionSha})
  ||JSON.stringify(x.staging)!==JSON.stringify(
   {base:stagingBase,runtime:stagingRuntime,runtimeSha:stagingSha})
  ||!/^[a-f0-9]{64}$/u.test(x.canonicalDumpSha256||'')
  ||!/^[a-f0-9]{64}$/u.test(x.pm2ClosureDigest||'')
  ||!/^[a-f0-9]{64}$/u.test(x.nodeSha256||'')
  ||!/^[a-f0-9]{64}$/u.test(x.recoveryAuthoritySha256||'')
  ||typeof x.bootId!=='string'||typeof x.outageBootId!=='string'
  ||!Number.isSafeInteger(x.outageStartedEpoch)
  ||!Number.isSafeInteger(x.outageStartedMonotonic)
  ||!Number.isSafeInteger(x.recoveryDeadlineEpoch)
  ||x.recoveryDeadlineEpoch-x.outageStartedEpoch!==120)process.exit(1);
process.stdout.write(JSON.stringify(x));
}finally{fs.closeSync(fd);}
NODE
}

validate_real_service_daemon() {
  local main_pid control_group pid_file_pid current_boot
  main_pid="$("$SYSTEMCTL_BIN" show pm2-dominguez.service -p MainPID --value)"
  control_group="$("$SYSTEMCTL_BIN" show pm2-dominguez.service -p ControlGroup --value)"
  [ "$("$SYSTEMCTL_BIN" show pm2-dominguez.service -p SubState --value)" = running ] \
    && [[ "$main_pid" =~ ^[1-9][0-9]*$ ]] \
    && [ "$control_group" = /system.slice/pm2-dominguez.service ] || {
    echo "pm2-dominguez is not the authoritative running service" >&2
    return 1
  }
  pid_file_pid="$(tr -d '[:space:]' <"$PM2_HOME/pm2.pid")"
  [ "$pid_file_pid" = "$main_pid" ] || {
    echo "pm2-dominguez MainPID differs from the worker PID file" >&2
    return 1
  }
  "$NODE_BIN" - "$main_pid" "$WORKER_UID" "$NODE_BIN" "$PM2_DAEMON_TITLE" \
    "$control_group" "$PM2_HOME" "$CANONICAL_DUMP" <<'NODE'
const fs=require('fs');const [pid,uidRaw,nodeBin,title,controlGroup,pm2Home,dump]=process.argv.slice(2);
const status=fs.readFileSync(`/proc/${pid}/status`,'utf8');
const uid=status.match(/^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$/mu);
if(!uid||uid.slice(1).some((value)=>Number(value)!==Number(uidRaw))
 ||fs.realpathSync.native(`/proc/${pid}/exe`)!==nodeBin)process.exit(1);
const command=fs.readFileSync(`/proc/${pid}/cmdline`).toString('utf8').split('\0').filter(Boolean);
if(command[0]!==title)process.exit(1);
const groups=fs.readFileSync(`/proc/${pid}/cgroup`,'utf8').trim().split('\n');
if(!groups.some((line)=>line.endsWith(controlGroup)))process.exit(1);
const environment=new Map(fs.readFileSync(`/proc/${pid}/environ`).toString('utf8')
 .split('\0').filter(Boolean).map((entry)=>{const i=entry.indexOf('=');return [entry.slice(0,i),entry.slice(i+1)]}));
const forbidden=new Set(['NODE_OPTIONS','NODE_PATH','PM2_NODE_OPTIONS','PYTHONPATH',
 'PYTHONHOME','PYTHONINSPECT','PYTHONSTARTUP','PYTHONBREAKPOINT',
 'LD_PRELOAD','LD_LIBRARY_PATH']);
if(environment.get('PM2_HOME')!==pm2Home
 ||environment.get('PM2_DUMP_FILE_PATH')!==dump
 ||environment.get('PM2_DAEMON_TITLE')!==title
 ||[...forbidden].some((name)=>environment.has(name)))process.exit(1);
NODE
  printf '%s\t%s\n' "$main_pid" "$control_group"
}

postcheck_boot() {
  [ -f "$BOOT_PENDING" ] && [ ! -L "$BOOT_PENDING" ] || exit 0
  load_roles
  local pending_json pending_digest authority_json temporary daemon_fields
  local main_pid control_group actual_service_healthy_epoch
  pending_json="$(validate_pending)"
  pending_digest="$(printf '%s' "$pending_json" | "$NODE_BIN" -e \
    'let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>process.stdout.write(JSON.parse(b).canonicalDumpSha256))')"
  authority_json="$(run_dump_authority validate)"
  [ "$(printf '%s' "$authority_json" | "$NODE_BIN" -e '
let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{
 const x=JSON.parse(b);process.stdout.write(x.dumpSha256||"")})')" = "$pending_digest" ] || {
    echo "boot PM2 authority differs from pending recovery" >&2
    exit 1
  }
  daemon_fields="$(validate_real_service_daemon)"
  IFS=$'\t' read -r main_pid control_group <<<"$daemon_fields"
  verify_exact_pm2_stable
  role_readiness production "$PRODUCTION_BASE" "$PRODUCTION_RUNTIME" "$PRODUCTION_SHA"
  role_readiness staging "$STAGING_BASE" "$STAGING_RUNTIME" "$STAGING_SHA"
  verify_exact_pm2_stable
  [ "$(validate_real_service_daemon)" = "$daemon_fields" ] || {
    echo "pm2-dominguez daemon identity changed during the root postcheck" >&2
    exit 1
  }
  actual_service_healthy_epoch="$(date +%s)"
  temporary="$(mktemp "$STATE_ROOT/.boot-health-proof.XXXXXXXX")"
  "$NODE_BIN" - "$temporary" "$BOOT_PENDING" "$pending_digest" \
    "$actual_service_healthy_epoch" "$main_pid" "$control_group" <<'NODE'
const crypto=require('crypto');const fs=require('fs');
const [output,pending,dumpSha256,healthyRaw,mainPidRaw,controlGroup]=process.argv.slice(2);
const body=fs.readFileSync(pending),x=JSON.parse(body),healthy=Number(healthyRaw);
const bootId=fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim();
const monotonic=Math.floor(Number(fs.readFileSync('/proc/uptime','utf8').split(/\s+/u)[0]));
const elapsed=x.outageBootId===bootId&&monotonic>=x.outageStartedMonotonic
 ?monotonic-x.outageStartedMonotonic:healthy-x.outageStartedEpoch;
if(x.bootId!==bootId||!Number.isSafeInteger(elapsed)||elapsed<0)process.exit(1);
const targetMet=healthy<=x.recoveryDeadlineEpoch&&elapsed<=120;
fs.writeFileSync(output,`${JSON.stringify({
 schema:'nexus.release-boot-health-proof.v2',
 status:targetMet?'passed':'healthy_sla_missed',
 pendingSha256:crypto.createHash('sha256').update(body).digest('hex'),
 canonicalDumpSha256:dumpSha256,serviceCount:4,
 bootId,outageBootId:x.outageBootId,outageStartedAt:x.outageStartedAt,
 actualServiceHealthyAt:new Date(healthy*1000).toISOString(),
 outageToActualServiceHealthySeconds:elapsed,recoveryTargetSeconds:120,targetMet,
 pm2Dominguez:{mainPid:Number(mainPidRaw),controlGroup},
 verifiedAt:new Date().toISOString(),
},null,2)}\n`,{mode:0o600,flag:'w'});
const fd=fs.openSync(output,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
NODE
  chmod 600 "$temporary"; root_own "$temporary"
  mv -T -- "$temporary" "$BOOT_PROOF"
  fsync_path "$STATE_ROOT"
  "$NODE_BIN" - "$BOOT_PROOF" <<'NODE'
const fs=require('fs');const x=JSON.parse(fs.readFileSync(process.argv[2]));
process.stdout.write(`${JSON.stringify({ok:true,schema:x.schema,status:x.status,
 targetMet:x.targetMet})}\n`);
NODE
}

install -d -m 700 "$STATE_ROOT"
if [ "$TEST_MODE" != 1 ]; then chown root:root "$STATE_ROOT"; fi
load_pm2_authority
case "$COMMAND" in
  start-temporary) ensure_temporary_pm2 ;;
  publish-current) load_roles; publish_current_dump ;;
  arm-current) arm_current ;;
  prepare) prepare_boot ;;
  postcheck) postcheck_boot ;;
esac
