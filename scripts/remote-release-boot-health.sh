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
PHASE_A_RECEIPT="${NEXUS_LAYOUT_PHASE_A_RECEIPT:-$STATE_ROOT/layout-activation/phase-a-receipt.v1.json}"
LAYOUT_ATTESTATION="${NEXUS_PROMOTION_LAYOUT_ATTESTATION:-$STATE_ROOT/layout-migration.v1.json}"
V4_STATE_ROOT="${NEXUS_V4_PRELAYOUT_STATE_ROOT:-/var/lib/nexus-rollback-drill-v4-prelayout-staging}"
V4_INSTALL_RECEIPT="${NEXUS_V4_PRELAYOUT_INSTALL_RECEIPT:-$V4_STATE_ROOT/install-receipt.v1.json}"
V4_RETIRED_RECEIPT="${NEXUS_V4_PRELAYOUT_RETIRED_RECEIPT:-$V4_STATE_ROOT/install-receipt.retired.v1.json}"
V4_TRANSACTIONS="${NEXUS_V4_PRELAYOUT_TRANSACTIONS:-$V4_STATE_ROOT/transactions}"
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
case "$COMMAND" in
  preflight-temporary|start-temporary|verify-live-prelayout|publish-current|arm-current|prepare|postcheck)
    [ "$#" -eq 1 ] || {
      echo "release boot health command takes no additional arguments" >&2
      exit 64
    }
    ;;
  verify-pending-roles)
    [ "$#" -eq 3 ] \
      && [[ "${2:-}" =~ ^(layout|legacy|v4-prelayout)$ ]] \
      && [[ "${3:-}" =~ ^[a-f0-9]{64}$ ]] || {
      echo "verify-pending-roles requires a profile and exact pending SHA-256" >&2
      exit 64
    }
    ;;
  publish-current-profile)
    [ "$#" -eq 2 ] && [[ "${2:-}" =~ ^(layout|legacy)$ ]] || {
      echo "publish-current-profile requires layout or legacy" >&2
      exit 64
    }
    ;;
  *) echo "Usage: nexus-release-boot-health <preflight-temporary|start-temporary|verify-live-prelayout|publish-current|publish-current-profile PROFILE|arm-current|prepare|postcheck|verify-pending-roles PROFILE PENDING_SHA256>" >&2; exit 64 ;;
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
PM2_CLOSURE_DIGEST=""
PM2_NODE_SHA256=""
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
  read -r PM2_CLOSURE_ROOT PM2_ROOT PM2_CLOSURE_DIGEST PM2_NODE_SHA256 \
    < <("$NODE_BIN" - "$PM2_ATTESTATION" \
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
 process.stdout.write(`${x.closureRoot}\t${path.join(x.closureRoot,'node_modules/pm2')}\t${
  x.closureDigest}\t${x.node.sha256}\n`);
}finally{fs.closeSync(fd);}
NODE
  )
  [ -n "$PM2_CLOSURE_ROOT" ] && [ -n "$PM2_ROOT" ] \
    && [[ "$PM2_CLOSURE_DIGEST" =~ ^[a-f0-9]{64}$ ]] \
    && [[ "$PM2_NODE_SHA256" =~ ^[a-f0-9]{64}$ ]] || {
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

boot_role_evidence() {
  local profile="$1" role="$2" base
  case "$profile:$role" in
    layout:production) base="$RELEASE_ROOT/production" ;;
    layout:staging) base="$RELEASE_ROOT/staging" ;;
    legacy:production|v4-prelayout:production) base="$OLD_PRODUCTION" ;;
    legacy:staging|v4-prelayout:staging) base="$OLD_STAGING" ;;
    *)
      echo "boot release role profile is invalid" >&2
      return 64
      ;;
  esac
  "$NODE_BIN" - "$profile" "$role" "$base" "$WORKER_UID" "$WORKER_GID" \
    "$TEST_MODE" "$LAYOUT_ATTESTATION" "$V4_INSTALL_RECEIPT" \
    "$V4_RETIRED_RECEIPT" "$PHASE_A_RECEIPT" "$V4_TRANSACTIONS" \
    "$RELEASE_ROOT" "$OLD_PRODUCTION" "$OLD_STAGING" <<'NODE'
const crypto=require('crypto');const fs=require('fs');const path=require('path');
const [profile,role,base,workerUidRaw,workerGidRaw,testMode,layoutFile,
 v4ReceiptFile,v4RetiredFile,phaseAFile,transactionsRoot,releaseRoot,
 oldProduction,oldStaging]=process.argv.slice(2);
