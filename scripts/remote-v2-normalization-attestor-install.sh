#!/usr/bin/env bash
# Transactional, one-time installer for the inactive v2 normalization attestor
# bridge. It installs no service, sudoers entry, operator command, or scheduler.
set -euo pipefail
umask 077
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH

COMMAND="${1:-}"
[ "$#" -gt 0 ] && shift
TEST_MODE="${NEXUS_V2_NORMALIZATION_INSTALL_TEST_MODE:-0}"
if [ "$TEST_MODE" = 1 ] && [ "$EUID" -eq 0 ]; then
  echo "v2 normalization attestor installer: test mode may not cross a privileged uid boundary" >&2
  exit 77
fi
if [ "$TEST_MODE" = 1 ] \
    && [ -n "${NEXUS_V2_NORMALIZATION_TEST_BIN_DIR:-}" ]; then
  PATH="$NEXUS_V2_NORMALIZATION_TEST_BIN_DIR:$PATH"
  export PATH
fi
BOOTSTRAP_BASE="${NEXUS_V2_NORMALIZATION_BOOTSTRAP_BASE:-/var/lib/nexus-release-bootstrap}"
STATE_ROOT="${NEXUS_V2_NORMALIZATION_STATE_ROOT:-/var/lib/nexus-release-promotion}"
BRIDGE_STATE="$STATE_ROOT/v2-normalization-attestor-bridge"
JOURNAL="$BRIDGE_STATE/install-in-progress.v1.json"
STRICT_RESTORE_JOURNAL="$BRIDGE_STATE/strict-restore-in-progress.v1.json"
RECEIPT="$BRIDGE_STATE/receipt.v1.json"
RESTORED_RECEIPT="$BRIDGE_STATE/restored.v1.json"
ROLLBACK_RECEIPT="$BRIDGE_STATE/last-rollback.v1.json"
STRICT_BACKUP="$BRIDGE_STATE/replaced-strict-attestor.mjs"
BRIDGE_BACKUP="$BRIDGE_STATE/installed-bridge-attestor.mjs"
PRODUCTION_AUTHORIZATION="$BRIDGE_STATE/production-authorization.envelope.json"
ACCEPTANCE="$BRIDGE_STATE/acceptance.v1.json"
MAINTENANCE_MARKER="$BRIDGE_STATE/maintenance.v1.json"
CONTROL_FAIL_CLOSED_MARKER="${NEXUS_V2_NORMALIZATION_CONTROL_MARKER:-$STATE_ROOT/bootstrap-in-progress.v1}"
CONTROL_LOCK="$STATE_ROOT/.control.lock"
SONAR_LOCK="${NEXUS_V2_NORMALIZATION_SONAR_LOCK:-/run/lock/nexus-release-sonar.lock}"
ATTESTOR_TARGET="${NEXUS_V2_NORMALIZATION_ATTESTOR_TARGET:-/usr/local/libexec/nexus-trusted-release-runtime-attestation.mjs}"
CONTROL_BIN="${NEXUS_V2_NORMALIZATION_CONTROL_BIN:-/usr/local/sbin/nexus-release-promotion-control}"
OWNER_PUBLIC_KEY="${NEXUS_V2_NORMALIZATION_OWNER_PUBLIC_KEY:-/etc/nexus-release/owner-promotion-public-key.pem}"
RELEASE_EVIDENCE_PUBLIC_KEY="${NEXUS_V2_NORMALIZATION_RELEASE_EVIDENCE_PUBLIC_KEY:-/etc/nexus-application-dr/release-evidence-public-key.pem}"
MACHINE_ID_FILE="${NEXUS_V2_NORMALIZATION_MACHINE_ID_FILE:-/etc/machine-id}"
WORKER_USER="${NEXUS_V2_NORMALIZATION_WORKER_USER:-dominguez}"
SYSTEM_NODE="${NEXUS_V2_NORMALIZATION_NODE_BIN:-/usr/bin/node}"
SYSTEMCTL_BIN="${NEXUS_V2_NORMALIZATION_SYSTEMCTL_BIN:-/usr/bin/systemctl}"
EXPECTED_CONTROL_SHA256="${NEXUS_V2_NORMALIZATION_EXPECTED_CONTROL_SHA256:-fb66d9257ec0b7b6f2c582d326c5ed3f6c01071f5792a4045c42199b6691edf1}"
EXPECTED_REPLACED_ATTESTOR_SHA256="${NEXUS_V2_NORMALIZATION_EXPECTED_REPLACED_ATTESTOR_SHA256:-c337fb11211b0db1f18a19e31d7f6383a62b2842994725b3c2b2f24c8c5df96d}"
INSTALL_MUTATED=false
INSTALL_COMPLETE=false

die() {
  echo "v2 normalization attestor installer: $*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage:
  sudo <sha-bound-source>/scripts/remote-v2-normalization-attestor-install.sh install \
    <source-root> <40-hex-source-sha> <source-archive> <64-hex-archive-sha256> \
    <production-authorization-envelope>
  sudo <sha-bound-source>/scripts/remote-v2-normalization-attestor-install.sh recover \
    <source-root> <40-hex-source-sha> <source-archive> <64-hex-archive-sha256>
  sudo <sha-bound-source>/scripts/remote-v2-normalization-attestor-install.sh restore \
    <source-root> <40-hex-source-sha> <source-archive> <64-hex-archive-sha256>
  sudo <sha-bound-source>/scripts/remote-v2-normalization-attestor-install.sh status
EOF
}

case "$COMMAND" in
  install) [ "$#" -eq 5 ] || { usage >&2; exit 64; } ;;
  recover|restore) [ "$#" -eq 4 ] || { usage >&2; exit 64; } ;;
  status) [ "$#" -eq 0 ] || { usage >&2; exit 64; } ;;
  *) usage >&2; exit 64 ;;
esac

if [ "$TEST_MODE" != 1 ]; then
  [ "$EUID" -eq 0 ] || { echo "v2 normalization attestor installer must run as root" >&2; exit 77; }
  [ "$EXPECTED_CONTROL_SHA256" = fb66d9257ec0b7b6f2c582d326c5ed3f6c01071f5792a4045c42199b6691edf1 ] \
    || die "production v2 control identity may not be overridden"
  [ "$EXPECTED_REPLACED_ATTESTOR_SHA256" = c337fb11211b0db1f18a19e31d7f6383a62b2842994725b3c2b2f24c8c5df96d ] \
    || die "production replaced-attestor identity may not be overridden"
fi

for utility in bash chmod chown cut dirname flock id install mktemp mv node \
  python3 realpath rm sha256sum stat; do
  command -v "$utility" >/dev/null 2>&1 || die "$utility is required"
done
[ -x "$SYSTEM_NODE" ] || die "trusted system Node is unavailable"

sha256_file() {
  sha256sum -- "$1" | cut -d' ' -f1
}

fsync_path() {
  "$SYSTEM_NODE" - "$1" <<'NODE'
const fs=require('fs');
const descriptor=fs.openSync(process.argv[2],'r');
try{fs.fsyncSync(descriptor);}finally{fs.closeSync(descriptor);}
NODE
}

