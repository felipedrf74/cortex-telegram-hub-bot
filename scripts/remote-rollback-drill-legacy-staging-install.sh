#!/usr/bin/env bash
# Transactional installer for the non-promotable control-v2 legacy staging
# drill adapter. It accepts only a root-owned, SHA-bound bootstrap source and
# proves every privileged input against the Git archive before installation.
set -euo pipefail
umask 077
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH

SCRIPT_NAME="$(basename -- "${BASH_SOURCE[0]}")"
COMMAND="${1:-}"
[ "$#" -gt 0 ] && shift
TEST_MODE="${NEXUS_LEGACY_DRILL_INSTALL_TEST_MODE:-0}"
if [ "$TEST_MODE" = 1 ] && [ "$EUID" -eq 0 ]; then
  echo "legacy staging drill installer: test mode may not cross a privileged uid boundary" >&2
  exit 77
fi
PROFILE_MODE=control-v2
if [ "$SCRIPT_NAME" = nexus-rollback-drill-v4-prelayout-staging-install ] \
    || [ "$COMMAND" = install-v4-prelayout ] \
    || [ "$COMMAND" = recover-v4-prelayout ] \
    || [ "$COMMAND" = activate-from-phase-a ] \
    || [ "$COMMAND" = retire-for-layout ] \
    || { [ "$TEST_MODE" = 1 ] \
      && [ "${NEXUS_LEGACY_DRILL_PROFILE:-}" = v4-prelayout ]; }; then
  PROFILE_MODE=v4-prelayout
fi
case "$COMMAND" in
  install-v4-prelayout) COMMAND=install ;;
  recover-v4-prelayout) COMMAND=recover ;;
esac

die() {
  echo "legacy staging drill installer: $*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage:
  sudo <sha-bound-source>/scripts/remote-rollback-drill-legacy-staging-install.sh install \
    <source-root> <40-hex-source-sha> <source-archive> <64-hex-archive-sha256>
  sudo <sha-bound-source>/scripts/remote-rollback-drill-legacy-staging-install.sh recover \
    <source-root> <40-hex-source-sha> <source-archive> <64-hex-archive-sha256>
  sudo /usr/local/sbin/nexus-rollback-drill-legacy-staging-install \
    recover-journal
  sudo /usr/local/sbin/nexus-rollback-drill-v4-prelayout-staging-install \
    activate-from-phase-a <resolved-marker-sha256|none>
  sudo /usr/local/sbin/nexus-rollback-drill-v4-prelayout-staging-install \
    retire-for-layout
  sudo <reviewed-installer>/remote-rollback-drill-legacy-staging-install.sh uninstall
  sudo <reviewed-installer>/remote-rollback-drill-legacy-staging-install.sh \
    phase-a-retirement-plan
  sudo <sha-bound-source>/scripts/remote-rollback-drill-legacy-staging-install.sh status
  sudo <sha-bound-source>/scripts/remote-rollback-drill-legacy-staging-install.sh install-v4-prelayout \
    <source-root> <40-hex-source-sha> <source-archive> <64-hex-archive-sha256>
EOF
}

case "$COMMAND" in
  install|recover) [ "$#" -eq 4 ] || { usage >&2; exit 64; } ;;
  activate-from-phase-a)
    [ "$#" -eq 1 ] || { usage >&2; exit 64; }
    ;;
  recover-journal|retire-for-layout|status|uninstall|phase-a-retirement-plan)
    [ "$#" -eq 0 ] || { usage >&2; exit 64; }
    ;;
  *) usage >&2; exit 64 ;;
esac
if [ "$PROFILE_MODE" = v4-prelayout ] \
    && { [ "$COMMAND" = uninstall ] \
      || [ "$COMMAND" = phase-a-retirement-plan ]; }; then
  die "v4 pre-layout drill retirement is owned by the layout transition"
fi
if [ "$COMMAND" = retire-for-layout ] && [ "$PROFILE_MODE" != v4-prelayout ]; then
  die "layout retirement is available only to the v4 pre-layout profile"
fi

if [ "$TEST_MODE" != 1 ]; then
  [ "$EUID" -eq 0 ] || {
    echo "legacy staging drill installer must run as root" >&2
    exit 77
  }
fi

BOOTSTRAP_BASE="${NEXUS_LEGACY_DRILL_BOOTSTRAP_BASE:-/var/lib/nexus-release-bootstrap}"
if [ "$PROFILE_MODE" = v4-prelayout ]; then
  DEFAULT_STATE_ROOT=/var/lib/nexus-rollback-drill-v4-prelayout-staging
  INSTALLER_NAME=nexus-rollback-drill-v4-prelayout-staging-install
  BROKER_NAME=nexus-rollback-drill-v4-prelayout-staging-broker
  ADAPTER_NAME=nexus-rollback-drill-v4-prelayout-staging-adapter.mjs
  FILESYSTEM_HELPER_NAME=nexus-rollback-drill-v4-prelayout-staging-fs.py
  INSTALL_RECOVERY_UNIT_NAME=nexus-rollback-drill-v4-prelayout-staging-install-recovery.service
  TRANSACTION_UNIT_NAME=nexus-rollback-drill-v4-prelayout-staging@.service
  RECOVERY_UNIT_NAME=nexus-rollback-drill-v4-prelayout-staging-recovery.service
  PM2_DROP_IN_NAME=15-nexus-rollback-drill-v4-prelayout-staging-recovery.conf
  PROMOTION_RECOVERY_DROP_IN_NAME=15-nexus-rollback-drill-v4-prelayout-promotion-recovery.conf
  SUDOERS_NAME=nexus-rollback-drill-v4-prelayout-staging
  DEPENDENCY_NAME=nexus-rollback-drill-v4-prelayout-runtime-dependencies.mjs
  INSTALLED_ATTESTOR_NAME=nexus-rollback-drill-v4-prelayout-installed-tree-attestation.mjs
  RECOVERY_ATTESTOR_NAME=nexus-rollback-drill-v4-prelayout-recovery-runtime-identity.mjs
  PUBLIC_KEY_NAME=rollback-drill-v4-prelayout-release-evidence-public-key.pem
  EXPECTED_CONTROL_VERSION=nexus-release-promotion-control.v4
  RECEIPT_SCHEMA=nexus.rollback-drill-v4-prelayout-staging-install-receipt.v1
  EXPECTED_BROKER_VERSION=nexus-rollback-drill-v4-prelayout-staging-broker.v1
else
  DEFAULT_STATE_ROOT=/var/lib/nexus-rollback-drill-legacy-staging
  INSTALLER_NAME=nexus-rollback-drill-legacy-staging-install
  BROKER_NAME=nexus-rollback-drill-legacy-staging-broker
  ADAPTER_NAME=nexus-rollback-drill-legacy-staging-adapter.mjs
  FILESYSTEM_HELPER_NAME=nexus-rollback-drill-legacy-staging-fs.py
  INSTALL_RECOVERY_UNIT_NAME=nexus-rollback-drill-legacy-staging-install-recovery.service
  TRANSACTION_UNIT_NAME=nexus-rollback-drill-legacy-staging@.service
  RECOVERY_UNIT_NAME=nexus-rollback-drill-legacy-staging-recovery.service
  PM2_DROP_IN_NAME=10-nexus-rollback-drill-legacy-staging-recovery.conf
  PROMOTION_RECOVERY_DROP_IN_NAME=
  SUDOERS_NAME=nexus-rollback-drill-legacy-staging
  DEPENDENCY_NAME=nexus-release-runtime-dependencies.mjs
  INSTALLED_ATTESTOR_NAME=nexus-release-installed-tree-attestation.mjs
  RECOVERY_ATTESTOR_NAME=nexus-release-recovery-runtime-identity.mjs
  PUBLIC_KEY_NAME=release-evidence-public-key.pem
  EXPECTED_CONTROL_VERSION=nexus-release-promotion-control.v2
  RECEIPT_SCHEMA=nexus.rollback-drill-legacy-staging-install-receipt.v1
  EXPECTED_BROKER_VERSION=nexus-rollback-drill-legacy-staging-broker.v1
fi
STATE_ROOT="${NEXUS_LEGACY_DRILL_STATE_ROOT:-$DEFAULT_STATE_ROOT}"
INSTALL_STATE="$STATE_ROOT/install"
JOURNAL="$INSTALL_STATE/install-in-progress.v1.json"
BACKUPS="$INSTALL_STATE/predecessor"
UNINSTALL_JOURNAL="$INSTALL_STATE/uninstall-in-progress.v1.json"
UNINSTALL_BACKUPS="$INSTALL_STATE/active-adapter"
RECEIPT="$STATE_ROOT/install-receipt.v1.json"
RETIREMENT_JOURNAL="$INSTALL_STATE/retire-for-layout-in-progress.v1.json"
RETIRED_RECEIPT="$STATE_ROOT/install-receipt.retired.v1.json"
RETIREMENT_RECEIPT="$STATE_ROOT/retirement-receipt.v1.json"
CONTROL_BIN="${NEXUS_LEGACY_DRILL_CONTROL_BIN:-/usr/local/sbin/nexus-release-promotion-control}"
LAYOUT_CONTROL_BIN="${NEXUS_LEGACY_DRILL_LAYOUT_CONTROL_BIN:-/usr/local/sbin/nexus-release-layout-activation-control}"
EXPECTED_CONTROL_SHA256="${NEXUS_LEGACY_DRILL_EXPECTED_CONTROL_SHA256:-fb66d9257ec0b7b6f2c582d326c5ed3f6c01071f5792a4045c42199b6691edf1}"
PHASE_A_RECEIPT="${NEXUS_LEGACY_DRILL_PHASE_A_RECEIPT:-/var/lib/nexus-release-promotion/layout-activation/phase-a-receipt.v1.json}"
LEGACY_V2_ACTIVE_RECEIPT="${NEXUS_LEGACY_DRILL_V2_ACTIVE_RECEIPT:-/var/lib/nexus-rollback-drill-legacy-staging/install-receipt.v1.json}"
LEGACY_V2_RETIRED_RECEIPT="${NEXUS_LEGACY_DRILL_V2_RETIRED_RECEIPT:-/var/lib/nexus-rollback-drill-legacy-staging/install-receipt.retired.v1.json}"
EXPECTED_SQLITE_HELPER_SHA256="${NEXUS_LEGACY_DRILL_EXPECTED_SQLITE_HELPER_SHA256:-e1f1a92d4dc49bd6fe6c1d8c1a3573ec2db61f6374a1831b2765a5541943708d}"
NODE_BIN="${NEXUS_LEGACY_DRILL_NODE_BIN:-/usr/bin/node}"
SYSTEMCTL_BIN="${NEXUS_LEGACY_DRILL_SYSTEMCTL_BIN:-/usr/bin/systemctl}"
VISUDO_BIN="${NEXUS_LEGACY_DRILL_VISUDO_BIN:-/usr/sbin/visudo}"
FLOCK_BIN="${NEXUS_LEGACY_DRILL_FLOCK_BIN:-/usr/bin/flock}"
PROC_ROOT="${NEXUS_LEGACY_DRILL_PROC_ROOT:-/proc}"
PROMOTION_STATE_ROOT="${NEXUS_PROMOTION_STATE_ROOT:-/var/lib/nexus-release-promotion}"
CONTROL_LOCK="$PROMOTION_STATE_ROOT/.control.lock"
PHASE_B_JOURNAL="$PROMOTION_STATE_ROOT/layout-activation/phase-b-handover-in-progress.v1.json"
PHASE_B_RECEIPT="$PROMOTION_STATE_ROOT/layout-activation/phase-b-receipt.v1.json"
PERMANENT_PM2_DROP_IN="${NEXUS_LEGACY_DRILL_PERMANENT_PM2_DROP_IN:-/etc/systemd/system/pm2-dominguez.service.d/nexus-release-recovery.conf}"
SONAR_LOCK="${NEXUS_LEGACY_DRILL_SONAR_LOCK:-/run/lock/nexus-release-sonar.lock}"
WORKER_USER="${NEXUS_LEGACY_DRILL_WORKER_USER:-dominguez}"
TARGET_ROOT="${NEXUS_LEGACY_DRILL_INSTALL_TARGET_ROOT:-}"
MUTATED=false
COMPLETE=false
UNINSTALL_ACTIVE=false
PHASE_A_SOURCE_SHA=
PHASE_A_ARCHIVE_SHA256=
PHASE_A_RECEIPT_SHA256=
PHASE_A_CONTROL_SHA256=

target() {
  if [ "$TEST_MODE" = 1 ]; then
    [ -n "$TARGET_ROOT" ] || die "test target root is required"
    printf '%s%s' "$TARGET_ROOT" "$1"
  else
    printf '%s' "$1"
  fi
}

INSTALLER_TARGET="$(target "/usr/local/sbin/$INSTALLER_NAME")"
INSTALL_RECOVERY_UNIT_TARGET="$(target "/etc/systemd/system/$INSTALL_RECOVERY_UNIT_NAME")"
BROKER_TARGET="$(target "/usr/local/sbin/$BROKER_NAME")"
ADAPTER_TARGET="$(target "/usr/local/libexec/$ADAPTER_NAME")"
DEPENDENCY_TARGET="$(target "/usr/local/libexec/$DEPENDENCY_NAME")"
INSTALLED_ATTESTOR_TARGET="$(target "/usr/local/libexec/$INSTALLED_ATTESTOR_NAME")"
RECOVERY_ATTESTOR_TARGET="$(target "/usr/local/libexec/$RECOVERY_ATTESTOR_NAME")"
PUBLIC_KEY_TARGET="$(target "/etc/nexus-release/$PUBLIC_KEY_NAME")"
TRANSACTION_UNIT_TARGET="$(target "/etc/systemd/system/$TRANSACTION_UNIT_NAME")"
RECOVERY_UNIT_TARGET="$(target "/etc/systemd/system/$RECOVERY_UNIT_NAME")"
PM2_DOMINGUEZ_DROP_IN_TARGET="$(target "/etc/systemd/system/pm2-dominguez.service.d/$PM2_DROP_IN_NAME")"
PM2_ROOT_DROP_IN_TARGET="$(target "/etc/systemd/system/pm2-root.service.d/$PM2_DROP_IN_NAME")"
PROMOTION_RECOVERY_DROP_IN_TARGET=
if [ "$PROFILE_MODE" = v4-prelayout ]; then
  PROMOTION_RECOVERY_DROP_IN_TARGET="$(
    target "/etc/systemd/system/nexus-release-promotion-recovery.service.d/$PROMOTION_RECOVERY_DROP_IN_NAME"
  )"
fi
SUDOERS_TARGET="$(target "/etc/sudoers.d/$SUDOERS_NAME")"
SQLITE_HELPER_TARGET="$(target /usr/local/libexec/nexus-application-dr/application-dr-sqlite.py)"
FILESYSTEM_HELPER_TARGET="$(target "/usr/local/libexec/$FILESYSTEM_HELPER_NAME")"
LEGACY_BASE="$(target /home/dominguez/telegram-hub-bot-staging)"
TARGETS=(
  "$INSTALLER_TARGET"
  "$INSTALL_RECOVERY_UNIT_TARGET"
  "$BROKER_TARGET"
  "$ADAPTER_TARGET"
  "$DEPENDENCY_TARGET"
  "$INSTALLED_ATTESTOR_TARGET"
  "$RECOVERY_ATTESTOR_TARGET"
  "$PUBLIC_KEY_TARGET"
  "$TRANSACTION_UNIT_TARGET"
  "$RECOVERY_UNIT_TARGET"
  "$PM2_DOMINGUEZ_DROP_IN_TARGET"
  "$PM2_ROOT_DROP_IN_TARGET"
  "$SUDOERS_TARGET"
  "$FILESYSTEM_HELPER_TARGET"
)
if [ "$PROFILE_MODE" = v4-prelayout ]; then
  TARGETS+=("$PROMOTION_RECOVERY_DROP_IN_TARGET")
fi

for utility in chmod chown cut dirname id install mktemp mv \
  python3 realpath rm sha256sum stat; do
  command -v "$utility" >/dev/null 2>&1 || die "$utility is required"
done
[ -x "$NODE_BIN" ] || die "trusted system Node is unavailable"
[ -x "$CONTROL_BIN" ] || die "exact promotion control is unavailable"
[ -x "$FLOCK_BIN" ] || die "flock is unavailable"
if [ "$TEST_MODE" != 1 ]; then
  [ "$("$NODE_BIN" --version)" = v22.23.1 ] \
    || die "trusted system Node must be exactly v22.23.1"
  [ "$WORKER_USER" = dominguez ] \
    || die "production release worker may not be overridden"
  if [ "$PROFILE_MODE" = control-v2 ]; then
    [ "$EXPECTED_CONTROL_SHA256" = fb66d9257ec0b7b6f2c582d326c5ed3f6c01071f5792a4045c42199b6691edf1 ] \
      || die "production promotion-control digest may not be overridden"
  else
    [ "$STATE_ROOT" = /var/lib/nexus-rollback-drill-v4-prelayout-staging ] \
      && [ "$PHASE_A_RECEIPT" = /var/lib/nexus-release-promotion/layout-activation/phase-a-receipt.v1.json ] \
      && [ "$LAYOUT_CONTROL_BIN" = /usr/local/sbin/nexus-release-layout-activation-control ] \
      && [ "$PHASE_B_JOURNAL" = /var/lib/nexus-release-promotion/layout-activation/phase-b-handover-in-progress.v1.json ] \
      && [ "$PHASE_B_RECEIPT" = /var/lib/nexus-release-promotion/layout-activation/phase-b-receipt.v1.json ] \
      && [ "$PERMANENT_PM2_DROP_IN" = /etc/systemd/system/pm2-dominguez.service.d/nexus-release-recovery.conf ] \
      && [ "$LEGACY_V2_ACTIVE_RECEIPT" = /var/lib/nexus-rollback-drill-legacy-staging/install-receipt.v1.json ] \
      && [ "$LEGACY_V2_RETIRED_RECEIPT" = /var/lib/nexus-rollback-drill-legacy-staging/install-receipt.retired.v1.json ] \
      || die "production v4 pre-layout identity may not be overridden"
  fi
  [ "$EXPECTED_SQLITE_HELPER_SHA256" = e1f1a92d4dc49bd6fe6c1d8c1a3573ec2db61f6374a1831b2765a5541943708d ] \
    || die "production SQLite helper digest may not be overridden"
  [ -x "$SYSTEMCTL_BIN" ] && [ -x "$VISUDO_BIN" ] \
    || die "systemctl and visudo are required"
