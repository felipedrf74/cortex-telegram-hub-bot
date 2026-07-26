#!/usr/bin/env bash
# Provision a fixed three-guest, KVM-backed rollback-drill set from Canonical's
# signed Ubuntu 24.04 cloud image. This command never starts or enables a VM.
set -euo pipefail
umask 077
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

STATE_ROOT="/var/lib/nexus-rollback-drill-vm"
BASE_DIR="$STATE_ROOT/base"
SETS_DIR="$STATE_ROOT/sets"
ACTIVE_RECEIPT="$STATE_ROOT/active.json"
LAYOUT_TRUST_MANIFEST="$STATE_ROOT/release-layout-evidence-trust.v1.json"
INSTALL_JOURNAL="$STATE_ROOT/install-in-progress.v1"
PROVISION_JOURNAL="$STATE_ROOT/provision-in-progress.v1"
CONTROL_LOCK="$STATE_ROOT/control.lock"
EXPECTED_USER="nexus-drill-vm"
IMAGE_ORIGIN="https://cloud-images.ubuntu.com/noble/current"
IMAGE_FILENAME="noble-server-cloudimg-amd64.img"
KEYRING="/usr/share/keyrings/ubuntu-cloudimage-keyring.gpg"
MANIFEST_HELPER="/usr/local/libexec/nexus-rollback-drill-vm/manifest.py"
RUNNER="/usr/local/libexec/nexus-rollback-drill-vm/run"
HOST_PREFLIGHT="/usr/local/libexec/nexus-rollback-drill-vm/host-preflight"
RUNTIME_MANIFEST="/usr/local/libexec/nexus-rollback-drill-vm/runtime-manifest"
RUNTIME_CONTROL_SOURCE="/usr/local/libexec/nexus-rollback-drill-vm/runtime-control-guest"
RUNTIME_READINESS="/usr/local/libexec/nexus-rollback-drill-vm/runtime-readiness"
RUNTIME_RECOVERY_UNIT_SOURCE="/usr/local/libexec/nexus-rollback-drill-vm/runtime-recovery.service"
FAULT_DRILL_CONTROLLER="/usr/local/libexec/nexus-rollback-drill-vm/release-layout-fault-controller"
FAULT_DRILL_GUEST_SOURCE="/usr/local/libexec/nexus-rollback-drill-vm/release-layout-fault-guest"
FAULT_DRILL_VERIFIER="/usr/local/libexec/nexus-rollback-drill-vm/release-layout-fault-drill.mjs"
FAULT_DRILL_GUEST_RECOVERY_UNIT_SOURCE="/usr/local/libexec/nexus-rollback-drill-vm/release-layout-fault-guest-recovery.service"
FAULT_DRILL_CONTROLLER_UNIT="/etc/systemd/system/nexus-release-layout-fault-drill@.service"
FAULT_DRILL_CONTROLLER_RECOVERY_UNIT="/etc/systemd/system/nexus-release-layout-fault-drill-recovery.service"
UNIT_PATH="/etc/systemd/system/nexus-rollback-drill-vm@.service"
SHARED_MUTEX="/run/lock/nexus-release-sonar.lock"
QEMU_IMG="/usr/bin/qemu-img"
QEMU_BIN="/usr/bin/qemu-system-x86_64"
CLOUD_LOCALDS="/usr/bin/cloud-localds"
CURL="/usr/bin/curl"
GPGV="/usr/bin/gpgv"
DPKG_QUERY="/usr/bin/dpkg-query"
OPENSSL="/usr/bin/openssl"
UNIT_TEMPLATE="nexus-rollback-drill-vm@.service"
UNIT_TEMPLATE_PROBE="nexus-rollback-drill-vm@guest-1.service"

die() {
  echo "rollback drill VM provisioner: $*" >&2
  exit 1
}

# BEGIN nexus.rollback-drill-vm-set-id.v2
derive_set_id() {
  [ "$#" -eq 24 ] || return 64
  printf 'schema=nexus.rollback-drill-vm-provision.v2\nimage=%s\nkey=%s\nhostKeys=%s\nports=%s,%s,%s\nrunner=%s\nhostPreflight=%s\nruntimeManifest=%s\nruntimeControl=%s\nruntimeReadiness=%s\nruntimeRecoveryUnit=%s\nfaultDrillController=%s\nfaultDrillControllerUnit=%s\nfaultDrillControllerRecoveryUnit=%s\nfaultDrillGuest=%s\nfaultDrillGuestRecoveryUnit=%s\nfaultDrillVerifier=%s\nunit=%s\nqemu=%s\nqemuVersion=%s\nqemuPackage=%s\nqemuPackageVersion=%s\nqemuPackageArchitecture=%s\n' \
    "$@" | sha256sum | cut -d' ' -f1
}
# END nexus.rollback-drill-vm-set-id.v2

usage() {
  cat <<'USAGE'
Usage:
  sudo /usr/local/libexec/nexus-rollback-drill-vm/provision \
    --expected-image-sha256 <64-lowercase-hex> \
    --expected-image-size <owner-reviewed-bytes> \
    --ssh-public-key <root-owned-ed25519-public-key> \
    --ports <port1,port2,port3> \
    [--staged-source-directory <unprivileged-directory>] \
    --acknowledge-isolated-drill-only
USAGE
}

[ "$(id -u)" -eq 0 ] || die "must run as root"
for command in cat chgrp chmod chown cut date dirname find flock getent id \
  install mktemp mv python3 realpath rm rmdir sed sha256sum sort ssh-keygen \
  stat systemctl tr; do
  command -v "$command" >/dev/null 2>&1 || die "$command is required"
done
for executable in "$QEMU_IMG" "$QEMU_BIN" "$CLOUD_LOCALDS" "$CURL" "$GPGV" \
  "$DPKG_QUERY" "$OPENSSL"; do
  [[ -x "$executable" && ! -L "$executable" ]] \
    || die "required executable is missing or unsafe: $executable"
done
[[ -f "$MANIFEST_HELPER" && ! -L "$MANIFEST_HELPER" ]] \
  || die "installed manifest helper is missing or unsafe"

fsync_path() {
  python3 - "$1" <<'PY'
import os
import sys
descriptor = os.open(sys.argv[1], os.O_RDONLY)
try:
    os.fsync(descriptor)
finally:
    os.close(descriptor)
PY
}

read_systemd_unit_state() {
  local unit="$1" output rc line key value
  local load_seen=false active_seen=false unit_file_seen=false
  SYSTEMD_LOAD_STATE=""
  SYSTEMD_ACTIVE_STATE=""
  SYSTEMD_UNIT_FILE_STATE=""
  if output="$(systemctl show --no-pager \
      --property=LoadState \
      --property=ActiveState \
      --property=UnitFileState \
      -- "$unit" 2>&1)"; then
    rc=0
  else
    rc=$?
  fi
  [ "$rc" -eq 0 ] \
    || die "systemd state query failed for $unit (exit $rc): $output"
  while IFS= read -r line; do
    key="${line%%=*}"
    value="${line#*=}"
    [ "$line" != "$key" ] || die "systemd returned malformed state for $unit"
    case "$key" in
      LoadState)
        [ "$load_seen" = false ] || die "systemd repeated LoadState for $unit"
        load_seen=true
        SYSTEMD_LOAD_STATE="$value"
        ;;
      ActiveState)
        [ "$active_seen" = false ] || die "systemd repeated ActiveState for $unit"
        active_seen=true
        SYSTEMD_ACTIVE_STATE="$value"
        ;;
      UnitFileState)
        [ "$unit_file_seen" = false ] || die "systemd repeated UnitFileState for $unit"
        unit_file_seen=true
        SYSTEMD_UNIT_FILE_STATE="$value"
        ;;
      *) die "systemd returned an unexpected property for $unit: $key" ;;
    esac
  done <<<"$output"
  [ "$load_seen" = true ] && [ "$active_seen" = true ] && [ "$unit_file_seen" = true ] \
    && [ -n "$SYSTEMD_LOAD_STATE" ] && [ -n "$SYSTEMD_ACTIVE_STATE" ] \
    || die "systemd state response is incomplete for $unit"
}

