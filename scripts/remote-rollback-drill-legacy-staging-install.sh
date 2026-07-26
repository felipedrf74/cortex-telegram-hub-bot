#!/usr/bin/env bash
# Transactional installer for the non-promotable control-v2 legacy staging
# drill adapter. It accepts only a root-owned, SHA-bound bootstrap source and
# proves every privileged input against the Git archive before installation.
set -euo pipefail
umask 077
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH

COMMAND="${1:-}"
[ "$#" -gt 0 ] && shift
TEST_MODE="${NEXUS_LEGACY_DRILL_INSTALL_TEST_MODE:-0}"
if [ "$TEST_MODE" = 1 ] && [ "$EUID" -eq 0 ]; then
  echo "legacy staging drill installer: test mode may not cross a privileged uid boundary" >&2
  exit 77
fi

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
  sudo <reviewed-installer>/remote-rollback-drill-legacy-staging-install.sh uninstall
  sudo <reviewed-installer>/remote-rollback-drill-legacy-staging-install.sh \
    phase-a-retirement-plan
  sudo <sha-bound-source>/scripts/remote-rollback-drill-legacy-staging-install.sh status
EOF
}

case "$COMMAND" in
  install|recover) [ "$#" -eq 4 ] || { usage >&2; exit 64; } ;;
  recover-journal|status|uninstall|phase-a-retirement-plan)
    [ "$#" -eq 0 ] || { usage >&2; exit 64; }
    ;;
  *) usage >&2; exit 64 ;;
esac

if [ "$TEST_MODE" != 1 ]; then
  [ "$EUID" -eq 0 ] || {
    echo "legacy staging drill installer must run as root" >&2
    exit 77
  }
fi

BOOTSTRAP_BASE="${NEXUS_LEGACY_DRILL_BOOTSTRAP_BASE:-/var/lib/nexus-release-bootstrap}"
STATE_ROOT="${NEXUS_LEGACY_DRILL_STATE_ROOT:-/var/lib/nexus-rollback-drill-legacy-staging}"
INSTALL_STATE="$STATE_ROOT/install"
JOURNAL="$INSTALL_STATE/install-in-progress.v1.json"
BACKUPS="$INSTALL_STATE/predecessor"
UNINSTALL_JOURNAL="$INSTALL_STATE/uninstall-in-progress.v1.json"
UNINSTALL_BACKUPS="$INSTALL_STATE/active-adapter"
RECEIPT="$STATE_ROOT/install-receipt.v1.json"
CONTROL_BIN="${NEXUS_LEGACY_DRILL_CONTROL_BIN:-/usr/local/sbin/nexus-release-promotion-control}"
EXPECTED_CONTROL_SHA256="${NEXUS_LEGACY_DRILL_EXPECTED_CONTROL_SHA256:-fb66d9257ec0b7b6f2c582d326c5ed3f6c01071f5792a4045c42199b6691edf1}"
EXPECTED_SQLITE_HELPER_SHA256="${NEXUS_LEGACY_DRILL_EXPECTED_SQLITE_HELPER_SHA256:-e1f1a92d4dc49bd6fe6c1d8c1a3573ec2db61f6374a1831b2765a5541943708d}"
NODE_BIN="${NEXUS_LEGACY_DRILL_NODE_BIN:-/usr/bin/node}"
SYSTEMCTL_BIN="${NEXUS_LEGACY_DRILL_SYSTEMCTL_BIN:-/usr/bin/systemctl}"
VISUDO_BIN="${NEXUS_LEGACY_DRILL_VISUDO_BIN:-/usr/sbin/visudo}"
FLOCK_BIN="${NEXUS_LEGACY_DRILL_FLOCK_BIN:-/usr/bin/flock}"
PROMOTION_STATE_ROOT="${NEXUS_PROMOTION_STATE_ROOT:-/var/lib/nexus-release-promotion}"
CONTROL_LOCK="$PROMOTION_STATE_ROOT/.control.lock"
SONAR_LOCK="${NEXUS_LEGACY_DRILL_SONAR_LOCK:-/run/lock/nexus-release-sonar.lock}"
WORKER_USER="${NEXUS_LEGACY_DRILL_WORKER_USER:-dominguez}"
TARGET_ROOT="${NEXUS_LEGACY_DRILL_INSTALL_TARGET_ROOT:-}"
MUTATED=false
COMPLETE=false
UNINSTALL_ACTIVE=false

target() {
  if [ "$TEST_MODE" = 1 ]; then
    [ -n "$TARGET_ROOT" ] || die "test target root is required"
    printf '%s%s' "$TARGET_ROOT" "$1"
  else
    printf '%s' "$1"
  fi
}