fi

sha256_file() {
  sha256sum -- "$1" | cut -d' ' -f1
}

fsync_path() {
  "$NODE_BIN" - "$1" <<'NODE'
const fs=require('node:fs');const fd=fs.openSync(process.argv[2],'r');
try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
NODE
}

backup_inventory_json() {
  local kind="$1" backups receipt
  case "$kind" in
    install)
      backups="$BACKUPS"
      receipt=-
      ;;
    uninstall)
      backups="$UNINSTALL_BACKUPS"
      receipt="$UNINSTALL_BACKUPS/receipt.json"
      ;;
    *) die "backup inventory kind is invalid" ;;
  esac
  "$NODE_BIN" - "$kind" "$TEST_MODE" "$backups" "$receipt" \
    "$LEGACY_BASE" "$LEGACY_BASE/releases" "${TARGETS[@]}" <<'NODE'
const crypto=require('node:crypto');const fs=require('node:fs');const path=require('node:path');
const [kind,testMode,backups,receipt,...paths]=process.argv.slice(2);
const parentPaths=paths.splice(0,2);
const sha=(body)=>crypto.createHash('sha256').update(body).digest('hex');
const canonical=(value)=>value===null||typeof value!=='object'
 ?JSON.stringify(value):Array.isArray(value)
  ?`[${value.map(canonical).join(',')}]`
  :`{${Object.keys(value).sort().map((key)=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
const directory=fs.lstatSync(backups,{bigint:true});
if(!directory.isDirectory()||directory.isSymbolicLink()
 ||directory.mode%0o1000n!==0o700n
 ||(testMode!=='1'&&(directory.uid!==0n||directory.gid!==0n))){
 throw new Error('backup inventory directory identity is unsafe');
}
const safe=(file,label,maximum=16*1024*1024)=>{
 const before=fs.lstatSync(file,{bigint:true});
 if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n
  ||before.mode%0o1000n!==0o600n||before.size<0n
  ||before.size>BigInt(maximum)
  ||(testMode!=='1'&&(before.uid!==0n||before.gid!==0n))){
  throw new Error(`${label} identity is unsafe`);
 }
 const descriptor=fs.openSync(
  file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0),
 );
 try{
  const opened=fs.fstatSync(descriptor,{bigint:true});
  const body=fs.readFileSync(descriptor);
  const after=fs.fstatSync(descriptor,{bigint:true});
  for(const field of ['dev','ino','size','mtimeNs','ctimeNs','nlink']){
   if(before[field]!==opened[field]||opened[field]!==after[field]){
    throw new Error(`${label} changed while it was read`);
   }
  }
  if(after.size!==BigInt(body.length)){
   throw new Error(`${label} size differs`);
  }
  return body;
 }finally{fs.closeSync(descriptor);}
};
const metadata=(file,label,pattern)=>{
 const body=safe(file,label,64).toString('utf8');
 if(!pattern.test(body))throw new Error(`${label} is invalid`);
 return body.slice(0,-1);
};
const expectedNames=new Set();
const read=(name,label,maximum)=>{
 expectedNames.add(name);
 return safe(path.join(backups,name),label,maximum);
};
const readMetadata=(name,label,pattern)=>{
 expectedNames.add(name);
 return metadata(path.join(backups,name),label,pattern);
};
const targets=paths.map((target,index)=>{
 const mode=readMetadata(`${index}.mode`,`target ${index} mode`,/^[0-7]{3,4}\n$/u);
 const uid=readMetadata(`${index}.uid`,`target ${index} uid`,/^(?:0|[1-9][0-9]*)\n$/u);
 const gid=readMetadata(`${index}.gid`,`target ${index} gid`,/^(?:0|[1-9][0-9]*)\n$/u);
 let existed='1';
 if(kind==='install'){
  existed=readMetadata(
   `${index}.existed`,`target ${index} existence`,/^[01]\n$/u,
  );
 }
 let backup=null;
 if(existed==='1'){
  const body=read(`${index}.file`,`target ${index} backup`,16*1024*1024);
  backup={sha256:sha(body),sizeBytes:body.length};
 }else if(fs.lstatSync(path.join(backups,`${index}.file`),{
  throwIfNoEntry:false,
 })){
  throw new Error(`unexpected target ${index} backup exists`);
 }
 return {
  index,path:target,existed:existed==='1',
  mode:Number.parseInt(mode,8),uid:Number(uid),gid:Number(gid),backup,
 };
});
const payload={
 schema:`nexus.rollback-drill-legacy-staging-${kind}-backup-inventory.v1`,
 targets,
};
if(kind==='install'){
 payload.parents=parentPaths.map((target,index)=>({
  index,path:target,
  existed:readMetadata(
   `parent.${index}.existed`,`parent ${index} existence`,/^[01]\n$/u,
  )==='1',
  mode:Number.parseInt(readMetadata(
   `parent.${index}.mode`,`parent ${index} mode`,/^[0-7]{3,4}\n$/u,
  ),8),
  uid:Number(readMetadata(
   `parent.${index}.uid`,`parent ${index} uid`,/^(?:0|[1-9][0-9]*)\n$/u,
  )),
  gid:Number(readMetadata(
   `parent.${index}.gid`,`parent ${index} gid`,/^(?:0|[1-9][0-9]*)\n$/u,
  )),
 }));
 payload.unitStates={
  recovery:readMetadata(
   'recovery.enabled','recovery unit state',
   /^(?:enabled|disabled|not-found)\n$/u,
  ),
  installRecovery:readMetadata(
   'install-recovery.enabled','install recovery unit state',
   /^(?:enabled|disabled|not-found)\n$/u,
  ),
 };
}else{
 const receiptBody=read('receipt.json','active adapter receipt',1024*1024);
 payload.receipt={
  sha256:sha(receiptBody),sizeBytes:receiptBody.length,
 };
}
const observedNames=fs.readdirSync(backups).sort();
const exactNames=[...expectedNames].sort();
if(canonical(observedNames)!==canonical(exactNames)){
 throw new Error('backup inventory contains unexpected entries');
}
const value={...payload,aggregateSha256:sha(Buffer.from(canonical(payload)))};
process.stdout.write(canonical(value));
NODE
}

journal_inventory_json() {
  local journal="$1" field="$2"
  "$NODE_BIN" - "$journal" "$field" <<'NODE'
const fs=require('node:fs');const [journal,field]=process.argv.slice(2);
const canonical=(value)=>value===null||typeof value!=='object'
 ?JSON.stringify(value):Array.isArray(value)
  ?`[${value.map(canonical).join(',')}]`
  :`{${Object.keys(value).sort().map((key)=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
const value=JSON.parse(fs.readFileSync(journal));
if(!value[field]||typeof value[field]!=='object'||Array.isArray(value[field])){
 process.exit(1);
}
process.stdout.write(canonical(value[field]));
NODE
}

assert_bound_backup_inventory() {
  local journal="$1" field="$2" kind="$3" bound observed
  bound="$(journal_inventory_json "$journal" "$field")" \
    || die "$kind backup inventory binding is invalid"
  observed="$(backup_inventory_json "$kind")" \
    || die "$kind backup inventory is invalid"
  [ "$bound" = "$observed" ] \
    || die "$kind backup inventory differs from its journal binding"
}

root_own() {
  [ "$TEST_MODE" = 1 ] || chown root:root "$@"
}

stat_value() {
  local format="$1" file="$2"
  if [ "$TEST_MODE" != 1 ]; then
    stat -c "$format" -- "$file"
    return
  fi
  "$NODE_BIN" - "$format" "$file" <<'NODE'
const fs=require('node:fs');
const [format,file]=process.argv.slice(2);
const value=fs.lstatSync(file);
const fields={
 '%h':String(value.nlink),
 '%u':String(value.uid),
 '%g':String(value.gid),
 '%a':(value.mode&0o7777).toString(8),
 '%s':String(value.size),
};
let output=format;
for(const [field,replacement] of Object.entries(fields)){
 output=output.replaceAll(field,replacement);
}
if(output.includes('%'))process.exit(64);
process.stdout.write(`${output}\n`);
NODE
}

canonical_path() {
  if [ "$TEST_MODE" != 1 ]; then
    realpath -e -- "$1"
    return
  fi
  "$NODE_BIN" -e \
    'process.stdout.write(require("node:fs").realpathSync(process.argv[1]))' \
    "$1"
}

move_exact() {
  if [ "$TEST_MODE" != 1 ]; then
    mv -fT -- "$1" "$2"
    return
  fi
  "$NODE_BIN" -e \
    'require("node:fs").renameSync(process.argv[1],process.argv[2])' \
    "$1" "$2"
}

assert_regular() {
  local file="$1" label="$2"
  [ -f "$file" ] && [ ! -L "$file" ] \
    && [ "$(stat_value '%h' "$file")" = 1 ] \
    && [ "$(canonical_path "$file")" = "$file" ] \
    || die "$label is not a canonical single-link regular file"
  if [ "$TEST_MODE" != 1 ]; then
    [ "$(stat_value '%u' "$file")" = 0 ] \
      || die "$label is not root-owned"
  fi
}

capture_recovery_unit_state() {
  local unit="$1" unit_file="$2" observed
  if [ ! -e "$unit_file" ] && [ ! -L "$unit_file" ]; then
    observed="$("$SYSTEMCTL_BIN" is-enabled "$unit" 2>/dev/null || true)"
    [ "$observed" = not-found ] \
      || die "missing recovery unit has unexpected enablement state: $unit"
    printf '%s\n' not-found
    return
  fi
  assert_regular "$unit_file" "predecessor recovery unit"
  observed="$("$SYSTEMCTL_BIN" is-enabled "$unit" 2>/dev/null || true)"
  case "$observed" in
    enabled|disabled) printf '%s\n' "$observed" ;;
    *) die "predecessor recovery unit enablement state is unsupported: $unit" ;;
  esac
}

assert_recovery_unit_state() {
  local unit="$1" expected="$2" observed
  observed="$("$SYSTEMCTL_BIN" is-enabled "$unit" 2>/dev/null || true)"
  [ "$observed" = "$expected" ] \
    || die "recovery unit enablement restoration differs: $unit"
}

disable_recovery_unit_if_present() {
  local unit="$1" unit_file="$2"
  if [ ! -e "$unit_file" ] && [ ! -L "$unit_file" ]; then
    return
  fi
  assert_regular "$unit_file" "active recovery unit"
  "$SYSTEMCTL_BIN" disable "$unit" >/dev/null
  assert_recovery_unit_state "$unit" disabled
}

restore_recovery_unit_state() {
  local unit="$1" unit_file="$2" expected="$3"
  case "$expected" in
    enabled)
      assert_regular "$unit_file" "restored predecessor recovery unit"
      "$SYSTEMCTL_BIN" enable "$unit" >/dev/null
      assert_recovery_unit_state "$unit" enabled
      ;;
    disabled)
      assert_regular "$unit_file" "restored predecessor recovery unit"
      "$SYSTEMCTL_BIN" disable "$unit" >/dev/null
      assert_recovery_unit_state "$unit" disabled
      ;;
    not-found)
      [ ! -e "$unit_file" ] && [ ! -L "$unit_file" ] \
        || die "absent predecessor recovery unit was unexpectedly restored"
      assert_recovery_unit_state "$unit" not-found
      ;;
    *) die "predecessor recovery unit enablement snapshot is invalid" ;;
  esac
}