validate_root_chain() {
  local candidate="$1" current owner mode
  [ -e "$candidate" ] && [ ! -L "$candidate" ] || die "trusted path is missing or symbolic: $candidate"
  current="$(realpath -e -- "$candidate")"
  [ "$current" = "$candidate" ] || die "trusted path is not canonical: $candidate"
  [ "$TEST_MODE" = 1 ] && return 0
  while :; do
    owner="$(stat -c '%u' -- "$current")"
    mode="$(stat -c '%a' -- "$current")"
    [ "$owner" = 0 ] || die "trusted path component is not root-owned: $current"
    [ $((8#$mode & 8#022)) -eq 0 ] \
      || die "trusted path component is group/world writable: $current"
    [ "$current" = / ] && break
    current="$(dirname -- "$current")"
  done
}

assert_regular() {
  local file="$1" label="$2" modes="$3" owner
  [ -f "$file" ] && [ ! -L "$file" ] && [ "$(stat -c '%h' -- "$file")" = 1 ] \
    && [ "$(realpath -e -- "$file")" = "$file" ] \
    || die "$label is not an exact regular file"
  case ":$modes:" in
    *":$(stat -c '%a' -- "$file"):"*) ;;
    *) die "$label mode is unsafe" ;;
  esac
  if [ "$TEST_MODE" != 1 ]; then
    owner="$(stat -c '%u:%g' -- "$file")"
    [ "$owner" = 0:0 ] || die "$label is not root-owned"
  fi
}

atomic_install() {
  local source="$1" target="$2" mode="$3" parent temporary
  parent="$(dirname -- "$target")"
  [ -d "$parent" ] && [ ! -L "$parent" ] \
    && [ "$(realpath -e -- "$parent")" = "$parent" ] \
    || die "atomic install parent is unsafe: $parent"
  if [ -e "$target" ] || [ -L "$target" ]; then
    [ -f "$target" ] && [ ! -L "$target" ] && [ "$(stat -c '%h' -- "$target")" = 1 ] \
      || die "atomic install target is unsafe: $target"
  fi
  temporary="$(mktemp -p "$parent" ".nexus-v2-normalization-attestor.XXXXXX")"
  if [ "$TEST_MODE" = 1 ]; then
    install -m "$mode" -- "$source" "$temporary"
  else
    install -o root -g root -m "$mode" -- "$source" "$temporary"
  fi
  fsync_path "$temporary"
  mv -fT -- "$temporary" "$target"
  fsync_path "$parent"
}

atomic_json() {
  local target="$1" temporary
  temporary="$(mktemp -p "$(dirname -- "$target")" ".nexus-v2-normalization-json.XXXXXX")"
  "$SYSTEM_NODE" - "$temporary" "${@:2}" <<'NODE'
const fs=require('fs');
const [output,...pairs]=process.argv.slice(2);
const value={};
for(const pair of pairs){
 const index=pair.indexOf('=');
 if(index<1)process.exit(1);
 value[pair.slice(0,index)]=pair.slice(index+1);
}
fs.writeFileSync(output,`${JSON.stringify(value,null,2)}\n`,{mode:0o600,flag:'w'});
NODE
  chmod 600 "$temporary"
  if [ "$TEST_MODE" != 1 ]; then chown root:root "$temporary"; fi
  fsync_path "$temporary"
  mv -fT -- "$temporary" "$target"
  fsync_path "$(dirname -- "$target")"
}

durable_remove() {
  local target="$1"
  [ -e "$target" ] || [ -L "$target" ] || return 0
  [ -f "$target" ] && [ ! -L "$target" ] && [ "$(stat -c '%h' -- "$target")" = 1 ] \
    || die "durable removal target is unsafe: $target"
  rm -f -- "$target"
  fsync_path "$(dirname -- "$target")"
}

ensure_state_directory() {
  if [ ! -e "$STATE_ROOT" ]; then
    if [ "$TEST_MODE" = 1 ]; then
      install -d -m 755 "$STATE_ROOT"
    else
      install -d -o root -g root -m 755 "$STATE_ROOT"
    fi
  fi
  [ -d "$STATE_ROOT" ] && [ ! -L "$STATE_ROOT" ] \
    && [ "$(realpath -e -- "$STATE_ROOT")" = "$STATE_ROOT" ] \
    || die "promotion state root is unsafe"
  if [ ! -e "$BRIDGE_STATE" ]; then
    if [ "$TEST_MODE" = 1 ]; then
      install -d -m 700 "$BRIDGE_STATE"
    else
      install -d -o root -g root -m 700 "$BRIDGE_STATE"
    fi
    fsync_path "$STATE_ROOT"
  fi
  [ -d "$BRIDGE_STATE" ] && [ ! -L "$BRIDGE_STATE" ] \
    && [ "$(realpath -e -- "$BRIDGE_STATE")" = "$BRIDGE_STATE" ] \
    && [ "$(stat -c '%a' -- "$BRIDGE_STATE")" = 700 ] \
    || die "bridge state directory is unsafe"
  if [ "$TEST_MODE" != 1 ]; then
    [ "$(stat -c '%u:%g' -- "$BRIDGE_STATE")" = 0:0 ] \
      || die "bridge state directory is not root-owned"
  fi
}

verify_open_lock() {
  local descriptor="$1" lock_path="$2" label="$3"
  local expected_mode="$4" expected_gid="$5"
  "$SYSTEM_NODE" - "$descriptor" "$lock_path" "$TEST_MODE" "$label" \
    "$expected_mode" "$expected_gid" <<'NODE'
const fs=require('fs');
const [descriptorRaw,file,testMode,label,modeRaw,gidRaw]=process.argv.slice(2);
const descriptor=Number(descriptorRaw);
const expectedMode=Number.parseInt(modeRaw,8);
const expectedGid=Number(gidRaw);
const pathStat=fs.lstatSync(file,{bigint:true});
const opened=fs.fstatSync(descriptor,{bigint:true});
const owner=testMode==="1"?BigInt(process.getuid()):0n;
if(!pathStat.isFile()||pathStat.isSymbolicLink()||pathStat.nlink!==1n
 ||pathStat.uid!==owner||pathStat.gid!==BigInt(expectedGid)
 ||Number(pathStat.mode&0o777n)!==expectedMode
 ||opened.dev!==pathStat.dev||opened.ino!==pathStat.ino
 ||opened.nlink!==1n||opened.uid!==owner||opened.gid!==BigInt(expectedGid)
 ||Number(opened.mode&0o777n)!==expectedMode){
 console.error(`${label} lock identity is unsafe`);
 process.exit(1);
}
NODE
}

acquire_maintenance_locks() {
  local root_gid=0 worker_gid
  [ "$TEST_MODE" != 1 ] || root_gid="$(id -g)"
  worker_gid="$(id -g "$WORKER_USER")"
  assert_regular "$CONTROL_LOCK" "promotion control lock" "600"
  assert_regular "$SONAR_LOCK" "release/Sonar lock" "660"
  exec 7<>"$CONTROL_LOCK"
  flock -x 7
  verify_open_lock 7 "$CONTROL_LOCK" "promotion control" 600 "$root_gid"
  exec 6<>"$SONAR_LOCK"
  flock -x 6
  verify_open_lock 6 "$SONAR_LOCK" "release/Sonar" 660 "$worker_gid"
}

assert_maintenance_idle_under_lock() {
  local recovery_load recovery_active active_units query_status root_gid=0
  local worker_gid
  [ "$TEST_MODE" != 1 ] || root_gid="$(id -g)"
  worker_gid="$(id -g "$WORKER_USER")"
  verify_open_lock 7 "$CONTROL_LOCK" "promotion control" 600 "$root_gid"
  verify_open_lock 6 "$SONAR_LOCK" "release/Sonar" 660 "$worker_gid"
  [ ! -e "$STATE_ROOT/active.json" ] && [ ! -L "$STATE_ROOT/active.json" ] \
    || die "promotion became active while acquiring maintenance authority"
  [ -x "$SYSTEMCTL_BIN" ] || die "trusted systemctl is unavailable"
  set +e
  recovery_load="$(
    "$SYSTEMCTL_BIN" show nexus-release-promotion-recovery.service \
      --property=LoadState --value 2>/dev/null
  )"
  query_status=$?
  set -e
  [ "$query_status" -eq 0 ] && [ "$recovery_load" = loaded ] \
    || die "promotion recovery unit state cannot be proved"
  set +e
  recovery_active="$(
    "$SYSTEMCTL_BIN" show nexus-release-promotion-recovery.service \
      --property=ActiveState --value 2>/dev/null
  )"
  query_status=$?
  set -e
  [ "$query_status" -eq 0 ] && [ "$recovery_active" = inactive ] \
    || die "promotion recovery unit is not provably inactive"
  set +e
  active_units="$(
    "$SYSTEMCTL_BIN" list-units --type=service \
      --state=activating,active,reloading,deactivating --no-legend --no-pager \
      'nexus-release-promotion@*.service' 2>/dev/null
  )"
  query_status=$?
  set -e
  [ "$query_status" -eq 0 ] \
    || die "promotion transaction unit state cannot be proved"
  [ -z "$active_units" ] || die "a promotion transaction unit is active"
}

write_maintenance_marker() {
  local operation="$1" transaction_id="$2" request_sha="$3"
  local control_sha="$4" attestor_sha="$5" temporary
  [ ! -e "$CONTROL_FAIL_CLOSED_MARKER" ] \
    && [ ! -L "$CONTROL_FAIL_CLOSED_MARKER" ] \
    || die "control-plane maintenance/bootstrap marker already exists"
  [ ! -e "$MAINTENANCE_MARKER" ] && [ ! -L "$MAINTENANCE_MARKER" ] \
    || die "v2 normalization maintenance marker already exists"
  temporary="$(mktemp -p "$STATE_ROOT" ".v2-maintenance-control.XXXXXX")"
  "$SYSTEM_NODE" - "$temporary" "$operation" "$transaction_id" "$request_sha" \
    "$control_sha" "$attestor_sha" <<'NODE'
const fs=require('fs');
const [output,operation,transactionId,requestSha256,controlSha256,
 attestorSha256]=process.argv.slice(2);
fs.writeFileSync(output,`${JSON.stringify({
 schema:"nexus.v2-normalization-control-maintenance.v1",
 status:"in_progress",operation,transactionId,requestSha256,
 controlSha256,attestorSha256,startedAt:new Date().toISOString(),
},null,2)}\n`,{mode:0o600,flag:"w"});
NODE
  chmod 600 "$temporary"; if [ "$TEST_MODE" != 1 ]; then chown root:root "$temporary"; fi
  fsync_path "$temporary"
  mv -fT -- "$temporary" "$CONTROL_FAIL_CLOSED_MARKER"
  fsync_path "$STATE_ROOT"
  atomic_install "$CONTROL_FAIL_CLOSED_MARKER" "$MAINTENANCE_MARKER" 600
  fsync_path "$BRIDGE_STATE"
  validate_maintenance_marker "$operation"
}

validate_maintenance_marker() {
  local operation="$1"
  assert_regular "$CONTROL_FAIL_CLOSED_MARKER" \
    "control-plane maintenance marker" "600"
  assert_regular "$MAINTENANCE_MARKER" "bridge maintenance marker" "600"
  [ "$(sha256_file "$CONTROL_FAIL_CLOSED_MARKER")" \
      = "$(sha256_file "$MAINTENANCE_MARKER")" ] \
    || die "maintenance marker copies differ"
  "$SYSTEM_NODE" - "$MAINTENANCE_MARKER" "$operation" <<'NODE'
const fs=require('fs');const [file,operation]=process.argv.slice(2);
const x=JSON.parse(fs.readFileSync(file,"utf8"));
const keys=["schema","status","operation","transactionId","requestSha256",
 "controlSha256","attestorSha256","startedAt"].sort().join(",");
if(!x||typeof x!=="object"||Array.isArray(x)
 ||Object.keys(x).sort().join(",")!==keys
 ||x.schema!=="nexus.v2-normalization-control-maintenance.v1"
 ||x.status!=="in_progress"||x.operation!==operation
 ||!/^[0-9]{8}T[0-9]{6}Z-[0-9]+-[a-f0-9]{12}$/u.test(x.transactionId||"")
 ||!/^[a-f0-9]{64}$/u.test(x.requestSha256||"")
 ||!/^[a-f0-9]{64}$/u.test(x.controlSha256||"")
 ||!/^[a-f0-9]{64}$/u.test(x.attestorSha256||"")
 ||!Number.isFinite(Date.parse(x.startedAt||"")))process.exit(1);
NODE
}

validate_active_receipt_completion() {
  local bridge_sha="$1" journal_file="${2:-}"
  assert_regular "$RECEIPT" "completed active bridge receipt" "600"
  assert_regular "$PRODUCTION_AUTHORIZATION" \
    "completed production bridge authorization" "600"
  [ "$(sha256_file "$ATTESTOR_TARGET")" = "$bridge_sha" ] \
    || die "completed bridge receipt target is not the exact bridge"
  "$SYSTEM_NODE" - "$RECEIPT" "$MAINTENANCE_MARKER" "$journal_file" \
    "$SOURCE_ROOT" "$SOURCE_SHA" "$EXPECTED_ARCHIVE_SHA256" \
    "$EXPECTED_CONTROL_SHA256" "$EXPECTED_REPLACED_ATTESTOR_SHA256" \
    "$bridge_sha" "$(sha256_file "$PRODUCTION_AUTHORIZATION")" <<'NODE'
const fs=require('fs');
const [receiptFile,markerFile,journalFile,sourceRoot,sourceSha,archiveSha256,
 controlSha256,strictSha256,bridgeSha256,productionSha256]=process.argv.slice(2);
const receipt=JSON.parse(fs.readFileSync(receiptFile,"utf8"));
const marker=JSON.parse(fs.readFileSync(markerFile,"utf8"));
const digest=/^[a-f0-9]{64}$/u;
const exact=(value,keys)=>value&&typeof value==="object"&&!Array.isArray(value)
 &&Object.keys(value).sort().join(",")===keys.sort().join(",");
if(!exact(receipt,["schema","status","source","installed","authorizations",
 "transaction","environmentPolicy","installedAt"])
 ||!exact(receipt.source,["sourceRoot","sourceSha","archiveSha256"])
 ||!exact(receipt.installed,["controlSha256","bridgeSha256",
  "replacedAttestorSha256","strictRestoreSha256"])
 ||!exact(receipt.authorizations,["productionSha256"])
 ||!exact(receipt.transaction,["transactionId","requestSha256",
  "requestEnvelopeSha256"])
 ||!exact(receipt.environmentPolicy,["legacyMode","modernMode"])
 ||receipt.schema!=="nexus.v2-normalization-attestor-install-receipt.v1"
 ||receipt.status!=="active"
 ||receipt.source.sourceRoot!==sourceRoot||receipt.source.sourceSha!==sourceSha
 ||receipt.source.archiveSha256!==archiveSha256
 ||receipt.installed.controlSha256!==controlSha256
 ||receipt.installed.bridgeSha256!==bridgeSha256
 ||receipt.installed.replacedAttestorSha256!==strictSha256
 ||receipt.installed.strictRestoreSha256!==strictSha256
 ||receipt.authorizations.productionSha256!==productionSha256
 ||receipt.transaction.transactionId!==marker.transactionId
 ||receipt.transaction.requestSha256!==marker.requestSha256
 ||!digest.test(receipt.transaction.requestEnvelopeSha256||"")
 ||receipt.environmentPolicy.legacyMode!=="worker:worker:0600"
 ||receipt.environmentPolicy.modernMode!=="root:worker:0440"
 ||!Number.isFinite(Date.parse(receipt.installedAt||"")))process.exit(1);
if(journalFile!==""){
 const journal=JSON.parse(fs.readFileSync(journalFile,"utf8"));
 if(receipt.source.sourceRoot!==journal.source?.sourceRoot
  ||receipt.source.sourceSha!==journal.source?.sourceSha
  ||receipt.source.archiveSha256!==journal.source?.archiveSha256
  ||receipt.installed.controlSha256!==journal.installed?.controlSha256
  ||receipt.installed.bridgeSha256!==journal.installed?.bridgeSha256
  ||receipt.installed.replacedAttestorSha256
    !==journal.installed?.replacedAttestorSha256
  ||receipt.authorizations.productionSha256
    !==journal.authorizations?.productionAuthorizationSha256
  ||receipt.transaction.transactionId!==journal.transaction?.transactionId
  ||receipt.transaction.requestSha256!==journal.transaction?.requestSha256
  ||receipt.transaction.requestEnvelopeSha256
    !==journal.transaction?.requestEnvelopeSha256)process.exit(1);
}
NODE
}

