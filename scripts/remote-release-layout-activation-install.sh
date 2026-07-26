#!/usr/bin/env bash
# Two-phase installer for the one-time release-layout activation.
#
# Phase A installs only the root-owned transaction/recovery machinery. It
# snapshots the effective PM2 and ingress units before and after installation
# and refuses to publish its receipt unless both identities are byte-for-byte
# unchanged. Phase B is a separate, reversible handover which is permitted
# only after the signed layout transaction has completed successfully.
set -euo pipefail
umask 077
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH

VERSION=nexus-release-layout-activation-install.v1
COMMAND="${1:-}"
[ "$#" -gt 0 ] && shift
BOOTSTRAP_BASE="${NEXUS_LAYOUT_BOOTSTRAP_BASE:-/var/lib/nexus-release-bootstrap}"
STATE_ROOT="${NEXUS_PROMOTION_STATE_ROOT:-/var/lib/nexus-release-promotion}"
ACTIVATION_ROOT="${NEXUS_LAYOUT_ACTIVATION_ROOT:-$STATE_ROOT/layout-activation}"
PHASE_A_RECEIPT="$ACTIVATION_ROOT/phase-a-receipt.v1.json"
PHASE_A_JOURNAL="$ACTIVATION_ROOT/phase-a-install-in-progress.v1.json"
PHASE_A_RECOVERY_FAILED="$ACTIVATION_ROOT/phase-a-recovery-failed.v1.json"
PHASE_A_ROLLBACK_RECEIPT="$ACTIVATION_ROOT/phase-a-rollback-receipt.v1.json"
PHASE_B_JOURNAL="$ACTIVATION_ROOT/phase-b-handover-in-progress.v1.json"
PHASE_B_RECEIPT="$ACTIVATION_ROOT/phase-b-receipt.v1.json"
LAYOUT_ATTESTATION="$STATE_ROOT/layout-migration.v1.json"
SYSTEMCTL_BIN="${NEXUS_LAYOUT_SYSTEMCTL_BIN:-/usr/bin/systemctl}"
FLOCK_BIN="${NEXUS_LAYOUT_FLOCK_BIN:-/usr/bin/flock}"
NODE_BIN="${NEXUS_LAYOUT_NODE_BIN:-/usr/bin/node}"
PYTHON_BIN="${NEXUS_LAYOUT_PYTHON_BIN:-/usr/bin/python3}"
PROMOTION_CONTROL="${NEXUS_LAYOUT_PROMOTION_CONTROL:-/usr/local/sbin/nexus-release-promotion-control}"
WORKER_USER="${NEXUS_PROMOTION_WORKER_USER:-dominguez}"
SUDOERS_TARGET="${NEXUS_LAYOUT_SUDOERS_TARGET:-/etc/sudoers.d/nexus-release-layout-activation}"
PM2_DROPIN="${NEXUS_LAYOUT_PM2_DROPIN:-/etc/systemd/system/pm2-dominguez.service.d/nexus-release-recovery.conf}"
INGRESS_DROPIN="${NEXUS_LAYOUT_INGRESS_DROPIN:-/etc/systemd/system/nexus-cloudflared.service.d/nexus-release-ready.conf}"
INSTALLER_TARGET="${NEXUS_LAYOUT_INSTALLER_TARGET:-/usr/local/sbin/nexus-release-layout-activation-install}"
CONTROL_TARGET="${NEXUS_LAYOUT_CONTROL_TARGET:-/usr/local/sbin/nexus-release-layout-activation-control}"
MIGRATE_TARGET="${NEXUS_LAYOUT_MIGRATE_TARGET:-/usr/local/sbin/nexus-release-layout-migrate}"
SQLITE_TARGET="${NEXUS_LAYOUT_SQLITE_TARGET:-/usr/local/libexec/nexus-release-layout-sqlite.py}"
AUTH_TARGET="${NEXUS_LAYOUT_AUTH_TARGET:-/usr/local/libexec/nexus-release-layout-authorization.mjs}"
DRILL_VERIFY_TARGET="${NEXUS_LAYOUT_DRILL_VERIFY_TARGET:-/usr/local/libexec/nexus-release-layout-fault-drill.mjs}"
ATTESTOR_TARGET="${NEXUS_LAYOUT_ATTESTOR_TARGET:-/usr/local/libexec/nexus-trusted-release-runtime-attestation.mjs}"
SELECTOR_TARGET="${NEXUS_LAYOUT_SELECTOR_TARGET:-/usr/local/libexec/nexus-release-selector-switch.py}"
PREFLIGHT_TARGET="${NEXUS_LAYOUT_PREFLIGHT_TARGET:-/usr/local/libexec/nexus-release-layout-preflight.sh}"
PROMOTION_CONTROL_TARGET="${NEXUS_LAYOUT_PROMOTION_CONTROL_TARGET:-/usr/local/sbin/nexus-release-promotion-control}"
FILESYSTEM_IDENTITY_TARGET="${NEXUS_LAYOUT_FILESYSTEM_IDENTITY_TARGET:-/usr/local/libexec/nexus-trusted-release-filesystem-identity.mjs}"
STAGING_BROKER_TARGET="${NEXUS_LAYOUT_STAGING_BROKER_TARGET:-/usr/local/libexec/nexus-staging-attestation-broker.sh}"
PM2_CAPTURE_AUTHORITY_TARGET="${NEXUS_LAYOUT_PM2_CAPTURE_AUTHORITY_TARGET:-/usr/local/libexec/nexus-capture-pm2-dump-authority.mjs}"
PM2_DUMP_AUTHORITY_TARGET="${NEXUS_LAYOUT_PM2_DUMP_AUTHORITY_TARGET:-/usr/local/libexec/nexus-pm2-dump-authority.py}"
BOOT_HEALTH_TARGET="${NEXUS_LAYOUT_BOOT_HEALTH_TARGET:-/usr/local/sbin/nexus-release-boot-health}"
PM2_RECOVERY_UNIT_TARGET="${NEXUS_LAYOUT_PM2_RECOVERY_UNIT_TARGET:-/etc/systemd/system/nexus-release-pm2-recovery-daemon.service}"
PROMOTION_RECOVERY_UNIT_TARGET="${NEXUS_LAYOUT_PROMOTION_RECOVERY_UNIT_TARGET:-/etc/systemd/system/nexus-release-promotion-recovery.service}"
ACTIVATION_UNIT_TARGET="${NEXUS_LAYOUT_ACTIVATION_UNIT_TARGET:-/etc/systemd/system/nexus-release-layout-activation@.service}"
LAYOUT_RECOVERY_UNIT_TARGET="${NEXUS_LAYOUT_RECOVERY_UNIT_TARGET:-/etc/systemd/system/nexus-release-layout-recovery.service}"
INSTALL_RECOVERY_UNIT_TARGET="${NEXUS_LAYOUT_INSTALL_RECOVERY_UNIT_TARGET:-/etc/systemd/system/nexus-release-layout-install-recovery.service}"
INSTALL_GUARD_TARGET="${NEXUS_LAYOUT_INSTALL_GUARD_TARGET:-/etc/systemd/system/pm2-dominguez.service.d/00-nexus-release-layout-install-recovery.conf}"
PM2_PREREQUISITE_CONTROL="${NEXUS_LAYOUT_PM2_PREREQUISITE_CONTROL:-}"
LEGACY_STATE_ROOT="${NEXUS_LEGACY_DRILL_STATE_ROOT:-/var/lib/nexus-rollback-drill-legacy-staging}"
LEGACY_RECEIPT="${NEXUS_LEGACY_DRILL_INSTALL_RECEIPT:-$LEGACY_STATE_ROOT/install-receipt.v1.json}"
LEGACY_RETIRED_RECEIPT="${NEXUS_LEGACY_DRILL_RETIRED_RECEIPT:-$LEGACY_STATE_ROOT/install-receipt.retired.v1.json}"
LEGACY_INSTALL_JOURNAL="$LEGACY_STATE_ROOT/install/install-in-progress.v1.json"
LEGACY_UNINSTALL_JOURNAL="$LEGACY_STATE_ROOT/install/uninstall-in-progress.v1.json"
LEGACY_PM2_DOMINGUEZ_DROPIN="${NEXUS_LEGACY_DRILL_PM2_DOMINGUEZ_DROPIN:-/etc/systemd/system/pm2-dominguez.service.d/10-nexus-rollback-drill-legacy-staging-recovery.conf}"
LEGACY_PM2_ROOT_DROPIN="${NEXUS_LEGACY_DRILL_PM2_ROOT_DROPIN:-/etc/systemd/system/pm2-root.service.d/10-nexus-rollback-drill-legacy-staging-recovery.conf}"
LEGACY_TARGET_ROOT="${NEXUS_LEGACY_DRILL_INSTALL_TARGET_ROOT:-}"
CONTROL_LOCK="${NEXUS_LAYOUT_CONTROL_LOCK:-$STATE_ROOT/.control.lock}"
RELEASE_SONAR_LOCK="${NEXUS_RELEASE_MUTEX:-/run/lock/nexus-release-sonar.lock}"
legacy_target() {
  printf '%s%s' "$LEGACY_TARGET_ROOT" "$1"
}
LEGACY_RETIREMENT_ALLOWLIST=(
  "$(legacy_target /usr/local/sbin/nexus-rollback-drill-legacy-staging-install)"
  "$(legacy_target /etc/systemd/system/nexus-rollback-drill-legacy-staging-install-recovery.service)"
  "$(legacy_target /usr/local/sbin/nexus-rollback-drill-legacy-staging-broker)"
  "$(legacy_target /usr/local/libexec/nexus-rollback-drill-legacy-staging-adapter.mjs)"
  "$(legacy_target /usr/local/libexec/nexus-release-runtime-dependencies.mjs)"
  "$(legacy_target /usr/local/libexec/nexus-release-installed-tree-attestation.mjs)"
  "$(legacy_target /usr/local/libexec/nexus-release-recovery-runtime-identity.mjs)"
  "$(legacy_target /etc/nexus-release/release-evidence-public-key.pem)"
  "$(legacy_target /etc/systemd/system/nexus-rollback-drill-legacy-staging@.service)"
  "$(legacy_target /etc/systemd/system/nexus-rollback-drill-legacy-staging-recovery.service)"
  "$LEGACY_PM2_DOMINGUEZ_DROPIN"
  "$LEGACY_PM2_ROOT_DROPIN"
  "$(legacy_target /etc/sudoers.d/nexus-rollback-drill-legacy-staging)"
  "$(legacy_target /usr/local/libexec/nexus-rollback-drill-legacy-staging-fs.py)"
)
LEGACY_RETAINED_SQLITE_HELPER="$(
  legacy_target /usr/local/libexec/nexus-application-dr/application-dr-sqlite.py
)"
PHASE_A_TARGETS=(
  "$INSTALL_GUARD_TARGET"
  "$INSTALLER_TARGET"
  "$CONTROL_TARGET"
  "$MIGRATE_TARGET"
  "$SQLITE_TARGET"
  "$AUTH_TARGET"
  "$DRILL_VERIFY_TARGET"
  "$ATTESTOR_TARGET"
  "$SELECTOR_TARGET"
  "$PREFLIGHT_TARGET"
  "$PROMOTION_CONTROL_TARGET"
  "$FILESYSTEM_IDENTITY_TARGET"
  "$STAGING_BROKER_TARGET"
  "$PM2_CAPTURE_AUTHORITY_TARGET"
  "$PM2_DUMP_AUTHORITY_TARGET"
  "$BOOT_HEALTH_TARGET"
  "$PM2_RECOVERY_UNIT_TARGET"
  "$PROMOTION_RECOVERY_UNIT_TARGET"
  "$ACTIVATION_UNIT_TARGET"
  "$LAYOUT_RECOVERY_UNIT_TARGET"
  "$INSTALL_RECOVERY_UNIT_TARGET"
  "$SUDOERS_TARGET"
  "$PHASE_A_RECEIPT"
  "$LEGACY_RECEIPT"
  "$LEGACY_RETIRED_RECEIPT"
)

die() {
  echo "release layout activation install: $*" >&2
  exit 1
}

if [ "${NEXUS_RELEASE_TEST_MODE:-0}" != 1 ] && [ -n "$LEGACY_TARGET_ROOT" ]; then
  die "legacy retirement target root may only be overridden in test mode"
fi

usage() {
  printf '%s\n' \
    "Usage: $0 phase-a <source-root> <protected-main-sha> <source-archive> <archive-sha256>" \
    "       $0 phase-b <source-root> <protected-main-sha> <source-archive> <archive-sha256> <layout-attestation-sha256>" \
    "       $0 recover-phase-a" \
    "       $0 assert-phase-a-safe" \
    "       $0 recover-handover" \
    "       $0 status"
}

[ "$EUID" -eq 0 ] || [ "${NEXUS_RELEASE_TEST_MODE:-0}" = 1 ] || {
  echo "release layout activation install must run as root" >&2
  exit 77
}
[ "${NEXUS_RELEASE_TEST_MODE:-0}" != 1 ] || [ "$EUID" -ne 0 ] || {
  echo "release layout activation test mode is prohibited for root" >&2
  exit 77
}

for command in /bin/bash "$NODE_BIN" "$PYTHON_BIN" "$SYSTEMCTL_BIN" \
  "$FLOCK_BIN" install mktemp realpath sha256sum stat visudo; do
  [ -x "$command" ] || command -v "$command" >/dev/null 2>&1 \
    || die "required executable is unavailable: $command"
done

fsync_path() {
  if [ "${NEXUS_RELEASE_TEST_MODE:-0}" = 1 ] \
      && [ "${NEXUS_LAYOUT_TEST_FAIL_FSYNC_PATH:-}" = "$1" ]; then
    return 97
  fi
  "$NODE_BIN" - "$1" <<'NODE'
const fs=require('fs');const descriptor=fs.openSync(process.argv[2],'r');
try{fs.fsyncSync(descriptor);}finally{fs.closeSync(descriptor);}
NODE
}

replace_file() {
  "$NODE_BIN" - "$1" "$2" <<'NODE'
const fs=require('fs');const [source,target]=process.argv.slice(2);
const sourceStat=fs.lstatSync(source);
const targetStat=fs.lstatSync(target,{throwIfNoEntry:false});
if(!sourceStat.isFile()||sourceStat.isSymbolicLink()||sourceStat.nlink!==1
 ||targetStat?.isDirectory())process.exit(1);
fs.renameSync(source,target);
NODE
}

acquire_phase_locks() {
  if [ "${NEXUS_RELEASE_TEST_MODE:-0}" = 1 ]; then
    install -d -m 700 "$(dirname -- "$CONTROL_LOCK")" \
      "$(dirname -- "$RELEASE_SONAR_LOCK")"
    [ -e "$CONTROL_LOCK" ] || : >"$CONTROL_LOCK"
    [ -e "$RELEASE_SONAR_LOCK" ] || : >"$RELEASE_SONAR_LOCK"
  fi
  [ -f "$CONTROL_LOCK" ] && [ ! -L "$CONTROL_LOCK" ] \
    || die "promotion control lock is unavailable"
  [ -f "$RELEASE_SONAR_LOCK" ] && [ ! -L "$RELEASE_SONAR_LOCK" ] \
    || die "shared release/Sonar lock is unavailable"
  exec 7>"$CONTROL_LOCK"
  "$FLOCK_BIN" -x 7
  exec 8>"$RELEASE_SONAR_LOCK"
  "$FLOCK_BIN" -x 8
}