INSTALLER_TARGET="$(target /usr/local/sbin/nexus-rollback-drill-legacy-staging-install)"
INSTALL_RECOVERY_UNIT_TARGET="$(target /etc/systemd/system/nexus-rollback-drill-legacy-staging-install-recovery.service)"
BROKER_TARGET="$(target /usr/local/sbin/nexus-rollback-drill-legacy-staging-broker)"
ADAPTER_TARGET="$(target /usr/local/libexec/nexus-rollback-drill-legacy-staging-adapter.mjs)"
DEPENDENCY_TARGET="$(target /usr/local/libexec/nexus-release-runtime-dependencies.mjs)"
INSTALLED_ATTESTOR_TARGET="$(target /usr/local/libexec/nexus-release-installed-tree-attestation.mjs)"
RECOVERY_ATTESTOR_TARGET="$(target /usr/local/libexec/nexus-release-recovery-runtime-identity.mjs)"
PUBLIC_KEY_TARGET="$(target /etc/nexus-release/release-evidence-public-key.pem)"
TRANSACTION_UNIT_TARGET="$(target /etc/systemd/system/nexus-rollback-drill-legacy-staging@.service)"
RECOVERY_UNIT_TARGET="$(target /etc/systemd/system/nexus-rollback-drill-legacy-staging-recovery.service)"
PM2_DOMINGUEZ_DROP_IN_TARGET="$(target /etc/systemd/system/pm2-dominguez.service.d/10-nexus-rollback-drill-legacy-staging-recovery.conf)"
PM2_ROOT_DROP_IN_TARGET="$(target /etc/systemd/system/pm2-root.service.d/10-nexus-rollback-drill-legacy-staging-recovery.conf)"
SUDOERS_TARGET="$(target /etc/sudoers.d/nexus-rollback-drill-legacy-staging)"
SQLITE_HELPER_TARGET="$(target /usr/local/libexec/nexus-application-dr/application-dr-sqlite.py)"
FILESYSTEM_HELPER_TARGET="$(target /usr/local/libexec/nexus-rollback-drill-legacy-staging-fs.py)"
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
  [ "$EXPECTED_CONTROL_SHA256" = fb66d9257ec0b7b6f2c582d326c5ed3f6c01071f5792a4045c42199b6691edf1 ] \
    || die "production promotion-control digest may not be overridden"
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
    "$EXPECTED_CONTROL_SHA256" \
    "$INSTALLER_TARGET" "$INSTALL_RECOVERY_UNIT_TARGET" \
    "$BROKER_TARGET" "$ADAPTER_TARGET" "$DEPENDENCY_TARGET" \
    "$INSTALLED_ATTESTOR_TARGET" "$RECOVERY_ATTESTOR_TARGET" \
    "$PUBLIC_KEY_TARGET" "$TRANSACTION_UNIT_TARGET" "$RECOVERY_UNIT_TARGET" \
    "$PM2_DOMINGUEZ_DROP_IN_TARGET" "$PM2_ROOT_DROP_IN_TARGET" \
    "$SUDOERS_TARGET" "$SQLITE_HELPER_TARGET" \
    "$FILESYSTEM_HELPER_TARGET" <<'NODE'
const crypto=require('node:crypto');const fs=require('node:fs');
const [output,sourceSha,archiveSha256,controlSha256,installer,
 installRecoveryUnit,broker,adapter,
 dependencies,installedAttestor,recoveryAttestor,releasePublicKey,
 transactionUnit,recoveryUnit,pm2DominguezDropIn,pm2RootDropIn,sudoers,
 sqliteTool,filesystemHelper]=process.argv.slice(2);
const digest=(file)=>crypto.createHash('sha256')
 .update(fs.readFileSync(file)).digest('hex');
