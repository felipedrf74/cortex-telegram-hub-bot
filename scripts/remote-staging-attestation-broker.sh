#!/usr/bin/env bash
# Root-owned, synchronous staging switch and evidence broker. The deploy user
# may provide only exact identities; it never supplies executable paths or
# evidence paths. Filesystem identities are rechecked around every candidate
# execution and before the root-only record is published.
set -euo pipefail
umask 077
PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
export PATH

VERSION="nexus-staging-attestation-broker.v1"
STATE_ROOT="${NEXUS_PROMOTION_STATE_ROOT:-/var/lib/nexus-release-promotion}"
RELEASE_ROOT="${NEXUS_PROMOTION_RELEASE_ROOT:-/srv/nexus-release}"
WORKER_USER="${NEXUS_PROMOTION_WORKER_USER:-dominguez}"
NODE_BIN="${NEXUS_PROMOTION_NODE_BIN:-/usr/bin/node}"
BASH_BIN="${NEXUS_PROMOTION_BASH_BIN:-/usr/bin/bash}"
CURL_BIN="${NEXUS_PROMOTION_CURL_BIN:-/usr/bin/curl}"
TIMEOUT_BIN="${NEXUS_PROMOTION_TIMEOUT_BIN:-/usr/bin/timeout}"
SETPRIV_BIN="${NEXUS_PROMOTION_SETPRIV_BIN:-/usr/bin/setpriv}"
ENV_BIN="${NEXUS_PROMOTION_ENV_BIN:-/usr/bin/env}"
PM2_BIN="${NEXUS_PROMOTION_PM2_BIN:-/usr/local/bin/pm2}"
FILESYSTEM_IDENTITY="${NEXUS_PROMOTION_FILESYSTEM_IDENTITY:-/usr/local/libexec/nexus-trusted-release-filesystem-identity.mjs}"
PYTHON_BIN="${NEXUS_PROMOTION_PYTHON_BIN:-/usr/bin/python3}"
SELECTOR_SWITCH="${NEXUS_PROMOTION_SELECTOR_SWITCH:-/usr/local/libexec/nexus-release-selector-switch.py}"
BOOT_HEALTH_BIN="${NEXUS_PROMOTION_BOOT_HEALTH_BIN:-/usr/local/sbin/nexus-release-boot-health}"
TEST_MODE="${NEXUS_RELEASE_TEST_MODE:-0}"
if [ "$TEST_MODE" = 1 ]; then
  PYTHON_BIN="${NEXUS_PROMOTION_PYTHON_BIN:-$(command -v python3)}"
  if [ -z "${NEXUS_PROMOTION_SELECTOR_SWITCH:-}" ]; then
    SELECTOR_SWITCH="$(cd "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/remote-release-selector-switch.py"
  fi
fi

MODE=attest
case "${1:-}" in
  recover-all) MODE=recover-all; shift ;;
  finalize) MODE=finalize; shift ;;
esac

REQUEST_ID="${1:-}"
RUNTIME="${2:-}"
BASE="${3:-}"
RUNTIME_SHA="${4:-}"
ARTIFACT_DIGEST="${5:-}"
STABILITY_SECONDS="${6:-60}"
BINDING="${7:-}"
RECOVERY="${8:-}"
OUTPUT="${9:-}"

if [ "$EUID" -ne 0 ] && [ "$TEST_MODE" != 1 ]; then
  echo "staging attestation broker must run as root" >&2
  exit 77