unit_enablement_state() {
  local unit="$1" observed status=0
  if observed="$("$SYSTEMCTL_BIN" is-enabled "$unit" 2>/dev/null)"; then
    status=0
  else
    status=$?
  fi
  [ -n "$observed" ] \
    || die "unit enablement state could not be observed: $unit"
  case "$observed" in
    enabled|enabled-runtime)
      [ "$status" -eq 0 ] \
        || die "enabled unit returned a failing status: $unit"
      printf '%s\n' "$observed"
      ;;
    disabled|not-found)
      [ "$status" -ne 0 ] \
        || die "disabled or absent unit returned a successful status: $unit"
      printf '%s\n' "$observed"
      ;;
    *)
      die "unit enablement state cannot be restored exactly: $unit ($observed)"
      ;;
  esac
}

recovery_anchor_enablement_state() {
  local unit="$1" observed
  observed="$(unit_enablement_state "$unit")"
  # The Phase A boot unit is intentionally retained as a recovery anchor. If
  # it did not exist before Phase A, its exact safe post-rollback state is an
  # installed but disabled unit rather than the now-impossible "not-found".
  [ "$observed" != not-found ] || observed=disabled
  printf '%s\n' "$observed"
}

restore_unit_enablement_state() {
  local unit="$1" expected="$2" observed
  case "$expected" in
    enabled)
      "$SYSTEMCTL_BIN" enable "$unit" >/dev/null
      ;;
    enabled-runtime)
      "$SYSTEMCTL_BIN" enable --runtime "$unit" >/dev/null
      ;;
    disabled)
      "$SYSTEMCTL_BIN" disable "$unit" >/dev/null
      ;;
    not-found)
      # The snapshotted unit file was absent and file restoration already
      # removed it. Running disable here could hide an unexpected file.
      ;;
    *)
      die "journaled unit enablement state is not restorable: $unit ($expected)"
      ;;
  esac
  observed="$(unit_enablement_state "$unit")"
  [ "$observed" = "$expected" ] \
    || die "unit enablement state differs after recovery: $unit ($observed != $expected)"
}

assert_legacy_terminal_journals() {
  local transactions="$LEGACY_STATE_ROOT/transactions"
  [ -e "$transactions" ] || [ -L "$transactions" ] || return 0
  [ -d "$transactions" ] && [ ! -L "$transactions" ] \
    || die "legacy adapter transaction root is unsafe"
  "$NODE_BIN" - "$transactions" <<'NODE'
const fs=require('fs');const path=require('path');const root=process.argv[2];
for(const entry of fs.readdirSync(root,{withFileTypes:true})){
 if(!entry.isDirectory())continue;
 const journal=path.join(root,entry.name,'journal.json');
 if(!fs.existsSync(journal))continue;
 const value=JSON.parse(fs.readFileSync(journal));
 if(!new Set(['completed','recovered']).has(value.phase))process.exit(1);
}
NODE
}

assert_legacy_install_state_safe() {
  local journal
  for journal in "$LEGACY_INSTALL_JOURNAL" "$LEGACY_UNINSTALL_JOURNAL"; do
    [ ! -e "$journal" ] && [ ! -L "$journal" ] \
      || die "legacy adapter install recovery must complete before layout activation"
  done
}

root_own() {
  [ "${NEXUS_RELEASE_TEST_MODE:-0}" = 1 ] || chown root:root "$@"
}

ensure_directory() {
  local target="$1" mode="$2"
  if [ -L "$target" ] || { [ -e "$target" ] && [ ! -d "$target" ]; }; then
    die "required directory is unsafe: $target"
  fi
  if [ ! -d "$target" ]; then
    install -d -m "$mode" -- "$target"
    root_own "$target"
    fsync_path "$(dirname -- "$target")"
  fi
  [ "$(stat -c '%a' -- "$target")" = "$mode" ] \
    || die "required directory mode is unsafe: $target"
  if [ "${NEXUS_RELEASE_TEST_MODE:-0}" != 1 ]; then
    [ "$(stat -c '%U:%G' -- "$target")" = root:root ] \
      || die "required directory owner is unsafe: $target"
  fi
}

install_file_atomically() {
  local source="$1" target="$2" mode="$3" parent temporary
  parent="$(dirname -- "$target")"
  [ -d "$parent" ] && [ ! -L "$parent" ] \
    || die "installation parent is unsafe: $parent"
  if [ -L "$target" ] || { [ -e "$target" ] && [ ! -f "$target" ]; }; then
    die "installation target is unsafe: $target"
  fi
  temporary="$(mktemp -p "$parent" .nexus-layout-install.XXXXXXXX)"
  install -m "$mode" -- "$source" "$temporary"
  root_own "$temporary"
  fsync_path "$temporary"
  replace_file "$temporary" "$target"
  fsync_path "$parent"
}

publish_text() {
  local target="$1" mode="$2" parent temporary
  parent="$(dirname -- "$target")"
  [ -d "$parent" ] && [ ! -L "$parent" ] \
    || die "publication parent is unsafe: $parent"
  if [ -L "$target" ] || { [ -e "$target" ] && [ ! -f "$target" ]; }; then
    die "publication target is unsafe: $target"
  fi
  temporary="$(mktemp -p "$parent" .nexus-layout-publication.XXXXXXXX)"
  "$PYTHON_BIN" - "$temporary"
  chmod "$mode" "$temporary"
  root_own "$temporary"
  fsync_path "$temporary"
  replace_file "$temporary" "$target"
  fsync_path "$parent"
}