validate_restored_receipt_completion() {
  local bridge_sha="$1"
  assert_regular "$RESTORED_RECEIPT" "completed strict restore receipt" "600"
  [ "$(sha256_file "$ATTESTOR_TARGET")" \
      = "$EXPECTED_REPLACED_ATTESTOR_SHA256" ] \
    || die "completed strict restore target is not the exact strict attestor"
  "$SYSTEM_NODE" - "$RESTORED_RECEIPT" "$MAINTENANCE_MARKER" \
    "$EXPECTED_REPLACED_ATTESTOR_SHA256" "$bridge_sha" <<'NODE'
const fs=require('fs');
const [receiptFile,markerFile,strictSha256,bridgeSha256]=process.argv.slice(2);
const receipt=JSON.parse(fs.readFileSync(receiptFile,"utf8"));
const marker=JSON.parse(fs.readFileSync(markerFile,"utf8"));
const digest=/^[a-f0-9]{64}$/u;
const sha=/^[a-f0-9]{40}$/u;
if(receipt.schema!=="nexus.v2-normalization-attestor-restored.v1"
 ||receipt.status!=="complete"
 ||receipt.transactionId!==marker.transactionId
 ||receipt.requestSha256!==marker.requestSha256
 ||receipt.strictAttestorSha256!==strictSha256
 ||marker.attestorSha256!==bridgeSha256
 ||!sha.test(receipt.target?.runtimeSha||"")
 ||!digest.test(receipt.target?.artifactDigest||"")
 ||!digest.test(receipt.target?.installedRuntimeDigest||"")
 ||!Number.isFinite(Date.parse(receipt.restoredAt||"")))process.exit(1);
NODE
}

clear_maintenance_marker() {
  durable_remove "$MAINTENANCE_MARKER"
  # The control-plane marker is removed last. Until this directory fsync
  # completes, every promotion control invocation remains fail-closed.
  durable_remove "$CONTROL_FAIL_CLOSED_MARKER"
}

install_crash_point() {
  local phase="$1"
  if [ "$TEST_MODE" = 1 ] \
      && [ "${NEXUS_V2_NORMALIZATION_TEST_HOLD_PHASE:-}" = "$phase" ]; then
    [ -n "${NEXUS_V2_NORMALIZATION_TEST_HOLD_READY:-}" ] \
      || die "test hold ready path is required"
    atomic_json "$NEXUS_V2_NORMALIZATION_TEST_HOLD_READY" \
      schema=nexus.v2-normalization-test-hold.v1 phase="$phase" pid="$$"
    kill -STOP "$$"
  fi
  if [ "$TEST_MODE" = 1 ] \
      && [ "${NEXUS_V2_NORMALIZATION_TEST_INSTALL_CRASH_PHASE:-}" = "$phase" ]; then
    kill -9 "$$"
  fi
}

source_provenance() {
  SOURCE_ROOT="$1"
  SOURCE_SHA="$2"
  SOURCE_ARCHIVE="$3"
  EXPECTED_ARCHIVE_SHA256="$4"
  [[ "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]] || die "source SHA is invalid"
  [[ "$EXPECTED_ARCHIVE_SHA256" =~ ^[0-9a-f]{64}$ ]] \
    || die "archive SHA-256 is invalid"
  EXPECTED_BOOTSTRAP_ROOT="$BOOTSTRAP_BASE/$SOURCE_SHA"
  [ "$SOURCE_ROOT" = "$EXPECTED_BOOTSTRAP_ROOT/source" ] \
    || die "source root is outside the exact SHA-bound bootstrap path"
  [ "$SOURCE_ARCHIVE" = "$EXPECTED_BOOTSTRAP_ROOT/source.tar.gz" ] \
    || die "source archive is outside the exact SHA-bound bootstrap path"
  validate_root_chain "$EXPECTED_BOOTSTRAP_ROOT"
  validate_root_chain "$SOURCE_ROOT"
  assert_regular "$SOURCE_ARCHIVE" "source archive" "400:600:640"
  [ "$(sha256_file "$SOURCE_ARCHIVE")" = "$EXPECTED_ARCHIVE_SHA256" ] \
    || die "source archive digest does not match"
  INSTALLER_SOURCE="$SOURCE_ROOT/scripts/remote-v2-normalization-attestor-install.sh"
  BRIDGE_SOURCE="$SOURCE_ROOT/scripts/trusted-release-runtime-attestation-v2-bridge.mjs"
  assert_regular "$INSTALLER_SOURCE" "installer source" "500:550:700:755"
  assert_regular "$BRIDGE_SOURCE" "bridge source" "400:440:600:640:644:700"
  [ "$(realpath -e -- "$0")" = "$INSTALLER_SOURCE" ] \
    || die "installer must execute from the exact SHA-bound source"

  # Prove the Git PAX commit and the byte identity of every privileged source
  # member without extracting or executing archive-controlled paths.
  python3 - "$SOURCE_ARCHIVE" "$SOURCE_ROOT" "$SOURCE_SHA" <<'PY'
import hashlib
import pathlib
import sys
import tarfile

archive_path, source_root_raw, source_sha = sys.argv[1:]
source_root = pathlib.Path(source_root_raw)
required = (
    "scripts/remote-v2-normalization-attestor-install.sh",
    "scripts/trusted-release-runtime-attestation-v2-bridge.mjs",
)
with tarfile.open(archive_path, "r:gz") as archive:
    if archive.pax_headers.get("comment") != source_sha:
        raise SystemExit("bootstrap archive Git PAX commit does not match")
    members = {member.name: member for member in archive.getmembers()}
    for relative in required:
        name = f"source/{relative}"
        member = members.get(name)
        if member is None or not member.isfile() or member.issym() or member.islnk():
            raise SystemExit(f"unsafe or missing source archive member: {name}")
        if pathlib.PurePosixPath(name).as_posix() != name or ".." in pathlib.PurePosixPath(name).parts:
            raise SystemExit(f"unsafe source archive path: {name}")
        archived = archive.extractfile(member)
        if archived is None:
            raise SystemExit(f"unreadable source archive member: {name}")
        archive_bytes = archived.read()
        source_bytes = (source_root / relative).read_bytes()
        if len(archive_bytes) != len(source_bytes):
            raise SystemExit(f"source size drift for {relative}")
        if hashlib.sha256(archive_bytes).digest() != hashlib.sha256(source_bytes).digest():
            raise SystemExit(f"source drift for {relative}")
PY
}

inspect_authorizations() {
  local production_input="$1" allow_expired="${2:-false}"
  local expected_replaced="${3:-}"
  local bridge_sha replaced_sha control_sha
  local production_stage
  local expiry_argument=
  [ "$allow_expired" = false ] || expiry_argument=--allow-expired
  assert_regular "$production_input" "production bridge authorization input" "400:600"
  production_stage="$(mktemp -p "$BRIDGE_STATE" ".production-authorization.XXXXXX")"
  if [ "$TEST_MODE" = 1 ]; then
    install -m 600 -- "$production_input" "$production_stage"
  else
    install -o root -g root -m 600 -- "$production_input" "$production_stage"
  fi
  fsync_path "$production_stage"
  bridge_sha="$(sha256_file "$BRIDGE_SOURCE")"
  replaced_sha="${expected_replaced:-$(sha256_file "$ATTESTOR_TARGET")}"
  control_sha="$(sha256_file "$CONTROL_BIN")"
  set +e
  AUTHORIZATION_JSON="$(
    NEXUS_V2_NORMALIZATION_TEST_MODE="$TEST_MODE" \
    NEXUS_V2_NORMALIZATION_EXPECTED_CONTROL_SHA256="$EXPECTED_CONTROL_SHA256" \
    NEXUS_V2_NORMALIZATION_EXPECTED_REPLACED_ATTESTOR_SHA256="$EXPECTED_REPLACED_ATTESTOR_SHA256" \
      "$SYSTEM_NODE" "$BRIDGE_SOURCE" inspect-authorizations \
      --production-authorization "$production_stage" \
      --owner-public-key "$OWNER_PUBLIC_KEY" \
      --machine-id-file "$MACHINE_ID_FILE" \
      --bridge-sha256 "$bridge_sha" \
      --replaced-attestor-sha256 "$replaced_sha" \
      --control-sha256 "$control_sha" \
      ${expiry_argument:+"$expiry_argument"}
  )"
  local inspect_status=$?
  set -e
  if [ "$inspect_status" -ne 0 ]; then
    rm -f -- "$production_stage"
    die "signed bridge authorization inspection failed"
  fi
  AUTHORIZATION_FIELDS="$(
    printf '%s' "$AUTHORIZATION_JSON" | "$SYSTEM_NODE" -e '
let body="";process.stdin.on("data",(chunk)=>body+=chunk);process.stdin.on("end",()=>{
 const x=JSON.parse(body);
 const fields=["transactionId","requestSha256","requestEnvelopeSha256",
  "productionAuthorizationSha256","workerUid",
  "workerGroupId","productionBase","targetRuntime","legacyEnvironmentMode",
  "modernEnvironmentMode","targetRuntimeSha","targetArtifactDigest",
  "targetInstalledRuntimeDigest"];
 if(x.ok!==true||fields.some((field)=>x[field]===undefined)
  ||fields.some((field)=>String(x[field]).includes("\t")))process.exit(1);
 process.stdout.write(fields.map((field)=>String(x[field])).join("\t"));
});'
  )" || {
    rm -f -- "$production_stage"
    die "signed bridge authorization result is invalid"
  }
  AUTHORIZATION_PRODUCTION_STAGE="$production_stage"
}

