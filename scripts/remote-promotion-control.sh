#!/usr/bin/env bash
# Root-owned authorization and reconciliation boundary for persistent release
# promotion. The deploy user may submit owner-signed authority, query status,
# or request recovery; it cannot mutate authoritative transaction state.
set -euo pipefail
umask 077

VERSION="nexus-release-promotion-control.v4"
STATE_ROOT="${NEXUS_PROMOTION_STATE_ROOT:-/var/lib/nexus-release-promotion}"
SYSTEMCTL_BIN="${NEXUS_PROMOTION_SYSTEMCTL_BIN:-/usr/bin/systemctl}"
AUTH_BIN="${NEXUS_PROMOTION_AUTH_BIN:-/usr/local/libexec/nexus-promotion-authorization.mjs}"
OWNER_PUBLIC_KEY="${NEXUS_PROMOTION_OWNER_PUBLIC_KEY:-/etc/nexus-release/owner-promotion-public-key.pem}"
WORKER_USER="${NEXUS_PROMOTION_WORKER_USER:-dominguez}"
TRUSTED_ATTESTOR="${NEXUS_PROMOTION_TRUSTED_ATTESTOR:-/usr/local/libexec/nexus-trusted-release-runtime-attestation.mjs}"
RECOVERY_ATTESTOR="${NEXUS_PROMOTION_RECOVERY_ATTESTOR:-/usr/local/libexec/nexus-application-dr/release-recovery-runtime-identity.mjs}"
RELEASE_ROOT="${NEXUS_PROMOTION_RELEASE_ROOT:-/srv/nexus-release}"
PRODUCTION_BASE="${NEXUS_PROMOTION_PRODUCTION_BASE:-$RELEASE_ROOT/production}"
STAGING_BASE="${NEXUS_PROMOTION_STAGING_BASE:-$RELEASE_ROOT/staging}"
FILESYSTEM_IDENTITY="${NEXUS_PROMOTION_FILESYSTEM_IDENTITY:-/usr/local/libexec/nexus-trusted-release-filesystem-identity.mjs}"
STAGING_BROKER="${NEXUS_PROMOTION_STAGING_BROKER:-/usr/local/libexec/nexus-staging-attestation-broker.sh}"
SELECTOR_SWITCH="${NEXUS_PROMOTION_SELECTOR_SWITCH:-/usr/local/libexec/nexus-release-selector-switch.py}"
SYSTEM_NODE_BIN="${NEXUS_PROMOTION_NODE_BIN:-/usr/bin/node}"
COMMAND="${1:-}"
shift || true
BOOTSTRAP_JOURNAL="/var/lib/nexus-release-promotion/bootstrap-in-progress.v1"
LAYOUT_ATTESTATION="${NEXUS_PROMOTION_LAYOUT_ATTESTATION:-/var/lib/nexus-release-promotion/layout-migration.v1.json}"
LAYOUT_RESULT="${NEXUS_PROMOTION_LAYOUT_RESULT:-/var/lib/nexus-release-promotion/layout-migration-result.v1.json}"
LAYOUT_TERMINAL_JOURNAL="${NEXUS_PROMOTION_LAYOUT_TERMINAL_JOURNAL:-/var/lib/nexus-release-promotion/layout-migration-terminal.v1.json}"
LAYOUT_ACTIVATION_ACTIVE="${NEXUS_PROMOTION_LAYOUT_ACTIVATION_ACTIVE:-$STATE_ROOT/layout-activation/active.v1.json}"
LAYOUT_REQUEST="${NEXUS_PROMOTION_LAYOUT_REQUEST:-/var/lib/nexus-release-promotion/layout-migration-request-envelope.v1.json}"
LAYOUT_DRILL="${NEXUS_PROMOTION_LAYOUT_DRILL:-/var/lib/nexus-release-promotion/layout-migration-fault-drill-envelope.v1.json}"
LAYOUT_AUTH_BIN="${NEXUS_PROMOTION_LAYOUT_AUTH_BIN:-/usr/local/libexec/nexus-release-layout-authorization.mjs}"
LAYOUT_DRILL_VERIFY_BIN="${NEXUS_PROMOTION_LAYOUT_DRILL_VERIFY_BIN:-/usr/local/libexec/nexus-release-layout-fault-drill.mjs}"
LAYOUT_KVM_TRUST_MANIFEST="${NEXUS_PROMOTION_LAYOUT_KVM_TRUST_MANIFEST:-/var/lib/nexus-rollback-drill-vm/release-layout-evidence-trust.v1.json}"
LAYOUT_KVM_PROVISION_RECEIPT="${NEXUS_PROMOTION_LAYOUT_KVM_PROVISION_RECEIPT:-/var/lib/nexus-rollback-drill-vm/active.json}"
LAYOUT_KVM_PROVISION_JOURNAL="${NEXUS_PROMOTION_LAYOUT_KVM_PROVISION_JOURNAL:-/var/lib/nexus-rollback-drill-vm/provision-in-progress.v1}"
PM2_ATTESTATION="${NEXUS_PROMOTION_PM2_ATTESTATION:-/var/lib/nexus-release-promotion/pm2-root-install.v1.json}"
ROOT_PM2_BIN="${NEXUS_PROMOTION_PM2_BIN:-/usr/local/bin/pm2}"
ROOT_NODE_BIN="${NEXUS_PROMOTION_NODE_BIN:-/usr/bin/node}"
PHASE_A_RECEIPT="${NEXUS_LAYOUT_PHASE_A_RECEIPT:-$STATE_ROOT/layout-activation/phase-a-receipt.v1.json}"
PM2_INSTALL_JOURNAL="${NEXUS_PROMOTION_PM2_INSTALL_JOURNAL:-/var/lib/nexus-release-promotion/pm2-install-in-progress.v1.json}"
PM2_TRUSTED_LOCK="${NEXUS_PROMOTION_PM2_TRUSTED_LOCK:-/usr/local/share/nexus-release/pm2-package-lock.json}"
BOOT_HEALTH_BIN="${NEXUS_PROMOTION_BOOT_HEALTH_BIN:-/usr/local/sbin/nexus-release-boot-health}"
BOOT_RECOVERY="$STATE_ROOT/boot-recovery-in-progress.v1.json"
BOOT_PENDING="$STATE_ROOT/boot-health-pending.v1.json"
BOOT_PROOF="$STATE_ROOT/boot-health-proof.v1.json"
COMPAT_HOME="${NEXUS_PROMOTION_COMPAT_HOME:-/home/dominguez}"
COMPAT_PRODUCTION="${NEXUS_PROMOTION_COMPAT_PRODUCTION:-/home/dominguez/telegram-hub-bot}"
COMPAT_STAGING="${NEXUS_PROMOTION_COMPAT_STAGING:-/home/dominguez/telegram-hub-bot-staging}"
FINDMNT_BIN="${NEXUS_PROMOTION_FINDMNT_BIN:-/usr/bin/findmnt}"

if [ "$EUID" -ne 0 ] && [ "${NEXUS_RELEASE_TEST_MODE:-0}" != "1" ]; then
  echo "promotion control must run as root" >&2
  exit 77
fi
if [ "${NEXUS_RELEASE_TEST_MODE:-0}" = "1" ]; then SYSTEM_NODE_BIN="$(command -v node)"; fi
if [ "${NEXUS_RELEASE_TEST_MODE:-0}" != "1" ]; then
  if [ -L "$BOOTSTRAP_JOURNAL" ]; then
    echo "promotion bootstrap journal is unsafe" >&2
    exit 75
  elif [ -e "$BOOTSTRAP_JOURNAL" ]; then
    [ -f "$BOOTSTRAP_JOURNAL" ] \
      && [ "$(stat -c '%U:%G:%a' "$BOOTSTRAP_JOURNAL")" = root:root:600 ] || {
      echo "promotion bootstrap journal is unsafe" >&2
      exit 75
    }
    echo "promotion control-plane installation is incomplete; rerun the reviewed bootstrap" >&2
    exit 75
  fi
fi

validate_id() {
  [[ "$1" =~ ^[0-9]{8}T[0-9]{6}Z-[0-9]+-[a-f0-9]{12}$ ]] || {
    echo "invalid promotion transaction id" >&2
    exit 64
  }
}
validate_staging_request_id() {
  [[ "$1" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] || {
    echo "invalid staging request id" >&2
    exit 64
  }
}
transaction_dir() { printf '%s/transactions/%s' "$STATE_ROOT" "$1"; }
worker_dir() { printf '%s/worker' "$(transaction_dir "$1")"; }
control_dir() { printf '%s/control' "$(transaction_dir "$1")"; }
state_dir() { printf '%s/state' "$(transaction_dir "$1")"; }
journal_path() { printf '%s/journal.json' "$(state_dir "$1")"; }
authority_path() { printf '%s/authority.json' "$(transaction_dir "$1")"; }
unit_name() { printf 'nexus-release-promotion@%s.service' "$1"; }
staging_binding_path() { printf '%s/staging/%s.binding.json' "$STATE_ROOT" "$1"; }
staging_recovery_path() { printf '%s/staging/%s.recovery.json' "$STATE_ROOT" "$1"; }
staging_evidence_path() { printf '%s/staging/%s.evidence.json' "$STATE_ROOT" "$1"; }

root_own() {
  if [ "$EUID" -eq 0 ] && [ "${NEXUS_RELEASE_TEST_MODE:-0}" != "1" ]; then chown root:root "$@"; fi
}

durable_staging_file() {
  local destination="$1" expected_mode="$2" parent temporary identity
  case "$expected_mode" in 600|644) ;; *) echo "unsafe durable publication mode" >&2; return 1 ;; esac
  [[ "$destination" == "$STATE_ROOT/"* ]] || {
    echo "unsafe durable publication path" >&2
    return 1
  }
  parent="$(dirname -- "$destination")"
  [ -d "$parent" ] && [ ! -L "$parent" ] || {
    echo "durable publication parent is unsafe" >&2
    return 1
  }
  temporary="$(mktemp "${destination}.next.XXXXXXXX")"
  [[ "$temporary" == "${destination}.next."* ]] \
    && [ -f "$temporary" ] && [ ! -L "$temporary" ] \
    && [ "$(stat -c '%h' "$temporary")" = 1 ] || {
    echo "durable publication staging file is unsafe" >&2
    return 1
  }
  chmod "$expected_mode" "$temporary"
  root_own "$temporary"
  if [ "$EUID" -eq 0 ] && [ "${NEXUS_RELEASE_TEST_MODE:-0}" != "1" ]; then
    identity="$(stat -c '%U:%G' "$temporary")"
    [ "$identity" = root:root ] || {
      rm -f -- "$temporary"
      echo "durable publication staging owner is unsafe" >&2
      return 1
    }
  fi
  printf '%s\n' "$temporary"
}

durable_publish() {
  local temporary="$1" destination="$2" expected_mode="$3" identity
  [[ "$destination" == "$STATE_ROOT/"* \
      && "$temporary" == "${destination}.next."* ]] \
    && [ "$(dirname -- "$temporary")" = "$(dirname -- "$destination")" ] \
    && [ -f "$temporary" ] && [ ! -L "$temporary" ] \
    && [ "$(stat -c '%h' "$temporary")" = 1 ] \
    && [ "$(stat -c '%a' "$temporary")" = "$expected_mode" ] || {
    echo "durable publication staging identity is unsafe" >&2
    return 1
  }
  if [ -e "$destination" ] || [ -L "$destination" ]; then
    [ -f "$destination" ] && [ ! -L "$destination" ] \
      && [ "$(stat -c '%h' "$destination")" = 1 ] || {
      echo "durable publication destination is unsafe" >&2
      return 1
    }
  fi
  if [ "$EUID" -eq 0 ] && [ "${NEXUS_RELEASE_TEST_MODE:-0}" != "1" ]; then
    identity="$(stat -c '%U:%G' "$temporary")"
    [ "$identity" = root:root ] || {
      echo "durable publication staging owner is unsafe" >&2
      return 1
    }
    if [ -e "$destination" ]; then
      identity="$(stat -c '%U:%G' "$destination")"
      [ "$identity" = root:root ] || {
        echo "durable publication destination owner is unsafe" >&2
        return 1
      }
    fi
  fi
  if ! "$SYSTEM_NODE_BIN" - "$temporary" "$destination" <<'NODE'
const fs = require('fs');
const path = require('path');
const [temporary, destination] = process.argv.slice(2);
const staged = fs.lstatSync(temporary);
if (!staged.isFile() || staged.isSymbolicLink() || staged.nlink !== 1
    || path.dirname(temporary) !== path.dirname(destination)) process.exit(1);
if (fs.existsSync(destination)) {
  const current = fs.lstatSync(destination);
  if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1) process.exit(1);
}
let descriptor = fs.openSync(temporary, 'r');
try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
fs.renameSync(temporary, destination);
descriptor = fs.openSync(path.dirname(destination), 'r');
try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
NODE
  then
    rm -f -- "$temporary"
    echo "durable publication failed" >&2
    return 1
  fi
}

durable_remove() {
  local destination="$1" expected_mode="$2" identity
  [ -e "$destination" ] || [ -L "$destination" ] || return 0
  [[ "$destination" == "$STATE_ROOT/"* ]] \
    && [ -f "$destination" ] && [ ! -L "$destination" ] \
    && [ "$(stat -c '%h' "$destination")" = 1 ] \
    && [ "$(stat -c '%a' "$destination")" = "$expected_mode" ] || {
    echo "durable removal target is unsafe" >&2
    return 1
  }
  if [ "$EUID" -eq 0 ] && [ "${NEXUS_RELEASE_TEST_MODE:-0}" != "1" ]; then
    identity="$(stat -c '%U:%G' "$destination")"
    [ "$identity" = root:root ] || {
      echo "durable removal target owner is unsafe" >&2
      return 1
    }
  fi
  "$SYSTEM_NODE_BIN" - "$destination" <<'NODE'
const fs = require('fs');
const path = require('path');
const destination = process.argv[2];
const current = fs.lstatSync(destination);
if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1) process.exit(1);
fs.unlinkSync(destination);
const descriptor = fs.openSync(path.dirname(destination), 'r');
try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
NODE
}

fsync_directory() {
  local directory="$1"
  [ -d "$directory" ] && [ ! -L "$directory" ] || {
    echo "directory durability target is unsafe" >&2
    return 1
  }
  "$SYSTEM_NODE_BIN" - "$directory" <<'NODE'
const fs=require('fs');const directory=process.argv[2];
const stat=fs.lstatSync(directory);
if(!stat.isDirectory()||stat.isSymbolicLink())process.exit(1);
const descriptor=fs.openSync(directory,'r');
try{fs.fsyncSync(descriptor);}finally{fs.closeSync(descriptor);}
NODE
}

ensure_state_root() {
  install -d -m 755 "$STATE_ROOT" "$STATE_ROOT/requests" "$STATE_ROOT/transactions"
  install -d -m 700 "$STATE_ROOT/staging"
  root_own "$STATE_ROOT" "$STATE_ROOT/requests" "$STATE_ROOT/transactions" "$STATE_ROOT/staging"
  fsync_directory "$STATE_ROOT"
}

