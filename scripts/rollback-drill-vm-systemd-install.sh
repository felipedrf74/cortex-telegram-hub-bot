#!/usr/bin/env bash
# Install the rollback-drill KVM controls from a root-owned immutable source.
# The installer creates no guest and starts no service. It enables only the
# root-owned boot recovery oneshot; VM and drill execution units stay static.
set -euo pipefail
umask 077
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

SOURCE_ROOT="${1:-}"
SOURCE_SHA="${2:-}"
SOURCE_ARCHIVE="${3:-}"
EXPECTED_ARCHIVE_SHA256="${4:-}"
BOOTSTRAP_BASE="/var/lib/nexus-release-bootstrap"
EXPECTED_USER="nexus-drill-vm"
LAYOUT_RELATIVE="ops/rollback-drill-vm/install-layout.tsv"
INSTALLER_RELATIVE="scripts/rollback-drill-vm-systemd-install.sh"
STATE_ROOT="/var/lib/nexus-rollback-drill-vm"
INSTALL_JOURNAL="$STATE_ROOT/install-in-progress.v1"
CONTROL_LOCK="$STATE_ROOT/control.lock"
ACTIVE_RECEIPT="$STATE_ROOT/active.json"
UNIT_TEMPLATE="nexus-rollback-drill-vm@.service"
UNIT_TEMPLATE_PROBE="nexus-rollback-drill-vm@guest-1.service"
SHARED_MUTEX="/run/lock/nexus-release-sonar.lock"
FAULT_CONTROLLER_RECOVERY_UNIT="nexus-release-layout-fault-drill-recovery.service"
FAULT_CONTROLLER_RECOVERY_WANTS="/etc/systemd/system/multi-user.target.wants/$FAULT_CONTROLLER_RECOVERY_UNIT"

die() {
  echo "rollback drill VM installer: $*" >&2
  exit 1
}

usage() {
  cat <<'USAGE'
Usage: sudo scripts/rollback-drill-vm-systemd-install.sh \
  <root-owned-source-root> <40-hex-source-sha> \
  <root-owned-source-archive> <64-hex-archive-sha256>
USAGE
}

[ "$#" -eq 4 ] || {
  usage >&2
  exit 64
}
[ "$(id -u)" -eq 0 ] || die "must run as root"
[[ "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]] \
  || die "source SHA must be exactly 40 lowercase hexadecimal characters"
[[ "$EXPECTED_ARCHIVE_SHA256" =~ ^[0-9a-f]{64}$ ]] \
  || die "archive SHA-256 must be exactly 64 lowercase hexadecimal characters"
EXPECTED_BOOTSTRAP_ROOT="$BOOTSTRAP_BASE/$SOURCE_SHA"
[ "$SOURCE_ROOT" = "$EXPECTED_BOOTSTRAP_ROOT/source" ] \
  || die "source root must be the exact SHA-bound bootstrap source path"
[ "$SOURCE_ARCHIVE" = "$EXPECTED_BOOTSTRAP_ROOT/source.tar.gz" ] \
  || die "source archive must be the exact SHA-bound bootstrap archive path"

for command in bash cat chmod chown cut dirname flock getent groupdel id install ln \
  mktemp mv python3 realpath rm rmdir sha256sum sort stat systemctl \
  systemd-analyze systemd-tmpfiles tail tr useradd userdel; do
  command -v "$command" >/dev/null 2>&1 || die "$command is required"
done
getent group kvm >/dev/null 2>&1 || die "kvm group is missing"
[[ -c /dev/kvm && -r /dev/kvm && -w /dev/kvm ]] || die "/dev/kvm is unavailable"

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

durable_remove() {
  local target="$1"
  rm -f -- "$target" || return 1
  fsync_path "$(dirname -- "$target")" || return 1
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
  local unit="$1" missing_allowed="$2"
  read_systemd_unit_state "$unit"
  [ "$SYSTEMD_ACTIVE_STATE" = inactive ] \
    || die "guest service is not safely inactive: $unit ($SYSTEMD_ACTIVE_STATE)"
  case "$SYSTEMD_LOAD_STATE" in
    loaded) ;;
    not-found)
      [ "$missing_allowed" = true ] \
        || die "installed guest service is not loaded: $unit"
      ;;
    *) die "guest service load state is unsafe: $unit ($SYSTEMD_LOAD_STATE)" ;;
  esac
}

assert_template_static() {
  local missing_allowed="$1"
  # systemd rejects a bare template name for `show` on supported Ubuntu
  # hosts. Query one fixed, never-started instance to inspect the template's
  # load and unit-file state without changing service state.
  read_systemd_unit_state "$UNIT_TEMPLATE_PROBE"
  [ "$SYSTEMD_ACTIVE_STATE" = inactive ] \
    || die "guest template is not safely inactive: $SYSTEMD_ACTIVE_STATE"
  case "$SYSTEMD_LOAD_STATE:$SYSTEMD_UNIT_FILE_STATE" in
    loaded:static|loaded:disabled) ;;
    not-found:)
      [ "$missing_allowed" = true ] \
        || die "installed guest template is not loaded"
      ;;
    *) die "guest template state is unsafe: $SYSTEMD_LOAD_STATE:${SYSTEMD_UNIT_FILE_STATE:-unset}" ;;
  esac
}