validate_installed_v2() {
  assert_regular "$CONTROL_BIN" "installed v2 promotion control" "700"
  assert_regular "$ATTESTOR_TARGET" "installed strict runtime attestor" "700"
  [ "$(sha256_file "$CONTROL_BIN")" = "$EXPECTED_CONTROL_SHA256" ] \
    || die "installed promotion control is not exact e168 v2"
  [ "$("$CONTROL_BIN" version)" = nexus-release-promotion-control.v2 ] \
    || die "installed promotion control version is not v2"
  [ "$(sha256_file "$ATTESTOR_TARGET")" = "$EXPECTED_REPLACED_ATTESTOR_SHA256" ] \
    || die "installed strict attestor is not the exact e168 identity"
}

assert_idle() {
  "$CONTROL_BIN" assert-idle >/dev/null \
    || die "v2 promotion control is not idle"
}

validate_environment() {
  local base="$1" phase="$2" worker_uid="$3" worker_gid="$4" identity
  [ -d "$base" ] && [ ! -L "$base" ] && [ "$(realpath -e -- "$base")" = "$base" ] \
    || die "$phase base is unsafe"
  assert_regular "$base/.env" "$phase environment" "600"
  identity="$(stat -c '%u:%g:%a' -- "$base/.env")"
  [ "$identity" = "$worker_uid:$worker_gid:600" ] \
    || die "$phase environment is not the explicit worker-owned legacy 0600 identity"
}

write_install_journal() {
  local bridge_sha="$1" production_sha="$2" transaction_id="$3"
  local request_sha="$4" request_envelope_sha="$5" temporary
  temporary="$(mktemp -p "$BRIDGE_STATE" ".install-journal.XXXXXX")"
  "$SYSTEM_NODE" - "$temporary" "$SOURCE_ROOT" "$SOURCE_SHA" \
    "$EXPECTED_ARCHIVE_SHA256" "$EXPECTED_CONTROL_SHA256" \
    "$EXPECTED_REPLACED_ATTESTOR_SHA256" "$bridge_sha" \
    "$production_sha" "$transaction_id" "$request_sha" \
    "$request_envelope_sha" <<'NODE'
const fs=require('fs');
const [output,sourceRoot,sourceSha,archiveSha256,controlSha256,
 replacedAttestorSha256,bridgeSha256,productionAuthorizationSha256,
 transactionId,requestSha256,
 requestEnvelopeSha256]=process.argv.slice(2);
fs.writeFileSync(output,`${JSON.stringify({
 schema:"nexus.v2-normalization-attestor-install-journal.v1",
 status:"in_progress",
 source:{sourceRoot,sourceSha,archiveSha256},
 installed:{controlSha256,replacedAttestorSha256,bridgeSha256},
 authorizations:{productionAuthorizationSha256},
 transaction:{transactionId,requestSha256,requestEnvelopeSha256},
 startedAt:new Date().toISOString(),
},null,2)}\n`,{mode:0o600,flag:"w"});
NODE
  chmod 600 "$temporary"
  if [ "$TEST_MODE" != 1 ]; then chown root:root "$temporary"; fi
  fsync_path "$temporary"
  mv -fT -- "$temporary" "$JOURNAL"
  fsync_path "$BRIDGE_STATE"
}

validate_install_journal() {
  assert_regular "$JOURNAL" "bridge install journal" "600"
  JOURNAL_FIELDS="$(
    "$SYSTEM_NODE" - "$JOURNAL" <<'NODE'
const fs=require('fs');const x=JSON.parse(fs.readFileSync(process.argv[2],"utf8"));
const digest=/^[a-f0-9]{64}$/u,id=/^[0-9]{8}T[0-9]{6}Z-[0-9]+-[a-f0-9]{12}$/u;
if(x.schema!=="nexus.v2-normalization-attestor-install-journal.v1"
 ||x.status!=="in_progress"||!digest.test(x.installed?.controlSha256||"")
 ||!digest.test(x.installed?.replacedAttestorSha256||"")
 ||!digest.test(x.installed?.bridgeSha256||"")
 ||!digest.test(x.authorizations?.productionAuthorizationSha256||"")
 ||!id.test(x.transaction?.transactionId||"")
 ||!digest.test(x.transaction?.requestSha256||"")
 ||!digest.test(x.transaction?.requestEnvelopeSha256||""))process.exit(1);
process.stdout.write([x.installed.controlSha256,x.installed.replacedAttestorSha256,
 x.installed.bridgeSha256,x.authorizations.productionAuthorizationSha256,
 x.transaction.transactionId,
 x.transaction.requestSha256,x.transaction.requestEnvelopeSha256].join("\t"));
NODE
  )" || die "bridge install journal is invalid"
}

write_receipt() {
  local bridge_sha="$1" production_sha="$2" transaction_id="$3"
  local request_sha="$4" request_envelope_sha="$5" temporary
  temporary="$(mktemp -p "$BRIDGE_STATE" ".install-receipt.XXXXXX")"
  "$SYSTEM_NODE" - "$temporary" "$SOURCE_ROOT" "$SOURCE_SHA" \
    "$EXPECTED_ARCHIVE_SHA256" "$EXPECTED_CONTROL_SHA256" "$bridge_sha" \
    "$EXPECTED_REPLACED_ATTESTOR_SHA256" "$production_sha" \
    "$transaction_id" "$request_sha" "$request_envelope_sha" <<'NODE'
const fs=require('fs');
const [output,sourceRoot,sourceSha,archiveSha256,controlSha256,bridgeSha256,
 replacedAttestorSha256,productionSha256,transactionId,
 requestSha256,requestEnvelopeSha256]=process.argv.slice(2);
fs.writeFileSync(output,`${JSON.stringify({
 schema:"nexus.v2-normalization-attestor-install-receipt.v1",
 status:"active",
 source:{sourceRoot,sourceSha,archiveSha256},
 installed:{controlSha256,bridgeSha256,replacedAttestorSha256,
  strictRestoreSha256:replacedAttestorSha256},
 authorizations:{productionSha256},
 transaction:{transactionId,requestSha256,requestEnvelopeSha256},
 environmentPolicy:{legacyMode:"worker:worker:0600",modernMode:"root:worker:0440"},
 installedAt:new Date().toISOString(),
},null,2)}\n`,{mode:0o600,flag:"w"});
NODE
  chmod 600 "$temporary"
  if [ "$TEST_MODE" != 1 ]; then chown root:root "$temporary"; fi
  fsync_path "$temporary"
  mv -fT -- "$temporary" "$RECEIPT"
  fsync_path "$BRIDGE_STATE"
}

write_strict_restore_journal() {
  local transaction_id="$1" request_sha="$2" bridge_sha="$3" receipt_sha="$4"
  local temporary
  temporary="$(mktemp -p "$BRIDGE_STATE" ".strict-restore-journal.XXXXXX")"
  "$SYSTEM_NODE" - "$temporary" "$transaction_id" "$request_sha" \
    "$bridge_sha" "$EXPECTED_REPLACED_ATTESTOR_SHA256" "$receipt_sha" <<'NODE'
const fs=require('fs');
const [output,transactionId,requestSha256,bridgeSha256,strictSha256,
 receiptSha256]=process.argv.slice(2);
fs.writeFileSync(output,`${JSON.stringify({
 schema:"nexus.v2-normalization-strict-restore-journal.v1",
 status:"in_progress",phase:"prepared",transactionId,requestSha256,
 bridgeSha256,strictSha256,receiptSha256,
 startedAt:new Date().toISOString(),updatedAt:new Date().toISOString(),
},null,2)}\n`,{mode:0o600,flag:"w"});
NODE
  chmod 600 "$temporary"; if [ "$TEST_MODE" != 1 ]; then chown root:root "$temporary"; fi
  fsync_path "$temporary"
  mv -fT -- "$temporary" "$STRICT_RESTORE_JOURNAL"
  fsync_path "$BRIDGE_STATE"
}

strict_restore_checkpoint() {
  local phase="$1" temporary
  temporary="$(mktemp -p "$BRIDGE_STATE" ".strict-restore-checkpoint.XXXXXX")"
  "$SYSTEM_NODE" - "$STRICT_RESTORE_JOURNAL" "$temporary" "$phase" <<'NODE'
const fs=require('fs');const [input,output,phase]=process.argv.slice(2);
const x=JSON.parse(fs.readFileSync(input,"utf8"));
if(x.schema!=="nexus.v2-normalization-strict-restore-journal.v1"
 ||x.status!=="in_progress"
 ||!["prepared","swapped","receipt_published"].includes(phase))process.exit(1);
fs.writeFileSync(output,`${JSON.stringify({...x,phase,
 updatedAt:new Date().toISOString()},null,2)}\n`,{mode:0o600,flag:"w"});
NODE
  chmod 600 "$temporary"; if [ "$TEST_MODE" != 1 ]; then chown root:root "$temporary"; fi
  fsync_path "$temporary"
  mv -fT -- "$temporary" "$STRICT_RESTORE_JOURNAL"
  fsync_path "$BRIDGE_STATE"
  strict_restore_crash_point "$phase"
}

strict_restore_crash_point() {
  local phase="$1"
  if [ "$TEST_MODE" = 1 ] \
      && [ "${NEXUS_V2_NORMALIZATION_TEST_RESTORE_CRASH_PHASE:-}" = "$phase" ]; then
    kill -9 "$$"
  fi
}

validate_strict_restore_journal() {
  assert_regular "$STRICT_RESTORE_JOURNAL" "strict restore journal" "600"
  STRICT_RESTORE_FIELDS="$(
    "$SYSTEM_NODE" - "$STRICT_RESTORE_JOURNAL" <<'NODE'
const fs=require('fs');const x=JSON.parse(fs.readFileSync(process.argv[2],"utf8"));
const digest=/^[a-f0-9]{64}$/u;
if(x.schema!=="nexus.v2-normalization-strict-restore-journal.v1"
 ||x.status!=="in_progress"
 ||!["prepared","swapped","receipt_published"].includes(x.phase)
 ||!/^[0-9]{8}T[0-9]{6}Z-[0-9]+-[a-f0-9]{12}$/u.test(x.transactionId||"")
 ||![x.requestSha256,x.bridgeSha256,x.strictSha256,x.receiptSha256]
   .every((value)=>digest.test(value||"")))process.exit(1);
process.stdout.write([x.transactionId,x.requestSha256,x.bridgeSha256,
 x.strictSha256,x.receiptSha256,x.phase].join("\t"));
NODE
  )" || die "strict restore journal is invalid"
}