validate_root_chain() {
  local candidate="$1" current owner mode
  [ -e "$candidate" ] && [ ! -L "$candidate" ] \
    || die "trusted path is missing or symbolic: $candidate"
  current="$(canonical_path "$candidate")"
  [ "$current" = "$candidate" ] \
    || die "trusted path is not canonical: $candidate"
  [ "$TEST_MODE" = 1 ] && return 0
  while :; do
    owner="$(stat_value '%u' "$current")"
    mode="$(stat_value '%a' "$current")"
    [ "$owner" = 0 ] \
      || die "trusted path component is not root-owned: $current"
    [ $((8#$mode & 8#022)) -eq 0 ] \
      || die "trusted path component is group/world writable: $current"
    [ "$current" = / ] && break
    current="$(dirname -- "$current")"
  done
}

ensure_directory() {
  local directory="$1" mode="$2"
  if [ ! -e "$directory" ]; then
    install -d -m "$mode" "$directory"
    root_own "$directory"
  fi
  [ -d "$directory" ] && [ ! -L "$directory" ] \
    && [ "$(canonical_path "$directory")" = "$directory" ] \
    || die "installation directory is unsafe: $directory"
  if [ "$TEST_MODE" != 1 ]; then
    [ "$(stat_value '%u' "$directory")" = 0 ] \
      || die "installation directory is not root-owned: $directory"
  fi
}

atomic_install() {
  local source="$1" destination="$2" mode="$3" parent temporary
  assert_regular "$source" "privileged source"
  parent="$(dirname -- "$destination")"
  ensure_directory "$parent" 755
  temporary="$(mktemp "$parent/.legacy-staging-drill-install.XXXXXXXX")"
  install -m "$mode" -- "$source" "$temporary"
  root_own "$temporary"
  fsync_path "$temporary"
  move_exact "$temporary" "$destination"
  fsync_path "$parent"
}

atomic_json_receipt() {
  local output="$1" source_sha="$2" archive_sha="$3" temporary
  temporary="$(mktemp "$(dirname -- "$output")/.legacy-drill-receipt.XXXXXXXX")"
  "$NODE_BIN" - "$temporary" "$source_sha" "$archive_sha" \
    "$RECEIPT_SCHEMA" "$EXPECTED_CONTROL_VERSION" "$EXPECTED_CONTROL_SHA256" \
    "$PROFILE_MODE" "$PHASE_A_SOURCE_SHA" "$PHASE_A_ARCHIVE_SHA256" \
    "$PHASE_A_RECEIPT_SHA256" \
    "$INSTALLER_TARGET" "$INSTALL_RECOVERY_UNIT_TARGET" \
    "$BROKER_TARGET" "$ADAPTER_TARGET" "$DEPENDENCY_TARGET" \
    "$INSTALLED_ATTESTOR_TARGET" "$RECOVERY_ATTESTOR_TARGET" \
    "$PUBLIC_KEY_TARGET" "$TRANSACTION_UNIT_TARGET" "$RECOVERY_UNIT_TARGET" \
    "$PM2_DOMINGUEZ_DROP_IN_TARGET" "$PM2_ROOT_DROP_IN_TARGET" \
    "$PROMOTION_RECOVERY_DROP_IN_TARGET" \
    "$SUDOERS_TARGET" "$SQLITE_HELPER_TARGET" \
    "$FILESYSTEM_HELPER_TARGET" <<'NODE'
const crypto=require('node:crypto');const fs=require('node:fs');
const [output,sourceSha,archiveSha256,schema,controlVersion,controlSha256,
 profile,phaseASourceSha,phaseAArchiveSha256,phaseAReceiptSha256,installer,
 installRecoveryUnit,broker,adapter,
 dependencies,installedAttestor,recoveryAttestor,releasePublicKey,
 transactionUnit,recoveryUnit,pm2DominguezDropIn,pm2RootDropIn,
 promotionRecoveryDropIn,sudoers,sqliteTool,filesystemHelper]
 =process.argv.slice(2);
const digest=(file)=>crypto.createHash('sha256')
 .update(fs.readFileSync(file)).digest('hex');
const value={
 schema,
 status:'active',promotionAllowed:false,
 source:{sourceSha,archiveSha256},
 control:{version:controlVersion,sha256:controlSha256},
 installed:{
  installer:digest(installer),installRecoveryUnit:digest(installRecoveryUnit),
  broker:digest(broker),adapter:digest(adapter),dependencies:digest(dependencies),
  installedAttestor:digest(installedAttestor),
  recoveryAttestor:digest(recoveryAttestor),
  releasePublicKey:digest(releasePublicKey),
  transactionUnit:digest(transactionUnit),recoveryUnit:digest(recoveryUnit),
  pm2DominguezDropIn:digest(pm2DominguezDropIn),
  pm2RootDropIn:digest(pm2RootDropIn),
  sudoers:digest(sudoers),sqliteTool:digest(sqliteTool),
  filesystemHelper:digest(filesystemHelper),
 },
 installedAt:new Date().toISOString(),
};
if(profile==='v4-prelayout'){
 value.phaseA={
  sourceSha:phaseASourceSha,archiveSha256:phaseAArchiveSha256,
  receiptSha256:phaseAReceiptSha256,
 };
 value.installed.promotionRecoveryDropIn=digest(promotionRecoveryDropIn);
}
const fd=fs.openSync(output,'w',0o600);
try{fs.writeFileSync(fd,`${JSON.stringify(value,null,2)}\n`);fs.fsyncSync(fd);}
finally{fs.closeSync(fd);}
NODE
  chmod 600 "$temporary"
  root_own "$temporary"
  fsync_path "$temporary"
  move_exact "$temporary" "$output"
  fsync_path "$(dirname -- "$output")"
}

source_provenance() {
  SOURCE_ROOT="$1"
  SOURCE_SHA="$2"
  SOURCE_ARCHIVE="$3"
  EXPECTED_ARCHIVE_SHA256="$4"
  [[ "$SOURCE_SHA" =~ ^[a-f0-9]{40}$ ]] || die "source SHA is invalid"
  [[ "$EXPECTED_ARCHIVE_SHA256" =~ ^[a-f0-9]{64}$ ]] \
    || die "archive SHA-256 is invalid"
  EXPECTED_BOOTSTRAP_ROOT="$BOOTSTRAP_BASE/$SOURCE_SHA"
  [ "$SOURCE_ROOT" = "$EXPECTED_BOOTSTRAP_ROOT/source" ] \
    || die "source root is outside the exact SHA-bound bootstrap path"
  [ "$SOURCE_ARCHIVE" = "$EXPECTED_BOOTSTRAP_ROOT/source.tar.gz" ] \
    || die "source archive is outside the exact SHA-bound bootstrap path"
  validate_root_chain "$EXPECTED_BOOTSTRAP_ROOT"
  validate_root_chain "$SOURCE_ROOT"
  assert_regular "$SOURCE_ARCHIVE" "source archive"
  [ "$(stat_value '%s' "$SOURCE_ARCHIVE")" -le 2147483648 ] \
    || die "source archive exceeds its size bound"
  [ "$(sha256_file "$SOURCE_ARCHIVE")" = "$EXPECTED_ARCHIVE_SHA256" ] \
    || die "source archive digest does not match"

  INSTALLER_SOURCE="$SOURCE_ROOT/scripts/remote-rollback-drill-legacy-staging-install.sh"
  BROKER_SOURCE="$SOURCE_ROOT/scripts/remote-rollback-drill-legacy-staging-broker.sh"
  ADAPTER_SOURCE="$SOURCE_ROOT/scripts/rollback-drill-legacy-staging-adapter.mjs"
  DEPENDENCY_SOURCE="$SOURCE_ROOT/scripts/release-runtime-dependencies.mjs"
  INSTALLED_ATTESTOR_SOURCE="$SOURCE_ROOT/scripts/release-installed-tree-attestation.mjs"
  RECOVERY_ATTESTOR_SOURCE="$SOURCE_ROOT/scripts/release-recovery-runtime-identity.mjs"
  SQLITE_HELPER_SOURCE="$SOURCE_ROOT/scripts/application-dr-sqlite.py"
  FILESYSTEM_HELPER_SOURCE="$SOURCE_ROOT/scripts/rollback-drill-legacy-staging-fs.py"
  if [ "$PROFILE_MODE" = v4-prelayout ]; then
    INSTALL_RECOVERY_UNIT_SOURCE="$SOURCE_ROOT/scripts/systemd/nexus-rollback-drill-v4-prelayout-staging-install-recovery.service"
    TRANSACTION_UNIT_SOURCE="$SOURCE_ROOT/scripts/systemd/nexus-rollback-drill-v4-prelayout-staging@.service"
    RECOVERY_UNIT_SOURCE="$SOURCE_ROOT/scripts/systemd/nexus-rollback-drill-v4-prelayout-staging-recovery.service"
    PM2_DROP_IN_SOURCE="$SOURCE_ROOT/scripts/systemd/15-nexus-rollback-drill-v4-prelayout-staging-recovery.conf"
    PROMOTION_RECOVERY_DROP_IN_SOURCE="$SOURCE_ROOT/scripts/systemd/15-nexus-rollback-drill-v4-prelayout-promotion-recovery.conf"
  else
    INSTALL_RECOVERY_UNIT_SOURCE="$SOURCE_ROOT/scripts/systemd/nexus-rollback-drill-legacy-staging-install-recovery.service"
    TRANSACTION_UNIT_SOURCE="$SOURCE_ROOT/scripts/systemd/nexus-rollback-drill-legacy-staging@.service"
    RECOVERY_UNIT_SOURCE="$SOURCE_ROOT/scripts/systemd/nexus-rollback-drill-legacy-staging-recovery.service"
    PM2_DROP_IN_SOURCE="$SOURCE_ROOT/scripts/systemd/10-nexus-rollback-drill-legacy-staging-recovery.conf"
    PROMOTION_RECOVERY_DROP_IN_SOURCE=
  fi
  PUBLIC_KEY_SOURCE="$SOURCE_ROOT/docs/release/evidence/release-evidence-public-key.pem"
  REQUIRED_SOURCES=(
    "$INSTALLER_SOURCE"
    "$INSTALL_RECOVERY_UNIT_SOURCE"
    "$BROKER_SOURCE"
    "$ADAPTER_SOURCE"
    "$DEPENDENCY_SOURCE"
    "$INSTALLED_ATTESTOR_SOURCE"
    "$RECOVERY_ATTESTOR_SOURCE"
    "$SQLITE_HELPER_SOURCE"
    "$FILESYSTEM_HELPER_SOURCE"
    "$TRANSACTION_UNIT_SOURCE"
    "$RECOVERY_UNIT_SOURCE"
    "$PM2_DROP_IN_SOURCE"
    "$PUBLIC_KEY_SOURCE"
  )
  if [ "$PROFILE_MODE" = v4-prelayout ]; then
    REQUIRED_SOURCES+=("$PROMOTION_RECOVERY_DROP_IN_SOURCE")
  fi
  for source in "${REQUIRED_SOURCES[@]}"; do
    assert_regular "$source" "SHA-bound privileged source"
  done
  [ "$(canonical_path "$0")" = "$INSTALLER_SOURCE" ] \
    || die "installer must execute from the exact SHA-bound source"
  [ "$(sha256_file "$SQLITE_HELPER_SOURCE")" = "$EXPECTED_SQLITE_HELPER_SHA256" ] \
    || die "SHA-bound SQLite helper differs from the reviewed identity"

  python3 - "$SOURCE_ARCHIVE" "$SOURCE_ROOT" "$SOURCE_SHA" \
    "$PROFILE_MODE" <<'PY'
import hashlib
import pathlib
import sys
import tarfile

archive_path, source_root_raw, source_sha, profile = sys.argv[1:]
source_root = pathlib.Path(source_root_raw)
required = [
    "scripts/remote-rollback-drill-legacy-staging-install.sh",
    "scripts/remote-rollback-drill-legacy-staging-broker.sh",
    "scripts/rollback-drill-legacy-staging-adapter.mjs",
    "scripts/release-runtime-dependencies.mjs",
    "scripts/release-installed-tree-attestation.mjs",
    "scripts/release-recovery-runtime-identity.mjs",
    "scripts/application-dr-sqlite.py",
    "scripts/rollback-drill-legacy-staging-fs.py",
    "docs/release/evidence/release-evidence-public-key.pem",
]
if profile == "v4-prelayout":
    required.extend((
        "scripts/systemd/nexus-rollback-drill-v4-prelayout-staging-install-recovery.service",
        "scripts/systemd/nexus-rollback-drill-v4-prelayout-staging@.service",
        "scripts/systemd/nexus-rollback-drill-v4-prelayout-staging-recovery.service",
        "scripts/systemd/15-nexus-rollback-drill-v4-prelayout-staging-recovery.conf",
        "scripts/systemd/15-nexus-rollback-drill-v4-prelayout-promotion-recovery.conf",
    ))
else:
    required.extend((
        "scripts/systemd/nexus-rollback-drill-legacy-staging-install-recovery.service",
        "scripts/systemd/nexus-rollback-drill-legacy-staging@.service",
        "scripts/systemd/nexus-rollback-drill-legacy-staging-recovery.service",
        "scripts/systemd/10-nexus-rollback-drill-legacy-staging-recovery.conf",
    ))
with tarfile.open(archive_path, "r:gz") as archive:
    if archive.pax_headers.get("comment") != source_sha:
        raise SystemExit("bootstrap archive Git PAX commit does not match")
    members = archive.getmembers()
    if len(members) > 200000:
        raise SystemExit("bootstrap archive has too many members")
    for relative in required:
        name = f"source/{relative}"
        matches = [member for member in members if member.name == name]
        if len(matches) != 1:
            raise SystemExit(f"missing or duplicated source archive member: {name}")
        member = matches[0]
        pure = pathlib.PurePosixPath(name)
        if (not member.isfile() or member.issym() or member.islnk()
                or pure.as_posix() != name or ".." in pure.parts
                or member.size > 128 * 1024 * 1024):
            raise SystemExit(f"unsafe source archive member: {name}")
        archived = archive.extractfile(member)
        if archived is None:
            raise SystemExit(f"unreadable source archive member: {name}")
        archive_bytes = archived.read()
        source_bytes = (source_root / relative).read_bytes()
        if (len(archive_bytes) != len(source_bytes)
                or hashlib.sha256(archive_bytes).digest()
                != hashlib.sha256(source_bytes).digest()):
            raise SystemExit(f"source drift for {relative}")
PY
}

validate_install_journal() {
  local expected_source_sha="${1:--}" expected_archive_sha="${2:--}"
  local parsed
  assert_regular "$JOURNAL" "install recovery journal"
  [ "$(stat_value '%a' "$JOURNAL")" = 600 ] \
    || die "install recovery journal mode is unsafe"
  [ "$(stat_value '%s' "$JOURNAL")" -gt 0 ] \
    && [ "$(stat_value '%s' "$JOURNAL")" -le 1048576 ] \
    || die "install recovery journal size is unsafe"
  parsed="$(
    python3 - "$JOURNAL" "$TEST_MODE" \
      "$expected_source_sha" "$expected_archive_sha" <<'PY'
import datetime
import json
import os
import stat
import sys

journal_path, test_mode, expected_source_sha, expected_archive_sha = sys.argv[1:]

def unique_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError(f"duplicate JSON key: {key}")
        value[key] = item
    return value

before = os.lstat(journal_path)
if (
    not stat.S_ISREG(before.st_mode)
    or stat.S_ISLNK(before.st_mode)
    or before.st_nlink != 1
    or stat.S_IMODE(before.st_mode) != 0o600
    or before.st_size < 1
    or before.st_size > 1024 * 1024
    or (test_mode != "1" and (before.st_uid != 0 or before.st_gid != 0))
):
    raise SystemExit("install recovery journal identity is unsafe")
descriptor = os.open(journal_path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
try:
    opened = os.fstat(descriptor)
    if (
        opened.st_dev != before.st_dev
        or opened.st_ino != before.st_ino
        or opened.st_size != before.st_size
        or opened.st_mtime_ns != before.st_mtime_ns
    ):
        raise SystemExit("install recovery journal changed while opening")
    body = os.read(descriptor, 1024 * 1024 + 1)
    after = os.fstat(descriptor)
    if (
        after.st_dev != opened.st_dev
        or after.st_ino != opened.st_ino
        or after.st_size != len(body)
        or after.st_mtime_ns != opened.st_mtime_ns
    ):
        raise SystemExit("install recovery journal changed while reading")
finally:
    os.close(descriptor)
try:
    value = json.loads(body, object_pairs_hook=unique_object)
except (UnicodeDecodeError, ValueError, json.JSONDecodeError) as error:
    raise SystemExit("install recovery journal JSON is invalid") from error
if (
    not isinstance(value, dict)
    or set(value)
    != {
        "schema",
        "phase",
        "promotionAllowed",
        "source",
        "predecessorInventory",
        "preparedAt",
    }
    or value.get("schema")
    != "nexus.rollback-drill-legacy-staging-install-journal.v1"
    or value.get("phase") != "prepared"
    or value.get("promotionAllowed") is not False
    or not isinstance(value.get("source"), dict)
    or set(value["source"]) != {"sourceSha", "archiveSha256"}
    or not isinstance(value["source"].get("sourceSha"), str)
    or len(value["source"]["sourceSha"]) != 40
    or set(value["source"]["sourceSha"]) - set("0123456789abcdef")
    or not isinstance(value["source"].get("archiveSha256"), str)
    or len(value["source"]["archiveSha256"]) != 64
    or set(value["source"]["archiveSha256"]) - set("0123456789abcdef")
    or not isinstance(value.get("predecessorInventory"), dict)
    or not isinstance(value.get("preparedAt"), str)
):
    raise SystemExit("install recovery journal contract is invalid")
try:
    datetime.datetime.fromisoformat(value["preparedAt"].replace("Z", "+00:00"))
except ValueError as error:
    raise SystemExit("install recovery journal timestamp is invalid") from error
source_sha = value["source"]["sourceSha"]
archive_sha = value["source"]["archiveSha256"]
if expected_source_sha != "-" and source_sha != expected_source_sha:
    raise SystemExit("install recovery journal source SHA differs")
if expected_archive_sha != "-" and archive_sha != expected_archive_sha:
    raise SystemExit("install recovery journal archive digest differs")
sys.stdout.write(f"{source_sha}\t{archive_sha}")
PY
  )" || die "install recovery journal validation failed"
  IFS=$'\t' read -r INSTALL_JOURNAL_SOURCE_SHA \
    INSTALL_JOURNAL_ARCHIVE_SHA256 <<<"$parsed"
  [[ "$INSTALL_JOURNAL_SOURCE_SHA" =~ ^[a-f0-9]{40}$ ]] \
    && [[ "$INSTALL_JOURNAL_ARCHIVE_SHA256" =~ ^[a-f0-9]{64}$ ]] \
    || die "install recovery journal output is invalid"
  assert_bound_backup_inventory \
    "$JOURNAL" predecessorInventory install
}

recover_install_journal() {
  local bootstrap_root source_root source_archive exact_installer
  if [ "$TEST_MODE" != 1 ]; then
    [ "$(canonical_path "$0")" = "$INSTALLER_TARGET" ] \
      || die "journal recovery must run from the fixed root-owned installer"
    assert_regular "$INSTALLER_TARGET" "fixed recovery installer"
    [ "$(stat_value '%a' "$INSTALLER_TARGET")" = 700 ] \
      || die "fixed recovery installer mode is unsafe"
  fi
  if [ ! -e "$JOURNAL" ] && [ ! -L "$JOURNAL" ]; then
    printf '%s\n' \
      '{"ok":true,"installed":false,"promotable":false,"status":"idle"}'
    return 0
  fi
  validate_install_journal
  bootstrap_root="$BOOTSTRAP_BASE/$INSTALL_JOURNAL_SOURCE_SHA"
  source_root="$bootstrap_root/source"
  source_archive="$bootstrap_root/source.tar.gz"
  exact_installer="$source_root/scripts/remote-rollback-drill-legacy-staging-install.sh"
  validate_root_chain "$bootstrap_root"
  validate_root_chain "$source_root"
  assert_regular "$source_archive" "journal-bound source archive"
  assert_regular "$exact_installer" "journal-bound exact installer"
  if [ "$TEST_MODE" != 1 ]; then
    [ $((8#$(stat_value '%a' "$source_archive") & 8#022)) -eq 0 ] \
      && [ $((8#$(stat_value '%a' "$exact_installer") & 8#022)) -eq 0 ] \
      || die "journal-bound recovery source is writable"
  fi
  [ "$(stat_value '%s' "$source_archive")" -le 2147483648 ] \
    && [ "$(sha256_file "$source_archive")" \
      = "$INSTALL_JOURNAL_ARCHIVE_SHA256" ] \
    || die "journal-bound source archive digest differs"
  python3 - "$source_archive" "$exact_installer" \
    "$INSTALL_JOURNAL_SOURCE_SHA" <<'PY'
import hashlib
import pathlib
import sys
import tarfile

archive_path, installer_path, source_sha = sys.argv[1:]
member_name = "source/scripts/remote-rollback-drill-legacy-staging-install.sh"
with tarfile.open(archive_path, "r:gz") as archive:
    if archive.pax_headers.get("comment") != source_sha:
        raise SystemExit("journal-bound archive Git PAX commit differs")
    members = archive.getmembers()
    if len(members) > 200000:
        raise SystemExit("journal-bound archive has too many members")
    matches = [member for member in members if member.name == member_name]
    if len(matches) != 1:
        raise SystemExit("journal-bound installer archive member is not unique")
    member = matches[0]
    if (
        not member.isfile()
        or member.issym()
        or member.islnk()
        or member.size > 128 * 1024 * 1024
    ):
        raise SystemExit("journal-bound installer archive member is unsafe")
    archived = archive.extractfile(member)
    if archived is None:
        raise SystemExit("journal-bound installer archive member is unreadable")
    archived_body = archived.read()
source_body = pathlib.Path(installer_path).read_bytes()
if (
    len(archived_body) != len(source_body)
    or hashlib.sha256(archived_body).digest()
    != hashlib.sha256(source_body).digest()
):
    raise SystemExit("journal-bound exact installer differs from its archive")
PY
  if [ "$PROFILE_MODE" = v4-prelayout ]; then
    exec /bin/bash "$exact_installer" recover-v4-prelayout \
      "$source_root" "$INSTALL_JOURNAL_SOURCE_SHA" \
      "$source_archive" "$INSTALL_JOURNAL_ARCHIVE_SHA256"
  fi
  exec /bin/bash "$exact_installer" recover \
    "$source_root" "$INSTALL_JOURNAL_SOURCE_SHA" \
    "$source_archive" "$INSTALL_JOURNAL_ARCHIVE_SHA256"
}

activate_from_phase_a() {
  local resolved_marker_sha256="$1"
  local bootstrap_root source_root source_archive source_installer archive
  local invoked_installer
  [ "$PROFILE_MODE" = v4-prelayout ] \
    || die "Phase A activation is available only to the v4 pre-layout profile"
  verify_control
  bootstrap_root="$BOOTSTRAP_BASE/$PHASE_A_SOURCE_SHA"
  source_root="$bootstrap_root/source"
  source_archive="$bootstrap_root/source.tar.gz"
  source_installer="$source_root/scripts/remote-rollback-drill-legacy-staging-install.sh"
  invoked_installer="$(canonical_path "$0")"
  if [ "$invoked_installer" = "$INSTALLER_TARGET" ]; then
    if [ "$TEST_MODE" != 1 ]; then
      [ "$(stat_value '%U:%G:%a:%h' "$INSTALLER_TARGET")" = root:root:700:1 ] \
        || die "fixed Phase A activation installer identity is unsafe"
    fi
  elif [ "$invoked_installer" = "$source_installer" ]; then
    validate_root_chain "$bootstrap_root"
    validate_root_chain "$source_root"
    assert_regular "$source_installer" "Phase A-bound exact installer"
    [ "$(stat_value '%a:%h' "$source_installer")" = 755:1 ] \
      || die "Phase A-bound exact installer mode is unsafe"
    if [ "$TEST_MODE" != 1 ]; then
      [ "$(stat_value '%U:%G' "$source_installer")" = root:root ] \
        || die "Phase A-bound exact installer owner is unsafe"
    fi
  else
    die "Phase A activation must run from the exact Phase A source installer or fixed root anchor"
  fi
  assert_v4_prelayout_idle
  if [ "$resolved_marker_sha256" != none ]; then
    [[ "$resolved_marker_sha256" =~ ^[a-f0-9]{64}$ ]] \
      || die "resolved pre-layout marker SHA-256 is invalid"
    archive="$PROMOTION_STATE_ROOT/boot-recovery-incidents/${resolved_marker_sha256}.prelayout-resolution.json"
    "$NODE_BIN" - "$archive" "$resolved_marker_sha256" \
      "$PHASE_A_RECEIPT_SHA256" "$TEST_MODE" <<'NODE' \
      || die "governed pre-layout recovery resolution is unavailable or invalid"
const crypto=require('node:crypto');const fs=require('node:fs');
const [file,digest,phaseAReceiptSha256,testMode]=process.argv.slice(2);
const descriptor=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));
try{
 const before=fs.fstatSync(descriptor),body=fs.readFileSync(descriptor);
 const after=fs.fstatSync(descriptor),value=JSON.parse(body);
 const rootUid=testMode==='1'?process.getuid():0;
 const rootGid=testMode==='1'?process.getgid():0;
 if(!before.isFile()||before.nlink!==1||before.uid!==rootUid
  ||before.gid!==rootGid||(before.mode&0o7777)!==0o600
  ||before.size<=0||before.size>2*1024*1024
  ||before.dev!==after.dev||before.ino!==after.ino
  ||before.size!==after.size||before.mtimeMs!==after.mtimeMs
  ||value.schema!=='nexus.release-prelayout-boot-recovery-resolution.v1'
  ||value.status!=='reconciled_no_mutation'||value.markerSha256!==digest
  ||value.liveHealthProof?.schema!=='nexus.release-live-prelayout-health-proof.v1'
  ||value.liveHealthProof?.status!=='verified_no_mutation'
  ||value.liveHealthProof?.phaseA?.receiptSha256!==phaseAReceiptSha256
  ||!Array.isArray(value.liveHealthProof?.mutationOperations)
  ||value.liveHealthProof.mutationOperations.length!==0
  ||!Number.isFinite(Date.parse(value.resolvedAt??'')))process.exit(1);
}finally{fs.closeSync(descriptor);}
NODE
  fi
  validate_root_chain "$bootstrap_root"
  validate_root_chain "$source_root"
  assert_regular "$source_archive" "Phase A-bound source archive"
  assert_regular "$source_installer" "Phase A-bound exact installer"
  [ "$(sha256_file "$source_archive")" = "$PHASE_A_ARCHIVE_SHA256" ] \
    || die "Phase A-bound source archive digest differs"
  exec /bin/bash "$source_installer" install-v4-prelayout \
    "$source_root" "$PHASE_A_SOURCE_SHA" "$source_archive" \
    "$PHASE_A_ARCHIVE_SHA256"
}

phase_a_identity() {
  [ "$PROFILE_MODE" = v4-prelayout ] || return 0
  "$NODE_BIN" - "$PHASE_A_RECEIPT" "$CONTROL_BIN" "$LAYOUT_CONTROL_BIN" \
    "$TEST_MODE" \
    "$LEGACY_V2_ACTIVE_RECEIPT" "$LEGACY_V2_RETIRED_RECEIPT" <<'NODE'
const crypto=require('node:crypto');const fs=require('node:fs');
const [receiptFile,controlFile,layoutControlFile,testMode,activeV2,retiredV2]
 =process.argv.slice(2);
const rootUid=testMode==='1'?process.getuid():0;
const rootGid=testMode==='1'?process.getgid():0;
const digest=(body)=>crypto.createHash('sha256').update(body).digest('hex');
const read=(file,label,maximum,mode)=>{
 const descriptor=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));
 try{
  const before=fs.fstatSync(descriptor),body=fs.readFileSync(descriptor);
  const after=fs.fstatSync(descriptor);
  if(!before.isFile()||before.nlink!==1||before.uid!==rootUid
   ||before.gid!==rootGid||(before.mode&0o7777)!==mode
   ||before.size<=0||before.size>maximum||before.dev!==after.dev
   ||before.ino!==after.ino||before.size!==after.size
   ||before.mtimeMs!==after.mtimeMs)throw new Error(`${label} identity is unsafe`);
  return {body,value:label==='Phase A receipt'?JSON.parse(body):null};
 }finally{fs.closeSync(descriptor);}
};
const receipt=read(receiptFile,'Phase A receipt',2*1024*1024,0o600);
const control=read(controlFile,'promotion control',16*1024*1024,0o755);
const layoutControl=read(
 layoutControlFile,'layout activation control',16*1024*1024,0o755,
);
const value=receipt.value;
if(value.schema!=='nexus.release-layout-phase-a-receipt.v1'
 ||value.status!=='completed'||value.phaseARecoveryGuard!==true
 ||typeof value.legacyV2AdapterRetired!=='boolean'
 ||!/^[a-f0-9]{40}$/u.test(value.sourceSha??'')
 ||!/^[a-f0-9]{64}$/u.test(value.sourceArchiveSha256??'')
 ||!Array.isArray(value.installedAssets)
 ||value.installedAssets.some((item)=>!item||typeof item!=='object'
   ||Object.keys(item).sort().join(',')!=='path,sha256'
   ||typeof item.path!=='string'||!/^[a-f0-9]{64}$/u.test(item.sha256??''))){
 throw new Error('Phase A receipt contract is invalid');
}
if(fs.existsSync(activeV2)){
 throw new Error('active v2 staging authority survived Phase A');
}
if(value.legacyV2AdapterRetired){
 const retired=fs.readFileSync(retiredV2);
 if(!/^[a-f0-9]{64}$/u.test(value.legacyRetirementSha256??'')
  ||digest(retired)!==value.legacyRetirementSha256){
  throw new Error('retired v2 staging authority is not bound by Phase A');
 }
}else if(value.legacyRetirementSha256!==null||fs.existsSync(retiredV2)){
 throw new Error('fresh Phase A has unexpected v2 retirement state');
}
const matches=value.installedAssets.filter((item)=>item.path===controlFile);
const layoutMatches=value.installedAssets.filter(
 (item)=>item.path===layoutControlFile,
);
const controlSha256=digest(control.body);
if(matches.length!==1||matches[0].sha256!==controlSha256
 ||layoutMatches.length!==1
 ||layoutMatches[0].sha256!==digest(layoutControl.body)){
 throw new Error('Phase A receipt does not bind the live control closure');
}
process.stdout.write([
 value.sourceSha,value.sourceArchiveSha256,digest(receipt.body),controlSha256,
].join('\t'));
NODE
}

verify_control() {
  local observed_version phase_a_fields
  observed_version="$("$CONTROL_BIN" version)"
  [ "$observed_version" = "$EXPECTED_CONTROL_VERSION" ] || {
    echo "exact installed $EXPECTED_CONTROL_VERSION is required" >&2
    exit 75
  }
  if [ "$PROFILE_MODE" = control-v2 ]; then
    [ "$(sha256_file "$CONTROL_BIN")" = "$EXPECTED_CONTROL_SHA256" ] || {
      echo "exact installed promotion control v2 is required" >&2
      exit 75
    }
    return
  fi
  phase_a_fields="$(phase_a_identity)" || {
    echo "completed Phase A receipt does not bind the live v4 control" >&2
    exit 75
  }
  IFS=$'\t' read -r PHASE_A_SOURCE_SHA PHASE_A_ARCHIVE_SHA256 \
    PHASE_A_RECEIPT_SHA256 PHASE_A_CONTROL_SHA256 <<<"$phase_a_fields"
  EXPECTED_CONTROL_SHA256="$PHASE_A_CONTROL_SHA256"
}

verify_sqlite_helper() {
  assert_regular "$SQLITE_HELPER_TARGET" "installed SQLite recovery helper"
  [ "$(stat_value '%a' "$SQLITE_HELPER_TARGET")" = 644 ] \
    && [ "$(sha256_file "$SQLITE_HELPER_TARGET")" \
      = "$EXPECTED_SQLITE_HELPER_SHA256" ] \
    || die "installed SQLite recovery helper identity mismatch"
}

verify_install_recovery_anchor() {
  local enabled_state properties
  assert_regular "$INSTALLER_TARGET" "fixed recovery installer"
  assert_regular "$INSTALL_RECOVERY_UNIT_TARGET" "install recovery unit"
  [ "$(stat_value '%a' "$INSTALLER_TARGET")" = 700 ] \
    && [ "$(stat_value '%a' "$INSTALL_RECOVERY_UNIT_TARGET")" = 644 ] \
    && [ "$(sha256_file "$INSTALLER_TARGET")" \
      = "$(sha256_file "$INSTALLER_SOURCE")" ] \
    && [ "$(sha256_file "$INSTALL_RECOVERY_UNIT_TARGET")" \
      = "$(sha256_file "$INSTALL_RECOVERY_UNIT_SOURCE")" ] \
    || die "install recovery anchor identity differs"
  [ "$TEST_MODE" = 1 ] && return 0
  enabled_state="$(
    "$SYSTEMCTL_BIN" is-enabled \
      "$INSTALL_RECOVERY_UNIT_NAME" \
      2>/dev/null || true
  )"
  [ "$enabled_state" = enabled ] \
    || die "install recovery anchor is not durably enabled"
  properties="$(
    "$SYSTEMCTL_BIN" show --no-pager \
      "$INSTALL_RECOVERY_UNIT_NAME" \
      -p User -p Group -p ExecStart -p Before
  )"
  "$NODE_BIN" - "$properties" "$INSTALLER_TARGET" "$RECOVERY_UNIT_NAME" <<'NODE'
const [body,installer,recoveryUnit]=process.argv.slice(2);const properties={};
for(const line of body.split(/\n/u)){
 if(!line)continue;
 const separator=line.indexOf('=');
 if(separator<1||Object.hasOwn(properties,line.slice(0,separator)))process.exit(1);
 properties[line.slice(0,separator)]=line.slice(separator+1);
}
const before=new Set((properties.Before??'').split(/\s+/u).filter(Boolean));
if(properties.User!=='root'||properties.Group!=='root'
 ||!properties.ExecStart?.includes(
  `${installer} recover-journal`,
 )
 ||![
  recoveryUnit,
  'nexus-release-layout-install-recovery.service',
  'pm2-dominguez.service',
  'pm2-root.service',
 ].every((unit)=>before.has(unit)))process.exit(1);
NODE
}

test_power_loss() {
  local checkpoint="$1"
  if [ "$TEST_MODE" = 1 ] \
      && [ "${NEXUS_LEGACY_DRILL_TEST_POWER_LOSS_AFTER:-}" = "$checkpoint" ]; then
    trap - EXIT INT TERM HUP
    exit 197
  fi
}

test_retirement_power_loss() {
  local checkpoint="$1"
  if [ "$TEST_MODE" = 1 ] \
      && [ "${NEXUS_LEGACY_DRILL_TEST_RETIRE_POWER_LOSS_AFTER:-}" \
        = "$checkpoint" ]; then
    trap - EXIT INT TERM HUP
    exit 198
  fi
}

test_install_failure() {
  local checkpoint="$1"
  if [ "$TEST_MODE" = 1 ] \
      && [ "${NEXUS_LEGACY_DRILL_TEST_INSTALL_FAIL_AFTER:-}" = "$checkpoint" ]; then
    echo "injected transactional install failure: $checkpoint" >&2
    return 91
  fi
}

test_recovery_failure() {
  local checkpoint="$1"
  if [ "$TEST_MODE" = 1 ] \
      && [ "${NEXUS_LEGACY_DRILL_TEST_RECOVERY_FAIL_AT:-}" = "$checkpoint" ]; then
    echo "injected installer recovery failure: $checkpoint" >&2
    return 92
  fi
}

ensure_state() {
  ensure_directory "$STATE_ROOT" 700
  ensure_directory "$INSTALL_STATE" 700
}

assert_v4_prelayout_idle() {
  [ "$PROFILE_MODE" = v4-prelayout ] || return 0
  local marker
  for marker in \
    "$PROMOTION_STATE_ROOT/layout-activation/active.v1.json" \
    "$PROMOTION_STATE_ROOT/layout-activation/phase-a-install-in-progress.v1.json" \
    "$PROMOTION_STATE_ROOT/layout-activation/phase-a-recovery-failed.v1.json" \
    "$PROMOTION_STATE_ROOT/layout-activation/phase-b-handover-in-progress.v1.json" \
    "$PROMOTION_STATE_ROOT/layout-migration-in-progress.v1.json" \
    "$PROMOTION_STATE_ROOT/layout-migration.v1.json" \
    "$PROMOTION_STATE_ROOT/boot-recovery-in-progress.v1.json" \
    "$PROMOTION_STATE_ROOT/active.json"; do
    [ ! -e "$marker" ] && [ ! -L "$marker" ] \
      || die "v4 pre-layout staging admission marker is active: $marker"
  done
  phase_a_identity >/dev/null \
    || die "v4 pre-layout staging Phase A identity changed"
}

verify_phase_b_permanent_guard() {
  "$NODE_BIN" - "$PHASE_B_RECEIPT" "$PHASE_A_RECEIPT" \
    "$PERMANENT_PM2_DROP_IN" "$TEST_MODE" "$PHASE_A_SOURCE_SHA" \
    "$PHASE_A_ARCHIVE_SHA256" "$PHASE_A_RECEIPT_SHA256" <<'NODE' \
    || die "completed Phase B permanent PM2 guard is invalid"
const crypto=require('node:crypto');const fs=require('node:fs');
const [receiptFile,phaseAFile,pm2DropIn,testMode,sourceSha,archiveSha,
 phaseAReceiptSha256]=process.argv.slice(2);
const hash=(body)=>crypto.createHash('sha256').update(body).digest('hex');
const secure=(file,mode,maximum)=>{
 const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));
 try{
  const before=fs.fstatSync(fd),body=fs.readFileSync(fd),after=fs.fstatSync(fd);
  const rootUid=testMode==='1'?process.getuid():0;
  const rootGid=testMode==='1'?process.getgid():0;
  if(!before.isFile()||before.nlink!==1||before.uid!==rootUid
   ||before.gid!==rootGid||(before.mode&0o7777)!==mode
   ||before.size<=0||before.size>maximum||before.dev!==after.dev
   ||before.ino!==after.ino||before.size!==after.size
   ||before.mtimeMs!==after.mtimeMs)process.exit(1);
  return body;
 }finally{fs.closeSync(fd);}
};
const receiptBody=secure(receiptFile,0o600,2*1024*1024);
const phaseABody=secure(phaseAFile,0o600,2*1024*1024);
const dropInBody=secure(pm2DropIn,0o644,1024*1024);
const receipt=JSON.parse(receiptBody);
const keys=[
 'schema','status','sourceSha','sourceArchiveSha256',
 'layoutAttestationSha256','phaseAReceiptSha256','completedAt',
 'runningServiceIdentity','handoverTargets','serviceRestarted',
 'ingressRestarted','rebootRequired',
];
const targets=receipt.handoverTargets?.filter(
 (item)=>item?.path===pm2DropIn,
);
const text=dropInBody.toString('utf8');
if(Object.keys(receipt).sort().join(',')!==keys.sort().join(',')
 ||receipt.schema!=='nexus.release-layout-phase-b-receipt.v1'
 ||receipt.status!=='completed'||receipt.sourceSha!==sourceSha
 ||receipt.sourceArchiveSha256!==archiveSha
 ||receipt.phaseAReceiptSha256!==phaseAReceiptSha256
 ||hash(phaseABody)!==phaseAReceiptSha256
 ||!/^[a-f0-9]{64}$/u.test(receipt.layoutAttestationSha256??'')
 ||!Number.isFinite(Date.parse(receipt.completedAt??''))
 ||receipt.rebootRequired!==true||receipt.serviceRestarted!==false
 ||receipt.ingressRestarted!==false||targets?.length!==1
 ||targets[0].sha256!==hash(dropInBody)
 ||!text.includes(
  'Requires=nexus-release-layout-recovery.service nexus-release-promotion-recovery.service',
 )
 ||!text.includes(
  'After=nexus-release-layout-recovery.service nexus-release-promotion-recovery.service',
 )
 ||!text.includes(
  'ExecCondition=+/usr/local/sbin/nexus-release-layout-activation-control assert-boot-safe',
 )
 ||!text.includes(
  'ExecStartPost=+/usr/local/sbin/nexus-release-promotion-control boot-postcheck',
 ))process.exit(1);
NODE
  [ ! -e "$PHASE_B_JOURNAL" ] && [ ! -L "$PHASE_B_JOURNAL" ] \
    || die "Phase B handover journal must be durably finalized before v4 retirement"
}

assert_v4_retirement_state() {
  [ "$PROFILE_MODE" = v4-prelayout ] || return 0
  local inherited_control_fd="${1:-}" marker
  for marker in \
    "$PROMOTION_STATE_ROOT/layout-activation/active.v1.json" \
    "$PROMOTION_STATE_ROOT/layout-activation/phase-a-install-in-progress.v1.json" \
    "$PROMOTION_STATE_ROOT/layout-activation/phase-a-recovery-failed.v1.json" \
    "$PROMOTION_STATE_ROOT/layout-migration-in-progress.v1.json" \
    "$PROMOTION_STATE_ROOT/active.json"; do
    [ ! -e "$marker" ] && [ ! -L "$marker" ] \
      || die "v4 pre-layout retirement marker is active: $marker"
  done
  marker="$PROMOTION_STATE_ROOT/boot-recovery-in-progress.v1.json"
  if [ -e "$marker" ] || [ -L "$marker" ]; then
    "$NODE_BIN" - "$marker" "$TEST_MODE" "$PROC_ROOT" \
      "${NEXUS_LEGACY_DRILL_TEST_BOOT_ID:-test-boot}" <<'NODE' \
      || die "promotion boot-recovery marker is unsafe for v4 retirement"
const fs=require('node:fs');
const [file,testMode,procRoot,testBootId]=process.argv.slice(2);
const descriptor=fs.openSync(
  file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0),
);
try{
 const before=fs.fstatSync(descriptor),body=fs.readFileSync(descriptor);
 const after=fs.fstatSync(descriptor),value=JSON.parse(body);
 const rootUid=testMode==='1'?process.getuid():0;
 const rootGid=testMode==='1'?process.getgid():0;
 const currentBootId=testMode==='1'?testBootId
  :fs.readFileSync(`${procRoot}/sys/kernel/random/boot_id`,'utf8').trim();
 const exactKeys=[
  'schema','status','bootId','bootDetectedAt','bootDetectedEpoch',
  'outageStartedAt','outageStartedEpoch','outageStartedMonotonic',
  'outageBootId','recoveryDeadlineEpoch','timingSource','activeTransactionId',
 ];
 if(!before.isFile()||before.nlink!==1||before.uid!==rootUid
  ||before.gid!==rootGid||(before.mode&0o7777)!==0o600
  ||before.size<=0||before.size>1024*1024
  ||before.dev!==after.dev||before.ino!==after.ino
  ||before.size!==after.size||before.mtimeMs!==after.mtimeMs
  ||Object.keys(value).sort().join(',')!==exactKeys.sort().join(',')
  ||value.schema!=='nexus.release-boot-recovery.v1'
  ||value.status!=='in_progress'
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
}finally{fs.closeSync(descriptor);}
NODE
  else
    if [ -z "$inherited_control_fd" ]; then
      "$CONTROL_BIN" assert-idle >/dev/null
    fi
  fi
  verify_phase_b_permanent_guard
  if [ -z "$inherited_control_fd" ]; then
    "$LAYOUT_CONTROL_BIN" assert-boot-safe >/dev/null \
      || die "release-layout boot authority is unsafe for v4 retirement"
  fi
  phase_a_identity >/dev/null \
    || die "v4 pre-layout staging Phase A identity changed"
}

acquire_retirement_locks() {
  local worker_gid
  local activation_lock="$PROMOTION_STATE_ROOT/layout-activation/.activation.lock"
  local inherited_activation_fd="${NEXUS_V4_RETIRE_INHERITED_ACTIVATION_LOCK_FD:-}"
  local inherited_control_fd="${NEXUS_V4_RETIRE_INHERITED_CONTROL_LOCK_FD:-}"
  local inherited_sonar_fd="${NEXUS_V4_RETIRE_INHERITED_SONAR_LOCK_FD:-}"
  verify_control
  if [ "$TEST_MODE" != 1 ]; then
    [ "$PROC_ROOT" = /proc ] \
      || die "production retirement requires the canonical proc filesystem"
  fi
  if { [ -n "$inherited_activation_fd" ] \
        || [ -n "$inherited_control_fd" ] \
        || [ -n "$inherited_sonar_fd" ]; } \
      && { [ -z "$inherited_activation_fd" ] \
        || [ -z "$inherited_control_fd" ] \
        || [ -z "$inherited_sonar_fd" ]; }; then
    die "all inherited retirement lock descriptors are required"
  fi
  if [ -n "$inherited_control_fd" ]; then
    case "$inherited_activation_fd:$inherited_control_fd:$inherited_sonar_fd" in
      *[!0-9:]*|0:*|1:*|2:*|*:0:*|*:1:*|*:2:*|*:0|*:1|*:2)
        die "inherited retirement lock descriptor is invalid"
        ;;
    esac
    [ -f "$activation_lock" ] && [ ! -L "$activation_lock" ] \
      && [ -e "/dev/fd/$inherited_activation_fd" ] \
      && [ "$activation_lock" -ef "/dev/fd/$inherited_activation_fd" ] \
      || die "inherited layout activation lock identity is invalid"
    [ -f "$CONTROL_LOCK" ] && [ ! -L "$CONTROL_LOCK" ] \
      && [ -e "/dev/fd/$inherited_control_fd" ] \
      && [ "$CONTROL_LOCK" -ef "/dev/fd/$inherited_control_fd" ] \
      || die "inherited promotion control lock identity is invalid"
    [ -f "$SONAR_LOCK" ] && [ ! -L "$SONAR_LOCK" ] \
      && [ -e "/dev/fd/$inherited_sonar_fd" ] \
      && [ "$SONAR_LOCK" -ef "/dev/fd/$inherited_sonar_fd" ] \
      || die "inherited release/Sonar lock identity is invalid"
    "$FLOCK_BIN" -n -x "$inherited_activation_fd" \
      && "$FLOCK_BIN" -n -x "$inherited_control_fd" \
      && "$FLOCK_BIN" -n -x "$inherited_sonar_fd" \
      || die "inherited retirement locks are not held exclusively"
    assert_v4_retirement_state "$inherited_control_fd"
    return
  fi
  assert_regular "$activation_lock" "release-layout activation lock"
  exec 7<>"$activation_lock"
  "$FLOCK_BIN" -x 7
  assert_v4_retirement_state
  assert_regular "$CONTROL_LOCK" "promotion control lock"
  if [ ! -e "$SONAR_LOCK" ]; then
    worker_gid="$(id -g "$WORKER_USER")"
    install -m 660 /dev/null "$SONAR_LOCK"
    if [ "$TEST_MODE" != 1 ]; then chown root:"$worker_gid" "$SONAR_LOCK"; fi
  fi
  assert_regular "$SONAR_LOCK" "release/Sonar lock"
  exec 9<>"$CONTROL_LOCK"
  "$FLOCK_BIN" -x 9
  exec 8<>"$SONAR_LOCK"
  "$FLOCK_BIN" -x 8
  [ ! -e "$PROMOTION_STATE_ROOT/active.json" ] \
    && [ ! -L "$PROMOTION_STATE_ROOT/active.json" ] \
    || die "ordinary promotion became active"
  assert_v4_retirement_state 9
}