const workerUid=Number(workerUidRaw),workerGid=Number(workerGidRaw);
const rootUid=testMode==='1'?process.getuid():0;
const rootGid=testMode==='1'?process.getgid():0;
const digest=(body)=>crypto.createHash('sha256').update(body).digest('hex');
const sha=/^[a-f0-9]{40}$/u,digestPattern=/^[a-f0-9]{64}$/u;
const requestPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const fail=()=>process.exit(1);
const readSafe=(file,{uid,gid,mode,maximum=4*1024*1024}={})=>{
 const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));
 try{
  const before=fs.fstatSync(fd),body=fs.readFileSync(fd),after=fs.fstatSync(fd);
  if(!before.isFile()||before.nlink!==1||before.size<=0||before.size>maximum
   ||(uid!==undefined&&before.uid!==uid)||(gid!==undefined&&before.gid!==gid)
   ||(mode!==undefined&&(before.mode&0o7777)!==mode)
   ||before.dev!==after.dev||before.ino!==after.ino||before.size!==after.size
   ||before.mtimeMs!==after.mtimeMs)fail();
  return {body,value:JSON.parse(body),stat:before};
 }finally{fs.closeSync(fd);}
};
const directory=(directoryPath,uid,gid,mode)=>{
 const before=fs.lstatSync(directoryPath);
 if(!before.isDirectory()||before.isSymbolicLink()
  ||fs.realpathSync.native(directoryPath)!==directoryPath
  ||before.uid!==uid||before.gid!==gid||(before.mode&0o7777)!==mode)fail();
 return before;
};
let sealedEntryCount=0;
const assertSealedTree=(directoryPath)=>{
 const observed=fs.lstatSync(directoryPath);
 if(!observed.isDirectory()||observed.isSymbolicLink()
  ||observed.uid!==rootUid||observed.gid!==rootGid
  ||(observed.mode&0o7777)!==0o555)fail();
 for(const name of fs.readdirSync(directoryPath).sort()){
  if(name===''||name==='.'||name==='..')fail();
  const absolute=path.join(directoryPath,name),entry=fs.lstatSync(absolute);
  sealedEntryCount+=1;if(sealedEntryCount>500000)fail();
  if(entry.uid!==rootUid||entry.gid!==rootGid)fail();
  if(entry.isSymbolicLink())continue;
  if(entry.isDirectory()){assertSealedTree(absolute);continue;}
  if(!entry.isFile()||entry.nlink!==1
   ||(entry.mode&0o7777)!==((entry.mode&0o111)!==0?0o555:0o444))fail();
 }
};
let authoritySha256=null;
if(profile==='layout'){
 const authority=readSafe(layoutFile,{uid:rootUid,gid:rootGid,mode:0o600});
 if(authority.value.schema!=='nexus.release-layout-migration.v1'
  ||authority.value.phase!=='passed'||authority.value.releaseRoot!==releaseRoot
  ||authority.value.productionBase!==path.join(releaseRoot,'production')
  ||authority.value.stagingBase!==path.join(releaseRoot,'staging')
  ||authority.value.previous?.production!==oldProduction
  ||authority.value.previous?.staging!==oldStaging)fail();
 authoritySha256=digest(authority.body);
}else if(profile==='v4-prelayout'){
 if(fs.existsSync(v4RetiredFile))fail();
 const receipt=readSafe(v4ReceiptFile,{uid:rootUid,gid:rootGid,mode:0o600});
 const phaseA=readSafe(phaseAFile,{uid:rootUid,gid:rootGid,mode:0o600});
 if(receipt.value.schema!=='nexus.rollback-drill-v4-prelayout-staging-install-receipt.v1'
  ||receipt.value.status!=='active'||receipt.value.promotionAllowed!==false
  ||receipt.value.control?.version!=='nexus-release-promotion-control.v4'
  ||receipt.value.phaseA?.sourceSha!==phaseA.value.sourceSha
  ||receipt.value.phaseA?.archiveSha256!==phaseA.value.sourceArchiveSha256
  ||receipt.value.phaseA?.receiptSha256!==digest(phaseA.body)
  ||phaseA.value.schema!=='nexus.release-layout-phase-a-receipt.v1'
  ||phaseA.value.status!=='completed'||phaseA.value.phaseARecoveryGuard!==true)fail();
 authoritySha256=digest(receipt.body);
}else if(profile!=='legacy')fail();

const releases=path.join(base,'releases');
let baseUid,baseGid,baseMode,releasesUid,releasesGid,releasesMode;
if(profile==='layout'){
 baseUid=rootUid;baseGid=workerGid;baseMode=0o1770;
 releasesUid=rootUid;releasesGid=workerGid;releasesMode=0o750;
}else if(profile==='v4-prelayout'&&role==='staging'){
 baseUid=rootUid;baseGid=rootGid;baseMode=0o755;
 releasesUid=rootUid;releasesGid=rootGid;releasesMode=0o755;
}else{
 baseUid=workerUid;baseGid=workerGid;baseMode=0o755;
 releasesUid=workerUid;releasesGid=workerGid;
 releasesMode=role==='production'?0o700:0o775;
}
directory(base,baseUid,baseGid,baseMode);
directory(releases,releasesUid,releasesGid,releasesMode);
const selectorPath=path.join(base,'current');
const selectorBefore=fs.lstatSync(selectorPath);
if(!selectorBefore.isSymbolicLink()||selectorBefore.nlink!==1
 ||(testMode!=='1'&&(selectorBefore.mode&0o7777)!==0o777))fail();
const runtime=fs.readlinkSync(selectorPath);
if(runtime===releases||path.dirname(runtime)!==releases
 ||fs.realpathSync.native(selectorPath)!==runtime)fail();
const runtimeBefore=fs.lstatSync(runtime);
if(!runtimeBefore.isDirectory()||runtimeBefore.isSymbolicLink()
 ||fs.realpathSync.native(runtime)!==runtime)fail();