validate_root_owned_chain() {
  local current="$1" label="${2:-source}" owner mode
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

[[ "$SOURCE_ROOT" == /* && "$SOURCE_ROOT" != / && -d "$SOURCE_ROOT" && ! -L "$SOURCE_ROOT" ]] \
  || die "source root must be an absolute non-symlink directory"
canonical_source_root="$(realpath -e -- "$SOURCE_ROOT")"
[ "$canonical_source_root" = "$SOURCE_ROOT" ] \
  || die "source root must not traverse symlinks"
SOURCE_ROOT="$canonical_source_root"
validate_root_owned_chain "$SOURCE_ROOT"

[[ -f "$SOURCE_ARCHIVE" && ! -L "$SOURCE_ARCHIVE" ]] \
  || die "bootstrap source archive is missing or unsafe"
[ "$(realpath -e -- "$SOURCE_ARCHIVE")" = "$SOURCE_ARCHIVE" ] \
  || die "bootstrap source archive must not traverse symlinks"
validate_root_owned_chain "$SOURCE_ARCHIVE" "bootstrap source archive"
archive_sha256="$(sha256sum -- "$SOURCE_ARCHIVE" | cut -d' ' -f1)"
[ "$archive_sha256" = "$EXPECTED_ARCHIVE_SHA256" ] \
  || die "bootstrap source archive digest does not match the owner-approved digest"

LAYOUT="$SOURCE_ROOT/$LAYOUT_RELATIVE"
INSTALLER_SOURCE="$SOURCE_ROOT/$INSTALLER_RELATIVE"
[[ -f "$LAYOUT" && ! -L "$LAYOUT" ]] || die "install layout is missing or unsafe"
[ "$(realpath -e -- "$LAYOUT")" = "$LAYOUT" ] \
  || die "install layout must not traverse symlinks"
validate_root_owned_chain "$LAYOUT"
[[ -f "$INSTALLER_SOURCE" && ! -L "$INSTALLER_SOURCE" ]] \
  || die "installer source is missing or unsafe"
[ "$(realpath -e -- "$INSTALLER_SOURCE")" = "$INSTALLER_SOURCE" ] \
  || die "installer source must not traverse symlinks"
validate_root_owned_chain "$INSTALLER_SOURCE"
[[ "${BASH_SOURCE[0]}" == /* && ! -L "${BASH_SOURCE[0]}" ]] \
  && [ "$(realpath -e -- "${BASH_SOURCE[0]}")" = "$INSTALLER_SOURCE" ] \
  || die "installer must execute from the exact reviewed bootstrap source path"

expected_layout="$(
  cat <<'LAYOUT'
scripts/rollback-drill-vm-provision.sh	/usr/local/libexec/nexus-rollback-drill-vm/provision	root:root	0755
scripts/rollback-drill-vm-run.sh	/usr/local/libexec/nexus-rollback-drill-vm/run	root:root	0755
scripts/rollback-drill-vm-host-preflight.sh	/usr/local/libexec/nexus-rollback-drill-vm/host-preflight	root:root	0755
scripts/rollback-drill-vm-manifest.py	/usr/local/libexec/nexus-rollback-drill-vm/manifest.py	root:root	0644
scripts/rollback-drill-vm-runtime-manifest.py	/usr/local/libexec/nexus-rollback-drill-vm/runtime-manifest	root:root	0755
scripts/rollback-drill-vm-runtime-control.sh	/usr/local/libexec/nexus-rollback-drill-vm/runtime-control-guest	root:root	0755
scripts/rollback-drill-vm-runtime-readiness-seal.sh	/usr/local/libexec/nexus-rollback-drill-vm/runtime-readiness	root:root	0755
scripts/release-layout-fault-drill-controller.mjs	/usr/local/libexec/nexus-rollback-drill-vm/release-layout-fault-controller	root:root	0755
scripts/release-layout-fault-drill-guest.mjs	/usr/local/libexec/nexus-rollback-drill-vm/release-layout-fault-guest	root:root	0755
scripts/release-layout-fault-drill.mjs	/usr/local/libexec/nexus-rollback-drill-vm/release-layout-fault-drill.mjs	root:root	0755
ops/rollback-drill-vm/systemd/nexus-rollback-drill-vm-runtime-recovery.service	/usr/local/libexec/nexus-rollback-drill-vm/runtime-recovery.service	root:root	0644
ops/rollback-drill-vm/systemd/nexus-release-layout-fault-drill-guest-recovery.service	/usr/local/libexec/nexus-rollback-drill-vm/release-layout-fault-guest-recovery.service	root:root	0644
ops/rollback-drill-vm/systemd/nexus-rollback-drill-vm@.service	/etc/systemd/system/nexus-rollback-drill-vm@.service	root:root	0644
ops/rollback-drill-vm/systemd/nexus-release-layout-fault-drill@.service	/etc/systemd/system/nexus-release-layout-fault-drill@.service	root:root	0644
ops/rollback-drill-vm/systemd/nexus-release-layout-fault-drill-recovery.service	/etc/systemd/system/nexus-release-layout-fault-drill-recovery.service	root:root	0644
ops/rollback-drill-vm/nexus-rollback-drill-vm.tmpfiles	/etc/tmpfiles.d/nexus-rollback-drill-vm.conf	root:root	0644
LAYOUT
)"
actual_layout="$(tail -n +2 "$LAYOUT")"
[ "$actual_layout" = "$expected_layout" ] || die "install layout differs from the exact allowlist"

# Prove the owner-reviewed archive is a Git archive of the declared commit and
# every privileged input remains byte-identical to its exact regular member.
python3 - \
  "$SOURCE_ARCHIVE" "$SOURCE_ROOT" "$SOURCE_SHA" "$LAYOUT" \
  "$INSTALLER_SOURCE" <<'PY'
import hashlib
import pathlib
import sys
import tarfile

archive_path, source_root, source_sha, layout_path, installer_path = sys.argv[1:]
source_root_path = pathlib.Path(source_root)
required = {
    "ops/rollback-drill-vm/install-layout.tsv",
    "scripts/rollback-drill-vm-systemd-install.sh",
}
with open(layout_path, "r", encoding="utf-8") as layout:
    for line_number, raw_line in enumerate(layout, start=1):
        line = raw_line.rstrip("\n")
        if line_number == 1 or not line:
            continue
        fields = line.split("\t")
        if len(fields) != 4:
            raise SystemExit("rollback drill VM archive verifier: malformed install layout")
        required.add(fields[0])

with tarfile.open(archive_path, mode="r:*") as archive:
    if archive.pax_headers.get("comment") != source_sha:
        raise SystemExit("rollback drill VM archive verifier: Git archive commit does not match source SHA")
    expected_names = {f"source/{relative}": relative for relative in required}
    required_members = {}
    for member in archive.getmembers():
        relative = expected_names.get(member.name)
        if relative is None:
            continue
        if relative in required_members:
            raise SystemExit(f"rollback drill VM archive verifier: duplicate member {member.name}")
        if not member.isreg() or member.issym() or member.islnk():
            raise SystemExit(
                f"rollback drill VM archive verifier: required member is not regular: {member.name}"
            )
        required_members[relative] = member
    missing = sorted(required - required_members.keys())
    if missing:
        raise SystemExit(
            f"rollback drill VM archive verifier: missing required member {missing[0]}"
        )
    for relative in sorted(required):
        member = required_members[relative]
        extracted = archive.extractfile(member)
        if extracted is None:
            raise SystemExit(
                f"rollback drill VM archive verifier: cannot read {member.name}"
            )
        archive_digest = hashlib.sha256(extracted.read()).hexdigest()
        local_path = source_root_path / relative
        if not local_path.is_file() or local_path.is_symlink():
            raise SystemExit(
                f"rollback drill VM archive verifier: unsafe source {relative}"
            )
        local_digest = hashlib.sha256(local_path.read_bytes()).hexdigest()
        if local_digest != archive_digest:
            raise SystemExit(
                f"rollback drill VM archive verifier: source drift for {relative}"
            )

if pathlib.Path(installer_path).is_symlink():
    raise SystemExit("rollback drill VM archive verifier: installer source is a symlink")
PY

validate_existing_target_chain() {
  local current="$1" parent canonical
  while [ ! -e "$current" ] && [ ! -L "$current" ]; do
    parent="$(dirname -- "$current")"
    [ "$parent" != "$current" ] || die "install target has no trusted ancestor"
    current="$parent"
  done
  [[ -d "$current" && ! -L "$current" ]] \
    || die "install target ancestor is unsafe: $current"
  canonical="$(realpath -e -- "$current")"
  [ "$canonical" = "$current" ] \
    || die "install target ancestor traverses a symlink: $current"
  validate_root_owned_chain "$current" "install target"
}

sources=()
targets=()
modes=()
source_digests=()
had_targets=()
unit_index=-1
runner_index=-1
preflight_index=-1
runtime_manifest_index=-1
runtime_control_index=-1
runtime_readiness_index=-1
runtime_recovery_index=-1
fault_controller_index=-1
fault_guest_index=-1
fault_drill_tool_index=-1
fault_guest_recovery_index=-1
fault_controller_unit_index=-1
fault_controller_recovery_unit_index=-1
while IFS=$'\t' read -r relative target owner mode extra; do
  [ -z "$extra" ] || die "install layout contains an extra column"
  [ -n "$relative" ] && [ -n "$target" ] && [ "$owner" = root:root ] && [ -n "$mode" ] \
    || die "install layout row is invalid"
  [[ "$relative" =~ ^[A-Za-z0-9._/@-]+$ ]] \
    && [[ "/$relative/" != *"/../"* && "/$relative/" != *"/./"* ]] \
    && [[ "$relative" != /* ]] \
    || die "install layout source is unsafe"
  source_path="$SOURCE_ROOT/$relative"
  [[ -f "$source_path" && ! -L "$source_path" ]] \
    || die "install source is missing or unsafe: $relative"
  [ "$(realpath -e -- "$source_path")" = "$source_path" ] \
    || die "install source traverses a symlink: $relative"
  validate_root_owned_chain "$source_path"
  [[ "$mode" =~ ^0(644|755)$ ]] || die "install target mode is outside the allowlist"
  [[ "$target" == /* && "$target" != / && "$(realpath -m -- "$target")" = "$target" ]] \
    || die "install target is noncanonical"
  case "$target" in
    /usr/local/libexec/nexus-rollback-drill-vm/*|\
    /etc/systemd/system/nexus-rollback-drill-vm@.service|\
    /etc/systemd/system/nexus-release-layout-fault-drill@.service|\
    /etc/systemd/system/nexus-release-layout-fault-drill-recovery.service|\
    /etc/tmpfiles.d/nexus-rollback-drill-vm.conf) ;;
    *) die "install target is outside the allowlist: $target" ;;
  esac
  validate_existing_target_chain "$(dirname -- "$target")"
  if [ -L "$target" ]; then
    die "existing install target is a symlink: $target"
  elif [ -e "$target" ]; then
    [ -f "$target" ] || die "existing install target is not a regular file: $target"
    [ "$(realpath -e -- "$target")" = "$target" ] \
      || die "existing install target traverses a symlink: $target"
    validate_root_owned_chain "$target" "install target"
    had_targets+=(true)
  else
    had_targets+=(false)
  fi
  sources+=("$source_path")
  targets+=("$target")
  modes+=("$mode")
  source_digests+=("$(sha256sum -- "$source_path" | cut -d' ' -f1)")
  if [ "$target" = "/etc/systemd/system/$UNIT_TEMPLATE" ]; then
    unit_index=$((${#targets[@]} - 1))
  elif [ "$target" = /usr/local/libexec/nexus-rollback-drill-vm/run ]; then
    runner_index=$((${#targets[@]} - 1))
  elif [ "$target" = /usr/local/libexec/nexus-rollback-drill-vm/host-preflight ]; then
    preflight_index=$((${#targets[@]} - 1))
  elif [ "$target" = /usr/local/libexec/nexus-rollback-drill-vm/runtime-manifest ]; then
    runtime_manifest_index=$((${#targets[@]} - 1))
  elif [ "$target" = /usr/local/libexec/nexus-rollback-drill-vm/runtime-control-guest ]; then
    runtime_control_index=$((${#targets[@]} - 1))
  elif [ "$target" = /usr/local/libexec/nexus-rollback-drill-vm/runtime-readiness ]; then
    runtime_readiness_index=$((${#targets[@]} - 1))
  elif [ "$target" = /usr/local/libexec/nexus-rollback-drill-vm/runtime-recovery.service ]; then
    runtime_recovery_index=$((${#targets[@]} - 1))
  elif [ "$target" = /usr/local/libexec/nexus-rollback-drill-vm/release-layout-fault-controller ]; then
    fault_controller_index=$((${#targets[@]} - 1))
  elif [ "$target" = /usr/local/libexec/nexus-rollback-drill-vm/release-layout-fault-guest ]; then
    fault_guest_index=$((${#targets[@]} - 1))
  elif [ "$target" = /usr/local/libexec/nexus-rollback-drill-vm/release-layout-fault-drill.mjs ]; then
    fault_drill_tool_index=$((${#targets[@]} - 1))
  elif [ "$target" = /usr/local/libexec/nexus-rollback-drill-vm/release-layout-fault-guest-recovery.service ]; then
    fault_guest_recovery_index=$((${#targets[@]} - 1))
  elif [ "$target" = /etc/systemd/system/nexus-release-layout-fault-drill@.service ]; then
    fault_controller_unit_index=$((${#targets[@]} - 1))
  elif [ "$target" = /etc/systemd/system/nexus-release-layout-fault-drill-recovery.service ]; then
    fault_controller_recovery_unit_index=$((${#targets[@]} - 1))
  fi
done <<<"$actual_layout"
[ "${#sources[@]}" -eq 16 ] || die "install layout asset count is invalid"
[ "$unit_index" -ge 0 ] || die "install layout omits the journal-guarded unit"
[ "$runner_index" -ge 0 ] || die "install layout omits the receipt-bound runner"
[ "$preflight_index" -ge 0 ] || die "install layout omits the receipt-bound host preflight"
[ "$runtime_manifest_index" -ge 0 ] \
  || die "install layout omits the receipt-bound runtime manifest helper"
[ "$runtime_control_index" -ge 0 ] \
  || die "install layout omits the receipt-bound guest runtime control"
[ "$runtime_readiness_index" -ge 0 ] \
  || die "install layout omits the receipt-bound runtime readiness collector"
[ "$runtime_recovery_index" -ge 0 ] \
  || die "install layout omits the receipt-bound guest runtime recovery unit"
[ "$fault_controller_index" -ge 0 ] \
  || die "install layout omits the trusted hypervisor fault controller"
[ "$fault_guest_index" -ge 0 ] \
  || die "install layout omits the isolated guest fault executor"
[ "$fault_drill_tool_index" -ge 0 ] \
  || die "install layout omits the fault evidence verifier"
[ "$fault_guest_recovery_index" -ge 0 ] \
  || die "install layout omits the guest fault recovery unit"
[ "$fault_controller_unit_index" -ge 0 ] \
  || die "install layout omits the hypervisor fault controller unit"
[ "$fault_controller_recovery_unit_index" -ge 0 ] \
  || die "install layout omits the hypervisor fault recovery unit"

for guest in guest-1 guest-2 guest-3; do
  assert_guest_unit_inactive "nexus-rollback-drill-vm@$guest.service" true
done
assert_template_static true

# Complete source syntax and unit validation before any persistent mutation.
for source_path in "${sources[@]}" "$INSTALLER_SOURCE"; do
  case "$source_path" in
    *.sh) bash -n "$source_path" ;;
    *.mjs) /usr/bin/node --check "$source_path" ;;
    *.py)
      python3 - "$source_path" <<'PY'
import pathlib
import sys
path = pathlib.Path(sys.argv[1])
compile(path.read_bytes(), str(path), "exec")
PY
      ;;
  esac
done
unit_source="${sources[$unit_index]}"
runner_source="${sources[$runner_index]}"
preflight_source="${sources[$preflight_index]}"
runtime_control_source="${sources[$runtime_control_index]}"
runtime_recovery_source="${sources[$runtime_recovery_index]}"
fault_controller_source="${sources[$fault_controller_index]}"
fault_guest_source="${sources[$fault_guest_index]}"
fault_guest_recovery_source="${sources[$fault_guest_recovery_index]}"
fault_controller_unit_source="${sources[$fault_controller_unit_index]}"
fault_controller_recovery_unit_source="${sources[$fault_controller_recovery_unit_index]}"
unit_verify_root="$(mktemp -d /tmp/nexus-rollback-drill-vm-unit.XXXXXX)"
[[ "$unit_verify_root" == /tmp/nexus-rollback-drill-vm-unit.* \
    && -d "$unit_verify_root" && ! -L "$unit_verify_root" ]] \
  || die "cannot create a safe unit prevalidation directory"
unit_verify_path="$unit_verify_root/$UNIT_TEMPLATE"
runtime_recovery_verify_path="$unit_verify_root/nexus-rollback-drill-vm-runtime-recovery.service"
fault_guest_recovery_verify_path="$unit_verify_root/nexus-release-layout-fault-drill-guest-recovery.service"
fault_controller_unit_verify_path="$unit_verify_root/nexus-release-layout-fault-drill@.service"
fault_controller_recovery_unit_verify_path="$unit_verify_root/nexus-release-layout-fault-drill-recovery.service"
prevalidate_rc=0
python3 - "$unit_source" "$runner_source" "$preflight_source" "$unit_verify_path" <<'PY' \
  || prevalidate_rc=$?
import pathlib
import sys
source, runner, preflight, output = sys.argv[1:]
text = pathlib.Path(source).read_text(encoding="utf-8")
expected_start = "ExecStart=/usr/local/libexec/nexus-rollback-drill-vm/run %i"
expected_preflight = "ExecStartPre=+/usr/local/libexec/nexus-rollback-drill-vm/host-preflight"
if text.count(expected_start) != 1 or text.count(expected_preflight) != 1:
    raise SystemExit("rollback drill VM unit prevalidation: ExecStart contract drifted")
pathlib.Path(output).write_text(
    text.replace(expected_start, f"ExecStart={runner} %i").replace(
        expected_preflight, f"ExecStartPre=+{preflight}"
    ),
    encoding="utf-8",
)
PY
if [ "$prevalidate_rc" -eq 0 ]; then
  python3 - "$runtime_recovery_source" "$runtime_control_source" \
    "$runtime_recovery_verify_path" <<'PY' \
    || prevalidate_rc=$?
import pathlib
import sys
source, control, output = sys.argv[1:]
text = pathlib.Path(source).read_text(encoding="utf-8")
expected = (
    "ExecStart=/usr/local/sbin/"
    "nexus-rollback-drill-vm-runtime-control recover-install"
)
if text.count(expected) != 1:
    raise SystemExit(
        "rollback drill VM runtime recovery prevalidation: "
        "ExecStart contract drifted"
    )
pathlib.Path(output).write_text(
    text.replace(expected, f"ExecStart={control} recover-install"),
    encoding="utf-8",
)
PY
fi
if [ "$prevalidate_rc" -eq 0 ]; then
  python3 - "$fault_guest_recovery_source" "$fault_guest_source" \
    "$fault_guest_recovery_verify_path" <<'PY' \
    || prevalidate_rc=$?
import pathlib
import sys
source, executor, output = sys.argv[1:]
text = pathlib.Path(source).read_text(encoding="utf-8")
expected = (
    "ExecStart=/usr/local/sbin/"
    "nexus-release-layout-fault-guest recover-all"
)
if text.count(expected) != 1:
    raise SystemExit(
        "release-layout guest fault recovery prevalidation: "
        "ExecStart contract drifted"
    )
pathlib.Path(output).write_text(
    text.replace(expected, f"ExecStart={executor} recover-all"),
    encoding="utf-8",
)
PY
fi
if [ "$prevalidate_rc" -eq 0 ]; then
  python3 - "$fault_controller_unit_source" "$fault_controller_source" \
    "$fault_controller_unit_verify_path" <<'PY' \
    || prevalidate_rc=$?
import pathlib
import sys
source, controller, output = sys.argv[1:]
text = pathlib.Path(source).read_text(encoding="utf-8")
expected = (
    "ExecStart=/usr/local/libexec/nexus-rollback-drill-vm/"
    "release-layout-fault-controller run %i"
)
if text.count(expected) != 1:
    raise SystemExit(
        "release-layout hypervisor fault controller prevalidation: "
        "ExecStart contract drifted"
    )
pathlib.Path(output).write_text(
    text.replace(expected, f"ExecStart={controller} run %i"),
    encoding="utf-8",
)
PY
fi
if [ "$prevalidate_rc" -eq 0 ]; then
  python3 - "$fault_controller_recovery_unit_source" "$fault_controller_source" \
    "$fault_controller_recovery_unit_verify_path" <<'PY' \
    || prevalidate_rc=$?
import pathlib
import sys
source, controller, output = sys.argv[1:]
text = pathlib.Path(source).read_text(encoding="utf-8")
expected = (
    "ExecStart=/usr/local/libexec/nexus-rollback-drill-vm/"
    "release-layout-fault-controller recover-all"
)
if text.count(expected) != 1:
    raise SystemExit(
        "release-layout hypervisor fault recovery prevalidation: "
        "ExecStart contract drifted"
    )
pathlib.Path(output).write_text(
    text.replace(expected, f"ExecStart={controller} recover-all"),
    encoding="utf-8",
)
PY
fi
if [ "$prevalidate_rc" -eq 0 ]; then
  SYSTEMD_UNIT_PATH="$unit_verify_root:/etc/systemd/system:/usr/lib/systemd/system:/lib/systemd/system" \
    systemd-analyze verify \
      "$unit_verify_path" "$runtime_recovery_verify_path" \
      "$fault_guest_recovery_verify_path" \
      "$fault_controller_unit_verify_path" \
      "$fault_controller_recovery_unit_verify_path" >/dev/null \
    || prevalidate_rc=$?
fi
rm -f -- "$unit_verify_path" "$runtime_recovery_verify_path" \
  "$fault_guest_recovery_verify_path" "$fault_controller_unit_verify_path" \
  "$fault_controller_recovery_unit_verify_path"
rmdir -- "$unit_verify_root"
[ "$prevalidate_rc" -eq 0 ] \
  || die "systemd unit prevalidation failed"

[[ -f "$SHARED_MUTEX" && ! -L "$SHARED_MUTEX" ]] \
  || die "shared release/Sonar mutex is missing or unsafe"
[ "$(realpath -e -- "$SHARED_MUTEX")" = "$SHARED_MUTEX" ] \
  && [ "$(stat -c '%U:%G:%a' -- "$SHARED_MUTEX")" = root:dominguez:660 ] \
  || die "shared release/Sonar mutex must be root:dominguez mode 0660"
exec 8<>"$SHARED_MUTEX"
flock -n 8 \
  || die "a release, Sonar operation, or rollback drill holds the shared mutex"

user_existed=false
if getent passwd "$EXPECTED_USER" >/dev/null 2>&1; then
  user_existed=true
  IFS=: read -r account _ uid gid _ home shell < <(getent passwd "$EXPECTED_USER")
  [ "$account" = "$EXPECTED_USER" ] \
    && [[ "$uid" =~ ^[0-9]+$ && "$uid" -gt 0 ]] \
    && [[ "$gid" =~ ^[0-9]+$ && "$gid" -gt 0 ]] \
    && [ "$home" = /nonexistent ] \
    || die "existing dedicated account identity is invalid"
  case "$shell" in
    /usr/sbin/nologin|/sbin/nologin|/bin/false) ;;
    *) die "existing dedicated account must have a disabled login shell" ;;
  esac
  mapfile -t existing_groups < <(id -nG "$EXPECTED_USER" | tr ' ' '\n' | sort)
  [ "${#existing_groups[@]}" -eq 2 ] \
    && [ "${existing_groups[0]}" = kvm ] \
    && [ "${existing_groups[1]}" = "$EXPECTED_USER" ] \
    || die "existing dedicated account must belong only to its private group and kvm"
else
  ! getent group "$EXPECTED_USER" >/dev/null \
    || die "private group exists without the dedicated account"
fi

state_existed=false
libexec_existed=false
runtime_dir_existed=false
[ -d "$STATE_ROOT" ] && state_existed=true
[ -d /usr/local/libexec/nexus-rollback-drill-vm ] && libexec_existed=true
[ -d /run/nexus-rollback-drill-vm ] && runtime_dir_existed=true
if [ "$state_existed" = true ]; then
  [[ ! -L "$STATE_ROOT" && "$(realpath -e -- "$STATE_ROOT")" = "$STATE_ROOT" ]] \
    || die "existing state root is unsafe"
  [ "$(stat -c '%U:%G:%a' -- "$STATE_ROOT")" = root:nexus-drill-vm:750 ] \
    || die "existing state root must be root:nexus-drill-vm mode 0750"
else
  validate_existing_target_chain "$(dirname -- "$STATE_ROOT")"
fi
if [ -L "$INSTALL_JOURNAL" ]; then
  die "install journal is a symlink"
elif [ -e "$INSTALL_JOURNAL" ]; then
  [[ -f "$INSTALL_JOURNAL" && "$(stat -c '%U:%G:%a' -- "$INSTALL_JOURNAL")" = root:root:600 ]] \
    || die "install journal is unsafe"
  die "an interrupted install requires owner inspection before retry"
fi
if [ -L "$ACTIVE_RECEIPT" ]; then
  die "active provision receipt is a symlink"
elif [ -e "$ACTIVE_RECEIPT" ]; then
  [[ -f "$ACTIVE_RECEIPT" && "$(realpath -e -- "$ACTIVE_RECEIPT")" = "$ACTIVE_RECEIPT" ]] \
    || die "active provision receipt is unsafe"
  [ "$(stat -c '%U:%G:%a' -- "$ACTIVE_RECEIPT")" = root:nexus-drill-vm:640 ] \
    || die "active provision receipt must be root:nexus-drill-vm mode 0640"
  [ "$(stat -c '%s' -- "$ACTIVE_RECEIPT")" -le 65536 ] \
    || die "active provision receipt exceeds the accepted bound"
  active_runtime_output="$(
    python3 - "$ACTIVE_RECEIPT" <<'PY'
import json
import re
import sys
from pathlib import Path
value = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
hypervisor = value.get("hypervisor")
if value.get("schema") != "nexus.rollback-drill-vm-provision.v2" or not isinstance(hypervisor, dict):
    raise SystemExit("active provision receipt schema is invalid")
for name in (
    "runnerSha256",
    "unitSha256",
    "hostPreflightSha256",
    "runtimeManifestSha256",
    "runtimeControlSha256",
    "runtimeReadinessSha256",
    "runtimeRecoveryUnitSha256",
    "faultDrillControllerSha256",
    "faultDrillControllerUnitSha256",
    "faultDrillControllerRecoveryUnitSha256",
    "faultDrillGuestExecutorSha256",
    "faultDrillGuestRecoveryUnitSha256",
    "faultDrillVerifierSha256",
):
    digest = hypervisor.get(name)
    if not isinstance(digest, str) or re.fullmatch(r"[0-9a-f]{64}", digest) is None:
        raise SystemExit(f"active provision receipt {name} is invalid")
    print(digest)
PY
  )" || die "cannot validate active provision receipt"
  mapfile -t active_runtime_digests <<<"$active_runtime_output"
  [ "${#active_runtime_digests[@]}" -eq 13 ] \
    || die "active provision receipt runtime identity is incomplete"
  proposed_runner_sha256="$(sha256sum -- "${sources[$runner_index]}" | cut -d' ' -f1)"
  proposed_unit_sha256="$(sha256sum -- "${sources[$unit_index]}" | cut -d' ' -f1)"
  proposed_preflight_sha256="$(sha256sum -- "${sources[$preflight_index]}" | cut -d' ' -f1)"
  proposed_runtime_manifest_sha256="$(sha256sum -- "${sources[$runtime_manifest_index]}" | cut -d' ' -f1)"
  proposed_runtime_control_sha256="$(sha256sum -- "${sources[$runtime_control_index]}" | cut -d' ' -f1)"
  proposed_runtime_readiness_sha256="$(sha256sum -- "${sources[$runtime_readiness_index]}" | cut -d' ' -f1)"
  proposed_runtime_recovery_sha256="$(sha256sum -- "${sources[$runtime_recovery_index]}" | cut -d' ' -f1)"
  proposed_fault_controller_sha256="$(sha256sum -- "${sources[$fault_controller_index]}" | cut -d' ' -f1)"
  proposed_fault_controller_unit_sha256="$(sha256sum -- "${sources[$fault_controller_unit_index]}" | cut -d' ' -f1)"
  proposed_fault_controller_recovery_unit_sha256="$(sha256sum -- "${sources[$fault_controller_recovery_unit_index]}" | cut -d' ' -f1)"
  proposed_fault_guest_sha256="$(sha256sum -- "${sources[$fault_guest_index]}" | cut -d' ' -f1)"
  proposed_fault_guest_recovery_sha256="$(sha256sum -- "${sources[$fault_guest_recovery_index]}" | cut -d' ' -f1)"
  proposed_fault_verifier_sha256="$(sha256sum -- "${sources[$fault_drill_tool_index]}" | cut -d' ' -f1)"
  [ "$proposed_runner_sha256" = "${active_runtime_digests[0]}" ] \
    || die "active guest set binds a different runner; replacement is not automatic"
  [ "$proposed_unit_sha256" = "${active_runtime_digests[1]}" ] \
    || die "active guest set binds a different systemd unit; replacement is not automatic"
  [ "$proposed_preflight_sha256" = "${active_runtime_digests[2]}" ] \
    || die "active guest set binds a different host preflight; replacement is not automatic"
  [ "$proposed_runtime_manifest_sha256" = "${active_runtime_digests[3]}" ] \
    || die "active guest set binds a different runtime manifest helper; replacement is not automatic"
  [ "$proposed_runtime_control_sha256" = "${active_runtime_digests[4]}" ] \
    || die "active guest set binds a different guest runtime control; replacement is not automatic"
  [ "$proposed_runtime_readiness_sha256" = "${active_runtime_digests[5]}" ] \
    || die "active guest set binds a different readiness collector; replacement is not automatic"
  [ "$proposed_runtime_recovery_sha256" = "${active_runtime_digests[6]}" ] \
    || die "active guest set binds a different guest recovery unit; replacement is not automatic"
  [ "$proposed_fault_controller_sha256" = "${active_runtime_digests[7]}" ] \
    || die "active guest set binds a different fault controller; replacement is not automatic"
  [ "$proposed_fault_controller_unit_sha256" = "${active_runtime_digests[8]}" ] \
    || die "active guest set binds a different fault controller unit; replacement is not automatic"
  [ "$proposed_fault_controller_recovery_unit_sha256" = "${active_runtime_digests[9]}" ] \
    || die "active guest set binds a different fault recovery unit; replacement is not automatic"
  [ "$proposed_fault_guest_sha256" = "${active_runtime_digests[10]}" ] \
    || die "active guest set binds a different guest fault executor; replacement is not automatic"
  [ "$proposed_fault_guest_recovery_sha256" = "${active_runtime_digests[11]}" ] \
    || die "active guest set binds a different guest fault recovery unit; replacement is not automatic"
  [ "$proposed_fault_verifier_sha256" = "${active_runtime_digests[12]}" ] \
    || die "active guest set binds a different fault verifier; replacement is not automatic"
fi

stage_paths=()
backup_paths=()
committed_indices=()
user_created=false
group_created=false
journal_armed=false
install_succeeded=false
rollback_abandoned=false
controller_recovery_was_enabled=false
controller_recovery_enabled_by_install=false
if [ -L "$FAULT_CONTROLLER_RECOVERY_WANTS" ]; then
  [ "$(realpath -e -- "$FAULT_CONTROLLER_RECOVERY_WANTS")" \
      = "/etc/systemd/system/$FAULT_CONTROLLER_RECOVERY_UNIT" ] \
    || die "existing fault recovery enablement is unsafe"
  controller_recovery_was_enabled=true
elif [ -e "$FAULT_CONTROLLER_RECOVERY_WANTS" ]; then
  die "fault recovery enablement path is not a symbolic link"
fi

cleanup_install() {
  local rc=$? position index target backup rollback_failed=false
  trap - EXIT INT TERM
  if [ "$install_succeeded" != true ] \
      && [ "${controller_recovery_enabled_by_install:-false}" = true ]; then
    systemctl disable -- "$FAULT_CONTROLLER_RECOVERY_UNIT" >/dev/null 2>&1 \
      || rollback_failed=true
    [ ! -e "$FAULT_CONTROLLER_RECOVERY_WANTS" ] \
      && [ ! -L "$FAULT_CONTROLLER_RECOVERY_WANTS" ] \
      || rollback_failed=true
    [ ! -d "$(dirname -- "$FAULT_CONTROLLER_RECOVERY_WANTS")" ] \
      || fsync_path "$(dirname -- "$FAULT_CONTROLLER_RECOVERY_WANTS")" \
      || rollback_failed=true
  fi
  set +e
  if [ "$install_succeeded" != true ] && [ "$rollback_abandoned" = false ]; then
    for ((position=${#committed_indices[@]} - 1; position >= 0; position-=1)); do
      index="${committed_indices[$position]}"
      target="${targets[$index]}"
      backup="${backup_paths[$index]:-}"
      if [ "${had_targets[$index]}" = true ]; then
        if [ -n "$backup" ] && [[ -f "$backup" && ! -L "$backup" ]]; then
          if [[ -f "$target" && ! -L "$target" && "$backup" -ef "$target" ]]; then
            # GNU mv rejects moving a hard-link backup over the unchanged
            # predecessor. In that boundary the predecessor is already
            # restored, so only the redundant backup needs durable removal.
            durable_remove "$backup" || rollback_failed=true
          else
            mv -fT -- "$backup" "$target" \
              && fsync_path "$(dirname -- "$target")" \
              || rollback_failed=true
          fi
          backup_paths[$index]=""
        else
          rollback_failed=true
        fi
      else
        durable_remove "$target" || rollback_failed=true
      fi
    done
    if [ "${#committed_indices[@]}" -gt 0 ]; then
      systemctl daemon-reload >/dev/null 2>&1 || rollback_failed=true
    fi
  elif [ "$install_succeeded" != true ]; then
    rollback_failed=true
  fi
  for stage in "${stage_paths[@]:-}"; do
    [ -n "$stage" ] && durable_remove "$stage"
  done
  for backup in "${backup_paths[@]:-}"; do
    [ -n "$backup" ] && [ "$install_succeeded" = true ] && durable_remove "$backup"
  done
  if [ "$install_succeeded" != true ] \
      && [ "$journal_armed" = true ] \
      && [ "$rollback_failed" = false ]; then
    durable_remove "$INSTALL_JOURNAL" || rollback_failed=true
  fi
  if [ "$install_succeeded" != true ]; then
    [ "$user_created" = true ] && userdel "$EXPECTED_USER" >/dev/null 2>&1
    [ "$group_created" = true ] && groupdel "$EXPECTED_USER" >/dev/null 2>&1
    if [ "$state_existed" = false ]; then
      rm -f -- "$CONTROL_LOCK"
      rmdir -- "$STATE_ROOT" >/dev/null 2>&1
    fi
    if [ "$libexec_existed" = false ]; then
      rmdir -- /usr/local/libexec/nexus-rollback-drill-vm >/dev/null 2>&1
    fi
    if [ "$runtime_dir_existed" = false ]; then
      for runtime_lock in \
        /run/nexus-rollback-drill-vm/admission.lock \
        /run/nexus-rollback-drill-vm/active.lock \
        /run/nexus-rollback-drill-vm/release-layout-fault-controller.lock; do
        if [ -e "$runtime_lock" ] || [ -L "$runtime_lock" ]; then
          expected_runtime_lock_identity=root:nexus-drill-vm:660:1
          if [ "$runtime_lock" = /run/nexus-rollback-drill-vm/release-layout-fault-controller.lock ]; then
            expected_runtime_lock_identity=root:root:600:1
          fi
          if [ -f "$runtime_lock" ] && [ ! -L "$runtime_lock" ] \
              && [ "$(stat -c '%U:%G:%a:%h' -- "$runtime_lock")" = "$expected_runtime_lock_identity" ]; then
            rm -f -- "$runtime_lock" || rollback_failed=true
          else
            rollback_failed=true
          fi
        fi
      done
      if [ -e /run/nexus-rollback-drill-vm/handoff ] \
          || [ -L /run/nexus-rollback-drill-vm/handoff ]; then
        if [ -d /run/nexus-rollback-drill-vm/handoff ] \
            && [ ! -L /run/nexus-rollback-drill-vm/handoff ] \
            && [ "$(stat -c '%U:%G:%a' -- /run/nexus-rollback-drill-vm/handoff)" = root:nexus-drill-vm:750 ]; then
          rmdir -- /run/nexus-rollback-drill-vm/handoff >/dev/null 2>&1 \
            || rollback_failed=true
        else
          rollback_failed=true
        fi
      fi
      rmdir -- /run/nexus-rollback-drill-vm >/dev/null 2>&1 \
        || rollback_failed=true
    fi
  fi
  if [ "$rollback_failed" = true ]; then
    echo "rollback drill VM installer: rollback incomplete; install journal remains" >&2
    rc=1
  fi
  exit "$rc"
}
trap cleanup_install EXIT
trap 'exit 130' INT TERM

if [ "$user_existed" = false ]; then
  if ! useradd \
    --system \
    --user-group \
    --groups kvm \
    --home-dir /nonexistent \
    --no-create-home \
    --shell /usr/sbin/nologin \
    "$EXPECTED_USER"; then
    getent group "$EXPECTED_USER" >/dev/null 2>&1 \
      && groupdel "$EXPECTED_USER" >/dev/null 2>&1
    die "failed to create dedicated account"
  fi
  user_created=true
  group_created=true
fi
mapfile -t actual_groups < <(id -nG "$EXPECTED_USER" | tr ' ' '\n' | sort)
[ "${#actual_groups[@]}" -eq 2 ] \
  && [ "${actual_groups[0]}" = kvm ] \
  && [ "${actual_groups[1]}" = "$EXPECTED_USER" ] \
  || die "dedicated account group membership is invalid"

install -d -o root -g root -m 0755 /usr/local/libexec
install -d -o root -g root -m 0755 /usr/local/libexec/nexus-rollback-drill-vm
install -d -o root -g "$EXPECTED_USER" -m 0750 "$STATE_ROOT"
fsync_path /usr/local/libexec/nexus-rollback-drill-vm
fsync_path /usr/local/libexec
fsync_path "$STATE_ROOT"
fsync_path /var/lib

if [ -L "$CONTROL_LOCK" ]; then
  die "control lock is a symlink"
elif [ -e "$CONTROL_LOCK" ]; then
  [[ -f "$CONTROL_LOCK" && "$(stat -c '%U:%G:%a' "$CONTROL_LOCK")" = root:root:600 ]] \
    || die "control lock is unsafe"
fi
exec 9>"$CONTROL_LOCK"
chmod 0600 "$CONTROL_LOCK"
flock -n 9 || die "another rollback-drill install or provision transaction is active"

journal_stage="$(mktemp -p "$STATE_ROOT" .install-journal.XXXXXX)"
printf '{"schema":"nexus.rollback-drill-vm-install-journal.v1","status":"in_progress","sourceSha":"%s","archiveSha256":"%s"}\n' \
  "$SOURCE_SHA" "$EXPECTED_ARCHIVE_SHA256" >"$journal_stage"
chown root:root "$journal_stage"
chmod 0600 "$journal_stage"
fsync_path "$journal_stage"
mv -fT -- "$journal_stage" "$INSTALL_JOURNAL"
fsync_path "$STATE_ROOT"
journal_armed=true

for ((index=0; index<${#sources[@]}; index+=1)); do
  target="${targets[$index]}"
  parent="$(dirname -- "$target")"
  stage="$(mktemp -p "$parent" .nexus-rollback-drill-vm.stage.XXXXXX)"
  install -o root -g root -m "${modes[$index]}" -- "${sources[$index]}" "$stage"
  [ "$(sha256sum -- "$stage" | cut -d' ' -f1)" = "${source_digests[$index]}" ] \
    || die "staged asset digest differs from its reviewed source: $target"
  fsync_path "$stage"
  stage_paths[$index]="$stage"
  backup_paths[$index]=""
done

commit_asset() {
  local index="$1" target parent backup
  target="${targets[$index]}"
  parent="$(dirname -- "$target")"
  committed_indices+=("$index")
  if [ "${had_targets[$index]}" = true ]; then
    backup="$(mktemp -p "$parent" .nexus-rollback-drill-vm.backup.XXXXXX)"
    rm -f -- "$backup"
    ln -- "$target" "$backup"
    fsync_path "$parent"
    backup_paths[$index]="$backup"
  fi
  mv -fT -- "${stage_paths[$index]}" "$target"
  stage_paths[$index]=""
  fsync_path "$parent"
}

# The unit containing the journal conditions commits first. A host interruption
# therefore leaves every guest fail-closed until the compatibility set is whole.
commit_asset "$unit_index"
for ((index=0; index<${#sources[@]}; index+=1)); do
  [ "$index" -eq "$unit_index" ] && continue
  commit_asset "$index"
done
systemctl daemon-reload
systemd-tmpfiles --create /etc/tmpfiles.d/nexus-rollback-drill-vm.conf

assert_template_static false
[ "$SYSTEMD_UNIT_FILE_STATE" = static ] \
  || die "installed guest template must be static"
for guest in guest-1 guest-2 guest-3; do
  assert_guest_unit_inactive "nexus-rollback-drill-vm@$guest.service" false
done
for ((index=0; index<${#targets[@]}; index+=1)); do
  [ "$(sha256sum -- "${targets[$index]}" | cut -d' ' -f1)" = "${source_digests[$index]}" ] \
    || die "installed asset digest differs from its reviewed source: ${targets[$index]}"
done
if [ "$controller_recovery_was_enabled" = false ]; then
  controller_recovery_enabled_by_install=true
  systemctl enable -- "$FAULT_CONTROLLER_RECOVERY_UNIT" >/dev/null \
    || die "cannot enable the fault-drill boot recovery service"
fi
[[ -L "$FAULT_CONTROLLER_RECOVERY_WANTS" \
    && "$(realpath -e -- "$FAULT_CONTROLLER_RECOVERY_WANTS")" \
      = "/etc/systemd/system/$FAULT_CONTROLLER_RECOVERY_UNIT" ]] \
  || die "fault-drill boot recovery enablement is invalid"
fsync_path "$(dirname -- "$FAULT_CONTROLLER_RECOVERY_WANTS")"

rollback_abandoned=true
for backup in "${backup_paths[@]:-}"; do
  [ -n "$backup" ] && durable_remove "$backup"
done
durable_remove "$INSTALL_JOURNAL"
journal_armed=false
install_succeeded=true
printf '{"ok":true,"schema":"nexus.rollback-drill-vm-install.v1","sourceSha":"%s","archiveSha256":"%s","installedAssets":16,"serviceUser":"%s","servicesStarted":false,"servicesEnabled":false,"recoveryServiceEnabled":true,"guestDataCreated":false}\n' \
  "$SOURCE_SHA" "$EXPECTED_ARCHIVE_SHA256" "$EXPECTED_USER"