recover_strict_restore() {
  [ -e "$STRICT_RESTORE_JOURNAL" ] || return 1
  validate_strict_restore_journal
  local transaction_id request_sha bridge_sha strict_sha receipt_sha phase current_sha
  IFS=$'\t' read -r transaction_id request_sha bridge_sha strict_sha receipt_sha phase \
    <<<"$STRICT_RESTORE_FIELDS"
  validate_maintenance_marker restore
  assert_regular "$BRIDGE_BACKUP" "installed bridge rollback copy" "700"
  [ "$(sha256_file "$BRIDGE_BACKUP")" = "$bridge_sha" ] \
    || die "installed bridge rollback copy differs from strict restore journal"
  current_sha="$(sha256_file "$ATTESTOR_TARGET")"
  if [ -e "$RECEIPT" ]; then
    assert_regular "$RECEIPT" "active bridge receipt during strict recovery" "600"
    [ "$(sha256_file "$RECEIPT")" = "$receipt_sha" ] \
      || die "active bridge receipt differs from strict restore journal"
  elif [ ! -e "$RESTORED_RECEIPT" ]; then
    die "strict restore lost both active and terminal receipts"
  fi
  if [ -f "$RESTORED_RECEIPT" ] && [ ! -L "$RESTORED_RECEIPT" ] \
      && [ "$current_sha" = "$strict_sha" ]; then
    "$SYSTEM_NODE" - "$RESTORED_RECEIPT" "$transaction_id" "$request_sha" \
      "$strict_sha" <<'NODE'
const fs=require('fs');const [file,id,requestSha,strictSha]=process.argv.slice(2);
const x=JSON.parse(fs.readFileSync(file,"utf8"));
if(x.schema!=="nexus.v2-normalization-attestor-restored.v1"
 ||x.status!=="complete"||x.transactionId!==id||x.requestSha256!==requestSha
 ||x.strictAttestorSha256!==strictSha)process.exit(1);
NODE
    durable_remove "$RECEIPT"
    durable_remove "$STRICT_RESTORE_JOURNAL"
    clear_maintenance_marker
    STRICT_RESTORE_RECOVERY_STATUS=finished
    return 0
  fi
  case "$current_sha" in
    "$bridge_sha") ;;
    "$strict_sha")
      assert_maintenance_idle_under_lock
      atomic_install "$BRIDGE_BACKUP" "$ATTESTOR_TARGET" 700
      ;;
    *) die "strict restore target has an unknown digest; maintenance remains fail-closed" ;;
  esac
  [ "$(sha256_file "$ATTESTOR_TARGET")" = "$bridge_sha" ] \
    || die "strict restore bridge rollback verification failed"
  atomic_json "$ROLLBACK_RECEIPT" \
    schema=nexus.v2-normalization-strict-restore-rollback.v1 \
    status=complete transactionId="$transaction_id" requestSha256="$request_sha" \
    restoredBridgeSha256="$bridge_sha" rolledBackAt="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  durable_remove "$STRICT_RESTORE_JOURNAL"
  clear_maintenance_marker
  STRICT_RESTORE_RECOVERY_STATUS=restored_bridge
  return 0
}

rollback_install() {
  local reason="${1:-installation_failed}" restored=false
  set +e
  if [ -f "$ATTESTOR_TARGET" ] && [ ! -L "$ATTESTOR_TARGET" ] \
      && [ "$(sha256_file "$ATTESTOR_TARGET" 2>/dev/null)" \
        = "$EXPECTED_REPLACED_ATTESTOR_SHA256" ]; then
    restored=true
  elif [ -f "$STRICT_BACKUP" ] && [ ! -L "$STRICT_BACKUP" ] \
      && [ "$(sha256_file "$STRICT_BACKUP" 2>/dev/null)" = "$EXPECTED_REPLACED_ATTESTOR_SHA256" ]; then
    assert_maintenance_idle_under_lock
    atomic_install "$STRICT_BACKUP" "$ATTESTOR_TARGET" 700
    if [ "$(sha256_file "$ATTESTOR_TARGET" 2>/dev/null)" = "$EXPECTED_REPLACED_ATTESTOR_SHA256" ]; then
      restored=true
    fi
  fi
  if [ "$restored" = true ]; then
    durable_remove "$RECEIPT"
    durable_remove "$ACCEPTANCE"
    durable_remove "$PRODUCTION_AUTHORIZATION"
    atomic_json "$ROLLBACK_RECEIPT" \
      schema=nexus.v2-normalization-attestor-install-rollback.v1 \
      status=complete reason="$reason" \
      restoredAttestorSha256="$EXPECTED_REPLACED_ATTESTOR_SHA256" \
      rolledBackAt="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    durable_remove "$JOURNAL"
    durable_remove "$STRICT_RESTORE_JOURNAL"
    durable_remove "$MAINTENANCE_MARKER"
    durable_remove "$CONTROL_FAIL_CLOSED_MARKER"
    set -e
    return 0
  fi
  echo "v2 normalization attestor rollback is incomplete; journal retained" >&2
  set -e
  return 1
}

install_failure_trap() {
  local status=$?
  trap - EXIT
  if [ "$status" -ne 0 ] && [ "$INSTALL_MUTATED" = true ] \
      && [ "$INSTALL_COMPLETE" != true ]; then
    rollback_install post_mutation_validation_failed \
      || status=76
  fi
  exit "$status"
}

restore_failure_trap() {
  local status=$?
  trap - EXIT
  if [ "$status" -ne 0 ] && [ "$INSTALL_MUTATED" = true ] \
      && [ "$INSTALL_COMPLETE" != true ]; then
    set +e
    if [ -e "$STRICT_RESTORE_JOURNAL" ]; then
      recover_strict_restore
      recovery_status=$?
    elif [ -e "$MAINTENANCE_MARKER" ] \
        && [ "$(sha256_file "$ATTESTOR_TARGET" 2>/dev/null)" \
          = "$(sha256_file "$BRIDGE_SOURCE" 2>/dev/null)" ]; then
      clear_maintenance_marker
      recovery_status=$?
    else
      recovery_status=1
    fi
    set -e
    [ "$recovery_status" -eq 0 ] || status=76
  fi
  exit "$status"
}

install_bridge() {
  local production_input="$5"
  local transaction_id request_sha request_envelope_sha production_sha
  local worker_uid worker_gid production_base legacy_mode modern_mode
  local target_runtime target_sha target_artifact target_installed bridge_sha
  source_provenance "$1" "$2" "$3" "$4"
  ensure_state_directory
  exec 9>"$BRIDGE_STATE/.install.lock"
  chmod 600 "$BRIDGE_STATE/.install.lock"
  if [ "$TEST_MODE" != 1 ]; then chown root:root "$BRIDGE_STATE/.install.lock"; fi
  flock -n 9 || die "another bridge installer is active"
  [ ! -e "$JOURNAL" ] && [ ! -L "$JOURNAL" ] \
    || die "an incomplete bridge installation requires explicit recover"
  [ ! -e "$RECEIPT" ] && [ ! -L "$RECEIPT" ] \
    || die "v2 normalization attestor bridge is already active"
  [ ! -e "$RESTORED_RECEIPT" ] && [ ! -L "$RESTORED_RECEIPT" ] \
    || die "the single-use v2 normalization bridge was already retired"
  validate_installed_v2
  assert_idle
  acquire_maintenance_locks
  assert_maintenance_idle_under_lock
  [ ! -e "$CONTROL_FAIL_CLOSED_MARKER" ] \
    && [ ! -e "$MAINTENANCE_MARKER" ] \
    || die "an incomplete maintenance transaction requires explicit recover"
  validate_installed_v2
  assert_regular "$OWNER_PUBLIC_KEY" "owner promotion public key" "600:644"
  assert_regular "$RELEASE_EVIDENCE_PUBLIC_KEY" \
    "production release evidence public key" "600:644"
  assert_regular "$MACHINE_ID_FILE" "server machine identity" \
    "$([ "$TEST_MODE" = 1 ] && printf '600:644' || printf '444')"
  inspect_authorizations "$production_input"
  IFS=$'\t' read -r transaction_id request_sha request_envelope_sha \
    production_sha worker_uid worker_gid production_base \
    target_runtime legacy_mode modern_mode target_sha target_artifact target_installed \
    <<<"$AUTHORIZATION_FIELDS"
  [ "$worker_uid" = "$(id -u "$WORKER_USER")" ] \
    && [ "$worker_gid" = "$(id -g "$WORKER_USER")" ] \
    || die "signed bridge worker identity differs from the installed worker"
  [ "$legacy_mode" = 0600 ] && [ "$modern_mode" = 0440 ] \
    || die "signed bridge environment modes are invalid"
  validate_environment "$production_base" production "$worker_uid" "$worker_gid"
  bridge_sha="$(sha256_file "$BRIDGE_SOURCE")"
  write_maintenance_marker install "$transaction_id" "$request_sha" \
    "$EXPECTED_CONTROL_SHA256" "$EXPECTED_REPLACED_ATTESTOR_SHA256"
  INSTALL_MUTATED=true
  trap install_failure_trap EXIT
  install_crash_point marker

  # Preserve and verify the strict predecessor before the in-progress journal
  # can make recovery mandatory. A crash after this idempotent copy but before
  # the journal leaves the next install able to revalidate and continue.
  if [ -e "$STRICT_BACKUP" ] || [ -L "$STRICT_BACKUP" ]; then
    assert_regular "$STRICT_BACKUP" "strict attestor rollback copy" "700"
    [ "$(sha256_file "$STRICT_BACKUP")" = "$EXPECTED_REPLACED_ATTESTOR_SHA256" ] \
      || die "strict attestor rollback copy differs from exact e168"
  else
    atomic_install "$ATTESTOR_TARGET" "$STRICT_BACKUP" 700
  fi
  write_install_journal "$bridge_sha" "$production_sha" \
    "$transaction_id" "$request_sha" "$request_envelope_sha"
  install_crash_point journal

  atomic_install "$AUTHORIZATION_PRODUCTION_STAGE" "$PRODUCTION_AUTHORIZATION" 600
  rm -f -- "$AUTHORIZATION_PRODUCTION_STAGE"
  fsync_path "$BRIDGE_STATE"
  assert_maintenance_idle_under_lock
  atomic_install "$BRIDGE_SOURCE" "$ATTESTOR_TARGET" 700
  [ "$(sha256_file "$ATTESTOR_TARGET")" = "$bridge_sha" ] \
    || die "installed bridge digest differs from the reviewed source"
  install_crash_point replaced
  if [ "$TEST_MODE" = 1 ] \
      && [ "${NEXUS_V2_NORMALIZATION_INSTALL_FAIL_AFTER_REPLACE:-0}" = 1 ]; then
    die "injected post-replacement failure"
  fi
  write_receipt "$bridge_sha" "$production_sha" \
    "$transaction_id" "$request_sha" "$request_envelope_sha"
  install_crash_point receipt
  durable_remove "$JOURNAL"
  install_crash_point journal_removed
  clear_maintenance_marker
  INSTALL_COMPLETE=true
  trap - EXIT
  printf '{"ok":true,"schema":"nexus.v2-normalization-attestor-install-receipt.v1","status":"active","transactionId":"%s","targetRuntimeSha":"%s","targetArtifactDigest":"%s","targetInstalledRuntimeDigest":"%s"}\n' \
    "$transaction_id" "$target_sha" "$target_artifact" "$target_installed"
}