let roleProfile,entryUid,entryGid,runtimeMode,markerMode;
let matchingRecoveries=[],matchingCompletion=null;
if(profile==='layout'){
 if(selectorBefore.uid!==rootUid||selectorBefore.gid!==rootGid)fail();
 roleProfile='layout';entryUid=rootUid;entryGid=workerGid;
 runtimeMode=0o550;markerMode=0o440;
}else if(profile==='legacy'||role==='production'){
 if(selectorBefore.uid!==workerUid||selectorBefore.gid!==workerGid)fail();
 roleProfile='legacy-worker';entryUid=workerUid;entryGid=workerGid;
 runtimeMode=0o700;markerMode=0o600;
}else{
 const transactionsStat=fs.lstatSync(transactionsRoot);
 if(!transactionsStat.isDirectory()||transactionsStat.isSymbolicLink()
  ||fs.realpathSync.native(transactionsRoot)!==transactionsRoot
  ||transactionsStat.uid!==rootUid||transactionsStat.gid!==rootGid
  ||(transactionsStat.mode&0o7777)!==0o700)fail();
 for(const entry of fs.readdirSync(transactionsRoot,{withFileTypes:true})
   .sort((left,right)=>left.name.localeCompare(right.name))){
  if(!entry.isDirectory()||entry.isSymbolicLink()||!requestPattern.test(entry.name))fail();
  const journalPath=path.join(transactionsRoot,entry.name,'journal.json');
  const journal=readSafe(journalPath,{uid:rootUid,gid:rootGid,mode:0o600});
  const value=journal.value;
  if(value.schema!=='nexus.rollback-drill-legacy-staging-journal.v1'
   ||value.requestId!==entry.name
   ||!new Set(['completed','recovered']).has(value.phase))fail();
  if(value.phase==='recovered'&&value.predecessor?.runtime===runtime){
   matchingRecoveries.push({requestId:entry.name,
    journalSha256:digest(journal.body)});
  }
  if(value.phase==='completed'&&value.candidateRuntime===runtime){
   if(matchingCompletion)fail();
   const evidencePath=path.join(transactionsRoot,entry.name,'evidence.json');
   const evidence=readSafe(evidencePath,{uid:rootUid,gid:rootGid,mode:0o600});
   if(value.evidenceSha256!==digest(evidence.body)
   ||evidence.value.schema!=='nexus.rollback-drill-legacy-staging-evidence.v1'
    ||evidence.value.status!=='completed'||evidence.value.promotionAllowed!==false
    ||evidence.value.requestId!==entry.name||evidence.value.releaseDir!==runtime
    ||evidence.value.currentSelector?.target!==runtime
    ||!sha.test(evidence.value.runtimeSha||'')
    ||!digestPattern.test(evidence.value.artifactDigest||''))fail();
   matchingCompletion={requestId:entry.name,phase:value.phase,
    journalSha256:digest(journal.body),evidenceSha256:digest(evidence.body),
    runtimeSha:evidence.value.runtimeSha,
    artifactDigest:evidence.value.artifactDigest};
  }
 }
 const selectorIsRoot=selectorBefore.uid===rootUid&&selectorBefore.gid===rootGid;
 const selectorIsWorker=selectorBefore.uid===workerUid&&selectorBefore.gid===workerGid;
 const runtimeIsSealed=runtimeBefore.uid===rootUid&&runtimeBefore.gid===rootGid
  &&(runtimeBefore.mode&0o7777)===0o555;
 const runtimeIsWorker=runtimeBefore.uid===workerUid&&runtimeBefore.gid===workerGid
  &&(runtimeBefore.mode&0o7777)===0o700;
 if(runtimeIsSealed&&selectorIsRoot&&matchingCompletion){
  roleProfile='v4-prelayout-sealed';entryUid=rootUid;entryGid=rootGid;
  runtimeMode=0o555;markerMode=0o444;
 }else if(runtimeIsWorker&&selectorIsRoot&&matchingRecoveries.length>0){
  roleProfile='v4-prelayout-recovered';entryUid=workerUid;entryGid=workerGid;
  runtimeMode=0o700;markerMode=0o600;
 }else if(runtimeIsWorker&&selectorIsWorker){
  roleProfile='v4-prelayout-worker';entryUid=workerUid;entryGid=workerGid;
  runtimeMode=0o700;markerMode=0o600;
 }else fail();
}
if(runtimeBefore.uid!==entryUid||runtimeBefore.gid!==entryGid
 ||(runtimeBefore.mode&0o7777)!==runtimeMode)fail();
const marker=readSafe(path.join(runtime,'.complete.json'),{
 uid:entryUid,gid:entryGid,mode:markerMode,
});
const installed=readSafe(path.join(runtime,'.nexus-installed-runtime.json'),{
 uid:entryUid,gid:entryGid,mode:markerMode,
});
if(marker.value.schema!=='nexus.release-bundle.v1'
 ||!sha.test(marker.value.runtimeSha||'')
 ||!digestPattern.test(marker.value.artifactDigest||'')
 ||installed.value.schema!=='nexus.installed-runtime-attestation.v1'
 ||!digestPattern.test(installed.value.aggregateDigest||'')
 ||installed.value.identity?.runtimeSha!==marker.value.runtimeSha
 ||installed.value.identity?.artifactDigest!==marker.value.artifactDigest)fail();
if(roleProfile==='v4-prelayout-sealed'
 &&(matchingCompletion.runtimeSha!==marker.value.runtimeSha
  ||matchingCompletion.artifactDigest!==marker.value.artifactDigest))fail();
if(roleProfile==='v4-prelayout-sealed')assertSealedTree(runtime);
const selectorAfter=fs.lstatSync(selectorPath),runtimeAfter=fs.lstatSync(runtime);
for(const [before,after] of [[selectorBefore,selectorAfter],[runtimeBefore,runtimeAfter]]){
 if(before.dev!==after.dev||before.ino!==after.ino||before.uid!==after.uid
  ||before.gid!==after.gid||(before.mode&0o7777)!==(after.mode&0o7777)
  ||before.mtimeMs!==after.mtimeMs)fail();
}
if(fs.readlinkSync(selectorPath)!==runtime||fs.realpathSync.native(selectorPath)!==runtime)fail();
const statIdentity=(value)=>({dev:String(value.dev),ino:String(value.ino),
 uid:value.uid,gid:value.gid,mode:value.mode&0o7777});
const transaction=roleProfile==='v4-prelayout-sealed'
 ?matchingCompletion:roleProfile==='v4-prelayout-recovered'?{
   phase:'recovered',count:matchingRecoveries.length,
   aggregateSha256:digest(Buffer.from(JSON.stringify(matchingRecoveries))),
   journals:matchingRecoveries,
  }:null;
if(transaction){
 delete transaction.runtimeSha;
 delete transaction.artifactDigest;
}
process.stdout.write(JSON.stringify({
 schema:'nexus.release-boot-role.v1',role,profile:roleProfile,base,runtime,
 runtimeSha:marker.value.runtimeSha,artifactDigest:marker.value.artifactDigest,
 installedRuntimeDigest:installed.value.aggregateDigest,
 selector:statIdentity(selectorBefore),runtimeIdentity:statIdentity(runtimeBefore),
 markerSha256:digest(marker.body),installedAttestationSha256:digest(installed.body),
 authoritySha256,transaction,
}));
NODE
}