const value={
 schema:'nexus.rollback-drill-legacy-staging-install-receipt.v1',
 status:'active',promotionAllowed:false,
 source:{sourceSha,archiveSha256},
 control:{version:'nexus-release-promotion-control.v2',sha256:controlSha256},
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
  INSTALL_RECOVERY_UNIT_SOURCE="$SOURCE_ROOT/scripts/systemd/nexus-rollback-drill-legacy-staging-install-recovery.service"
  BROKER_SOURCE="$SOURCE_ROOT/scripts/remote-rollback-drill-legacy-staging-broker.sh"
  ADAPTER_SOURCE="$SOURCE_ROOT/scripts/rollback-drill-legacy-staging-adapter.mjs"
  DEPENDENCY_SOURCE="$SOURCE_ROOT/scripts/release-runtime-dependencies.mjs"
  INSTALLED_ATTESTOR_SOURCE="$SOURCE_ROOT/scripts/release-installed-tree-attestation.mjs"
  RECOVERY_ATTESTOR_SOURCE="$SOURCE_ROOT/scripts/release-recovery-runtime-identity.mjs"
  SQLITE_HELPER_SOURCE="$SOURCE_ROOT/scripts/application-dr-sqlite.py"
  FILESYSTEM_HELPER_SOURCE="$SOURCE_ROOT/scripts/rollback-drill-legacy-staging-fs.py"
  TRANSACTION_UNIT_SOURCE="$SOURCE_ROOT/scripts/systemd/nexus-rollback-drill-legacy-staging@.service"
  RECOVERY_UNIT_SOURCE="$SOURCE_ROOT/scripts/systemd/nexus-rollback-drill-legacy-staging-recovery.service"
  PM2_DROP_IN_SOURCE="$SOURCE_ROOT/scripts/systemd/10-nexus-rollback-drill-legacy-staging-recovery.conf"
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
  for source in "${REQUIRED_SOURCES[@]}"; do
    assert_regular "$source" "SHA-bound privileged source"
  done
  [ "$(canonical_path "$0")" = "$INSTALLER_SOURCE" ] \
    || die "installer must execute from the exact SHA-bound source"
  [ "$(sha256_file "$SQLITE_HELPER_SOURCE")" = "$EXPECTED_SQLITE_HELPER_SHA256" ] \
    || die "SHA-bound SQLite helper differs from the reviewed identity"

  python3 - "$SOURCE_ARCHIVE" "$SOURCE_ROOT" "$SOURCE_SHA" <<'PY'
import hashlib
import pathlib
import sys
import tarfile

archive_path, source_root_raw, source_sha = sys.argv[1:]
source_root = pathlib.Path(source_root_raw)
required = (
    "scripts/remote-rollback-drill-legacy-staging-install.sh",
    "scripts/systemd/nexus-rollback-drill-legacy-staging-install-recovery.service",
    "scripts/remote-rollback-drill-legacy-staging-broker.sh",
    "scripts/rollback-drill-legacy-staging-adapter.mjs",
    "scripts/release-runtime-dependencies.mjs",
    "scripts/release-installed-tree-attestation.mjs",
    "scripts/release-recovery-runtime-identity.mjs",
    "scripts/application-dr-sqlite.py",
    "scripts/rollback-drill-legacy-staging-fs.py",
    "scripts/systemd/nexus-rollback-drill-legacy-staging@.service",
    "scripts/systemd/nexus-rollback-drill-legacy-staging-recovery.service",
    "scripts/systemd/10-nexus-rollback-drill-legacy-staging-recovery.conf",
    "docs/release/evidence/release-evidence-public-key.pem",
)
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
  exec /bin/bash "$exact_installer" recover \
    "$source_root" "$INSTALL_JOURNAL_SOURCE_SHA" \
    "$source_archive" "$INSTALL_JOURNAL_ARCHIVE_SHA256"
}

verify_control() {
  [ "$(sha256_file "$CONTROL_BIN")" = "$EXPECTED_CONTROL_SHA256" ] \
    && [ "$("$CONTROL_BIN" version)" = nexus-release-promotion-control.v2 ] \
    || {
      echo "exact installed promotion control v2 is required" >&2
      exit 75
    }
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
      nexus-rollback-drill-legacy-staging-install-recovery.service \
      2>/dev/null || true
  )"
  [ "$enabled_state" = enabled ] \
    || die "install recovery anchor is not durably enabled"
  properties="$(
    "$SYSTEMCTL_BIN" show --no-pager \
      nexus-rollback-drill-legacy-staging-install-recovery.service \
      -p User -p Group -p ExecStart -p Before
  )"
  "$NODE_BIN" - "$properties" <<'NODE'