assert_layout_evidence_ready() {
  local worker_uid worker_gid identity evidence
  [ ! -e "$LAYOUT_ACTIVATION_ACTIVE" ] && [ ! -L "$LAYOUT_ACTIVATION_ACTIVE" ] || {
    echo "release layout activation is active; ordinary releases remain blocked" >&2
    return 75
  }
  assert_root_pm2_ready >/dev/null
  [ ! -e "$STATE_ROOT/layout-migration-in-progress.v1.json" ] \
    && [ ! -L "$STATE_ROOT/layout-migration-in-progress.v1.json" ] || {
    echo "release layout migration recovery is incomplete; releases remain blocked" >&2
    return 75
  }
  [ -f "$LAYOUT_AUTH_BIN" ] && [ ! -L "$LAYOUT_AUTH_BIN" ] || {
    echo "root-installed layout authority verifier is unavailable" >&2
    return 75
  }
  [ -f "$LAYOUT_DRILL_VERIFY_BIN" ] && [ ! -L "$LAYOUT_DRILL_VERIFY_BIN" ] || {
    echo "root-installed layout machine-proof verifier is unavailable" >&2
    return 75
  }
  for evidence in "$LAYOUT_ATTESTATION" "$LAYOUT_RESULT" "$LAYOUT_TERMINAL_JOURNAL" \
    "$LAYOUT_REQUEST" "$LAYOUT_DRILL" "$PM2_ATTESTATION"; do
    [ -f "$evidence" ] && [ ! -L "$evidence" ] \
      && [ "$(stat -c '%a:%h' "$evidence")" = 600:1 ] || {
      echo "authoritative release layout evidence is unavailable or unsafe; releases remain blocked" >&2
      return 75
    }
  done
  if [ "${NEXUS_RELEASE_TEST_MODE:-0}" != "1" ]; then
    for evidence in "$LAYOUT_ATTESTATION" "$LAYOUT_RESULT" "$LAYOUT_TERMINAL_JOURNAL" \
      "$LAYOUT_REQUEST" "$LAYOUT_DRILL" "$PM2_ATTESTATION"; do
      identity="$(stat -c '%U:%G' "$evidence")"
      [ "$identity" = root:root ] || {
        echo "release layout migration evidence owner is unsafe" >&2
        return 1
      }
    done
  fi
  "$SYSTEM_NODE_BIN" "$LAYOUT_AUTH_BIN" verify \
    --request-envelope "$LAYOUT_REQUEST" \
    --fault-drill-envelope "$LAYOUT_DRILL" \
    --public-key "$OWNER_PUBLIC_KEY" \
    --allow-expired >/dev/null
  [ ! -e "$LAYOUT_KVM_PROVISION_JOURNAL" ] \
    && [ ! -L "$LAYOUT_KVM_PROVISION_JOURNAL" ] || {
    echo "rollback-drill KVM provisioning is incomplete" >&2
    return 75
  }
  "$SYSTEM_NODE_BIN" "$LAYOUT_DRILL_VERIFY_BIN" verify-envelope \
    --input "$LAYOUT_DRILL" \
    --trust-manifest "$LAYOUT_KVM_TRUST_MANIFEST" \
    --provision-receipt "$LAYOUT_KVM_PROVISION_RECEIPT" \
    --require-root-trust --allow-expired >/dev/null
  worker_uid="$(id -u "$WORKER_USER")"
  worker_gid="$(id -g "$WORKER_USER")"
  if [ "${NEXUS_RELEASE_TEST_MODE:-0}" != 1 ]; then
    [ -x "$FINDMNT_BIN" ] || {
      echo "findmnt is required to attest compatibility bind mounts" >&2
      return 75
    }
    local compatibility_path compatibility_target compatibility_mount_target
    while IFS=$'\t' read -r compatibility_path compatibility_target; do
      compatibility_mount_target="$("$FINDMNT_BIN" --mountpoint "$compatibility_path" \
        --noheadings --output TARGET)" || return 75
      [ "$compatibility_mount_target" = "$compatibility_path" ] || return 75
      [ "$(stat -c '%d:%i' -- "$compatibility_path")" \
          = "$(stat -c '%d:%i' -- "$compatibility_target")" ] || return 75
    done <<EOF
$COMPAT_PRODUCTION	$PRODUCTION_BASE
$COMPAT_STAGING	$STAGING_BASE
EOF
  fi
    "$SYSTEM_NODE_BIN" - "$LAYOUT_ATTESTATION" "$LAYOUT_RESULT" \
    "$LAYOUT_TERMINAL_JOURNAL" "$LAYOUT_REQUEST" "$LAYOUT_DRILL" "$PM2_ATTESTATION" \
    "$RELEASE_ROOT" "$PRODUCTION_BASE" "$STAGING_BASE" "$worker_uid" "$worker_gid" \
    "${NEXUS_RELEASE_TEST_MODE:-0}" "$COMPAT_HOME" "$COMPAT_PRODUCTION" \
    "$COMPAT_STAGING" "$FINDMNT_BIN" <<'NODE'
const crypto=require('crypto');const fs=require('fs');const path=require('path');
const {execFileSync}=require('child_process');
const [file,resultFile,terminalFile,requestFile,drillFile,pm2File,
 releaseRoot,productionBase,stagingBase,workerUidRaw,workerGidRaw,testMode,
 compatHome,compatProduction,compatStaging,findmntBin]=process.argv.slice(2);
const workerUid=Number(workerUidRaw);
const workerGid=Number(workerGidRaw);
const rootUid=testMode==='1'?process.getuid():0;
const rootGid=testMode==='1'?process.getgid():0;
const sha256=(body)=>crypto.createHash('sha256').update(body).digest('hex');
const canonical=(value)=>value===null||typeof value!=='object'?JSON.stringify(value)
 :Array.isArray(value)?`[${value.map(canonical).join(',')}]`
 :`{${Object.keys(value).sort().map((key)=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
const readSafe=(input)=>{
 const fd=fs.openSync(input,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));
 try{
  const before=fs.fstatSync(fd);const body=fs.readFileSync(fd);const after=fs.fstatSync(fd);
  if(!before.isFile()||before.nlink!==1||before.dev!==after.dev||before.ino!==after.ino
   ||before.size!==after.size||before.mtimeMs!==after.mtimeMs)process.exit(1);
  return {body,value:JSON.parse(body.toString('utf8'))};
 }finally{fs.closeSync(fd);}
};
const markerInput=readSafe(file),resultInput=readSafe(resultFile);
const terminalInput=readSafe(terminalFile),requestInput=readSafe(requestFile);
const drillInput=readSafe(drillFile),pm2Input=readSafe(pm2File);
const value=markerInput.value,result=resultInput.value,terminal=terminalInput.value;
const requestEnvelope=requestInput.value,drillEnvelope=drillInput.value;
const request=requestEnvelope.payload,drill=drillEnvelope.payload;
if(value.schema!=='nexus.release-layout-migration.v1'
 ||value.phase!=='passed'
 ||value.releaseRoot!==releaseRoot||value.productionBase!==productionBase
 ||value.stagingBase!==stagingBase
 ||value.previous?.production!=='/home/dominguez/telegram-hub-bot'
 ||value.previous?.staging!=='/home/dominguez/telegram-hub-bot-staging'
 ||value.soakSeconds!==60
 ||result.schema!=='nexus.release-layout-migration-result.v1'||result.phase!=='passed'
 ||terminal.schema!=='nexus.release-layout-migration-terminal-journal.v1'
 ||terminal.phase!=='completed'
 ||request?.schema!=='nexus.release-layout-migration-request.v1'
 ||drill?.schema!=='nexus.release-layout-fault-drill.v1'
 ||value.requestEnvelopeSha256!==sha256(requestInput.body)
 ||value.faultDrillEnvelopeSha256!==sha256(drillInput.body)
 ||value.pm2AttestationSha256!==sha256(pm2Input.body)
 ||value.terminalJournalSha256!==sha256(terminalInput.body)
 ||value.resultSha256!==sha256(resultInput.body)
 ||value.requestEnvelopeSha256!==result.requestEnvelopeSha256
 ||value.requestEnvelopeSha256!==terminal.requestEnvelopeSha256
 ||value.faultDrillEnvelopeSha256!==result.faultDrillEnvelopeSha256
 ||value.faultDrillEnvelopeSha256!==terminal.faultDrillEnvelopeSha256
 ||value.pm2AttestationSha256!==result.pm2AttestationSha256
 ||value.pm2AttestationSha256!==terminal.pm2AttestationSha256
 ||result.terminalJournalSha256!==value.terminalJournalSha256
 ||request.migrationId!==drill.migrationId||request.migrationId!==result.migrationId
 ||request.migrationId!==terminal.migrationId
 ||canonical(request.source)!==canonical(result.source)
 ||canonical(request.source)!==canonical(terminal.source)
 ||canonical(result.runtime)!==canonical(terminal.runtime)
 ||canonical(result.filesystem)!==canonical(terminal.filesystem)
 ||!/^[a-f0-9]{64}$/u.test(value.pm2DumpSha256||'')
 ||value.pm2DumpSha256!==result.pm2DumpSha256
 ||value.pm2DumpSha256!==terminal.pm2DumpSha256
	 ||canonical(result.readinessSha256)!==canonical(terminal.readinessSha256)
	 ||canonical(value.readinessSha256)!==canonical(result.readinessSha256)
	 ||canonical(value.unavailability)!==canonical(result.unavailability)
	 ||canonical(value.unavailability)!==canonical(terminal.unavailability)
	 ||value.unavailability?.schema!=='nexus.release-layout-unavailability.v1'
	 ||value.unavailability?.targetMet!==true
	 ||value.unavailability?.timingBasis!=='same_boot_monotonic'
	 ||!Number.isSafeInteger(value.unavailability?.durationMilliseconds)
	 ||value.unavailability.durationMilliseconds<0
	 ||value.unavailability.durationMilliseconds>120000
	 ||value.unavailability?.targetMilliseconds!==120000
	 ||!Number.isSafeInteger(value.unavailability?.start?.epochMs)
	 ||!Number.isSafeInteger(value.unavailability?.start?.monotonicMs)
	 ||!Number.isSafeInteger(value.unavailability?.end?.epochMs)
	 ||!Number.isSafeInteger(value.unavailability?.end?.monotonicMs)
	 ||value.unavailability.start.bootId!==value.unavailability.end.bootId
	 ||value.unavailability.end.monotonicMs-value.unavailability.start.monotonicMs
	   !==value.unavailability.durationMilliseconds
	 ||canonical(value.databaseRecovery)!==canonical(result.databaseRecovery)
	 ||canonical(value.databaseRecovery)!==canonical(terminal.databaseRecovery)
	 ||canonical(value.compatibility)!==canonical(result.compatibility)
	 ||canonical(value.compatibility)!==canonical(terminal.compatibility)
	 ||!/^[a-f0-9]{64}$/u.test(value.databaseRecovery?.recoveryPointSha256||'')
	 ||!Number.isSafeInteger(value.databaseRecovery?.recoveryPointSizeBytes)
	 ||value.databaseRecovery.recoveryPointSizeBytes<=0
	 ||value.databaseRecovery.recoveryPointSizeBytes>2*1024*1024*1024
	 ||!/^[a-f0-9]{64}$/u.test(value.databaseRecovery?.snapshotEvidenceSha256||'')
	 ||!/^[a-f0-9]{64}$/u.test(value.databaseRecovery?.stoppedBoundarySha256||'')
	 ||!Number.isSafeInteger(value.databaseRecovery?.stoppedBoundarySizeBytes)
	 ||value.databaseRecovery.stoppedBoundarySizeBytes<=0
	 ||value.databaseRecovery.stoppedBoundarySizeBytes>2*1024*1024*1024
	 ||!/^[a-f0-9]{64}$/u.test(value.databaseRecovery?.stoppedBoundaryEvidenceSha256||'')
	 ||!/^[a-f0-9]{64}$/u.test(value.databaseRecovery?.stoppedBoundaryCopyEvidenceSha256||'')
	 ||value.databaseRecovery?.restoredFromRecoveryPoint!==false
	 ||value.databaseRecovery?.integrityCheck!=='ok'
	 ||value.databaseRecovery?.foreignKeyCheck!=='ok'
 ||drill.maximumRecoverySeconds>120
 ||!Array.isArray(drill.scenarios)||drill.scenarios.length!==3
 ||drill.scenarios.some((scenario)=>scenario.status!=='passed'
   ||!/^[a-f0-9]{64}$/u.test(scenario.resultSha256||''))
 ||!Number.isFinite(Date.parse(value.completedAt||'')))process.exit(1);
const home=fs.lstatSync(compatHome,{bigint:true});
if(!home.isDirectory()||home.isSymbolicLink()
 ||value.compatibility?.home?.path!==compatHome
 ||value.compatibility.home.dev!==String(home.dev)
 ||value.compatibility.home.ino!==String(home.ino)
 ||value.compatibility.home.uid!==Number(home.uid)
 ||value.compatibility.home.gid!==Number(home.gid)
 ||value.compatibility.home.mode!==Number(home.mode&0o7777n)
 ||Number(home.uid)!==workerUid
 ||Number(home.gid)!==workerGid
 ||(Number(home.mode&0o0022n)!==0))process.exit(1);
for(const [role,mountPath,target] of [
 ['production',compatProduction,productionBase],['staging',compatStaging,stagingBase],
]){
 const stat=fs.lstatSync(mountPath,{bigint:true});
 const targetStat=fs.lstatSync(target,{bigint:true}),record=value.compatibility?.[role];
 const expectedKind=testMode==='1'?'test-symlink-equivalent':'bind-mount';
 let live;
 if(testMode==='1'){
  if(!stat.isSymbolicLink()||fs.readlinkSync(mountPath)!==target
   ||fs.realpathSync.native(mountPath)!==target)process.exit(1);
  live={kind:expectedKind,path:mountPath,target,
   findmnt:{source:'test-equivalent',target:mountPath,options:['bind']},
   mountIdentity:{dev:String(targetStat.dev),ino:String(targetStat.ino)},
   targetIdentity:{dev:String(targetStat.dev),ino:String(targetStat.ino)}};
 }else if(!stat.isDirectory()||stat.isSymbolicLink()
  ||String(stat.dev)!==String(targetStat.dev)
  ||String(stat.ino)!==String(targetStat.ino))process.exit(1);
 else{
  const mount=JSON.parse(execFileSync(findmntBin,
   ['--json','--mountpoint',mountPath,'--output','SOURCE,TARGET,OPTIONS'],
   {encoding:'utf8'})).filesystems;
  if(!Array.isArray(mount)||mount.length!==1||mount[0].target!==mountPath
   ||typeof mount[0].source!=='string'||typeof mount[0].options!=='string')process.exit(1);
  live={kind:expectedKind,path:mountPath,target,
   findmnt:{source:mount[0].source,target:mount[0].target,
    options:mount[0].options.split(',').filter(Boolean).sort()},
   mountIdentity:{dev:String(stat.dev),ino:String(stat.ino)},
   targetIdentity:{dev:String(targetStat.dev),ino:String(targetStat.ino)}};
 }
 const identitySha256=sha256(Buffer.from(canonical(live)));
 if(canonical(record)!==canonical({...live,identitySha256}))process.exit(1);
}
const statEntry=(entryPath,uid,gid,mode)=>{
 const stat=fs.lstatSync(entryPath,{bigint:true});
 if(!stat.isDirectory()||stat.isSymbolicLink()
  ||fs.realpathSync.native(entryPath)!==entryPath
  ||Number(stat.uid)!==uid||Number(stat.gid)!==gid
  ||Number(stat.mode&0o7777n)!==mode)process.exit(1);
 return {path:entryPath,dev:String(stat.dev),ino:String(stat.ino)};
};
const selectorEntry=(base,runtime)=>{
 const selectorPath=path.join(base,'current');
 const stat=fs.lstatSync(selectorPath,{bigint:true});
 if(!stat.isSymbolicLink()||Number(stat.uid)!==rootUid||Number(stat.gid)!==rootGid
  ||fs.readlinkSync(selectorPath)!==runtime||fs.realpathSync.native(selectorPath)!==runtime)process.exit(1);
 return {schema:'nexus.release-current-selector-identity.v1',path:selectorPath,
  dev:String(stat.dev),ino:String(stat.ino),target:runtime,
  uid:Number(stat.uid),gid:Number(stat.gid)};
};
const observedRoot=statEntry(releaseRoot,rootUid,rootGid,0o755);
for(const [role,base] of [['production',productionBase],['staging',stagingBase]]){
 const record=value[role];
 const source=request.source?.[role];
 if(!record||record.currentRuntime===path.join(base,'releases')
  ||!record.currentRuntime.startsWith(`${path.join(base,'releases')}${path.sep}`)
  ||!/^[a-f0-9]{40}$/u.test(record.runtimeSha||'')
  ||!/^[a-f0-9]{64}$/u.test(record.artifactDigest||'')
  ||!/^[a-f0-9]{64}$/u.test(record.installedRuntimeDigest||'')
  ||record.runtimeSha!==source?.runtimeSha
  ||record.artifactDigest!==source?.artifactDigest
  ||record.installedRuntimeDigest!==source?.installedRuntimeDigest
  ||record.currentRuntime!==result.runtime?.[role]
  ||canonical(record.filesystem)!==canonical(result.filesystem?.[role]))process.exit(1);
 const observedAnchors={
  releaseRoot:observedRoot,
  base:statEntry(base,rootUid,workerGid,0o1770),
  releases:statEntry(path.join(base,'releases'),rootUid,workerGid,0o750),
 };
 for(const anchor of Object.keys(observedAnchors)){
  if(canonical(observedAnchors[anchor])!==canonical(record.filesystem?.[anchor]))process.exit(1);
 }
 const liveRuntime=fs.realpathSync.native(path.join(base,'current'));
 if(liveRuntime===path.join(base,'releases')
  ||!liveRuntime.startsWith(`${path.join(base,'releases')}${path.sep}`))process.exit(1);
 statEntry(liveRuntime,rootUid,workerGid,0o550);
 selectorEntry(base,liveRuntime);
 const marker=JSON.parse(fs.readFileSync(path.join(liveRuntime,'.complete.json'),'utf8'));
 const installed=JSON.parse(fs.readFileSync(
  path.join(liveRuntime,'.nexus-installed-runtime.json'),'utf8'));
 if(!/^[a-f0-9]{40}$/u.test(marker.runtimeSha||'')
  ||!/^[a-f0-9]{64}$/u.test(marker.artifactDigest||'')
  ||!/^[a-f0-9]{64}$/u.test(installed.aggregateDigest||''))process.exit(1);
}
process.stdout.write(`${JSON.stringify({ok:true,schema:value.schema,
 releaseRoot,completedAt:value.completedAt})}\n`);
NODE
}

validate_boot_recovery_prepared() {
  local profile="$1" active_id pending_digest pair_fields
  case "$profile" in
    layout|legacy|v4-prelayout) ;;
    *)
      echo "boot recovery profile must be layout, legacy, or v4-prelayout" >&2
      return 64
      ;;
  esac
  [ -f "$BOOT_RECOVERY" ] && [ ! -L "$BOOT_RECOVERY" ] \
    && [ -f "$BOOT_PENDING" ] && [ ! -L "$BOOT_PENDING" ] || {
    echo "boot recovery and pending health authority are incomplete" >&2
    return 75
  }
  pair_fields="$("$SYSTEM_NODE_BIN" - "$BOOT_RECOVERY" "$BOOT_PENDING" \
    "${NEXUS_RELEASE_TEST_MODE:-0}" "$profile" <<'NODE'
const crypto=require('crypto');const fs=require('fs');
const [recoveryFile,pendingFile,testMode,profile]=process.argv.slice(2);
const rootUid=testMode==='1'?process.getuid():0;
const rootGid=testMode==='1'?process.getgid():0;
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)
 &&JSON.stringify(Object.keys(value).sort())===JSON.stringify([...keys].sort());
const readSafe=(file)=>{
 const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));
 try{
  const before=fs.fstatSync(fd),body=fs.readFileSync(fd),after=fs.fstatSync(fd);
  if(!before.isFile()||before.nlink!==1||before.uid!==rootUid||before.gid!==rootGid
   ||(before.mode&0o7777)!==0o600||before.dev!==after.dev||before.ino!==after.ino
   ||before.size!==after.size||before.mtimeMs!==after.mtimeMs)process.exit(1);
  return {body,value:JSON.parse(body)};
 }finally{fs.closeSync(fd);}
};
const recoveryInput=readSafe(recoveryFile),pendingInput=readSafe(pendingFile);
const recovery=recoveryInput.value,pending=pendingInput.value;
const currentBootId=testMode==='1'
 ?(process.env.NEXUS_PROMOTION_TEST_BOOT_ID||'test-boot')
 :fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim();
const digest=/^[a-f0-9]{64}$/u,sha=/^[a-f0-9]{40}$/u;
const transaction=/^[0-9]{8}T[0-9]{6}Z-[0-9]+-[a-f0-9]{12}$/u;
const recoveryKeys=['schema','status','bootId','bootDetectedAt','bootDetectedEpoch',
 'outageStartedAt','outageStartedEpoch','outageStartedMonotonic','outageBootId',
 'recoveryDeadlineEpoch','timingSource','activeTransactionId'];
const pendingKeys=['schema','status','profile','production','staging','canonicalDumpSha256',
 'pm2ClosureDigest','nodeSha256','recoveryAuthoritySha256','bootId','outageBootId',
 'outageStartedAt','outageStartedEpoch','outageStartedMonotonic',
 'recoveryDeadlineEpoch','temporaryPreparedAt'];
const roleKeys=['schema','role','profile','base','runtime','runtimeSha',
 'artifactDigest','installedRuntimeDigest','selector','runtimeIdentity',
 'markerSha256','installedAttestationSha256','authoritySha256','transaction'];
const timingSources=new Set(['boot_detection','layout_recovery','layout_journal',
 'promotion_recovery_attempt','promotion_cutover']);
if(!exact(recovery,recoveryKeys)
 ||recovery.schema!=='nexus.release-boot-recovery.v1'||recovery.status!=='in_progress'
 ||recovery.bootId!==currentBootId||typeof recovery.outageBootId!=='string'
 ||!recovery.outageBootId||!Number.isFinite(Date.parse(recovery.bootDetectedAt||''))
 ||!Number.isFinite(Date.parse(recovery.outageStartedAt||''))
 ||!Number.isSafeInteger(recovery.bootDetectedEpoch)
 ||Math.floor(Date.parse(recovery.bootDetectedAt)/1000)!==recovery.bootDetectedEpoch
 ||!Number.isSafeInteger(recovery.outageStartedEpoch)
 ||Math.floor(Date.parse(recovery.outageStartedAt)/1000)!==recovery.outageStartedEpoch
 ||recovery.bootDetectedEpoch<recovery.outageStartedEpoch
 ||!Number.isSafeInteger(recovery.outageStartedMonotonic)
 ||recovery.outageStartedMonotonic<0
 ||recovery.recoveryDeadlineEpoch!==recovery.outageStartedEpoch+120
 ||!timingSources.has(recovery.timingSource)
 ||!(recovery.activeTransactionId===null
   ||transaction.test(recovery.activeTransactionId)))process.exit(1);
if(!exact(pending,pendingKeys)
 ||pending.schema!=='nexus.release-boot-health-pending.v3'||pending.status!=='pending'
 ||pending.profile!==profile
 ||pending.recoveryAuthoritySha256
   !==crypto.createHash('sha256').update(recoveryInput.body).digest('hex')
 ||pending.bootId!==recovery.bootId||pending.outageBootId!==recovery.outageBootId
 ||pending.outageStartedAt!==recovery.outageStartedAt
 ||pending.outageStartedEpoch!==recovery.outageStartedEpoch
 ||pending.outageStartedMonotonic!==recovery.outageStartedMonotonic
 ||pending.recoveryDeadlineEpoch!==recovery.recoveryDeadlineEpoch
 ||!digest.test(pending.canonicalDumpSha256||'')
 ||!digest.test(pending.pm2ClosureDigest||'')||!digest.test(pending.nodeSha256||'')
 ||!Number.isFinite(Date.parse(pending.temporaryPreparedAt||'')))process.exit(1);
for(const role of ['production','staging']){
 const value=pending[role];
 if(!exact(value,roleKeys)||value.schema!=='nexus.release-boot-role.v1'
  ||value.role!==role||!sha.test(value.runtimeSha||'')
  ||!digest.test(value.artifactDigest||'')
  ||!digest.test(value.installedRuntimeDigest||'')
  ||!digest.test(value.markerSha256||'')
  ||!digest.test(value.installedAttestationSha256||''))process.exit(1);
}
process.stdout.write(`${recovery.activeTransactionId??'none'}\t${
 crypto.createHash('sha256').update(pendingInput.body).digest('hex')}`);
NODE
  )" || {
    echo "boot recovery and pending health authority are invalid" >&2
    return 75
  }
  IFS=$'\t' read -r active_id pending_digest <<<"$pair_fields"
  "$BOOT_HEALTH_BIN" verify-pending-roles "$profile" "$pending_digest" >/dev/null \
    || {
      echo "boot recovery live role evidence is invalid" >&2
      return 75
    }
  if [ "$active_id" = none ]; then
    [ ! -e "$STATE_ROOT/active.json" ] && [ ! -L "$STATE_ROOT/active.json" ] || {
      echo "boot recovery omits the active promotion authority" >&2
      return 75
    }
    return 0
  fi
  validate_id "$active_id"
  [ -f "$STATE_ROOT/active.json" ] && [ ! -L "$STATE_ROOT/active.json" ] || {
    echo "boot recovery active promotion authority is unavailable" >&2
    return 75
  }
  local observed_id request_sha
  IFS=$'\t' read -r observed_id request_sha < <(read_active_fields) || return 75
  [ "$observed_id" = "$active_id" ] \
    && journal_terminal "$observed_id" "$request_sha" || {
    echo "boot promotion recovery has not reached a terminal state" >&2
    return 75
  }
}

assert_layout_ready() {
  [ ! -e "$BOOT_RECOVERY" ] && [ ! -L "$BOOT_RECOVERY" ] \
    && [ ! -e "$BOOT_PENDING" ] && [ ! -L "$BOOT_PENDING" ] || {
    echo "boot recovery or pending health authority is unresolved; releases remain blocked" >&2
    return 75
  }
  assert_layout_evidence_ready
}

assert_layout_boot_ready() {
  if [ -e "$BOOT_RECOVERY" ] || [ -L "$BOOT_RECOVERY" ] \
      || [ -e "$BOOT_PENDING" ] || [ -L "$BOOT_PENDING" ]; then
    validate_boot_recovery_prepared layout
  fi
  assert_layout_evidence_ready
}

assert_root_pm2_ready() {
  local identity
  if [ -e "$PM2_INSTALL_JOURNAL" ] || [ -L "$PM2_INSTALL_JOURNAL" ]; then
    echo "root PM2 closure installation is incomplete; releases remain blocked" >&2
    return 75
  fi
  [ -f "$PM2_ATTESTATION" ] && [ ! -L "$PM2_ATTESTATION" ] \
    && [ "$(stat -c '%a:%h' "$PM2_ATTESTATION")" = 600:1 ] || {
    echo "root-owned PM2 closure is not owner-attested; releases remain blocked" >&2
    return 75
  }
  [ -f "$PM2_TRUSTED_LOCK" ] && [ ! -L "$PM2_TRUSTED_LOCK" ] || {
    echo "root PM2 trusted package lock is unavailable" >&2
    return 75
  }
  if [ "${NEXUS_RELEASE_TEST_MODE:-0}" != "1" ]; then
    identity="$(stat -c '%U:%G' "$PM2_ATTESTATION")"
    [ "$identity" = root:root ] || {
      echo "root PM2 installation attestation owner is unsafe" >&2
      return 1
    }
    [ "$(stat -c '%U:%G:%a' "$PM2_TRUSTED_LOCK")" = root:root:644 ] || {
      echo "root PM2 trusted package lock identity is unsafe" >&2
      return 1
    }
  fi
  "$SYSTEM_NODE_BIN" - "$PM2_ATTESTATION" "$ROOT_PM2_BIN" "$ROOT_NODE_BIN" "$PM2_TRUSTED_LOCK" \
    "${NEXUS_RELEASE_TEST_MODE:-0}" <<'NODE'
const crypto=require('crypto');const fs=require('fs');const path=require('path');
const [attestationPath,launcher,nodeBin,trustedLockPath,testMode]=process.argv.slice(2);
const rootUid=testMode==='1'?process.getuid():0;
const allowedNodeUids=testMode==='1'?new Set([0,rootUid]):new Set([0]);
const canonical=(value)=>value===null||typeof value!=='object'?JSON.stringify(value)
 :Array.isArray(value)?`[${value.map(canonical).join(',')}]`
 :`{${Object.keys(value).sort().map((key)=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
const sha256=(value)=>crypto.createHash('sha256').update(value).digest('hex');
const readSafe=(file)=>{
 const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));
 try{
  const before=fs.fstatSync(fd);const body=fs.readFileSync(fd,'utf8');const after=fs.fstatSync(fd);
  if(!before.isFile()||before.nlink!==1||before.dev!==after.dev||before.ino!==after.ino
   ||before.size!==after.size||before.mtimeMs!==after.mtimeMs)process.exit(1);
  return JSON.parse(body);
 }finally{fs.closeSync(fd);}
};
const record=readSafe(attestationPath);
if(record.schema!=='nexus.pm2-root-install.v1'||record.launcher!==launcher
 ||!/^[0-9]+\.[0-9]+\.[0-9]+$/u.test(record.version||'')
 ||!/^[a-f0-9]{64}$/u.test(record.sourceArchiveSha256||'')
 ||!/^[a-f0-9]{64}$/u.test(record.closureDigest||'')
 ||!/^[a-f0-9]{64}$/u.test(record.payloadDigest||'')
 ||!/^[a-f0-9]{64}$/u.test(record.packageLockSha256||'')
 ||!/^[a-f0-9]{64}$/u.test(record.launcherSha256||'')
 ||record.node?.path!==nodeBin||record.node?.version!=='v22.23.1'
 ||!/^[a-f0-9]{64}$/u.test(record.node?.sha256||'')
 ||!Number.isSafeInteger(record.fileCount)||record.fileCount<2
 ||!Number.isFinite(Date.parse(record.installedAt||'')))process.exit(1);
const link=fs.lstatSync(launcher);
if(!link.isFile()||link.isSymbolicLink()||link.uid!==rootUid
 ||(link.mode&0o7777)!==0o755||link.nlink!==1)process.exit(1);
const launcherBody=fs.readFileSync(launcher);
if(sha256(launcherBody)!==record.launcherSha256)process.exit(1);
const nodeStat=fs.lstatSync(nodeBin);
if(!nodeStat.isFile()||nodeStat.isSymbolicLink()||!allowedNodeUids.has(nodeStat.uid)
 ||(nodeStat.mode&0o022)!==0||sha256(fs.readFileSync(nodeBin))!==record.node.sha256)process.exit(1);
const closureRoot=path.resolve(record.closureRoot);
const entrypoint=path.join(closureRoot,'node_modules','pm2','bin','pm2');
if(record.entrypoint!==entrypoint)process.exit(1);
const expectedLauncher=`#!/usr/bin/bash\nexec ${JSON.stringify(nodeBin)} ${JSON.stringify(entrypoint)} "$@"\n`;
if(launcherBody.toString('utf8')!==expectedLauncher)process.exit(1);
const files=[];
const walk=(directory)=>{
 const directoryStat=fs.lstatSync(directory);
 if(!directoryStat.isDirectory()||directoryStat.isSymbolicLink()
  ||directoryStat.uid!==rootUid||(directoryStat.mode&0o7777)!==0o755)process.exit(1);
 for(const name of fs.readdirSync(directory).sort()){
  const absolute=path.join(directory,name);const stat=fs.lstatSync(absolute);
  if(stat.isSymbolicLink()||stat.uid!==rootUid||(stat.mode&0o022)!==0)process.exit(1);
  if(stat.isDirectory())walk(absolute);
  else if(stat.isFile()){
   const body=fs.readFileSync(absolute);
   files.push({path:path.relative(closureRoot,absolute).split(path.sep).join('/'),
    size:body.length,mode:stat.mode&0o7777,sha256:sha256(body)});
  }else process.exit(1);
 }
};
walk(closureRoot);
const legacyDigest=sha256(canonical({schema:'nexus.pm2-root-closure.v1',files}));
const normalizedFiles=[...files].sort((left,right)=>
 left.path<right.path?-1:left.path>right.path?1:0);
const normalizedDigest=sha256(canonical({
 schema:'nexus.pm2-root-closure.v1',files:normalizedFiles,
}));
if(files.length!==record.fileCount
 ||(record.closureDigest!==legacyDigest&&record.closureDigest!==normalizedDigest))process.exit(1);
const packageIdentity=JSON.parse(fs.readFileSync(
 path.join(closureRoot,'node_modules','pm2','package.json'),'utf8'));
if(packageIdentity.name!=='pm2'||packageIdentity.version!==record.version)process.exit(1);
const manifest=JSON.parse(fs.readFileSync(path.join(closureRoot,'closure-manifest.json'),'utf8'));
const trustedLockBody=fs.readFileSync(trustedLockPath);
const trustedLock=JSON.parse(trustedLockBody);
const lockPackages=Object.entries(trustedLock.packages??{}).filter(([packagePath])=>packagePath)
 .map(([packagePath,identity])=>({path:packagePath,version:identity.version??null,
  resolved:identity.resolved??null,integrity:identity.integrity??null}))
 .sort((left,right)=>left.path<right.path?-1:left.path>right.path?1:0);
if(lockPackages.some((entry)=>String(entry.resolved??'').startsWith('https://')
  &&(!entry.version||!entry.integrity)))process.exit(1);
const payloadFiles=normalizedFiles.filter((entry)=>entry.path!=='closure-manifest.json');
const payloadDigest=sha256(canonical({schema:'nexus.pm2-root-closure-payload.v1',files:payloadFiles}));
const installedPackages=[];
for(const identity of lockPackages){
 const packageFile=path.join(closureRoot,identity.path,'package.json');
 if(!fs.existsSync(packageFile)){
  if(trustedLock.packages[identity.path]?.optional===true)continue;
  process.exit(1);
 }
 const installed=JSON.parse(fs.readFileSync(packageFile,'utf8'));
 if(installed.version!==identity.version)process.exit(1);
 installedPackages.push({path:identity.path,version:identity.version});
}
if(manifest.schema!=='nexus.pm2-root-closure-manifest.v1'
 ||manifest.pm2Version!==record.version||manifest.nodeVersion!=='v22.23.1'
 ||manifest.npmVersion!=='10.9.8'
 ||manifest.packageLockSha256!==sha256(trustedLockBody)
 ||manifest.packageLockSha256!==record.packageLockSha256
 ||canonical(manifest.packageLockPackages)!==canonical(lockPackages)
 ||canonical(manifest.installedPackages)!==canonical(installedPackages)
 ||canonical(manifest.files)!==canonical(payloadFiles)
 ||manifest.fileCount!==payloadFiles.length||manifest.payloadDigest!==payloadDigest
 ||record.payloadDigest!==payloadDigest)process.exit(1);
process.stdout.write(`${JSON.stringify({ok:true,schema:record.schema,version:record.version,
 closureDigest:record.closureDigest,payloadDigest,packageLockSha256:record.packageLockSha256,
 launcher,launcherSha256:record.launcherSha256,node:record.node,entrypoint})}\n`);
NODE
}

ensure_transaction_dirs() {
  local id="$1" dir
  dir="$(transaction_dir "$id")"
  # 0711 permits traversal for the known transaction ID but prevents the
  # deploy account from enumerating other owner-authorized transactions.
  install -d -m 711 "$dir" "$(control_dir "$id")"
  install -d -m 700 "$(state_dir "$id")"
  root_own "$dir" "$(control_dir "$id")" "$(state_dir "$id")"
  if [ ! -d "$(worker_dir "$id")" ]; then install -d -m 700 "$(worker_dir "$id")"; fi
  chmod 700 "$(worker_dir "$id")"
  if [ "$EUID" -eq 0 ] && [ "${NEXUS_RELEASE_TEST_MODE:-0}" != "1" ]; then
    chown "$WORKER_USER:$WORKER_USER" "$(worker_dir "$id")"
  fi
  fsync_directory "$STATE_ROOT/transactions"
  fsync_directory "$dir"
}

acquire_control_lock() {
  local inherited_fd="${NEXUS_PROMOTION_INHERITED_CONTROL_LOCK_FD:-}"
  command -v flock >/dev/null 2>&1 || { echo "flock is required for promotion serialization" >&2; exit 1; }
  if [ -n "$inherited_fd" ]; then
    case "$inherited_fd" in
      *[!0-9]*|0|1|2) echo "inherited promotion control lock fd is invalid" >&2; exit 1 ;;
    esac
    [ -f "$STATE_ROOT/.control.lock" ] \
      && [ ! -L "$STATE_ROOT/.control.lock" ] \
      && [ -e "/dev/fd/$inherited_fd" ] \
      && [ "$STATE_ROOT/.control.lock" -ef "/dev/fd/$inherited_fd" ] || {
      echo "inherited promotion control lock identity is invalid" >&2
      exit 1
    }
    flock -n -x "$inherited_fd" || {
      echo "inherited promotion control lock is not held exclusively" >&2
      exit 1
    }
    return
  fi
  exec 9>"$STATE_ROOT/.control.lock"
  chmod 600 "$STATE_ROOT/.control.lock"; root_own "$STATE_ROOT/.control.lock"
  flock -x 9
}