acquire_locks() {
  local worker_gid
  verify_control
  if [ "$PROFILE_MODE" = v4-prelayout ]; then
    assert_regular \
      "$PROMOTION_STATE_ROOT/layout-activation/.activation.lock" \
      "release-layout activation lock"
    exec 7<>"$PROMOTION_STATE_ROOT/layout-activation/.activation.lock"
    "$FLOCK_BIN" -s 7
  fi
  assert_v4_prelayout_idle
  "$CONTROL_BIN" assert-idle >/dev/null
  assert_regular "$CONTROL_LOCK" "promotion control lock"
  if [ ! -e "$SONAR_LOCK" ]; then
    worker_gid="$(id -g "$WORKER_USER")"
    install -m 660 /dev/null "$SONAR_LOCK"
    if [ "$TEST_MODE" != 1 ]; then chown root:"$worker_gid" "$SONAR_LOCK"; fi
  fi
  assert_regular "$SONAR_LOCK" "release/Sonar lock"
  exec 9<>"$CONTROL_LOCK"
  "$FLOCK_BIN" -x 9
  exec 8<>"$SONAR_LOCK"
  "$FLOCK_BIN" -x 8
  [ ! -e "$PROMOTION_STATE_ROOT/active.json" ] \
    && [ ! -L "$PROMOTION_STATE_ROOT/active.json" ] \
    || die "ordinary promotion became active"
  assert_v4_prelayout_idle
  NEXUS_PROMOTION_INHERITED_CONTROL_LOCK_FD=9 \
    "$CONTROL_BIN" assert-idle >/dev/null
}