recover_install() {
  source_provenance "$1" "$2" "$3" "$4"
  ensure_state_directory
  exec 9>"$BRIDGE_STATE/.install.lock"; chmod 600 "$BRIDGE_STATE/.install.lock"
  flock -n 9 || die "another bridge installer is active"
  acquire_maintenance_locks
  assert_maintenance_idle_under_lock
  if [ -e "$CONTROL_FAIL_CLOSED_MARKER" ] \
      && [ ! -e "$MAINTENANCE_MARKER" ] \
      && [ ! -e "$JOURNAL" ] \
      && [ ! -e "$STRICT_RESTORE_JOURNAL" ]; then
    assert_regular "$CONTROL_FAIL_CLOSED_MARKER" \
      "partial control-plane maintenance marker" "600"
    atomic_install "$CONTROL_FAIL_CLOSED_MARKER" "$MAINTENANCE_MARKER" 600
  fi
  if [ -e "$MAINTENANCE_MARKER" ] \
      && [ ! -e "$CONTROL_FAIL_CLOSED_MARKER" ]; then
    die "bridge maintenance marker lacks the fail-closed control marker"
  fi
  if [ -e "$STRICT_RESTORE_JOURNAL" ]; then
    recover_strict_restore
    printf '{"ok":true,"status":"%s"}\n' "$STRICT_RESTORE_RECOVERY_STATUS"
    return 0
  fi
  if [ ! -e "$JOURNAL" ] && [ -e "$MAINTENANCE_MARKER" ]; then
    marker_operation="$(
      "$SYSTEM_NODE" - "$MAINTENANCE_MARKER" <<'NODE'
const fs=require('fs');const x=JSON.parse(fs.readFileSync(process.argv[2],"utf8"));
if(!["install","restore"].includes(x.operation))process.exit(1);
process.stdout.write(x.operation);
NODE
    )" || die "pre-journal maintenance marker operation is invalid"
    validate_maintenance_marker "$marker_operation"
    current_sha="$(sha256_file "$ATTESTOR_TARGET")"
    if [ "$marker_operation" = install ]; then
      if [ "$current_sha" = "$EXPECTED_REPLACED_ATTESTOR_SHA256" ]; then
        recovery_status=pre_mutation_maintenance_recovered
      else
        bridge_sha="$(sha256_file "$BRIDGE_SOURCE")"
        [ "$current_sha" = "$bridge_sha" ] \
          || die "install marker has no journal and attestor is unknown"
        validate_active_receipt_completion "$bridge_sha"
        recovery_status=finished_install
      fi
    else
      bridge_sha="$(sha256_file "$BRIDGE_SOURCE")"
      if [ "$current_sha" = "$bridge_sha" ]; then
        assert_regular "$RECEIPT" "active bridge receipt" "600"
        receipt_bridge_sha="$(
          "$SYSTEM_NODE" - "$RECEIPT" <<'NODE'
const fs=require('fs');const x=JSON.parse(fs.readFileSync(process.argv[2],"utf8"));
if(x.schema!=="nexus.v2-normalization-attestor-install-receipt.v1"
 ||x.status!=="active"||!/^[a-f0-9]{64}$/u.test(x.installed?.bridgeSha256||""))
 process.exit(1);
process.stdout.write(x.installed.bridgeSha256);
NODE
        )" || die "active bridge receipt is invalid"
        [ "$receipt_bridge_sha" = "$bridge_sha" ] \
          || die "active bridge receipt differs from reviewed source"
        recovery_status=pre_mutation_maintenance_recovered
      elif [ "$current_sha" = "$EXPECTED_REPLACED_ATTESTOR_SHA256" ]; then
        validate_restored_receipt_completion "$bridge_sha"
        durable_remove "$RECEIPT"
        recovery_status=finished_restore
      else
        die "restore marker has no journal and attestor is unknown"
      fi
    fi
    clear_maintenance_marker
    printf '{"ok":true,"status":"%s"}\n' "$recovery_status"
    return 0
  fi
  [ -e "$JOURNAL" ] || { printf '{"ok":true,"status":"no_recovery_required"}\n'; return 0; }
  validate_maintenance_marker install
  validate_install_journal
  IFS=$'\t' read -r journal_control journal_replaced journal_bridge \
    journal_production journal_transaction journal_request journal_envelope \
    <<<"$JOURNAL_FIELDS"
  [ "$journal_control" = "$EXPECTED_CONTROL_SHA256" ] \
    && [ "$journal_replaced" = "$EXPECTED_REPLACED_ATTESTOR_SHA256" ] \
    || die "install journal does not bind exact e168 identities"
  assert_regular "$STRICT_BACKUP" "strict attestor rollback copy" "700"
  [ "$(sha256_file "$STRICT_BACKUP")" = "$journal_replaced" ] \
    || die "strict attestor rollback copy does not match the journal"
  current_sha="$(sha256_file "$ATTESTOR_TARGET")"
  if [ -e "$RECEIPT" ]; then
    [ "$current_sha" = "$journal_bridge" ] \
      || die "completed bridge receipt exists but installed attestor differs"
    validate_active_receipt_completion "$journal_bridge" "$JOURNAL"
    durable_remove "$JOURNAL"
    clear_maintenance_marker
    printf '{"ok":true,"status":"finished_install","transactionId":"%s"}\n' \
      "$journal_transaction"
    return 0
  fi
  case "$current_sha" in
    "$journal_replaced") ;;
    "$journal_bridge")
      assert_maintenance_idle_under_lock
      atomic_install "$STRICT_BACKUP" "$ATTESTOR_TARGET" 700
      ;;
    *) die "installed attestor has an unknown digest; journal retained" ;;
  esac
  [ "$(sha256_file "$ATTESTOR_TARGET")" = "$journal_replaced" ] \
    || die "strict attestor recovery verification failed"
  rollback_install interrupted_install_recovered
  printf '{"ok":true,"status":"recovered","restoredAttestorSha256":"%s"}\n' \
    "$journal_replaced"
}

validate_modern_environment() {
  local base="$1" worker_gid="$2" label="$3" identity expected_owner=0
  [ "$TEST_MODE" = 1 ] && expected_owner="$(id -u)"
  assert_regular "$base/.env" "$label modern environment" "440"
  identity="$(stat -c '%u:%g:%a' -- "$base/.env")"
  [ "$identity" = "$expected_owner:$worker_gid:440" ] \
    || die "$label environment has not reached root:worker 0440 policy"
}

restore_strict() {
  local transaction_id request_sha request_envelope_sha production_sha
  local production_base worker_gid target_runtime target_sha target_artifact
  local target_installed
  source_provenance "$1" "$2" "$3" "$4"
  ensure_state_directory
  exec 9>"$BRIDGE_STATE/.install.lock"; chmod 600 "$BRIDGE_STATE/.install.lock"
  flock -n 9 || die "another bridge installer is active"
  assert_idle
  acquire_maintenance_locks
  assert_maintenance_idle_under_lock
  [ ! -e "$JOURNAL" ] && [ ! -L "$JOURNAL" ] \
    || die "an incomplete bridge installation must be recovered first"
  [ ! -e "$STRICT_RESTORE_JOURNAL" ] \
    && [ ! -e "$MAINTENANCE_MARKER" ] \
    && [ ! -e "$CONTROL_FAIL_CLOSED_MARKER" ] \
    || die "an incomplete maintenance transaction must be recovered first"
  assert_regular "$RECEIPT" "active bridge receipt" "600"
  assert_regular "$ACCEPTANCE" "durable bridge acceptance" "600"
  assert_regular "$PRODUCTION_AUTHORIZATION" "production bridge authorization" "600"
  assert_regular "$STRICT_BACKUP" "strict attestor rollback copy" "700"
  [ "$(sha256_file "$STRICT_BACKUP")" = "$EXPECTED_REPLACED_ATTESTOR_SHA256" ] \
    || die "strict attestor rollback copy differs from exact e168"
  bridge_sha="$(sha256_file "$BRIDGE_SOURCE")"
  [ "$(sha256_file "$ATTESTOR_TARGET")" = "$bridge_sha" ] \
    || die "active installed bridge differs from reviewed source"
  RECEIPT_FIELDS="$(
    "$SYSTEM_NODE" - "$RECEIPT" "$bridge_sha" "$EXPECTED_CONTROL_SHA256" \
      "$EXPECTED_REPLACED_ATTESTOR_SHA256" <<'NODE'
const fs=require('fs');
const [file,bridge,control,replaced]=process.argv.slice(2);
const x=JSON.parse(fs.readFileSync(file,"utf8"));
if(x.schema!=="nexus.v2-normalization-attestor-install-receipt.v1"
 ||x.status!=="active"||x.installed?.bridgeSha256!==bridge
 ||x.installed?.controlSha256!==control
 ||x.installed?.replacedAttestorSha256!==replaced
 ||x.installed?.strictRestoreSha256!==replaced)process.exit(1);
process.stdout.write([x.transaction.transactionId,x.transaction.requestSha256,
 x.transaction.requestEnvelopeSha256,x.authorizations.productionSha256,
].join("\t"));
NODE
  )" || die "active bridge receipt is invalid"
  IFS=$'\t' read -r transaction_id request_sha request_envelope_sha \
    production_sha <<<"$RECEIPT_FIELDS"
  [ "$(sha256_file "$PRODUCTION_AUTHORIZATION")" = "$production_sha" ] \
    || die "stored bridge authorizations differ from the active receipt"
  "$SYSTEM_NODE" - "$ACCEPTANCE" "$transaction_id" "$request_sha" \
    "$request_envelope_sha" "$production_sha" <<'NODE'
const fs=require('fs');
const [file,transactionId,requestSha256,requestEnvelopeSha256,
 productionAuthorizationSha256]=process.argv.slice(2);
const x=JSON.parse(fs.readFileSync(file,"utf8"));
const keys=["schema","transactionId","requestSha256","requestEnvelopeSha256",
 "productionAuthorizationSha256","productionAuthorizationId","productionNonce",
 "acceptedAt"].sort().join(",");
if(!x||typeof x!=="object"||Array.isArray(x)
 ||Object.keys(x).sort().join(",")!==keys
 ||x.schema!=="nexus.v2-normalization-attestor-acceptance.v1"
 ||x.transactionId!==transactionId||x.requestSha256!==requestSha256
 ||x.requestEnvelopeSha256!==requestEnvelopeSha256
 ||x.productionAuthorizationSha256!==productionAuthorizationSha256
 ||!Number.isFinite(Date.parse(x.acceptedAt||"")))process.exit(1);
NODE
  inspect_authorizations "$PRODUCTION_AUTHORIZATION" true \
    "$EXPECTED_REPLACED_ATTESTOR_SHA256"
  IFS=$'\t' read -r inspected_id inspected_request inspected_envelope _ _ worker_gid \
    production_base target_runtime _ _ target_sha target_artifact target_installed \
    <<<"$AUTHORIZATION_FIELDS"
  rm -f -- "$AUTHORIZATION_PRODUCTION_STAGE"
  [ "$inspected_id" = "$transaction_id" ] \
    && [ "$inspected_request" = "$request_sha" ] \
    && [ "$inspected_envelope" = "$request_envelope_sha" ] \
    || die "stored bridge authorization transaction differs from the receipt"
  transaction_state="$STATE_ROOT/transactions/$transaction_id/state"
  journal="$transaction_state/journal.json"
  escrow="$transaction_state/escrow-confirmation.json"
  result="$transaction_state/result.env"
  assert_regular "$journal" "completed promotion journal" "600"
  assert_regular "$escrow" "completed promotion escrow" "600"
  assert_regular "$result" "sealed promotion result" "600"
  if ! "$SYSTEM_NODE" - "$journal" "$escrow" "$result" "$transaction_id" \
    "$request_sha" "$target_runtime" "$target_sha" "$target_artifact" \
    "$target_installed" <<'NODE'