fi
if [ "$MODE" = attest ]; then
  [[ "$REQUEST_ID" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ \
      && "$RUNTIME_SHA" =~ ^[a-f0-9]{40}$ \
      && "$ARTIFACT_DIGEST" =~ ^[a-f0-9]{64}$ ]] || {
    echo "staging attestation broker identity is invalid" >&2
    exit 64
  }
  [ "$BASE" = "$RELEASE_ROOT/staging" ] \
    && [ "$RUNTIME" != "$BASE/releases" ] \
    && [[ "$RUNTIME" == "$BASE"/releases/* ]] || {
    echo "staging attestation broker path is outside the authoritative root" >&2
    exit 64
  }
  case "$STABILITY_SECONDS" in
    ''|*[!0-9]*) echo "staging stability seconds are invalid" >&2; exit 64 ;;
  esac
  [ "$STABILITY_SECONDS" -le 60 ] || {
    echo "staging stability seconds must not exceed 60" >&2
    exit 64
  }
elif [ "$MODE" = recover-all ]; then
  [ "$#" -eq 0 ] || {
    echo "recover-all does not accept deploy-user supplied identities" >&2
    exit 64
  }
else
  [[ "$REQUEST_ID" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] \
    && [ "$#" -eq 1 ] || {
    echo "staging finalize identity is invalid" >&2
    exit 64
  }
fi
for executable in "$NODE_BIN" "$BASH_BIN" "$CURL_BIN" "$TIMEOUT_BIN" \
  "$PYTHON_BIN" "$SELECTOR_SWITCH"; do
  [ -x "$executable" ] || { echo "root broker executable is unavailable" >&2; exit 1; }
done
if [ "$TEST_MODE" != 1 ]; then
  [ -x "$SETPRIV_BIN" ] && [ -x "$ENV_BIN" ] || {
    echo "root broker privilege-drop toolchain is unavailable" >&2
    exit 1
  }
fi
[ -f "$FILESYSTEM_IDENTITY" ] && [ ! -L "$FILESYSTEM_IDENTITY" ] || {
  echo "root-installed filesystem identity verifier is unavailable" >&2
  exit 1
}
if [ "$MODE" = attest ]; then
  for input in "$BINDING" "$RECOVERY"; do
    [[ "$input" == "$STATE_ROOT/staging/"* ]] \
      && [ -f "$input" ] && [ ! -L "$input" ] && [ "$(stat -c '%h' "$input")" = 1 ] || {
      echo "root broker input evidence is unsafe" >&2
      exit 1
    }
  done
  [[ "$OUTPUT" == "$STATE_ROOT/staging/"*".next."* ]] \
    && [ -f "$OUTPUT" ] && [ ! -L "$OUTPUT" ] && [ "$(stat -c '%h' "$OUTPUT")" = 1 ] || {
    echo "root broker output target is unsafe" >&2
    exit 1
  }
fi

WORKER_UID="$(id -u "$WORKER_USER")"
WORKER_GID="$(id -g "$WORKER_USER")"
WORKER_HOME="$(getent passwd "$WORKER_USER" | cut -d: -f6)"
[ -n "$WORKER_HOME" ] || { echo "release worker home is unavailable" >&2; exit 1; }

FS_ARGS=()
if [ "$MODE" = attest ]; then
  FS_ARGS=(
    --role staging
    --release-root "$RELEASE_ROOT"
    --base "$BASE"
    --runtime "$RUNTIME"
    --worker-uid "$WORKER_UID"
    --worker-gid "$WORKER_GID"
    --binding "$BINDING"
  )
  if [ "$TEST_MODE" = 1 ]; then FS_ARGS+=(--allow-test-owner); fi
fi

verify_filesystem_identity() {
  "$NODE_BIN" "$FILESYSTEM_IDENTITY" verify "${FS_ARGS[@]}" >/dev/null
}

resolve_trusted_pm2() {
  "$NODE_BIN" - "$PM2_BIN" "$TEST_MODE" <<'NODE'
const fs=require('fs');const path=require('path');
const [declared,testMode]=process.argv.slice(2);
if(!path.isAbsolute(declared))throw new Error('PM2 path must be absolute');
const resolved=fs.realpathSync.native(declared);
const stat=fs.statSync(resolved);
if(!stat.isFile()||!(stat.mode&0o111))throw new Error('PM2 target is not executable');
if(testMode!=='1'){
  if(stat.uid!==0||(stat.mode&0o022)!==0)throw new Error('PM2 target ownership is unsafe');
  const declaredParent=path.dirname(declared);
  for(const initial of [declaredParent,path.dirname(resolved)]){
    let current=initial;
    for(;;){
      const item=fs.statSync(current);
      if(!item.isDirectory()||item.uid!==0||(item.mode&0o022)!==0){
        throw new Error('PM2 path ancestor ownership is unsafe');
      }
      const parent=path.dirname(current);
      if(parent===current)break;
      current=parent;
    }
  }
  const link=fs.lstatSync(declared);
  if(link.isSymbolicLink()&&link.uid!==0)throw new Error('PM2 link ownership is unsafe');
}
process.stdout.write(resolved);
NODE
}
PM2_RESOLVED="$(resolve_trusted_pm2)"

run_worker() {
  if [ "$TEST_MODE" = 1 ]; then
    HOME="$WORKER_HOME" PATH="$PATH" "$@"
  else
    "$SETPRIV_BIN" --reuid="$WORKER_UID" --regid="$WORKER_GID" \
      --init-groups --no-new-privs \
      "$ENV_BIN" -i HOME="$WORKER_HOME" PATH="$PATH" "$@"
  fi
}

run_worker_release() {
  local selected_runtime="$1" selected_sha="$2"
  shift 2
  run_worker "$ENV_BIN" \
    NEXUS_RELEASE_DIR="$selected_runtime" \
    NEXUS_RELEASE_BASE_DIR="$BASE" \
    NEXUS_RELEASE_ROLE=staging \
    NEXUS_RELEASE_SHA="$selected_sha" \
    SENTRY_RELEASE="$selected_sha" \
    "$@"
}

delete_staging_apps() {
  local app snapshot matches
  snapshot="$(
    run_worker "$TIMEOUT_BIN" --signal=TERM --kill-after=2s 5s \
      "$PM2_RESOLVED" jlist
  )"
  for app in nexus-hub-staging content-engine-staging; do
    matches="$("$NODE_BIN" -e '
const rows=JSON.parse(process.argv[1]);const matches=rows.filter((row)=>row?.name===process.argv[2]);
if(matches.length>1)process.exit(1);process.stdout.write(String(matches.length));' \
      "$snapshot" "$app")"
    if [ "$matches" = 1 ]; then
      run_worker "$TIMEOUT_BIN" --signal=TERM --kill-after=2s 8s \
        "$PM2_RESOLVED" delete "$app" >/dev/null
    fi
  done
}

read_current() {
  if [ -L "$BASE/current" ]; then
    readlink -f "$BASE/current"
  elif [ -e "$BASE/current" ]; then
    echo "staging current entry is not a symlink" >&2
    return 1
  fi
}

current_selector_identity() {
  local expected="$1"
  local args=(
    verify --role staging --release-root "$RELEASE_ROOT"
    --worker-uid "$WORKER_UID" --worker-gid "$WORKER_GID"
    --target "$expected"
  )
  if [ "$TEST_MODE" = 1 ]; then args+=(--allow-test-owner); fi
  "$PYTHON_BIN" "$SELECTOR_SWITCH" "${args[@]}"
}

atomic_current_switch() {
  local expected="$1" target="$2"
  local args=(
    switch --role staging --release-root "$RELEASE_ROOT"
    --worker-uid "$WORKER_UID" --worker-gid "$WORKER_GID"
    --expected "$expected" --target "$target"
  )
  if [ "$TEST_MODE" = 1 ]; then args+=(--allow-test-owner); fi
  "$PYTHON_BIN" "$SELECTOR_SWITCH" "${args[@]}" >/dev/null
}

sha256_safe_file() {
  "$NODE_BIN" - "$1" <<'NODE'
const crypto=require('crypto');const fs=require('fs');const file=process.argv[2];
const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));
try{
 const before=fs.fstatSync(fd),body=fs.readFileSync(fd),after=fs.fstatSync(fd);
 if(!before.isFile()||before.nlink!==1||before.dev!==after.dev||before.ino!==after.ino
  ||before.size!==after.size||before.mtimeMs!==after.mtimeMs)process.exit(1);
 process.stdout.write(crypto.createHash('sha256').update(body).digest('hex'));
}finally{fs.closeSync(fd);}
NODE
}

recovery_runtime_fields() {
  local runtime="$1"
  "$NODE_BIN" - "$runtime" "$BASE" "$WORKER_GID" "$TEST_MODE" <<'NODE'
const crypto=require('crypto');const fs=require('fs');const path=require('path');
const [runtime,base,workerGidRaw,testMode]=process.argv.slice(2);
const workerGid=Number(workerGidRaw),rootUid=testMode==='1'?process.getuid():0;
if(path.dirname(runtime)!==path.join(base,'releases'))process.exit(1);
const runtimeStat=fs.lstatSync(runtime);
if(!runtimeStat.isDirectory()||runtimeStat.isSymbolicLink()
 ||fs.realpathSync.native(runtime)!==runtime||runtimeStat.uid!==rootUid
 ||runtimeStat.gid!==workerGid||(runtimeStat.mode&0o7777)!==0o550)process.exit(1);
const markerPath=path.join(runtime,'.complete.json');
const fd=fs.openSync(markerPath,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));
try{
 const before=fs.fstatSync(fd),body=fs.readFileSync(fd),after=fs.fstatSync(fd);
 if(!before.isFile()||before.nlink!==1||before.dev!==after.dev||before.ino!==after.ino
  ||before.size!==after.size||before.mtimeMs!==after.mtimeMs)process.exit(1);
 const marker=JSON.parse(body);
 if(!/^[a-f0-9]{40}$/u.test(marker.runtimeSha||'')
  ||!/^[a-f0-9]{64}$/u.test(marker.artifactDigest||''))process.exit(1);
 process.stdout.write(`${marker.runtimeSha}\t${marker.artifactDigest}\t${
  crypto.createHash('sha256').update(body).digest('hex')}\n`);
}finally{fs.closeSync(fd);}
NODE
}

transaction_journal_path() {
  printf '%s/staging/%s.transaction.json' "$STATE_ROOT" "$1"
}

write_initial_transaction() {
  local journal="$1" predecessor="$2" predecessor_sha="$3"
  local predecessor_artifact="$4" predecessor_marker_sha="$5"
  local binding_sha="$6" recovery_sha="$7"
  "$NODE_BIN" - "$journal" "$REQUEST_ID" "$BASE" "$RUNTIME" "$RUNTIME_SHA" \
    "$ARTIFACT_DIGEST" "$predecessor" "$predecessor_sha" \
    "$predecessor_artifact" "$predecessor_marker_sha" "$binding_sha" \
    "$recovery_sha" "$TEST_MODE" <<'NODE'
const crypto=require('crypto');const fs=require('fs');const path=require('path');
const [journal,requestId,base,candidateRuntime,candidateSha,artifactDigest,
 predecessorRuntime,predecessorSha,predecessorArtifactDigest,
 predecessorMarkerSha256,bindingSha256,recoverySha256,testMode]=process.argv.slice(2);
if(fs.lstatSync(journal,{throwIfNoEntry:false}))process.exit(1);
const value={schema:'nexus.staging-attestation-transaction.v1',requestId,
 phase:'prepared',base,candidateRuntime,candidateSha,artifactDigest,
 predecessorRuntime,predecessorSha,predecessorArtifactDigest,
 predecessorMarkerSha256,bindingSha256,recoverySha256,
 preparedAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
const parent=path.dirname(journal);
for(let attempt=0;attempt<32;attempt++){
 const temporary=`${journal}.next.${crypto.randomBytes(16).toString('hex')}`;
 try{
  const fd=fs.openSync(temporary,'wx',0o600);
  try{fs.writeFileSync(fd,`${JSON.stringify(value,null,2)}\n`);fs.fsyncSync(fd);}
  finally{fs.closeSync(fd);}
  fs.renameSync(temporary,journal);
  const directory=fs.openSync(parent,'r');try{fs.fsyncSync(directory);}finally{fs.closeSync(directory);}
  process.exit(0);
 }catch(error){
  try{fs.unlinkSync(temporary);}catch{}
  if(error?.code!=='EEXIST')throw error;
 }
}
process.exit(1);
NODE
  chmod 600 "$journal"
  if [ "$TEST_MODE" != 1 ]; then chown root:root "$journal"; fi
}

read_transaction_fields() {
  local journal="$1" binding_sha="$2" recovery_sha="$3"
  "$NODE_BIN" - "$journal" "$REQUEST_ID" "$BASE" "$RUNTIME" "$RUNTIME_SHA" \
    "$ARTIFACT_DIGEST" "$binding_sha" "$recovery_sha" "$TEST_MODE" <<'NODE'
const fs=require('fs');const path=require('path');
const [journal,requestId,base,candidateRuntime,candidateSha,artifactDigest,
 bindingSha256,recoverySha256,testMode]=process.argv.slice(2);
const fd=fs.openSync(journal,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));
try{
 const before=fs.fstatSync(fd),body=fs.readFileSync(fd),after=fs.fstatSync(fd);
 const rootUid=testMode==='1'?process.getuid():0,rootGid=testMode==='1'?process.getgid():0;
 if(!before.isFile()||before.nlink!==1||(before.mode&0o7777)!==0o600
  ||before.uid!==rootUid||before.gid!==rootGid||before.dev!==after.dev
  ||before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs)process.exit(1);
 const x=JSON.parse(body);
 const phases=new Set(['prepared','selector_switched','candidate_started',
  'readiness_passed','completed','recovered']);
 if(x.schema!=='nexus.staging-attestation-transaction.v1'||x.requestId!==requestId
  ||x.base!==base||x.candidateRuntime!==candidateRuntime||x.candidateSha!==candidateSha
  ||x.artifactDigest!==artifactDigest||x.bindingSha256!==bindingSha256
  ||x.recoverySha256!==recoverySha256||!phases.has(x.phase)
  ||path.dirname(x.predecessorRuntime)!==path.join(base,'releases')
  ||x.predecessorRuntime===candidateRuntime
  ||!/^[a-f0-9]{40}$/u.test(x.predecessorSha||'')
  ||!/^[a-f0-9]{64}$/u.test(x.predecessorArtifactDigest||'')
  ||!/^[a-f0-9]{64}$/u.test(x.predecessorMarkerSha256||''))process.exit(1);
 process.stdout.write([x.phase,x.predecessorRuntime,x.predecessorSha,
  x.predecessorArtifactDigest,x.predecessorMarkerSha256].join('\t'));
}finally{fs.closeSync(fd);}
NODE
}

publish_terminal_pm2_authority() {
  local result
  # Boot reconciliation defers publication until both roles have reached their
  # exact terminal state under the shared governed temporary daemon.
  [ ! -f "$STATE_ROOT/boot-recovery-in-progress.v1.json" ] || return 0
  if [ "$TEST_MODE" = 1 ] && [ -z "${NEXUS_PROMOTION_BOOT_HEALTH_BIN:-}" ]; then
    return 0
  fi
  [ -x "$BOOT_HEALTH_BIN" ] || {
    echo "root PM2 authority publisher is unavailable" >&2
    return 1
  }
  result="$("$BOOT_HEALTH_BIN" publish-current)"
  "$NODE_BIN" -e '
const x=JSON.parse(process.argv[1]);
if(x.schema!=="nexus.pm2-resurrection-authority.v2"
 ||!/^[a-f0-9]{64}$/u.test(x.dumpSha256||""))process.exit(1);
' "$result"
}

write_transaction_phase() {
  local journal="$1" phase="$2" evidence_sha="${3:-}"
  case "$phase" in completed|recovered) publish_terminal_pm2_authority ;; esac
  "$NODE_BIN" - "$journal" "$phase" "$evidence_sha" <<'NODE'
const crypto=require('crypto');const fs=require('fs');const path=require('path');
const [journal,phase,evidenceSha256]=process.argv.slice(2);
const transitions={
 prepared:new Set(['prepared','selector_switched','recovered']),
 selector_switched:new Set(['selector_switched','candidate_started','recovered']),
 candidate_started:new Set(['candidate_started','readiness_passed','recovered']),
 readiness_passed:new Set(['readiness_passed','completed','recovered']),
 completed:new Set(['completed','recovered']),recovered:new Set(['recovered']),
};
const current=JSON.parse(fs.readFileSync(journal,'utf8'));
if(current.schema!=='nexus.staging-attestation-transaction.v1'
 ||!transitions[current.phase]?.has(phase)
 ||(phase==='completed'&&!/^[a-f0-9]{64}$/u.test(evidenceSha256||'')))process.exit(1);
const value={...current,phase,updatedAt:new Date().toISOString(),
 ...(phase==='completed'?{publishedEvidenceSha256:evidenceSha256}:{})};
for(let attempt=0;attempt<32;attempt++){
 const temporary=`${journal}.next.${crypto.randomBytes(16).toString('hex')}`;
 try{
  const fd=fs.openSync(temporary,'wx',0o600);
  try{fs.writeFileSync(fd,`${JSON.stringify(value,null,2)}\n`);fs.fsyncSync(fd);}
  finally{fs.closeSync(fd);}
  fs.renameSync(temporary,journal);
  const directory=fs.openSync(path.dirname(journal),'r');
  try{fs.fsyncSync(directory);}finally{fs.closeSync(directory);}
  process.exit(0);
 }catch(error){
  try{fs.unlinkSync(temporary);}catch{}
  if(error?.code!=='EEXIST')throw error;
 }
}
process.exit(1);
NODE
  chmod 600 "$journal"
  if [ "$TEST_MODE" != 1 ]; then chown root:root "$journal"; fi
}

STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
READINESS_TEMP=""
TRANSACTION_JOURNAL=""
PREVIOUS_RUNTIME=""
PREVIOUS_SHA=""
PREVIOUS_ARTIFACT_DIGEST=""
PREVIOUS_MARKER_SHA256=""
TRANSACTION_PHASE=""
RESUMED_EXACT_ACTIVE=false
SWITCHED=false
SWITCHED_AT=""

verify_predecessor_from_journal() {
  local observed_sha observed_artifact observed_marker
  IFS=$'\t' read -r observed_sha observed_artifact observed_marker \
    < <(recovery_runtime_fields "$PREVIOUS_RUNTIME")
  [ "$observed_sha" = "$PREVIOUS_SHA" ] \
    && [ "$observed_artifact" = "$PREVIOUS_ARTIFACT_DIGEST" ] \
    && [ "$observed_marker" = "$PREVIOUS_MARKER_SHA256" ] || {
    echo "exact staging predecessor changed after recovery was armed" >&2
    return 1
  }
}

prove_predecessor_healthy() {
  local recovery_readiness
  recovery_readiness="$(mktemp "$STATE_ROOT/staging/.${REQUEST_ID}.recovery-readiness.XXXXXXXX")"
  chmod 600 "$recovery_readiness"
  if [ "$TEST_MODE" != 1 ]; then chown root:root "$recovery_readiness"; fi
  exec 7<>"$recovery_readiness"
  if ! run_worker "$TIMEOUT_BIN" --signal=TERM --kill-after=5s 60s \
      "$BASH_BIN" "$PREVIOUS_RUNTIME/scripts/remote-release-readiness.sh" \
      --role staging --base-dir "$BASE" --release-dir "$PREVIOUS_RUNTIME" \
      --runtime-sha "$PREVIOUS_SHA" --pm2-bin "$PM2_RESOLVED" \
      --node-bin "$NODE_BIN" --curl-bin "$CURL_BIN" --output-fd 7 \
      --stability-seconds 0 --readiness-attempts 8 --poll-seconds 1 >&2; then
    exec 7>&-
    rm -f -- "$recovery_readiness"
    return 1
  fi
  exec 7>&-
  if ! current_selector_identity "$PREVIOUS_RUNTIME" >/dev/null; then
    rm -f -- "$recovery_readiness"
    return 1
  fi
  rm -f -- "$recovery_readiness"
}

restore_previous() {
  verify_predecessor_from_journal
  delete_staging_apps
  atomic_current_switch "$RUNTIME" "$PREVIOUS_RUNTIME"
  run_worker_release "$PREVIOUS_RUNTIME" "$PREVIOUS_SHA" \
    "$TIMEOUT_BIN" --signal=TERM --kill-after=3s 20s \
    "$PM2_RESOLVED" start "$PREVIOUS_RUNTIME/ecosystem.release.config.js" \
      --update-env >/dev/null
  run_worker "$TIMEOUT_BIN" --signal=TERM --kill-after=2s 10s \
    "$PM2_RESOLVED" save >/dev/null
  prove_predecessor_healthy
  write_transaction_phase "$TRANSACTION_JOURNAL" recovered
}

rollback_on_failure() {
  local status=$? recovery_status=0
  trap - EXIT INT TERM HUP
  if [ -n "$READINESS_TEMP" ]; then rm -f -- "$READINESS_TEMP"; fi
  if [ "$status" -ne 0 ] && [ -n "$TRANSACTION_JOURNAL" ] \
      && [ -f "$TRANSACTION_JOURNAL" ]; then
    echo "root staging broker failed; restoring and proving the exact predecessor" >&2
    set +e
    (
      set -euo pipefail
      restore_previous
    )
    recovery_status=$?
    set -e
    if [ "$recovery_status" -ne 0 ]; then
      echo "automatic staging predecessor restore failed; durable journal retained" >&2
    fi
  fi
  exit "$status"
}

load_recovery_journal() {
  local journal="$1"
  "$NODE_BIN" - "$journal" "$STATE_ROOT" "$RELEASE_ROOT" "$TEST_MODE" <<'NODE'
const fs=require('fs');const path=require('path');
const [journal,stateRoot,releaseRoot,testMode]=process.argv.slice(2);
const match=path.basename(journal).match(
 /^([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.transaction\.json$/u);
const fd=fs.openSync(journal,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));
try{
 const before=fs.fstatSync(fd),body=fs.readFileSync(fd),after=fs.fstatSync(fd);
 const rootUid=testMode==='1'?process.getuid():0,rootGid=testMode==='1'?process.getgid():0;
 const x=JSON.parse(body),base=path.join(releaseRoot,'staging');
 if(!match||path.dirname(journal)!==path.join(stateRoot,'staging')
  ||!before.isFile()||before.nlink!==1||(before.mode&0o7777)!==0o600
  ||before.uid!==rootUid||before.gid!==rootGid||before.dev!==after.dev
  ||before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs
  ||x.schema!=='nexus.staging-attestation-transaction.v1'||x.requestId!==match[1]
  ||x.base!==base||path.dirname(x.candidateRuntime)!==path.join(base,'releases')
  ||path.dirname(x.predecessorRuntime)!==path.join(base,'releases')
  ||x.candidateRuntime===x.predecessorRuntime
  ||!/^[a-f0-9]{40}$/u.test(x.candidateSha||'')
  ||!/^[a-f0-9]{64}$/u.test(x.artifactDigest||'')
  ||!/^[a-f0-9]{40}$/u.test(x.predecessorSha||'')
  ||!/^[a-f0-9]{64}$/u.test(x.predecessorArtifactDigest||'')
  ||!/^[a-f0-9]{64}$/u.test(x.predecessorMarkerSha256||'')
  ||!new Set(['prepared','selector_switched','candidate_started',
   'readiness_passed','completed','recovered']).has(x.phase))process.exit(1);
 process.stdout.write([x.requestId,x.phase,x.base,x.candidateRuntime,x.candidateSha,
  x.artifactDigest,x.predecessorRuntime,x.predecessorSha,
  x.predecessorArtifactDigest,x.predecessorMarkerSha256].join('\t'));
}finally{fs.closeSync(fd);}
NODE
}

finalize_staging_transaction() {
  local journal evidence fields candidate_sha evidence_sha
  journal="$(transaction_journal_path "$REQUEST_ID")"
  evidence="$STATE_ROOT/staging/$REQUEST_ID.evidence.json"
  [ -f "$journal" ] && [ ! -L "$journal" ] \
    && [ -f "$evidence" ] && [ ! -L "$evidence" ] || {
    echo "staging transaction cannot finalize without root journal and evidence" >&2
    return 1
  }
  fields="$(load_recovery_journal "$journal")"
  IFS=$'\t' read -r REQUEST_ID TRANSACTION_PHASE BASE RUNTIME candidate_sha \
    ARTIFACT_DIGEST PREVIOUS_RUNTIME PREVIOUS_SHA PREVIOUS_ARTIFACT_DIGEST \
    PREVIOUS_MARKER_SHA256 <<<"$fields"
  RUNTIME_SHA="$candidate_sha"
  TRANSACTION_JOURNAL="$journal"
  case "$TRANSACTION_PHASE" in
    readiness_passed|completed) ;;
    *) echo "staging transaction is not publication-ready" >&2; return 1 ;;
  esac
  verify_predecessor_from_journal
  current_selector_identity "$RUNTIME" >/dev/null
  evidence_sha="$("$NODE_BIN" - "$journal" "$evidence" "$REQUEST_ID" "$RUNTIME" \
    "$RUNTIME_SHA" "$ARTIFACT_DIGEST" "$PREVIOUS_RUNTIME" "$TEST_MODE" <<'NODE'
const crypto=require('crypto');const fs=require('fs');
const [journalFile,evidenceFile,requestId,runtime,runtimeSha,artifactDigest,
 predecessorRuntime,testMode]=process.argv.slice(2);
const readSafe=(file)=>{
 const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));
 try{
  const before=fs.fstatSync(fd),body=fs.readFileSync(fd),after=fs.fstatSync(fd);
  const rootUid=testMode==='1'?process.getuid():0,rootGid=testMode==='1'?process.getgid():0;
  if(!before.isFile()||before.nlink!==1||(before.mode&0o7777)!==0o600
   ||before.uid!==rootUid||before.gid!==rootGid||before.dev!==after.dev
   ||before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs)process.exit(1);
  return {body,value:JSON.parse(body)};
 }finally{fs.closeSync(fd);}
};
const sha256=(body)=>crypto.createHash('sha256').update(body).digest('hex');
const journal=readSafe(journalFile),evidence=readSafe(evidenceFile);
const evidenceSha=sha256(evidence.body);
if(journal.value.schema!=='nexus.staging-attestation-transaction.v1'
 ||!['readiness_passed','completed'].includes(journal.value.phase)
 ||evidence.value.schema!=='nexus.root-staging-attestation-evidence.v1'
 ||evidence.value.requestId!==requestId||evidence.value.releaseDir!==runtime
 ||evidence.value.runtimeSha!==runtimeSha||evidence.value.artifactDigest!==artifactDigest
 ||evidence.value.currentSelector?.target!==runtime
 ||evidence.value.transaction?.previousRuntime!==predecessorRuntime
 ||(journal.value.phase==='readiness_passed'
   &&evidence.value.outputDigests?.transactionJournalSha256!==sha256(journal.body))
 ||(journal.value.phase==='completed'
   &&journal.value.publishedEvidenceSha256!==evidenceSha))process.exit(1);
process.stdout.write(evidenceSha);
NODE
)"
  if [ "$TRANSACTION_PHASE" = readiness_passed ]; then
    write_transaction_phase "$journal" completed "$evidence_sha"
  fi
}

recover_all_staging_transactions() {
  local journal fields started_at candidate_sha
  local -a unfinished=()
  shopt -s nullglob
  # Pass one is classification-only except for independently provable
  # publication finalization. Never mutate PM2 or current until every
  # root journal is safe and the unfinished set is unambiguous.
  for journal in "$STATE_ROOT/staging/"*.transaction.json; do
    fields="$(load_recovery_journal "$journal")"
    IFS=$'\t' read -r REQUEST_ID TRANSACTION_PHASE BASE RUNTIME candidate_sha \
      ARTIFACT_DIGEST PREVIOUS_RUNTIME PREVIOUS_SHA PREVIOUS_ARTIFACT_DIGEST \
      PREVIOUS_MARKER_SHA256 <<<"$fields"
    case "$TRANSACTION_PHASE" in
      completed|recovered) continue ;;
      readiness_passed)
        if [ -f "$STATE_ROOT/staging/$REQUEST_ID.evidence.json" ] \
            && [ ! -L "$STATE_ROOT/staging/$REQUEST_ID.evidence.json" ]; then
          finalize_staging_transaction
          continue
        fi
        ;;
    esac
    unfinished+=("$journal")
  done
  [ "${#unfinished[@]}" -le 1 ] || {
    echo "multiple unfinished staging transactions require owner review" >&2
    return 1
  }
  # Pass two may recover the sole exact transaction only after the complete
  # set was validated above.
  for journal in "${unfinished[@]}"; do
    fields="$(load_recovery_journal "$journal")"
    IFS=$'\t' read -r REQUEST_ID TRANSACTION_PHASE BASE RUNTIME candidate_sha \
      ARTIFACT_DIGEST PREVIOUS_RUNTIME PREVIOUS_SHA PREVIOUS_ARTIFACT_DIGEST \
      PREVIOUS_MARKER_SHA256 <<<"$fields"
    RUNTIME_SHA="$candidate_sha"
    TRANSACTION_JOURNAL="$journal"
    started_at="$(date +%s)"
    verify_predecessor_from_journal
    restore_previous
    [ "$(( $(date +%s) - started_at ))" -le 120 ] || {
      echo "staging boot recovery exceeded 120 seconds" >&2
      return 1
    }
  done
}

assert_no_other_unfinished_staging_transaction() {
  local journal fields observed_request observed_phase
  shopt -s nullglob
  for journal in "$STATE_ROOT/staging/"*.transaction.json; do
    fields="$(load_recovery_journal "$journal")"
    IFS=$'\t' read -r observed_request observed_phase _ <<<"$fields"
    case "$observed_phase" in completed|recovered) continue ;; esac
    [ "$observed_request" = "$REQUEST_ID" ] || {
      echo "another unfinished staging transaction requires recovery" >&2
      return 1
    }
  done
}

if [ "$MODE" = recover-all ]; then
  [ -d "$STATE_ROOT/staging" ] && [ ! -L "$STATE_ROOT/staging" ] || {
    echo "root staging transaction directory is unavailable" >&2
    exit 1
  }
  recover_all_staging_transactions
  printf '{"ok":true,"schema":"nexus.staging-attestation-recovery.v1","status":"reconciled"}\n'
  exit 0
fi
if [ "$MODE" = finalize ]; then
  finalize_staging_transaction
  printf '{"ok":true,"schema":"nexus.staging-attestation-transaction.v1","status":"completed","requestId":"%s"}\n' \
    "$REQUEST_ID"
  exit 0
fi

assert_no_other_unfinished_staging_transaction
verify_filesystem_identity
CURRENT="$(read_current)"
case "$CURRENT" in
  "$BASE"/releases/*) ;;
  *) echo "staging current target is outside the authoritative root" >&2; exit 1 ;;
esac

# The candidate is immutable and its exact dev/inode chain is verified before
# its script is opened. The root-controlled parent hierarchy prevents the
# service identity from renaming any pinned directory after this check.
run_worker "$BASH_BIN" "$RUNTIME/scripts/remote-release-preflight.sh" \
  --role staging --base-dir "$BASE" --release-dir "$RUNTIME" --node-bin "$NODE_BIN" >&2
PREFLIGHT_COMPLETED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
verify_filesystem_identity
CURRENT="$(read_current)"

TRANSACTION_JOURNAL="$(transaction_journal_path "$REQUEST_ID")"
BINDING_SHA256="$(sha256_safe_file "$BINDING")"
RECOVERY_SHA256="$(sha256_safe_file "$RECOVERY")"
if [ -e "$TRANSACTION_JOURNAL" ] || [ -L "$TRANSACTION_JOURNAL" ]; then
  [ -f "$TRANSACTION_JOURNAL" ] && [ ! -L "$TRANSACTION_JOURNAL" ] || {
    echo "staging transaction journal is unsafe" >&2
    exit 1
  }
  IFS=$'\t' read -r TRANSACTION_PHASE PREVIOUS_RUNTIME PREVIOUS_SHA \
    PREVIOUS_ARTIFACT_DIGEST PREVIOUS_MARKER_SHA256 \
    < <(read_transaction_fields "$TRANSACTION_JOURNAL" "$BINDING_SHA256" "$RECOVERY_SHA256")
  [ "$TRANSACTION_PHASE" != recovered ] || {
    echo "staging transaction was recovered; a new attestation request is required" >&2
    exit 75
  }
  verify_predecessor_from_journal
else
  [ "$CURRENT" != "$RUNTIME" ] || {
    echo "active staging candidate has no durable predecessor journal" >&2
    exit 75
  }
  PREVIOUS_RUNTIME="$CURRENT"
  IFS=$'\t' read -r PREVIOUS_SHA PREVIOUS_ARTIFACT_DIGEST PREVIOUS_MARKER_SHA256 \
    < <(recovery_runtime_fields "$PREVIOUS_RUNTIME")
  write_initial_transaction "$TRANSACTION_JOURNAL" "$PREVIOUS_RUNTIME" \
    "$PREVIOUS_SHA" "$PREVIOUS_ARTIFACT_DIGEST" "$PREVIOUS_MARKER_SHA256" \
    "$BINDING_SHA256" "$RECOVERY_SHA256"
  TRANSACTION_PHASE=prepared
fi

trap rollback_on_failure EXIT
case "$CURRENT" in
  "$RUNTIME")
    RESUMED_EXACT_ACTIVE=true
    SWITCHED=true
    if [ "$TRANSACTION_PHASE" = prepared ]; then
      write_transaction_phase "$TRANSACTION_JOURNAL" selector_switched
      TRANSACTION_PHASE=selector_switched
    fi
    ;;
  "$PREVIOUS_RUNTIME")
    [ "$TRANSACTION_PHASE" = prepared ] || {
      echo "staging selector was restored without a terminal recovery record" >&2
      exit 1
    }
    ;;
  *)
    echo "staging selector differs from both durable transaction endpoints" >&2
    exit 1
    ;;
esac

if [ "$RESUMED_EXACT_ACTIVE" = false ]; then
  SWITCHED=true
  atomic_current_switch "$PREVIOUS_RUNTIME" "$RUNTIME"
  SWITCHED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  write_transaction_phase "$TRANSACTION_JOURNAL" selector_switched
  TRANSACTION_PHASE=selector_switched
fi
if [ "$TRANSACTION_PHASE" = selector_switched ]; then
  delete_staging_apps
  run_worker_release "$RUNTIME" "$RUNTIME_SHA" \
    "$TIMEOUT_BIN" --signal=TERM --kill-after=3s 20s \
    "$PM2_RESOLVED" start "$RUNTIME/ecosystem.release.config.js" --update-env >&2
  write_transaction_phase "$TRANSACTION_JOURNAL" candidate_started
  TRANSACTION_PHASE=candidate_started
fi
verify_filesystem_identity
[ "$(read_current)" = "$RUNTIME" ] || {
  echo "staging current target drifted after the atomic switch" >&2
  exit 1
}

READINESS_TEMP="$(mktemp "$STATE_ROOT/staging/.${REQUEST_ID}.readiness.XXXXXXXX")"
chmod 600 "$READINESS_TEMP"
if [ "$TEST_MODE" != 1 ]; then chown root:root "$READINESS_TEMP"; fi
exec 8<>"$READINESS_TEMP"
run_worker "$BASH_BIN" "$RUNTIME/scripts/remote-release-readiness.sh" \
  --role staging --base-dir "$BASE" --release-dir "$RUNTIME" \
  --runtime-sha "$RUNTIME_SHA" --pm2-bin "$PM2_RESOLVED" \
  --node-bin "$NODE_BIN" --curl-bin "$CURL_BIN" --output-fd 8 \
  --stability-seconds "$STABILITY_SECONDS" >&2
exec 8>&-
READINESS_COMPLETED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
if [ "$TRANSACTION_PHASE" != completed ]; then
  write_transaction_phase "$TRANSACTION_JOURNAL" readiness_passed
  TRANSACTION_PHASE=readiness_passed
fi
verify_filesystem_identity
[ "$(read_current)" = "$RUNTIME" ] || {
  echo "staging current target drifted during readiness" >&2
  exit 1
}
run_worker "$TIMEOUT_BIN" --signal=TERM --kill-after=2s 10s \
  "$PM2_RESOLVED" save >/dev/null
CURRENT_SELECTOR="$(current_selector_identity "$RUNTIME")"

INSTALLED="$RUNTIME/.nexus-installed-runtime.json"
"$NODE_BIN" - "$OUTPUT" "$BINDING" "$RECOVERY" "$INSTALLED" "$READINESS_TEMP" \
  "$REQUEST_ID" "$RUNTIME" "$BASE" "$RUNTIME_SHA" "$ARTIFACT_DIGEST" \
  "$STARTED_AT" "$PREFLIGHT_COMPLETED_AT" "$SWITCHED_AT" \
  "$READINESS_COMPLETED_AT" "$RESUMED_EXACT_ACTIVE" "$PREVIOUS_RUNTIME" \
  "$CURRENT_SELECTOR" "$TRANSACTION_JOURNAL" <<'NODE'
const crypto=require('crypto');const fs=require('fs');
const [output,bindingPath,recoveryPath,installedPath,readinessPath,requestId,
 releaseDir,base,runtimeSha,artifactDigest,startedAt,preflightCompletedAt,
 switchedAt,readinessCompletedAt,resumedExactActive,previousRuntime,
 currentSelectorJson,transactionJournalPath]=process.argv.slice(2);
const canonical=(value)=>value===null||typeof value!=='object'?JSON.stringify(value)
 :Array.isArray(value)?`[${value.map(canonical).join(',')}]`
 :`{${Object.keys(value).sort().map((key)=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
const sha256=(value)=>crypto.createHash('sha256').update(value).digest('hex');
const readSafe=(file)=>{
 const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));
 try{
  const before=fs.fstatSync(fd);
  if(!before.isFile()||before.nlink!==1)throw new Error('root broker evidence input is unsafe');
  const body=fs.readFileSync(fd);
  const after=fs.fstatSync(fd);
  if(before.dev!==after.dev||before.ino!==after.ino||before.size!==after.size
   ||before.mtimeMs!==after.mtimeMs)throw new Error('root broker evidence input changed');
  return {body,value:JSON.parse(body)};
 }finally{fs.closeSync(fd);}
};
const binding=readSafe(bindingPath).value;
const recoveryRuntimeAttestation=readSafe(recoveryPath).value;
const installedRuntimeAttestation=readSafe(installedPath).value;
const readinessInput=readSafe(readinessPath);
const transactionJournalInput=readSafe(transactionJournalPath);
const remoteReadiness=readinessInput.value;
const currentSelector=JSON.parse(currentSelectorJson);
if(binding.schema!=='nexus.trusted-staging-runtime-binding.v1'
 ||binding.requestId!==requestId||binding.runtime!==releaseDir||binding.base!==base
 ||binding.runtimeSha!==runtimeSha||binding.artifactDigest!==artifactDigest
 ||installedRuntimeAttestation.schema!=='nexus.installed-runtime-attestation.v1'
 ||installedRuntimeAttestation.aggregateDigest!==binding.installedRuntimeDigest
 ||recoveryRuntimeAttestation.schema!=='nexus.recovery-runtime-attestation.v1'
 ||recoveryRuntimeAttestation.aggregateDigest!==binding.recoveryRuntimeDigest
 ||remoteReadiness.schema!=='nexus.release-readiness.v1'
 ||remoteReadiness.role!=='staging'||remoteReadiness.runtimeSha!==runtimeSha){
 throw new Error('root broker evidence identity is inconsistent');
}
const remoteIdentity={
 schema:'nexus.pm2-release-identity.v1',
 services:remoteReadiness.services.map(({
  name,status,cwd,executable,interpreter,releaseSha,sentryRelease,
 })=>({name,status,cwd,executable,interpreter,releaseSha,sentryRelease})),
};
const publishedAt=new Date().toISOString();
const record={
 schema:'nexus.root-staging-attestation-evidence.v1',
 requestId,runtimeSha,artifactDigest,releaseDir,base,
 binding,filesystem:binding.filesystem,currentSelector,
 installedRuntimeAttestation,recoveryRuntimeAttestation,
 remoteIdentity,remoteReadiness,
 outputDigests:{
  bindingSha256:sha256(canonical(binding)),
  installedRuntimeSha256:sha256(canonical(installedRuntimeAttestation)),
  recoveryRuntimeSha256:sha256(canonical(recoveryRuntimeAttestation)),
 pm2IdentitySha256:sha256(canonical(remoteIdentity)),
  currentSelectorSha256:sha256(canonical(currentSelector)),
  readinessSha256:sha256(readinessInput.body),
  transactionJournalSha256:sha256(transactionJournalInput.body),
 },
 transaction:{
  startedAt,preflightCompletedAt,switchedAt:switchedAt||null,
  readinessCompletedAt,publishedAt,resumedExactActive:resumedExactActive==='true',
  previousRuntime:previousRuntime||null,
 },
};
fs.writeFileSync(output,`${JSON.stringify(record,null,2)}\n`,{mode:0o600,flag:'w'});
const outputDescriptor=fs.openSync(output,'r');
try{fs.fsyncSync(outputDescriptor);}finally{fs.closeSync(outputDescriptor);}
NODE
chmod 600 "$OUTPUT"
if [ "$TEST_MODE" != 1 ]; then chown root:root "$OUTPUT"; fi
verify_filesystem_identity
[ "$(current_selector_identity "$RUNTIME")" = "$CURRENT_SELECTOR" ] || {
  echo "staging current selector identity drifted before evidence publication" >&2
  exit 1
}
rm -f -- "$READINESS_TEMP"
READINESS_TEMP=""
trap - EXIT INT TERM HUP
printf '%s\n' "$VERSION" >&2