const body=process.argv[2];const properties={};
for(const line of body.split(/\n/u)){
 if(!line)continue;
 const separator=line.indexOf('=');
 if(separator<1||Object.hasOwn(properties,line.slice(0,separator)))process.exit(1);
 properties[line.slice(0,separator)]=line.slice(separator+1);
}
const before=new Set((properties.Before??'').split(/\s+/u).filter(Boolean));
if(properties.User!=='root'||properties.Group!=='root'
 ||!properties.ExecStart?.includes(
  '/usr/local/sbin/nexus-rollback-drill-legacy-staging-install recover-journal',
 )
 ||![
  'nexus-rollback-drill-legacy-staging-recovery.service',
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

acquire_locks() {
  local worker_gid
  verify_control
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
  cat >"$SUDOERS_SOURCE" <<'EOF'
dominguez ALL=(root) NOPASSWD: NOSETENV: /usr/local/sbin/nexus-rollback-drill-legacy-staging-broker version
dominguez ALL=(root) NOPASSWD: NOSETENV: /usr/local/sbin/nexus-rollback-drill-legacy-staging-broker inspect
dominguez ALL=(root) NOPASSWD: NOSETENV: /usr/local/sbin/nexus-rollback-drill-legacy-staging-broker prepare *
dominguez ALL=(root) NOPASSWD: NOSETENV: /usr/local/sbin/nexus-rollback-drill-legacy-staging-broker launch *
dominguez ALL=(root) NOPASSWD: NOSETENV: /usr/local/sbin/nexus-rollback-drill-legacy-staging-broker status *
dominguez ALL=(root) NOPASSWD: NOSETENV: /usr/local/sbin/nexus-rollback-drill-legacy-staging-broker fetch-evidence *
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
        nexus-rollback-drill-legacy-staging-recovery.service \
        "$RECOVERY_UNIT_TARGET"
    )"
    install_recovery_enabled_state="$(
      capture_recovery_unit_state \
        nexus-rollback-drill-legacy-staging-install-recovery.service \
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
            nexus-rollback-drill-legacy-staging-recovery.service \
            "$RECOVERY_UNIT_TARGET"
          ;;
        "$INSTALL_RECOVERY_UNIT_TARGET")
          disable_recovery_unit_if_present \
            nexus-rollback-drill-legacy-staging-install-recovery.service \
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
      nexus-rollback-drill-legacy-staging-recovery.service \
      "$RECOVERY_UNIT_TARGET" "$enabled_state"
    restore_recovery_unit_state \
      nexus-rollback-drill-legacy-staging-install-recovery.service \
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
  "$NODE_BIN" - "$RECEIPT" "$EXPECTED_CONTROL_SHA256" \
    "$INSTALLER_TARGET" "$INSTALL_RECOVERY_UNIT_TARGET" \
    "$BROKER_TARGET" "$ADAPTER_TARGET" "$DEPENDENCY_TARGET" \
    "$INSTALLED_ATTESTOR_TARGET" "$RECOVERY_ATTESTOR_TARGET" \
    "$PUBLIC_KEY_TARGET" "$TRANSACTION_UNIT_TARGET" "$RECOVERY_UNIT_TARGET" \
    "$PM2_DOMINGUEZ_DROP_IN_TARGET" "$PM2_ROOT_DROP_IN_TARGET" \
    "$SUDOERS_TARGET" "$SQLITE_HELPER_TARGET" \
    "$FILESYSTEM_HELPER_TARGET" <<'NODE'
const crypto=require('node:crypto');const fs=require('node:fs');
const [receiptFile,controlSha256,installer,installRecoveryUnit,
 broker,adapter,dependencies,installedAttestor,
 recoveryAttestor,releasePublicKey,transactionUnit,recoveryUnit,
 pm2DominguezDropIn,pm2RootDropIn,sudoers,sqliteTool,filesystemHelper]
 =process.argv.slice(2);
const receipt=JSON.parse(fs.readFileSync(receiptFile));
const digest=(file)=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const files={installer,installRecoveryUnit,broker,adapter,dependencies,
 installedAttestor,recoveryAttestor,
 releasePublicKey,transactionUnit,recoveryUnit,pm2DominguezDropIn,
 pm2RootDropIn,sudoers,sqliteTool,filesystemHelper};
if(receipt.schema!=='nexus.rollback-drill-legacy-staging-install-receipt.v1'
 ||receipt.status!=='active'||receipt.promotionAllowed!==false
 ||receipt.control?.version!=='nexus-release-promotion-control.v2'
 ||receipt.control?.sha256!==controlSha256)process.exit(1);
for(const [name,file] of Object.entries(files)){
 const stat=fs.lstatSync(file);
 if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1
  ||receipt.installed?.[name]!==digest(file))process.exit(1);
}
process.stdout.write(`${JSON.stringify({
 ok:true,installed:true,promotable:false,sourceSha:receipt.source.sourceSha,
 archiveSha256:receipt.source.archiveSha256,installedAt:receipt.installedAt,
})}\n`);
NODE
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
    recover_install_journal
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
        nexus-rollback-drill-legacy-staging-install-recovery.service \
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
    atomic_install "$SUDOERS_SOURCE" "$SUDOERS_TARGET" 440
    atomic_json_receipt \
      "$RECEIPT" "$SOURCE_SHA" "$EXPECTED_ARCHIVE_SHA256"

    if [ "$TEST_MODE" != 1 ]; then
      "$VISUDO_BIN" -cf "$SUDOERS_TARGET" >/dev/null
      "$SYSTEMCTL_BIN" daemon-reload
      "$SYSTEMCTL_BIN" enable \
        nexus-rollback-drill-legacy-staging-recovery.service >/dev/null
      [ "$("$BROKER_TARGET" version)" \
          = nexus-rollback-drill-legacy-staging-broker.v1 ] \
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