const fs=require('fs');
const path=require('path');
const [journalPath,escrowPath,resultPath,id,requestSha,targetRuntime,targetSha,
 artifact,installed]=process.argv.slice(2);
const journal=JSON.parse(fs.readFileSync(journalPath,"utf8"));
const escrow=JSON.parse(fs.readFileSync(escrowPath,"utf8"));
const result=new Map();
for(const line of fs.readFileSync(resultPath,"utf8").split(/\r?\n/u)){
 if(line==="")continue;
 const match=line.match(/^([A-Z0-9_]+)=(.*)$/u);
 if(!match||result.has(match[1]))process.exit(1);
 result.set(match[1],match[2]);
}
const resultKeys=[
 "NEXUS_TRANSACTION_ID","NEXUS_RUNTIME_SHA","NEXUS_ARTIFACT_DIGEST",
 "NEXUS_INSTALLED_RUNTIME_DIGEST","NEXUS_TARGET_VERSION",
 "NEXUS_SENTRY_RELEASE","NEXUS_CUTOVER_STARTED_AT",
 "NEXUS_SERVICE_UNAVAILABLE_STARTED_AT","NEXUS_CANDIDATE_AVAILABLE_AT",
 "NEXUS_CUTOVER_SECONDS","NEXUS_BACKUP_WINDOW_SECONDS",
 "NEXUS_BACKUP_OUTAGE_SECONDS","NEXUS_FINAL_UNAVAILABILITY_SECONDS",
 "NEXUS_TOTAL_UNAVAILABILITY_SECONDS","NEXUS_VERIFICATION_SOAK_SECONDS",
 "NEXUS_SOAK_STARTED_AT","NEXUS_SOAK_COMPLETED_AT",
 "NEXUS_SOAK_OBSERVED_SECONDS","NEXUS_BACKUP_FILE",
 "NEXUS_BACKUP_SHA256","NEXUS_BACKUP_SIZE_BYTES",
 "NEXUS_BACKUP_ARCHIVED_VERSION","NEXUS_BACKUP_TARGET_VERSION",
 "NEXUS_BACKUP_CREATED_AT","NEXUS_BACKUP_DATABASE_SHA256",
];
const record=(value)=>value!==null&&typeof value==="object"
 &&!Array.isArray(value);
const exact=(value,keys)=>record(value)
 &&Object.keys(value).sort().join(",")===[...keys].sort().join(",");
const digest=(value)=>/^[a-f0-9]{64}$/u.test(value||"");
const integer=(value)=>/^(?:0|[1-9][0-9]*)$/u.test(value||"");
const canonicalTimestamp=(value)=>/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value||"")
 &&Number.isFinite(Date.parse(value));
const opaqueVersion=(value)=>{
 if(typeof value!=="string"||value==="null")return false;
 const encoded=Buffer.from(value,"utf8");
 return encoded.length>=1&&encoded.length<=1024
  &&encoded.toString("utf8")===value
  &&!/\p{Cc}/u.test(value);
};
const storage=escrow.storageControls;
const storagePair=(storage?.provider==="aws-s3"
 &&storage?.controlMode==="versioned-s3")
 ||(storage?.provider==="cloudflare-r2"
  &&storage?.controlMode==="r2-approved-variance");
const providerProof=(value)=>{
 const confirmed=Date.parse(value?.confirmedAt||"");
 if(!Number.isFinite(confirmed))return false;
 if(storage?.provider==="aws-s3"){
  return opaqueVersion(value?.objectVersionId)
   &&canonicalTimestamp(value?.retainUntil)
   &&Date.parse(value.retainUntil)>=confirmed+90*86400*1000
   &&value.retentionVariance===null
   &&value.approvedUnversionedVariance===false;
 }
 return storage?.provider==="cloudflare-r2"
  &&value?.objectVersionId===null&&value?.retainUntil===null
  &&value?.retentionVariance==="r2-approved-variance"
  &&value?.approvedUnversionedVariance===true;
};
const databaseProof=(value)=>{
 if(typeof value?.objectKey!=="string"
  ||value.objectKey.includes("..")||value.objectKey.includes("//")
  ||!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,900}\/database\/hourly\/nexus-db-\d{8}T\d{6}Z\.sqlite\.age$/u.test(value.objectKey)
  ||!digest(value.plaintextSha256)||!digest(value.encryptedSha256)
  ||!Number.isSafeInteger(value.encryptedSizeBytes)
  ||value.encryptedSizeBytes<=0||!canonicalTimestamp(value.confirmedAt)){
  return false;
 }
 if(storage?.provider==="aws-s3"){
  return opaqueVersion(value.objectVersionId)
   &&value.retentionVariance===null
   &&value.approvedUnversionedVariance===false;
 }
 return storage?.provider==="cloudflare-r2"
  &&value.objectVersionId===null
  &&value.retentionVariance==="r2-approved-variance"
  &&value.approvedUnversionedVariance===true;
};
const topKeys=["schema","status","transactionId","requestSha256","confirmedAt",
 "storageControls","requiredRelease","preMutationCurrentRecovery",
 "currentRecoveryRuntime","preMutationDatabaseRecoveryPoint",
 "currentDatabaseRecoveryPoint","promotionTimeline",
 "candidateReadinessRefresh"];
const storageKeys=["provider","controlMode","releasePrefixLockVerified"];
const releaseKeys=["path","plaintextSha256","objectKey","encryptedSha256",
 "encryptedSizeBytes","confirmedAt","retainUntil","objectVersionId",
 "retentionVariance","approvedUnversionedVariance","confirmed"];
const recoveryKeys=["path","plaintextSha256","objectKey","encryptedSha256",
 "encryptedSizeBytes","runtimeSha","artifactDigest","installedRuntimeDigest",
 "recoveryRuntimeDigest","releaseManifestSha256","stagingAttestationSha256",
 "escrowId","escrowPhase","confirmedAt","retainUntil","objectVersionId",
 "retentionVariance","approvedUnversionedVariance","confirmed"];
const databaseKeys=["objectKey","plaintextSha256","encryptedSha256",
 "encryptedSizeBytes","objectVersionId","confirmedAt","retentionVariance",
 "approvedUnversionedVariance"];
const timelineKeys=["cutoverStartedAt","serviceUnavailableStartedAt",
 "soakCompletedAt"];
const readinessKeys=["schema","status","transactionId","runtimeSha",
 "packageVersion","verifiedAt","checks"];
const checkKeys=["loopbackBackend","contentEngine","pm2Identity",
 "publicHealth","authenticatedSnapshot"];
const r=escrow.requiredRelease;
const pre=escrow.preMutationCurrentRecovery;
const current=escrow.currentRecoveryRuntime;
const preDatabase=escrow.preMutationDatabaseRecoveryPoint;
const currentDatabase=escrow.currentDatabaseRecoveryPoint;
const timeline=escrow.promotionTimeline;
const refresh=escrow.candidateReadinessRefresh;
const before=refresh?.beforeEscrow;
const after=refresh?.afterEscrow;
const readiness=(value)=>exact(value,readinessKeys)
 &&value.schema==="nexus.candidate-readiness-refresh.v1"
 &&value.status==="passed"&&value.transactionId===id
 &&value.runtimeSha===targetSha
 &&value.packageVersion===result.get("NEXUS_TARGET_VERSION")
 &&canonicalTimestamp(value.verifiedAt)&&exact(value.checks,checkKeys)
 &&Object.values(value.checks).every((check)=>check===true);
const safeObjectKey=(value)=>typeof value==="string"
 &&!value.includes("..")&&!value.includes("//")&&value.length<=1024;
const stable=["path","plaintextSha256","runtimeSha","artifactDigest",
 "installedRuntimeDigest","recoveryRuntimeDigest","releaseManifestSha256",
 "stagingAttestationSha256","escrowId"];