acquire_successor_locks() {
  local worker_gid
  verify_successor
  assert_regular "$CONTROL_LOCK" "promotion control lock"
  if [ ! -e "$SONAR_LOCK" ]; then
    worker_gid="$(id -g "$WORKER_USER")"
    install -m 660 /dev/null "$SONAR_LOCK"
    if [ "$TEST_MODE" != 1 ]; then chown root:"$worker_gid" "$SONAR_LOCK"; fi
  fi
  assert_regular "$SONAR_LOCK" "release/Sonar lock"
  exec 9<>"$CONTROL_LOCK"
  "$FLOCK_BIN" -x 9
  exec 8<>"$SONAR_LOCK"
  "$FLOCK_BIN" -x 8
  [ ! -e "$PROMOTION_STATE_ROOT/active.json" ] \
    && [ ! -L "$PROMOTION_STATE_ROOT/active.json" ] \
    || die "ordinary promotion became active"
  verify_successor
}

write_sudoers_source() {
  SUDOERS_SOURCE="$INSTALL_STATE/sudoers.next"
  [ ! -e "$SUDOERS_SOURCE" ] && [ ! -L "$SUDOERS_SOURCE" ] \
    || rm -f -- "$SUDOERS_SOURCE"
  : >"$SUDOERS_SOURCE"
  cat >>"$SUDOERS_SOURCE" <<EOF
$WORKER_USER ALL=(root) NOPASSWD: NOSETENV: /usr/local/sbin/$BROKER_NAME version
$WORKER_USER ALL=(root) NOPASSWD: NOSETENV: /usr/local/sbin/$BROKER_NAME inspect
$WORKER_USER ALL=(root) NOPASSWD: NOSETENV: /usr/local/sbin/$BROKER_NAME prepare *
$WORKER_USER ALL=(root) NOPASSWD: NOSETENV: /usr/local/sbin/$BROKER_NAME launch *
$WORKER_USER ALL=(root) NOPASSWD: NOSETENV: /usr/local/sbin/$BROKER_NAME status *
$WORKER_USER ALL=(root) NOPASSWD: NOSETENV: /usr/local/sbin/$BROKER_NAME fetch-evidence *
EOF
  chmod 440 "$SUDOERS_SOURCE"
  root_own "$SUDOERS_SOURCE"
  if [ "$TEST_MODE" != 1 ]; then
    "$VISUDO_BIN" -cf "$SUDOERS_SOURCE" >/dev/null
  fi
}

begin_install_journal() {
  local index target_file enabled_state install_recovery_enabled_state directory
  local predecessor_inventory journal_temporary
  [ ! -e "$JOURNAL" ] && [ ! -L "$JOURNAL" ] \
    || die "an interrupted adapter installation must be recovered first"
  rm -rf -- "$BACKUPS"
  ensure_directory "$BACKUPS" 700
  for index in "${!TARGETS[@]}"; do
    target_file="${TARGETS[$index]}"
    if [ -e "$target_file" ] || [ -L "$target_file" ]; then
      assert_regular "$target_file" "predecessor installation target"
      install -m 600 -- "$target_file" "$BACKUPS/$index.file"
      root_own "$BACKUPS/$index.file"
      fsync_path "$BACKUPS/$index.file"
      printf '1\n' >"$BACKUPS/$index.existed"
      stat_value '%a' "$target_file" >"$BACKUPS/$index.mode"
      stat_value '%u' "$target_file" >"$BACKUPS/$index.uid"
      stat_value '%g' "$target_file" >"$BACKUPS/$index.gid"
    else
      printf '0\n' >"$BACKUPS/$index.existed"
      printf '600\n' >"$BACKUPS/$index.mode"
      printf '0\n' >"$BACKUPS/$index.uid"
      printf '0\n' >"$BACKUPS/$index.gid"
    fi
    chmod 600 "$BACKUPS/$index.existed" "$BACKUPS/$index.mode" \
      "$BACKUPS/$index.uid" "$BACKUPS/$index.gid"
    root_own "$BACKUPS/$index.existed" "$BACKUPS/$index.mode" \
      "$BACKUPS/$index.uid" "$BACKUPS/$index.gid"
    fsync_path "$BACKUPS/$index.existed"
    fsync_path "$BACKUPS/$index.mode"
    fsync_path "$BACKUPS/$index.uid"
    fsync_path "$BACKUPS/$index.gid"
  done
  index=0
  for directory in "$LEGACY_BASE" "$LEGACY_BASE/releases"; do
    if [ -d "$directory" ] && [ ! -L "$directory" ]; then
      printf '1\n' >"$BACKUPS/parent.$index.existed"
      stat_value '%a' "$directory" >"$BACKUPS/parent.$index.mode"
      stat_value '%u' "$directory" >"$BACKUPS/parent.$index.uid"
      stat_value '%g' "$directory" >"$BACKUPS/parent.$index.gid"
    else
      [ ! -e "$directory" ] && [ ! -L "$directory" ] \
        || die "legacy release parent is unsafe"
      printf '0\n' >"$BACKUPS/parent.$index.existed"
      printf '755\n' >"$BACKUPS/parent.$index.mode"
      printf '0\n' >"$BACKUPS/parent.$index.uid"
      printf '0\n' >"$BACKUPS/parent.$index.gid"
    fi
    chmod 600 "$BACKUPS"/parent."$index".*
    root_own "$BACKUPS"/parent."$index".*
    fsync_path "$BACKUPS/parent.$index.existed"
    fsync_path "$BACKUPS/parent.$index.mode"
    fsync_path "$BACKUPS/parent.$index.uid"
    fsync_path "$BACKUPS/parent.$index.gid"
    index=$((index + 1))
  done
  enabled_state=disabled
  install_recovery_enabled_state=disabled
  if [ "$TEST_MODE" != 1 ]; then
    enabled_state="$(
      capture_recovery_unit_state \
        "$RECOVERY_UNIT_NAME" \
        "$RECOVERY_UNIT_TARGET"
    )"
    install_recovery_enabled_state="$(
      capture_recovery_unit_state \
        "$INSTALL_RECOVERY_UNIT_NAME" \
        "$INSTALL_RECOVERY_UNIT_TARGET"
    )"
  fi
  printf '%s\n' "$enabled_state" >"$BACKUPS/recovery.enabled"
  printf '%s\n' "$install_recovery_enabled_state" \
    >"$BACKUPS/install-recovery.enabled"
  chmod 600 "$BACKUPS/recovery.enabled" \
    "$BACKUPS/install-recovery.enabled"
  root_own "$BACKUPS/recovery.enabled" \
    "$BACKUPS/install-recovery.enabled"
  fsync_path "$BACKUPS/recovery.enabled"
  fsync_path "$BACKUPS/install-recovery.enabled"
  fsync_path "$BACKUPS"
  predecessor_inventory="$(backup_inventory_json install)" \
    || die "install predecessor inventory could not be bound"
  journal_temporary="$(mktemp "$INSTALL_STATE/.install-journal.XXXXXXXX")"
  "$NODE_BIN" - "$journal_temporary" "$SOURCE_SHA" \
    "$EXPECTED_ARCHIVE_SHA256" "$predecessor_inventory" <<'NODE'
const fs=require('node:fs');
const [output,sourceSha,archiveSha256,inventoryJson]=process.argv.slice(2);
const value={
 schema:'nexus.rollback-drill-legacy-staging-install-journal.v1',
 phase:'prepared',promotionAllowed:false,source:{sourceSha,archiveSha256},
 predecessorInventory:JSON.parse(inventoryJson),
 preparedAt:new Date().toISOString(),
};
const fd=fs.openSync(output,'w',0o600);
try{fs.writeFileSync(fd,`${JSON.stringify(value,null,2)}\n`);fs.fsyncSync(fd);}
finally{fs.closeSync(fd);}
NODE
  chmod 600 "$journal_temporary"
  root_own "$journal_temporary"
  fsync_path "$journal_temporary"
  move_exact "$journal_temporary" "$JOURNAL"
  fsync_path "$INSTALL_STATE"
}

rollback_install() {
  local index target_file existed predecessor_mode predecessor_uid
  local predecessor_gid enabled_state install_recovery_enabled_state directory
  if [ "$UNINSTALL_ACTIVE" != true ]; then
    [ -f "$JOURNAL" ] && [ ! -L "$JOURNAL" ] || return 0
    validate_install_journal "${SOURCE_SHA:--}" \
      "${EXPECTED_ARCHIVE_SHA256:--}"
  else
    validate_uninstall_journal
  fi
  for ((index=${#TARGETS[@]}-1; index>=0; index-=1)); do
    target_file="${TARGETS[$index]}"
    if [ "$TEST_MODE" != 1 ]; then
      case "$target_file" in
        "$RECOVERY_UNIT_TARGET")
          disable_recovery_unit_if_present \
            "$RECOVERY_UNIT_NAME" \
            "$RECOVERY_UNIT_TARGET"
          ;;
        "$INSTALL_RECOVERY_UNIT_TARGET")
          disable_recovery_unit_if_present \
            "$INSTALL_RECOVERY_UNIT_NAME" \
            "$INSTALL_RECOVERY_UNIT_TARGET"
          ;;
      esac
    fi
    existed="$(tr -d '\n' <"$BACKUPS/$index.existed")"
    if [ "$existed" = 1 ]; then
      predecessor_mode="$(tr -d '\n' <"$BACKUPS/$index.mode")"
      [[ "$predecessor_mode" =~ ^[0-7]{3,4}$ ]] \
        || die "predecessor target mode is invalid"
      atomic_install "$BACKUPS/$index.file" "$target_file" \
        "$predecessor_mode"
      predecessor_uid="$(tr -d '\n' <"$BACKUPS/$index.uid")"
      predecessor_gid="$(tr -d '\n' <"$BACKUPS/$index.gid")"
      if [ "$TEST_MODE" != 1 ]; then
        chown "$predecessor_uid:$predecessor_gid" "$target_file"
      fi
    else
      rm -f -- "$target_file"
      [ ! -d "$(dirname -- "$target_file")" ] \
        || fsync_path "$(dirname -- "$target_file")"
    fi
    if [ "$UNINSTALL_ACTIVE" = true ] \
        && [ "${NEXUS_LEGACY_DRILL_TEST_UNINSTALL_FAIL_AFTER_TARGET:-}" \
          = "$index" ]; then
      die "injected transactional uninstall failure"
    fi
    if [ "$UNINSTALL_ACTIVE" = true ] && [ "$TEST_MODE" = 1 ] \
        && [ "${NEXUS_LEGACY_DRILL_TEST_UNINSTALL_POWER_LOSS_AFTER_TARGET:-}" \
          = "$index" ]; then
      trap - EXIT INT TERM HUP
      exit 198
    fi
  done
  index=1
  for directory in "$LEGACY_BASE/releases" "$LEGACY_BASE"; do
    existed="$(tr -d '\n' <"$BACKUPS/parent.$index.existed")"
    if [ "$existed" = 1 ]; then
      predecessor_mode="$(tr -d '\n' <"$BACKUPS/parent.$index.mode")"
      predecessor_uid="$(tr -d '\n' <"$BACKUPS/parent.$index.uid")"
      predecessor_gid="$(tr -d '\n' <"$BACKUPS/parent.$index.gid")"
      chmod "$predecessor_mode" "$directory"
      if [ "$TEST_MODE" != 1 ]; then
        chown "$predecessor_uid:$predecessor_gid" "$directory"
      fi
    else
      rmdir -- "$directory" 2>/dev/null || true
    fi
    index=$((index - 1))
  done
  rm -f -- "$RECEIPT"
  if [ "$TEST_MODE" != 1 ]; then
    "$SYSTEMCTL_BIN" daemon-reload
  fi
  test_recovery_failure daemon_reload
  if [ "$TEST_MODE" != 1 ]; then
    enabled_state="$(tr -d '\n' <"$BACKUPS/recovery.enabled")"
    install_recovery_enabled_state="$(
      tr -d '\n' <"$BACKUPS/install-recovery.enabled"
    )"
    restore_recovery_unit_state \
      "$RECOVERY_UNIT_NAME" \
      "$RECOVERY_UNIT_TARGET" "$enabled_state"
    restore_recovery_unit_state \
      "$INSTALL_RECOVERY_UNIT_NAME" \
      "$INSTALL_RECOVERY_UNIT_TARGET" \
      "$install_recovery_enabled_state"
  fi
  test_recovery_failure unit_state_restoration
  rm -f -- "$JOURNAL"
  fsync_path "$INSTALL_STATE"
}