legacy_role_fields() {
  local role="$1" legacy authoritative
  if [ "$role" = production ]; then
    legacy="$OLD_PRODUCTION"; authoritative="$RELEASE_ROOT/production"
  else
    legacy="$OLD_STAGING"; authoritative="$RELEASE_ROOT/staging"
  fi
  "$NODE_BIN" - "$role" "$legacy" "$authoritative" "$WORKER_UID" \
    "$WORKER_GID" "$TEST_MODE" <<'NODE'
const crypto=require('crypto');const fs=require('fs');const path=require('path');
const [role,legacy,authoritative,workerUidRaw,workerGidRaw]=process.argv.slice(2);
const workerUid=Number(workerUidRaw),workerGid=Number(workerGidRaw);
const sha256=(body)=>crypto.createHash('sha256').update(body).digest('hex');
if(fs.lstatSync(path.join(authoritative,'current'),{throwIfNoEntry:false}))process.exit(1);
const base=fs.lstatSync(legacy);
if(!base.isDirectory()||base.isSymbolicLink()||fs.realpathSync.native(legacy)!==legacy
 ||base.uid!==workerUid||base.gid!==workerGid||(base.mode&0o7777)!==0o755)process.exit(1);
const selectorPath=path.join(legacy,'current'),selector=fs.lstatSync(selectorPath);
if(!selector.isSymbolicLink()||selector.uid!==workerUid||selector.gid!==workerGid
 ||selector.nlink!==1)process.exit(1);
const runtime=fs.readlinkSync(selectorPath);
if(path.dirname(runtime)!==path.join(legacy,'releases')
 ||fs.realpathSync.native(selectorPath)!==runtime)process.exit(1);
const runtimeStat=fs.lstatSync(runtime);
if(!runtimeStat.isDirectory()||runtimeStat.isSymbolicLink()
 ||fs.realpathSync.native(runtime)!==runtime||runtimeStat.uid!==workerUid
 ||runtimeStat.gid!==workerGid||(runtimeStat.mode&0o7777)!==0o700)process.exit(1);
const readSafe=(file,schema)=>{
 const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));
 try{
  const before=fs.fstatSync(fd),body=fs.readFileSync(fd),after=fs.fstatSync(fd);
  if(!before.isFile()||before.nlink!==1||before.uid!==workerUid
   ||before.gid!==workerGid||(before.mode&0o7777)!==0o600
   ||before.dev!==after.dev||before.ino!==after.ino||before.size!==after.size
   ||before.mtimeMs!==after.mtimeMs)process.exit(1);
  const value=JSON.parse(body);
  if(value.schema!==schema)process.exit(1);
  return {body,value,stat:before};
 }finally{fs.closeSync(fd);}
};
const marker=readSafe(path.join(runtime,'.complete.json'),'nexus.release-bundle.v1');
const installed=readSafe(path.join(runtime,'.nexus-installed-runtime.json'),
 'nexus.installed-runtime-attestation.v1');
if(!/^[a-f0-9]{40}$/u.test(marker.value.runtimeSha||'')
 ||!/^[a-f0-9]{64}$/u.test(marker.value.artifactDigest||'')
 ||!/^[a-f0-9]{64}$/u.test(installed.value.aggregateDigest||''))process.exit(1);
process.stdout.write([
 role,legacy,runtime,marker.value.runtimeSha,marker.value.artifactDigest,
 installed.value.aggregateDigest,String(selector.dev),String(selector.ino),
 String(runtimeStat.dev),String(runtimeStat.ino),sha256(marker.body),
 sha256(installed.body),
].join('\t'));
NODE
}

load_roles() {
  local profile
  profile="$(select_boot_profile)"
  load_roles_for_profile "$profile"
}

select_boot_profile() {
  if [ -e "$LAYOUT_ATTESTATION" ] || [ -L "$LAYOUT_ATTESTATION" ]; then
    [ -f "$LAYOUT_ATTESTATION" ] && [ ! -L "$LAYOUT_ATTESTATION" ] \
      || { echo "layout boot authority is unsafe" >&2; return 1; }
    printf '%s\n' layout
  elif [ -e "$V4_INSTALL_RECEIPT" ] || [ -L "$V4_INSTALL_RECEIPT" ]; then
    [ -f "$V4_INSTALL_RECEIPT" ] && [ ! -L "$V4_INSTALL_RECEIPT" ] \
      || { echo "v4 pre-layout boot authority is unsafe" >&2; return 1; }
    printf '%s\n' v4-prelayout
  elif [ -e "$V4_RETIRED_RECEIPT" ] || [ -L "$V4_RETIRED_RECEIPT" ]; then
    echo "retired v4 authority exists without terminal layout evidence" >&2
    return 1
  else
    printf '%s\n' legacy
  fi
}

load_roles_for_profile() {
  local profile="$1" fields
  case "$profile" in layout|legacy|v4-prelayout) ;; *)
    echo "boot release profile is invalid" >&2
    return 64
  esac
  PRODUCTION_ROLE_EVIDENCE="$(boot_role_evidence "$profile" production)"
  STAGING_ROLE_EVIDENCE="$(boot_role_evidence "$profile" staging)"
  fields="$("$NODE_BIN" -e '
for(const raw of process.argv.slice(1)){
 const value=JSON.parse(raw);
 if(value.schema!=="nexus.release-boot-role.v1")process.exit(1);
 process.stdout.write(`${value.base}\t${value.runtime}\t${value.runtimeSha}\n`);
}' "$PRODUCTION_ROLE_EVIDENCE" "$STAGING_ROLE_EVIDENCE")"
  IFS=$'\t' read -r PRODUCTION_BASE PRODUCTION_RUNTIME PRODUCTION_SHA \
    <<<"$(printf '%s\n' "$fields" | sed -n '1p')"
  IFS=$'\t' read -r STAGING_BASE STAGING_RUNTIME STAGING_SHA \
    <<<"$(printf '%s\n' "$fields" | sed -n '2p')"
  BOOT_ROLE_PROFILE="$profile"
}