validate_authorization_input() {
  local input="$1" mode uid
  [ -n "$input" ] && [ -f "$input" ] && [ ! -L "$input" ] || {
    echo "signed promotion authorization must be a non-symlink regular file" >&2
    exit 64
  }
  mode="$(stat -c '%a' "$input" 2>/dev/null || stat -f '%Lp' "$input")"
  case "$mode" in 400|600) ;; *) echo "signed promotion authorization mode must be 400 or 600" >&2; exit 64 ;; esac
  if [ "$EUID" -eq 0 ] && [ -n "${SUDO_UID:-}" ]; then
    uid="$(stat -c '%u' "$input" 2>/dev/null || stat -f '%u' "$input")"
    [ "$uid" = "$SUDO_UID" ] || { echo "signed promotion authorization owner mismatch" >&2; exit 77; }
  fi
}

read_active_fields() {
  node - "$STATE_ROOT/active.json" <<'NODE'
const fs=require('fs');const x=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
if(x.schema!=='nexus.promotion-active.v1'
 ||!/^[0-9]{8}T[0-9]{6}Z-[0-9]+-[a-f0-9]{12}$/u.test(x.transactionId||'')
 ||!/^[a-f0-9]{64}$/u.test(x.requestSha256||'')||!/^[a-f0-9]{64}$/u.test(x.envelopeSha256||''))process.exit(1);
process.stdout.write(`${x.transactionId}\t${x.requestSha256}\n`);
NODE
}