secure_release_parents() {
  ensure_directory "$LEGACY_BASE" 755
  ensure_directory "$LEGACY_BASE/releases" 755
  chmod 755 "$LEGACY_BASE" "$LEGACY_BASE/releases"
  root_own "$LEGACY_BASE" "$LEGACY_BASE/releases"
  fsync_path "$LEGACY_BASE"
}

verify_successor() {
  [ "$("$CONTROL_BIN" version)" = nexus-release-promotion-control.v4 ] \
    || die "installed successor promotion control v4 is required"
  "$CONTROL_BIN" assert-idle >/dev/null \
    && "$CONTROL_BIN" assert-layout-ready >/dev/null \
    || die "installed successor layout evidence is not operationally valid"
  if [ "$TEST_MODE" != 1 ]; then
    [ "$CONTROL_BIN" = /usr/local/sbin/nexus-release-promotion-control ] \
      && [ "$(stat_value '%U:%G:%a:%h' "$CONTROL_BIN")" = root:root:700:1 ] \
      || die "installed successor control identity is unsafe"
  fi
}

begin_uninstall_journal() {
  local index target_file active_inventory install_inventory
  local journal_temporary
  [ ! -e "$UNINSTALL_JOURNAL" ] && [ ! -L "$UNINSTALL_JOURNAL" ] \
    || die "an interrupted adapter uninstall requires recovery"
  rm -rf -- "$UNINSTALL_BACKUPS"
  ensure_directory "$UNINSTALL_BACKUPS" 700
  for index in "${!TARGETS[@]}"; do
    target_file="${TARGETS[$index]}"
    assert_regular "$target_file" "active adapter uninstall target"
    install -m 600 -- "$target_file" "$UNINSTALL_BACKUPS/$index.file"
    root_own "$UNINSTALL_BACKUPS/$index.file"
    fsync_path "$UNINSTALL_BACKUPS/$index.file"
    stat_value '%a' "$target_file" >"$UNINSTALL_BACKUPS/$index.mode"
    stat_value '%u' "$target_file" >"$UNINSTALL_BACKUPS/$index.uid"
    stat_value '%g' "$target_file" >"$UNINSTALL_BACKUPS/$index.gid"
    chmod 600 "$UNINSTALL_BACKUPS"/"$index".*
    root_own "$UNINSTALL_BACKUPS"/"$index".*
    fsync_path "$UNINSTALL_BACKUPS/$index.mode"
    fsync_path "$UNINSTALL_BACKUPS/$index.uid"
    fsync_path "$UNINSTALL_BACKUPS/$index.gid"
  done
  install -m 600 -- "$RECEIPT" "$UNINSTALL_BACKUPS/receipt.json"
  root_own "$UNINSTALL_BACKUPS/receipt.json"
  fsync_path "$UNINSTALL_BACKUPS/receipt.json"
  fsync_path "$UNINSTALL_BACKUPS"
  active_inventory="$(backup_inventory_json uninstall)" \
    || die "uninstall active-adapter inventory could not be bound"
  install_inventory="$(backup_inventory_json install)" \
    || die "install predecessor inventory could not be rebound for uninstall"
  journal_temporary="$(mktemp "$INSTALL_STATE/.uninstall-journal.XXXXXXXX")"
  "$NODE_BIN" - "$journal_temporary" "$active_inventory" \
    "$install_inventory" <<'NODE'
const fs=require('node:fs');const [output,activeJson,installJson]=process.argv.slice(2);
const value={
 schema:'nexus.rollback-drill-legacy-staging-uninstall-journal.v1',
 phase:'prepared',activeAdapterInventory:JSON.parse(activeJson),
 installPredecessorInventory:JSON.parse(installJson),
 preparedAt:new Date().toISOString(),
};
const fd=fs.openSync(output,'w',0o600);
try{fs.writeFileSync(fd,`${JSON.stringify(value,null,2)}\n`);fs.fsyncSync(fd);}
finally{fs.closeSync(fd);}
NODE
  chmod 600 "$journal_temporary"
  root_own "$journal_temporary"
  fsync_path "$journal_temporary"
  move_exact "$journal_temporary" "$UNINSTALL_JOURNAL"
  fsync_path "$INSTALL_STATE"
}

restore_active_adapter() {
  local index target_file mode uid gid
  validate_uninstall_journal
  for index in "${!TARGETS[@]}"; do
    target_file="${TARGETS[$index]}"
    mode="$(tr -d '\n' <"$UNINSTALL_BACKUPS/$index.mode")"
    uid="$(tr -d '\n' <"$UNINSTALL_BACKUPS/$index.uid")"
    gid="$(tr -d '\n' <"$UNINSTALL_BACKUPS/$index.gid")"
    atomic_install "$UNINSTALL_BACKUPS/$index.file" "$target_file" "$mode"
    if [ "$TEST_MODE" != 1 ]; then chown "$uid:$gid" "$target_file"; fi
  done
  atomic_install "$UNINSTALL_BACKUPS/receipt.json" "$RECEIPT" 600
  secure_release_parents
  if [ "$TEST_MODE" != 1 ]; then
    "$SYSTEMCTL_BIN" daemon-reload
    "$SYSTEMCTL_BIN" enable \
      nexus-rollback-drill-legacy-staging-install-recovery.service >/dev/null
    "$SYSTEMCTL_BIN" enable \
      nexus-rollback-drill-legacy-staging-recovery.service >/dev/null
  fi
  rm -f -- "$UNINSTALL_JOURNAL"
  fsync_path "$INSTALL_STATE"
}

validate_uninstall_journal() {
  assert_regular "$UNINSTALL_JOURNAL" "uninstall recovery journal"
  [ "$(stat_value '%a' "$UNINSTALL_JOURNAL")" = 600 ] \
    && [ "$(stat_value '%s' "$UNINSTALL_JOURNAL")" -gt 0 ] \
    && [ "$(stat_value '%s' "$UNINSTALL_JOURNAL")" -le 1048576 ] \
    || die "uninstall recovery journal identity is unsafe"
  "$NODE_BIN" - "$UNINSTALL_JOURNAL" <<'NODE'
const fs=require('node:fs');
const value=JSON.parse(fs.readFileSync(process.argv[2]));
if(!value||Object.keys(value).sort().join(',')!==[
 'activeAdapterInventory','installPredecessorInventory','phase',
 'preparedAt','schema',
].sort().join(',')
 ||value.schema!=='nexus.rollback-drill-legacy-staging-uninstall-journal.v1'
 ||value.phase!=='prepared'
 ||!value.activeAdapterInventory
 ||typeof value.activeAdapterInventory!=='object'
 ||!value.installPredecessorInventory
 ||typeof value.installPredecessorInventory!=='object'
 ||typeof value.preparedAt!=='string'
 ||Number.isNaN(Date.parse(value.preparedAt)))process.exit(1);
NODE
  assert_bound_backup_inventory \
    "$UNINSTALL_JOURNAL" activeAdapterInventory uninstall
  assert_bound_backup_inventory \
    "$UNINSTALL_JOURNAL" installPredecessorInventory install
}

rollback_uninstall_on_failure() {
  local status=$?
  trap - EXIT INT TERM HUP
  if [ "$status" -ne 0 ] && [ "$UNINSTALL_ACTIVE" = true ] \
      && [ "$COMPLETE" = false ]; then
    set +e
    ( set -e; restore_active_adapter )
    local recovered=$?
    set -e
    [ "$recovered" -eq 0 ] \
      || echo "legacy staging drill uninstall recovery failed; journal retained" >&2
  fi
  exit "$status"
}

rollback_on_failure() {
  local status=$?
  trap - EXIT INT TERM HUP
  if [ "$status" -ne 0 ] && [ "$MUTATED" = true ] \
      && [ "$COMPLETE" = false ]; then
    set +e
    ( set -e; rollback_install )
    local recovered=$?
    set -e
    if [ "$recovered" -ne 0 ]; then
      echo "legacy staging drill installer recovery failed; root journal retained" >&2
    fi
  fi
  exit "$status"
}

validate_receipt() {
  [ -f "$RECEIPT" ] && [ ! -L "$RECEIPT" ] \
    || { echo "legacy staging drill adapter is not installed" >&2; return 66; }
  [ "$(stat_value '%a:%h' "$RECEIPT")" = 600:1 ] \
    || die "staging drill install receipt mode or link identity is unsafe"
  if [ "$TEST_MODE" != 1 ]; then
    [ "$(stat_value '%U:%G' "$RECEIPT")" = root:root ] \
      || die "staging drill install receipt owner is unsafe"
  fi
  "$NODE_BIN" - "$RECEIPT" "$RECEIPT_SCHEMA" \
    "$EXPECTED_CONTROL_VERSION" "$EXPECTED_CONTROL_SHA256" "$PROFILE_MODE" \
    "$TEST_MODE" \
    "$PHASE_A_RECEIPT" "$PHASE_A_SOURCE_SHA" "$PHASE_A_ARCHIVE_SHA256" \
    "$PHASE_A_RECEIPT_SHA256" \
    "$INSTALLER_TARGET" "$INSTALL_RECOVERY_UNIT_TARGET" \
    "$BROKER_TARGET" "$ADAPTER_TARGET" "$DEPENDENCY_TARGET" \
    "$INSTALLED_ATTESTOR_TARGET" "$RECOVERY_ATTESTOR_TARGET" \
    "$PUBLIC_KEY_TARGET" "$TRANSACTION_UNIT_TARGET" "$RECOVERY_UNIT_TARGET" \
    "$PM2_DOMINGUEZ_DROP_IN_TARGET" "$PM2_ROOT_DROP_IN_TARGET" \
    "$PROMOTION_RECOVERY_DROP_IN_TARGET" \
    "$SUDOERS_TARGET" "$SQLITE_HELPER_TARGET" \
    "$FILESYSTEM_HELPER_TARGET" <<'NODE'
const crypto=require('node:crypto');const fs=require('node:fs');
const [receiptFile,schema,controlVersion,controlSha256,profile,testMode,phaseAFile,
 phaseASourceSha,phaseAArchiveSha256,phaseAReceiptSha256,
 installer,installRecoveryUnit,
 broker,adapter,dependencies,installedAttestor,
 recoveryAttestor,releasePublicKey,transactionUnit,recoveryUnit,
 pm2DominguezDropIn,pm2RootDropIn,promotionRecoveryDropIn,
 sudoers,sqliteTool,filesystemHelper]
 =process.argv.slice(2);
const hash=(body)=>crypto.createHash('sha256').update(body).digest('hex');
const receiptBody=fs.readFileSync(receiptFile);
const receipt=JSON.parse(receiptBody);
const digest=(file)=>hash(fs.readFileSync(file));
const rootUid=testMode==='1'?process.getuid():0;
const rootGid=testMode==='1'?process.getgid():0;
const files={
 installer:[installer,0o700],installRecoveryUnit:[installRecoveryUnit,0o644],
 broker:[broker,0o700],adapter:[adapter,0o700],dependencies:[dependencies,0o700],
 installedAttestor:[installedAttestor,0o700],
 recoveryAttestor:[recoveryAttestor,0o700],
 releasePublicKey:[releasePublicKey,0o644],
 transactionUnit:[transactionUnit,0o644],recoveryUnit:[recoveryUnit,0o644],
 pm2DominguezDropIn:[pm2DominguezDropIn,0o644],
 pm2RootDropIn:[pm2RootDropIn,0o644],sudoers:[sudoers,0o440],
 sqliteTool:[sqliteTool,0o644],filesystemHelper:[filesystemHelper,0o700],
};
if(receipt.schema!==schema
 ||receipt.status!=='active'||receipt.promotionAllowed!==false
 ||receipt.control?.version!==controlVersion
 ||receipt.control?.sha256!==controlSha256)process.exit(1);
if(profile==='v4-prelayout'){
 const phaseABody=fs.readFileSync(phaseAFile),phaseA=JSON.parse(phaseABody);
 if(receipt.phaseA?.sourceSha!==phaseASourceSha
  ||receipt.phaseA?.archiveSha256!==phaseAArchiveSha256
  ||receipt.phaseA?.receiptSha256!==phaseAReceiptSha256
  ||hash(phaseABody)!==phaseAReceiptSha256
  ||phaseA.sourceSha!==phaseASourceSha
  ||phaseA.sourceArchiveSha256!==phaseAArchiveSha256
  ||phaseA.status!=='completed'||phaseA.phaseARecoveryGuard!==true
 ||typeof phaseA.legacyV2AdapterRetired!=='boolean')process.exit(1);
 files.promotionRecoveryDropIn=[promotionRecoveryDropIn,0o644];
}else if(receipt.phaseA!==undefined
 ||receipt.installed?.promotionRecoveryDropIn!==undefined)process.exit(1);
for(const [name,[file,mode]] of Object.entries(files)){
 const stat=fs.lstatSync(file);
 if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1
  ||stat.uid!==rootUid||stat.gid!==rootGid||(stat.mode&0o7777)!==mode
  ||receipt.installed?.[name]!==digest(file))process.exit(1);
}
process.stdout.write(`${JSON.stringify({
 ok:true,installed:true,promotable:false,sourceSha:receipt.source.sourceSha,
 archiveSha256:receipt.source.archiveSha256,installedAt:receipt.installedAt,
})}\n`);
NODE
}