load_legacy_roles() {
  local production_fields staging_fields
  production_fields="$(legacy_role_fields production)"
  staging_fields="$(legacy_role_fields staging)"
  IFS=$'\t' read -r _ PRODUCTION_BASE PRODUCTION_RUNTIME PRODUCTION_SHA \
    PRODUCTION_ARTIFACT_DIGEST PRODUCTION_INSTALLED_DIGEST _ \
    <<<"$production_fields"
  IFS=$'\t' read -r _ STAGING_BASE STAGING_RUNTIME STAGING_SHA \
    STAGING_ARTIFACT_DIGEST STAGING_INSTALLED_DIGEST _ \
    <<<"$staging_fields"
  LEGACY_PRODUCTION_FIELDS="$production_fields"
  LEGACY_STAGING_FIELDS="$staging_fields"
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

preflight_temporary_pm2() {
  local real_active real_pid temporary_active temporary_pid
  real_active="$("$SYSTEMCTL_BIN" show pm2-dominguez.service -p ActiveState --value)"
  real_pid="$("$SYSTEMCTL_BIN" show pm2-dominguez.service -p MainPID --value)"
  [ "$real_active" = inactive ] && [ "$real_pid" = 0 ] || {
    echo "real pm2-dominguez is not inactive before sequential boot recovery" >&2
    return 1
  }
  temporary_active="$("$SYSTEMCTL_BIN" show "$TEMP_PM2_UNIT" -p ActiveState --value)"
  temporary_pid="$("$SYSTEMCTL_BIN" show "$TEMP_PM2_UNIT" -p MainPID --value)"
  case "$temporary_active" in
    active) systemd_pm2_authority "$TEMP_PM2_UNIT" >/dev/null ;;
    inactive)
      [ "$temporary_pid" = 0 ] || {
        echo "inactive temporary recovery PM2 still has a MainPID" >&2
        return 1
      }
      assert_no_ungoverned_pm2_daemon
      ;;
    *)
      echo "temporary recovery PM2 is neither governed nor inactive" >&2
      return 1
      ;;
  esac
}

ensure_temporary_pm2() {
  preflight_temporary_pm2
  if [ "$("$SYSTEMCTL_BIN" show "$TEMP_PM2_UNIT" -p ActiveState --value)" = active ]; then
    return 0
  fi
  # Worker-owned PID/socket files are never signal authority. The root unit is
  # inactive here, so remove only the three pinned stale runtime names through
  # an already-open PM2_HOME descriptor.
  remove_untrusted_pm2_runtime_files
  "$SYSTEMCTL_BIN" start "$TEMP_PM2_UNIT"
  systemd_pm2_authority "$TEMP_PM2_UNIT" >/dev/null
}

validate_legacy_pm2_title() {
  local title="$1" pm2_home="$2"
  "$NODE_BIN" - "$title" "$pm2_home" <<'NODE'
const [title,pm2Home]=process.argv.slice(2);
const prefix=title.match(/^PM2 v\d+\.\d+\.\d+: God Daemon /u)?.[0];
if(!prefix||title.slice(prefix.length)!==`(${pm2Home})`)process.exit(1);
NODE
}

phase_a_service_snapshot() {
  local scratch cat_file show_file daemon_fields main_pid control_group output status
  local legacy_title
  scratch="$(mktemp -d "$STATE_ROOT/.prelayout-service.XXXXXXXX")"
  chmod 700 "$scratch"; root_own "$scratch"
  cat_file="$scratch/pm2-dominguez.service.cat"
  show_file="$scratch/pm2-dominguez.service.show"
  "$SYSTEMCTL_BIN" cat --no-pager pm2-dominguez.service >"$cat_file"
  "$SYSTEMCTL_BIN" show --no-pager pm2-dominguez.service \
    -p FragmentPath -p DropInPaths -p Type -p User -p Group \
    -p ExecStart -p ExecStartPost -p ExecStop -p Environment \
    -p Requires -p After -p Before -p ActiveState -p SubState \
    -p UnitFileState -p MainPID -p ExecMainStartTimestampMonotonic \
    -p NRestarts >"$show_file"
  chmod 600 "$cat_file" "$show_file"; root_own "$cat_file" "$show_file"
  daemon_fields="$(systemd_pm2_authority pm2-dominguez.service)"
  IFS=$'\t' read -r main_pid control_group <<<"$daemon_fields"
  legacy_title="$("$NODE_BIN" - "$main_pid" <<'NODE'
const fs=require('fs');const pid=process.argv[2];
const title=fs.readFileSync(`/proc/${pid}/cmdline`).toString('utf8').split('\0')[0];
if(!title)process.exit(1);process.stdout.write(title);
NODE
)"
  validate_legacy_pm2_title "$legacy_title" "$PM2_HOME"
  set +e
  output="$("$NODE_BIN" - "$PHASE_A_RECEIPT" "$cat_file" "$show_file" \
    "$main_pid" "$control_group" "$WORKER_USER" "$WORKER_UID" "$WORKER_GID" \
    "$PM2_HOME" "$TEST_MODE" "$legacy_title" <<'NODE'
const crypto=require('crypto');const fs=require('fs');const path=require('path');
const [receiptFile,catFile,showFile,mainPidRaw,controlGroup,workerUser,
 workerUidRaw,workerGidRaw,pm2Home,testMode,legacyTitle]=process.argv.slice(2);
const workerUid=Number(workerUidRaw),workerGid=Number(workerGidRaw);
const rootUid=testMode==='1'?process.getuid():0,rootGid=testMode==='1'?process.getgid():0;
const sha=(body)=>crypto.createHash('sha256').update(body).digest('hex');
const canonical=(value)=>value===null||typeof value!=='object'?JSON.stringify(value)
 :Array.isArray(value)?`[${value.map(canonical).join(',')}]`
 :`{${Object.keys(value).sort().map((key)=>`${JSON.stringify(key)}:${
  canonical(value[key])}`).join(',')}}`;