journal_status() {
  local id="$1" request_sha="$2" journal
  journal="$(journal_path "$id")"
  [ -f "$journal" ] && [ ! -L "$journal" ] || return 1
  node - "$journal" "$id" "$request_sha" <<'NODE'
const fs=require('fs');const [file,id,digest]=process.argv.slice(2);const x=JSON.parse(fs.readFileSync(file,'utf8'));
if(x.schema!=='nexus.promotion-transaction-journal.v1'||x.transactionId!==id||x.requestSha256!==digest)process.exit(1);
process.stdout.write(String(x.status||''));
NODE
}

journal_phase() {
  local id="$1" request_sha="$2" journal
  journal="$(journal_path "$id")"
  [ -f "$journal" ] && [ ! -L "$journal" ] || return 1
  node - "$journal" "$id" "$request_sha" <<'NODE'
const fs=require('fs');const [file,id,digest]=process.argv.slice(2);
const x=JSON.parse(fs.readFileSync(file,'utf8'));
if(x.schema!=='nexus.promotion-transaction-journal.v1'||x.transactionId!==id
 ||x.requestSha256!==digest||typeof x.phase!=='string')process.exit(1);
process.stdout.write(x.phase);
NODE
}

journal_terminal() {
  local status
  status="$(journal_status "$1" "$2")" || return 1
  case "$status" in completed|recovered|failed_before_stop) return 0 ;; *) return 1 ;; esac
}

clear_terminal_active() {
  local id request_sha
  [ -f "$STATE_ROOT/active.json" ] || return 0
  # Boot recovery retains the active transaction even after the temporary
  # daemon reports healthy. Only the real pm2-dominguez ExecStartPost proof may
  # clear this authority.
  [ ! -f "$BOOT_RECOVERY" ] || return 0
  IFS=$'\t' read -r id request_sha < <(read_active_fields) || {
    echo "authoritative active promotion state is invalid" >&2
    exit 1
  }
  validate_id "$id"
  if journal_terminal "$id" "$request_sha"; then durable_remove "$STATE_ROOT/active.json" 600; fi
}

clear_terminal_active_during_boot_finalization() {
  local id request_sha
  [ -f "$STATE_ROOT/active.json" ] || return 0
  [ -f "$BOOT_RECOVERY" ] && [ ! -L "$BOOT_RECOVERY" ] || {
    echo "boot recovery authority disappeared before active-state finalization" >&2
    return 1
  }
  IFS=$'\t' read -r id request_sha < <(read_active_fields) || {
    echo "authoritative active promotion state is invalid" >&2
    return 1
  }
  validate_id "$id"
  journal_terminal "$id" "$request_sha" || {
    echo "boot promotion transaction is not terminal after real service health" >&2
    return 1
  }
  durable_remove "$STATE_ROOT/active.json" 600
}

write_boot_recovery_authority() {
  local output active_id="" timing_file="" layout_journal
  layout_journal="$STATE_ROOT/layout-migration-in-progress.v1.json"
  if [ -f "$STATE_ROOT/active.json" ] && [ ! -L "$STATE_ROOT/active.json" ]; then
    local active_sha
    read -r active_id active_sha < <(read_active_fields)
    # A terminal transaction's historical cutover is not an outage on this
    # ordinary reboot. Its active marker remains until the real service proof,
    # but SLA timing begins at current boot detection.
    if ! journal_terminal "$active_id" "$active_sha"; then
      if [ -f "$(state_dir "$active_id")/recovery-attempt-timing.json" ]; then
        timing_file="$(state_dir "$active_id")/recovery-attempt-timing.json"
      elif [ -f "$(state_dir "$active_id")/cutover-timing.json" ]; then
        timing_file="$(state_dir "$active_id")/cutover-timing.json"
      fi
    fi
  fi
  output="$(durable_staging_file "$BOOT_RECOVERY" 600)"
  "$SYSTEM_NODE_BIN" - "$output" "$BOOT_RECOVERY" "$layout_journal" \
    "$timing_file" "$active_id" <<'NODE'
const fs=require('fs');
const [output,existingFile,layoutFile,timingFile,transactionId]=process.argv.slice(2);
const testMode=process.env.NEXUS_RELEASE_TEST_MODE==='1';
const bootId=testMode?(process.env.NEXUS_PROMOTION_TEST_BOOT_ID||'test-boot')
 :fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim();
const nowEpoch=Math.floor(Date.now()/1000);
const nowMonotonic=testMode
 ?Number(process.env.NEXUS_PROMOTION_TEST_MONOTONIC_SECONDS||1)
 :Math.floor(Number(fs.readFileSync('/proc/uptime','utf8').split(/\s+/u)[0]));
if(!Number.isSafeInteger(nowMonotonic)||nowMonotonic<0)process.exit(1);
const candidates=[];
const read=(file)=>{try{return JSON.parse(fs.readFileSync(file,'utf8'))}catch{return null}};
const existing=read(existingFile);
if(existing?.schema==='nexus.release-boot-recovery.v1'
 &&existing.status==='in_progress'
 &&Number.isSafeInteger(existing.outageStartedEpoch)
 &&Number.isSafeInteger(existing.outageStartedMonotonic)
 &&typeof existing.outageBootId==='string'){
 candidates.push({epoch:existing.outageStartedEpoch,monotonic:existing.outageStartedMonotonic,
  outageBootId:existing.outageBootId,startedAt:existing.outageStartedAt,source:existing.timingSource});
}
const layout=read(layoutFile);
if(layout?.schema==='nexus.release-layout-migration-journal.v1'){
 const epoch=Number.isSafeInteger(layout.productionAvailabilityRestoredEpoch)?nowEpoch
  :Number.isSafeInteger(layout.productionOutageStartedEpoch)?layout.productionOutageStartedEpoch:null;
 if(epoch!==null)candidates.push({epoch,
  monotonic:Number.isSafeInteger(layout.productionAvailabilityRestoredEpoch)?nowMonotonic
   :Number.isSafeInteger(layout.productionOutageStartedMonotonic)
    ?layout.productionOutageStartedMonotonic:nowMonotonic,
  outageBootId:Number.isSafeInteger(layout.productionAvailabilityRestoredEpoch)?bootId
   :typeof layout.productionOutageBootId==='string'?layout.productionOutageBootId:bootId,
  startedAt:new Date(epoch*1000).toISOString(),source:'layout_journal'});
}
const timing=timingFile?read(timingFile):null;
if(timing?.schema==='nexus.promotion-recovery-attempt-timing.v1'){
 const epoch=Math.floor(Date.parse(timing.measurementStartedAt)/1000);
 if(Number.isSafeInteger(epoch)&&Number.isSafeInteger(timing.startedMonotonicSeconds)
  &&typeof timing.bootId==='string')candidates.push({epoch,
   monotonic:timing.startedMonotonicSeconds,outageBootId:timing.bootId,
   startedAt:timing.measurementStartedAt,source:'promotion_recovery_attempt'});
}else if(timing?.schema==='nexus.promotion-cutover-timing.v1'){
 const epoch=Math.floor(Date.parse(timing.startedAt)/1000);
 if(Number.isSafeInteger(epoch)&&Number.isSafeInteger(timing.startedMonotonicSeconds)
  &&typeof timing.bootId==='string')candidates.push({epoch,
   monotonic:timing.startedMonotonicSeconds,outageBootId:timing.bootId,
   startedAt:timing.startedAt,source:'promotion_cutover'});
}
if(candidates.length===0)candidates.push({epoch:nowEpoch,monotonic:nowMonotonic,
 outageBootId:bootId,startedAt:new Date(nowEpoch*1000).toISOString(),source:'boot_detection'});
candidates.sort((a,b)=>a.epoch-b.epoch);
let origin=candidates[0];
if(!Number.isSafeInteger(origin.epoch)||origin.epoch>nowEpoch+1
 ||!Number.isSafeInteger(origin.monotonic)||origin.monotonic<0
 ||typeof origin.outageBootId!=='string'||!origin.outageBootId
 ||!Number.isFinite(Date.parse(origin.startedAt)))process.exit(1);
if(origin.epoch===nowEpoch+1){
 origin={epoch:nowEpoch,monotonic:nowMonotonic,outageBootId:bootId,
  startedAt:new Date(nowEpoch*1000).toISOString(),source:'boot_detection'};
}
fs.writeFileSync(output,`${JSON.stringify({
 schema:'nexus.release-boot-recovery.v1',status:'in_progress',bootId,
 bootDetectedAt:new Date(nowEpoch*1000).toISOString(),bootDetectedEpoch:nowEpoch,
 outageStartedAt:origin.startedAt,outageStartedEpoch:origin.epoch,
 outageStartedMonotonic:origin.monotonic,outageBootId:origin.outageBootId,
 recoveryDeadlineEpoch:origin.epoch+120,timingSource:origin.source,
 activeTransactionId:transactionId||null,
},null,2)}\n`,{mode:0o600,flag:'w'});
NODE
  chmod 600 "$output"; root_own "$output"
  durable_publish "$output" "$BOOT_RECOVERY" 600
}

finalize_boot_recovery() {
  [ -f "$BOOT_RECOVERY" ] && [ ! -L "$BOOT_RECOVERY" ] \
    && [ -f "$BOOT_PENDING" ] && [ ! -L "$BOOT_PENDING" ] \
    && [ -f "$BOOT_PROOF" ] && [ ! -L "$BOOT_PROOF" ] || {
    echo "boot recovery proof chain is incomplete" >&2
    return 1
  }
  "$SYSTEM_NODE_BIN" - "$BOOT_RECOVERY" "$BOOT_PENDING" "$BOOT_PROOF" <<'NODE'
const crypto=require('crypto');const fs=require('fs');
const [recoveryFile,pendingFile,proofFile]=process.argv.slice(2);
const recoveryBody=fs.readFileSync(recoveryFile),pendingBody=fs.readFileSync(pendingFile);
const recovery=JSON.parse(recoveryBody),pending=JSON.parse(pendingBody);
const proof=JSON.parse(fs.readFileSync(proofFile));
const digest=(body)=>crypto.createHash('sha256').update(body).digest('hex');
if(recovery.schema!=='nexus.release-boot-recovery.v1'||recovery.status!=='in_progress'
 ||pending.schema!=='nexus.release-boot-health-pending.v3'||pending.status!=='pending'
 ||proof.schema!=='nexus.release-boot-health-proof.v2'||proof.status!=='passed'
 ||proof.pendingSha256!==digest(pendingBody)
 ||pending.recoveryAuthoritySha256!==digest(recoveryBody)
 ||proof.canonicalDumpSha256!==pending.canonicalDumpSha256
 ||proof.bootId!==recovery.bootId||proof.outageBootId!==recovery.outageBootId
 ||proof.targetMet!==true||proof.recoveryTargetSeconds!==120
 ||!Number.isSafeInteger(proof.outageToActualServiceHealthySeconds)
 ||proof.outageToActualServiceHealthySeconds<0
 ||proof.outageToActualServiceHealthySeconds>120)process.exit(1);
NODE
  if [ -f "$STATE_ROOT/active.json" ]; then
    local transaction_id request_sha journal temporary
    IFS=$'\t' read -r transaction_id request_sha < <(read_active_fields)
    journal="$(journal_path "$transaction_id")"
    journal_terminal "$transaction_id" "$request_sha" || {
      echo "boot promotion transaction is not terminal after real service health" >&2
      return 1
    }
    temporary="$(durable_staging_file "$journal" 600)"
    "$SYSTEM_NODE_BIN" - "$journal" "$BOOT_PROOF" "$temporary" <<'NODE'
const crypto=require('crypto');const fs=require('fs');
const [journalFile,proofFile,output]=process.argv.slice(2);
const journal=JSON.parse(fs.readFileSync(journalFile)),proofBody=fs.readFileSync(proofFile);
fs.writeFileSync(output,`${JSON.stringify({...journal,
 bootRecovery:{schema:'nexus.promotion-boot-recovery-proof.v1',
  proofSha256:crypto.createHash('sha256').update(proofBody).digest('hex'),
  actualServiceHealthyAt:JSON.parse(proofBody).actualServiceHealthyAt,
  outageToActualServiceHealthySeconds:JSON.parse(proofBody).outageToActualServiceHealthySeconds,
  targetMet:true},
 updatedAt:new Date().toISOString()},null,2)}\n`,{mode:0o600,flag:'w'});
NODE
    chmod 600 "$temporary"; root_own "$temporary"
    durable_publish "$temporary" "$journal" 600
  fi
  # BOOT_RECOVERY remains the durable admission blocker until all subordinate
  # mutable authority is gone. A crash before the final unlink is therefore
  # reconstructed by recover-all; a crash after it cannot leave orphaned
  # pending health or active promotion state.
  clear_terminal_active_during_boot_finalization
  durable_remove "$BOOT_PENDING" 600
  durable_remove "$BOOT_RECOVERY" 600
}

resolve_boot_sla_incident() {
  local expected_digest="$1" observed_digest archive_dir archive temporary
  [[ "$expected_digest" =~ ^[a-f0-9]{64}$ ]] || {
    echo "exact boot SLA proof digest is required" >&2
    return 64
  }
  archive_dir="$STATE_ROOT/boot-recovery-incidents"
  archive="$archive_dir/${expected_digest}.resolution.json"
  [ -f "$BOOT_RECOVERY" ] && [ ! -L "$BOOT_RECOVERY" ] \
    && [ -f "$BOOT_PROOF" ] && [ ! -L "$BOOT_PROOF" ] \
    && { { [ -f "$BOOT_PENDING" ] && [ ! -L "$BOOT_PENDING" ]; } \
      || { [ -f "$archive" ] && [ ! -L "$archive" ]; }; } || {
    echo "no unresolved boot SLA incident exists" >&2
    return 75
  }
  observed_digest="$(sha256sum "$BOOT_PROOF" | cut -d' ' -f1)"
  [ "$observed_digest" = "$expected_digest" ] || {
    echo "boot SLA incident proof digest changed" >&2
    return 73
  }
  if [ -f "$BOOT_PENDING" ]; then
    "$SYSTEM_NODE_BIN" - "$BOOT_RECOVERY" "$BOOT_PENDING" "$BOOT_PROOF" <<'NODE'
const crypto=require('crypto');const fs=require('fs');
const [recoveryFile,pendingFile,proofFile]=process.argv.slice(2);
const recoveryBody=fs.readFileSync(recoveryFile),pendingBody=fs.readFileSync(pendingFile);
const recovery=JSON.parse(recoveryBody),pending=JSON.parse(pendingBody);
const proof=JSON.parse(fs.readFileSync(proofFile));
const digest=(body)=>crypto.createHash('sha256').update(body).digest('hex');
if(recovery.schema!=='nexus.release-boot-recovery.v1'||recovery.status!=='in_progress'
 ||pending.schema!=='nexus.release-boot-health-pending.v3'||pending.status!=='pending'
 ||proof.schema!=='nexus.release-boot-health-proof.v2'
 ||proof.status!=='healthy_sla_missed'||proof.targetMet!==false
 ||proof.pendingSha256!==digest(pendingBody)
 ||pending.recoveryAuthoritySha256!==digest(recoveryBody)
 ||proof.canonicalDumpSha256!==pending.canonicalDumpSha256
 ||!Number.isSafeInteger(proof.outageToActualServiceHealthySeconds)
 ||proof.outageToActualServiceHealthySeconds<=120)process.exit(1);
NODE
  else
    "$SYSTEM_NODE_BIN" - "$BOOT_RECOVERY" "$BOOT_PROOF" "$archive" \
      "$expected_digest" "${NEXUS_RELEASE_TEST_MODE:-0}" <<'NODE'
const crypto=require('crypto');const fs=require('fs');
const [recoveryFile,proofFile,resolutionFile,proofSha256,testMode]=process.argv.slice(2);
const rootUid=testMode==='1'?process.getuid():0;
const rootGid=testMode==='1'?process.getgid():0;
const readSafe=(file)=>{
 const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));
 try{
  const stat=fs.fstatSync(fd),body=fs.readFileSync(fd);
  if(!stat.isFile()||stat.nlink!==1||stat.uid!==rootUid||stat.gid!==rootGid
   ||(stat.mode&0o7777)!==0o600)process.exit(1);
  return {body,value:JSON.parse(body)};
 }finally{fs.closeSync(fd);}
};
const recovery=readSafe(recoveryFile),proof=readSafe(proofFile),resolution=readSafe(resolutionFile);
const digest=(body)=>crypto.createHash('sha256').update(body).digest('hex');
if(digest(proof.body)!==proofSha256
 ||recovery.value.schema!=='nexus.release-boot-recovery.v1'
 ||proof.value.schema!=='nexus.release-boot-health-proof.v2'
 ||proof.value.status!=='healthy_sla_missed'||proof.value.targetMet!==false
 ||resolution.value.schema!=='nexus.release-boot-sla-incident-resolution.v1'
 ||resolution.value.proofSha256!==proofSha256
 ||resolution.value.recoveryAuthoritySha256!==digest(recovery.body)
 ||resolution.value.pendingSha256!==proof.value.pendingSha256)process.exit(1);