write_retirement_journal() {
  local temporary
  temporary="$(mktemp "$INSTALL_STATE/.retire-for-layout.XXXXXXXX")"
  "$NODE_BIN" - "$temporary" "$RECEIPT" "$STATE_ROOT/transactions" \
    "$PM2_DOMINGUEZ_DROP_IN_TARGET" "$PM2_ROOT_DROP_IN_TARGET" \
    "$PROMOTION_RECOVERY_DROP_IN_TARGET" "$SUDOERS_TARGET" \
    "$TEST_MODE" <<'NODE'
const crypto=require('node:crypto');const fs=require('node:fs');const path=require('node:path');
const [output,receiptFile,transactions,pm2Dominguez,pm2Root,
 promotionRecoveryDropIn,sudoers,testMode]=process.argv.slice(2);
const sha=(body)=>crypto.createHash('sha256').update(body).digest('hex');
const canonical=(value)=>value===null||typeof value!=='object'
 ?JSON.stringify(value):Array.isArray(value)
  ?`[${value.map(canonical).join(',')}]`
  :`{${Object.keys(value).sort().map((key)=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
const receiptBody=fs.readFileSync(receiptFile),receipt=JSON.parse(receiptBody);
if(receipt.schema!=='nexus.rollback-drill-v4-prelayout-staging-install-receipt.v1'
 ||receipt.status!=='active'||receipt.promotionAllowed!==false)process.exit(1);
const terminal=[];
const successful=[];
for(const entry of fs.readdirSync(transactions,{withFileTypes:true})
  .sort((left,right)=>left.name.localeCompare(right.name))){
 if(!entry.isDirectory()||entry.isSymbolicLink()
  ||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
    .test(entry.name))process.exit(1);
 const journal=path.join(transactions,entry.name,'journal.json');
 const body=fs.readFileSync(journal),value=JSON.parse(body);
 if(value.schema!=='nexus.rollback-drill-legacy-staging-journal.v1'
  ||value.requestId!==entry.name
  ||!new Set(['completed','recovered']).has(value.phase))process.exit(1);
 const journalSha256=sha(body);
 terminal.push({requestId:entry.name,phase:value.phase,journalSha256});
 if(value.phase==='completed'){
  const evidenceFile=path.join(transactions,entry.name,'evidence.json');
  const stat=fs.lstatSync(evidenceFile),evidenceBody=fs.readFileSync(evidenceFile);
  const rootUid=testMode==='1'?process.getuid():0;
  const rootGid=testMode==='1'?process.getgid():0;
  const evidence=JSON.parse(evidenceBody),evidenceSha256=sha(evidenceBody);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1
   ||stat.uid!==rootUid||stat.gid!==rootGid||(stat.mode&0o7777)!==0o600
   ||stat.size<=0||stat.size>4*1024*1024
   ||value.evidenceSha256!==evidenceSha256
   ||evidence.schema!=='nexus.rollback-drill-legacy-staging-evidence.v1'
   ||evidence.status!=='completed'||evidence.promotionAllowed!==false
   ||evidence.requestId!==entry.name)process.exit(1);
  successful.push({requestId:entry.name,journalSha256,evidenceSha256});
 }
}
if(successful.length<1)process.exit(1);
const retiredAssets={
 pm2DominguezDropIn:{path:pm2Dominguez,sha256:receipt.installed.pm2DominguezDropIn},
 pm2RootDropIn:{path:pm2Root,sha256:receipt.installed.pm2RootDropIn},
 promotionRecoveryDropIn:{
  path:promotionRecoveryDropIn,
  sha256:receipt.installed.promotionRecoveryDropIn,
 },
 sudoers:{path:sudoers,sha256:receipt.installed.sudoers},
};
const now=new Date().toISOString();
const value={
 schema:'nexus.rollback-drill-v4-prelayout-staging-retirement-journal.v1',
 phase:'prepared',promotionAllowed:false,
 source:receipt.source,phaseA:receipt.phaseA,control:receipt.control,
 installReceipt:{path:receiptFile,sha256:sha(receiptBody)},
 terminal:{count:terminal.length,aggregateSha256:sha(Buffer.from(canonical(terminal)))},
 successful:{
  count:successful.length,
  aggregateSha256:sha(Buffer.from(canonical(successful))),
  evidence:successful,
 },
 retiredAssets,preparedAt:now,phaseUpdatedAt:now,
};
const fd=fs.openSync(output,'w',0o600);
try{fs.writeFileSync(fd,`${JSON.stringify(value,null,2)}\n`);fs.fsyncSync(fd);}
finally{fs.closeSync(fd);}
NODE
  chmod 600 "$temporary"
  root_own "$temporary"
  fsync_path "$temporary"
  validate_retirement_success_evidence "$temporary"
  move_exact "$temporary" "$RETIREMENT_JOURNAL"
  fsync_path "$INSTALL_STATE"
}

validate_retirement_success_evidence() {
  local journal="$1" request_id evidence_digest evidence
  while IFS=$'\t' read -r request_id evidence_digest; do
    [ -n "$request_id" ] && [ -n "$evidence_digest" ] \
      || die "successful v4 drill evidence binding is empty"
    evidence="$STATE_ROOT/transactions/$request_id/evidence.json"
    assert_regular "$evidence" "successful v4 drill evidence"
    [ "$(stat_value '%a' "$evidence")" = 600 ] \
      && [ "$(sha256_file "$evidence")" = "$evidence_digest" ] \
      || die "successful v4 drill evidence identity changed"
    if [ "$TEST_MODE" = 1 ]; then
      NODE_ENV=test \
      NEXUS_LEGACY_DRILL_BASE="$LEGACY_BASE" \
      NEXUS_LEGACY_DRILL_DATABASE_TRANSACTION_ROOT="$STATE_ROOT/transactions" \
      NEXUS_LEGACY_DRILL_SQLITE_HELPER="$SQLITE_HELPER_TARGET" \
      NEXUS_LEGACY_DRILL_FILESYSTEM_HELPER="$FILESYSTEM_HELPER_TARGET" \
      NEXUS_LEGACY_DRILL_EXPECTED_SQLITE_HELPER_SHA256="$EXPECTED_SQLITE_HELPER_SHA256" \
      "$NODE_BIN" "$ADAPTER_TARGET" validate-broker-evidence \
        --evidence "$evidence" >/dev/null \
        || die "successful v4 drill evidence failed exact adapter validation"
    else
      "$NODE_BIN" "$ADAPTER_TARGET" validate-broker-evidence \
        --evidence "$evidence" >/dev/null \
        || die "successful v4 drill evidence failed exact adapter validation"
    fi
  done < <("$NODE_BIN" - "$journal" <<'NODE'
const fs=require('node:fs');const value=JSON.parse(fs.readFileSync(process.argv[2]));
if(!Array.isArray(value.successful?.evidence)
 ||value.successful.evidence.length<1)process.exit(1);
for(const item of value.successful.evidence){
 process.stdout.write(`${item.requestId}\t${item.evidenceSha256}\n`);
}
NODE
  )
}

retirement_journal_phase() {
  assert_regular "$RETIREMENT_JOURNAL" "v4 pre-layout retirement journal"
  [ "$(stat_value '%a:%h' "$RETIREMENT_JOURNAL")" = 600:1 ] \
    || die "v4 pre-layout retirement journal mode is unsafe"
  if [ "$TEST_MODE" != 1 ]; then
    [ "$(stat_value '%U:%G' "$RETIREMENT_JOURNAL")" = root:root ] \
      || die "v4 pre-layout retirement journal owner is unsafe"
  fi
  "$NODE_BIN" - "$RETIREMENT_JOURNAL" <<'NODE'
const crypto=require('node:crypto');const fs=require('node:fs');
const value=JSON.parse(fs.readFileSync(process.argv[2]));
const exact=(x,keys)=>x&&typeof x==='object'&&!Array.isArray(x)
 &&Object.keys(x).sort().join(',')===[...keys].sort().join(',');
const hex=/^[a-f0-9]{64}$/u;
const canonical=(x)=>x===null||typeof x!=='object'?JSON.stringify(x)
 :Array.isArray(x)?`[${x.map(canonical).join(',')}]`
 :`{${Object.keys(x).sort().map(
  (key)=>`${JSON.stringify(key)}:${canonical(x[key])}`,
 ).join(',')}}`;
const sha=(body)=>crypto.createHash('sha256').update(body).digest('hex');
if(!exact(value,['schema','phase','promotionAllowed','source','phaseA','control',
 'installReceipt','terminal','successful','retiredAssets','preparedAt',
 'phaseUpdatedAt'])
 ||value.schema!=='nexus.rollback-drill-v4-prelayout-staging-retirement-journal.v1'
 ||!new Set(['prepared','recovery_disabled','admission_closed','authority_retired'])
   .has(value.phase)
 ||value.promotionAllowed!==false
 ||!exact(value.source,['sourceSha','archiveSha256'])
 ||!exact(value.phaseA,['sourceSha','archiveSha256','receiptSha256'])
 ||!exact(value.control,['version','sha256'])
 ||value.control.version!=='nexus-release-promotion-control.v4'
 ||!exact(value.installReceipt,['path','sha256'])
 ||!hex.test(value.installReceipt.sha256??'')
 ||!exact(value.terminal,['count','aggregateSha256'])
 ||!Number.isSafeInteger(value.terminal.count)||value.terminal.count<0
 ||!hex.test(value.terminal.aggregateSha256??'')
 ||!exact(value.successful,['count','aggregateSha256','evidence'])
 ||!Number.isSafeInteger(value.successful.count)||value.successful.count<1
 ||!hex.test(value.successful.aggregateSha256??'')
 ||!Array.isArray(value.successful.evidence)
 ||value.successful.evidence.length!==value.successful.count
 ||value.successful.evidence.some((item)=>!exact(
  item,['requestId','journalSha256','evidenceSha256'],
 )||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
  .test(item.requestId??'')
  ||!hex.test(item.journalSha256??'')||!hex.test(item.evidenceSha256??''))
 ||value.successful.aggregateSha256
   !==sha(Buffer.from(canonical(value.successful.evidence)))
 ||!Number.isFinite(Date.parse(value.preparedAt??''))
 ||!Number.isFinite(Date.parse(value.phaseUpdatedAt??'')))process.exit(1);
for(const name of [
 'pm2DominguezDropIn','pm2RootDropIn','promotionRecoveryDropIn','sudoers',
]){
 const asset=value.retiredAssets?.[name];
 if(!exact(asset,['path','sha256'])||!hex.test(asset.sha256??''))process.exit(1);
}
process.stdout.write(value.phase);
NODE
  validate_retirement_success_evidence "$RETIREMENT_JOURNAL"
}

advance_retirement_phase() {
  local expected="$1" next="$2" temporary
  [ "$(retirement_journal_phase)" = "$expected" ] \
    || die "v4 pre-layout retirement phase changed"
  temporary="$(mktemp "$INSTALL_STATE/.retire-for-layout-phase.XXXXXXXX")"
  "$NODE_BIN" - "$RETIREMENT_JOURNAL" "$temporary" "$expected" "$next" <<'NODE'
const fs=require('node:fs');const [source,output,expected,next]=process.argv.slice(2);
const value=JSON.parse(fs.readFileSync(source));
if(value.phase!==expected)process.exit(1);
value.phase=next;value.phaseUpdatedAt=new Date().toISOString();
const fd=fs.openSync(output,'w',0o600);
try{fs.writeFileSync(fd,`${JSON.stringify(value,null,2)}\n`);fs.fsyncSync(fd);}
finally{fs.closeSync(fd);}
NODE
  chmod 600 "$temporary"; root_own "$temporary"; fsync_path "$temporary"
  move_exact "$temporary" "$RETIREMENT_JOURNAL"
  fsync_path "$INSTALL_STATE"
}

retirement_asset_field() {
  "$NODE_BIN" -e '
const x=require(process.argv[1]);const value=x.retiredAssets?.[process.argv[2]];
if(!value)process.exit(1);process.stdout.write(`${value.path}\t${value.sha256}`);' \
    "$RETIREMENT_JOURNAL" "$1"
}

durable_remove_retirement_asset() {
  local name="$1" expected_path="$2" expected_mode="$3"
  local fields path_value digest_value
  fields="$(retirement_asset_field "$name")" \
    || die "retirement asset binding is unavailable: $name"
  IFS=$'\t' read -r path_value digest_value <<<"$fields"
  [ "$path_value" = "$expected_path" ] \
    || die "retirement asset path changed: $name"
  if [ -e "$expected_path" ] || [ -L "$expected_path" ]; then
    assert_regular "$expected_path" "v4 retirement asset $name"
    [ "$(stat_value '%a' "$expected_path")" = "$expected_mode" ] \
      && [ "$(sha256_file "$expected_path")" = "$digest_value" ] \
      || die "v4 retirement asset identity changed: $name"
    if [ "$TEST_MODE" != 1 ]; then
      [ "$(stat_value '%U:%G' "$expected_path")" = root:root ] \
        || die "v4 retirement asset owner changed: $name"
    fi
    rm -f -- "$expected_path"
    fsync_path "$(dirname -- "$expected_path")"
  fi
}

archive_active_receipt() {
  local expected_digest
  expected_digest="$("$NODE_BIN" -e '
const x=require(process.argv[1]);process.stdout.write(x.installReceipt.sha256);' \
    "$RETIREMENT_JOURNAL")"
  if [ -e "$RETIRED_RECEIPT" ] || [ -L "$RETIRED_RECEIPT" ]; then
    assert_regular "$RETIRED_RECEIPT" "retired v4 install receipt"
    [ "$(stat_value '%a:%h' "$RETIRED_RECEIPT")" = 600:1 ] \
      && [ "$(sha256_file "$RETIRED_RECEIPT")" = "$expected_digest" ] \
      || die "retired v4 install receipt identity changed"
    if [ "$TEST_MODE" != 1 ]; then
      [ "$(stat_value '%U:%G' "$RETIRED_RECEIPT")" = root:root ] \
        || die "retired v4 install receipt owner changed"
    fi
  else
    assert_regular "$RECEIPT" "active v4 install receipt"
    [ "$(sha256_file "$RECEIPT")" = "$expected_digest" ] \
      || die "active v4 install receipt changed during retirement"
    atomic_install "$RECEIPT" "$RETIRED_RECEIPT" 600
  fi
  test_retirement_power_loss retirement_receipt_archived
  if [ -e "$RECEIPT" ] || [ -L "$RECEIPT" ]; then
    assert_regular "$RECEIPT" "active v4 install receipt"
    [ "$(sha256_file "$RECEIPT")" = "$expected_digest" ] \
      || die "active v4 install receipt changed before removal"
    rm -f -- "$RECEIPT"
    fsync_path "$STATE_ROOT"
  fi
  test_retirement_power_loss retirement_active_receipt_removed
}

write_retirement_receipt() {
  local temporary
  [ "$(retirement_journal_phase)" = authority_retired ] \
    || die "v4 authority has not reached its retired phase"
  temporary="$(mktemp "$STATE_ROOT/.retirement-receipt.XXXXXXXX")"
  "$NODE_BIN" - "$RETIREMENT_JOURNAL" "$RETIRED_RECEIPT" "$temporary" <<'NODE'
const crypto=require('node:crypto');const fs=require('node:fs');
const [journalFile,archiveFile,output]=process.argv.slice(2);
const sha=(body)=>crypto.createHash('sha256').update(body).digest('hex');
const journalBody=fs.readFileSync(journalFile),journal=JSON.parse(journalBody);
const archiveBody=fs.readFileSync(archiveFile);
if(journal.phase!=='authority_retired'
 ||sha(archiveBody)!==journal.installReceipt.sha256)process.exit(1);
const value={
 schema:'nexus.rollback-drill-v4-prelayout-staging-retirement.v1',
 status:'retired',promotionAllowed:false,
 source:journal.source,phaseA:journal.phaseA,control:journal.control,
 installReceipt:{
  activePath:journal.installReceipt.path,
  archivedPath:archiveFile,
  sha256:journal.installReceipt.sha256,
 },
 terminal:journal.terminal,successful:journal.successful,
 retiredAssets:journal.retiredAssets,
 retirementJournalSha256:sha(journalBody),retiredAt:new Date().toISOString(),
};
const fd=fs.openSync(output,'w',0o600);
try{fs.writeFileSync(fd,`${JSON.stringify(value,null,2)}\n`);fs.fsyncSync(fd);}
finally{fs.closeSync(fd);}
NODE
  chmod 600 "$temporary"; root_own "$temporary"; fsync_path "$temporary"
  move_exact "$temporary" "$RETIREMENT_RECEIPT"
  fsync_path "$STATE_ROOT"
}

validate_retirement_receipt() {
  assert_regular "$RETIREMENT_RECEIPT" "v4 pre-layout retirement receipt"
  [ "$(stat_value '%a:%h' "$RETIREMENT_RECEIPT")" = 600:1 ] \
    || die "v4 pre-layout retirement receipt mode is unsafe"
  if [ "$TEST_MODE" != 1 ]; then
    [ "$(stat_value '%U:%G' "$RETIREMENT_RECEIPT")" = root:root ] \
      && [ "$(stat_value '%U:%G:%a:%h' "$RETIRED_RECEIPT")" \
        = root:root:600:1 ] \
      || die "v4 pre-layout retirement receipt ownership is unsafe"
  fi
  [ ! -e "$RECEIPT" ] && [ ! -L "$RECEIPT" ] \
    && [ ! -e "$PM2_DOMINGUEZ_DROP_IN_TARGET" ] \
    && [ ! -L "$PM2_DOMINGUEZ_DROP_IN_TARGET" ] \
    && [ ! -e "$PM2_ROOT_DROP_IN_TARGET" ] \
    && [ ! -L "$PM2_ROOT_DROP_IN_TARGET" ] \
    && [ ! -e "$PROMOTION_RECOVERY_DROP_IN_TARGET" ] \
    && [ ! -L "$PROMOTION_RECOVERY_DROP_IN_TARGET" ] \
    && [ ! -e "$SUDOERS_TARGET" ] && [ ! -L "$SUDOERS_TARGET" ] \
    || die "v4 pre-layout retirement left active admission authority"
  "$NODE_BIN" - "$RETIREMENT_RECEIPT" "$RETIREMENT_JOURNAL" \
    "$RETIRED_RECEIPT" <<'NODE'
const crypto=require('node:crypto');const fs=require('node:fs');
const [receiptFile,journalFile,archiveFile]=process.argv.slice(2);
const sha=(body)=>crypto.createHash('sha256').update(body).digest('hex');
const value=JSON.parse(fs.readFileSync(receiptFile));
const journalBody=fs.readFileSync(journalFile),journal=JSON.parse(journalBody);
const archiveBody=fs.readFileSync(archiveFile);
if(value.schema!=='nexus.rollback-drill-v4-prelayout-staging-retirement.v1'
 ||value.status!=='retired'||value.promotionAllowed!==false
 ||journal.phase!=='authority_retired'
 ||value.retirementJournalSha256!==sha(journalBody)
 ||value.installReceipt?.archivedPath!==archiveFile
 ||value.installReceipt?.sha256!==sha(archiveBody)
 ||value.installReceipt.sha256!==journal.installReceipt.sha256
 ||value.successful?.count!==journal.successful?.count
 ||value.successful?.aggregateSha256!==journal.successful?.aggregateSha256
 ||JSON.stringify(value.successful?.evidence)
   !==JSON.stringify(journal.successful?.evidence))process.exit(1);
NODE
  validate_retirement_success_evidence "$RETIREMENT_JOURNAL"
}

disable_retirement_unit() {
  local unit="$1" state
  [ "$TEST_MODE" = 1 ] && return 0
  "$SYSTEMCTL_BIN" disable "$unit" >/dev/null
  state="$("$SYSTEMCTL_BIN" is-enabled "$unit" 2>/dev/null || true)"
  case "$state" in
    disabled|not-found) ;;
    *) die "v4 pre-layout retirement unit remains enabled: $unit ($state)" ;;
  esac
}

retire_for_layout() {
  local phase
  acquire_retirement_locks
  if [ -e "$RETIREMENT_RECEIPT" ] || [ -L "$RETIREMENT_RECEIPT" ]; then
    validate_retirement_receipt
    disable_retirement_unit "$INSTALL_RECOVERY_UNIT_NAME"
    printf '%s\n' \
      '{"ok":true,"installed":false,"promotable":false,"status":"retired_for_layout","idempotent":true}'
    return
  fi
  [ ! -e "$JOURNAL" ] && [ ! -L "$JOURNAL" ] \
    || die "interrupted v4 installation must be recovered before retirement"
  if [ ! -e "$RETIREMENT_JOURNAL" ] && [ ! -L "$RETIREMENT_JOURNAL" ]; then
    validate_receipt >/dev/null
    write_retirement_journal
    test_retirement_power_loss retirement_prepared
  fi
  phase="$(retirement_journal_phase)"
  if [ "$phase" = prepared ]; then
    disable_retirement_unit "$RECOVERY_UNIT_NAME"
    advance_retirement_phase prepared recovery_disabled
    phase=recovery_disabled
    test_retirement_power_loss retirement_recovery_disabled
  fi
  if [ "$phase" = recovery_disabled ]; then
    durable_remove_retirement_asset \
      pm2DominguezDropIn "$PM2_DOMINGUEZ_DROP_IN_TARGET" 644
    test_retirement_power_loss retirement_pm2_dominguez_removed
    durable_remove_retirement_asset \
      pm2RootDropIn "$PM2_ROOT_DROP_IN_TARGET" 644
    test_retirement_power_loss retirement_pm2_root_removed
    durable_remove_retirement_asset promotionRecoveryDropIn \
      "$PROMOTION_RECOVERY_DROP_IN_TARGET" 644
    test_retirement_power_loss retirement_promotion_recovery_dropin_removed
    durable_remove_retirement_asset sudoers "$SUDOERS_TARGET" 440
    test_retirement_power_loss retirement_sudoers_removed
    if [ "$TEST_MODE" != 1 ]; then "$SYSTEMCTL_BIN" daemon-reload; fi
    advance_retirement_phase recovery_disabled admission_closed
    phase=admission_closed
    test_retirement_power_loss retirement_admission_closed
  fi
  if [ "$phase" = admission_closed ]; then
    archive_active_receipt
    advance_retirement_phase admission_closed authority_retired
    phase=authority_retired
    test_retirement_power_loss retirement_authority_retired
  fi
  [ "$phase" = authority_retired ] \
    || die "v4 pre-layout retirement stopped at an unknown phase"
  write_retirement_receipt
  disable_retirement_unit "$INSTALL_RECOVERY_UNIT_NAME"
  validate_retirement_receipt
  printf '%s\n' \
    '{"ok":true,"installed":false,"promotable":false,"status":"retired_for_layout","idempotent":false}'
}

phase_a_retirement_plan() {
  local recovery_enabled_state install_recovery_enabled_state
  validate_receipt >/dev/null
  if [ "$TEST_MODE" = 1 ]; then
    recovery_enabled_state="$(tr -d '\n' <"$BACKUPS/recovery.enabled")"
    install_recovery_enabled_state="$(
      tr -d '\n' <"$BACKUPS/install-recovery.enabled"
    )"
  else
    recovery_enabled_state="$(
      "$SYSTEMCTL_BIN" is-enabled \
        nexus-rollback-drill-legacy-staging-recovery.service 2>/dev/null \
        || true
    )"
    install_recovery_enabled_state="$(
      "$SYSTEMCTL_BIN" is-enabled \
        nexus-rollback-drill-legacy-staging-install-recovery.service \
        2>/dev/null || true
    )"
  fi
  case "$recovery_enabled_state" in
    enabled|enabled-runtime|linked|linked-runtime|alias|disabled|not-found) ;;
    *) die "legacy recovery unit enablement state is not canonical" ;;
  esac
  case "$install_recovery_enabled_state" in
    enabled|enabled-runtime|linked|linked-runtime|alias|disabled|not-found) ;;
    *) die "legacy install recovery unit enablement state is not canonical" ;;
  esac
  "$NODE_BIN" - "$TEST_MODE" "$STATE_ROOT" "$RECEIPT" "$BACKUPS" \
    "$CONTROL_BIN" "$recovery_enabled_state" \
    "$install_recovery_enabled_state" "$SQLITE_HELPER_TARGET" \
    "$INSTALLER_TARGET" installer 700 \
    "$INSTALL_RECOVERY_UNIT_TARGET" installRecoveryUnit 644 \
    "$BROKER_TARGET" broker 700 \
    "$ADAPTER_TARGET" adapter 700 \
    "$DEPENDENCY_TARGET" dependencies 700 \
    "$INSTALLED_ATTESTOR_TARGET" installedAttestor 700 \
    "$RECOVERY_ATTESTOR_TARGET" recoveryAttestor 700 \
    "$PUBLIC_KEY_TARGET" releasePublicKey 644 \
    "$TRANSACTION_UNIT_TARGET" transactionUnit 644 \
    "$RECOVERY_UNIT_TARGET" recoveryUnit 644 \
    "$PM2_DOMINGUEZ_DROP_IN_TARGET" pm2DominguezDropIn 644 \
    "$PM2_ROOT_DROP_IN_TARGET" pm2RootDropIn 644 \
    "$SUDOERS_TARGET" sudoers 440 \
    "$FILESYSTEM_HELPER_TARGET" filesystemHelper 700 <<'NODE'
const crypto=require('node:crypto');const fs=require('node:fs');const path=require('node:path');
const [testMode,stateRoot,receiptPath,backups,controlPath,recoveryEnabledState,
 installRecoveryEnabledState,sqliteHelperPath,...targetArguments]=process.argv.slice(2);
const digest=/^[a-f0-9]{64}$/u;
const sha=(body)=>crypto.createHash('sha256').update(body).digest('hex');
const canonical=(value)=>value===null||typeof value!=='object'
 ?JSON.stringify(value):Array.isArray(value)
  ?`[${value.map(canonical).join(',')}]`
  :`{${Object.keys(value).sort().map((key)=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)
 &&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
const safeFile=(file,label,{maximum=128*1024*1024,mode=null}={})=>{
 const observed=fs.lstatSync(file);
 if(!observed.isFile()||observed.isSymbolicLink()||observed.nlink!==1
  ||observed.size<0||observed.size>maximum
  ||(testMode!=='1'&&(observed.uid!==0||observed.gid!==0))
 ||(mode!==null&&(observed.mode&0o7777)!==mode)){
  throw new Error(`${label} identity is unsafe`);
 }
 const descriptor=fs.openSync(
   file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0),
 );
 try{
  const opened=fs.fstatSync(descriptor);
  if(opened.dev!==observed.dev||opened.ino!==observed.ino
   ||opened.size!==observed.size||opened.mtimeMs!==observed.mtimeMs){
   throw new Error(`${label} changed while it was opened`);
  }
  const body=fs.readFileSync(descriptor);
  const after=fs.fstatSync(descriptor);
  if(after.dev!==opened.dev||after.ino!==opened.ino
   ||after.size!==body.length||after.mtimeMs!==opened.mtimeMs){
   throw new Error(`${label} changed while it was read`);
  }
  return {body,observed:opened};
 }finally{
  fs.closeSync(descriptor);
 }
};
if(targetArguments.length!==42)throw new Error('retirement target contract is incomplete');
const receiptEvidence=safeFile(receiptPath,'active install receipt',{maximum:1024*1024,mode:0o600});
const receipt=JSON.parse(receiptEvidence.body);
if(!exact(receipt,['schema','status','promotionAllowed','source','control','installed','installedAt'])
 ||!exact(receipt.source,['sourceSha','archiveSha256'])
 ||!exact(receipt.control,['version','sha256'])
 ||receipt.schema!=='nexus.rollback-drill-legacy-staging-install-receipt.v1'
 ||receipt.status!=='active'||receipt.promotionAllowed!==false
 ||!/^[a-f0-9]{40}$/u.test(receipt.source.sourceSha||'')
 ||!digest.test(receipt.source.archiveSha256||'')
 ||receipt.control.version!=='nexus-release-promotion-control.v2'
 ||!digest.test(receipt.control.sha256||'')
 ||!Number.isFinite(Date.parse(receipt.installedAt||''))){
 throw new Error('active install receipt contract is invalid');
}
const controlEvidence=safeFile(controlPath,'live v2 promotion control',{mode:0o700});
if(sha(controlEvidence.body)!==receipt.control.sha256){
 throw new Error('live v2 promotion control differs from the active receipt');
}
const sqliteHelperEvidence=safeFile(
 sqliteHelperPath,'retained application DR SQLite helper',{
   maximum:1024*1024,mode:0o644,
 },
);
const sqliteHelperSha256=sha(sqliteHelperEvidence.body);
if(!digest.test(receipt.installed?.sqliteTool||'')
 ||receipt.installed.sqliteTool!==sqliteHelperSha256){
 throw new Error('retained application DR SQLite helper differs from receipt');
}
const targets=[];
for(let index=0;index<targetArguments.length;index+=3){
 const targetPath=targetArguments[index];
 const receiptName=targetArguments[index+1];
 const expectedMode=Number.parseInt(targetArguments[index+2],8);
 const activeEvidence=safeFile(targetPath,`active retirement target ${receiptName}`,{
  maximum:16*1024*1024,mode:expectedMode,
 });
 const activeSha256=sha(activeEvidence.body);
 if(!digest.test(receipt.installed?.[receiptName]||'')
  ||receipt.installed[receiptName]!==activeSha256){
  throw new Error(`active retirement target differs from receipt: ${receiptName}`);
 }
 const metadata={};
 for(const field of ['existed','mode','uid','gid']){
  const evidence=safeFile(path.join(backups,`${index/3}.${field}`),
    `predecessor ${receiptName} ${field}`,{maximum:64,mode:0o600});
  metadata[field]=evidence.body.toString('utf8').replace(/\n$/u,'');
 }
 if(!/^[01]$/u.test(metadata.existed)
  ||!/^[0-7]{3,4}$/u.test(metadata.mode)
  ||!/^(?:0|[1-9][0-9]*)$/u.test(metadata.uid)
  ||!/^(?:0|[1-9][0-9]*)$/u.test(metadata.gid)){
  throw new Error(`predecessor metadata is invalid: ${receiptName}`);
 }
 let predecessor;
 const predecessorPath=path.join(backups,`${index/3}.file`);
 if(metadata.existed==='1'){
  const predecessorEvidence=safeFile(
    predecessorPath,`predecessor ${receiptName}`,{
      maximum:16*1024*1024,mode:0o600,
    },
  );
  predecessor={
    action:'restore',
    sourcePath:predecessorPath,
    sha256:sha(predecessorEvidence.body),
    mode:Number.parseInt(metadata.mode,8),
    uid:Number(metadata.uid),
    gid:Number(metadata.gid),
  };
 }else{
  if(fs.lstatSync(predecessorPath,{throwIfNoEntry:false})){
   throw new Error(`unexpected predecessor bytes exist: ${receiptName}`);
  }
  predecessor={action:'remove'};
 }
 targets.push({
  path:targetPath,
  active:{
    sha256:activeSha256,
    mode:activeEvidence.observed.mode&0o7777,
    uid:activeEvidence.observed.uid,
    gid:activeEvidence.observed.gid,
  },
  predecessor,
 });
}
const transactionRoot=path.join(stateRoot,'transactions');
const terminalTransactions=[];
const transactionStat=fs.lstatSync(transactionRoot,{throwIfNoEntry:false});
if(transactionStat){
 if(!transactionStat.isDirectory()||transactionStat.isSymbolicLink()
  ||(testMode!=='1'&&(transactionStat.uid!==0||transactionStat.gid!==0))
  ||transactionStat.mode&0o022){
  throw new Error('legacy transaction root is unsafe');
 }
 for(const entry of fs.readdirSync(transactionRoot,{withFileTypes:true})
   .sort((left,right)=>left.name.localeCompare(right.name))){
  if(!entry.isDirectory()||entry.isSymbolicLink()){
   throw new Error('legacy transaction root contains an unsupported entry');
  }
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
    .test(entry.name)){
   throw new Error('legacy transaction directory identity is invalid');
  }
  const journalPath=path.join(transactionRoot,entry.name,'journal.json');
  const journalEvidence=safeFile(
    journalPath,`legacy terminal journal ${entry.name}`,{
      maximum:2*1024*1024,mode:0o600,
    },
  );
  const journal=JSON.parse(journalEvidence.body);
  if(journal.schema!=='nexus.rollback-drill-legacy-staging-journal.v1'
   ||journal.requestId!==entry.name
   ||!new Set(['completed','recovered']).has(journal.phase)){
   throw new Error(`legacy transaction is not terminal: ${entry.name}`);
  }
  terminalTransactions.push({
    requestId:entry.name,
    phase:journal.phase,
    journalSha256:sha(journalEvidence.body),
  });
 }
}
const plan={
 schema:'nexus.rollback-drill-legacy-staging-phase-a-retirement-plan.v1',
 status:'ready',promotionAllowed:false,
 receipt:{path:receiptPath,sha256:sha(receiptEvidence.body)},
 source:receipt.source,
 control:{version:'nexus-release-promotion-control.v2',
  sha256:sha(controlEvidence.body)},
 recoveryUnit:{
  name:'nexus-rollback-drill-legacy-staging-recovery.service',
  enabledState:recoveryEnabledState,
 },
 installRecoveryUnit:{
  name:'nexus-rollback-drill-legacy-staging-install-recovery.service',
  enabledState:installRecoveryEnabledState,
 },
 retainedDependencies:[{
  path:sqliteHelperPath,
  sha256:sqliteHelperSha256,
  mode:sqliteHelperEvidence.observed.mode&0o7777,
  uid:sqliteHelperEvidence.observed.uid,
  gid:sqliteHelperEvidence.observed.gid,
 }],
 terminal:{
  count:terminalTransactions.length,
  aggregateSha256:sha(Buffer.from(canonical(terminalTransactions))),
 },
 targets,
};
process.stdout.write(`${canonical(plan)}\n`);
NODE
}