validate_root_path() {
  local candidate="$1" label="$2" kind="$3" current owner mode
  [[ "$candidate" == /* && "$candidate" != / && ! -L "$candidate" ]] \
    || die "$label must be an absolute non-symlink path"
  case "$kind" in
    directory) [ -d "$candidate" ] || die "$label must be a directory" ;;
    file) [ -f "$candidate" ] || die "$label must be a regular file" ;;
    *) die "path validator misuse" ;;
  esac
  current="$(realpath -e -- "$candidate")"
  [ "$current" = "$candidate" ] || die "$label must not traverse symlinks"
  if [ "${NEXUS_RELEASE_TEST_MODE:-0}" = 1 ]; then return; fi
  while :; do
    owner="$(stat -c '%U:%G' -- "$current")"
    mode="$(stat -c '%a' -- "$current")"
    [ "$owner" = root:root ] || die "$label path component is not root-owned"
    (( (8#$mode & 0022) == 0 )) || die "$label path component is writable"
    [ "$current" = / ] && break
    current="$(dirname -- "$current")"
  done
}

REQUIRED_INPUTS=(
  scripts/remote-release-layout-activation-install.sh
  scripts/remote-rollback-drill-legacy-staging-install.sh
  scripts/remote-release-layout-activation-control.sh
  scripts/remote-release-layout-migrate.sh
  scripts/release-layout-sqlite.py
  scripts/release-layout-authorization.mjs
  scripts/release-layout-fault-drill.mjs
  scripts/trusted-release-runtime-attestation.mjs
  scripts/remote-release-selector-switch.py
  scripts/remote-release-preflight.sh
  scripts/remote-promotion-control.sh
  scripts/trusted-release-filesystem-identity.mjs
  scripts/remote-staging-attestation-broker.sh
  scripts/capture-pm2-dump-authority.mjs
  scripts/remote-pm2-dump-authority.py
  scripts/remote-release-boot-health.sh
  scripts/systemd/nexus-release-pm2-recovery-daemon.service
  scripts/systemd/nexus-release-promotion-recovery.service
  scripts/systemd/nexus-release-layout-activation@.service
  scripts/systemd/nexus-release-layout-recovery.service
  scripts/systemd/nexus-release-layout-install-recovery.service
  scripts/systemd/10-nexus-release-layout-install-recovery.conf
)

validate_source() {
  [ "$#" -eq 4 ] || die "source validation requires four arguments"
  local source_root="$1" source_sha="$2" source_archive="$3" archive_sha="$4"
  [[ "$source_sha" =~ ^[a-f0-9]{40}$ ]] || die "protected-main SHA is invalid"
  [[ "$archive_sha" =~ ^[a-f0-9]{64}$ ]] || die "source archive digest is invalid"
  [ "$source_root" = "$BOOTSTRAP_BASE/$source_sha/source" ] \
    || die "source root is not the exact SHA-bound bootstrap path"
  [ "$source_archive" = "$BOOTSTRAP_BASE/$source_sha/source.tar.gz" ] \
    || die "source archive is not the exact SHA-bound sibling"
  validate_root_path "$source_root" "activation source root" directory
  validate_root_path "$source_archive" "activation source archive" file
  local required
  for required in "${REQUIRED_INPUTS[@]}"; do
    validate_root_path "$source_root/$required" "activation source ($required)" file
  done
  [ "$(sha256sum -- "$source_archive" | cut -d' ' -f1)" = "$archive_sha" ] \
    || die "source archive does not match the approved digest"
  "$PYTHON_BIN" - "$source_archive" "$source_root" "$source_sha" \
    "$archive_sha" "${REQUIRED_INPUTS[@]}" <<'PY'
import hashlib
import pathlib
import sys
import tarfile

archive_path, source_root, source_sha, expected_digest, *required = sys.argv[1:]
root = pathlib.Path(source_root)

def safe_relative(value: str) -> bool:
    path = pathlib.PurePosixPath(value)
    return (
        value != ""
        and not path.is_absolute()
        and all(part not in ("", ".", "..") for part in path.parts)
        and str(path) == value
    )

if any(not safe_relative(value) for value in required):
    raise SystemExit("activation archive verifier: unsafe required path")
with open(archive_path, "rb") as stream:
    if hashlib.sha256(stream.read()).hexdigest() != expected_digest:
        raise SystemExit("activation archive verifier: archive digest changed")
with tarfile.open(archive_path, mode="r:*") as archive:
    if archive.pax_headers.get("comment") != source_sha:
        raise SystemExit("activation archive verifier: commit identity differs")
    expected = {f"source/{value}": value for value in required}
    seen = set()
    members = {}
    for member in archive.getmembers():
        if (
            not safe_relative(member.name)
            or (member.name != "source" and not member.name.startswith("source/"))
            or member.name in seen
        ):
            raise SystemExit("activation archive verifier: unsafe or duplicate member")
        seen.add(member.name)
        relative = expected.get(member.name)
        if relative is None:
            continue
        if not member.isreg() or member.issym() or member.islnk():
            raise SystemExit("activation archive verifier: required member is not regular")
        members[relative] = member
    missing = sorted(set(required) - set(members))
    if missing:
        raise SystemExit(f"activation archive verifier: missing source/{missing[0]}")
    for relative in sorted(required):
        extracted = archive.extractfile(members[relative])
        local = root / relative
        if extracted is None or not local.is_file() or local.is_symlink():
            raise SystemExit("activation archive verifier: unsafe required source")
        if hashlib.sha256(extracted.read()).digest() != hashlib.sha256(local.read_bytes()).digest():
            raise SystemExit(f"activation archive verifier: byte drift for {relative}")
PY
  [ "$(realpath -e -- "${BASH_SOURCE[0]}")" \
    = "$source_root/scripts/remote-release-layout-activation-install.sh" ] \
    || die "phase command must execute from the exact reviewed source"
}

capture_service_identity() {
  local output="$1" scratch unit
  scratch="$(mktemp -d "$ACTIVATION_ROOT/.unit-snapshot.XXXXXXXX")"
  for unit in pm2-dominguez.service nexus-cloudflared.service; do
    "$SYSTEMCTL_BIN" cat --no-pager "$unit" >"$scratch/$unit.cat"
    "$SYSTEMCTL_BIN" show --no-pager "$unit" \
      -p FragmentPath -p DropInPaths -p Type -p User -p Group \
      -p ExecStart -p ExecStartPost -p ExecStop -p Environment \
      -p Requires -p After -p Before -p ActiveState -p SubState \
      -p UnitFileState -p MainPID -p ExecMainStartTimestampMonotonic \
      -p NRestarts >"$scratch/$unit.show"
  done
  "$NODE_BIN" - "$scratch" "$output" <<'NODE'
const crypto=require('crypto');const fs=require('fs');const path=require('path');
const [root,output]=process.argv.slice(2);const sha=(body)=>crypto.createHash('sha256').update(body).digest('hex');
const canonical=(value)=>value===null||typeof value!=='object'?JSON.stringify(value)
 :Array.isArray(value)?`[${value.map(canonical).join(',')}]`
 :`{${Object.keys(value).sort().map((key)=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
const units={},runtime={};
for(const unit of ['pm2-dominguez.service','nexus-cloudflared.service']){
 const cat=fs.readFileSync(path.join(root,`${unit}.cat`));
 const show=fs.readFileSync(path.join(root,`${unit}.show`));
 units[unit]={catSha256:sha(cat),showSha256:sha(show)};
 const properties={};
 for(const line of show.toString('utf8').split(/\n/u)){
  const separator=line.indexOf('=');if(separator>0)properties[line.slice(0,separator)]=line.slice(separator+1);
 }
 runtime[unit]=Object.fromEntries([
  'Type','User','Group','ExecStart','ExecStartPost','ExecStop','Environment',
  'ActiveState','SubState','MainPID','ExecMainStartTimestampMonotonic','NRestarts',
 ].map((key)=>[key,properties[key]??'']));
}
fs.writeFileSync(output,`${JSON.stringify({schema:'nexus.release-layout-unit-snapshot.v1',
 units,runtime,sha256:sha(canonical(units)),runtimeSha256:sha(canonical(runtime))},null,2)}\n`,
 {mode:0o600,flag:'w'});
NODE
  rm -f -- "$scratch/pm2-dominguez.service.cat" \
    "$scratch/pm2-dominguez.service.show" \
    "$scratch/nexus-cloudflared.service.cat" \
    "$scratch/nexus-cloudflared.service.show"
  rmdir -- "$scratch"
}

validate_legacy_retirement_plan() {
  local plan="$1" legacy_recovery_state="$2"
  local legacy_install_recovery_state="$3"
  [ -f "$plan" ] && [ ! -L "$plan" ] \
    || die "legacy retirement plan is unsafe"
  "$PYTHON_BIN" - "$plan" "$LEGACY_RECEIPT" "$LEGACY_STATE_ROOT" \
    "$legacy_recovery_state" "$legacy_install_recovery_state" \
    "$LEGACY_RETAINED_SQLITE_HELPER" \
    "$PROMOTION_CONTROL_TARGET" "${NEXUS_RELEASE_TEST_MODE:-0}" \
    "${LEGACY_RETIREMENT_ALLOWLIST[@]}" <<'PY'
import datetime
import hashlib
import json
import os
import pathlib
import stat
import sys

(
    plan_value,
    receipt_value,
    state_value,
    legacy_recovery_state,
    legacy_install_recovery_state,
    retained_sqlite_value,
    control_value,
    test_mode,
    *allowed,
) = sys.argv[1:]
plan_path = pathlib.Path(plan_value)
receipt_path = pathlib.Path(receipt_value)
state_root = pathlib.Path(state_value)
retained_sqlite = pathlib.Path(retained_sqlite_value)
control_path = pathlib.Path(control_value)
digest_pattern = set("0123456789abcdef")
expected_modes = [
    0o700,
    0o644,
    0o700,
    0o700,
    0o700,
    0o700,
    0o700,
    0o644,
    0o644,
    0o644,
    0o644,
    0o644,
    0o440,
    0o700,
]
expected_receipt_names = [
    "installer",
    "installRecoveryUnit",
    "broker",
    "adapter",
    "dependencies",
    "installedAttestor",
    "recoveryAttestor",
    "releasePublicKey",
    "transactionUnit",
    "recoveryUnit",
    "pm2DominguezDropIn",
    "pm2RootDropIn",
    "sudoers",
    "filesystemHelper",
]
if len(allowed) != len(expected_modes):
    raise SystemExit("legacy retirement allowlist contract is incomplete")

def regular(path: pathlib.Path, label: str) -> os.stat_result:
    identity = path.lstat()
    if not stat.S_ISREG(identity.st_mode) or identity.st_nlink != 1:
        raise SystemExit(f"{label} is not a single-link regular file")
    return identity

def read_bounded(path: pathlib.Path, label: str, maximum: int = 1024 * 1024) -> bytes:
    regular(path, label)
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        identity = os.fstat(descriptor)
        if identity.st_size > maximum:
            raise SystemExit(f"{label} exceeds its size bound")
        body = os.read(descriptor, maximum + 1)
    finally:
        os.close(descriptor)
    if len(body) > maximum:
        raise SystemExit(f"{label} exceeds its size bound")
    return body

def object_without_duplicates(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError(f"duplicate JSON key: {key}")
        value[key] = item
    return value

def exact(value, keys, label):
    if not isinstance(value, dict) or set(value) != set(keys):
        raise SystemExit(f"{label} has an invalid shape")

def valid_digest(value):
    return (
        isinstance(value, str)
        and len(value) == 64
        and set(value) <= digest_pattern
    )

def integer(value, maximum=None):
    return (
        isinstance(value, int)
        and not isinstance(value, bool)
        and value >= 0
        and (maximum is None or value <= maximum)
    )

try:
    plan_body = read_bounded(plan_path, "legacy retirement plan")
    plan = json.loads(plan_body, object_pairs_hook=object_without_duplicates)
    receipt_body = read_bounded(receipt_path, "legacy install receipt")
    receipt = json.loads(receipt_body, object_pairs_hook=object_without_duplicates)
except (OSError, ValueError, json.JSONDecodeError) as error:
    raise SystemExit(f"legacy retirement plan input is invalid: {error}") from error
if test_mode != "1":
    for path, label, mode in (
        (plan_path, "legacy retirement plan", 0o600),
        (receipt_path, "legacy install receipt", 0o600),
    ):
        identity = path.lstat()
        if (
            identity.st_uid != 0
            or identity.st_gid != 0
            or stat.S_IMODE(identity.st_mode) != mode
        ):
            raise SystemExit(f"{label} ownership or mode is unsafe")

exact(
    plan,
    [
        "schema",
        "status",
        "promotionAllowed",
        "receipt",
        "source",
        "control",
        "recoveryUnit",
        "installRecoveryUnit",
        "retainedDependencies",
        "terminal",
        "targets",
    ],
    "legacy retirement plan",
)
exact(plan["receipt"], ["path", "sha256"], "legacy retirement receipt binding")
exact(plan["source"], ["sourceSha", "archiveSha256"], "legacy retirement source binding")
exact(plan["control"], ["version", "sha256"], "legacy retirement control binding")
exact(plan["recoveryUnit"], ["name", "enabledState"], "legacy recovery unit binding")
exact(
    plan["installRecoveryUnit"],
    ["name", "enabledState"],
    "legacy install recovery unit binding",
)
exact(plan["terminal"], ["count", "aggregateSha256"], "legacy terminal binding")
if (
    plan["schema"] != "nexus.rollback-drill-legacy-staging-phase-a-retirement-plan.v1"
    or plan["status"] != "ready"
    or plan["promotionAllowed"] is not False
    or plan["receipt"]["path"] != str(receipt_path)
    or plan["receipt"]["sha256"] != hashlib.sha256(receipt_body).hexdigest()
    or not isinstance(plan["source"]["sourceSha"], str)
    or len(plan["source"]["sourceSha"]) != 40
    or not set(plan["source"]["sourceSha"]) <= digest_pattern
    or not valid_digest(plan["source"]["archiveSha256"])
    or plan["control"]["version"] != "nexus-release-promotion-control.v2"
    or not valid_digest(plan["control"]["sha256"])
    or plan["recoveryUnit"] != {
        "name": "nexus-rollback-drill-legacy-staging-recovery.service",
        "enabledState": legacy_recovery_state,
    }
    or plan["installRecoveryUnit"] != {
        "name": "nexus-rollback-drill-legacy-staging-install-recovery.service",
        "enabledState": legacy_install_recovery_state,
    }
    or not isinstance(plan["targets"], list)
    or len(plan["targets"]) != len(allowed)
):
    raise SystemExit("legacy retirement plan identity differs")
if (
    set(receipt) != {
        "schema", "status", "promotionAllowed", "source", "control",
        "installed", "installedAt",
    }
    or receipt.get("schema")
    != "nexus.rollback-drill-legacy-staging-install-receipt.v1"
    or receipt.get("status") != "active"
    or receipt.get("promotionAllowed") is not False
    or set(receipt.get("source", {})) != {"sourceSha", "archiveSha256"}
    or set(receipt.get("control", {})) != {"version", "sha256"}
    or receipt.get("source") != plan["source"]
    or receipt.get("control") != plan["control"]
    or set(receipt.get("installed", {}))
    != set(expected_receipt_names) | {"sqliteTool"}
):
    raise SystemExit("legacy install receipt is not an active v2 receipt")
try:
    datetime.datetime.fromisoformat(
        str(receipt["installedAt"]).replace("Z", "+00:00")
    )
except (TypeError, ValueError) as error:
    raise SystemExit("legacy install receipt timestamp is invalid") from error
if any(not valid_digest(value) for value in receipt["installed"].values()):
    raise SystemExit("legacy installed digest binding is invalid")
control_body = read_bounded(control_path, "live v2 promotion control", 16 * 1024 * 1024)
control_identity = control_path.lstat()
if (
    hashlib.sha256(control_body).hexdigest() != plan["control"]["sha256"]
    or (test_mode != "1" and (
        control_identity.st_uid != 0
        or control_identity.st_gid != 0
        or stat.S_IMODE(control_identity.st_mode) != 0o700
    ))
):
    raise SystemExit("live v2 promotion control differs from the plan")

dependencies = plan["retainedDependencies"]
if not isinstance(dependencies, list) or len(dependencies) != 1:
    raise SystemExit("legacy retained dependency contract differs")
retained = dependencies[0]
exact(
    retained,
    ["path", "sha256", "mode", "uid", "gid"],
    "legacy retained dependency",
)
retained_identity = regular(retained_sqlite, "retained application DR SQLite helper")
retained_body = read_bounded(
    retained_sqlite,
    "retained application DR SQLite helper",
    1024 * 1024,
)
if (
    retained["path"] != str(retained_sqlite)
    or not valid_digest(retained["sha256"])
    or retained["sha256"] != hashlib.sha256(retained_body).hexdigest()
    or not integer(retained["mode"], 0o7777)
    or not integer(retained["uid"])
    or not integer(retained["gid"])
    or retained["mode"] != stat.S_IMODE(retained_identity.st_mode)
    or retained["uid"] != retained_identity.st_uid
    or retained["gid"] != retained_identity.st_gid
    or retained["mode"] != 0o644
    or (test_mode != "1" and (
        retained["uid"] != 0
        or retained["gid"] != 0
    ))
    or receipt.get("installed", {}).get("sqliteTool") != retained["sha256"]
):
    raise SystemExit("retained application DR SQLite helper identity differs")

terminal_transactions = []
transaction_root = state_root / "transactions"
if transaction_root.exists():
    transaction_identity = transaction_root.lstat()
    if (
        not stat.S_ISDIR(transaction_identity.st_mode)
        or transaction_root.is_symlink()
        or transaction_identity.st_mode & 0o022
        or (test_mode != "1" and (
            transaction_identity.st_uid != 0
            or transaction_identity.st_gid != 0
        ))
    ):
        raise SystemExit("legacy transaction root is unsafe")
    import re
    request_pattern = re.compile(
        r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-"
        r"[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
    )
    for transaction in sorted(transaction_root.iterdir(), key=lambda item: item.name):
        transaction_entry = transaction.lstat()
        if (
            not stat.S_ISDIR(transaction_entry.st_mode)
            or transaction.is_symlink()
            or request_pattern.fullmatch(transaction.name) is None
            or transaction_entry.st_mode & 0o022
            or (test_mode != "1" and (
                transaction_entry.st_uid != 0
                or transaction_entry.st_gid != 0
            ))
        ):
            raise SystemExit("legacy transaction directory identity is invalid")
        journal_path = transaction / "journal.json"
        journal_body = read_bounded(
            journal_path,
            "legacy terminal journal",
            2 * 1024 * 1024,
        )
        journal_identity = journal_path.lstat()
        if (
            stat.S_IMODE(journal_identity.st_mode) != 0o600
            or (test_mode != "1" and (
                journal_identity.st_uid != 0
                or journal_identity.st_gid != 0
            ))
        ):
            raise SystemExit("legacy terminal journal identity is unsafe")
        try:
            journal = json.loads(
                journal_body,
                object_pairs_hook=object_without_duplicates,
            )
        except (ValueError, json.JSONDecodeError) as error:
            raise SystemExit("legacy terminal journal is invalid") from error
        if (
            journal.get("schema")
            != "nexus.rollback-drill-legacy-staging-journal.v1"
            or journal.get("requestId") != transaction.name
            or journal.get("phase") not in {"completed", "recovered"}
        ):
            raise SystemExit("legacy transaction is not terminal")
        terminal_transactions.append({
            "requestId": transaction.name,
            "phase": journal["phase"],
            "journalSha256": hashlib.sha256(journal_body).hexdigest(),
        })
terminal_body = json.dumps(
    terminal_transactions,
    ensure_ascii=False,
    separators=(",", ":"),
    sort_keys=True,
).encode()
if (
    not integer(plan["terminal"]["count"])
    or plan["terminal"]["count"] != len(terminal_transactions)
    or not valid_digest(plan["terminal"]["aggregateSha256"])
    or plan["terminal"]["aggregateSha256"]
    != hashlib.sha256(terminal_body).hexdigest()
):
    raise SystemExit("legacy terminal transaction binding differs")

backup_root = state_root / "install" / "predecessor"
for index, (item, allowed_path, expected_mode, receipt_name) in enumerate(
    zip(plan["targets"], allowed, expected_modes, expected_receipt_names)
):
    exact(item, ["path", "active", "predecessor"], "legacy retirement target")
    exact(item["active"], ["sha256", "mode", "uid", "gid"], "legacy active target")
    target = pathlib.Path(allowed_path)
    if item["path"] != allowed_path or not target.is_absolute():
        raise SystemExit("legacy retirement target is outside the allowlist")
    identity = regular(target, "legacy active target")
    body = read_bounded(target, "legacy active target", 16 * 1024 * 1024)
    active = item["active"]
    if (
        not valid_digest(active["sha256"])
        or active["sha256"] != hashlib.sha256(body).hexdigest()
        or active["sha256"] != receipt["installed"][receipt_name]
        or not integer(active["mode"], 0o7777)
        or not integer(active["uid"])
        or not integer(active["gid"])
        or active["mode"] != stat.S_IMODE(identity.st_mode)
        or active["uid"] != identity.st_uid
        or active["gid"] != identity.st_gid
        or active["mode"] != expected_mode
        or (test_mode != "1" and (
            active["uid"] != 0
            or active["gid"] != 0
        ))
    ):
        raise SystemExit("legacy active target identity differs")

    predecessor = item["predecessor"]
    existed_path = backup_root / f"{index}.existed"
    existed_body = read_bounded(existed_path, "legacy predecessor presence", 16)
    existed_identity = existed_path.lstat()
    if (
        stat.S_IMODE(existed_identity.st_mode) != 0o600
        or (test_mode != "1" and (
            existed_identity.st_uid != 0
            or existed_identity.st_gid != 0
        ))
    ):
        raise SystemExit("legacy predecessor presence identity is unsafe")
    try:
        existed = existed_body.decode("ascii").strip()
    except UnicodeDecodeError as error:
        raise SystemExit("legacy predecessor presence is invalid") from error
    if existed == "0":
        exact(predecessor, ["action"], "legacy absent predecessor")
        if predecessor["action"] != "remove":
            raise SystemExit("legacy absent predecessor action differs")
        continue
    if existed != "1":
        raise SystemExit("legacy predecessor presence is invalid")
    exact(
        predecessor,
        ["action", "sourcePath", "sha256", "mode", "uid", "gid"],
        "legacy predecessor",
    )
    predecessor_path = backup_root / f"{index}.file"
    if predecessor["action"] != "restore" or predecessor["sourcePath"] != str(predecessor_path):
        raise SystemExit("legacy predecessor restore path differs")
    predecessor_body = read_bounded(
        predecessor_path,
        "legacy predecessor body",
        16 * 1024 * 1024,
    )
    predecessor_identity = predecessor_path.lstat()
    metadata = {}
    for key in ("mode", "uid", "gid"):
        metadata_path = backup_root / f"{index}.{key}"
        raw = read_bounded(metadata_path, f"legacy predecessor {key}", 32)
        metadata_identity = metadata_path.lstat()
        if (
            stat.S_IMODE(metadata_identity.st_mode) != 0o600
            or (test_mode != "1" and (
                metadata_identity.st_uid != 0
                or metadata_identity.st_gid != 0
            ))
        ):
            raise SystemExit(f"legacy predecessor {key} identity is unsafe")
        try:
            metadata[key] = int(
                raw.decode("ascii").strip(),
                8 if key == "mode" else 10,
            )
        except (UnicodeDecodeError, ValueError) as error:
            raise SystemExit(f"legacy predecessor {key} is invalid") from error
    if (
        not valid_digest(predecessor["sha256"])
        or predecessor["sha256"] != hashlib.sha256(predecessor_body).hexdigest()
        or not integer(predecessor["mode"], 0o7777)
        or not integer(predecessor["uid"])
        or not integer(predecessor["gid"])
        or predecessor["mode"] != metadata["mode"]
        or predecessor["uid"] != metadata["uid"]
        or predecessor["gid"] != metadata["gid"]
        or stat.S_IMODE(predecessor_identity.st_mode) != 0o600
        or (test_mode != "1" and (
            predecessor_identity.st_uid != 0
            or predecessor_identity.st_gid != 0
        ))
    ):
        raise SystemExit("legacy predecessor identity differs")

canonical_plan = (
    json.dumps(plan, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode()
    + b"\n"
)
if plan_body != canonical_plan:
    raise SystemExit("legacy retirement plan is not canonical")
print(hashlib.sha256(plan_body).hexdigest())
PY
}

write_phase_a_journal() {
  local source_sha="$1" archive_sha="$2" install_recovery_state="$3"
  local promotion_recovery_state="$4" legacy_recovery_state="$5"
  local legacy_install_recovery_state="$6"
  local retirement_plan="$7" retirement_plan_sha="$8"
  [ ! -e "$PHASE_A_JOURNAL" ] && [ ! -L "$PHASE_A_JOURNAL" ] \
    || die "Phase A recovery is required before installation"
  "$PYTHON_BIN" - "$PHASE_A_JOURNAL" "$source_sha" "$archive_sha" \
    "$install_recovery_state" "$promotion_recovery_state" "$legacy_recovery_state" \
    "$legacy_install_recovery_state" \
    "${retirement_plan:--}" "${retirement_plan_sha:--}" \
    "${#PHASE_A_TARGETS[@]}" "${#LEGACY_RETIREMENT_ALLOWLIST[@]}" \
    "$LEGACY_RETAINED_SQLITE_HELPER" \
    "${PHASE_A_TARGETS[@]}" "${LEGACY_RETIREMENT_ALLOWLIST[@]}" <<'PY'
import base64
import datetime
import hashlib
import json
import os
import pathlib
import stat
import sys

(
    output,
    source_sha,
    archive_sha,
    install_state,
    promotion_state,
    legacy_state,
    legacy_install_state,
    retirement_plan_value,
    retirement_plan_sha,
    fixed_count_value,
    allow_count_value,
    retained_sqlite,
    *arguments,
) = sys.argv[1:]
fixed_count = int(fixed_count_value)
allow_count = int(allow_count_value)
if len(arguments) != fixed_count + allow_count:
    raise SystemExit("Phase A journal target contract is incomplete")
fixed_targets = arguments[:fixed_count]
allowed_legacy_targets = arguments[fixed_count:]
legacy_retirement = None
target_values = list(fixed_targets)
if retirement_plan_value != "-":
    plan_path = pathlib.Path(retirement_plan_value)
    if plan_path.is_symlink() or not plan_path.is_file():
        raise SystemExit("legacy retirement plan is unsafe")
    plan_body = plan_path.read_bytes()
    if hashlib.sha256(plan_body).hexdigest() != retirement_plan_sha:
        raise SystemExit("legacy retirement plan changed before journaling")
    plan = json.loads(plan_body)
    plan_targets = [item.get("path") for item in plan.get("targets", [])]
    if plan_targets != allowed_legacy_targets:
        raise SystemExit("legacy retirement plan target allowlist differs")
    dependencies = plan.get("retainedDependencies")
    if (
        not isinstance(dependencies, list)
        or len(dependencies) != 1
        or dependencies[0].get("path") != retained_sqlite
    ):
        raise SystemExit("legacy retained dependency contract differs")
    legacy_retirement = {
        "planSha256": retirement_plan_sha,
        "plan": plan,
    }
    target_values.extend(plan_targets)
elif retirement_plan_sha != "-":
    raise SystemExit("legacy retirement plan digest is unexpected")
if len(target_values) != len(set(target_values)):
    raise SystemExit("Phase A journal targets are duplicated")
targets = []
for target_value in target_values:
    target = pathlib.Path(target_value)
    parent = target.parent
    if not target.is_absolute() or target == pathlib.Path("/"):
        raise SystemExit("Phase A journal target is unsafe")
    if parent.exists() and (parent.is_symlink() or not parent.is_dir()):
        raise SystemExit("Phase A journal parent is unsafe")
    record = {
        "path": str(target),
        "parentPresent": parent.exists(),
        "present": target.exists(),
    }
    if target.is_symlink():
        raise SystemExit("Phase A journal target is a symlink")
    if target.exists():
        identity = target.stat()
        if not stat.S_ISREG(identity.st_mode) or identity.st_nlink != 1:
            raise SystemExit("Phase A journal target is not a single-link regular file")
        body = target.read_bytes()
        if len(body) > 16 * 1024 * 1024:
            raise SystemExit("Phase A journal target exceeds the snapshot bound")
        record.update({
            "uid": identity.st_uid,
            "gid": identity.st_gid,
            "mode": stat.S_IMODE(identity.st_mode),
            "sha256": hashlib.sha256(body).hexdigest(),
            "bodyBase64": base64.b64encode(body).decode("ascii"),
        })
    targets.append(record)
if legacy_retirement is not None:
    records_by_path = {item["path"]: item for item in targets}
    for item in legacy_retirement["plan"]["targets"]:
        record = records_by_path[item["path"]]
        active = item["active"]
        if (
            not record["present"]
            or record["sha256"] != active["sha256"]
            or record["mode"] != active["mode"]
            or record["uid"] != active["uid"]
            or record["gid"] != active["gid"]
        ):
            raise SystemExit("legacy target changed before Phase A journaling")
    retained = legacy_retirement["plan"]["retainedDependencies"][0]
    retained_path = pathlib.Path(retained_sqlite)
    retained_identity = retained_path.stat()
    retained_body = retained_path.read_bytes()
    if (
        retained_path.is_symlink()
        or not stat.S_ISREG(retained_identity.st_mode)
        or retained_identity.st_nlink != 1
        or hashlib.sha256(retained_body).hexdigest() != retained["sha256"]
        or stat.S_IMODE(retained_identity.st_mode) != retained["mode"]
        or retained_identity.st_uid != retained["uid"]
        or retained_identity.st_gid != retained["gid"]
    ):
        raise SystemExit("retained dependency changed before Phase A journaling")
value = {
    "schema": "nexus.release-layout-phase-a-journal.v1",
    "status": "in_progress",
    "checkpoint": "snapshotted",
    "sourceSha": source_sha,
    "sourceArchiveSha256": archive_sha,
    "unitStates": {
        "nexus-release-layout-install-recovery.service": install_state,
        "nexus-release-promotion-recovery.service": promotion_state,
        "nexus-rollback-drill-legacy-staging-recovery.service": legacy_state,
        "nexus-rollback-drill-legacy-staging-install-recovery.service": legacy_install_state,
    },
    "legacyRetirement": legacy_retirement,
    "targets": targets,
    "createdAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
}
temporary = f"{output}.next.{os.getpid()}"
descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
try:
    os.write(descriptor, (json.dumps(value, indent=2) + "\n").encode())
    os.fsync(descriptor)
finally:
    os.close(descriptor)
os.replace(temporary, output)
directory = os.open(str(pathlib.Path(output).parent), os.O_RDONLY | os.O_DIRECTORY)
try:
    os.fsync(directory)
finally:
    os.close(directory)
PY
  root_own "$PHASE_A_JOURNAL"
}

phase_a_checkpoint() {
  local checkpoint="$1" temporary
  temporary="$(mktemp "$ACTIVATION_ROOT/.phase-a-journal.XXXXXXXX")"
  "$NODE_BIN" - "$PHASE_A_JOURNAL" "$temporary" "$checkpoint" <<'NODE'
const fs=require('fs');const [journalFile,output,checkpoint]=process.argv.slice(2);
const current=JSON.parse(fs.readFileSync(journalFile));
if(current.schema!=='nexus.release-layout-phase-a-journal.v1'
 ||current.status!=='in_progress'||typeof checkpoint!=='string'||!checkpoint)process.exit(1);
fs.writeFileSync(output,`${JSON.stringify({...current,checkpoint,
 updatedAt:new Date().toISOString()},null,2)}\n`,{mode:0o600,flag:'w'});
const descriptor=fs.openSync(output,'r');try{fs.fsyncSync(descriptor);}finally{fs.closeSync(descriptor);}
NODE
  root_own "$temporary"
  replace_file "$temporary" "$PHASE_A_JOURNAL"
  fsync_path "$ACTIVATION_ROOT"
}

restore_phase_a_files() {
  "$PYTHON_BIN" - "$PHASE_A_JOURNAL" "$INSTALLER_TARGET" \
    "$INSTALL_RECOVERY_UNIT_TARGET" "$INSTALL_GUARD_TARGET" \
    "$LEGACY_RECEIPT" \
    "${#PHASE_A_TARGETS[@]}" "${#LEGACY_RETIREMENT_ALLOWLIST[@]}" \
    "$LEGACY_RETAINED_SQLITE_HELPER" \
    "${PHASE_A_TARGETS[@]}" "${LEGACY_RETIREMENT_ALLOWLIST[@]}" <<'PY'
import base64
import hashlib
import json
import os
import pathlib
import stat
import sys

journal_file, installer_anchor, unit_anchor, guard_anchor, legacy_receipt, \
    fixed_count_value, allow_count_value, retained_sqlite, *arguments = sys.argv[1:]
fixed_count = int(fixed_count_value)
allow_count = int(allow_count_value)
if len(arguments) != fixed_count + allow_count:
    raise SystemExit("Phase A recovery allowlist contract is incomplete")
fixed_targets = arguments[:fixed_count]
legacy_allowlist = arguments[fixed_count:]
recovery_anchors = {installer_anchor, unit_anchor, guard_anchor}
journal_path = pathlib.Path(journal_file)
journal = json.loads(journal_path.read_text())
targets = journal.get("targets")
legacy_retirement = journal.get("legacyRetirement")
allowed = list(fixed_targets)
retained = None
if legacy_retirement is not None:
    if (
        not isinstance(legacy_retirement, dict)
        or set(legacy_retirement) != {"planSha256", "plan"}
        or not isinstance(legacy_retirement["plan"], dict)
    ):
        raise SystemExit("Phase A legacy retirement journal is invalid")
    plan = legacy_retirement["plan"]
    canonical = (
        json.dumps(plan, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode()
        + b"\n"
    )
    if hashlib.sha256(canonical).hexdigest() != legacy_retirement["planSha256"]:
        raise SystemExit("Phase A legacy retirement digest differs")
    plan_targets = plan.get("targets")
    if (
        set(plan) != {
            "schema", "status", "promotionAllowed", "receipt", "source",
            "control", "recoveryUnit", "installRecoveryUnit",
            "retainedDependencies", "terminal", "targets",
        }
        or plan.get("schema")
        != "nexus.rollback-drill-legacy-staging-phase-a-retirement-plan.v1"
        or plan.get("status") != "ready"
        or plan.get("promotionAllowed") is not False
        or set(plan.get("receipt", {})) != {"path", "sha256"}
        or plan["receipt"].get("path") != legacy_receipt
        or set(plan.get("source", {})) != {"sourceSha", "archiveSha256"}
        or set(plan.get("control", {})) != {"version", "sha256"}
        or plan["control"].get("version") != "nexus-release-promotion-control.v2"
        or set(plan.get("recoveryUnit", {})) != {"name", "enabledState"}
        or plan["recoveryUnit"] != {
            "name": "nexus-rollback-drill-legacy-staging-recovery.service",
            "enabledState": journal.get("unitStates", {}).get(
                "nexus-rollback-drill-legacy-staging-recovery.service"
            ),
        }
        or set(plan.get("installRecoveryUnit", {}))
        != {"name", "enabledState"}
        or plan["installRecoveryUnit"] != {
            "name":
            "nexus-rollback-drill-legacy-staging-install-recovery.service",
            "enabledState": journal.get("unitStates", {}).get(
                "nexus-rollback-drill-legacy-staging-install-recovery.service"
            ),
        }
        or set(plan.get("terminal", {})) != {"count", "aggregateSha256"}
        or not isinstance(plan_targets, list)
        or [item.get("path") for item in plan_targets] != legacy_allowlist
        or not isinstance(plan.get("retainedDependencies"), list)
        or len(plan["retainedDependencies"]) != 1
        or set(plan["retainedDependencies"][0])
        != {"path", "sha256", "mode", "uid", "gid"}
        or plan["retainedDependencies"][0].get("path") != retained_sqlite
    ):
        raise SystemExit("Phase A legacy retirement allowlist differs")
    for item in plan_targets:
        if (
            not isinstance(item, dict)
            or set(item) != {"path", "active", "predecessor"}
            or set(item.get("active", {})) != {"sha256", "mode", "uid", "gid"}
            or not isinstance(item.get("predecessor"), dict)
        ):
            raise SystemExit("Phase A legacy target contract differs")
        predecessor = item["predecessor"]
        if (
            predecessor.get("action") == "remove"
            and set(predecessor) != {"action"}
        ) or (
            predecessor.get("action") == "restore"
            and set(predecessor)
            != {"action", "sourcePath", "sha256", "mode", "uid", "gid"}
        ) or predecessor.get("action") not in {"remove", "restore"}:
            raise SystemExit("Phase A legacy predecessor contract differs")
    retained = plan["retainedDependencies"][0]
    allowed.extend(legacy_allowlist)
if (
    journal.get("schema") != "nexus.release-layout-phase-a-journal.v1"
    or journal.get("status") != "in_progress"
    or not isinstance(targets, list)
    or [item.get("path") for item in targets] != allowed
):
    raise SystemExit("Phase A recovery journal identity is invalid")

def assert_retained_dependency():
    if retained is None:
        return
    dependency = pathlib.Path(retained_sqlite)
    identity = dependency.lstat()
    if (
        not stat.S_ISREG(identity.st_mode)
        or dependency.is_symlink()
        or identity.st_nlink != 1
        or hashlib.sha256(dependency.read_bytes()).hexdigest() != retained.get("sha256")
        or stat.S_IMODE(identity.st_mode) != retained.get("mode")
        or identity.st_uid != retained.get("uid")
        or identity.st_gid != retained.get("gid")
    ):
        raise SystemExit("retained dependency changed during Phase A")

assert_retained_dependency()
for item in reversed(targets):
    target = pathlib.Path(item["path"])
    if str(target) in recovery_anchors:
        continue
    parent = target.parent
    if parent.exists() and (parent.is_symlink() or not parent.is_dir()):
        raise SystemExit("Phase A recovery parent is unsafe")
    if item["present"]:
        body = base64.b64decode(item["bodyBase64"], validate=True)
        if hashlib.sha256(body).hexdigest() != item["sha256"]:
            raise SystemExit("Phase A recovery body digest differs")
        parent.mkdir(mode=0o755, parents=False, exist_ok=True)
        temporary = parent / f".nexus-layout-phase-a-restore.{os.getpid()}"
        descriptor = os.open(
            temporary,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0),
            item["mode"],
        )
        try:
            os.write(descriptor, body)
            os.fchmod(descriptor, item["mode"])
            os.fchown(descriptor, item["uid"], item["gid"])
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        os.replace(temporary, target)
    else:
        if target.is_symlink() or (target.exists() and not target.is_file()):
            raise SystemExit("Phase A recovery target is unsafe")
        target.unlink(missing_ok=True)
        if not item["parentPresent"]:
            try:
                parent.rmdir()
            except OSError:
                pass
    durable_parent = parent if parent.exists() else parent.parent
    descriptor = os.open(durable_parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
assert_retained_dependency()
PY
}

publish_phase_a_recovery_failure() {
  local status="$1" temporary
  temporary="$(mktemp "$ACTIVATION_ROOT/.phase-a-recovery-failed.XXXXXXXX")"
  "$NODE_BIN" - "$temporary" "$status" <<'NODE'
const fs=require('fs');const [file,status]=process.argv.slice(2);
fs.writeFileSync(file,`${JSON.stringify({schema:'nexus.release-layout-phase-a-recovery-failure.v1',
 status:'failed',exitStatus:Number(status),failedAt:new Date().toISOString()},null,2)}\n`,
 {mode:0o600,flag:'w'});
NODE
  root_own "$temporary"
  fsync_path "$temporary"
  replace_file "$temporary" "$PHASE_A_RECOVERY_FAILED"
  fsync_path "$ACTIVATION_ROOT"
}

publish_phase_a_rollback_receipt() {
  local temporary
  temporary="$(mktemp "$ACTIVATION_ROOT/.phase-a-rollback-receipt.XXXXXXXX")"
  "$NODE_BIN" - "$PHASE_A_JOURNAL" "$temporary" \
    "$INSTALLER_TARGET" "$INSTALL_RECOVERY_UNIT_TARGET" "$INSTALL_GUARD_TARGET" <<'NODE'
const crypto=require('crypto');const fs=require('fs');
const [journalFile,output,...anchors]=process.argv.slice(2);
const body=fs.readFileSync(journalFile);
const sha=(file)=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
for(const file of anchors){
 const stat=fs.lstatSync(file);
 if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)process.exit(1);
}
fs.writeFileSync(output,`${JSON.stringify({
 schema:'nexus.release-layout-phase-a-rollback-receipt.v1',status:'recovered',
 journalSha256:crypto.createHash('sha256').update(body).digest('hex'),
 recoveryAnchorsRetained:true,
 recoveryAnchors:anchors.map((path)=>({path,sha256:sha(path)})),
 recoveredAt:new Date().toISOString(),
},null,2)}\n`,{mode:0o600,flag:'w'});
NODE
  root_own "$temporary"
  fsync_path "$temporary"
  replace_file "$temporary" "$PHASE_A_ROLLBACK_RECEIPT"
  fsync_path "$ACTIVATION_ROOT"
}

recover_phase_a_strict() {
  local states install_state promotion_state legacy_state legacy_install_state
  states="$("$NODE_BIN" - "$PHASE_A_JOURNAL" <<'NODE'
const fs=require('fs');const x=JSON.parse(fs.readFileSync(process.argv[2]));
if(x.schema!=='nexus.release-layout-phase-a-journal.v1'
 ||x.status!=='in_progress')process.exit(1);
const states=[
 x.unitStates?.['nexus-release-layout-install-recovery.service']??'not-found',
 x.unitStates?.['nexus-release-promotion-recovery.service']??'not-found',
 x.unitStates?.['nexus-rollback-drill-legacy-staging-recovery.service']??'not-found',
 x.unitStates?.['nexus-rollback-drill-legacy-staging-install-recovery.service']??'not-found',
];
if(states.some((state)=>!new Set(['enabled','enabled-runtime','disabled','not-found']).has(state)))
 process.exit(1);
process.stdout.write(states.join('\t'));
NODE
  )"
  IFS=$'\t' read -r install_state promotion_state legacy_state \
    legacy_install_state <<<"$states"
  restore_phase_a_files
  "$SYSTEMCTL_BIN" daemon-reload
  restore_unit_enablement_state \
    nexus-release-layout-install-recovery.service "$install_state"
  restore_unit_enablement_state \
    nexus-release-promotion-recovery.service "$promotion_state"
  restore_unit_enablement_state \
    nexus-rollback-drill-legacy-staging-recovery.service "$legacy_state"
  restore_unit_enablement_state \
    nexus-rollback-drill-legacy-staging-install-recovery.service \
    "$legacy_install_state"
  publish_phase_a_rollback_receipt
  rm -f -- "$PHASE_A_RECOVERY_FAILED"
  fsync_path "$ACTIVATION_ROOT"
}

recover_phase_a() {
  if [ ! -e "$PHASE_A_JOURNAL" ] && [ ! -L "$PHASE_A_JOURNAL" ]; then
    [ ! -e "$PHASE_A_RECOVERY_FAILED" ] && [ ! -L "$PHASE_A_RECOVERY_FAILED" ] \
      || die "a previous Phase A recovery failure remains unresolved"
    printf '{"ok":true,"schema":"%s","status":"idle"}\n' "$VERSION"
    return 0
  fi
  [ -f "$PHASE_A_JOURNAL" ] && [ ! -L "$PHASE_A_JOURNAL" ] \
    || die "Phase A recovery journal is unsafe"
  local status
  set +e
  (
    set -euo pipefail
    recover_phase_a_strict
  )
  status=$?
  set -e
  if [ "$status" -ne 0 ]; then
    publish_phase_a_recovery_failure "$status"
    return "$status"
  fi
  # All restoration, state verification, receipt publication, and fsync work
  # completed while the journal still existed. The final unlink is deliberately
  # the last fallible action: if its directory entry survives a crash, recovery
  # safely replays from the durable journal and receipt.
  rm -f -- "$PHASE_A_JOURNAL"
  printf '{"ok":true,"schema":"%s","status":"recovered"}\n' "$VERSION"
}

assert_phase_a_safe() {
  [ ! -e "$PHASE_A_JOURNAL" ] && [ ! -L "$PHASE_A_JOURNAL" ] \
    || die "Phase A installation recovery is required"
  [ ! -e "$PHASE_A_RECOVERY_FAILED" ] && [ ! -L "$PHASE_A_RECOVERY_FAILED" ] \
    || die "Phase A installation recovery failed"
  if [ -f "$PHASE_A_RECEIPT" ] && [ ! -L "$PHASE_A_RECEIPT" ]; then
    "$NODE_BIN" - "$PHASE_A_RECEIPT" "$LEGACY_RETIRED_RECEIPT" \
      "$LEGACY_RECEIPT" "$LEGACY_RETAINED_SQLITE_HELPER" <<'NODE'
const crypto=require('crypto');const fs=require('fs');const x=JSON.parse(fs.readFileSync(process.argv[2]));
const [retiredReceipt,activeReceipt,retainedSqlite]=process.argv.slice(3);
const sha=(file)=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
if(x.schema!=='nexus.release-layout-phase-a-receipt.v1'||x.status!=='completed'
 ||!Array.isArray(x.installedAssets)||x.installedAssets.length<1)process.exit(1);
for(const asset of x.installedAssets){
 const stat=fs.lstatSync(asset.path);
 if(!/^[a-f0-9]{64}$/u.test(asset.sha256||'')||!stat.isFile()
  ||stat.isSymbolicLink()||stat.nlink!==1
  ||sha(asset.path)!==asset.sha256)
  process.exit(1);
}
if(x.legacyV2AdapterRetired===true){
 if(fs.existsSync(activeReceipt)||!fs.existsSync(retiredReceipt)
  ||!/^[a-f0-9]{64}$/u.test(x.legacyRetirementSha256||'')
  ||sha(retiredReceipt)!==x.legacyRetirementSha256)process.exit(1);
 const retired=JSON.parse(fs.readFileSync(retiredReceipt));
 const dependencies=retired.retainedDependencies;
 if(retired.schema!=='nexus.rollback-drill-legacy-staging-retirement.v1'
  ||retired.status!=='retired'||retired.promotionAllowed!==false
  ||!Array.isArray(dependencies)||dependencies.length!==1
  ||dependencies[0].path!==retainedSqlite)process.exit(1);
 const dependency=dependencies[0],stat=fs.lstatSync(retainedSqlite);
 if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1
  ||sha(retainedSqlite)!==dependency.sha256
  ||(stat.mode&0o7777)!==dependency.mode
  ||stat.uid!==dependency.uid||stat.gid!==dependency.gid)process.exit(1);
}
NODE
    [ -x "$CONTROL_TARGET" ] \
      || die "completed Phase A control is unavailable"
    "$CONTROL_TARGET" assert-boot-safe >/dev/null
    return 0
  fi
  [ -f "$PHASE_A_ROLLBACK_RECEIPT" ] && [ ! -L "$PHASE_A_ROLLBACK_RECEIPT" ] \
    || die "Phase A completion or rollback receipt is missing"
  "$NODE_BIN" - "$PHASE_A_ROLLBACK_RECEIPT" "$INSTALLER_TARGET" \
    "$INSTALL_RECOVERY_UNIT_TARGET" "$INSTALL_GUARD_TARGET" <<'NODE'
const crypto=require('crypto');const fs=require('fs');
const [file,...expected]=process.argv.slice(2);const x=JSON.parse(fs.readFileSync(file));
if(x.schema!=='nexus.release-layout-phase-a-rollback-receipt.v1'
 ||x.status!=='recovered'||x.recoveryAnchorsRetained!==true
 ||!/^[a-f0-9]{64}$/u.test(x.journalSha256||'')
 ||!Array.isArray(x.recoveryAnchors)||x.recoveryAnchors.length!==expected.length
 ||!Number.isFinite(Date.parse(x.recoveredAt||'')))process.exit(1);
for(const [index,path] of expected.entries()){
 const record=x.recoveryAnchors[index],stat=fs.lstatSync(path);
 if(record?.path!==path||!/^[a-f0-9]{64}$/u.test(record.sha256||'')
  ||!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1
  ||crypto.createHash('sha256').update(fs.readFileSync(path)).digest('hex')!==record.sha256)
  process.exit(1);
}
NODE
}

apply_legacy_retirement_plan() {
  "$PYTHON_BIN" - "$PHASE_A_JOURNAL" "$LEGACY_RETAINED_SQLITE_HELPER" \
    "${LEGACY_RETIREMENT_ALLOWLIST[@]}" <<'PY'
import hashlib
import json
import os
import pathlib
import stat
import sys

journal_value, retained_sqlite, *allowed = sys.argv[1:]
journal = json.loads(pathlib.Path(journal_value).read_text())
legacy = journal.get("legacyRetirement")
if (
    journal.get("schema") != "nexus.release-layout-phase-a-journal.v1"
    or journal.get("status") != "in_progress"
    or not isinstance(legacy, dict)
    or set(legacy) != {"planSha256", "plan"}
):
    raise SystemExit("legacy retirement journal is unavailable")
plan = legacy["plan"]
canonical = (
    json.dumps(plan, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode()
    + b"\n"
)
if hashlib.sha256(canonical).hexdigest() != legacy["planSha256"]:
    raise SystemExit("legacy retirement plan digest differs")
targets = plan.get("targets")
if (
    not isinstance(targets, list)
    or [item.get("path") for item in targets] != allowed
    or not isinstance(plan.get("retainedDependencies"), list)
    or len(plan["retainedDependencies"]) != 1
    or plan["retainedDependencies"][0].get("path") != retained_sqlite
):
    raise SystemExit("legacy retirement plan allowlist differs")
retained = plan["retainedDependencies"][0]

def bounded_regular(path: pathlib.Path, label: str, maximum: int) -> tuple[os.stat_result, bytes]:
    identity = path.lstat()
    if (
        not stat.S_ISREG(identity.st_mode)
        or path.is_symlink()
        or identity.st_nlink != 1
        or identity.st_size > maximum
    ):
        raise SystemExit(f"{label} is unsafe")
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        opened = os.fstat(descriptor)
        body = os.read(descriptor, maximum + 1)
    finally:
        os.close(descriptor)
    if (
        len(body) > maximum
        or opened.st_dev != identity.st_dev
        or opened.st_ino != identity.st_ino
        or opened.st_size != identity.st_size
    ):
        raise SystemExit(f"{label} changed while it was read")
    return identity, body

def matches(path: pathlib.Path, expected: dict, label: str, maximum: int) -> bytes:
    identity, body = bounded_regular(path, label, maximum)
    if (
        hashlib.sha256(body).hexdigest() != expected.get("sha256")
        or stat.S_IMODE(identity.st_mode) != expected.get("mode")
        or identity.st_uid != expected.get("uid")
        or identity.st_gid != expected.get("gid")
    ):
        raise SystemExit(f"{label} identity differs")
    return body

matches(pathlib.Path(retained_sqlite), retained, "retained dependency", 1024 * 1024)
prepared = []
for item in targets:
    target = pathlib.Path(item["path"])
    matches(target, item["active"], "legacy active target", 16 * 1024 * 1024)
    predecessor = item["predecessor"]
    if predecessor.get("action") == "remove":
        if set(predecessor) != {"action"}:
            raise SystemExit("legacy removal action is invalid")
        prepared.append((item, None))
        continue
    if predecessor.get("action") != "restore" or set(predecessor) != {
        "action", "sourcePath", "sha256", "mode", "uid", "gid",
    }:
        raise SystemExit("legacy restore action is invalid")
    predecessor_identity, body = bounded_regular(
        pathlib.Path(predecessor["sourcePath"]),
        "legacy predecessor",
        16 * 1024 * 1024,
    )
    if (
        hashlib.sha256(body).hexdigest() != predecessor["sha256"]
        or stat.S_IMODE(predecessor_identity.st_mode) != 0o600
    ):
        raise SystemExit("legacy predecessor identity differs")
    prepared.append((item, body))

# All active targets, predecessor bytes, and the retained helper are validated
# before the first mutation. Any later failure is recovered from Phase A's
# independent byte-for-byte journal.
for item, predecessor_body in prepared:
    target = pathlib.Path(item["path"])
    matches(target, item["active"], "legacy active target", 16 * 1024 * 1024)
    predecessor = item["predecessor"]
    parent = target.parent
    parent_identity = parent.lstat()
    if not stat.S_ISDIR(parent_identity.st_mode) or parent.is_symlink():
        raise SystemExit("legacy retirement parent is unsafe")
    if predecessor["action"] == "remove":
        target.unlink()
    else:
        temporary = parent / f".nexus-legacy-retirement.{os.getpid()}"
        descriptor = os.open(
            temporary,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0),
            predecessor["mode"],
        )
        try:
            os.write(descriptor, predecessor_body)
            os.fchmod(descriptor, predecessor["mode"])
            os.fchown(descriptor, predecessor["uid"], predecessor["gid"])
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        os.replace(temporary, target)
    descriptor = os.open(parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
matches(pathlib.Path(retained_sqlite), retained, "retained dependency", 1024 * 1024)
PY
}

retire_legacy_adapter() {
  "$PYTHON_BIN" - "$PHASE_A_JOURNAL" "$LEGACY_RECEIPT" \
    "$LEGACY_RETIRED_RECEIPT" "$LEGACY_RETAINED_SQLITE_HELPER" \
    "${LEGACY_RETIREMENT_ALLOWLIST[@]}" <<'PY'
import datetime
import hashlib
import json
import os
import pathlib
import stat
import sys

journal_value, receipt_value, output_value, retained_sqlite, *allowed = sys.argv[1:]
journal = json.loads(pathlib.Path(journal_value).read_text())
legacy = journal.get("legacyRetirement")
if (
    journal.get("schema") != "nexus.release-layout-phase-a-journal.v1"
    or journal.get("status") != "in_progress"
    or not isinstance(legacy, dict)
    or set(legacy) != {"planSha256", "plan"}
):
    raise SystemExit("legacy retirement journal is invalid")
plan = legacy["plan"]
canonical = (
    json.dumps(plan, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode()
    + b"\n"
)
if hashlib.sha256(canonical).hexdigest() != legacy["planSha256"]:
    raise SystemExit("legacy retirement plan digest differs")
targets = plan.get("targets")
if not isinstance(targets, list) or [item.get("path") for item in targets] != allowed:
    raise SystemExit("legacy retirement target allowlist differs")
receipt_path = pathlib.Path(receipt_value)
receipt_body = receipt_path.read_bytes()
receipt_identity = receipt_path.lstat()
if (
    not stat.S_ISREG(receipt_identity.st_mode)
    or receipt_path.is_symlink()
    or receipt_identity.st_nlink != 1
    or hashlib.sha256(receipt_body).hexdigest() != plan["receipt"]["sha256"]
):
    raise SystemExit("active legacy receipt changed before retirement")

def observed(path: pathlib.Path):
    identity = path.lstat()
    if not stat.S_ISREG(identity.st_mode) or path.is_symlink() or identity.st_nlink != 1:
        raise SystemExit("legacy retirement output is unsafe")
    body = path.read_bytes()
    return identity, body

for item in targets:
    target = pathlib.Path(item["path"])
    predecessor = item["predecessor"]
    if predecessor["action"] == "remove":
        if target.exists() or target.is_symlink():
            raise SystemExit("legacy retirement target was not removed")
        continue
    identity, body = observed(target)
    if (
        hashlib.sha256(body).hexdigest() != predecessor["sha256"]
        or stat.S_IMODE(identity.st_mode) != predecessor["mode"]
        or identity.st_uid != predecessor["uid"]
        or identity.st_gid != predecessor["gid"]
    ):
        raise SystemExit("legacy predecessor was not restored exactly")
retained = plan["retainedDependencies"][0]
retained_identity, retained_body = observed(pathlib.Path(retained_sqlite))
if (
    hashlib.sha256(retained_body).hexdigest() != retained["sha256"]
    or stat.S_IMODE(retained_identity.st_mode) != retained["mode"]
    or retained_identity.st_uid != retained["uid"]
    or retained_identity.st_gid != retained["gid"]
):
    raise SystemExit("retained dependency changed during retirement")
value = {
    "schema": "nexus.rollback-drill-legacy-staging-retirement.v1",
    "status": "retired",
    "promotionAllowed": False,
    "predecessorReceiptSha256": plan["receipt"]["sha256"],
    "retirementPlanSha256": legacy["planSha256"],
    "terminal": plan["terminal"],
    "targetCount": len(targets),
    "retainedDependencies": plan["retainedDependencies"],
    "retiredAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
}
output = pathlib.Path(output_value)
descriptor = os.open(
    output,
    os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0),
    0o600,
)
try:
    os.write(descriptor, (json.dumps(value, indent=2) + "\n").encode())
    os.fsync(descriptor)
finally:
    os.close(descriptor)
PY
  root_own "$LEGACY_RETIRED_RECEIPT"
  fsync_path "$LEGACY_RETIRED_RECEIPT"
}

assert_phase_a_retained_dependencies() {
  "$PYTHON_BIN" - "$PHASE_A_JOURNAL" "$LEGACY_RETAINED_SQLITE_HELPER" <<'PY'
import hashlib
import json
import pathlib
import stat
import sys

journal = json.loads(pathlib.Path(sys.argv[1]).read_text())
legacy = journal.get("legacyRetirement")
if legacy is None:
    raise SystemExit(0)
dependencies = legacy.get("plan", {}).get("retainedDependencies")
if (
    not isinstance(dependencies, list)
    or len(dependencies) != 1
    or dependencies[0].get("path") != sys.argv[2]
):
    raise SystemExit("retained dependency journal differs")
expected = dependencies[0]
path = pathlib.Path(sys.argv[2])
identity = path.lstat()
if (
    not stat.S_ISREG(identity.st_mode)
    or path.is_symlink()
    or identity.st_nlink != 1
    or hashlib.sha256(path.read_bytes()).hexdigest() != expected.get("sha256")
    or stat.S_IMODE(identity.st_mode) != expected.get("mode")
    or identity.st_uid != expected.get("uid")
    or identity.st_gid != expected.get("gid")
):
    raise SystemExit("retained dependency changed during Phase A")
PY
}

phase_a() {
  [ "$#" -eq 4 ] || { usage >&2; exit 64; }
  local source_root="$1" source_sha="$2" source_archive="$3" archive_sha="$4"
  local before after sudoers_tmp receipt_tmp retirement_plan="" retirement_plan_sha=""
  local pm2_proof pm2_proof_after pm2_prerequisite_control legacy_present=false
  local install_recovery_state promotion_recovery_state legacy_recovery_state
  local legacy_install_recovery_state
  validate_source "$source_root" "$source_sha" "$source_archive" "$archive_sha"
  if { [ -e "$PHASE_A_RECEIPT" ] || [ -L "$PHASE_A_RECEIPT" ]; } \
      && [ ! -e "$PHASE_A_JOURNAL" ] && [ ! -L "$PHASE_A_JOURNAL" ]; then
    die "Phase A already has a terminal receipt"
  fi
  pm2_prerequisite_control="$source_root/scripts/remote-promotion-control.sh"
  if [ "${NEXUS_RELEASE_TEST_MODE:-0}" = 1 ] \
      && [ -n "$PM2_PREREQUISITE_CONTROL" ]; then
    pm2_prerequisite_control="$PM2_PREREQUISITE_CONTROL"
  elif [ -n "$PM2_PREREQUISITE_CONTROL" ]; then
    die "PM2 prerequisite control override is prohibited outside test mode"
  fi
  [ -x "$pm2_prerequisite_control" ] \
    || die "root-owned PM2 prerequisite control is unavailable"
  ensure_directory /usr/local/libexec 755
  ensure_directory /usr/local/sbin 755
  ensure_directory /etc/systemd/system 755
  ensure_directory /etc/sudoers.d 755
  ensure_directory /srv/nexus-release 755
  if [ ! -e "$STATE_ROOT" ] && [ ! -L "$STATE_ROOT" ]; then
    install -d -m 755 -- "$STATE_ROOT"
    root_own "$STATE_ROOT"
  fi
  [ -d "$STATE_ROOT" ] && [ ! -L "$STATE_ROOT" ] \
    && [ "$(stat -c '%U:%a' -- "$STATE_ROOT")" = root:755 ] \
    || die "promotion state root is unsafe"
  ensure_directory "$ACTIVATION_ROOT" 700
  ensure_directory "$ACTIVATION_ROOT/transactions" 700
  if [ "${NEXUS_RELEASE_TEST_MODE:-0}" = 1 ]; then
    [ -e "$CONTROL_LOCK" ] || : >"$CONTROL_LOCK"
    if [ ! -e "$RELEASE_SONAR_LOCK" ]; then
      install -d -m 700 "$(dirname -- "$RELEASE_SONAR_LOCK")"
      : >"$RELEASE_SONAR_LOCK"
    fi
  fi
  acquire_phase_locks
  pm2_proof="$(mktemp)"
  NEXUS_PROMOTION_INHERITED_CONTROL_LOCK_FD=7 \
    "$pm2_prerequisite_control" assert-root-pm2-ready >"$pm2_proof" \
    || die "root-owned pinned PM2 executable closure is not attested"
  assert_legacy_install_state_safe
  if [ -e "$PHASE_A_JOURNAL" ] || [ -L "$PHASE_A_JOURNAL" ]; then
    recover_phase_a
  fi
  [ ! -e "$PHASE_B_JOURNAL" ] && [ ! -L "$PHASE_B_JOURNAL" ] \
    || die "a Phase B handover journal already exists"
  if [ -e "$LEGACY_RECEIPT" ] || [ -L "$LEGACY_RECEIPT" ]; then
    [ -f "$LEGACY_RECEIPT" ] && [ ! -L "$LEGACY_RECEIPT" ] \
      || die "legacy v2 adapter retirement authority is unsafe"
    [ ! -e "$LEGACY_RETIRED_RECEIPT" ] && [ ! -L "$LEGACY_RETIRED_RECEIPT" ] \
      || die "active and retired legacy receipts coexist"
    legacy_present=true
  elif [ -e "$LEGACY_PM2_DOMINGUEZ_DROPIN" ] || [ -L "$LEGACY_PM2_DOMINGUEZ_DROPIN" ] \
      || [ -e "$LEGACY_PM2_ROOT_DROPIN" ] || [ -L "$LEGACY_PM2_ROOT_DROPIN" ]; then
    die "legacy v2 adapter drop-in exists without its retirement receipt"
  elif [ -e "$LEGACY_RETIRED_RECEIPT" ] || [ -L "$LEGACY_RETIRED_RECEIPT" ]; then
    die "legacy retirement receipt exists without Phase A authority"
  fi
  [ ! -e "$STATE_ROOT/active.json" ] && [ ! -L "$STATE_ROOT/active.json" ] \
    || die "ordinary promotion is active"
  [ ! -e "$ACTIVATION_ROOT/active.v1.json" ] \
    && [ ! -L "$ACTIVATION_ROOT/active.v1.json" ] \
    || die "layout activation is already active"
  assert_legacy_terminal_journals
  before="$(mktemp "$ACTIVATION_ROOT/.phase-a-before.XXXXXXXX")"
  after="$(mktemp "$ACTIVATION_ROOT/.phase-a-after.XXXXXXXX")"
  capture_service_identity "$before"
  install_recovery_state="$(
    recovery_anchor_enablement_state \
      nexus-release-layout-install-recovery.service
  )"
  promotion_recovery_state="$(
    unit_enablement_state nexus-release-promotion-recovery.service
  )"
  legacy_recovery_state="$(
    unit_enablement_state nexus-rollback-drill-legacy-staging-recovery.service
  )"
  legacy_install_recovery_state="$(
    unit_enablement_state \
      nexus-rollback-drill-legacy-staging-install-recovery.service
  )"
  if [ "$legacy_present" = true ]; then
    retirement_plan="$(mktemp "$ACTIVATION_ROOT/.legacy-retirement-plan.XXXXXXXX")"
    /bin/bash \
      "$source_root/scripts/remote-rollback-drill-legacy-staging-install.sh" \
      phase-a-retirement-plan >"$retirement_plan"
    chmod 600 "$retirement_plan"
    root_own "$retirement_plan"
    fsync_path "$retirement_plan"
    retirement_plan_sha="$(
      validate_legacy_retirement_plan "$retirement_plan" \
        "$legacy_recovery_state" "$legacy_install_recovery_state"
    )" || die "legacy v2 retirement plan is invalid"
  fi
  phase_a_failure() {
    local status="${1:-$?}" recovery_status
    trap - ERR INT TERM HUP EXIT
    if [ "$status" -ne 0 ] \
        && { [ -e "$PHASE_A_JOURNAL" ] || [ -L "$PHASE_A_JOURNAL" ]; }; then
      set +e
      (
        set -euo pipefail
        recover_phase_a
      )
      recovery_status=$?
      set -e
      [ "$recovery_status" -eq 0 ] || exit "$recovery_status"
    fi
    exit "$status"
  }
  trap 'phase_a_failure $?' ERR
  trap 'phase_a_failure 130' INT
  trap 'phase_a_failure 143' TERM
  trap 'phase_a_failure 129' HUP
  trap 'phase_a_failure $?' EXIT
  write_phase_a_journal "$source_sha" "$archive_sha" \
    "$install_recovery_state" "$promotion_recovery_state" "$legacy_recovery_state" \
    "$legacy_install_recovery_state" \
    "$retirement_plan" "$retirement_plan_sha"

  # Install the recovery executable, boot unit, and PM2 guard before replacing
  # any control consumed by the running release plane.
  install_file_atomically \
    "$source_root/scripts/remote-release-layout-activation-install.sh" \
    "$INSTALLER_TARGET" 755
  install_file_atomically \
    "$source_root/scripts/systemd/nexus-release-layout-install-recovery.service" \
    "$INSTALL_RECOVERY_UNIT_TARGET" 644
  ensure_directory "$(dirname -- "$INSTALL_GUARD_TARGET")" 755
  install_file_atomically \
    "$source_root/scripts/systemd/10-nexus-release-layout-install-recovery.conf" \
    "$INSTALL_GUARD_TARGET" 644
  "$SYSTEMCTL_BIN" daemon-reload
  "$SYSTEMCTL_BIN" enable nexus-release-layout-install-recovery.service >/dev/null
  phase_a_checkpoint recovery_guard_active

  install_file_atomically \
    "$source_root/scripts/remote-release-layout-activation-control.sh" \
    "$CONTROL_TARGET" 755
  install_file_atomically \
    "$source_root/scripts/remote-release-layout-migrate.sh" \
    "$MIGRATE_TARGET" 755
  install_file_atomically \
    "$source_root/scripts/release-layout-sqlite.py" \
    "$SQLITE_TARGET" 755
  install_file_atomically \
    "$source_root/scripts/release-layout-authorization.mjs" \
    "$AUTH_TARGET" 755
  install_file_atomically \
    "$source_root/scripts/release-layout-fault-drill.mjs" \
    "$DRILL_VERIFY_TARGET" 755
  install_file_atomically \
    "$source_root/scripts/trusted-release-runtime-attestation.mjs" \
    "$ATTESTOR_TARGET" 755
  install_file_atomically \
    "$source_root/scripts/remote-release-selector-switch.py" \
    "$SELECTOR_TARGET" 755
  install_file_atomically \
    "$source_root/scripts/remote-release-preflight.sh" \
    "$PREFLIGHT_TARGET" 755
  install_file_atomically \
    "$source_root/scripts/systemd/nexus-release-layout-activation@.service" \
    "$ACTIVATION_UNIT_TARGET" 644
  install_file_atomically \
    "$source_root/scripts/systemd/nexus-release-layout-recovery.service" \
    "$LAYOUT_RECOVERY_UNIT_TARGET" 644
  phase_a_checkpoint successor_assets_installed

  if [ -n "$retirement_plan" ]; then
    "$SYSTEMCTL_BIN" disable \
      nexus-rollback-drill-legacy-staging-recovery.service >/dev/null
    "$SYSTEMCTL_BIN" disable \
      nexus-rollback-drill-legacy-staging-install-recovery.service >/dev/null
    apply_legacy_retirement_plan
    "$SYSTEMCTL_BIN" daemon-reload
    retire_legacy_adapter
    # The durable Phase A journal contains every active adapter byte and its
    # canonical predecessor disposition. Record completed asset retirement
    # before withdrawing the v2 receipt that authorized the transition.
    phase_a_checkpoint legacy_v2_adapter_assets_retired
    rm -f -- "$LEGACY_RECEIPT"
    fsync_path "$LEGACY_STATE_ROOT"
    phase_a_checkpoint legacy_v2_adapter_receipt_retired
  fi
  # Complete the recovery call graph before replacing promotion-control or
  # making its recovery unit reachable from the PM2 handover. This prevents a
  # reboot from binding a healthy legacy PM2 service to a partial closure.
  install_file_atomically \
    "$source_root/scripts/trusted-release-filesystem-identity.mjs" \
    "$FILESYSTEM_IDENTITY_TARGET" 700
  install_file_atomically \
    "$source_root/scripts/remote-staging-attestation-broker.sh" \
    "$STAGING_BROKER_TARGET" 700
  install_file_atomically \
    "$source_root/scripts/capture-pm2-dump-authority.mjs" \
    "$PM2_CAPTURE_AUTHORITY_TARGET" 700
  install_file_atomically \
    "$source_root/scripts/remote-pm2-dump-authority.py" \
    "$PM2_DUMP_AUTHORITY_TARGET" 700
  install_file_atomically \
    "$source_root/scripts/remote-release-boot-health.sh" \
    "$BOOT_HEALTH_TARGET" 700
  install_file_atomically \
    "$source_root/scripts/systemd/nexus-release-pm2-recovery-daemon.service" \
    "$PM2_RECOVERY_UNIT_TARGET" 644
  install_file_atomically \
    "$source_root/scripts/systemd/nexus-release-promotion-recovery.service" \
    "$PROMOTION_RECOVERY_UNIT_TARGET" 644
  "$SYSTEMCTL_BIN" daemon-reload
  "$SYSTEMCTL_BIN" enable nexus-release-promotion-recovery.service >/dev/null
  phase_a_checkpoint promotion_recovery_closure_installed

  install_file_atomically \
    "$source_root/scripts/remote-promotion-control.sh" \
    "$PROMOTION_CONTROL_TARGET" 755
  pm2_proof_after="$(mktemp)"
  NEXUS_PROMOTION_INHERITED_CONTROL_LOCK_FD=7 \
    "$PROMOTION_CONTROL_TARGET" assert-root-pm2-ready >"$pm2_proof_after" \
    || die "installed promotion control rejects the pinned PM2 closure"
  cmp -s -- "$pm2_proof" "$pm2_proof_after" \
    || die "PM2 closure proof changed across promotion-control replacement"
  rm -f -- "$pm2_proof_after"
  pm2_proof_after=""
  phase_a_checkpoint promotion_control_v3_installed

  sudoers_tmp="$(mktemp "$ACTIVATION_ROOT/.phase-a-sudoers.XXXXXXXX")"
  printf '%s\n' \
    "Cmnd_Alias NEXUS_LAYOUT_ACTIVATION = /usr/local/sbin/nexus-release-layout-activation-control version, /usr/local/sbin/nexus-release-layout-activation-control submit *, /usr/local/sbin/nexus-release-layout-activation-control status, /usr/local/sbin/nexus-release-layout-activation-control status *, /usr/local/sbin/nexus-release-layout-activation-control fetch *" \
    "$WORKER_USER ALL=(root) NOPASSWD: NEXUS_LAYOUT_ACTIVATION" >"$sudoers_tmp"
  chmod 440 "$sudoers_tmp"; root_own "$sudoers_tmp"
  visudo -cf "$sudoers_tmp" >/dev/null
  install_file_atomically "$sudoers_tmp" "$SUDOERS_TARGET" 440
  rm -f -- "$sudoers_tmp"

  "$SYSTEMCTL_BIN" daemon-reload
  "$SYSTEMCTL_BIN" enable nexus-release-layout-recovery.service >/dev/null
  phase_a_checkpoint units_reloaded
  assert_phase_a_retained_dependencies
  capture_service_identity "$after"
  "$NODE_BIN" - "$before" "$after" <<'NODE'
const fs=require('fs');const [beforeFile,afterFile]=process.argv.slice(2);
const before=JSON.parse(fs.readFileSync(beforeFile));
const after=JSON.parse(fs.readFileSync(afterFile));
if(!/^[a-f0-9]{64}$/u.test(before.sha256||'')
 ||!/^[a-f0-9]{64}$/u.test(after.sha256||'')
 ||before.runtimeSha256!==after.runtimeSha256
 ||JSON.stringify(before.runtime)!==JSON.stringify(after.runtime))process.exit(1);
NODE

  receipt_tmp="$(mktemp "$ACTIVATION_ROOT/.phase-a-receipt.XXXXXXXX")"
  "$NODE_BIN" - "$receipt_tmp" "$source_sha" "$archive_sha" "$before" \
    "$after" "$LEGACY_RETIRED_RECEIPT" "$pm2_proof" \
    "$INSTALLER_TARGET" "$CONTROL_TARGET" "$MIGRATE_TARGET" \
    "$SQLITE_TARGET" "$AUTH_TARGET" "$DRILL_VERIFY_TARGET" \
    "$ATTESTOR_TARGET" "$SELECTOR_TARGET" \
    "$PREFLIGHT_TARGET" "$PROMOTION_CONTROL_TARGET" "$ACTIVATION_UNIT_TARGET" \
    "$FILESYSTEM_IDENTITY_TARGET" "$STAGING_BROKER_TARGET" \
    "$PM2_CAPTURE_AUTHORITY_TARGET" "$PM2_DUMP_AUTHORITY_TARGET" \
    "$BOOT_HEALTH_TARGET" "$PM2_RECOVERY_UNIT_TARGET" \
    "$PROMOTION_RECOVERY_UNIT_TARGET" \
    "$LAYOUT_RECOVERY_UNIT_TARGET" "$INSTALL_RECOVERY_UNIT_TARGET" \
    "$INSTALL_GUARD_TARGET" \
    "$SUDOERS_TARGET" <<'NODE'
const crypto=require('crypto');const fs=require('fs');
const [output,sourceSha,archiveSha,beforeFile,afterFile,legacyRetirement,pm2Proof,...assets]
 =process.argv.slice(2);
const sha=(file)=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const before=JSON.parse(fs.readFileSync(beforeFile));
const after=JSON.parse(fs.readFileSync(afterFile));
fs.writeFileSync(output,`${JSON.stringify({
 schema:'nexus.release-layout-phase-a-receipt.v1',status:'completed',
 sourceSha,sourceArchiveSha256:archiveSha,completedAt:new Date().toISOString(),
 existingServiceIdentity:{runtimeUnchanged:true,beforeSha256:before.sha256,
  afterSha256:after.sha256,runtimeSha256:after.runtimeSha256,
  beforeUnits:before.units,afterUnits:after.units,runtime:after.runtime},
 installedAssets:assets.map((path)=>({path,sha256:sha(path)})),
 phaseARecoveryGuard:true,legacyV2AdapterRetired:fs.existsSync(legacyRetirement),
 legacyRetirementSha256:fs.existsSync(legacyRetirement)?sha(legacyRetirement):null,
 pm2Prerequisite:{verified:true,evidenceSha256:sha(pm2Proof)},
 prohibitedCommands:['run','recover-all'],
},null,2)}\n`,{mode:0o600,flag:'w'});
NODE
  chmod 600 "$receipt_tmp"; root_own "$receipt_tmp"; fsync_path "$receipt_tmp"
  replace_file "$receipt_tmp" "$PHASE_A_RECEIPT"; fsync_path "$ACTIVATION_ROOT"
  phase_a_checkpoint receipt_published
  rm -f -- "$PHASE_A_ROLLBACK_RECEIPT"; fsync_path "$ACTIVATION_ROOT"
  # Keep the journal present through every receipt and fsync operation. The
  # receipt and receipt_published checkpoint make a replay after a crash safe.
  rm -f -- "$PHASE_A_JOURNAL"
  trap - ERR INT TERM HUP EXIT
  rm -f -- "$before" "$after"
  rm -f -- "$pm2_proof"
  [ -z "${pm2_proof_after:-}" ] || rm -f -- "$pm2_proof_after"
  [ -z "$retirement_plan" ] || rm -f -- "$retirement_plan"
  printf '{"ok":true,"schema":"%s","phase":"phase_a","status":"completed","sourceSha":"%s"}\n' \
    "$VERSION" "$source_sha"
}

write_handover_journal() {
  local source_sha="$1" archive_sha="$2" attestation_sha="$3"
  "$PYTHON_BIN" - "$PHASE_B_JOURNAL" "$source_sha" "$archive_sha" \
    "$attestation_sha" "$PM2_DROPIN" "$INGRESS_DROPIN" <<'PY'
import base64
import datetime
import hashlib
import json
import os
import pathlib
import stat
import sys

output, source_sha, archive_sha, attestation_sha, *targets = sys.argv[1:]
records = []
for target_value in targets:
    target = pathlib.Path(target_value)
    parent = target.parent
    parent_present = parent.exists()
    if parent_present and (parent.is_symlink() or not parent.is_dir()):
        raise SystemExit("handover target parent is unsafe")
    record = {"path": str(target), "parentPresent": parent_present, "present": target.exists()}
    if target.is_symlink():
        raise SystemExit("handover target is a symlink")
    if target.exists():
        identity = target.stat()
        if not stat.S_ISREG(identity.st_mode) or identity.st_nlink != 1:
            raise SystemExit("handover target is not a single-link regular file")
        body = target.read_bytes()
        record.update({
            "uid": identity.st_uid,
            "gid": identity.st_gid,
            "mode": stat.S_IMODE(identity.st_mode),
            "sha256": hashlib.sha256(body).hexdigest(),
            "bodyBase64": base64.b64encode(body).decode("ascii"),
        })
    records.append(record)
value = {
    "schema": "nexus.release-layout-phase-b-journal.v1",
    "status": "in_progress",
    "sourceSha": source_sha,
    "sourceArchiveSha256": archive_sha,
    "layoutAttestationSha256": attestation_sha,
    "createdAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "targets": records,
}
temporary = f"{output}.next.{os.getpid()}"
descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
try:
    os.write(descriptor, (json.dumps(value, indent=2) + "\n").encode())
    os.fsync(descriptor)
finally:
    os.close(descriptor)
os.replace(temporary, output)
directory = os.open(str(pathlib.Path(output).parent), os.O_RDONLY)
try:
    os.fsync(directory)
finally:
    os.close(directory)
PY
  root_own "$PHASE_B_JOURNAL"
}

assert_phase_b_committed_receipt() {
  "$NODE_BIN" - "$PHASE_B_JOURNAL" "$PHASE_B_RECEIPT" \
    "$PM2_DROPIN" "$INGRESS_DROPIN" <<'NODE'
const crypto=require('crypto');const fs=require('fs');
const [journalFile,receiptFile,...targets]=process.argv.slice(2);
const journal=JSON.parse(fs.readFileSync(journalFile));
const receipt=JSON.parse(fs.readFileSync(receiptFile));
const sha=(file)=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
if(journal.schema!=='nexus.release-layout-phase-b-journal.v1'
 ||journal.status!=='committed'
 ||receipt.schema!=='nexus.release-layout-phase-b-receipt.v1'
 ||receipt.status!=='completed'
 ||receipt.sourceSha!==journal.sourceSha
 ||receipt.sourceArchiveSha256!==journal.sourceArchiveSha256
 ||receipt.layoutAttestationSha256!==journal.layoutAttestationSha256
 ||JSON.stringify(receipt.handoverTargets?.map((item)=>item.path))!==JSON.stringify(targets)
 ||receipt.handoverTargets.some((item,index)=>item.sha256!==sha(targets[index])))
 process.exit(1);
NODE
}

restore_handover_strict() {
  local journal_status
  journal_status="$("$PYTHON_BIN" - "$PHASE_B_JOURNAL" \
    "$PM2_DROPIN" "$INGRESS_DROPIN" <<'PY'
import base64
import hashlib
import json
import os
import pathlib
import stat
import sys

journal_file, *allowed = sys.argv[1:]
journal = json.loads(pathlib.Path(journal_file).read_text())
if (
    journal.get("schema") != "nexus.release-layout-phase-b-journal.v1"
    or journal.get("status") not in {"in_progress", "committed"}
    or [item.get("path") for item in journal.get("targets", [])] != allowed
):
    raise SystemExit("Phase B handover journal identity is invalid")
if journal["status"] == "committed":
    print("committed")
    raise SystemExit(0)
for item in journal["targets"]:
    target = pathlib.Path(item["path"])
    parent = target.parent
    if parent.exists() and (parent.is_symlink() or not parent.is_dir()):
        raise SystemExit("handover rollback parent is unsafe")
    if item["present"]:
        body = base64.b64decode(item["bodyBase64"], validate=True)
        if hashlib.sha256(body).hexdigest() != item["sha256"]:
            raise SystemExit("handover rollback body digest differs")
        parent.mkdir(mode=0o755, parents=False, exist_ok=True)
        temporary = parent / f".nexus-layout-rollback.{os.getpid()}"
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, item["mode"])
        try:
            os.write(descriptor, body)
            os.fchmod(descriptor, item["mode"])
            os.fchown(descriptor, item["uid"], item["gid"])
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        os.replace(temporary, target)
    else:
        if target.is_symlink() or (target.exists() and not target.is_file()):
            raise SystemExit("handover rollback target is unsafe")
        if target.exists():
            target.unlink()
        if not item["parentPresent"]:
            try:
                parent.rmdir()
            except OSError:
                pass
    directory = os.open(str(parent if parent.exists() else parent.parent), os.O_RDONLY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)
print("in_progress")
PY
  )"
  if [ "$journal_status" = committed ]; then
    assert_phase_b_committed_receipt
    fsync_path "$PHASE_B_RECEIPT"
    fsync_path "$ACTIVATION_ROOT"
    rm -f -- "$PHASE_B_JOURNAL"
    return 0
  fi
  [ "$journal_status" = in_progress ] \
    || die "Phase B handover rollback state is invalid"
  "$SYSTEMCTL_BIN" daemon-reload
  rm -f -- "$PHASE_B_RECEIPT"
  fsync_path "$ACTIVATION_ROOT"
  rm -f -- "$PHASE_B_JOURNAL"
}

restore_handover() {
  [ -e "$PHASE_B_JOURNAL" ] || [ -L "$PHASE_B_JOURNAL" ] || return 0
  [ -f "$PHASE_B_JOURNAL" ] && [ ! -L "$PHASE_B_JOURNAL" ] \
    || die "Phase B handover journal is unsafe"
  local status
  set +e
  (
    set -euo pipefail
    restore_handover_strict
  )
  status=$?
  set -e
  [ "$status" -eq 0 ] || die "Phase B handover rollback failed"
}

publish_pm2_handover() {
  ensure_directory "$(dirname -- "$PM2_DROPIN")" 755
  publish_text "$PM2_DROPIN" 644 <<'PY'
import pathlib, sys
pathlib.Path(sys.argv[1]).write_text("""[Unit]
Requires=nexus-release-layout-recovery.service nexus-release-promotion-recovery.service
After=nexus-release-layout-recovery.service nexus-release-promotion-recovery.service

[Service]
Type=forking
User=dominguez
Group=dominguez
PIDFile=
PIDFile=/home/dominguez/.pm2/pm2.pid
MemoryDenyWriteExecute=false
KillMode=control-group
SendSIGKILL=yes
TimeoutStartSec=135s
TimeoutStopSec=30s
Environment=
EnvironmentFile=
PassEnvironment=
UnsetEnvironment=
Environment=\"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\"
Environment=\"PM2_HOME=/home/dominguez/.pm2\"
Environment=\"PM2_DUMP_FILE_PATH=/var/lib/nexus-release-promotion/pm2-authority/dump.pm2\"
Environment=\"PM2_DUMP_BACKUP_FILE_PATH=/var/lib/nexus-release-promotion/pm2-authority/dump.pm2.backup-disabled\"
Environment=\"PM2_DAEMON_TITLE=NexusPM2:/opt/nexus-release/pm2/6.0.14\"
UnsetEnvironment=NODE_OPTIONS NODE_PATH PM2_NODE_OPTIONS PYTHONPATH PYTHONHOME PYTHONINSPECT PYTHONSTARTUP PYTHONBREAKPOINT LD_PRELOAD LD_LIBRARY_PATH
ExecCondition=
ExecCondition=+/usr/local/sbin/nexus-release-layout-activation-control assert-boot-safe
ExecStartPre=
ExecStart=
ExecStart=/usr/local/bin/pm2 resurrect
ExecStartPost=
ExecStartPost=+/usr/local/sbin/nexus-release-promotion-control boot-postcheck
ExecReload=
ExecReload=/usr/local/bin/pm2 reload all
ExecStop=
ExecStop=/usr/local/bin/pm2 kill
ExecStopPost=
""")
PY
}

publish_ingress_handover() {
  ensure_directory "$(dirname -- "$INGRESS_DROPIN")" 755
  publish_text "$INGRESS_DROPIN" 644 <<'PY'
import pathlib, sys
pathlib.Path(sys.argv[1]).write_text("""[Unit]
Requires=nexus-release-layout-recovery.service nexus-release-promotion-recovery.service pm2-dominguez.service
After=nexus-release-layout-recovery.service nexus-release-promotion-recovery.service pm2-dominguez.service
""")
PY
}

verify_handover() {
  local pm2_root_state properties
  pm2_root_state="$("$SYSTEMCTL_BIN" is-enabled pm2-root.service 2>/dev/null || true)"
  case "$pm2_root_state" in masked|not-found|"") ;; *)
    die "competing pm2-root.service must already be absent or masked"
  esac
  properties="$("$SYSTEMCTL_BIN" show --no-pager pm2-dominguez.service \
    -p DropInPaths -p Type -p User -p Group -p ExecStart -p ExecStartPost \
    -p ExecStop -p ExecCondition -p Requires -p After)"
  "$PYTHON_BIN" - "$properties" "$PM2_DROPIN" <<'PY'
import sys
body, expected_dropin = sys.argv[1:]
properties = {}
for line in body.splitlines():
    key, separator, value = line.partition("=")
    if not separator or key in properties:
        raise SystemExit("PM2 effective property output is invalid")
    properties[key] = value
if (
    properties.get("Type") != "forking"
    or properties.get("User") != "dominguez"
    or properties.get("Group") != "dominguez"
    or expected_dropin not in properties.get("DropInPaths", "").split()
    or "/usr/local/bin/pm2 resurrect" not in properties.get("ExecStart", "")
    or "nexus-release-promotion-control boot-postcheck" not in properties.get("ExecStartPost", "")
    or "/usr/local/bin/pm2 kill" not in properties.get("ExecStop", "")
    or "nexus-release-layout-activation-control assert-boot-safe"
        not in properties.get("ExecCondition", "")
    or "nexus-release-layout-recovery.service" not in properties.get("Requires", "").split()
    or "nexus-release-promotion-recovery.service" not in properties.get("Requires", "").split()
    or "nexus-release-layout-recovery.service" not in properties.get("After", "").split()
):
    raise SystemExit("PM2 effective handover differs")
PY
  properties="$("$SYSTEMCTL_BIN" show --no-pager nexus-cloudflared.service \
    -p DropInPaths -p Requires -p After)"
  "$PYTHON_BIN" - "$properties" "$INGRESS_DROPIN" <<'PY'
import sys
body, expected_dropin = sys.argv[1:]
properties = {}
for line in body.splitlines():
    key, separator, value = line.partition("=")
    if not separator or key in properties:
        raise SystemExit("ingress effective property output is invalid")
    properties[key] = value
if (
    expected_dropin not in properties.get("DropInPaths", "").split()
    or "pm2-dominguez.service" not in properties.get("Requires", "").split()
    or "pm2-dominguez.service" not in properties.get("After", "").split()
):
    raise SystemExit("ingress effective handover differs")
PY
}

phase_b() {
  [ "$#" -eq 5 ] || { usage >&2; exit 64; }
  local source_root="$1" source_sha="$2" source_archive="$3" archive_sha="$4"
  local expected_attestation_sha="$5" actual_attestation_sha receipt_tmp
  local service_before="" service_after=""
  validate_source "$source_root" "$source_sha" "$source_archive" "$archive_sha"
  [[ "$expected_attestation_sha" =~ ^[a-f0-9]{64}$ ]] \
    || die "layout attestation digest is invalid"
  [ -f "$PHASE_A_RECEIPT" ] && [ ! -L "$PHASE_A_RECEIPT" ] \
    || die "Phase A receipt is unavailable"
  assert_phase_a_safe
  "$NODE_BIN" - "$PHASE_A_RECEIPT" "$source_sha" "$archive_sha" <<'NODE' \
    || die "Phase A receipt belongs to a different protected source"
const fs=require('fs');
const [receiptFile,sourceSha,archiveSha]=process.argv.slice(2);
const receipt=JSON.parse(fs.readFileSync(receiptFile));
if(receipt.schema!=='nexus.release-layout-phase-a-receipt.v1'
 ||receipt.status!=='completed'
 ||receipt.sourceSha!==sourceSha
 ||receipt.sourceArchiveSha256!==archiveSha)process.exit(1);
NODE
  [ ! -e "$PHASE_B_RECEIPT" ] && [ ! -L "$PHASE_B_RECEIPT" ] \
    || die "Phase B was already completed"
  [ ! -e "$PHASE_B_JOURNAL" ] && [ ! -L "$PHASE_B_JOURNAL" ] \
    || die "Phase B recovery is required before a new handover"
  [ -f "$LAYOUT_ATTESTATION" ] && [ ! -L "$LAYOUT_ATTESTATION" ] \
    || die "successful layout attestation is unavailable"
  actual_attestation_sha="$(sha256sum -- "$LAYOUT_ATTESTATION" | cut -d' ' -f1)"
  [ "$actual_attestation_sha" = "$expected_attestation_sha" ] \
    || die "layout attestation digest differs"
  "$PROMOTION_CONTROL" assert-layout-ready >/dev/null
  acquire_phase_locks
  assert_legacy_install_state_safe
  [ ! -e "$STATE_ROOT/active.json" ] && [ ! -L "$STATE_ROOT/active.json" ] \
    || die "ordinary promotion became active before Phase B"
  [ "$(sha256sum -- "$LAYOUT_ATTESTATION" | cut -d' ' -f1)" \
      = "$expected_attestation_sha" ] \
    || die "layout attestation changed before Phase B mutation"
  assert_legacy_terminal_journals
  service_before="$(mktemp "$ACTIVATION_ROOT/.phase-b-before.XXXXXXXX")"
  service_after="$(mktemp "$ACTIVATION_ROOT/.phase-b-after.XXXXXXXX")"
  capture_service_identity "$service_before"

  phase_b_failure() {
    local status="${1:-$?}" recovery_status
    trap - ERR INT TERM HUP EXIT
    if [ "$status" -ne 0 ] \
        && { [ -e "$PHASE_B_JOURNAL" ] || [ -L "$PHASE_B_JOURNAL" ]; }; then
      set +e
      (
        set -euo pipefail
        restore_handover
      )
      recovery_status=$?
      set -e
      [ "$recovery_status" -eq 0 ] || exit "$recovery_status"
    fi
    [ -z "$service_before" ] || rm -f -- "$service_before"
    [ -z "$service_after" ] || rm -f -- "$service_after"
    exit "$status"
  }
  trap 'phase_b_failure $?' ERR
  trap 'phase_b_failure 130' INT
  trap 'phase_b_failure 143' TERM
  trap 'phase_b_failure 129' HUP
  trap 'phase_b_failure $?' EXIT
  write_handover_journal "$source_sha" "$archive_sha" "$expected_attestation_sha"
  publish_pm2_handover
  publish_ingress_handover
  "$SYSTEMCTL_BIN" daemon-reload
  verify_handover
  capture_service_identity "$service_after"
  "$NODE_BIN" - "$service_before" "$service_after" <<'NODE'
const fs=require('fs');const [beforeFile,afterFile]=process.argv.slice(2);
const before=JSON.parse(fs.readFileSync(beforeFile));
const after=JSON.parse(fs.readFileSync(afterFile));
if(!/^[a-f0-9]{64}$/u.test(before.runtimeSha256??'')
 ||before.runtimeSha256!==after.runtimeSha256
 ||JSON.stringify(before.runtime)!==JSON.stringify(after.runtime))process.exit(1);
NODE
  receipt_tmp="$(mktemp "$ACTIVATION_ROOT/.phase-b-receipt.XXXXXXXX")"
  "$NODE_BIN" - "$receipt_tmp" "$source_sha" "$archive_sha" \
    "$expected_attestation_sha" "$PHASE_A_RECEIPT" "$service_before" \
    "$service_after" "$PM2_DROPIN" "$INGRESS_DROPIN" <<'NODE'
const crypto=require('crypto');const fs=require('fs');
const [output,sourceSha,archiveSha,attestationSha,phaseA,beforeFile,afterFile,
 ...targets]=process.argv.slice(2);
const sha=(file)=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const before=JSON.parse(fs.readFileSync(beforeFile));
const after=JSON.parse(fs.readFileSync(afterFile));
if(before.runtimeSha256!==after.runtimeSha256
 ||JSON.stringify(before.runtime)!==JSON.stringify(after.runtime))process.exit(1);
fs.writeFileSync(output,`${JSON.stringify({
 schema:'nexus.release-layout-phase-b-receipt.v1',status:'completed',
 sourceSha,sourceArchiveSha256:archiveSha,layoutAttestationSha256:attestationSha,
 phaseAReceiptSha256:sha(phaseA),completedAt:new Date().toISOString(),
 runningServiceIdentity:{runtimeUnchanged:true,beforeSha256:before.sha256,
  afterSha256:after.sha256,runtimeSha256:after.runtimeSha256,
  before:before.runtime,after:after.runtime},
 handoverTargets:targets.map((path)=>({path,sha256:sha(path)})),
 serviceRestarted:false,ingressRestarted:false,rebootRequired:true,
},null,2)}\n`,{mode:0o600,flag:'w'});
NODE
  chmod 600 "$receipt_tmp"; root_own "$receipt_tmp"; fsync_path "$receipt_tmp"
  replace_file "$receipt_tmp" "$PHASE_B_RECEIPT"; fsync_path "$ACTIVATION_ROOT"
  "$NODE_BIN" - "$PHASE_B_JOURNAL" <<'NODE'
const fs=require('fs');const file=process.argv[2];const current=JSON.parse(fs.readFileSync(file));
if(current.schema!=='nexus.release-layout-phase-b-journal.v1'
 ||current.status!=='in_progress')process.exit(1);
const temporary=`${file}.next.${process.pid}`;
fs.writeFileSync(temporary,`${JSON.stringify({...current,status:'committed',
 committedAt:new Date().toISOString()},null,2)}\n`,{mode:0o600,flag:'wx'});
const descriptor=fs.openSync(temporary,'r');try{fs.fsyncSync(descriptor);}finally{fs.closeSync(descriptor);}
fs.renameSync(temporary,file);
NODE
  fsync_path "$PHASE_B_JOURNAL"
  fsync_path "$ACTIVATION_ROOT"
  # A reappearing committed journal is finalized only after its durable
  # receipt is revalidated; no fallible durability step follows this unlink.
  rm -f -- "$PHASE_B_JOURNAL"
  trap - ERR INT TERM HUP EXIT
  rm -f -- "$service_before" "$service_after"
  printf '{"ok":true,"schema":"%s","phase":"phase_b","status":"completed","rebootRequired":true}\n' \
    "$VERSION"
}

recover_handover() {
  if [ ! -e "$PHASE_B_JOURNAL" ] && [ ! -L "$PHASE_B_JOURNAL" ]; then
    printf '{"ok":true,"schema":"%s","status":"idle"}\n' "$VERSION"
    return
  fi
  restore_handover
  printf '{"ok":true,"schema":"%s","status":"recovered"}\n' "$VERSION"
}

status() {
  "$NODE_BIN" - "$PHASE_A_RECEIPT" "$PHASE_B_RECEIPT" \
    "$PHASE_B_JOURNAL" "$VERSION" <<'NODE'
const fs=require('fs');const [phaseA,phaseB,journal,schema]=process.argv.slice(2);
const read=(file)=>{try{return JSON.parse(fs.readFileSync(file));}catch{return null;}};
const a=read(phaseA),b=read(phaseB),j=read(journal);
process.stdout.write(`${JSON.stringify({ok:true,schema,
 phaseA:a?.status??'not_installed',phaseB:b?.status??(j?'recovery_required':'not_completed'),
 sourceSha:b?.sourceSha??a?.sourceSha??null,rebootRequired:b?.rebootRequired===true})}\n`);
NODE
}

case "$COMMAND" in
  phase-a) phase_a "$@" ;;
  phase-b) phase_b "$@" ;;
  recover-phase-a)
    [ "$#" -eq 0 ] || exit 64
    if [ "${NEXUS_RELEASE_TEST_MODE:-0}" = 1 ]; then
      [ -e "$CONTROL_LOCK" ] || : >"$CONTROL_LOCK"
      if [ ! -e "$RELEASE_SONAR_LOCK" ]; then
        install -d -m 700 "$(dirname -- "$RELEASE_SONAR_LOCK")"
        : >"$RELEASE_SONAR_LOCK"
      fi
    fi
    acquire_phase_locks
    assert_legacy_install_state_safe
    recover_phase_a
    ;;
  assert-phase-a-safe) [ "$#" -eq 0 ] || exit 64; assert_phase_a_safe ;;
  recover-handover)
    [ "$#" -eq 0 ] || exit 64
    acquire_phase_locks
    assert_legacy_install_state_safe
    recover_handover
    ;;
  status) [ "$#" -eq 0 ] || exit 64; status ;;
  version) [ "$#" -eq 0 ] || exit 64; printf '%s\n' "$VERSION" ;;
  test-validate-legacy-retirement-plan)
    [ "${NEXUS_RELEASE_TEST_MODE:-0}" = 1 ] && [ "$#" -eq 3 ] || exit 64
    validate_legacy_retirement_plan "$1" "$2" "$3"
    ;;
  test-apply-and-record-legacy-retirement)
    [ "${NEXUS_RELEASE_TEST_MODE:-0}" = 1 ] && [ "$#" -eq 0 ] || exit 64
    apply_legacy_retirement_plan
    retire_legacy_adapter
    ;;
  *) usage >&2; exit 64 ;;
esac