NODE
  fi
  [ "$("$SYSTEMCTL_BIN" show pm2-dominguez.service -p ActiveState --value)" = active ] \
    && [ "$("$SYSTEMCTL_BIN" show pm2-dominguez.service -p SubState --value)" = running ] || {
    echo "cannot resolve a boot SLA incident without the exact healthy service" >&2
    return 1
  }
  if [ -f "$STATE_ROOT/active.json" ]; then
    local transaction_id request_sha journal journal_next
    IFS=$'\t' read -r transaction_id request_sha < <(read_active_fields)
    journal="$(journal_path "$transaction_id")"
    journal_terminal "$transaction_id" "$request_sha" || {
      echo "cannot resolve boot SLA incident with a nonterminal promotion" >&2
      return 1
    }
  fi
  if [ "${NEXUS_RELEASE_TEST_MODE:-0}" = 1 ]; then
    install -d -m 700 "$archive_dir"
  else
    install -d -o root -g root -m 700 "$archive_dir"
  fi
  if [ ! -e "$archive" ] && [ ! -L "$archive" ]; then
    temporary="$(durable_staging_file "$archive" 600)"
    "$SYSTEM_NODE_BIN" - "$BOOT_RECOVERY" "$BOOT_PENDING" "$BOOT_PROOF" \
      "$temporary" "$expected_digest" <<'NODE'
const crypto=require('crypto');const fs=require('fs');
const [recovery,pending,proof,output,proofSha256]=process.argv.slice(2);
const digest=(file)=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const value=JSON.parse(fs.readFileSync(proof));
fs.writeFileSync(output,`${JSON.stringify({
 schema:'nexus.release-boot-sla-incident-resolution.v1',status:'owner_acknowledged',
 proofSha256,recoveryAuthoritySha256:digest(recovery),pendingSha256:digest(pending),
 actualServiceHealthyAt:value.actualServiceHealthyAt,
 outageToActualServiceHealthySeconds:value.outageToActualServiceHealthySeconds,
 acknowledgedAt:new Date().toISOString(),
},null,2)}\n`,{mode:0o600,flag:'w'});
NODE
    chmod 600 "$temporary"; root_own "$temporary"
    durable_publish "$temporary" "$archive" 600
  else
    [ -f "$archive" ] && [ ! -L "$archive" ] || {
      echo "boot SLA incident resolution archive is unsafe" >&2
      return 73
    }
  fi
  if [ -f "$STATE_ROOT/active.json" ]; then
    journal_next="$(durable_staging_file "$journal" 600)"
    "$SYSTEM_NODE_BIN" - "$journal" "$archive" "$journal_next" <<'NODE'
const crypto=require('crypto');const fs=require('fs');
const [journalFile,resolutionFile,output]=process.argv.slice(2);
const journal=JSON.parse(fs.readFileSync(journalFile)),resolution=JSON.parse(fs.readFileSync(resolutionFile));
fs.writeFileSync(output,`${JSON.stringify({...journal,
 bootRecovery:{schema:'nexus.promotion-boot-recovery-proof.v1',
  incidentResolutionSha256:crypto.createHash('sha256').update(fs.readFileSync(resolutionFile)).digest('hex'),
  actualServiceHealthyAt:resolution.actualServiceHealthyAt,
  outageToActualServiceHealthySeconds:resolution.outageToActualServiceHealthySeconds,
  targetMet:false,ownerAcknowledgedAt:resolution.acknowledgedAt},
 updatedAt:new Date().toISOString()},null,2)}\n`,{mode:0o600,flag:'w'});
NODE
    chmod 600 "$journal_next"; root_own "$journal_next"
    durable_publish "$journal_next" "$journal" 600
  fi
  # Keep BOOT_RECOVERY as the admission blocker until every subordinate
  # authority is gone. This ordering also makes an interrupted owner
  # acknowledgement resumable from the durable resolution archive.
  clear_terminal_active_during_boot_finalization
  durable_remove "$BOOT_PENDING" 600
  durable_remove "$BOOT_RECOVERY" 600
  printf '{"ok":true,"schema":"nexus.release-boot-sla-incident-resolution.v1","status":"owner_acknowledged","proofSha256":"%s"}\n' \
    "$expected_digest"
}

validate_prelayout_boot_marker() {
  local expected_digest="$1"
  "$SYSTEM_NODE_BIN" - "$BOOT_RECOVERY" "$expected_digest" \
    "${NEXUS_RELEASE_TEST_MODE:-0}" <<'NODE'
const crypto=require('crypto');const fs=require('fs');
const [file,expectedDigest,testMode]=process.argv.slice(2);
const rootUid=testMode==='1'?process.getuid():0;
const rootGid=testMode==='1'?process.getgid():0;
const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));
try{
 const before=fs.fstatSync(fd),body=fs.readFileSync(fd),after=fs.fstatSync(fd);
 const value=JSON.parse(body),digest=crypto.createHash('sha256').update(body).digest('hex');
 const currentBootId=testMode==='1'
  ?(process.env.NEXUS_PROMOTION_TEST_BOOT_ID||'test-boot')
  :fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim();
 if(!before.isFile()||before.nlink!==1||before.uid!==rootUid||before.gid!==rootGid
  ||(before.mode&0o7777)!==0o600||before.dev!==after.dev||before.ino!==after.ino
  ||before.size!==after.size||before.mtimeMs!==after.mtimeMs
  ||digest!==expectedDigest
  ||value.schema!=='nexus.release-boot-recovery.v1'||value.status!=='in_progress'
  ||value.bootId!==currentBootId||value.outageBootId!==currentBootId
  ||value.timingSource!=='boot_detection'||value.activeTransactionId!==null
  ||!Number.isSafeInteger(value.bootDetectedEpoch)
  ||!Number.isSafeInteger(value.outageStartedEpoch)
  ||value.bootDetectedEpoch!==value.outageStartedEpoch
  ||value.bootDetectedAt!==value.outageStartedAt
  ||!Number.isSafeInteger(value.outageStartedMonotonic)
  ||value.outageStartedMonotonic<0
  ||value.recoveryDeadlineEpoch!==value.outageStartedEpoch+120
  ||!Number.isFinite(Date.parse(value.bootDetectedAt)))process.exit(1);
 process.stdout.write(JSON.stringify(value));
}finally{fs.closeSync(fd);}
NODE
}

assert_no_unfinished_staging_transaction() {
  "$SYSTEM_NODE_BIN" - "$STATE_ROOT/staging" "${NEXUS_RELEASE_TEST_MODE:-0}" <<'NODE'
const fs=require('fs');const path=require('path');
const [directory,testMode]=process.argv.slice(2);
const rootUid=testMode==='1'?process.getuid():0;
const rootGid=testMode==='1'?process.getgid():0;
for(const name of fs.readdirSync(directory)){
 if(!name.endsWith('.transaction.json'))continue;
 const file=path.join(directory,name);
 const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));
 try{
  const before=fs.fstatSync(fd),body=fs.readFileSync(fd),after=fs.fstatSync(fd);
  const value=JSON.parse(body);
  if(!before.isFile()||before.nlink!==1||before.uid!==rootUid
   ||before.gid!==rootGid||(before.mode&0o7777)!==0o600
   ||before.dev!==after.dev||before.ino!==after.ino
   ||before.size!==after.size||before.mtimeMs!==after.mtimeMs
   ||value.schema!=='nexus.staging-attestation-transaction.v1'
   ||!['completed','recovered'].includes(value.phase))process.exit(1);
 }finally{fs.closeSync(fd);}
}
NODE
}

validate_live_prelayout_proof() {
  local marker_json="$1" proof_json="$2" worker_uid worker_gid
  worker_uid="$(/usr/bin/id -u "$WORKER_USER")"
  worker_gid="$(/usr/bin/id -g "$WORKER_USER")"
  "$SYSTEM_NODE_BIN" - "$marker_json" "$proof_json" \
    "$COMPAT_PRODUCTION" "$COMPAT_STAGING" "$PHASE_A_RECEIPT" \
    "${NEXUS_RELEASE_TEST_MODE:-0}" "$worker_uid" "$worker_gid" \
    /home/linuxbrew/.linuxbrew/Cellar/node <<'NODE'
const crypto=require('crypto');const fs=require('fs');const path=require('path');
const [markerRaw,proofRaw,productionBase,stagingBase,phaseAReceipt,testMode,
 workerUidRaw,workerGidRaw,legacyNodeRoot]
 =process.argv.slice(2);
const marker=JSON.parse(markerRaw),proof=JSON.parse(proofRaw);
const digest=/^[a-f0-9]{64}$/u,sha=/^[a-f0-9]{40}$/u,digits=/^[0-9]+$/u;
const rootUid=testMode==='1'?process.getuid():0,rootGid=testMode==='1'?process.getgid():0;
const workerUid=Number(workerUidRaw),workerGid=Number(workerGidRaw);
const receiptFd=fs.openSync(phaseAReceipt,
 fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));
let receiptBody,receipt;
try{
 const before=fs.fstatSync(receiptFd);receiptBody=fs.readFileSync(receiptFd);
 const after=fs.fstatSync(receiptFd);receipt=JSON.parse(receiptBody);
 if(!before.isFile()||before.nlink!==1||before.uid!==rootUid||before.gid!==rootGid
  ||(before.mode&0o7777)!==0o600||before.dev!==after.dev||before.ino!==after.ino
  ||before.size!==after.size||before.mtimeMs!==after.mtimeMs)process.exit(1);
}finally{fs.closeSync(receiptFd);}
const requiredChecks=new Set(['phase_a_service_receipt',
 'legacy_real_systemd_daemon_identity',
 'future_root_pm2_attestation','four_exact_pm2_apps_stable','production_authenticated_readiness',
 'staging_authenticated_readiness','legacy_selector_and_runtime_identity_stable']);
const role=(value,name,base)=>value?.name===name&&value.base===base
 &&path.dirname(value.runtime)===path.join(base,'releases')
 &&sha.test(value.runtimeSha||'')&&digest.test(value.artifactDigest||'')
 &&digest.test(value.installedRuntimeDigest||'')
 &&digits.test(value.selector?.dev||'')&&digits.test(value.selector?.ino||'')
 &&digits.test(value.runtimeIdentity?.dev||'')&&digits.test(value.runtimeIdentity?.ino||'')
 &&digest.test(value.markerSha256||'')
 &&digest.test(value.installedAttestationSha256||'');
const service=proof.pm2Dominguez;
const executablePath=service?.executable?.path??'';
const relativeExecutable=path.relative(legacyNodeRoot,executablePath).split(path.sep);
const checks=[
 ['marker_authority',marker.timingSource==='boot_detection'
   &&marker.activeTransactionId===null],
 ['proof_schema',proof.schema==='nexus.release-live-prelayout-health-proof.v1'
   &&proof.status==='verified_no_mutation'],
 ['no_mutation',Array.isArray(proof.mutationOperations)
   &&proof.mutationOperations.length===0],
 ['required_checks',Array.isArray(proof.checks)
   &&[...requiredChecks].every((check)=>proof.checks.includes(check))],
 ['service_authority',service?.activeState==='active'&&service?.subState==='running'
   &&Number.isSafeInteger(service.mainPid)&&service.mainPid>0
   &&service.controlGroup==='/system.slice/pm2-dominguez.service'
   &&Number.isSafeInteger(service.execMainStartTimestampMonotonic)
   &&service.execMainStartTimestampMonotonic>0
   &&service.execMainStartTimestampMonotonic
     <=(marker.outageStartedMonotonic+1)*1_000_000
   &&service.nRestarts===0&&digest.test(service.unitRuntimeSha256||'')],
 ['legacy_observed_executable',
   service?.executable?.classification==='worker_owned_legacy_observation'
   &&service?.executable?.ancestryPolicy
     ==='linuxbrew_worker_owned_no_world_write'
   &&path.isAbsolute(executablePath)
   &&relativeExecutable.length===3
   &&/^[0-9]+\.[0-9]+\.[0-9]+$/u.test(relativeExecutable[0])
   &&relativeExecutable[1]==='bin'&&relativeExecutable[2]==='node'
   &&digest.test(service?.executable?.sha256||'')
   &&digits.test(service?.executable?.dev||'')
   &&digits.test(service?.executable?.ino||'')
   &&Number.isSafeInteger(workerUid)&&Number.isSafeInteger(workerGid)
   &&service?.executable?.uid===workerUid
   &&service?.executable?.gid===workerGid
   &&service?.executable?.mode===0o555],
 ['phase_a_receipt',receipt.schema==='nexus.release-layout-phase-a-receipt.v1'
   &&receipt.status==='completed'&&receipt.sourceSha===proof.phaseA?.sourceSha
   &&receipt.sourceArchiveSha256===proof.phaseA?.sourceArchiveSha256
   &&crypto.createHash('sha256').update(receiptBody).digest('hex')
     ===proof.phaseA?.receiptSha256],
 ['phase_a_identity',sha.test(proof.phaseA?.sourceSha||'')
   &&digest.test(proof.phaseA?.receiptSha256||'')
   &&digest.test(proof.phaseA?.sourceArchiveSha256||'')
   &&digest.test(proof.phaseA?.existingServiceRuntimeSha256||'')
   &&digest.test(proof.phaseA?.pm2PrerequisiteEvidenceSha256||'')
   &&digest.test(proof.phaseA?.unitCatSha256||'')
   &&digest.test(proof.phaseA?.unitShowSha256||'')
   &&Number.isFinite(Date.parse(proof.phaseA?.completedAt||''))
   &&Date.parse(proof.phaseA.completedAt)<=Date.parse(marker.bootDetectedAt)],
 ['future_pm2',digest.test(proof.futureRootPm2Attestation?.closureDigest||'')
   &&digest.test(proof.futureRootPm2Attestation?.nodeSha256||'')],
 ['production_role',role(proof.production,'production',productionBase)],
 ['staging_role',role(proof.staging,'staging',stagingBase)],
 ['verified_at',Number.isFinite(Date.parse(proof.verifiedAt||''))],
];
const failed=checks.find(([,passed])=>!passed);
if(failed){process.stderr.write(`live pre-layout proof check failed: ${failed[0]}\n`);process.exit(1);}
NODE
}

validate_prelayout_resolution_archive() {
  local archive="$1" expected_digest="$2" expected_marker_json="${3:-}"
  "$SYSTEM_NODE_BIN" - "$archive" "$expected_digest" "$expected_marker_json" \
    "${NEXUS_RELEASE_TEST_MODE:-0}" <<'NODE'
const fs=require('fs');const [file,digest,expectedMarkerRaw,testMode]=process.argv.slice(2);
const rootUid=testMode==='1'?process.getuid():0,rootGid=testMode==='1'?process.getgid():0;
const canonical=(value)=>value===null||typeof value!=='object'?JSON.stringify(value)
 :Array.isArray(value)?`[${value.map(canonical).join(',')}]`
 :`{${Object.keys(value).sort().map((key)=>`${JSON.stringify(key)}:${
  canonical(value[key])}`).join(',')}}`;
const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));
try{
 const before=fs.fstatSync(fd),body=fs.readFileSync(fd),after=fs.fstatSync(fd);
 const value=JSON.parse(body),proof=value.liveHealthProof,marker=value.marker;
 const expectedMarker=expectedMarkerRaw?JSON.parse(expectedMarkerRaw):null;
 if(!before.isFile()||before.nlink!==1||before.uid!==rootUid||before.gid!==rootGid
  ||(before.mode&0o7777)!==0o600||before.dev!==after.dev||before.ino!==after.ino
  ||before.size!==after.size||before.mtimeMs!==after.mtimeMs
  ||value.schema!=='nexus.release-prelayout-boot-recovery-resolution.v1'
  ||value.status!=='reconciled_no_mutation'||value.markerSha256!==digest
  ||marker?.schema!=='nexus.release-boot-recovery.v1'
  ||marker?.status!=='in_progress'||marker?.timingSource!=='boot_detection'
  ||marker?.activeTransactionId!==null
  ||(expectedMarker&&canonical(marker)!==canonical(expectedMarker))
  ||proof?.schema!=='nexus.release-live-prelayout-health-proof.v1'
  ||proof?.status!=='verified_no_mutation'
  ||!Array.isArray(proof?.mutationOperations)||proof.mutationOperations.length!==0
  ||!/^[a-f0-9]{64}$/u.test(proof?.phaseA?.receiptSha256||'')
  ||!Number.isFinite(Date.parse(value.resolvedAt||'')))process.exit(1);
}finally{fs.closeSync(fd);}
NODE
}