ensure_state
case "$COMMAND" in
  install|recover|status|phase-a-retirement-plan) verify_control ;;
esac

case "$COMMAND" in
  recover-journal)
    if [ "$PROFILE_MODE" = v4-prelayout ] \
        && { [ -e "$RETIREMENT_JOURNAL" ] \
          || [ -L "$RETIREMENT_JOURNAL" ] \
          || [ -e "$RETIREMENT_RECEIPT" ] \
          || [ -L "$RETIREMENT_RECEIPT" ]; }; then
      retire_for_layout
    else
      recover_install_journal
    fi
    ;;
  activate-from-phase-a)
    activate_from_phase_a "$1"
    ;;
  retire-for-layout)
    retire_for_layout
    ;;
  phase-a-retirement-plan)
    phase_a_retirement_plan
    ;;
  status)
    verify_sqlite_helper
    validate_receipt
    ;;
  recover)
    source_provenance "$1" "$2" "$3" "$4"
    acquire_locks
    if [ -e "$JOURNAL" ] || [ -L "$JOURNAL" ]; then
      validate_install_journal "$SOURCE_SHA" "$EXPECTED_ARCHIVE_SHA256"
      rollback_install
      printf '%s\n' \
        '{"ok":true,"installed":false,"promotable":false,"status":"recovered_predecessor"}'
    else
      verify_sqlite_helper
      validate_receipt
    fi
    ;;
  uninstall)
    if [ -e "$UNINSTALL_JOURNAL" ] || [ -L "$UNINSTALL_JOURNAL" ]; then
      validate_uninstall_journal
      acquire_successor_locks
      restore_active_adapter
      printf '%s\n' \
        '{"ok":true,"installed":true,"status":"recovered_interrupted_uninstall"}'
      exit 75
    fi
    validate_receipt >/dev/null
    "$BROKER_TARGET" assert-terminal-retirement-ready >/dev/null \
      || die "legacy adapter retirement prerequisites are not satisfied"
    acquire_successor_locks
    begin_uninstall_journal
    UNINSTALL_ACTIVE=true
    MUTATED=true
    trap rollback_uninstall_on_failure EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM
    trap 'exit 129' HUP
    rollback_install
    if [ "$TEST_MODE" != 1 ]; then "$SYSTEMCTL_BIN" daemon-reload; fi
    rm -f -- "$UNINSTALL_JOURNAL"
    fsync_path "$INSTALL_STATE"
    COMPLETE=true
    trap - EXIT INT TERM HUP
    printf '%s\n' \
      '{"ok":true,"installed":false,"status":"retired_to_verified_control_v3"}'
    ;;
  install)
    source_provenance "$1" "$2" "$3" "$4"
    verify_sqlite_helper
    acquire_locks
    if [ -f "$RECEIPT" ] && [ ! -L "$RECEIPT" ]; then
      validate_receipt
      exit 0
    fi
    [ ! -e "$JOURNAL" ] && [ ! -L "$JOURNAL" ] \
      || die "an interrupted adapter installation must be recovered first"
    write_sudoers_source
    begin_install_journal
    MUTATED=true
    trap rollback_on_failure EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM
    trap 'exit 129' HUP

    atomic_install "$INSTALLER_SOURCE" "$INSTALLER_TARGET" 700
    atomic_install "$INSTALL_RECOVERY_UNIT_SOURCE" \
      "$INSTALL_RECOVERY_UNIT_TARGET" 644
    if [ "$TEST_MODE" != 1 ]; then
      "$SYSTEMCTL_BIN" daemon-reload
      "$SYSTEMCTL_BIN" enable \
        "$INSTALL_RECOVERY_UNIT_NAME" \
        >/dev/null
    fi
    verify_install_recovery_anchor
    test_power_loss install_recovery_enabled

    secure_release_parents
    atomic_install "$BROKER_SOURCE" "$BROKER_TARGET" 700
    atomic_install "$ADAPTER_SOURCE" "$ADAPTER_TARGET" 700
    atomic_install "$DEPENDENCY_SOURCE" "$DEPENDENCY_TARGET" 700
    atomic_install "$INSTALLED_ATTESTOR_SOURCE" "$INSTALLED_ATTESTOR_TARGET" 700
    atomic_install "$RECOVERY_ATTESTOR_SOURCE" "$RECOVERY_ATTESTOR_TARGET" 700
    atomic_install "$FILESYSTEM_HELPER_SOURCE" "$FILESYSTEM_HELPER_TARGET" 700
    atomic_install "$PUBLIC_KEY_SOURCE" "$PUBLIC_KEY_TARGET" 644
    atomic_install "$TRANSACTION_UNIT_SOURCE" "$TRANSACTION_UNIT_TARGET" 644
    atomic_install "$RECOVERY_UNIT_SOURCE" "$RECOVERY_UNIT_TARGET" 644
    atomic_install "$PM2_DROP_IN_SOURCE" "$PM2_DOMINGUEZ_DROP_IN_TARGET" 644
    test_power_loss pm2_dominguez_dropin_installed
    atomic_install "$PM2_DROP_IN_SOURCE" "$PM2_ROOT_DROP_IN_TARGET" 644
    test_power_loss pm2_root_dropin_installed
    test_install_failure pm2_root_dropin_installed
    if [ "$PROFILE_MODE" = v4-prelayout ]; then
      atomic_install "$PROMOTION_RECOVERY_DROP_IN_SOURCE" \
        "$PROMOTION_RECOVERY_DROP_IN_TARGET" 644
      test_power_loss promotion_recovery_dropin_installed
    fi
    atomic_install "$SUDOERS_SOURCE" "$SUDOERS_TARGET" 440
    atomic_json_receipt \
      "$RECEIPT" "$SOURCE_SHA" "$EXPECTED_ARCHIVE_SHA256"

    if [ "$TEST_MODE" != 1 ]; then
      "$VISUDO_BIN" -cf "$SUDOERS_TARGET" >/dev/null
      "$SYSTEMCTL_BIN" daemon-reload
      "$SYSTEMCTL_BIN" enable \
        "$RECOVERY_UNIT_NAME" >/dev/null
      [ "$("$BROKER_TARGET" version)" \
          = "$EXPECTED_BROKER_VERSION" ] \
        || die "installed broker identity is invalid"
    fi
    validate_receipt >/dev/null
    rm -f -- "$JOURNAL"
    fsync_path "$INSTALL_STATE"
    COMPLETE=true
    trap - EXIT INT TERM HUP
    printf '{"ok":true,"installed":true,"promotable":false,"sourceSha":"%s","archiveSha256":"%s"}\n' \
      "$SOURCE_SHA" "$EXPECTED_ARCHIVE_SHA256"
    ;;
esac