const readSafe=(file,uid,gid,mode)=>{
 const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));
 try{
  const before=fs.fstatSync(fd),body=fs.readFileSync(fd),after=fs.fstatSync(fd);
  if(!before.isFile()||before.nlink!==1||before.uid!==uid||before.gid!==gid
   ||(before.mode&0o7777)!==mode||before.dev!==after.dev||before.ino!==after.ino
   ||before.size!==after.size||before.mtimeMs!==after.mtimeMs)process.exit(1);
  return {body,value:JSON.parse(body)};
 }finally{fs.closeSync(fd);}
};
const receiptInput=readSafe(receiptFile,rootUid,rootGid,0o600);
const receipt=receiptInput.value,identity=receipt.existingServiceIdentity;
if(receipt.schema!=='nexus.release-layout-phase-a-receipt.v1'
 ||receipt.status!=='completed'||!/^[a-f0-9]{40}$/u.test(receipt.sourceSha||'')
 ||!/^[a-f0-9]{64}$/u.test(receipt.sourceArchiveSha256||'')
 ||!Number.isFinite(Date.parse(receipt.completedAt||''))
 ||identity?.runtimeUnchanged!==true
 ||!/^[a-f0-9]{64}$/u.test(identity.beforeSha256||'')
 ||!/^[a-f0-9]{64}$/u.test(identity.afterSha256||'')
 ||!/^[a-f0-9]{64}$/u.test(identity.runtimeSha256||'')
 ||receipt.phaseARecoveryGuard!==true||receipt.pm2Prerequisite?.verified!==true
 ||!/^[a-f0-9]{64}$/u.test(receipt.pm2Prerequisite?.evidenceSha256||'')
 ||!Array.isArray(receipt.installedAssets)
 ||JSON.stringify(receipt.prohibitedCommands)!==JSON.stringify(['run','recover-all']))
 process.exit(1);
const requiredAssets=new Set(['/usr/local/sbin/nexus-release-boot-health',
 '/usr/local/sbin/nexus-release-promotion-control',
 '/etc/systemd/system/nexus-release-promotion-recovery.service']);
for(const asset of receipt.installedAssets){
 if(typeof asset?.path!=='string'||!/^[a-f0-9]{64}$/u.test(asset.sha256||''))
  process.exit(1);
 const stat=fs.lstatSync(asset.path);
 if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1
  ||stat.uid!==rootUid||stat.gid!==rootGid
  ||sha(fs.readFileSync(asset.path))!==asset.sha256)process.exit(1);
 requiredAssets.delete(asset.path);
}
if(requiredAssets.size!==0)process.exit(1);
const catBody=fs.readFileSync(catFile),showBody=fs.readFileSync(showFile);
const expectedUnit=identity.afterUnits?.['pm2-dominguez.service'];
if(!expectedUnit||sha(catBody)!==expectedUnit.catSha256
 ||sha(showBody)!==expectedUnit.showSha256)process.exit(1);
const properties={};
for(const line of showBody.toString('utf8').split(/\n/u)){
 const separator=line.indexOf('=');if(separator>0)
  properties[line.slice(0,separator)]=line.slice(separator+1);
}
const runtime=Object.fromEntries([
 'Type','User','Group','ExecStart','ExecStartPost','ExecStop','Environment',
 'ActiveState','SubState','MainPID','ExecMainStartTimestampMonotonic','NRestarts',
].map((key)=>[key,properties[key]??'']));
const expectedRuntime=identity.runtime?.['pm2-dominguez.service'];
if(canonical(runtime)!==canonical(expectedRuntime)
 ||identity.runtimeSha256!==sha(canonical(identity.runtime))
 ||runtime.User!==workerUser||runtime.ActiveState!=='active'
 ||runtime.SubState!=='running'||runtime.MainPID!==mainPidRaw
 ||runtime.NRestarts!=='0'||!/^[1-9][0-9]*$/u.test(runtime.MainPID)
 ||!/^[1-9][0-9]*$/u.test(runtime.ExecMainStartTimestampMonotonic))
 process.exit(1);
const pid=runtime.MainPID,pidFile=path.join(pm2Home,'pm2.pid');
const pidFd=fs.openSync(pidFile,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));
try{
 const stat=fs.fstatSync(pidFd);
 if(!stat.isFile()||stat.nlink!==1||stat.uid!==workerUid||stat.gid!==workerGid
  ||(stat.mode&0o022)!==0
  ||fs.readFileSync(pidFd,'utf8').trim()!==pid)process.exit(1);
}finally{fs.closeSync(pidFd);}
const status=fs.readFileSync(`/proc/${pid}/status`,'utf8');
const uid=status.match(/^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$/mu);
if(!uid||uid.slice(1).some((value)=>Number(value)!==workerUid))process.exit(1);
const groups=fs.readFileSync(`/proc/${pid}/cgroup`,'utf8').trim().split('\n');
if(!groups.some((line)=>line.endsWith(controlGroup)))process.exit(1);
const command=fs.readFileSync(`/proc/${pid}/cmdline`).toString('utf8')
 .split('\0').filter(Boolean);
if(command.length<1||command[0]!==legacyTitle)process.exit(1);
const environment=new Map(fs.readFileSync(`/proc/${pid}/environ`).toString('utf8')
 .split('\0').filter(Boolean).map((entry)=>{
  const i=entry.indexOf('=');return [entry.slice(0,i),entry.slice(i+1)];
 }));
const forbidden=['NODE_OPTIONS','NODE_PATH','PM2_NODE_OPTIONS','PYTHONPATH',
 'PYTHONHOME','PYTHONINSPECT','PYTHONSTARTUP','PYTHONBREAKPOINT',
 'LD_PRELOAD','LD_LIBRARY_PATH'];