resolve_prelayout_boot_recovery() {
  local expected_digest="$1" archive_dir archive marker_json proof_json
  local repeated_marker temporary
  [[ "$expected_digest" =~ ^[a-f0-9]{64}$ ]] || {
    echo "resolve-prelayout-boot-recovery requires the exact marker SHA-256" >&2
    return 64
  }
  archive_dir="$STATE_ROOT/boot-recovery-incidents"
  archive="$archive_dir/${expected_digest}.prelayout-resolution.json"
  if [ ! -e "$BOOT_RECOVERY" ] && [ ! -L "$BOOT_RECOVERY" ]; then
    [ -f "$archive" ] && [ ! -L "$archive" ] || {
      echo "no unresolved pre-layout boot recovery marker exists" >&2
      return 75
    }
    validate_prelayout_resolution_archive "$archive" "$expected_digest" || {
      echo "pre-layout reconciliation archive is invalid" >&2
      return 73
    }
    printf '{"ok":true,"schema":"nexus.release-prelayout-boot-recovery-resolution.v1","status":"reconciled_no_mutation","markerSha256":"%s","idempotent":true}\n' \
      "$expected_digest"
    return 0
  fi
  [ -f "$BOOT_RECOVERY" ] && [ ! -L "$BOOT_RECOVERY" ] || {
    echo "pre-layout boot recovery marker is unsafe" >&2
    return 73
  }
  marker_json="$(validate_prelayout_boot_marker "$expected_digest")" || {
    echo "pre-layout boot recovery marker does not match the governed live scenario" >&2
    return 73
  }
  for forbidden in "$BOOT_PENDING" "$BOOT_PROOF" "$STATE_ROOT/active.json" \
    "$STATE_ROOT/layout-migration-in-progress.v1.json" "$LAYOUT_ACTIVATION_ACTIVE" \
    "$LAYOUT_ATTESTATION" "$LAYOUT_RESULT" "$LAYOUT_TERMINAL_JOURNAL" \
    "$LAYOUT_REQUEST" "$LAYOUT_DRILL"; do
    [ ! -e "$forbidden" ] && [ ! -L "$forbidden" ] || {
      echo "release or layout authority changed; pre-layout reconciliation refused" >&2
      return 75
    }
  done
  assert_no_unfinished_staging_transaction || {
    echo "an unfinished or unsafe staging transaction blocks pre-layout reconciliation" >&2
    return 75
  }
  if [ -e "$archive" ] || [ -L "$archive" ]; then
    [ -f "$archive" ] && [ ! -L "$archive" ] \
      && validate_prelayout_resolution_archive \
        "$archive" "$expected_digest" "$marker_json" || {
      echo "pre-layout reconciliation archive differs from current authority" >&2
      return 73
    }
    durable_remove "$BOOT_RECOVERY" 600
    printf '{"ok":true,"schema":"nexus.release-prelayout-boot-recovery-resolution.v1","status":"reconciled_no_mutation","markerSha256":"%s","idempotent":false,"resumedArchive":true}\n' \
      "$expected_digest"
    return 0
  fi
  proof_json="$("$BOOT_HEALTH_BIN" verify-live-prelayout)" || {
    echo "live pre-layout PM2 and release verification failed" >&2
    return 1
  }
  validate_live_prelayout_proof "$marker_json" "$proof_json" || {
    echo "live pre-layout verification proof is invalid" >&2
    return 73
  }
  repeated_marker="$(validate_prelayout_boot_marker "$expected_digest")" || {
    echo "pre-layout boot recovery marker changed during verification" >&2
    return 73
  }
  [ "$repeated_marker" = "$marker_json" ] || {
    echo "pre-layout boot recovery authority changed during verification" >&2
    return 73
  }
  install -d -m 700 "$archive_dir"
  root_own "$archive_dir"
  if [ ! -e "$archive" ] && [ ! -L "$archive" ]; then
    temporary="$(durable_staging_file "$archive" 600)"
    "$SYSTEM_NODE_BIN" - "$temporary" "$expected_digest" "$marker_json" \
      "$proof_json" <<'NODE'
const fs=require('fs');
const [output,markerSha256,markerRaw,proofRaw]=process.argv.slice(2);
fs.writeFileSync(output,`${JSON.stringify({
 schema:'nexus.release-prelayout-boot-recovery-resolution.v1',
 status:'reconciled_no_mutation',markerSha256,
 marker:JSON.parse(markerRaw),liveHealthProof:JSON.parse(proofRaw),
 resolvedAt:new Date().toISOString(),
},null,2)}\n`,{mode:0o600,flag:'w'});
NODE
    chmod 600 "$temporary"; root_own "$temporary"
    durable_publish "$temporary" "$archive" 600
  else
    [ -f "$archive" ] && [ ! -L "$archive" ] || {
      echo "pre-layout reconciliation archive is unsafe" >&2
      return 73
    }
    validate_prelayout_resolution_archive \
      "$archive" "$expected_digest" "$marker_json" || {
      echo "pre-layout reconciliation archive differs from current authority" >&2
      return 73
    }
  fi
  durable_remove "$BOOT_RECOVERY" 600
  printf '{"ok":true,"schema":"nexus.release-prelayout-boot-recovery-resolution.v1","status":"reconciled_no_mutation","markerSha256":"%s","idempotent":false}\n' \
    "$expected_digest"
}

write_active() {
  local id="$1" request_sha="$2" envelope_sha="$3" output
  [ ! -e "$BOOT_RECOVERY" ] && [ ! -L "$BOOT_RECOVERY" ] || {
    echo "cannot activate a promotion while boot recovery is unresolved" >&2
    return 75
  }
  output="$(durable_staging_file "$STATE_ROOT/active.json" 600)"
  node - "$output" "$id" "$request_sha" "$envelope_sha" <<'NODE'
const fs=require('fs');const [output,transactionId,requestSha256,envelopeSha256]=process.argv.slice(2);
fs.writeFileSync(output,`${JSON.stringify({schema:'nexus.promotion-active.v1',transactionId,requestSha256,
 envelopeSha256,activatedAt:new Date().toISOString()},null,2)}\n`,{mode:0o600,flag:'w'});
NODE
  chmod 600 "$output"; root_own "$output"
  durable_publish "$output" "$STATE_ROOT/active.json" 600
}

active_matches() {
  local actual_id actual_sha
  [ -f "$STATE_ROOT/active.json" ] || return 1
  IFS=$'\t' read -r actual_id actual_sha < <(read_active_fields) || return 1
  [ "$actual_id" = "$1" ] && [ "$actual_sha" = "$2" ]
}

write_recovery_control() {
  local id="$1" output temporary
  ensure_transaction_dirs "$id"
  output="$(control_dir "$id")/recover"
  temporary="$(durable_staging_file "$output" 644)"
  printf '%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$temporary"
  chmod 644 "$temporary"; root_own "$temporary"
  durable_publish "$temporary" "$output" 644
}