assert_guest_unit_inactive() {
  local unit="$1"
  read_systemd_unit_state "$unit"
  [ "$SYSTEMD_LOAD_STATE" = loaded ] \
    || die "guest service is not loaded: $unit ($SYSTEMD_LOAD_STATE)"
  [ "$SYSTEMD_ACTIVE_STATE" = inactive ] \
    || die "guest service is not safely inactive: $unit ($SYSTEMD_ACTIVE_STATE)"
}

assert_template_static() {
  # systemd rejects a bare template name for `show` on supported Ubuntu
  # hosts. Query one fixed instance to inspect the template without starting it.
  read_systemd_unit_state "$UNIT_TEMPLATE_PROBE"
  [ "$SYSTEMD_LOAD_STATE" = loaded ] \
    && [ "$SYSTEMD_ACTIVE_STATE" = inactive ] \
    && [ "$SYSTEMD_UNIT_FILE_STATE" = static ] \
    || die "guest template must be loaded, inactive, and static"
}

validate_root_trusted_path() {
  local candidate="$1" label="$2" expected_type="$3" current owner mode
  [[ "$candidate" == /* && "$candidate" != / && ! -L "$candidate" ]] \
    || die "$label must be an absolute non-symlink path"
  case "$expected_type" in
    directory) [ -d "$candidate" ] || die "$label must be a directory" ;;
    file) [ -f "$candidate" ] || die "$label must be a regular file" ;;
    *) die "root path validator misuse" ;;
  esac
  current="$(realpath -e -- "$candidate")"
  [ "$current" = "$candidate" ] || die "$label must not traverse symlinks"
  while :; do
    owner="$(stat -c '%U:%G' -- "$current")"
    mode="$(stat -c '%a' -- "$current")"
    [ "$owner" = root:root ] || die "$label path component is not root-owned: $current"
    (( (8#$mode & 0022) == 0 )) \
      || die "$label path component is group/world writable: $current"
    [ "$current" = / ] && break
    current="$(dirname -- "$current")"
  done
}

expected_image_sha256=""
expected_image_size=""
ssh_public_key=""
ports_csv=""
staged_source_directory=""
acknowledged=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    --expected-image-sha256)
      [ "$#" -ge 2 ] || die "--expected-image-sha256 requires a value"
      [ -z "$expected_image_sha256" ] || die "--expected-image-sha256 was repeated"
      expected_image_sha256="$2"
      shift 2
      ;;
    --expected-image-size)
      [ "$#" -ge 2 ] || die "--expected-image-size requires a value"
      [ -z "$expected_image_size" ] || die "--expected-image-size was repeated"
      expected_image_size="$2"
      shift 2
      ;;
    --ssh-public-key)
      [ "$#" -ge 2 ] || die "--ssh-public-key requires a value"
      [ -z "$ssh_public_key" ] || die "--ssh-public-key was repeated"
      ssh_public_key="$2"
      shift 2
      ;;
    --ports)
      [ "$#" -ge 2 ] || die "--ports requires a value"
      [ -z "$ports_csv" ] || die "--ports was repeated"
      ports_csv="$2"
      shift 2
      ;;
    --staged-source-directory)
      [ "$#" -ge 2 ] || die "--staged-source-directory requires a value"
      [ -z "$staged_source_directory" ] || die "--staged-source-directory was repeated"
      staged_source_directory="$2"
      shift 2
      ;;
    --acknowledge-isolated-drill-only)
      [ "$acknowledged" = false ] || die "isolation acknowledgement was repeated"
      acknowledged=true
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      die "unknown argument: $1"
      ;;
  esac
done
[ "$acknowledged" = true ] \
  || die "explicit --acknowledge-isolated-drill-only is required"
[[ "$expected_image_sha256" =~ ^[0-9a-f]{64}$ ]] \
  || die "owner-reviewed image SHA-256 is invalid"
[[ "$expected_image_size" =~ ^[0-9]+$ ]] \
  && [ "$expected_image_size" -ge 1048576 ] \
  && [ "$expected_image_size" -le 17179869184 ] \
  || die "owner-reviewed image byte size is invalid"
[ -n "$ssh_public_key" ] || die "dedicated lab SSH public key is required"
validate_root_trusted_path "$ssh_public_key" "lab SSH public key" file
validate_root_trusted_path "$KEYRING" "Ubuntu cloud-image keyring" file
validate_root_trusted_path "$MANIFEST_HELPER" "installed manifest helper" file
validate_root_trusted_path "$RUNNER" "installed VM runner" file
validate_root_trusted_path "$HOST_PREFLIGHT" "installed host preflight" file
validate_root_trusted_path "$RUNTIME_MANIFEST" "installed runtime manifest helper" file
validate_root_trusted_path "$RUNTIME_CONTROL_SOURCE" "installed guest runtime control" file
validate_root_trusted_path "$RUNTIME_READINESS" "installed runtime readiness collector" file
validate_root_trusted_path "$RUNTIME_RECOVERY_UNIT_SOURCE" "installed guest runtime recovery unit" file
validate_root_trusted_path "$FAULT_DRILL_CONTROLLER" "installed fault-drill controller" file
validate_root_trusted_path "$FAULT_DRILL_GUEST_SOURCE" "installed guest fault executor" file
validate_root_trusted_path "$FAULT_DRILL_VERIFIER" "installed fault-drill verifier" file
validate_root_trusted_path "$FAULT_DRILL_GUEST_RECOVERY_UNIT_SOURCE" "installed guest fault recovery unit" file
validate_root_trusted_path "$FAULT_DRILL_CONTROLLER_UNIT" "installed fault-drill controller unit" file
validate_root_trusted_path "$FAULT_DRILL_CONTROLLER_RECOVERY_UNIT" "installed fault-drill controller recovery unit" file
validate_root_trusted_path "$UNIT_PATH" "installed VM unit" file
validate_root_trusted_path "$QEMU_BIN" "QEMU system emulator" file
runner_sha256="$(sha256sum -- "$RUNNER" | cut -d' ' -f1)"
host_preflight_sha256="$(sha256sum -- "$HOST_PREFLIGHT" | cut -d' ' -f1)"
runtime_manifest_sha256="$(sha256sum -- "$RUNTIME_MANIFEST" | cut -d' ' -f1)"
runtime_control_sha256="$(sha256sum -- "$RUNTIME_CONTROL_SOURCE" | cut -d' ' -f1)"
runtime_readiness_sha256="$(sha256sum -- "$RUNTIME_READINESS" | cut -d' ' -f1)"
runtime_recovery_unit_sha256="$(sha256sum -- "$RUNTIME_RECOVERY_UNIT_SOURCE" | cut -d' ' -f1)"
fault_drill_controller_sha256="$(sha256sum -- "$FAULT_DRILL_CONTROLLER" | cut -d' ' -f1)"
fault_drill_guest_sha256="$(sha256sum -- "$FAULT_DRILL_GUEST_SOURCE" | cut -d' ' -f1)"
fault_drill_verifier_sha256="$(sha256sum -- "$FAULT_DRILL_VERIFIER" | cut -d' ' -f1)"
fault_drill_guest_recovery_unit_sha256="$(
  sha256sum -- "$FAULT_DRILL_GUEST_RECOVERY_UNIT_SOURCE" | cut -d' ' -f1
)"
fault_drill_controller_unit_sha256="$(
  sha256sum -- "$FAULT_DRILL_CONTROLLER_UNIT" | cut -d' ' -f1
)"
fault_drill_controller_recovery_unit_sha256="$(
  sha256sum -- "$FAULT_DRILL_CONTROLLER_RECOVERY_UNIT" | cut -d' ' -f1
)"
unit_sha256="$(sha256sum -- "$UNIT_PATH" | cut -d' ' -f1)"
qemu_sha256="$(sha256sum -- "$QEMU_BIN" | cut -d' ' -f1)"
qemu_version="$(
  "$QEMU_BIN" --version | python3 -c '
import re
import sys
lines = sys.stdin.read().splitlines()
if not lines or re.fullmatch(r"QEMU emulator version [ -~]{1,230}", lines[0]) is None:
    raise SystemExit("QEMU version output is invalid")
print(lines[0])
'
)" || die "cannot derive the installed QEMU version"
qemu_package="$(
  "$DPKG_QUERY" --search "$QEMU_BIN" | python3 -c '
import re
import sys
path = sys.argv[1]
suffix = ": " + path
matches = []
for line in sys.stdin.read().splitlines():
    if line.endswith(suffix):
        package = line[:-len(suffix)]
        if re.fullmatch(r"[a-z0-9][a-z0-9+.-]*(?::[a-z0-9][a-z0-9-]*)?", package):
            matches.append(package)
if len(matches) != 1:
    raise SystemExit("QEMU binary must have exactly one owning package")
print(matches[0])
' "$QEMU_BIN"
)" || die "cannot resolve the installed QEMU package"
qemu_package_record="$(
  "$DPKG_QUERY" --show \
    --showformat='${binary:Package}\t${Version}\t${Architecture}\n' \
    "$qemu_package"
)" || die "cannot query the installed QEMU package"
IFS=$'\t' read -r qemu_package_name qemu_package_version qemu_package_architecture qemu_package_extra \
  <<<"$qemu_package_record"
[ -z "${qemu_package_extra:-}" ] \
  && [ "$qemu_package_name" = "$qemu_package" ] \
  && [[ "$qemu_package_version" =~ ^[A-Za-z0-9.+:~_-]+$ ]] \
  && [[ "$qemu_package_architecture" =~ ^[a-z0-9][a-z0-9-]*$ ]] \
  || die "installed QEMU package identity is invalid"

normalized_key="$(
  python3 - "$ssh_public_key" <<'PY'
import base64
import binascii
import sys
from pathlib import Path

try:
    text = Path(sys.argv[1]).read_text(encoding="ascii", errors="strict")
except (OSError, UnicodeError) as error:
    raise SystemExit(f"cannot read lab SSH public key: {error}")
lines = text.splitlines()
if len(lines) != 1:
    raise SystemExit("lab SSH public key must contain exactly one line")
fields = lines[0].split()
if len(fields) not in (2, 3) or fields[0] != "ssh-ed25519":
    raise SystemExit("lab SSH public key must be one option-free Ed25519 key")
try:
    decoded = base64.b64decode(fields[1], validate=True)
except binascii.Error:
    raise SystemExit("lab SSH public key base64 is invalid")
if len(decoded) < 32 or len(decoded) > 4096:
    raise SystemExit("lab SSH public key payload is outside the accepted bound")
print(f"{fields[0]} {fields[1]}")
PY
)" || die "lab SSH public key is invalid"
ssh-keygen -l -E sha256 -f "$ssh_public_key" >/dev/null \
  || die "lab SSH public key is not accepted by OpenSSH"
ssh_public_key_sha256="$(
  printf '%s' "$normalized_key" | sha256sum | cut -d' ' -f1
)"

if [ -n "$staged_source_directory" ]; then
  [[ "$staged_source_directory" == /* && "$staged_source_directory" != / && -d "$staged_source_directory" && ! -L "$staged_source_directory" ]] \
    || die "staged source must be an absolute non-symlink directory"
  [ "$(realpath -e -- "$staged_source_directory")" = "$staged_source_directory" ] \
    || die "staged source must not traverse symlinks"
fi

IFS=, read -r port1 port2 port3 extra <<<"$ports_csv"
[ -z "${extra:-}" ] && [ -n "${port1:-}" ] && [ -n "${port2:-}" ] && [ -n "${port3:-}" ] \
  || die "exactly three comma-separated ports are required"
ports=("$port1" "$port2" "$port3")
for port in "${ports[@]}"; do
  [[ "$port" =~ ^[0-9]+$ ]] \
    && [ "$port" -ge 1024 ] && [ "$port" -le 65535 ] \
    || die "each port must be an integer from 1024 through 65535"
done
[ "$port1" != "$port2" ] && [ "$port1" != "$port3" ] && [ "$port2" != "$port3" ] \
  || die "guest ports must be unique"

[[ -c /dev/kvm && -r /dev/kvm && -w /dev/kvm ]] \
  || die "/dev/kvm is unavailable to root"
getent group kvm >/dev/null 2>&1 || die "kvm group is missing"
getent passwd "$EXPECTED_USER" >/dev/null 2>&1 \
  || die "dedicated nexus-drill-vm account is missing; run the installer first"
IFS=: read -r account _ uid gid _ home shell < <(getent passwd "$EXPECTED_USER")
[ "$account" = "$EXPECTED_USER" ] \
  && [[ "$uid" =~ ^[0-9]+$ && "$uid" -gt 0 ]] \
  && [[ "$gid" =~ ^[0-9]+$ && "$gid" -gt 0 ]] \
  && [ "$home" = /nonexistent ] \
  || die "dedicated account identity is invalid"
case "$shell" in
  /usr/sbin/nologin|/sbin/nologin|/bin/false) ;;
  *) die "dedicated account must have a disabled login shell" ;;
esac
mapfile -t actual_groups < <(id -nG "$EXPECTED_USER" | tr ' ' '\n' | sort)
[ "${#actual_groups[@]}" -eq 2 ] \
  && [ "${actual_groups[0]}" = kvm ] \
  && [ "${actual_groups[1]}" = "$EXPECTED_USER" ] \
  || die "dedicated account must belong only to its private group and kvm"

for guest in guest-1 guest-2 guest-3; do
  assert_guest_unit_inactive "nexus-rollback-drill-vm@$guest.service"
done
assert_template_static

[[ -d "$STATE_ROOT" && ! -L "$STATE_ROOT" ]] \
  || die "state root is missing or unsafe; run the installer first"
[ "$(realpath -e -- "$STATE_ROOT")" = "$STATE_ROOT" ] \
  || die "state root must not traverse symlinks"
[ "$(stat -c '%U:%G:%a' -- "$STATE_ROOT")" = root:nexus-drill-vm:750 ] \
  || die "state root must be root:nexus-drill-vm mode 0750"
[[ ! -e "$INSTALL_JOURNAL" && ! -L "$INSTALL_JOURNAL" ]] \
  || die "installer journal is present; owner inspection is required"
[[ ! -e "$PROVISION_JOURNAL" && ! -L "$PROVISION_JOURNAL" ]] \
  || die "provision journal is present; owner inspection is required"
[[ ! -e "$ACTIVE_RECEIPT" && ! -L "$ACTIVE_RECEIPT" ]] \
  || die "an active guest set already exists; replacement is not automatic"
[[ ! -e "$LAYOUT_TRUST_MANIFEST" && ! -L "$LAYOUT_TRUST_MANIFEST" ]] \
  || die "a release-layout evidence trust mapping already exists; replacement is not automatic"

for directory in "$BASE_DIR" "$SETS_DIR"; do
  if [ -L "$directory" ]; then
    die "provision directory is a symlink: $directory"
  elif [ -e "$directory" ]; then
    [[ -d "$directory" && "$(realpath -e -- "$directory")" = "$directory" ]] \
      || die "provision directory is unsafe: $directory"
    [ "$(stat -c '%U:%G:%a' -- "$directory")" = root:nexus-drill-vm:750 ] \
      || die "provision directory must be root:nexus-drill-vm mode 0750: $directory"
  fi
done
[[ -f "$SHARED_MUTEX" && ! -L "$SHARED_MUTEX" ]] \
  || die "shared release/Sonar mutex is missing or unsafe"
[ "$(realpath -e -- "$SHARED_MUTEX")" = "$SHARED_MUTEX" ] \
  && [ "$(stat -c '%U:%G:%a' -- "$SHARED_MUTEX")" = root:dominguez:660 ] \
  || die "shared release/Sonar mutex must be root:dominguez mode 0660"
exec 8<>"$SHARED_MUTEX"
flock -n 8 \
  || die "a release, Sonar operation, or rollback drill holds the shared mutex"

install -d -o root -g "$EXPECTED_USER" -m 0750 "$BASE_DIR" "$SETS_DIR"
fsync_path "$BASE_DIR"
fsync_path "$SETS_DIR"
fsync_path "$STATE_ROOT"
[ -z "$(find "$BASE_DIR" -mindepth 1 -maxdepth 1 -print -quit)" ] \
  || die "base directory is not empty; refusing ambiguous state"
[ -z "$(find "$SETS_DIR" -mindepth 1 -maxdepth 1 -print -quit)" ] \
  || die "guest-set directory is not empty; refusing ambiguous state"

if [ -L "$CONTROL_LOCK" ]; then
  die "provision control lock is a symlink"
elif [ -e "$CONTROL_LOCK" ]; then
  [[ -f "$CONTROL_LOCK" && "$(stat -c '%U:%G:%a' -- "$CONTROL_LOCK")" = root:root:600 ]] \
    || die "provision control lock is unsafe"
fi
exec 9>"$CONTROL_LOCK"
chmod 0600 "$CONTROL_LOCK"
flock -n 9 || die "another rollback-drill install or provision transaction is active"

python3 - "$STATE_ROOT" "$expected_image_size" <<'PY' \
  || die "rollback-drill storage admission failed"
import os
import sys

state_root, image_size_text = sys.argv[1:]
image_size = int(image_size_text)
guard_bytes = 20 * 1024 * 1024 * 1024
metadata_bytes = 4 * 1024 * 1024
required_available = image_size * 2 + guard_bytes + metadata_bytes
storage = os.statvfs(state_root)
available = storage.f_bavail * storage.f_frsize
if available < required_available:
    raise SystemExit(
        f"requires {required_available} available bytes including the 20 GiB host guard; "
        f"observed {available}"
    )
if storage.f_favail < 256:
    raise SystemExit(
        f"requires at least 256 available inodes; observed {storage.f_favail}"
    )
PY

download_dir=""
set_stage=""
set_target=""
active_stage=""
trust_stage=""
base_stage=""
journal_stage=""
base_target="$BASE_DIR/$expected_image_sha256.qcow2"
base_installed=false
set_committed=false
active_committed=false
trust_committed=false
journal_armed=false
transaction_succeeded=false

safe_remove_tree() {
  local target="$1" expected_prefix="$2" canonical
  [ -n "$target" ] || return 0
  canonical="$(realpath -m -- "$target")"
  [[ "$canonical" == "$expected_prefix"* && "$canonical" != "$expected_prefix" ]] \
    || return 1
  rm -rf --one-file-system -- "$canonical"
  fsync_path "$(dirname -- "$canonical")"
}

cleanup_transaction() {
  local rc=$? rollback_failed=false
  trap - EXIT INT TERM
  set +e
  if [ "$transaction_succeeded" != true ]; then
    if [ "$active_committed" = true ]; then
      rm -f -- "$ACTIVE_RECEIPT" && fsync_path "$STATE_ROOT" \
        || rollback_failed=true
    fi
    if [ "$trust_committed" = true ]; then
      rm -f -- "$LAYOUT_TRUST_MANIFEST" && fsync_path "$STATE_ROOT" \
        || rollback_failed=true
    fi
    if [ "$set_committed" = true ]; then
      safe_remove_tree "$set_target" "$SETS_DIR/" || rollback_failed=true
    elif [ -n "$set_stage" ] && [ -e "$set_stage" ]; then
      safe_remove_tree "$set_stage" "$SETS_DIR/.stage." || rollback_failed=true
    fi
    if [ "$base_installed" = true ]; then
      rm -f -- "$base_target" && fsync_path "$BASE_DIR" \
        || rollback_failed=true
    fi
  fi
  if [ -n "$active_stage" ] && [ -e "$active_stage" ]; then
    rm -f -- "$active_stage" && fsync_path "$STATE_ROOT" \
      || rollback_failed=true
  fi
  if [ -n "$trust_stage" ] && [ -e "$trust_stage" ]; then
    rm -f -- "$trust_stage" && fsync_path "$STATE_ROOT" \
      || rollback_failed=true
  fi
  if [ -n "$base_stage" ] && [ -e "$base_stage" ]; then
    rm -f -- "$base_stage" && fsync_path "$BASE_DIR" \
      || rollback_failed=true
  fi
  if [ -n "$journal_stage" ] && [ -e "$journal_stage" ]; then
    rm -f -- "$journal_stage" && fsync_path "$STATE_ROOT" \
      || rollback_failed=true
  fi
  if [ -n "$download_dir" ] && [ -e "$download_dir" ]; then
    safe_remove_tree "$download_dir" "$STATE_ROOT/.download." || rollback_failed=true
  fi
  if [ "$transaction_succeeded" != true ] \
      && [ "$journal_armed" = true ] \
      && [ "$rollback_failed" = false ]; then
    rm -f -- "$PROVISION_JOURNAL" && fsync_path "$STATE_ROOT" \
      || rollback_failed=true
  fi
  if [ "$rollback_failed" = true ]; then
    echo "rollback drill VM provisioner: rollback incomplete; journal remains" >&2
    rc=1
  fi
  exit "$rc"
}
trap cleanup_transaction EXIT
trap 'exit 130' INT TERM

journal_stage="$(mktemp -p "$STATE_ROOT" .provision-journal.XXXXXX)"
printf '%s\n' \
  '{"schema":"nexus.rollback-drill-vm-provision-journal.v1","status":"in_progress"}' \
  >"$journal_stage"
chown root:root "$journal_stage"
chmod 0600 "$journal_stage"
fsync_path "$journal_stage"
mv -fT -- "$journal_stage" "$PROVISION_JOURNAL"
fsync_path "$STATE_ROOT"
journal_armed=true

download_dir="$(mktemp -d -p "$STATE_ROOT" .download.XXXXXX)"
chown root:root "$download_dir"
chmod 0700 "$download_dir"
sums="$download_dir/SHA256SUMS"
signature="$download_dir/SHA256SUMS.gpg"
image="$download_dir/$IMAGE_FILENAME"
copy_untrusted_regular_file() {
  local source_directory="$1" basename="$2" destination="$3" minimum_size="$4" maximum_size="$5"
  python3 - "$source_directory" "$basename" "$destination" "$minimum_size" "$maximum_size" <<'PY'
import os
import stat
import sys

source_directory, basename, destination, minimum_size, maximum_size = sys.argv[1:]
minimum = int(minimum_size)
maximum = int(maximum_size)
if not basename or "/" in basename or "\\" in basename or basename in {".", ".."}:
    raise SystemExit("unsafe staged source basename")
directory_flags = os.O_RDONLY | os.O_DIRECTORY
if hasattr(os, "O_NOFOLLOW"):
    directory_flags |= os.O_NOFOLLOW
directory_fd = os.open(source_directory, directory_flags)
try:
    source_flags = os.O_RDONLY
    if hasattr(os, "O_NOFOLLOW"):
        source_flags |= os.O_NOFOLLOW
    source_fd = os.open(basename, source_flags, dir_fd=directory_fd)
    try:
        before = os.fstat(source_fd)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink < 1:
            raise SystemExit("staged source is not a regular file")
        if before.st_size < minimum or before.st_size > maximum:
            raise SystemExit("staged source size is outside the accepted bound")
        destination_flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
        if hasattr(os, "O_NOFOLLOW"):
            destination_flags |= os.O_NOFOLLOW
        destination_fd = os.open(destination, destination_flags, 0o600)
        try:
            copied = 0
            while True:
                chunk = os.read(source_fd, 1024 * 1024)
                if not chunk:
                    break
                view = memoryview(chunk)
                while view:
                    written = os.write(destination_fd, view)
                    if written <= 0:
                        raise SystemExit("short write while root-copying staged input")
                    view = view[written:]
                copied += len(chunk)
                if copied > maximum:
                    raise SystemExit("staged input grew beyond the accepted bound")
            os.fsync(destination_fd)
        finally:
            os.close(destination_fd)
        after = os.fstat(source_fd)
        if (
            before.st_dev != after.st_dev
            or before.st_ino != after.st_ino
            or before.st_size != after.st_size
            or before.st_mtime_ns != after.st_mtime_ns
            or copied != before.st_size
        ):
            raise SystemExit("staged input changed during the root copy")
    finally:
        os.close(source_fd)
finally:
    os.close(directory_fd)
PY
}

if [ -n "$staged_source_directory" ]; then
  copy_untrusted_regular_file \
    "$staged_source_directory" SHA256SUMS "$sums" 1 2097152
  copy_untrusted_regular_file \
    "$staged_source_directory" SHA256SUMS.gpg "$signature" 1 2097152
  copy_untrusted_regular_file \
    "$staged_source_directory" "$IMAGE_FILENAME" "$image" \
    "$expected_image_size" "$expected_image_size"
else
  curl_args=(
    --disable
    --fail
    --location
    --silent
    --show-error
    --proto =https
    --proto-redir =https
    --tlsv1.2
    --connect-timeout 15
    --max-time 1800
    --remove-on-error
  )
  "$CURL" "${curl_args[@]}" --max-filesize 2097152 \
    --output "$sums" "$IMAGE_ORIGIN/SHA256SUMS"
  "$CURL" "${curl_args[@]}" --max-filesize 2097152 \
    --output "$signature" "$IMAGE_ORIGIN/SHA256SUMS.gpg"
fi
chmod 0600 "$sums" "$signature"
"$GPGV" --keyring "$KEYRING" "$signature" "$sums" \
  || die "Canonical SHA256SUMS signature verification failed"
python3 "$MANIFEST_HELPER" \
  --checksums "$sums" \
  --filename "$IMAGE_FILENAME" \
  --expected-sha256 "$expected_image_sha256" \
  >/dev/null
if [ -z "$staged_source_directory" ]; then
  "$CURL" "${curl_args[@]}" --max-filesize "$expected_image_size" \
    --output "$image" "$IMAGE_ORIGIN/$IMAGE_FILENAME"
fi
chmod 0600 "$image"
[ "$(stat -c '%s' -- "$image")" = "$expected_image_size" ] \
  || die "image byte size differs from the owner-reviewed value"
printf '%s  %s\n' "$expected_image_sha256" "$image" | sha256sum --check --status \
  || die "downloaded image digest differs from the verified signed manifest"
"$QEMU_IMG" check -q -- "$image" || die "downloaded qcow2 structural check failed"
image_info="$("$QEMU_IMG" info --output=json -- "$image")" \
  || die "cannot inspect downloaded image"
python3 - "$image_info" <<'PY' || die "downloaded image is not the expected standalone qcow2 format"
import json
import sys
value = json.loads(sys.argv[1])
if value.get("format") != "qcow2":
    raise SystemExit(1)
if value.get("backing-filename") is not None or value.get("full-backing-filename") is not None:
    raise SystemExit(1)
virtual_size = value.get("virtual-size")
if type(virtual_size) is not int or virtual_size <= 0 or virtual_size > 100 * 1024 * 1024 * 1024:
    raise SystemExit(1)
PY

base_stage="$(mktemp -p "$BASE_DIR" .base.XXXXXX)"
install -o root -g "$EXPECTED_USER" -m 0440 -- "$image" "$base_stage"
fsync_path "$base_stage"
mv -fT -- "$base_stage" "$base_target"
base_stage=""
fsync_path "$BASE_DIR"
base_installed=true
[ "$(stat -c '%U:%G:%a' -- "$base_target")" = root:nexus-drill-vm:440 ] \
  || die "installed base image ownership or mode is unsafe"
printf '%s  %s\n' "$expected_image_sha256" "$base_target" | sha256sum --check --status \
  || die "installed base image digest drifted"

declare -a guest_host_private_keys=()
declare -a guest_host_public_keys=()
declare -a guest_host_public_key_sha256s=()
declare -a guest_host_key_fingerprints=()
for index in 1 2 3; do
  guest_host_key="$download_dir/ssh_host_ed25519_key_guest_$index"
  guest_host_key_public="$guest_host_key.pub"
  ssh-keygen -q -t ed25519 -N '' -C '' -f "$guest_host_key" \
    || die "cannot create the guest-$index SSH host key"
  chmod 0600 "$guest_host_key" "$guest_host_key_public"
  guest_host_public_key="$(cut -d' ' -f1-2 "$guest_host_key_public")"
  [[ "$guest_host_public_key" =~ ^ssh-ed25519\ [A-Za-z0-9+/=]+$ ]] \
    || die "guest-$index SSH host public key is invalid"
  guest_host_public_key_sha256="$(
    printf '%s' "$guest_host_public_key" | sha256sum | cut -d' ' -f1
  )"
  [[ "$guest_host_public_key_sha256" =~ ^[0-9a-f]{64}$ ]] \
    || die "cannot derive guest-$index SSH host public-key digest"
  guest_host_key_fingerprint="$(
    ssh-keygen -l -E sha256 -f "$guest_host_key_public" | cut -d' ' -f2
  )"
  [[ "$guest_host_key_fingerprint" =~ ^SHA256:[A-Za-z0-9+/]{43}$ ]] \
    || die "guest-$index SSH host-key fingerprint is invalid"
  [ "$guest_host_public_key_sha256" != "$ssh_public_key_sha256" ] \
    || die "lab SSH client and guest-$index host identities must be independent"
  guest_host_private_keys+=("$guest_host_key")
  guest_host_public_keys+=("$guest_host_public_key")
  guest_host_public_key_sha256s+=("$guest_host_public_key_sha256")
  guest_host_key_fingerprints+=("$guest_host_key_fingerprint")
done
[ "$(printf '%s\n' "${guest_host_public_key_sha256s[@]}" | sort -u | wc -l)" -eq 3 ] \
  || die "each rollback-drill guest must have a distinct SSH host key"
guest_host_key_set="$(
  IFS=,
  printf '%s' "${guest_host_public_key_sha256s[*]}"
)"

set_id="$(derive_set_id \
  "$expected_image_sha256" "$ssh_public_key_sha256" "$guest_host_key_set" \
  "$port1" "$port2" "$port3" \
  "$runner_sha256" "$host_preflight_sha256" \
  "$runtime_manifest_sha256" "$runtime_control_sha256" \
  "$runtime_readiness_sha256" "$runtime_recovery_unit_sha256" \
  "$fault_drill_controller_sha256" "$fault_drill_controller_unit_sha256" \
  "$fault_drill_controller_recovery_unit_sha256" \
  "$fault_drill_guest_sha256" "$fault_drill_guest_recovery_unit_sha256" \
  "$fault_drill_verifier_sha256" \
  "$unit_sha256" "$qemu_sha256" "$qemu_version" \
  "$qemu_package_name" "$qemu_package_version" "$qemu_package_architecture")"
[[ "$set_id" =~ ^[0-9a-f]{64}$ ]] || die "cannot derive provision set identity"
set_target="$SETS_DIR/$set_id"
[[ ! -e "$set_target" && ! -L "$set_target" ]] \
  || die "derived guest-set target already exists"
set_stage="$(mktemp -d -p "$SETS_DIR" .stage.XXXXXX)"
chown root:"$EXPECTED_USER" "$set_stage"
chmod 0750 "$set_stage"
layout_hypervisor_private="$set_stage/release-layout-hypervisor-evidence-private.pem"
layout_hypervisor_public="$set_stage/release-layout-hypervisor-evidence-public.pem"
"$OPENSSL" genpkey -algorithm ED25519 -out "$layout_hypervisor_private" \
  || die "cannot generate the release-layout hypervisor evidence key"
"$OPENSSL" pkey -in "$layout_hypervisor_private" -pubout \
  -out "$layout_hypervisor_public" \
  || die "cannot derive the release-layout hypervisor public key"
chown root:root "$layout_hypervisor_private" "$layout_hypervisor_public"
chmod 0600 "$layout_hypervisor_private"
chmod 0644 "$layout_hypervisor_public"
fsync_path "$layout_hypervisor_private"
fsync_path "$layout_hypervisor_public"
declare -a layout_guest_private_keys=()
declare -a layout_guest_public_keys=()
for index in 1 2 3; do
  layout_guest_private="$download_dir/release_layout_guest_${index}_private.pem"
  layout_guest_public="$set_stage/release-layout-guest-${index}-evidence-public.pem"
  "$OPENSSL" genpkey -algorithm ED25519 -out "$layout_guest_private" \
    || die "cannot generate the guest-$index release-layout evidence key"
  "$OPENSSL" pkey -in "$layout_guest_private" -pubout \
    -out "$layout_guest_public" \
    || die "cannot derive the guest-$index release-layout public key"
  chown root:root "$layout_guest_private" "$layout_guest_public"
  chmod 0600 "$layout_guest_private"
  chmod 0644 "$layout_guest_public"
  fsync_path "$layout_guest_private"
  fsync_path "$layout_guest_public"
  layout_guest_private_keys+=("$layout_guest_private")
  layout_guest_public_keys+=("$layout_guest_public")
done
guest_records="$set_stage/.guest-records.tsv"
: >"$guest_records"
chmod 0600 "$guest_records"
runtime_manifest_base64="$(
  python3 - "$RUNTIME_MANIFEST" <<'PY'
import base64,pathlib,sys
print(base64.b64encode(pathlib.Path(sys.argv[1]).read_bytes()).decode("ascii"))
PY
)"
runtime_control_base64="$(
  python3 - "$RUNTIME_CONTROL_SOURCE" <<'PY'
import base64,pathlib,sys
print(base64.b64encode(pathlib.Path(sys.argv[1]).read_bytes()).decode("ascii"))
PY
)"
runtime_recovery_unit_base64="$(
  python3 - "$RUNTIME_RECOVERY_UNIT_SOURCE" <<'PY'
import base64,pathlib,sys
print(base64.b64encode(pathlib.Path(sys.argv[1]).read_bytes()).decode("ascii"))
PY
)"
fault_drill_guest_base64="$(
  python3 - "$FAULT_DRILL_GUEST_SOURCE" <<'PY'
import base64,pathlib,sys
print(base64.b64encode(pathlib.Path(sys.argv[1]).read_bytes()).decode("ascii"))
PY
)"
fault_drill_guest_recovery_unit_base64="$(
  python3 - "$FAULT_DRILL_GUEST_RECOVERY_UNIT_SOURCE" <<'PY'
import base64,pathlib,sys
print(base64.b64encode(pathlib.Path(sys.argv[1]).read_bytes()).decode("ascii"))
PY
)"

for index in 1 2 3; do
  guest="guest-$index"
  port="${ports[$((index - 1))]}"
  guest_dir="$set_stage/$guest"
  install -d -o root -g "$EXPECTED_USER" -m 0750 "$guest_dir"
  overlay="$guest_dir/root.qcow2"
  seed="$guest_dir/seed.img"
  meta="$guest_dir/meta-data"
  user_data="$guest_dir/user-data"
  network="$guest_dir/network-config"
  vm_uuid="$(tr 'A-F' 'a-f' </proc/sys/kernel/random/uuid)"
  [[ "$vm_uuid" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] \
    || die "kernel returned an invalid VM UUID"
  identity_digest="$(printf '%s:%s' "$set_id" "$guest" | sha256sum | cut -d' ' -f1)"
  mac="52:54:00:${identity_digest:0:2}:${identity_digest:2:2}:${identity_digest:4:2}"
  instance_id="nexus-rollback-drill-$guest-${set_id:0:16}"
  bitmap_name="nexus-initial-${identity_digest:0:24}"
  guest_host_key="${guest_host_private_keys[$((index - 1))]}"
  guest_host_public_key="${guest_host_public_keys[$((index - 1))]}"
  guest_host_public_key_sha256="${guest_host_public_key_sha256s[$((index - 1))]}"
  guest_host_key_fingerprint="${guest_host_key_fingerprints[$((index - 1))]}"
  layout_guest_private="${layout_guest_private_keys[$((index - 1))]}"
  layout_guest_private_base64="$(
    python3 - "$layout_guest_private" <<'PY'
import base64
import pathlib
import sys
print(base64.b64encode(pathlib.Path(sys.argv[1]).read_bytes()).decode("ascii"))
PY
  )" || die "cannot encode the guest-$index release-layout evidence key"

  "$QEMU_IMG" create -q -f qcow2 -F qcow2 -b "$base_target" "$overlay" 100G \
    || die "cannot create guest overlay: $guest"
  "$QEMU_IMG" bitmap --add --disable -g 65536 "$overlay" "$bitmap_name" \
    || die "cannot bind independent identity metadata to guest overlay: $guest"
  chown "$EXPECTED_USER:$EXPECTED_USER" "$overlay"
  chmod 0600 "$overlay"
  "$QEMU_IMG" check -q -- "$overlay" \
    || die "new guest overlay structural check failed"
  overlay_info="$("$QEMU_IMG" info --output=json -- "$overlay")" \
    || die "cannot inspect new guest overlay"
  python3 - "$overlay_info" "$base_target" "$bitmap_name" <<'PY' \
    || die "new guest overlay is not exactly bound to the immutable base"
import json
import sys
value = json.loads(sys.argv[1])
if value.get("format") != "qcow2":
    raise SystemExit(1)
if value.get("virtual-size") != 100 * 1024 * 1024 * 1024:
    raise SystemExit(1)
if value.get("full-backing-filename") != sys.argv[2]:
    raise SystemExit(1)
format_data = value.get("format-specific", {}).get("data", {})
if format_data.get("bitmaps") != [{
    "flags": [],
    "name": sys.argv[3],
    "granularity": 65536,
}]:
    raise SystemExit(1)
PY
  overlay_initial_sha256="$(sha256sum "$overlay" | cut -d' ' -f1)"
  [[ "$overlay_initial_sha256" =~ ^[0-9a-f]{64}$ ]] \
    || die "cannot derive initial guest overlay digest"

  printf 'instance-id: %s\nlocal-hostname: %s\n' "$instance_id" "$guest" >"$meta"
  cat >"$network" <<'NETWORK'
version: 2
ethernets:
  primary:
    match:
      name: "e*"
    dhcp4: true
    dhcp6: false
NETWORK
  {
    cat <<USER_HEAD
#cloud-config
preserve_hostname: false
manage_etc_hosts: true
disable_root: true
ssh_pwauth: false
package_update: false
package_upgrade: false
users:
  - name: dominguez
    gecos: Nexus rollback drill operator
    shell: /bin/bash
    lock_passwd: true
    ssh_authorized_keys:
      - $normalized_key
ssh_deletekeys: true
ssh_genkeytypes: []
ssh_keys:
  ed25519_private: |
USER_HEAD
    sed 's/^/    /' "$guest_host_key"
    printf '  ed25519_public: %s\n' "$guest_host_public_key"
    cat <<USER_TAIL
write_files:
  - path: /etc/nexus-release/release-layout-evidence-private.pem
    owner: root:root
    permissions: '0600'
    encoding: b64
    content: $layout_guest_private_base64
  - path: /etc/sudoers.d/nexus-rollback-drill-vm
    owner: root:root
    permissions: '0440'
    content: |
      dominguez ALL=(root) NOPASSWD: NOSETENV: /usr/local/sbin/nexus-rollback-drill-vm-runtime-control *
      dominguez ALL=(root) NOPASSWD: NOSETENV: /usr/local/sbin/nexus-release-layout-fault-guest stage *
      dominguez ALL=(root) NOPASSWD: NOSETENV: /usr/local/sbin/nexus-release-layout-fault-guest run *
      dominguez ALL=(root) NOPASSWD: NOSETENV: /usr/local/sbin/nexus-release-layout-fault-guest recover-if-present *
      dominguez ALL=(root) NOPASSWD: NOSETENV: /usr/local/sbin/nexus-release-layout-fault-guest seal *
      dominguez ALL=(root) NOPASSWD: NOSETENV: /usr/local/sbin/nexus-release-layout-fault-guest fetch *
      dominguez ALL=(root) NOPASSWD: NOSETENV: /usr/local/sbin/nexus-release-layout-fault-guest cleanup *
  - path: /etc/ssh/sshd_config.d/99-nexus-rollback-drill.conf
    owner: root:root
    permissions: '0644'
    content: |
      PermitRootLogin no
      PasswordAuthentication no
      KbdInteractiveAuthentication no
      PubkeyAuthentication yes
      AllowUsers dominguez
  - path: /usr/local/libexec/nexus-rollback-drill-vm/runtime-manifest
    owner: root:root
    permissions: '0755'
    encoding: b64
    content: $runtime_manifest_base64
  - path: /usr/local/sbin/nexus-rollback-drill-vm-runtime-control
    owner: root:root
    permissions: '0755'
    encoding: b64
    content: $runtime_control_base64
  - path: /etc/systemd/system/nexus-rollback-drill-vm-runtime-recovery.service
    owner: root:root
    permissions: '0644'
    encoding: b64
    content: $runtime_recovery_unit_base64
  - path: /usr/local/sbin/nexus-release-layout-fault-guest
    owner: root:root
    permissions: '0755'
    encoding: b64
    content: $fault_drill_guest_base64
  - path: /etc/systemd/system/nexus-release-layout-fault-guest-recovery.service
    owner: root:root
    permissions: '0644'
    encoding: b64
    content: $fault_drill_guest_recovery_unit_base64
runcmd:
  - [install, -d, -o, root, -g, root, -m, '0700', /var/lib/nexus-release-layout-fault-guest]
  - [install, -o, root, -g, root, -m, '0600', /dev/null, /var/lib/nexus-release-layout-fault-guest/mutation.lock]
  - [systemctl, daemon-reload]
  - [systemctl, enable, nexus-rollback-drill-vm-runtime-recovery.service]
  - [systemctl, enable, nexus-release-layout-fault-guest-recovery.service]
  - [systemctl, start, nexus-rollback-drill-vm-runtime-recovery.service]
  - [systemctl, start, nexus-release-layout-fault-guest-recovery.service]
  - [systemctl, restart, ssh.service]
final_message: "nexus rollback drill guest ready"
USER_TAIL
  } >"$user_data"
  chmod 0600 "$meta" "$network" "$user_data"
  "$CLOUD_LOCALDS" \
    --disk-format raw \
    --network-config="$network" \
    "$seed" "$user_data" "$meta" \
    || die "cannot create cloud-init seed: $guest"
  chown root:"$EXPECTED_USER" "$seed"
  chmod 0640 "$seed"
  seed_sha256="$(sha256sum "$seed" | cut -d' ' -f1)"
  [[ "$seed_sha256" =~ ^[0-9a-f]{64}$ ]] || die "cannot derive guest seed digest"
  rm -f -- "$meta" "$network" "$user_data"

  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$guest" "$port" "$vm_uuid" "$mac" "$instance_id" "$seed_sha256" \
    "$overlay_initial_sha256" "$guest_host_key_fingerprint" \
    "$guest_host_public_key_sha256" "$guest_host_public_key" \
    >>"$guest_records"
done
fsync_path "$guest_records"

created_at="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
receipt="$set_stage/receipt.json"
python3 - \
  "$receipt" "$set_id" "$expected_image_sha256" "$ssh_public_key_sha256" \
  "$port1" "$port2" "$port3" "$set_target" "$guest_records" "$created_at" \
  "$runner_sha256" "$host_preflight_sha256" \
  "$runtime_manifest_sha256" "$runtime_control_sha256" \
  "$runtime_readiness_sha256" "$runtime_recovery_unit_sha256" \
  "$fault_drill_controller_sha256" "$fault_drill_controller_unit_sha256" \
  "$fault_drill_controller_recovery_unit_sha256" \
  "$fault_drill_guest_sha256" "$fault_drill_guest_recovery_unit_sha256" \
  "$fault_drill_verifier_sha256" \
  "$unit_sha256" "$qemu_sha256" "$qemu_version" \
  "$qemu_package_name" "$qemu_package_version" "$qemu_package_architecture" <<'PY'
import hashlib
import json
import sys
from pathlib import Path

(
    output, set_id, image_sha, key_sha, port1, port2, port3,
    set_directory, records_path, created_at, runner_sha, host_preflight_sha,
    runtime_manifest_sha, runtime_control_sha, runtime_readiness_sha,
    runtime_recovery_unit_sha, fault_drill_controller_sha,
    fault_drill_controller_unit_sha, fault_drill_controller_recovery_unit_sha,
    fault_drill_guest_sha,
    fault_drill_guest_recovery_unit_sha, fault_drill_verifier_sha,
    unit_sha, qemu_sha, qemu_version, qemu_package, qemu_package_version,
    qemu_package_architecture,
) = sys.argv[1:]
ports = [int(port1), int(port2), int(port3)]
guests = []
for line in Path(records_path).read_text(encoding="utf-8").splitlines():
    (
        name, port, uuid, mac, instance_id, seed_sha, overlay_initial_sha,
        fingerprint, host_public_key_sha256, host_public_key,
    ) = line.split("\t")
    root = f"{set_directory}/{name}"
    guests.append({
        "name": name,
        "port": int(port),
        "unit": f"nexus-rollback-drill-vm@{name}.service",
        "uuid": uuid,
        "mac": mac,
        "instanceId": instance_id,
        "overlayPath": f"{root}/root.qcow2",
        "overlayInitialSha256": overlay_initial_sha,
        "seedPath": f"{root}/seed.img",
        "seedSha256": seed_sha,
        "hostPublicKey": host_public_key,
        "hostPublicKeySha256": host_public_key_sha256,
        "hostKeyFingerprint": fingerprint,
    })
if len({guest["overlayInitialSha256"] for guest in guests}) != 3:
    raise SystemExit("initial guest overlay digests must be independent")
if len({guest["hostPublicKey"] for guest in guests}) != 3:
    raise SystemExit("guest SSH host public keys must be distinct")
if len({guest["hostKeyFingerprint"] for guest in guests}) != 3:
    raise SystemExit("guest SSH host fingerprints must be distinct")
for guest in guests:
    if hashlib.sha256(
        guest["hostPublicKey"].strip().encode("utf-8")
    ).hexdigest() != guest["hostPublicKeySha256"]:
        raise SystemExit("guest SSH host public key differs from its identity")
value = {
    "schema": "nexus.rollback-drill-vm-provision.v2",
    "setId": set_id,
    "image": {
        "filename": "noble-server-cloudimg-amd64.img",
        "sha256": image_sha,
        "basePath": f"/var/lib/nexus-rollback-drill-vm/base/{image_sha}.qcow2",
    },
    "sshPublicKeySha256": key_sha,
    "guestSshHostPublicKeySha256s": [
        guest["hostPublicKeySha256"] for guest in guests
    ],
    "ports": ports,
    "setDirectory": set_directory,
    "runtimeReadiness": {
        "status": "ssh_only_bootstrap_required",
        "drillReady": False,
        "requirements": [
            "node-22.23.1",
            "python-3.12.x",
            "pm2-6.0.14-root-closure-at-/opt/nexus-release/pm2/6.0.14-via-/usr/local/bin/pm2",
            "digest-bound-offline-toolchain-evidence",
        ],
    },
    "hypervisor": {
        "manager": "qemu-systemd",
        "qemuBinary": "/usr/bin/qemu-system-x86_64",
        "qemuSha256": qemu_sha,
        "qemuVersion": qemu_version,
        "qemuPackage": qemu_package,
        "qemuPackageVersion": qemu_package_version,
        "qemuPackageArchitecture": qemu_package_architecture,
        "runnerPath": "/usr/local/libexec/nexus-rollback-drill-vm/run",
        "runnerSha256": runner_sha,
        "hostPreflightPath": "/usr/local/libexec/nexus-rollback-drill-vm/host-preflight",
        "hostPreflightSha256": host_preflight_sha,
        "runtimeManifestPath": "/usr/local/libexec/nexus-rollback-drill-vm/runtime-manifest",
        "runtimeManifestSha256": runtime_manifest_sha,
        "runtimeControlSourcePath": "/usr/local/libexec/nexus-rollback-drill-vm/runtime-control-guest",
        "runtimeControlSha256": runtime_control_sha,
        "runtimeReadinessPath": "/usr/local/libexec/nexus-rollback-drill-vm/runtime-readiness",
        "runtimeReadinessSha256": runtime_readiness_sha,
        "runtimeRecoveryUnitSourcePath": "/usr/local/libexec/nexus-rollback-drill-vm/runtime-recovery.service",
        "runtimeRecoveryUnitSha256": runtime_recovery_unit_sha,
        "faultDrillControllerPath": "/usr/local/libexec/nexus-rollback-drill-vm/release-layout-fault-controller",
        "faultDrillControllerSha256": fault_drill_controller_sha,
        "faultDrillControllerUnitPath": "/etc/systemd/system/nexus-release-layout-fault-drill@.service",
        "faultDrillControllerUnitSha256": fault_drill_controller_unit_sha,
        "faultDrillControllerRecoveryUnitPath": "/etc/systemd/system/nexus-release-layout-fault-drill-recovery.service",
        "faultDrillControllerRecoveryUnitSha256": fault_drill_controller_recovery_unit_sha,
        "faultDrillGuestExecutorSourcePath": "/usr/local/libexec/nexus-rollback-drill-vm/release-layout-fault-guest",
        "faultDrillGuestExecutorSha256": fault_drill_guest_sha,
        "faultDrillGuestRecoveryUnitSourcePath": "/usr/local/libexec/nexus-rollback-drill-vm/release-layout-fault-guest-recovery.service",
        "faultDrillGuestRecoveryUnitSha256": fault_drill_guest_recovery_unit_sha,
        "faultDrillVerifierPath": "/usr/local/libexec/nexus-rollback-drill-vm/release-layout-fault-drill.mjs",
        "faultDrillVerifierSha256": fault_drill_verifier_sha,
        "sharedMutexPath": "/run/lock/nexus-release-sonar.lock",
        "guestAdmissionLockPath": "/run/nexus-rollback-drill-vm/admission.lock",
        "hostAvailableMemoryFloorGiB": 25,
        "hostLoad15CeilingExclusive": 6,
        "unitTemplate": "nexus-rollback-drill-vm@.service",
        "unitPath": "/etc/systemd/system/nexus-rollback-drill-vm@.service",
        "unitSha256": unit_sha,
        "vcpus": 4,
        "memoryMiB": 14336,
        "memorySwapMaxMiB": 512,
        "diskBytes": 100 * 1024 * 1024 * 1024,
        "networkMode": "qemu-user-restrict",
        "loopbackHost": "127.0.0.1",
        "singleActiveGuest": True,
        "bridgeAttached": False,
        "tapAttached": False,
        "sharedFilesystemAttached": False,
        "hostBlockDeviceAttached": False,
        "productionDataAttached": False,
    },
    "guests": guests,
    "createdAt": created_at,
}
Path(output).write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")
PY
layout_trust="$set_stage/release-layout-evidence-trust.v1.json"
python3 - "$layout_trust" "$receipt" "$layout_hypervisor_public" \
  "${layout_guest_public_keys[0]}" "${layout_guest_public_keys[1]}" \
  "${layout_guest_public_keys[2]}" "$created_at" <<'PY'
import hashlib
import json
import sys
from pathlib import Path

output, receipt_path, hypervisor_key_path, guest_1_key_path, \
    guest_2_key_path, guest_3_key_path, created_at = sys.argv[1:]
receipt_body = Path(receipt_path).read_bytes()
receipt = json.loads(receipt_body)
guest_by_name = {guest["name"]: guest for guest in receipt["guests"]}
public_keys = {
    "guest-1": Path(guest_1_key_path).read_text(encoding="ascii"),
    "guest-2": Path(guest_2_key_path).read_text(encoding="ascii"),
    "guest-3": Path(guest_3_key_path).read_text(encoding="ascii"),
}
scenario_guests = {
    "failed_health_check": "guest-2",
    "host_reboot_during_migration": "guest-3",
    "ssh_disconnect_after_pm2_stop": "guest-1",
}
hypervisor_public_key = Path(hypervisor_key_path).read_text(encoding="ascii")
value = {
    "schema": "nexus.release-layout-kvm-trust.v1",
    "provision": {
        "schema": receipt["schema"],
        "setId": receipt["setId"],
        "receiptSha256": hashlib.sha256(receipt_body).hexdigest(),
    },
    "hypervisor": {
        "publicKeyPem": hypervisor_public_key,
        "publicKeySha256": hashlib.sha256(
            hypervisor_public_key.encode("ascii")
        ).hexdigest(),
        "qemuSha256": receipt["hypervisor"]["qemuSha256"],
        "runnerSha256": receipt["hypervisor"]["runnerSha256"],
        "controllerPath": "/usr/local/libexec/nexus-rollback-drill-vm/release-layout-fault-controller",
        "controllerSha256": receipt["hypervisor"]["faultDrillControllerSha256"],
        "controllerRecoveryUnitPath": "/etc/systemd/system/nexus-release-layout-fault-drill-recovery.service",
        "controllerRecoveryUnitSha256": receipt["hypervisor"]["faultDrillControllerRecoveryUnitSha256"],
        "controllerUnitPath": "/etc/systemd/system/nexus-release-layout-fault-drill@.service",
        "controllerUnitSha256": receipt["hypervisor"]["faultDrillControllerUnitSha256"],
        "verifierPath": "/usr/local/libexec/nexus-rollback-drill-vm/release-layout-fault-drill.mjs",
        "verifierSha256": receipt["hypervisor"]["faultDrillVerifierSha256"],
    },
    "guests": {
        scenario: {
            "guestId": guest,
            "publicKeyPem": public_keys[guest],
            "publicKeySha256": hashlib.sha256(
                public_keys[guest].encode("ascii")
            ).hexdigest(),
            "sshHostPublicKeySha256":
                guest_by_name[guest]["hostPublicKeySha256"],
            "executorPath": "/usr/local/sbin/nexus-release-layout-fault-guest",
            "executorSha256":
                receipt["hypervisor"]["faultDrillGuestExecutorSha256"],
            "recoveryUnitPath":
                "/etc/systemd/system/"
                "nexus-release-layout-fault-guest-recovery.service",
            "recoveryUnitSha256":
                receipt["hypervisor"]["faultDrillGuestRecoveryUnitSha256"],
        }
        for scenario, guest in scenario_guests.items()
    },
    "createdAt": created_at,
}
Path(output).write_text(
    json.dumps(value, indent=2, sort_keys=True) + "\n",
    encoding="utf-8",
)
PY
chown root:root "$layout_trust"
chmod 0600 "$layout_trust"
fsync_path "$layout_trust"
rm -f -- "$guest_records"
chown root:"$EXPECTED_USER" "$receipt"
chmod 0640 "$receipt"
fsync_path "$receipt"
for index in 1 2 3; do
  fsync_path "$set_stage/guest-$index/root.qcow2"
  fsync_path "$set_stage/guest-$index/seed.img"
  fsync_path "$set_stage/guest-$index"
done
fsync_path "$set_stage"

active_stage="$(mktemp -p "$STATE_ROOT" .active.XXXXXX)"
install -o root -g "$EXPECTED_USER" -m 0640 -- "$receipt" "$active_stage"
fsync_path "$active_stage"
trust_stage="$(mktemp -p "$STATE_ROOT" .layout-trust.XXXXXX)"
install -o root -g root -m 0600 -- "$layout_trust" "$trust_stage"
fsync_path "$trust_stage"
mv -T -- "$set_stage" "$set_target"
set_stage=""
set_committed=true
fsync_path "$SETS_DIR"
mv -fT -- "$trust_stage" "$LAYOUT_TRUST_MANIFEST"
trust_stage=""
trust_committed=true
fsync_path "$STATE_ROOT"
mv -fT -- "$active_stage" "$ACTIVE_RECEIPT"
active_stage=""
active_committed=true
fsync_path "$STATE_ROOT"

rm -f -- "$PROVISION_JOURNAL"
fsync_path "$STATE_ROOT"
journal_armed=false
transaction_succeeded=true
printf '{"ok":true,"schema":"nexus.rollback-drill-vm-provision-result.v1","setId":"%s","imageSha256":"%s","guestCount":3,"servicesStarted":false,"servicesEnabled":false,"drillReady":false,"runtimeStatus":"ssh_only_bootstrap_required","layoutTrustManifestSha256":"%s"}\n' \
  "$set_id" "$expected_image_sha256" \
  "$(sha256sum -- "$LAYOUT_TRUST_MANIFEST" | cut -d' ' -f1)"