if(environment.get('PM2_HOME')!==pm2Home
 ||environment.has('PM2_DUMP_FILE_PATH')||environment.has('PM2_DAEMON_TITLE')
 ||forbidden.some((name)=>environment.has(name)))process.exit(1);
const procExecutable=`/proc/${pid}/exe`;
const executablePath=fs.realpathSync.native(procExecutable);
const legacyNodeRoot='/home/linuxbrew/.linuxbrew/Cellar/node';
const relativeExecutable=path.relative(legacyNodeRoot,executablePath).split(path.sep);
if(!path.isAbsolute(executablePath)||executablePath.startsWith(`${pm2Home}/`)
 ||relativeExecutable.length!==3
 ||!/^[0-9]+\.[0-9]+\.[0-9]+$/u.test(relativeExecutable[0])
 ||relativeExecutable[1]!=='bin'||relativeExecutable[2]!=='node')
 process.exit(1);
let current='/';
for(const component of executablePath.split('/').filter(Boolean).slice(0,-1)){
 current=path.join(current,component);
 const stat=fs.lstatSync(current);
 const rootOwned=current==='/'||current==='/home'||current==='/home/linuxbrew';
 if(!stat.isDirectory()||stat.isSymbolicLink()
  ||(rootOwned
   ?(stat.uid!==rootUid||stat.gid!==rootGid||(stat.mode&0o022)!==0)
   :(stat.uid!==workerUid||stat.gid!==workerGid||(stat.mode&0o002)!==0)))
  process.exit(1);
}
const executableFd=fs.openSync(procExecutable,fs.constants.O_RDONLY);
let executableStat,executableBody;
try{
 const before=fs.fstatSync(executableFd);
 const openedPath=fs.realpathSync.native(`/proc/self/fd/${executableFd}`);
 executableBody=fs.readFileSync(executableFd);
 const after=fs.fstatSync(executableFd);
 const currentPath=fs.realpathSync.native(procExecutable);
 if(openedPath!==executablePath||currentPath!==executablePath
  ||before.dev!==after.dev||before.ino!==after.ino
  ||before.size!==after.size||before.mtimeMs!==after.mtimeMs
  ||!before.isFile()||before.nlink!==1
  ||before.uid!==workerUid||before.gid!==workerGid
  ||(before.mode&0o7777)!==0o555)process.exit(1);
 executableStat=after;
}finally{fs.closeSync(executableFd);}
process.stdout.write(JSON.stringify({
 phaseA:{receiptSha256:sha(receiptInput.body),sourceSha:receipt.sourceSha,
  sourceArchiveSha256:receipt.sourceArchiveSha256,completedAt:receipt.completedAt,
  existingServiceRuntimeSha256:identity.runtimeSha256,
  pm2PrerequisiteEvidenceSha256:receipt.pm2Prerequisite.evidenceSha256,
  unitCatSha256:expectedUnit.catSha256,unitShowSha256:expectedUnit.showSha256},
 pm2Dominguez:{activeState:runtime.ActiveState,subState:runtime.SubState,
  mainPid:Number(pid),controlGroup,
  execMainStartTimestampMonotonic:Number(runtime.ExecMainStartTimestampMonotonic),
  nRestarts:Number(runtime.NRestarts),unitRuntimeSha256:sha(canonical(runtime)),
  executable:{classification:'worker_owned_legacy_observation',
   ancestryPolicy:'linuxbrew_worker_owned_no_world_write',
   path:executablePath,sha256:sha(executableBody),
   dev:String(executableStat.dev),ino:String(executableStat.ino),
   uid:executableStat.uid,gid:executableStat.gid,
   mode:executableStat.mode&0o7777}},
}));
NODE
)"
  status=$?
  set -e
  rm -f -- "$cat_file" "$show_file"
  rmdir -- "$scratch"
  [ "$status" -eq 0 ] || return "$status"
  printf '%s\n' "$output"
}