validate_runtime_target() {
  local runtime="$1" base="$2"
  [ "$base" = "$PRODUCTION_BASE" ] \
    && [ "$runtime" != "$base/releases" ] \
    && [[ "$runtime" == "$base"/releases/* ]] || {
    echo "unsafe production runtime target" >&2
    exit 64
  }
}

validate_staging_runtime_target() {
  local runtime="$1" base="$2"
  [ "$base" = "$STAGING_BASE" ] \
    && [ "$runtime" != "$base/releases" ] \
    && [[ "$runtime" == "$base"/releases/* ]] || {
    echo "unsafe staging runtime target" >&2
    exit 64
  }
}

harden_release_anchors() {
  local base="$1" role="${2:-release}" worker_uid worker_gid worker_group current_target
  [ -d "$RELEASE_ROOT" ] && [ ! -L "$RELEASE_ROOT" ] \
    && [ "$(readlink -f "$RELEASE_ROOT")" = "$RELEASE_ROOT" ] || {
    echo "authoritative release root is not a canonical directory" >&2
    exit 1
  }
  if [ "${NEXUS_RELEASE_TEST_MODE:-0}" != "1" ]; then
    [ "$(stat -c '%U:%G:%a' "$RELEASE_ROOT")" = root:root:755 ] || {
      echo "authoritative release root ownership or mode is unsafe" >&2
      exit 1
    }
  fi
  [ -d "$base" ] && [ ! -L "$base" ] && [ "$(readlink -f "$base")" = "$base" ] || {
    echo "$role base is not a canonical directory" >&2
    exit 1
  }
  [ -d "$base/releases" ] && [ ! -L "$base/releases" ] \
    && [ "$(readlink -f "$base/releases")" = "$base/releases" ] || {
    echo "$role releases directory is not canonical" >&2
    exit 1
  }
  worker_uid="$(id -u "$WORKER_USER")"; worker_gid="$(id -g "$WORKER_USER")"; worker_group="$(id -gn "$WORKER_USER")"
  chown root:"$worker_group" "$base" "$base/releases"
  chmod 1770 "$base"
  chmod 0750 "$base/releases"
  if [ -e "$base/current" ] || [ -L "$base/current" ]; then
    [ -L "$base/current" ] || { echo "production current entry is not a symlink" >&2; exit 1; }
    current_target="$(readlink -f "$base/current")"
    [[ "$current_target" == "$base"/releases/* ]] || { echo "production current target is unsafe" >&2; exit 1; }
    # Never adopt a deploy-user selector: validating then chowning would let a
    # same-user rename race bless an attacker-selected target.
    if [ "${NEXUS_RELEASE_TEST_MODE:-0}" = "1" ]; then
      [ "$(stat -c '%u:%g' "$base/current")" = "$(id -u):$(id -g)" ] || {
        echo "release current selector owner is unsafe" >&2
        exit 1
      }
    else
      [ "$(stat -c '%U:%G' "$base/current")" = root:root ] || {
        echo "release current selector must already be root-owned" >&2
        exit 1
      }
    fi
  fi
}

ensure_release_layout() {
  local base="$1" role="$2" worker_group
  worker_group="$(id -gn "$WORKER_USER")"
  install -d -o root -g root -m 755 "$RELEASE_ROOT"
  install -d -o root -g "$worker_group" -m 1770 "$base"
  install -d -o root -g "$worker_group" -m 0750 "$base/releases"
  if [ ! -e "$base/data" ]; then
    install -d -o "$WORKER_USER" -g "$worker_group" -m 0700 "$base/data"
  fi
  if [ ! -e "$base/logs" ]; then
    install -d -o "$WORKER_USER" -g "$worker_group" -m 0700 "$base/logs"
  fi
  harden_release_anchors "$base" "$role"
}

prepare_runtime_target() {
  local runtime="$1" base="$2" role="$3" worker_uid worker_gid identity writable
  harden_release_anchors "$base" "$role"
  worker_uid="$(id -u "$WORKER_USER")"; worker_gid="$(id -g "$WORKER_USER")"
  if [ -e "$runtime" ] || [ -L "$runtime" ]; then
    [ -d "$runtime" ] && [ ! -L "$runtime" ] && [ "$(readlink -f "$runtime")" = "$runtime" ] || {
      echo "existing $role runtime target is unsafe" >&2
      exit 1
    }
    identity="$(stat -c '%u:%g:%a' "$runtime")"
    if [ "$identity" = "$worker_uid:$worker_gid:700" ]; then writable=true
    elif [ "$identity" = "0:$worker_gid:550" ]; then writable=false
    else echo "existing $role runtime target has an unsafe ownership state" >&2; exit 1
    fi
  else
    install -d -o "$WORKER_USER" -g "$(id -gn "$WORKER_USER")" -m 700 "$runtime"
    writable=true
  fi
  printf '{"ok":true,"runtime":"%s","writable":%s}\n' "$runtime" "$writable"
}

assert_root_installed_attestors() {
  local candidate identity
  for candidate in "$TRUSTED_ATTESTOR" "$RECOVERY_ATTESTOR" "$FILESYSTEM_IDENTITY" \
    "$SELECTOR_SWITCH" "$STAGING_BROKER"; do
    [ -f "$candidate" ] && [ ! -L "$candidate" ] || {
      echo "root-installed staging attestor is unavailable" >&2
      exit 1
    }
    if [ "${NEXUS_RELEASE_TEST_MODE:-0}" != "1" ]; then
      identity="$(stat -c '%U:%G' "$candidate")"
      [ "$identity" = root:root ] || {
        echo "root-installed staging attestor owner is unsafe" >&2
        exit 1
      }
    fi
  done
}

emit_staging_runtime_evidence() {
  local binding="$1" recovery="$2"
  "$SYSTEM_NODE_BIN" - "$binding" "$recovery" <<'NODE'
const fs=require('fs');
const [bindingPath,recoveryPath]=process.argv.slice(2);
const binding=JSON.parse(fs.readFileSync(bindingPath,'utf8'));
const recoveryRuntimeAttestation=JSON.parse(fs.readFileSync(recoveryPath,'utf8'));
process.stdout.write(`${JSON.stringify({
  schema:'nexus.trusted-staging-runtime-evidence.v1',
  binding,
  recoveryRuntimeAttestation,
})}\n`);
NODE
}

staging_filesystem_identity() {
  local command="$1" binding="${2:-}" worker_uid worker_gid
  local -a arguments
  worker_uid="$(id -u "$WORKER_USER")"
  worker_gid="$(id -g "$WORKER_USER")"
  arguments=(
    "$command"
    --role staging
    --release-root "$RELEASE_ROOT"
    --base "$STAGING_BASE"
    --runtime "$3"
    --worker-uid "$worker_uid"
    --worker-gid "$worker_gid"
  )
  if [ -n "$binding" ]; then arguments+=(--binding "$binding"); fi
  if [ "${NEXUS_RELEASE_TEST_MODE:-0}" = "1" ]; then arguments+=(--allow-test-owner); fi
  "$SYSTEM_NODE_BIN" "$FILESYSTEM_IDENTITY" "${arguments[@]}"
}

verify_staging_runtime_binding() {
  local request_id="$1" runtime="$2" base="$3" runtime_sha="$4" artifact_digest="$5"
  local expected_installed_digest="${6:-}"
  local binding recovery installed_digest recovery_digest group_id
  binding="$(staging_binding_path "$request_id")"
  recovery="$(staging_recovery_path "$request_id")"
  [ -f "$binding" ] && [ ! -L "$binding" ] && [ -f "$recovery" ] && [ ! -L "$recovery" ] || {
    echo "trusted staging runtime binding is unavailable" >&2
    return 66
  }
  [ "$(stat -c '%a:%h' "$binding")" = 600:1 ] \
    && [ "$(stat -c '%a:%h' "$recovery")" = 644:1 ] || {
    echo "trusted staging runtime binding mode or link identity is unsafe" >&2
    return 1
  }
  if [ "${NEXUS_RELEASE_TEST_MODE:-0}" != "1" ]; then
    [ "$(stat -c '%U:%G' "$binding")" = root:root ] \
      && [ "$(stat -c '%U:%G' "$recovery")" = root:root ] || {
      echo "trusted staging runtime binding owner is unsafe" >&2
      return 1
    }
  fi
  IFS=$'\t' read -r installed_digest recovery_digest < <(
    "$SYSTEM_NODE_BIN" - "$binding" "$recovery" "$request_id" "$runtime" "$base" \
      "$runtime_sha" "$artifact_digest" "$expected_installed_digest" <<'NODE'
const crypto=require('crypto');const fs=require('fs');
const [bindingPath,recoveryPath,requestId,runtime,base,runtimeSha,
 artifactDigest,expectedInstalledDigest]=process.argv.slice(2);
const binding=JSON.parse(fs.readFileSync(bindingPath,'utf8'));
const recovery=JSON.parse(fs.readFileSync(recoveryPath,'utf8'));
const canonical=(value)=>value===null||typeof value!=='object'?JSON.stringify(value)
 :Array.isArray(value)?`[${value.map(canonical).join(',')}]`
 :`{${Object.keys(value).sort().map((key)=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
const recoveryDigest=crypto.createHash('sha256').update(canonical(recovery.identity)).digest('hex');
if(binding.schema!=='nexus.trusted-staging-runtime-binding.v1'
 ||binding.requestId!==requestId||binding.runtime!==runtime||binding.base!==base
 ||binding.runtimeSha!==runtimeSha||binding.artifactDigest!==artifactDigest
 ||(expectedInstalledDigest&&binding.installedRuntimeDigest!==expectedInstalledDigest)
 ||!/^[a-f0-9]{64}$/u.test(binding.installedRuntimeDigest||'')
 ||!/^[a-f0-9]{64}$/u.test(binding.recoveryRuntimeDigest||'')
 ||!Number.isFinite(Date.parse(binding.sealedAt||''))
 ||recovery.schema!=='nexus.recovery-runtime-attestation.v1'
 ||recovery.aggregateDigest!==binding.recoveryRuntimeDigest
 ||recoveryDigest!==binding.recoveryRuntimeDigest
 ||recovery.identity?.runtimeSha!==runtimeSha
 ||recovery.identity?.artifactDigest!==artifactDigest)process.exit(1);
process.stdout.write(`${binding.installedRuntimeDigest}\t${binding.recoveryRuntimeDigest}\n`);
NODE
  ) || {
    echo "trusted staging runtime binding is invalid" >&2
    return 1
  }
  group_id="$(id -g "$WORKER_USER")"
  "$SYSTEM_NODE_BIN" "$TRUSTED_ATTESTOR" verify --root "$runtime" --base "$base" \
    --runtime-sha "$runtime_sha" --artifact-digest "$artifact_digest" \
    --installed-runtime-digest "$installed_digest" --group-id "$group_id" >/dev/null
  runuser -u "$WORKER_USER" -- "$SYSTEM_NODE_BIN" "$RECOVERY_ATTESTOR" compute \
    --root "$runtime" --runtime-sha "$runtime_sha" --artifact-digest "$artifact_digest" \
    --expect-digest "$recovery_digest" >/dev/null
  staging_filesystem_identity verify "$binding" "$runtime" >/dev/null
  emit_staging_runtime_evidence "$binding" "$recovery"
}

emit_root_staging_evidence() {
  local evidence="$1" request_id="$2" runtime="${3:-}" runtime_sha="${4:-}" artifact_digest="${5:-}"
  [ -f "$evidence" ] && [ ! -L "$evidence" ] \
    && [ "$(stat -c '%a:%h' "$evidence")" = 600:1 ] || {
    echo "root staging evidence is unavailable or unsafe" >&2
    return 66
  }
  if [ "${NEXUS_RELEASE_TEST_MODE:-0}" != "1" ]; then
    [ "$(stat -c '%U:%G' "$evidence")" = root:root ] || {
      echo "root staging evidence owner is unsafe" >&2
      return 1
    }
  fi
  "$SYSTEM_NODE_BIN" - "$evidence" "$request_id" "$runtime" "$runtime_sha" "$artifact_digest" <<'NODE'
const crypto=require('crypto');const fs=require('fs');
const [file,requestId,runtime,runtimeSha,artifactDigest]=process.argv.slice(2);
const canonical=(value)=>value===null||typeof value!=='object'?JSON.stringify(value)
 :Array.isArray(value)?`[${value.map(canonical).join(',')}]`
 :`{${Object.keys(value).sort().map((key)=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
const sha256=(value)=>crypto.createHash('sha256').update(value).digest('hex');
const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));
try{
 const before=fs.fstatSync(fd);
 if(!before.isFile()||before.nlink!==1)process.exit(1);
 const body=fs.readFileSync(fd);
 const after=fs.fstatSync(fd);
 if(before.dev!==after.dev||before.ino!==after.ino||before.size!==after.size
  ||before.mtimeMs!==after.mtimeMs)process.exit(1);
 const x=JSON.parse(body);
 if(x.schema!=='nexus.root-staging-attestation-evidence.v1'||x.requestId!==requestId
  ||(runtime&&x.releaseDir!==runtime)||(runtimeSha&&x.runtimeSha!==runtimeSha)
  ||(artifactDigest&&x.artifactDigest!==artifactDigest)
  ||x.binding?.schema!=='nexus.trusted-staging-runtime-binding.v1'
  ||x.binding.requestId!==requestId||x.binding.runtime!==x.releaseDir
  ||x.binding.base!==x.base||x.binding.runtimeSha!==x.runtimeSha
  ||x.binding.artifactDigest!==x.artifactDigest
  ||canonical(x.filesystem)!==canonical(x.binding.filesystem)
  ||x.currentSelector?.schema!=='nexus.release-current-selector-identity.v1'
  ||x.currentSelector.path!==`${x.base}/current`
  ||x.currentSelector.target!==x.releaseDir
  ||x.installedRuntimeAttestation?.aggregateDigest!==x.binding.installedRuntimeDigest
  ||x.recoveryRuntimeAttestation?.aggregateDigest!==x.binding.recoveryRuntimeDigest
  ||x.remoteIdentity?.schema!=='nexus.pm2-release-identity.v1'
  ||x.remoteReadiness?.schema!=='nexus.release-readiness.v1'
  ||x.remoteReadiness.role!=='staging'||x.remoteReadiness.runtimeSha!==x.runtimeSha
  ||x.outputDigests?.bindingSha256!==sha256(canonical(x.binding))
  ||x.outputDigests?.installedRuntimeSha256!==sha256(canonical(x.installedRuntimeAttestation))
  ||x.outputDigests?.recoveryRuntimeSha256!==sha256(canonical(x.recoveryRuntimeAttestation))
  ||x.outputDigests?.pm2IdentitySha256!==sha256(canonical(x.remoteIdentity))
  ||x.outputDigests?.currentSelectorSha256!==sha256(canonical(x.currentSelector))
  ||x.outputDigests?.readinessSha256
    !==sha256(`${JSON.stringify(x.remoteReadiness,null,2)}\n`)
  ||!Number.isFinite(Date.parse(x.transaction?.publishedAt??'')))process.exit(1);
 const selectorStat=fs.lstatSync(x.currentSelector.path,{bigint:true});
 if(!selectorStat.isSymbolicLink()
  ||String(selectorStat.dev)!==x.currentSelector.dev
  ||String(selectorStat.ino)!==x.currentSelector.ino
  ||Number(selectorStat.uid)!==process.getuid()
  ||Number(selectorStat.gid)!==process.getgid()
  ||fs.readlinkSync(x.currentSelector.path)!==x.releaseDir
  ||fs.realpathSync.native(x.currentSelector.path)!==x.releaseDir)process.exit(1);
 process.stdout.write(body);
}finally{fs.closeSync(fd);}
NODE
}

case "$COMMAND" in
  version)
    printf '%s\n' "$VERSION"
    ;;
  assert-idle)
    ensure_state_root; acquire_control_lock; clear_terminal_active
    [ ! -e "$LAYOUT_ACTIVATION_ACTIVE" ] && [ ! -L "$LAYOUT_ACTIVATION_ACTIVE" ] || {
      echo "release layout activation is active" >&2
      exit 73
    }
    [ ! -e "$BOOT_RECOVERY" ] && [ ! -L "$BOOT_RECOVERY" ] || {
      echo "boot recovery or SLA incident is unresolved" >&2
      exit 73
    }
    [ ! -e "$BOOT_PENDING" ] && [ ! -L "$BOOT_PENDING" ] || {
      echo "boot health preparation is unresolved" >&2
      exit 73
    }
    if [ -f "$STATE_ROOT/active.json" ]; then
      read -r active_id _ < <(read_active_fields)
      printf 'promotion transaction active: %s\n' "$active_id" >&2
      exit 73
    fi
    ;;
  assert-root-pm2-ready)
    ensure_state_root; acquire_control_lock
    assert_root_pm2_ready
    ;;
  assert-layout-ready)
    ensure_state_root; acquire_control_lock
    assert_layout_ready
    ;;
  assert-layout-boot-ready)
    [ "$#" -eq 0 ] || {
      echo "assert-layout-boot-ready accepts no arguments" >&2
      exit 64
    }
    ensure_state_root; acquire_control_lock
    assert_layout_boot_ready
    ;;
  assert-boot-recovery-prepared)
    [ "$#" -eq 1 ] || {
      echo "assert-boot-recovery-prepared requires layout, legacy, or v4-prelayout" >&2
      exit 64
    }
    ensure_state_root; acquire_control_lock
    validate_boot_recovery_prepared "$1"
    ;;
  prepare-runtime-target)
    runtime="${1:-}"; base="${2:-}"; validate_runtime_target "$runtime" "$base"
    ensure_state_root; acquire_control_lock; clear_terminal_active
    assert_layout_ready >/dev/null
    [ ! -f "$STATE_ROOT/active.json" ] || { echo "cannot prepare a runtime while promotion is active" >&2; exit 73; }
    ensure_release_layout "$base" production
    prepare_runtime_target "$runtime" "$base" production
    ;;
  prepare-staging-runtime-target)
    runtime="${1:-}"; base="${2:-}"; validate_staging_runtime_target "$runtime" "$base"
    ensure_state_root; acquire_control_lock; clear_terminal_active
    assert_layout_ready >/dev/null
    [ ! -f "$STATE_ROOT/active.json" ] || {
      echo "cannot prepare a staging runtime while promotion is active" >&2
      exit 73
    }
    ensure_release_layout "$base" staging
    prepare_runtime_target "$runtime" "$base" staging
    ;;
  seal-runtime)
    runtime="${1:-}"; base="${2:-}"; runtime_sha="${3:-}"; artifact_digest="${4:-}"; installed_digest="${5:-}"
    validate_runtime_target "$runtime" "$base"
    [[ "$runtime_sha" =~ ^[a-f0-9]{40}$ \
        && "$artifact_digest" =~ ^[a-f0-9]{64}$ \
        && "$installed_digest" =~ ^[a-f0-9]{64}$ ]] || { echo "unsafe runtime sealing request" >&2; exit 64; }
    [ -f "$TRUSTED_ATTESTOR" ] && [ ! -L "$TRUSTED_ATTESTOR" ] || { echo "trusted runtime attestor is unavailable" >&2; exit 1; }
    ensure_state_root; acquire_control_lock; clear_terminal_active
    assert_layout_ready >/dev/null
    [ ! -f "$STATE_ROOT/active.json" ] || { echo "cannot seal a runtime while promotion is active" >&2; exit 73; }
    harden_release_anchors "$base"
    group_id="$(id -g "$WORKER_USER")"
    /usr/bin/node "$TRUSTED_ATTESTOR" seal --root "$runtime" --base "$base" \
      --runtime-sha "$runtime_sha" --artifact-digest "$artifact_digest" \
      --installed-runtime-digest "$installed_digest" --group-id "$group_id"
    ;;
  seal-staging-runtime)
    request_id="${1:-}"; runtime="${2:-}"; base="${3:-}"; runtime_sha="${4:-}"
    artifact_digest="${5:-}"; installed_digest="${6:-}"
    validate_staging_request_id "$request_id"
    validate_staging_runtime_target "$runtime" "$base"
    [[ "$runtime_sha" =~ ^[a-f0-9]{40}$ \
        && "$artifact_digest" =~ ^[a-f0-9]{64}$ \
        && "$installed_digest" =~ ^[a-f0-9]{64}$ ]] || {
      echo "unsafe staging runtime sealing request" >&2
      exit 64
    }
    assert_root_installed_attestors
    ensure_state_root; acquire_control_lock; clear_terminal_active
    assert_layout_ready >/dev/null
    [ ! -f "$STATE_ROOT/active.json" ] || {
      echo "cannot seal a staging runtime while promotion is active" >&2
      exit 73
    }
    binding="$(staging_binding_path "$request_id")"
    recovery="$(staging_recovery_path "$request_id")"
    if [ -e "$binding" ] || [ -L "$binding" ]; then
      verify_staging_runtime_binding \
        "$request_id" "$runtime" "$base" "$runtime_sha" "$artifact_digest" "$installed_digest"
      exit $?
    fi
    if [ -e "$recovery" ] || [ -L "$recovery" ]; then durable_remove "$recovery" 644; fi
    harden_release_anchors "$base" staging
    group_id="$(id -g "$WORKER_USER")"
    "$SYSTEM_NODE_BIN" "$TRUSTED_ATTESTOR" seal --root "$runtime" --base "$base" \
      --runtime-sha "$runtime_sha" --artifact-digest "$artifact_digest" \
      --installed-runtime-digest "$installed_digest" --group-id "$group_id" >/dev/null
    recovery_json="$(
      runuser -u "$WORKER_USER" -- "$SYSTEM_NODE_BIN" "$RECOVERY_ATTESTOR" compute \
        --root "$runtime" --runtime-sha "$runtime_sha" --artifact-digest "$artifact_digest"
    )"
    recovery_digest="$(
      printf '%s' "$recovery_json" | "$SYSTEM_NODE_BIN" -e '
let body="";process.stdin.on("data",(chunk)=>{body+=chunk});process.stdin.on("end",()=>{
 const crypto=require("crypto");const value=JSON.parse(body);
 const canonical=(input)=>input===null||typeof input!=="object"?JSON.stringify(input)
  :Array.isArray(input)?`[${input.map(canonical).join(",")}]`
  :`{${Object.keys(input).sort().map((key)=>`${JSON.stringify(key)}:${canonical(input[key])}`).join(",")}}`;
 const digest=crypto.createHash("sha256").update(canonical(value.identity)).digest("hex");
 if(value.schema!=="nexus.recovery-runtime-attestation.v1"
  ||value.identity?.runtimeSha!==process.argv[1]||value.identity?.artifactDigest!==process.argv[2]
  ||value.aggregateDigest!==digest||!/^[a-f0-9]{64}$/.test(digest))process.exit(1);
 process.stdout.write(digest);
})' "$runtime_sha" "$artifact_digest"
    )" || {
      echo "trusted recovery runtime attestation is invalid" >&2
      exit 1
    }
    filesystem_temporary="$(mktemp "$STATE_ROOT/staging/.${request_id}.filesystem.XXXXXXXX")"
    cleanup_staging_filesystem_temporary() { rm -f -- "$filesystem_temporary"; }
    trap cleanup_staging_filesystem_temporary EXIT
    staging_filesystem_identity capture "" "$runtime" > "$filesystem_temporary"
    chmod 600 "$filesystem_temporary"; root_own "$filesystem_temporary"
    recovery_next="$(durable_staging_file "$recovery" 644)"
    binding_next="$(durable_staging_file "$binding" 600)"
    printf '%s' "$recovery_json" | "$SYSTEM_NODE_BIN" -e '
const fs=require("fs");let body="";process.stdin.on("data",(chunk)=>{body+=chunk});
process.stdin.on("end",()=>fs.writeFileSync(process.argv[1],`${JSON.stringify(JSON.parse(body),null,2)}\n`,{mode:0o644,flag:"w"}));' \
      "$recovery_next"
    chmod 644 "$recovery_next"; root_own "$recovery_next"
    "$SYSTEM_NODE_BIN" - "$binding_next" "$filesystem_temporary" "$request_id" "$runtime" "$base" \
      "$runtime_sha" "$artifact_digest" "$installed_digest" "$recovery_digest" <<'NODE'
const fs=require('fs');
const [output,filesystemPath,requestId,runtime,base,runtimeSha,artifactDigest,
 installedRuntimeDigest,recoveryRuntimeDigest]=process.argv.slice(2);
const filesystem=JSON.parse(fs.readFileSync(filesystemPath,'utf8'));
fs.writeFileSync(output,`${JSON.stringify({
  schema:'nexus.trusted-staging-runtime-binding.v1',
  requestId,runtime,base,runtimeSha,artifactDigest,
  installedRuntimeDigest,recoveryRuntimeDigest,filesystem,
  sealedAt:new Date().toISOString(),
},null,2)}\n`,{mode:0o600,flag:'w'});
NODE
    chmod 600 "$binding_next"; root_own "$binding_next"
    durable_publish "$recovery_next" "$recovery" 644
    durable_publish "$binding_next" "$binding" 600
    cleanup_staging_filesystem_temporary
    trap - EXIT
    emit_staging_runtime_evidence "$binding" "$recovery"
    ;;
  verify-staging-runtime)
    request_id="${1:-}"; runtime="${2:-}"; base="${3:-}"; runtime_sha="${4:-}"
    artifact_digest="${5:-}"
    validate_staging_request_id "$request_id"
    validate_staging_runtime_target "$runtime" "$base"
    [[ "$runtime_sha" =~ ^[a-f0-9]{40}$ \
        && "$artifact_digest" =~ ^[a-f0-9]{64}$ ]] || {
      echo "unsafe staging runtime verification request" >&2
      exit 64
    }
    assert_root_installed_attestors
    ensure_state_root; acquire_control_lock; clear_terminal_active
    assert_layout_ready >/dev/null
    [ ! -f "$STATE_ROOT/active.json" ] || {
      echo "cannot verify a staging runtime while promotion is active" >&2
      exit 73
    }
    verify_staging_runtime_binding \
      "$request_id" "$runtime" "$base" "$runtime_sha" "$artifact_digest"
    ;;
  attest-staging-runtime)
    request_id="${1:-}"; runtime="${2:-}"; base="${3:-}"; runtime_sha="${4:-}"
    artifact_digest="${5:-}"; stability_seconds="${6:-60}"
    validate_staging_request_id "$request_id"
    validate_staging_runtime_target "$runtime" "$base"
    [[ "$runtime_sha" =~ ^[a-f0-9]{40}$ \
        && "$artifact_digest" =~ ^[a-f0-9]{64}$ ]] || {
      echo "unsafe staging attestation request" >&2
      exit 64
    }
    case "$stability_seconds" in
      ''|*[!0-9]*) echo "unsafe staging stability interval" >&2; exit 64 ;;
    esac
    [ "$stability_seconds" -le 60 ] || {
      echo "staging stability interval exceeds the governed soak" >&2
      exit 64
    }
    if [ "${NEXUS_RELEASE_TEST_MODE:-0}" != "1" ] && [ "$stability_seconds" -ne 60 ]; then
      echo "staging stability soak must be exactly 60 seconds" >&2
      exit 64
    fi
    assert_root_installed_attestors
    ensure_state_root; acquire_control_lock; clear_terminal_active
    assert_layout_ready >/dev/null
    [ ! -f "$STATE_ROOT/active.json" ] || {
      echo "cannot attest staging while promotion is active" >&2
      exit 73
    }
    binding="$(staging_binding_path "$request_id")"
    recovery="$(staging_recovery_path "$request_id")"
    evidence="$(staging_evidence_path "$request_id")"
    if [ -e "$evidence" ] || [ -L "$evidence" ]; then
      "$STAGING_BROKER" finalize "$request_id" >/dev/null
      emit_root_staging_evidence \
        "$evidence" "$request_id" "$runtime" "$runtime_sha" "$artifact_digest"
      exit $?
    fi
    verify_staging_runtime_binding \
      "$request_id" "$runtime" "$base" "$runtime_sha" "$artifact_digest" >/dev/null
    evidence_next="$(durable_staging_file "$evidence" 600)"
    if ! NEXUS_PROMOTION_STATE_ROOT="$STATE_ROOT" \
      NEXUS_PROMOTION_RELEASE_ROOT="$RELEASE_ROOT" \
      NEXUS_PROMOTION_WORKER_USER="$WORKER_USER" \
      NEXUS_PROMOTION_NODE_BIN="$SYSTEM_NODE_BIN" \
      NEXUS_PROMOTION_FILESYSTEM_IDENTITY="$FILESYSTEM_IDENTITY" \
      NEXUS_RELEASE_TEST_MODE="${NEXUS_RELEASE_TEST_MODE:-0}" \
      "$STAGING_BROKER" \
        "$request_id" "$runtime" "$base" "$runtime_sha" "$artifact_digest" \
        "$stability_seconds" "$binding" "$recovery" "$evidence_next"; then
      rm -f -- "$evidence_next"
      echo "root staging attestation transaction failed" >&2
      exit 1
    fi
    chmod 600 "$evidence_next"; root_own "$evidence_next"
    durable_publish "$evidence_next" "$evidence" 600
    "$STAGING_BROKER" finalize "$request_id" >/dev/null
    emit_root_staging_evidence \
      "$evidence" "$request_id" "$runtime" "$runtime_sha" "$artifact_digest"
    ;;
  fetch-staging-evidence)
    request_id="${1:-}"
    validate_staging_request_id "$request_id"
    assert_root_installed_attestors
    ensure_state_root; acquire_control_lock
    "$STAGING_BROKER" finalize "$request_id" >/dev/null
    emit_root_staging_evidence "$(staging_evidence_path "$request_id")" "$request_id"
    ;;
  launch)
    envelope_input="${1:-}"; validate_authorization_input "$envelope_input"
    [ -x "$AUTH_BIN" ] || { echo "promotion authorization verifier is unavailable" >&2; exit 1; }
    [ -f "$OWNER_PUBLIC_KEY" ] && [ ! -L "$OWNER_PUBLIC_KEY" ] || { echo "owner promotion public key is unavailable" >&2; exit 1; }
    ensure_state_root
    acquire_control_lock
    assert_layout_ready >/dev/null
    trusted_envelope="$(mktemp "$STATE_ROOT/requests/.launch-envelope.XXXXXXXX")"
    [[ "$trusted_envelope" == "$STATE_ROOT/requests/".launch-envelope.* ]] \
      && [ -f "$trusted_envelope" ] && [ ! -L "$trusted_envelope" ] || {
      echo "root-owned launch envelope staging failed" >&2
      exit 1
    }
    cleanup_trusted_envelope() { rm -f -- "$trusted_envelope"; }
    trap cleanup_trusted_envelope EXIT
    install -m 600 "$envelope_input" "$trusted_envelope"
    root_own "$trusted_envelope"
    verification="$("$AUTH_BIN" verify-request --input "$trusted_envelope" --public-key "$OWNER_PUBLIC_KEY")" || {
      echo "owner-signed promotion request verification failed" >&2
      exit 77
    }
    IFS=$'\t' read -r transaction_id request_sha envelope_sha < <(printf '%s' "$verification" | node -e '
      let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{const x=JSON.parse(b);
      process.stdout.write(`${x.transactionId}\t${x.payloadSha256}\t${x.envelopeSha256}\n`)})')
    validate_id "$transaction_id"; clear_terminal_active
    ensure_transaction_dirs "$transaction_id"
    request_envelope="$STATE_ROOT/requests/$transaction_id.envelope.json"
    request_payload="$STATE_ROOT/requests/$transaction_id.json"
    authority="$(authority_path "$transaction_id")"
    if [ -f "$authority" ]; then
      stored="$(node -e 'const x=require(process.argv[1]);process.stdout.write(`${x.requestSha256}\t${x.envelopeSha256}`)' "$authority")"
      [ "$stored" = "$request_sha"$'\t'"$envelope_sha" ] || { echo "promotion transaction authority is immutable" >&2; exit 73; }
    else
      request_envelope_next="$(durable_staging_file "$request_envelope" 600)"
      request_payload_next="$(durable_staging_file "$request_payload" 644)"
      authority_next="$(durable_staging_file "$authority" 600)"
      install -m 600 "$trusted_envelope" "$request_envelope_next"; root_own "$request_envelope_next"
      node - "$trusted_envelope" "$request_payload_next" <<'NODE'
const fs=require('fs');const e=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
fs.writeFileSync(process.argv[3],`${JSON.stringify(e.payload,null,2)}\n`,{mode:0o644,flag:'w'});
NODE
      chmod 644 "$request_payload_next"; root_own "$request_payload_next"
      node - "$authority_next" "$transaction_id" "$request_sha" "$envelope_sha" <<'NODE'
const fs=require('fs');const [output,transactionId,requestSha256,envelopeSha256]=process.argv.slice(2);
fs.writeFileSync(output,`${JSON.stringify({schema:'nexus.promotion-authority.v1',transactionId,requestSha256,envelopeSha256},null,2)}\n`,{mode:0o600,flag:'w'});
NODE
      chmod 600 "$authority_next"; root_own "$authority_next"
      durable_publish "$request_envelope_next" "$request_envelope" 600
      durable_publish "$request_payload_next" "$request_payload" 644
      durable_publish "$authority_next" "$authority" 600
    fi
    if journal_terminal "$transaction_id" "$request_sha"; then
      printf '{"ok":true,"transactionId":"%s","state":"terminal","requestSha256":"%s"}\n' "$transaction_id" "$request_sha"
      exit 0
    fi
    if [ -f "$STATE_ROOT/active.json" ]; then
      active_matches "$transaction_id" "$request_sha" || { read -r active_id _ < <(read_active_fields); echo "another promotion transaction is active: $active_id" >&2; exit 73; }
    else
      write_active "$transaction_id" "$request_sha" "$envelope_sha"
    fi
    if ! "$SYSTEMCTL_BIN" is-active --quiet "$(unit_name "$transaction_id")"; then
      "$SYSTEMCTL_BIN" start --no-block "$(unit_name "$transaction_id")"
    fi
    printf '{"ok":true,"transactionId":"%s","state":"launched","requestSha256":"%s"}\n' "$transaction_id" "$request_sha"
    ;;
  status)
    transaction_id="${1:-}"; validate_id "$transaction_id"; ensure_state_root
    authority="$(authority_path "$transaction_id")"
    if [ ! -f "$authority" ]; then
      printf '{"schema":"nexus.promotion-transaction-status.v1","transactionId":"%s","status":"not_found"}\n' \
        "$transaction_id"
      # EX_NOINPUT is an authoritative application-level absence. Transport,
      # sudo, and malformed-state failures use different statuses so the Mac
      # may safely resubmit only this same verified owner-signed authority.
      exit 66
    fi
    request_sha="$(node -e 'const x=require(process.argv[1]);process.stdout.write(x.requestSha256||"")' "$authority")"
    journal="$(journal_path "$transaction_id")"
    unit_active=false
    if "$SYSTEMCTL_BIN" is-active --quiet "$(unit_name "$transaction_id")"; then
      unit_active=true
    fi
    if [ -f "$journal" ]; then
      "$SYSTEM_NODE_BIN" - "$journal" "$unit_active" <<'NODE'
const fs=require('fs');
const [file,unitActiveRaw]=process.argv.slice(2);
const value=JSON.parse(fs.readFileSync(file,'utf8'));
if(value===null||typeof value!=='object'||Array.isArray(value)
 ||!['true','false'].includes(unitActiveRaw))process.exit(1);
value.unitActive=unitActiveRaw==='true';
process.stdout.write(`${JSON.stringify(value)}\n`);
NODE
    else
      printf '{"schema":"nexus.promotion-transaction-journal.v1","transactionId":"%s","requestSha256":"%s","phase":"submitted","status":"pending","unitActive":%s}\n' \
        "$transaction_id" "$request_sha" "$unit_active"
    fi
    ;;
  ensure-started)
    transaction_id="${1:-}"; expected_request_sha="${2:-}"
    validate_id "$transaction_id"
    [[ "$expected_request_sha" =~ ^[a-f0-9]{64}$ ]] || {
      echo "invalid promotion request digest" >&2
      exit 64
    }
    ensure_state_root; acquire_control_lock; clear_terminal_active
    authority="$(authority_path "$transaction_id")"
    [ -f "$authority" ] && [ ! -L "$authority" ] || {
      echo "accepted promotion authority is unavailable" >&2
      exit 66
    }
    IFS=$'\t' read -r request_sha envelope_sha < <(node - "$authority" "$transaction_id" <<'NODE'
const fs=require('fs');const [file,id]=process.argv.slice(2);
const x=JSON.parse(fs.readFileSync(file,'utf8'));
if(x.schema!=='nexus.promotion-authority.v1'||x.transactionId!==id
 ||!/^[a-f0-9]{64}$/u.test(x.requestSha256||'')
 ||!/^[a-f0-9]{64}$/u.test(x.envelopeSha256||''))process.exit(1);
process.stdout.write(`${x.requestSha256}\t${x.envelopeSha256}\n`);
NODE
    ) || { echo "accepted promotion authority is invalid" >&2; exit 1; }
    [ "$request_sha" = "$expected_request_sha" ] || {
      echo "accepted promotion request digest does not match" >&2
      exit 73
    }
    if journal_terminal "$transaction_id" "$request_sha"; then
      printf '{"ok":true,"transactionId":"%s","state":"terminal","requestSha256":"%s"}\n' \
        "$transaction_id" "$request_sha"
      exit 0
    fi
    if [ -f "$STATE_ROOT/active.json" ]; then
      active_matches "$transaction_id" "$request_sha" || {
        read -r active_id _ < <(read_active_fields)
        echo "another promotion transaction is active: $active_id" >&2
        exit 73
      }
    else
      write_active "$transaction_id" "$request_sha" "$envelope_sha"
    fi
    unit="$(unit_name "$transaction_id")"
    if ! "$SYSTEMCTL_BIN" is-active --quiet "$unit"; then
      "$SYSTEMCTL_BIN" reset-failed "$unit" >/dev/null 2>&1 || true
      "$SYSTEMCTL_BIN" start --no-block "$unit"
    fi
    printf '{"ok":true,"transactionId":"%s","state":"started","requestSha256":"%s"}\n' \
      "$transaction_id" "$request_sha"
    ;;
  recover)
    transaction_id="${1:-}"; validate_id "$transaction_id"; ensure_state_root; acquire_control_lock; clear_terminal_active
    [ -f "$STATE_ROOT/active.json" ] || { echo "no promotion transaction is active" >&2; exit 75; }
    IFS=$'\t' read -r active_id request_sha < <(read_active_fields)
    [ "$active_id" = "$transaction_id" ] || { echo "recovery target is not authoritative active transaction" >&2; exit 73; }
    write_recovery_control "$transaction_id"
    unit="$(unit_name "$transaction_id")"
    if ! "$SYSTEMCTL_BIN" is-active --quiet "$unit"; then
      "$SYSTEMCTL_BIN" reset-failed "$unit" >/dev/null 2>&1 || true
      "$SYSTEMCTL_BIN" start --no-block "$unit"
    fi
    printf '{"ok":true,"transactionId":"%s","decision":"recover"}\n' "$transaction_id"
    ;;
  retry-escrow)
    transaction_id="${1:-}"; validate_id "$transaction_id"; ensure_state_root; acquire_control_lock; clear_terminal_active
    [ -f "$STATE_ROOT/active.json" ] || { echo "no promotion transaction is active" >&2; exit 75; }
    IFS=$'\t' read -r active_id request_sha < <(read_active_fields)
    [ "$active_id" = "$transaction_id" ] || {
      echo "escrow retry target is not the authoritative active transaction" >&2
      exit 73
    }
    [ "$(journal_status "$transaction_id" "$request_sha" 2>/dev/null || true)" = escrow_pending ] || {
      echo "promotion transaction is not awaiting rollback escrow" >&2
      exit 75
    }
    unit="$(unit_name "$transaction_id")"
    if "$SYSTEMCTL_BIN" is-active --quiet "$unit"; then
      state=active
    else
      "$SYSTEMCTL_BIN" reset-failed "$unit" >/dev/null 2>&1 || true
      "$SYSTEMCTL_BIN" start --no-block "$unit"
      state=relaunched
    fi
    printf '{"ok":true,"transactionId":"%s","state":"%s","retry":"rollback-escrow"}\n' \
      "$transaction_id" "$state"
    ;;
  recover-all)
    ensure_state_root; acquire_control_lock
    # This read-only preflight runs before the durable timing marker. A live
    # invocation with the real PM2 service already active therefore cannot
    # manufacture an unresolved boot-recovery incident.
    if [ "${NEXUS_RELEASE_TEST_MODE:-0}" = 1 ] \
        && [ -z "${NEXUS_PROMOTION_BOOT_HEALTH_BIN:-}" ]; then
      :
    else
      "$BOOT_HEALTH_BIN" preflight-temporary >/dev/null
    fi
    write_boot_recovery_authority
    # All nested PM2 clients must attach to this root-owned cgroup. Starting it
    # before either recovery broker prevents PM2 CLI auto-spawn in a transient
    # worker unit from becoming an ungoverned daemon authority.
    if [ "${NEXUS_RELEASE_TEST_MODE:-0}" = 1 ] \
        && [ -z "${NEXUS_PROMOTION_BOOT_HEALTH_BIN:-}" ]; then
      :
    else
      "$BOOT_HEALTH_BIN" start-temporary >/dev/null
    fi
    # Staging has no transient systemd unit of its own. Reconcile its
    # root-owned predecessor journal before PM2 autostart and before the
    # production transaction, even when no production active.json exists.
    "$STAGING_BROKER" recover-all >/dev/null
    if [ -f "$STATE_ROOT/active.json" ]; then
      IFS=$'\t' read -r transaction_id request_sha < <(read_active_fields)
      validate_id "$transaction_id"
      active_matches "$transaction_id" "$request_sha" || {
        echo "active promotion identity changed during recovery" >&2
        exit 1
      }
      journal="$(journal_path "$transaction_id")"
      if [ -e "$journal" ] || [ -L "$journal" ]; then
        [ -f "$journal" ] && [ ! -L "$journal" ] || {
          echo "authoritative promotion journal is unsafe at boot" >&2
          exit 1
        }
        status="$(journal_status "$transaction_id" "$request_sha")" || {
          echo "authoritative promotion journal is invalid at boot" >&2
          exit 1
        }
        transaction_phase="$(journal_phase "$transaction_id" "$request_sha")" || {
          echo "authoritative promotion journal phase is invalid at boot" >&2
          exit 1
        }
      else
        status=""
        transaction_phase=""
      fi
      transaction_state="$(state_dir "$transaction_id")"
      if ! journal_terminal "$transaction_id" "$request_sha"; then
        if [ -z "$status" ] \
            && [ ! -e "$transaction_state/journal.json" ] \
            && [ ! -L "$transaction_state/journal.json" ] \
            && [ ! -e "$transaction_state/recovery-armed" ] \
            && [ ! -L "$transaction_state/recovery-armed" ]; then
          # Pre-mutation work still runs synchronously at boot. The recovery
          # unit never launches a competing background release lane.
          :
        elif [ "$status" != escrow_pending ] \
            && [ "$transaction_phase" != waiting_for_dr_lease ]; then
          write_recovery_control "$transaction_id"
        fi
        unit="$(unit_name "$transaction_id")"
        "$SYSTEMCTL_BIN" reset-failed "$unit" >/dev/null 2>&1 || true
        "$SYSTEMCTL_BIN" start "$unit"
        journal_terminal "$transaction_id" "$request_sha" || {
          echo "boot promotion recovery did not reach a terminal state" >&2
          exit 1
        }
      fi
    fi
    # Reuse the governed temporary daemon to prove and capture the exact
    # four-app state. It publishes the root authority, writes pending SLA
    # evidence, and kills the entire temporary cgroup before this unit returns.
    if [ "${NEXUS_RELEASE_TEST_MODE:-0}" = 1 ] \
        && [ -z "${NEXUS_PROMOTION_BOOT_HEALTH_BIN:-}" ]; then
      :
    else
      "$BOOT_HEALTH_BIN" prepare >/dev/null
    fi
    ;;
  boot-postcheck)
    [ "$#" -eq 0 ] || { echo "boot-postcheck accepts no arguments" >&2; exit 64; }
    ensure_state_root; acquire_control_lock
    [ -f "$BOOT_RECOVERY" ] || exit 0
    "$BOOT_HEALTH_BIN" postcheck >/dev/null
    if [ "$("$SYSTEM_NODE_BIN" -e '
const x=require(process.argv[1]);
if(x.schema!=="nexus.release-boot-health-proof.v2"
 ||!["passed","healthy_sla_missed"].includes(x.status)
 ||typeof x.targetMet!=="boolean")process.exit(1);
process.stdout.write(String(x.targetMet));
' "$BOOT_PROOF")" != true ]; then
      # Exact service health is an availability fact, while an SLA miss is an
      # incident. Keep the real healthy service and retain root recovery/active
      # authority so every subsequent promotion remains blocked until explicit
      # owner incident handling.
      printf '{"ok":true,"schema":"nexus.release-boot-health-proof.v2","status":"healthy_sla_missed","promotionBlocked":true}\n'
      exit 0
    fi
    finalize_boot_recovery
    printf '{"ok":true,"schema":"nexus.release-boot-health-proof.v2","status":"passed","promotionBlocked":false}\n'
    ;;
  resolve-boot-sla-incident)
    [ "$#" -eq 1 ] || {
      echo "resolve-boot-sla-incident requires the exact proof SHA-256" >&2
      exit 64
    }
    ensure_state_root; acquire_control_lock
    resolve_boot_sla_incident "$1"
    ;;
  resolve-prelayout-boot-recovery)
    [ "$#" -eq 1 ] || {
      echo "resolve-prelayout-boot-recovery requires the exact marker SHA-256" >&2
      exit 64
    }
    ensure_state_root; acquire_control_lock
    resolve_prelayout_boot_recovery "$1"
    ;;
  fetch)
    transaction_id="${1:-}"; artifact="${2:-}"; validate_id "$transaction_id"; ensure_state_root
    authority="$(authority_path "$transaction_id")"; [ -f "$authority" ] || { echo "promotion transaction is unknown" >&2; exit 1; }
    request_sha="$(node -e 'const x=require(process.argv[1]);process.stdout.write(x.requestSha256||"")' "$authority")"
    [ "$(journal_status "$transaction_id" "$request_sha" 2>/dev/null || true)" = completed ] || {
      echo "promotion artifacts are unavailable before authoritative completion" >&2
      exit 75
    }
    case "$artifact" in
      result) file="$(state_dir "$transaction_id")/result.env" ;;
      escrow) file="$(state_dir "$transaction_id")/escrow-confirmation.json" ;;
      *) echo "unknown promotion transaction artifact" >&2; exit 64 ;;
    esac
    [ -f "$file" ] && [ ! -L "$file" ] || { echo "promotion transaction artifact is unavailable" >&2; exit 75; }
    cat "$file"
    ;;
  *)
    echo "Usage: nexus-release-promotion-control <version|assert-idle|assert-layout-ready|assert-layout-boot-ready|assert-boot-recovery-prepared|prepare-runtime-target|prepare-staging-runtime-target|seal-runtime|seal-staging-runtime|verify-staging-runtime|attest-staging-runtime|fetch-staging-evidence|launch|status|ensure-started|recover|retry-escrow|recover-all|boot-postcheck|resolve-boot-sla-incident|resolve-prelayout-boot-recovery|fetch>" >&2
    exit 64
    ;;
esac