const cutover=Date.parse(result.get("NEXUS_CUTOVER_STARTED_AT")||"");
const unavailable=Date.parse(
 result.get("NEXUS_SERVICE_UNAVAILABLE_STARTED_AT")||"",
);
const candidate=Date.parse(result.get("NEXUS_CANDIDATE_AVAILABLE_AT")||"");
const soakStart=Date.parse(result.get("NEXUS_SOAK_STARTED_AT")||"");
const soakEnd=Date.parse(result.get("NEXUS_SOAK_COMPLETED_AT")||"");
const releaseConfirmed=Date.parse(r?.confirmedAt||"");
const preConfirmed=Date.parse(pre?.confirmedAt||"");
const currentConfirmed=Date.parse(current?.confirmedAt||"");
const preDatabaseConfirmed=Date.parse(preDatabase?.confirmedAt||"");
const currentDatabaseConfirmed=Date.parse(currentDatabase?.confirmedAt||"");
const beforeVerified=Date.parse(before?.verifiedAt||"");
const afterVerified=Date.parse(after?.verifiedAt||"");
const escrowConfirmed=Date.parse(escrow.confirmedAt||"");
const completed=Date.parse(journal.completedAt||"");
const version=result.get("NEXUS_TARGET_VERSION")||"";
const backup=result.get("NEXUS_BACKUP_FILE")||"";
const backupSha=result.get("NEXUS_BACKUP_SHA256")||"";
if(result.size!==resultKeys.length
 ||resultKeys.some((key)=>!result.has(key))
 ||result.get("NEXUS_TRANSACTION_ID")!==id
 ||result.get("NEXUS_RUNTIME_SHA")!==targetSha
 ||result.get("NEXUS_ARTIFACT_DIGEST")!==artifact
 ||result.get("NEXUS_INSTALLED_RUNTIME_DIGEST")!==installed
 ||result.get("NEXUS_SENTRY_RELEASE")!==targetSha
 ||!/^[0-9A-Za-z.+-]+$/u.test(version)
 ||result.get("NEXUS_BACKUP_TARGET_VERSION")!==version
 ||!/^[0-9A-Za-z.+-]+$/u.test(
  result.get("NEXUS_BACKUP_ARCHIVED_VERSION")||"",
 )
 ||!path.isAbsolute(backup)||!path.basename(backup).startsWith("v")
 ||!path.basename(backup).endsWith(".tar.gz")
 ||/\p{Cc}/u.test(path.basename(backup))
 ||!digest(backupSha)||!digest(result.get("NEXUS_BACKUP_DATABASE_SHA256"))
 ||!integer(result.get("NEXUS_BACKUP_SIZE_BYTES"))
 ||Number(result.get("NEXUS_BACKUP_SIZE_BYTES"))<1
 ||!canonicalTimestamp(result.get("NEXUS_BACKUP_CREATED_AT"))
 ||result.get("NEXUS_VERIFICATION_SOAK_SECONDS")!=="60"
 ||!["NEXUS_CUTOVER_SECONDS","NEXUS_BACKUP_WINDOW_SECONDS",
  "NEXUS_BACKUP_OUTAGE_SECONDS","NEXUS_FINAL_UNAVAILABILITY_SECONDS",
  "NEXUS_TOTAL_UNAVAILABILITY_SECONDS","NEXUS_SOAK_OBSERVED_SECONDS"]
  .every((key)=>integer(result.get(key)))
 ||result.get("NEXUS_BACKUP_OUTAGE_SECONDS")
  !==result.get("NEXUS_BACKUP_WINDOW_SECONDS")
 ||result.get("NEXUS_FINAL_UNAVAILABILITY_SECONDS")
  !==result.get("NEXUS_TOTAL_UNAVAILABILITY_SECONDS")
 ||Number(result.get("NEXUS_SOAK_OBSERVED_SECONDS"))<60
 ||Number(result.get("NEXUS_SOAK_OBSERVED_SECONDS"))>180
 ||Number(result.get("NEXUS_TOTAL_UNAVAILABILITY_SECONDS"))>60
 ||!["NEXUS_CUTOVER_STARTED_AT","NEXUS_SERVICE_UNAVAILABLE_STARTED_AT",
  "NEXUS_CANDIDATE_AVAILABLE_AT","NEXUS_SOAK_STARTED_AT",
  "NEXUS_SOAK_COMPLETED_AT"].every(
   (key)=>canonicalTimestamp(result.get(key)),
  )
 ||![cutover,unavailable,candidate,soakStart,soakEnd].every(Number.isFinite)
 ||cutover>unavailable||unavailable>candidate||candidate>soakStart
 ||soakStart>soakEnd
 ||journal.schema!=="nexus.promotion-transaction-journal.v1"
 ||journal.transactionId!==id||journal.requestSha256!==requestSha
 ||journal.phase!=="completed"||journal.status!=="completed"
 ||journal.escrowConfirmed!==true||!canonicalTimestamp(journal.completedAt)
 ||!exact(escrow,topKeys)
 ||escrow.schema!=="nexus.promotion-dr-escrow.v3"
 ||escrow.status!=="passed"||escrow.transactionId!==id
 ||escrow.requestSha256!==requestSha||!canonicalTimestamp(escrow.confirmedAt)
 ||!exact(storage,storageKeys)||!storagePair
 ||storage.releasePrefixLockVerified!==true
 ||!exact(r,releaseKeys)||r.confirmed!==true||r.path!==backup
 ||r.plaintextSha256!==backupSha||!digest(r.encryptedSha256)
 ||!Number.isSafeInteger(r.encryptedSizeBytes)||r.encryptedSizeBytes<=0
 ||!safeObjectKey(r.objectKey)||!r.objectKey.endsWith(`.${backupSha}.age`)
 ||!providerProof(r)
 ||!exact(pre,recoveryKeys)||!exact(current,recoveryKeys)
 ||pre.confirmed!==true||current.confirmed!==true
 ||pre.path!==targetRuntime||current.path!==targetRuntime
 ||pre.runtimeSha!==targetSha||current.runtimeSha!==targetSha
 ||pre.artifactDigest!==artifact||current.artifactDigest!==artifact
 ||pre.installedRuntimeDigest!==installed
 ||current.installedRuntimeDigest!==installed
 ||!digest(pre.plaintextSha256)||!digest(current.plaintextSha256)
 ||!digest(pre.encryptedSha256)||!digest(current.encryptedSha256)
 ||!digest(pre.recoveryRuntimeDigest)
 ||!digest(pre.releaseManifestSha256)||!digest(pre.stagingAttestationSha256)
 ||!Number.isSafeInteger(pre.encryptedSizeBytes)||pre.encryptedSizeBytes<=0
 ||!Number.isSafeInteger(current.encryptedSizeBytes)
 ||current.encryptedSizeBytes<=0
 ||pre.escrowId!==id||current.escrowId!==id
 ||pre.escrowPhase!=="pre-mutation"||current.escrowPhase!=="post-soak"
 ||!safeObjectKey(pre.objectKey)||!safeObjectKey(current.objectKey)
 ||!pre.objectKey.endsWith(
  `+escrow-${id}+phase-pre-mutation.tar.gz.${pre.plaintextSha256}.age`,
 )
 ||!current.objectKey.endsWith(
  `+escrow-${id}+phase-post-soak.tar.gz.${current.plaintextSha256}.age`,
 )
 ||!providerProof(pre)||!providerProof(current)
 ||stable.some((field)=>pre[field]!==current[field])
 ||!exact(preDatabase,databaseKeys)||!exact(currentDatabase,databaseKeys)
 ||!databaseProof(preDatabase)||!databaseProof(currentDatabase)
 ||!exact(timeline,timelineKeys)
 ||timeline.cutoverStartedAt!==result.get("NEXUS_CUTOVER_STARTED_AT")
 ||timeline.serviceUnavailableStartedAt
  !==result.get("NEXUS_SERVICE_UNAVAILABLE_STARTED_AT")
 ||timeline.soakCompletedAt!==result.get("NEXUS_SOAK_COMPLETED_AT")
 ||!exact(refresh,["beforeEscrow","afterEscrow"])
 ||!readiness(before)||!readiness(after)
 ||![releaseConfirmed,preConfirmed,currentConfirmed,preDatabaseConfirmed,
  currentDatabaseConfirmed,beforeVerified,afterVerified,escrowConfirmed,
  completed].every(Number.isFinite)
 ||preDatabaseConfirmed>cutover||preDatabaseConfirmed>unavailable
 ||preConfirmed>cutover||preConfirmed>unavailable
 ||currentDatabaseConfirmed<soakEnd
 ||currentDatabaseConfirmed<preDatabaseConfirmed
 ||currentConfirmed<soakEnd||currentConfirmed<preConfirmed
 ||beforeVerified<soakEnd||releaseConfirmed<beforeVerified
 ||currentConfirmed<beforeVerified||currentDatabaseConfirmed<beforeVerified
 ||afterVerified<beforeVerified||afterVerified<releaseConfirmed
 ||afterVerified<currentConfirmed||afterVerified<currentDatabaseConfirmed
 ||escrowConfirmed!==Math.max(
  releaseConfirmed,currentConfirmed,currentDatabaseConfirmed,
 )
 ||completed<afterVerified)process.exit(1);
NODE
  then
    die "completed promotion escrow-v3 evidence is invalid"
  fi
  validate_modern_environment "$production_base" "$worker_gid" production
  write_maintenance_marker restore "$transaction_id" "$request_sha" \
    "$EXPECTED_CONTROL_SHA256" "$bridge_sha"
  INSTALL_MUTATED=true
  trap restore_failure_trap EXIT
  if [ -e "$BRIDGE_BACKUP" ] || [ -L "$BRIDGE_BACKUP" ]; then
    assert_regular "$BRIDGE_BACKUP" "installed bridge rollback copy" "700"
    [ "$(sha256_file "$BRIDGE_BACKUP")" = "$bridge_sha" ] \
      || die "installed bridge rollback copy differs from active bridge"
  else
    atomic_install "$ATTESTOR_TARGET" "$BRIDGE_BACKUP" 700
  fi
  write_strict_restore_journal "$transaction_id" "$request_sha" "$bridge_sha" \
    "$(sha256_file "$RECEIPT")"
  strict_restore_checkpoint prepared
  assert_maintenance_idle_under_lock
  atomic_install "$STRICT_BACKUP" "$ATTESTOR_TARGET" 700
  [ "$(sha256_file "$ATTESTOR_TARGET")" = "$EXPECTED_REPLACED_ATTESTOR_SHA256" ] \
    || die "strict attestor restore verification failed"
  strict_restore_checkpoint swapped
  temporary="$(mktemp -p "$BRIDGE_STATE" ".restored-receipt.XXXXXX")"
  "$SYSTEM_NODE" - "$temporary" "$transaction_id" "$request_sha" \
    "$EXPECTED_REPLACED_ATTESTOR_SHA256" "$target_sha" "$target_artifact" \
    "$target_installed" <<'NODE'
const fs=require('fs');
const [output,transactionId,requestSha256,strictAttestorSha256,targetRuntimeSha,
 targetArtifactDigest,targetInstalledRuntimeDigest]=process.argv.slice(2);
fs.writeFileSync(output,`${JSON.stringify({
 schema:"nexus.v2-normalization-attestor-restored.v1",status:"complete",
 transactionId,requestSha256,strictAttestorSha256,
 target:{runtimeSha:targetRuntimeSha,artifactDigest:targetArtifactDigest,
  installedRuntimeDigest:targetInstalledRuntimeDigest},
 gates:{promotionCompleted:true,escrowConfirmed:true,soakSeconds:60,
  productionEnvironment:"root:worker:0440",
  stagingNormalization:"separate_owner_signed_transaction_required",
  selectorAdoption:"post_terminal_only_not_performed_by_this_installer",
  pm2BootAuthority:"external_activation_prerequisite"},
 restoredAt:new Date().toISOString(),
},null,2)}\n`,{mode:0o600,flag:"w"});
NODE
  chmod 600 "$temporary"; if [ "$TEST_MODE" != 1 ]; then chown root:root "$temporary"; fi
  fsync_path "$temporary"; mv -fT -- "$temporary" "$RESTORED_RECEIPT"
  fsync_path "$BRIDGE_STATE"
  strict_restore_checkpoint receipt_published
  durable_remove "$RECEIPT"
  durable_remove "$STRICT_RESTORE_JOURNAL"
  strict_restore_crash_point journal_removed
  clear_maintenance_marker
  INSTALL_COMPLETE=true
  trap - EXIT
  printf '{"ok":true,"status":"restored","transactionId":"%s","strictAttestorSha256":"%s"}\n' \
    "$transaction_id" "$EXPECTED_REPLACED_ATTESTOR_SHA256"
}

status_bridge() {
  ensure_state_directory
  "$SYSTEM_NODE" - "$JOURNAL" "$STRICT_RESTORE_JOURNAL" \
    "$MAINTENANCE_MARKER" "$CONTROL_FAIL_CLOSED_MARKER" \
    "$RECEIPT" "$RESTORED_RECEIPT" "$ATTESTOR_TARGET" <<'NODE'
const crypto=require('crypto'),fs=require('fs');
const [journal,strictJournal,maintenance,controlMarker,receipt,restored,target]
 =process.argv.slice(2);
const exists=(file)=>fs.existsSync(file);
const digest=exists(target)&&fs.lstatSync(target).isFile()
 ?crypto.createHash("sha256").update(fs.readFileSync(target)).digest("hex"):null;
process.stdout.write(`${JSON.stringify({
 ok:true,installJournalPresent:exists(journal),activeReceiptPresent:exists(receipt),
 strictRestoreJournalPresent:exists(strictJournal),
 maintenanceMarkerPresent:exists(maintenance),
 controlFailClosedMarkerPresent:exists(controlMarker),
 restoredReceiptPresent:exists(restored),installedAttestorSha256:digest,
})}\n`);
NODE
}

case "$COMMAND" in
  install) install_bridge "$@" ;;
  recover) recover_install "$@" ;;
  restore) restore_strict "$@" ;;
  status) status_bridge ;;
esac