verify_live_prelayout() {
  local service_before service_after production_before production_after
  local staging_before staging_after
  [ "$("$SYSTEMCTL_BIN" show "$TEMP_PM2_UNIT" -p ActiveState --value)" = inactive ] \
    && [ "$("$SYSTEMCTL_BIN" show "$TEMP_PM2_UNIT" -p MainPID --value)" = 0 ] || {
    echo "temporary recovery PM2 is active during live pre-layout verification" >&2
    return 1
  }
  service_before="$(phase_a_service_snapshot)"
  load_legacy_roles
  production_before="$LEGACY_PRODUCTION_FIELDS"
  staging_before="$LEGACY_STAGING_FIELDS"
  verify_exact_pm2_stable
  role_readiness production "$PRODUCTION_BASE" "$PRODUCTION_RUNTIME" "$PRODUCTION_SHA"
  role_readiness staging "$STAGING_BASE" "$STAGING_RUNTIME" "$STAGING_SHA"
  verify_exact_pm2_stable
  production_after="$(legacy_role_fields production)"
  staging_after="$(legacy_role_fields staging)"
  service_after="$(phase_a_service_snapshot)"
  [ "$service_before" = "$service_after" ] \
    && [ "$production_before" = "$production_after" ] \
    && [ "$staging_before" = "$staging_after" ] || {
    echo "live pre-layout PM2 or release identity changed during verification" >&2
    return 1
  }
  "$NODE_BIN" - "$service_after" "$production_after" "$staging_after" \
    "$PM2_CLOSURE_DIGEST" "$PM2_NODE_SHA256" <<'NODE'
const [serviceRaw,production,staging,closureDigest,nodeSha256]=process.argv.slice(2);
const service=JSON.parse(serviceRaw);
const role=(raw)=>{
 const [name,base,runtime,runtimeSha,artifactDigest,installedRuntimeDigest,
  selectorDev,selectorIno,runtimeDev,runtimeIno,markerSha256,
  installedAttestationSha256]=raw.split('\t');
 return {name,base,runtime,runtimeSha,artifactDigest,installedRuntimeDigest,
  selector:{dev:selectorDev,ino:selectorIno},
  runtimeIdentity:{dev:runtimeDev,ino:runtimeIno},
  markerSha256,installedAttestationSha256};
};
process.stdout.write(`${JSON.stringify({
 schema:'nexus.release-live-prelayout-health-proof.v1',
 status:'verified_no_mutation',
 phaseA:service.phaseA,pm2Dominguez:service.pm2Dominguez,
 futureRootPm2Attestation:{closureDigest,nodeSha256},
 production:role(production),staging:role(staging),
 checks:['phase_a_service_receipt','legacy_real_systemd_daemon_identity',
  'future_root_pm2_attestation',
  'four_exact_pm2_apps_stable',
  'production_authenticated_readiness','staging_authenticated_readiness',
  'legacy_selector_and_runtime_identity_stable'],
 mutationOperations:[],verifiedAt:new Date().toISOString(),
},null,2)}\n`);
NODE
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
    "$BOOT_ROLE_PROFILE" "$PRODUCTION_ROLE_EVIDENCE" \
    "$STAGING_ROLE_EVIDENCE" <<'NODE'
const crypto=require('crypto');const fs=require('fs');
const [output,authorityRaw,recoveryFile,profile,productionRaw,
 stagingRaw]=process.argv.slice(2);
const authority=JSON.parse(authorityRaw);
const production=JSON.parse(productionRaw),staging=JSON.parse(stagingRaw);
const recoveryBody=fs.readFileSync(recoveryFile),recovery=JSON.parse(recoveryBody);
if(authority.schema!=='nexus.pm2-resurrection-authority.v2'
 ||!/^[a-f0-9]{64}$/u.test(authority.dumpSha256||''))process.exit(1);
if(!new Set(['layout','legacy','v4-prelayout']).has(profile)
 ||production.schema!=='nexus.release-boot-role.v1'||production.role!=='production'
 ||staging.schema!=='nexus.release-boot-role.v1'||staging.role!=='staging')process.exit(1);
if(recovery.schema!=='nexus.release-boot-recovery.v1'||recovery.status!=='in_progress'
 ||typeof recovery.bootId!=='string'||!recovery.bootId
 ||typeof recovery.outageStartedAt!=='string'||!Number.isFinite(Date.parse(recovery.outageStartedAt))
 ||!Number.isSafeInteger(recovery.outageStartedEpoch)
 ||!Number.isSafeInteger(recovery.recoveryDeadlineEpoch)
 ||recovery.recoveryDeadlineEpoch-recovery.outageStartedEpoch!==120
 ||!Number.isSafeInteger(recovery.outageStartedMonotonic)
 ||typeof recovery.outageBootId!=='string')process.exit(1);
fs.writeFileSync(output,`${JSON.stringify({
 schema:'nexus.release-boot-health-pending.v3',status:'pending',profile,
 production,staging,
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
  local expected_digest="${1:-}"
  "$NODE_BIN" - "$BOOT_PENDING" "$BOOT_ROLE_PROFILE" \
    "$PRODUCTION_ROLE_EVIDENCE" "$STAGING_ROLE_EVIDENCE" \
    "$expected_digest" "$TEST_MODE" <<'NODE'
const crypto=require('crypto');const fs=require('fs');
const [file,profile,productionRaw,stagingRaw,expectedDigest,testMode]=process.argv.slice(2);
const rootUid=testMode==='1'?process.getuid():0;
const rootGid=testMode==='1'?process.getgid():0;
const canonical=(value)=>value===null||typeof value!=='object'?JSON.stringify(value)
 :Array.isArray(value)?`[${value.map(canonical).join(',')}]`
 :`{${Object.keys(value).sort().map((key)=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
const exactKeys=['schema','status','profile','production','staging',
 'canonicalDumpSha256','pm2ClosureDigest','nodeSha256','recoveryAuthoritySha256',
 'bootId','outageBootId','outageStartedAt','outageStartedEpoch',
 'outageStartedMonotonic','recoveryDeadlineEpoch','temporaryPreparedAt'];
const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));
try{
 const before=fs.fstatSync(fd),body=fs.readFileSync(fd),after=fs.fstatSync(fd);
 const x=JSON.parse(body);
 if(!before.isFile()||before.nlink!==1||before.uid!==rootUid||before.gid!==rootGid
  ||(before.mode&0o7777)!==0o600
  ||before.dev!==after.dev||before.ino!==after.ino||before.size!==after.size
  ||before.mtimeMs!==after.mtimeMs
  ||(expectedDigest&&crypto.createHash('sha256').update(body).digest('hex')!==expectedDigest)
  ||JSON.stringify(Object.keys(x).sort())!==JSON.stringify(exactKeys.sort())
  ||x.schema!=='nexus.release-boot-health-pending.v3'||x.status!=='pending'
  ||x.profile!==profile
  ||canonical(x.production)!==canonical(JSON.parse(productionRaw))
  ||canonical(x.staging)!==canonical(JSON.parse(stagingRaw))
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

verify_pending_roles() {
  local profile="$1" expected_digest="$2"
  load_roles_for_profile "$profile"
  validate_pending "$expected_digest" >/dev/null
  printf '{"ok":true,"schema":"nexus.release-boot-role-verification.v1","profile":"%s","pendingSha256":"%s"}\n' \
    "$profile" "$expected_digest"
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
  preflight-temporary) preflight_temporary_pm2 ;;
  start-temporary) ensure_temporary_pm2 ;;
  verify-live-prelayout) verify_live_prelayout ;;
  publish-current) load_roles; publish_current_dump ;;
  publish-current-profile) load_roles_for_profile "$2"; publish_current_dump ;;
  arm-current) arm_current ;;
  prepare) prepare_boot ;;
  postcheck) postcheck_boot ;;
  verify-pending-roles) verify_pending_roles "$2" "$3" ;;
  *) echo "release boot health dispatch is invalid" >&2; exit 64 ;;
esac
