#!/usr/bin/env bash
# Run exactly one previously provisioned rollback-drill guest. This helper is
# installed root-owned and invoked only by the static systemd template.
set -euo pipefail
umask 077
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

STATE_ROOT="/var/lib/nexus-rollback-drill-vm"
ACTIVE_RECEIPT="$STATE_ROOT/active.json"
RUN_LOCK="/run/nexus-rollback-drill-vm/active.lock"
ADMISSION_LOCK="/run/nexus-rollback-drill-vm/admission.lock"
HANDOFF_DIR="/run/nexus-rollback-drill-vm/handoff"
SHARED_MUTEX="/run/lock/nexus-release-sonar.lock"
EXPECTED_USER="nexus-drill-vm"
QEMU_BIN="/usr/bin/qemu-system-x86_64"
QEMU_IMG="/usr/bin/qemu-img"
DPKG_QUERY="/usr/bin/dpkg-query"
RUNNER_PATH="/usr/local/libexec/nexus-rollback-drill-vm/run"
HOST_PREFLIGHT_PATH="/usr/local/libexec/nexus-rollback-drill-vm/host-preflight"
RUNTIME_MANIFEST_PATH="/usr/local/libexec/nexus-rollback-drill-vm/runtime-manifest"
RUNTIME_CONTROL_SOURCE_PATH="/usr/local/libexec/nexus-rollback-drill-vm/runtime-control-guest"
RUNTIME_READINESS_PATH="/usr/local/libexec/nexus-rollback-drill-vm/runtime-readiness"
RUNTIME_RECOVERY_UNIT_SOURCE_PATH="/usr/local/libexec/nexus-rollback-drill-vm/runtime-recovery.service"
UNIT_PATH="/etc/systemd/system/nexus-rollback-drill-vm@.service"

die() {
  echo "rollback drill VM runner: $*" >&2
  exit 1
}

[ "$#" -eq 1 ] || die "usage: rollback-drill-vm-run <guest-1|guest-2|guest-3>"
guest="$1"
case "$guest" in
  guest-1|guest-2|guest-3) ;;
  *) die "guest identity is outside the fixed three-guest allowlist" ;;
esac

[ "$(id -un)" = "$EXPECTED_USER" ] \
  || die "must run as the dedicated nexus-drill-vm identity"
for command in flock id python3 readlink realpath sha256sum stat; do
  command -v "$command" >/dev/null 2>&1 || die "$command is required"
done
[[ -x "$QEMU_BIN" && ! -L "$QEMU_BIN" ]] || die "reviewed QEMU binary is unavailable"
[[ -x "$QEMU_IMG" && ! -L "$QEMU_IMG" ]] || die "reviewed qemu-img binary is unavailable"
[[ -x "$DPKG_QUERY" && ! -L "$DPKG_QUERY" ]] || die "dpkg-query is unavailable"
[ "$(stat -c '%U:%G' -- "$QEMU_BIN")" = root:root ] \
  || die "reviewed QEMU binary is not root-owned"
qemu_mode="$(stat -c '%a' -- "$QEMU_BIN")"
(( (8#$qemu_mode & 0022) == 0 )) \
  || die "reviewed QEMU binary is group/world writable"
[[ -c /dev/kvm && -r /dev/kvm && -w /dev/kvm ]] || die "/dev/kvm is unavailable"

acquire_shared_release_mutex() {
  local path_identity descriptor_identity
  [[ -f "$SHARED_MUTEX" && ! -L "$SHARED_MUTEX" ]] \
    || die "shared release/Sonar mutex is missing or unsafe"
  [ "$(realpath -e -- "$SHARED_MUTEX")" = "$SHARED_MUTEX" ] \
    && [ "$(stat -c '%U:%G:%a' -- "$SHARED_MUTEX")" = root:dominguez:660 ] \
    || die "shared release/Sonar mutex must be root:dominguez mode 0660"
  [ "${LISTEN_PID:-}" = "$$" ] \
    && [ "${LISTEN_FDS:-}" = 2 ] \
    && [ "${LISTEN_FDNAMES:-}" = release-sonar-lock:rollback-drill-run-lock ] \
    || die "shared mutex descriptor was not supplied by the reviewed systemd unit"
  [[ -e /proc/self/fd/3 && "$(readlink -f -- /proc/self/fd/3)" = "$SHARED_MUTEX" ]] \
    || die "systemd supplied an unexpected shared mutex descriptor"
  path_identity="$(stat -c '%d:%i' -- "$SHARED_MUTEX")"
  descriptor_identity="$(stat -Lc '%d:%i' -- /proc/self/fd/3)"
  [ "$descriptor_identity" = "$path_identity" ] \
    && [ "$(stat -Lc '%U:%G:%a' -- /proc/self/fd/3)" = root:dominguez:660 ] \
    || die "systemd shared mutex descriptor identity is invalid"
  flock -n 3 \
    || die "a release, Sonar operation, or rollback drill holds the shared mutex"
}
acquire_shared_release_mutex

acquire_guest_admission() {
  local path_identity descriptor_identity
  [[ -f "$ADMISSION_LOCK" && ! -L "$ADMISSION_LOCK" ]] \
    || die "guest admission lock is missing or unsafe"
  [ "$(realpath -e -- "$ADMISSION_LOCK")" = "$ADMISSION_LOCK" ] \
    && [ "$(stat -c '%U:%G:%a:%h' -- "$ADMISSION_LOCK")" = root:nexus-drill-vm:660:1 ] \
    || die "guest admission lock must be root:nexus-drill-vm mode 0660 with one link"
  exec 5<>"$ADMISSION_LOCK"
  path_identity="$(stat -c '%d:%i' -- "$ADMISSION_LOCK")"
  descriptor_identity="$(stat -Lc '%d:%i' -- /proc/self/fd/5)"
  [ "$descriptor_identity" = "$path_identity" ] \
    && [ "$(stat -Lc '%U:%G:%a:%h' -- /proc/self/fd/5)" = root:nexus-drill-vm:660:1 ] \
    || die "guest admission descriptor identity is invalid"
  flock -n 5 \
    || die "runtime readiness collection currently blocks new guest starts"
  [ "$(stat -c '%d:%i' -- "$ADMISSION_LOCK")" = "$descriptor_identity" ] \
    || die "guest admission-lock path changed after acquisition"
}
acquire_guest_admission

acquire_single_guest_lock() {
  local run_directory path_identity descriptor_identity
  run_directory="$(dirname -- "$RUN_LOCK")"
  [[ -d "$run_directory" && ! -L "$run_directory" ]] \
    || die "global guest-lock directory is unavailable"
  [ "$(realpath -e -- "$run_directory")" = "$run_directory" ] \
    && [ "$(stat -c '%U:%G:%a' -- "$run_directory")" = root:nexus-drill-vm:750 ] \
    || die "global guest-lock directory must be root:nexus-drill-vm mode 0750"
  [[ -f "$RUN_LOCK" && ! -L "$RUN_LOCK" ]] \
    || die "global guest lock is unavailable"
  [ "$(realpath -e -- "$RUN_LOCK")" = "$RUN_LOCK" ] \
    && [ "$(stat -c '%U:%G:%a:%h' -- "$RUN_LOCK")" = root:nexus-drill-vm:660:1 ] \
    || die "global guest lock must be root:nexus-drill-vm mode 0660 with one link"
  [[ -e /proc/self/fd/4 && "$(readlink -f -- /proc/self/fd/4)" = "$RUN_LOCK" ]] \
    || die "systemd supplied an unexpected global guest-lock descriptor"
  path_identity="$(stat -c '%d:%i' -- "$RUN_LOCK")"
  descriptor_identity="$(stat -Lc '%d:%i' -- /proc/self/fd/4)"
  [ "$descriptor_identity" = "$path_identity" ] \
    && [ "$(stat -Lc '%U:%G:%a:%h' -- /proc/self/fd/4)" = root:nexus-drill-vm:660:1 ] \
    || die "systemd global guest-lock descriptor identity is invalid"
  flock -n 4 || die "another rollback-drill guest is already active"
  [ "$(stat -c '%d:%i' -- "$RUN_LOCK")" = "$descriptor_identity" ] \
    || die "global guest-lock path changed after acquisition"
}
acquire_single_guest_lock
flock -u 5 || die "cannot release the guest admission lock after admission"

python3 - <<'PY' || die "host capacity changed below the rollback-drill admission floor"
import pathlib
import re

meminfo = pathlib.Path("/proc/meminfo").read_text(encoding="ascii")
match = re.search(r"^MemAvailable:\s+([0-9]+)\s+kB$", meminfo, re.MULTILINE)
if match is None or int(match.group(1)) < 25 * 1024 * 1024:
    raise SystemExit("MemAvailable is below 25 GiB")
load_fields = pathlib.Path("/proc/loadavg").read_text(encoding="ascii").split()
if len(load_fields) < 3 or re.fullmatch(r"[0-9]+(?:\.[0-9]+)?", load_fields[2]) is None:
    raise SystemExit("load-15 is unavailable")
if float(load_fields[2]) >= 6:
    raise SystemExit("load-15 is at or above 6")
PY

[[ -f "$ACTIVE_RECEIPT" && ! -L "$ACTIVE_RECEIPT" ]] \
  || die "active provision receipt is missing or unsafe"
[ "$(stat -c '%U:%G:%a' -- "$ACTIVE_RECEIPT")" = root:nexus-drill-vm:640 ] \
  || die "active provision receipt must be root:nexus-drill-vm mode 0640"
[ "$(stat -c '%s' -- "$ACTIVE_RECEIPT")" -le 65536 ] \
  || die "active provision receipt exceeds the accepted bound"
active_receipt_sha256="$(sha256sum -- "$ACTIVE_RECEIPT" | cut -d' ' -f1)"
[[ "$active_receipt_sha256" =~ ^[0-9a-f]{64}$ ]] \
  || die "cannot derive the active provision receipt identity"

mapfile -t selected < <(
  python3 - "$ACTIVE_RECEIPT" "$guest" <<'PY'
import base64
import hashlib
import json
import re
import sys
from pathlib import Path

receipt_path, guest_name = sys.argv[1:]
hex64 = re.compile(r"^[0-9a-f]{64}$")
uuid = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
mac = re.compile(r"^52:54:00(?::[0-9a-f]{2}){3}$")
fingerprint = re.compile(r"^SHA256:[A-Za-z0-9+/]{43}$")
try:
    value = json.loads(Path(receipt_path).read_text(encoding="utf-8"))
except Exception as error:
    raise SystemExit(f"cannot read provision receipt: {error}")
if set(value) != {
    "schema", "setId", "image", "sshPublicKeySha256",
    "guestSshHostPublicKeySha256", "ports",
    "setDirectory", "runtimeReadiness", "hypervisor", "guests", "createdAt"
}:
    raise SystemExit("provision receipt has an unexpected schema")
if value["schema"] != "nexus.rollback-drill-vm-provision.v1":
    raise SystemExit("provision receipt schema is invalid")
if not hex64.fullmatch(value["setId"]):
    raise SystemExit("provision set identity is invalid")
if not hex64.fullmatch(value["sshPublicKeySha256"]):
    raise SystemExit("SSH public-key digest is invalid")
if not hex64.fullmatch(value["guestSshHostPublicKeySha256"]):
    raise SystemExit("SSH host public-key digest is invalid")
if value["sshPublicKeySha256"] == value["guestSshHostPublicKeySha256"]:
    raise SystemExit("SSH client and host identities must be independent")
expected_set = f"/var/lib/nexus-rollback-drill-vm/sets/{value['setId']}"
if value["setDirectory"] != expected_set:
    raise SystemExit("provision set path is noncanonical")
if not isinstance(value["ports"], list) or len(value["ports"]) != 3:
    raise SystemExit("provision ports are invalid")
if any(type(port) is not int or port < 1024 or port > 65535 for port in value["ports"]):
    raise SystemExit("provision port is outside the allowed range")
if len(set(value["ports"])) != 3:
    raise SystemExit("provision ports are not unique")
if not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", value["createdAt"]):
    raise SystemExit("provision creation time is invalid")
image = value["image"]
if set(image) != {"filename", "sha256", "basePath"}:
    raise SystemExit("image receipt has an unexpected schema")
if image["filename"] != "noble-server-cloudimg-amd64.img" or not hex64.fullmatch(image["sha256"]):
    raise SystemExit("image identity is invalid")
if image["basePath"] != f"/var/lib/nexus-rollback-drill-vm/base/{image['sha256']}.qcow2":
    raise SystemExit("base image path is noncanonical")
if value["runtimeReadiness"] != {
    "status": "ssh_only_bootstrap_required",
    "drillReady": False,
    "requirements": [
        "node-22.23.1",
        "python-3.12.x",
        "pm2-6.0.14-at-/opt/nexus-rollback-drill-vm/runtime/pm2-6.0.14/bin/pm2",
        "digest-bound-offline-toolchain-evidence",
    ],
}:
    raise SystemExit("guest runtime-readiness boundary is invalid")
hypervisor = value["hypervisor"]
if set(hypervisor) != {
    "manager", "qemuBinary", "qemuSha256", "qemuVersion", "qemuPackage",
    "qemuPackageVersion", "qemuPackageArchitecture", "runnerPath",
    "runnerSha256", "hostPreflightPath", "hostPreflightSha256",
    "runtimeManifestPath", "runtimeManifestSha256",
    "runtimeControlSourcePath", "runtimeControlSha256",
    "runtimeReadinessPath", "runtimeReadinessSha256",
    "runtimeRecoveryUnitSourcePath", "runtimeRecoveryUnitSha256",
    "sharedMutexPath", "guestAdmissionLockPath", "hostAvailableMemoryFloorGiB",
    "hostLoad15CeilingExclusive", "unitTemplate", "unitPath", "unitSha256",
    "vcpus", "memoryMiB", "memorySwapMaxMiB", "diskBytes",
    "networkMode", "loopbackHost", "singleActiveGuest", "bridgeAttached",
    "tapAttached", "sharedFilesystemAttached", "hostBlockDeviceAttached",
    "productionDataAttached",
}:
    raise SystemExit("hypervisor receipt has an unexpected schema")
expected_hypervisor = {
    "manager": "qemu-systemd",
    "qemuBinary": "/usr/bin/qemu-system-x86_64",
    "runnerPath": "/usr/local/libexec/nexus-rollback-drill-vm/run",
    "hostPreflightPath": "/usr/local/libexec/nexus-rollback-drill-vm/host-preflight",
    "runtimeManifestPath": "/usr/local/libexec/nexus-rollback-drill-vm/runtime-manifest",
    "runtimeControlSourcePath": "/usr/local/libexec/nexus-rollback-drill-vm/runtime-control-guest",
    "runtimeReadinessPath": "/usr/local/libexec/nexus-rollback-drill-vm/runtime-readiness",
    "runtimeRecoveryUnitSourcePath": "/usr/local/libexec/nexus-rollback-drill-vm/runtime-recovery.service",
    "sharedMutexPath": "/run/lock/nexus-release-sonar.lock",
    "guestAdmissionLockPath": "/run/nexus-rollback-drill-vm/admission.lock",
    "hostAvailableMemoryFloorGiB": 25,
    "hostLoad15CeilingExclusive": 6,
    "unitTemplate": "nexus-rollback-drill-vm@.service",
    "unitPath": "/etc/systemd/system/nexus-rollback-drill-vm@.service",
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
}
for key, expected in expected_hypervisor.items():
    if hypervisor.get(key) != expected:
        raise SystemExit(f"hypervisor contract drifted at {key}")
for name in (
    "runnerSha256",
    "unitSha256",
    "hostPreflightSha256",
    "runtimeManifestSha256",
    "runtimeControlSha256",
    "runtimeReadinessSha256",
    "runtimeRecoveryUnitSha256",
):
    if not hex64.fullmatch(hypervisor.get(name, "")):
        raise SystemExit(f"{name} digest is invalid")
if not hex64.fullmatch(hypervisor.get("qemuSha256", "")):
    raise SystemExit("QEMU digest is invalid")
if re.fullmatch(r"QEMU emulator version [ -~]{1,230}", hypervisor.get("qemuVersion", "")) is None:
    raise SystemExit("QEMU version is invalid")
if re.fullmatch(r"[a-z0-9][a-z0-9+.-]*(?::[a-z0-9][a-z0-9-]*)?", hypervisor.get("qemuPackage", "")) is None:
    raise SystemExit("QEMU package is invalid")
if re.fullmatch(r"[A-Za-z0-9.+:~_-]+", hypervisor.get("qemuPackageVersion", "")) is None:
    raise SystemExit("QEMU package version is invalid")
if re.fullmatch(r"[a-z0-9][a-z0-9-]*", hypervisor.get("qemuPackageArchitecture", "")) is None:
    raise SystemExit("QEMU package architecture is invalid")
set_material = (
    "schema=nexus.rollback-drill-vm-provision.v1\n"
    f"image={image['sha256']}\n"
    f"key={value['sshPublicKeySha256']}\n"
    f"hostKey={value['guestSshHostPublicKeySha256']}\n"
    f"ports={value['ports'][0]},{value['ports'][1]},{value['ports'][2]}\n"
    f"runner={hypervisor['runnerSha256']}\n"
    f"hostPreflight={hypervisor['hostPreflightSha256']}\n"
    f"runtimeManifest={hypervisor['runtimeManifestSha256']}\n"
    f"runtimeControl={hypervisor['runtimeControlSha256']}\n"
    f"runtimeReadiness={hypervisor['runtimeReadinessSha256']}\n"
    f"runtimeRecoveryUnit={hypervisor['runtimeRecoveryUnitSha256']}\n"
    f"unit={hypervisor['unitSha256']}\n"
    f"qemu={hypervisor['qemuSha256']}\n"
    f"qemuVersion={hypervisor['qemuVersion']}\n"
    f"qemuPackage={hypervisor['qemuPackage']}\n"
    f"qemuPackageVersion={hypervisor['qemuPackageVersion']}\n"
    f"qemuPackageArchitecture={hypervisor['qemuPackageArchitecture']}\n"
)
if hashlib.sha256(set_material.encode("utf-8")).hexdigest() != value["setId"]:
    raise SystemExit("provision set identity does not bind the hypervisor contract")
guests = value["guests"]
if not isinstance(guests, list) or len(guests) != 3:
    raise SystemExit("guest inventory must contain exactly three entries")
if [entry.get("name") for entry in guests] != ["guest-1", "guest-2", "guest-3"]:
    raise SystemExit("guest inventory is not canonical")
observed_uuids = set()
observed_macs = set()
observed_fingerprints = set()
for slot, candidate in enumerate(guests, start=1):
    if set(candidate) != {
        "name", "port", "unit", "uuid", "mac", "instanceId", "overlayPath",
        "overlayInitialSha256", "seedPath", "seedSha256", "hostPublicKey",
        "hostKeyFingerprint"
    }:
        raise SystemExit("guest receipt has an unexpected schema")
    candidate_name = f"guest-{slot}"
    candidate_root = f"{expected_set}/{candidate_name}"
    if candidate["name"] != candidate_name or candidate["port"] != value["ports"][slot - 1]:
        raise SystemExit("guest slot identity is invalid")
    if candidate["unit"] != f"nexus-rollback-drill-vm@{candidate_name}.service":
        raise SystemExit("guest unit identity is invalid")
    if not uuid.fullmatch(candidate["uuid"]) or not mac.fullmatch(candidate["mac"]):
        raise SystemExit("guest machine identity is invalid")
    if candidate["instanceId"] != f"nexus-rollback-drill-{candidate_name}-{value['setId'][:16]}":
        raise SystemExit("guest cloud-init identity is invalid")
    if candidate["overlayPath"] != f"{candidate_root}/root.qcow2":
        raise SystemExit("guest overlay path is noncanonical")
    if candidate["seedPath"] != f"{candidate_root}/seed.img":
        raise SystemExit("guest seed path is noncanonical")
    if not hex64.fullmatch(candidate["seedSha256"]):
        raise SystemExit("guest seed digest is invalid")
    if not hex64.fullmatch(candidate["overlayInitialSha256"]):
        raise SystemExit("guest initial overlay digest is invalid")
    fields = candidate["hostPublicKey"].split()
    if len(fields) != 2 or fields[0] != "ssh-ed25519":
        raise SystemExit("guest host public key is invalid")
    try:
        host_key_bytes = base64.b64decode(fields[1], validate=True)
    except Exception:
        raise SystemExit("guest host public key is invalid")
    expected_fingerprint = "SHA256:" + base64.b64encode(
        hashlib.sha256(host_key_bytes).digest()
    ).decode("ascii").rstrip("=")
    if candidate["hostKeyFingerprint"] != expected_fingerprint:
        raise SystemExit("guest host-key fingerprint does not match its public key")
    expected_public_key_sha = hashlib.sha256(
        candidate["hostPublicKey"].strip().encode("utf-8")
    ).hexdigest()
    if expected_public_key_sha != value["guestSshHostPublicKeySha256"]:
        raise SystemExit("guest host public key is not the provision-set identity")
    if not fingerprint.fullmatch(candidate["hostKeyFingerprint"]):
        raise SystemExit("guest host-key fingerprint is invalid")
    observed_uuids.add(candidate["uuid"])
    observed_macs.add(candidate["mac"])
    observed_fingerprints.add(candidate["hostKeyFingerprint"])
if len(observed_uuids) != 3 or len(observed_macs) != 3 or len(observed_fingerprints) != 1:
    raise SystemExit(
        "guest machine identities must be independent and SSH host identity set-scoped"
    )
entry = next((candidate for candidate in guests if candidate.get("name") == guest_name), None)
if entry is None or set(entry) != {
    "name", "port", "unit", "uuid", "mac", "instanceId", "overlayPath",
    "overlayInitialSha256", "seedPath", "seedSha256", "hostPublicKey",
    "hostKeyFingerprint"
}:
    raise SystemExit("selected guest receipt is invalid")
index = int(guest_name[-1]) - 1
guest_root = f"{expected_set}/{guest_name}"
if entry["port"] != value["ports"][index]:
    raise SystemExit("guest port is not bound to its canonical slot")
if not uuid.fullmatch(entry["uuid"]) or not mac.fullmatch(entry["mac"]):
    raise SystemExit("guest machine identity is invalid")
if entry["instanceId"] != f"nexus-rollback-drill-{guest_name}-{value['setId'][:16]}":
    raise SystemExit("guest cloud-init identity is invalid")
if entry["overlayPath"] != f"{guest_root}/root.qcow2":
    raise SystemExit("guest overlay path is noncanonical")
if entry["seedPath"] != f"{guest_root}/seed.img":
    raise SystemExit("guest seed path is noncanonical")
if not hex64.fullmatch(entry["seedSha256"]):
    raise SystemExit("guest seed digest is invalid")
if not fingerprint.fullmatch(entry["hostKeyFingerprint"]):
    raise SystemExit("guest host-key fingerprint is invalid")
for output in (
    expected_set, image["basePath"], image["sha256"], entry["overlayPath"],
    entry["overlayInitialSha256"], entry["seedPath"], entry["seedSha256"],
    str(entry["port"]), entry["uuid"], entry["mac"], entry["instanceId"],
    hypervisor["runnerSha256"], hypervisor["unitSha256"],
    hypervisor["hostPreflightSha256"],
    hypervisor["runtimeManifestSha256"], hypervisor["runtimeControlSha256"],
    hypervisor["runtimeReadinessSha256"], hypervisor["runtimeRecoveryUnitSha256"],
    hypervisor["qemuSha256"], hypervisor["qemuVersion"],
    hypervisor["qemuPackage"], hypervisor["qemuPackageVersion"],
    hypervisor["qemuPackageArchitecture"],
):
    print(output)
PY
)
[ "${#selected[@]}" -eq 23 ] || die "provision receipt selection failed"
set_directory="${selected[0]}"
base_path="${selected[1]}"
base_sha256="${selected[2]}"
overlay_path="${selected[3]}"
overlay_initial_sha256="${selected[4]}"
seed_path="${selected[5]}"
seed_sha256="${selected[6]}"
port="${selected[7]}"
vm_uuid="${selected[8]}"
mac="${selected[9]}"
instance_id="${selected[10]}"
runner_sha256="${selected[11]}"
unit_sha256="${selected[12]}"
host_preflight_sha256="${selected[13]}"
runtime_manifest_sha256="${selected[14]}"
runtime_control_sha256="${selected[15]}"
runtime_readiness_sha256="${selected[16]}"
runtime_recovery_unit_sha256="${selected[17]}"
qemu_sha256="${selected[18]}"
qemu_version="${selected[19]}"
qemu_package="${selected[20]}"
qemu_package_version="${selected[21]}"
qemu_package_architecture="${selected[22]}"

for directory in "$STATE_ROOT" "$STATE_ROOT/base" "$STATE_ROOT/sets" "$set_directory" "$(dirname -- "$overlay_path")"; do
  [[ -d "$directory" && ! -L "$directory" ]] \
    || die "provision directory is missing or unsafe: $directory"
  [ "$(realpath -e -- "$directory")" = "$directory" ] \
    || die "provision directory traverses a symlink: $directory"
done
[ "$(stat -c '%U:%G:%a' -- "$STATE_ROOT")" = root:nexus-drill-vm:750 ] \
  || die "state root ownership or mode is unsafe"
[ "$(stat -c '%U:%G:%a' -- "$STATE_ROOT/base")" = root:nexus-drill-vm:750 ] \
  || die "base directory ownership or mode is unsafe"
[ "$(stat -c '%U:%G:%a' -- "$STATE_ROOT/sets")" = root:nexus-drill-vm:750 ] \
  || die "set directory ownership or mode is unsafe"
[ "$(stat -c '%U:%G:%a' -- "$set_directory")" = root:nexus-drill-vm:750 ] \
  || die "active set ownership or mode is unsafe"
[ "$(stat -c '%U:%G:%a' -- "$(dirname -- "$overlay_path")")" = root:nexus-drill-vm:750 ] \
  || die "guest directory ownership or mode is unsafe"
[[ -f "$base_path" && ! -L "$base_path" ]] || die "base image is missing or unsafe"
[[ -f "$overlay_path" && ! -L "$overlay_path" ]] || die "guest overlay is missing or unsafe"
[[ -f "$seed_path" && ! -L "$seed_path" ]] || die "guest seed is missing or unsafe"
[ "$(realpath -e -- "$base_path")" = "$base_path" ] || die "base image traverses a symlink"
[ "$(realpath -e -- "$overlay_path")" = "$overlay_path" ] || die "guest overlay traverses a symlink"
[ "$(realpath -e -- "$seed_path")" = "$seed_path" ] || die "guest seed traverses a symlink"
[ "$(stat -c '%U:%G:%a' -- "$base_path")" = root:nexus-drill-vm:440 ] \
  || die "base image ownership or mode is unsafe"
[ "$(stat -c '%U:%G:%a' -- "$overlay_path")" = nexus-drill-vm:nexus-drill-vm:600 ] \
  || die "guest overlay ownership or mode is unsafe"
[ "$(stat -c '%U:%G:%a' -- "$seed_path")" = root:nexus-drill-vm:640 ] \
  || die "guest seed ownership or mode is unsafe"
[[ -f "$RUNNER_PATH" && ! -L "$RUNNER_PATH" ]] || die "installed runner is unsafe"
[[ -f "$UNIT_PATH" && ! -L "$UNIT_PATH" ]] || die "installed unit is unsafe"
[[ -f "$HOST_PREFLIGHT_PATH" && ! -L "$HOST_PREFLIGHT_PATH" ]] \
  || die "installed host preflight is unsafe"
[[ -f "$RUNTIME_MANIFEST_PATH" && ! -L "$RUNTIME_MANIFEST_PATH" ]] \
  || die "installed runtime manifest helper is unsafe"
[[ -f "$RUNTIME_CONTROL_SOURCE_PATH" && ! -L "$RUNTIME_CONTROL_SOURCE_PATH" ]] \
  || die "installed guest runtime control source is unsafe"
[[ -f "$RUNTIME_READINESS_PATH" && ! -L "$RUNTIME_READINESS_PATH" ]] \
  || die "installed runtime readiness collector is unsafe"
[[ -f "$RUNTIME_RECOVERY_UNIT_SOURCE_PATH" && ! -L "$RUNTIME_RECOVERY_UNIT_SOURCE_PATH" ]] \
  || die "installed guest runtime recovery unit source is unsafe"
[ "$(stat -c '%U:%G:%a' -- "$RUNNER_PATH")" = root:root:755 ] \
  || die "installed runner ownership or mode is unsafe"
[ "$(stat -c '%U:%G:%a' -- "$UNIT_PATH")" = root:root:644 ] \
  || die "installed unit ownership or mode is unsafe"
[ "$(stat -c '%U:%G:%a' -- "$HOST_PREFLIGHT_PATH")" = root:root:755 ] \
  || die "installed host preflight ownership or mode is unsafe"
[ "$(stat -c '%U:%G:%a' -- "$RUNTIME_MANIFEST_PATH")" = root:root:755 ] \
  || die "installed runtime manifest helper ownership or mode is unsafe"
[ "$(stat -c '%U:%G:%a' -- "$RUNTIME_CONTROL_SOURCE_PATH")" = root:root:755 ] \
  || die "installed guest runtime control source ownership or mode is unsafe"
[ "$(stat -c '%U:%G:%a' -- "$RUNTIME_READINESS_PATH")" = root:root:755 ] \
  || die "installed runtime readiness collector ownership or mode is unsafe"
[ "$(stat -c '%U:%G:%a' -- "$RUNTIME_RECOVERY_UNIT_SOURCE_PATH")" = root:root:644 ] \
  || die "installed guest runtime recovery unit source ownership or mode is unsafe"
printf '%s  %s\n' "$runner_sha256" "$RUNNER_PATH" | sha256sum --check --status \
  || die "installed runner digest drifted"
printf '%s  %s\n' "$unit_sha256" "$UNIT_PATH" | sha256sum --check --status \
  || die "installed unit digest drifted"
printf '%s  %s\n' "$host_preflight_sha256" "$HOST_PREFLIGHT_PATH" | sha256sum --check --status \
  || die "installed host preflight digest drifted"
printf '%s  %s\n' "$runtime_manifest_sha256" "$RUNTIME_MANIFEST_PATH" | sha256sum --check --status \
  || die "installed runtime manifest helper digest drifted"
printf '%s  %s\n' "$runtime_control_sha256" "$RUNTIME_CONTROL_SOURCE_PATH" | sha256sum --check --status \
  || die "installed guest runtime control source digest drifted"
printf '%s  %s\n' "$runtime_readiness_sha256" "$RUNTIME_READINESS_PATH" | sha256sum --check --status \
  || die "installed runtime readiness collector digest drifted"
printf '%s  %s\n' "$runtime_recovery_unit_sha256" "$RUNTIME_RECOVERY_UNIT_SOURCE_PATH" | sha256sum --check --status \
  || die "installed guest runtime recovery unit source digest drifted"
printf '%s  %s\n' "$qemu_sha256" "$QEMU_BIN" | sha256sum --check --status \
  || die "installed QEMU binary digest drifted"
printf '%s  %s\n' "$base_sha256" "$base_path" | sha256sum --check --status \
  || die "base image digest drifted"
set_id="${set_directory##*/}"
expected_overlay_sha256="$overlay_initial_sha256"
readiness="$STATE_ROOT/runtime-readiness/$set_id/$guest.json"
if [ -e "$readiness" ] || [ -L "$readiness" ]; then
  [ -f "$readiness" ] && [ ! -L "$readiness" ] \
    && [ "$(realpath -e -- "$readiness")" = "$readiness" ] \
    && [ "$(stat -c '%U:%G:%a:%h' -- "$readiness")" = root:nexus-drill-vm:640:1 ] \
    && [ "$(stat -c '%s' -- "$readiness")" -le 1048576 ] \
    || die "runtime readiness receipt is missing or unsafe"
  expected_overlay_sha256="$(
    python3 - "$readiness" "$set_id" "$guest" "$port" \
      "$active_receipt_sha256" "$overlay_path" "$overlay_initial_sha256" \
      "$vm_uuid" "$instance_id" "$mac" <<'PY'
import json,re,sys
from pathlib import Path
(
 path,set_id,guest,port,provision_sha,overlay_path,overlay_initial,
 uuid,instance_id,mac,
)=sys.argv[1:]
hex64=re.compile(r"^[0-9a-f]{64}$")
iso=re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
value=json.loads(Path(path).read_text(encoding="utf-8"))
if set(value)!={
 "schema","status","drillReady","sealedAt","setId","guest","port",
 "provisionReceiptSha256","bundleManifestSha256","ownerAuthorization",
 "guestMeasurement","machine","qemu","stoppedGuestProof","overlay",
 "runtime","control","pm2DryHealth","networkInstallAttempted",
}:
 raise SystemExit("runtime readiness receipt schema is invalid")
if (
 value["schema"]!="nexus.rollback-drill-vm-runtime-readiness.v2"
 or value["status"]!="ready"
 or value["drillReady"] is not True
 or not iso.fullmatch(value["sealedAt"])
 or value["setId"]!=set_id
 or value["guest"]!=guest
 or value["port"]!=int(port)
 or value["provisionReceiptSha256"]!=provision_sha
 or not hex64.fullmatch(value["bundleManifestSha256"])
 or value["networkInstallAttempted"] is not False
):
 raise SystemExit("runtime readiness receipt boundary is invalid")
machine=value["machine"]
if machine!={
 "uuid":uuid,
 "instanceId":instance_id,
 "mac":mac,
 "sshHostKeyFingerprint":machine.get("sshHostKeyFingerprint"),
 "sshHostPublicKeySha256":machine.get("sshHostPublicKeySha256"),
}:
 raise SystemExit("runtime readiness machine identity is invalid")
if (
 not isinstance(machine["sshHostKeyFingerprint"],str)
 or not machine["sshHostKeyFingerprint"].startswith("SHA256:")
 or not hex64.fullmatch(machine["sshHostPublicKeySha256"])
):
 raise SystemExit("runtime readiness SSH host identity is invalid")
overlay=value["overlay"]
if set(overlay)!={
 "path","initialSha256","currentSha256","size","device","inode","mtimeNs",
 "ctimeNs","stableDescriptor",
} or (
 overlay["path"]!=overlay_path
 or overlay["initialSha256"]!=overlay_initial
 or not hex64.fullmatch(overlay["currentSha256"])
 or type(overlay["size"]) is not int or overlay["size"]<=0
 or type(overlay["device"]) is not int or overlay["device"]<=0
 or type(overlay["inode"]) is not int or overlay["inode"]<=0
 or type(overlay["mtimeNs"]) is not int or overlay["mtimeNs"]<=0
 or type(overlay["ctimeNs"]) is not int or overlay["ctimeNs"]<=0
 or overlay["stableDescriptor"] is not True
):
 raise SystemExit("runtime readiness overlay identity is invalid")
proof=value["stoppedGuestProof"]
if set(proof)!={
 "unit","systemdState","admissionLockHeld","activeLockHolder",
 "sharedReleaseSonarLockHolder","holderPid","holderStartTime",
 "handoffNonce","qemuExited","overlayProcessAbsent",
} or (
 proof["unit"]!=f"nexus-rollback-drill-vm@{guest}.service"
 or proof["systemdState"] not in {"active-handoff-wait","inactive-recovery"}
 or proof["admissionLockHeld"] is not True
 or proof["activeLockHolder"] not in {"runner-supervisor","root-collector"}
 or proof["sharedReleaseSonarLockHolder"]!=proof["activeLockHolder"]
 or type(proof["holderPid"]) is not int or proof["holderPid"]<=1
 or not isinstance(proof["holderStartTime"],str)
 or not proof["holderStartTime"].isdigit()
 or not hex64.fullmatch(proof["handoffNonce"])
 or proof["qemuExited"] is not True
 or proof["overlayProcessAbsent"] is not True
):
 raise SystemExit("runtime readiness stopped-guest proof is invalid")
if (
 (proof["systemdState"]=="active-handoff-wait"
  and proof["activeLockHolder"]!="runner-supervisor")
 or (proof["systemdState"]=="inactive-recovery"
  and proof["activeLockHolder"]!="root-collector")
):
 raise SystemExit("runtime readiness lock-holder state is invalid")
authorization=value["ownerAuthorization"]
if set(authorization)!={
 "authorizationId","drill","issuedAt","expiresAt","sha256","signatureSha256",
 "ownerPublicKeySha256",
} or any(
 not hex64.fullmatch(authorization[name])
 for name in ("authorizationId","sha256","signatureSha256","ownerPublicKeySha256")
):
 raise SystemExit("runtime readiness authorization identity is invalid")
measurement=value["guestMeasurement"]
if set(measurement)!={
 "sha256","signatureSha256","challenge","namespace",
} or any(
 not hex64.fullmatch(measurement[name])
 for name in ("sha256","signatureSha256","challenge")
) or measurement["namespace"]!="nexus-rollback-drill-vm-runtime-measurement":
 raise SystemExit("runtime readiness guest measurement identity is invalid")
if not all(isinstance(value[name],dict) for name in ("qemu","runtime","control","pm2DryHealth")):
 raise SystemExit("runtime readiness evidence is incomplete")
print(overlay["currentSha256"])
PY
  )" || die "runtime readiness receipt validation failed"
fi
printf '%s  %s\n' "$expected_overlay_sha256" "$overlay_path" \
  | sha256sum --check --status \
  || die "guest overlay differs from its accepted current readiness; provision a fresh set"
printf '%s  %s\n' "$seed_sha256" "$seed_path" | sha256sum --check --status \
  || die "guest seed digest drifted"

actual_qemu_version="$(
  "$QEMU_BIN" --version | python3 -c '
import re
import sys
lines = sys.stdin.read().splitlines()
if not lines or re.fullmatch(r"QEMU emulator version [ -~]{1,230}", lines[0]) is None:
    raise SystemExit("QEMU version output is invalid")
print(lines[0])
'
)" || die "cannot derive the installed QEMU version"
[ "$actual_qemu_version" = "$qemu_version" ] \
  || die "installed QEMU version drifted"
actual_qemu_package="$(
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
[ "$actual_qemu_package" = "$qemu_package" ] \
  || die "installed QEMU package owner drifted"
actual_qemu_package_record="$(
  "$DPKG_QUERY" --show \
    --showformat='${binary:Package}\t${Version}\t${Architecture}\n' \
    "$qemu_package"
)" || die "cannot query the installed QEMU package"
IFS=$'\t' read -r actual_qemu_package_name actual_qemu_package_version \
  actual_qemu_package_architecture actual_qemu_package_extra \
  <<<"$actual_qemu_package_record"
[ -z "${actual_qemu_package_extra:-}" ] \
  && [ "$actual_qemu_package_name" = "$qemu_package" ] \
  && [ "$actual_qemu_package_version" = "$qemu_package_version" ] \
  && [ "$actual_qemu_package_architecture" = "$qemu_package_architecture" ] \
  || die "installed QEMU package identity drifted"

qemu_info="$("$QEMU_IMG" info --output=json -- "$overlay_path")" \
  || die "cannot inspect guest overlay"
"$QEMU_IMG" check -q -- "$overlay_path" \
  || die "guest overlay structural check failed"
python3 - "$qemu_info" "$base_path" <<'PY' \
  || die "guest overlay is not bound to the immutable base"
import json
import sys
value = json.loads(sys.argv[1])
if value.get("format") != "qcow2":
    raise SystemExit(1)
if value.get("virtual-size") != 100 * 1024 * 1024 * 1024:
    raise SystemExit(1)
if value.get("full-backing-filename") != sys.argv[2]:
    raise SystemExit(1)
PY

python3 - "$port" <<'PY' || die "loopback SSH port is already occupied"
import socket
import sys
port = int(sys.argv[1])
with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
    sock.bind(("127.0.0.1", port))
PY

# Ignore an early handoff signal during the tiny launch window; the collector
# retries the nonce-bound request until this handler is replaced below.
trap ':' USR1
qemu_pid=""
normal_shutdown=false
normal_shutdown_status=0
handle_normal_shutdown() {
  normal_shutdown=true
  normal_shutdown_status=0
  if [ -n "$qemu_pid" ]; then
    kill -TERM "$qemu_pid" 2>/dev/null || true
  fi
}
handle_interrupt() {
  normal_shutdown=true
  normal_shutdown_status=130
  if [ -n "$qemu_pid" ]; then
    kill -TERM "$qemu_pid" 2>/dev/null || true
  fi
}
trap handle_normal_shutdown TERM
trap handle_interrupt INT
"$QEMU_BIN" \
  -name "$instance_id" \
  -enable-kvm \
  -machine q35,accel=kvm \
  -cpu host \
  -smp 4 \
  -m 14336 \
  -uuid "$vm_uuid" \
  -nodefaults \
  -no-user-config \
  -display none \
  -serial none \
  -parallel none \
  -monitor none \
  -device virtio-scsi-pci,id=scsi0 \
  -drive "file=$overlay_path,if=none,id=rootdisk,format=qcow2,cache=writeback" \
  -device scsi-hd,drive=rootdisk,bootindex=1 \
  -drive "file=$seed_path,if=none,id=seed,format=raw,readonly=on" \
  -device scsi-cd,drive=seed \
  -netdev "user,id=net0,restrict=on,hostfwd=tcp:127.0.0.1:${port}-:22" \
  -device "virtio-net-pci,netdev=net0,mac=$mac" \
  -object rng-random,id=rng0,filename=/dev/urandom \
  -device virtio-rng-pci,rng=rng0 &
qemu_pid=$!
handoff_request="$HANDOFF_DIR/$guest.request"
[[ -d "$HANDOFF_DIR" && ! -L "$HANDOFF_DIR" ]] \
  && [ "$(realpath -e -- "$HANDOFF_DIR")" = "$HANDOFF_DIR" ] \
  && [ "$(stat -c '%U:%G:%a' -- "$HANDOFF_DIR")" = root:nexus-drill-vm:750 ] \
  || die "runtime handoff directory is missing or unsafe"
[[ ! -e "$handoff_request" && ! -L "$handoff_request" ]] \
  || die "a stale runtime readiness handoff request blocks this guest"
supervisor_start_time="$(
  python3 - "$$" <<'PY'
import pathlib,sys
body=pathlib.Path(f"/proc/{sys.argv[1]}/stat").read_text(encoding="ascii")
print(body[body.rfind(") ")+2:].split()[19])
PY
)" || die "cannot derive the runner supervisor start time"
qemu_start_time="$(
  python3 - "$qemu_pid" <<'PY'
import pathlib,sys
body=pathlib.Path(f"/proc/{sys.argv[1]}/stat").read_text(encoding="ascii")
print(body[body.rfind(") ")+2:].split()[19])
PY
)" || die "cannot derive the QEMU child start time"
handoff_requested=false
qemu_status=0

validate_handoff_request() {
  [ -f "$handoff_request" ] && [ ! -L "$handoff_request" ] \
    && [ "$(realpath -e -- "$handoff_request")" = "$handoff_request" ] \
    && [ "$(stat -c '%U:%G:%a:%h' -- "$handoff_request")" = root:nexus-drill-vm:640:1 ] \
    && [ "$(stat -c '%s' -- "$handoff_request")" -le 65536 ] \
    || return 1
  python3 - "$handoff_request" "$set_id" "$guest" "$$" \
    "$supervisor_start_time" "$qemu_pid" "$qemu_start_time" <<'PY'
import json,re,sys
from pathlib import Path
path,set_id,guest,supervisor,supervisor_start,qemu,qemu_start=sys.argv[1:]
value=json.loads(Path(path).read_text(encoding="utf-8"))
if set(value)!={
 "schema","setId","guest","supervisorPid","supervisorStartTime",
 "qemuPid","qemuStartTime","nonce",
} or (
 value["schema"]!="nexus.rollback-drill-vm-runtime-handoff.v1"
 or value["setId"]!=set_id
 or value["guest"]!=guest
 or value["supervisorPid"]!=int(supervisor)
 or value["supervisorStartTime"]!=supervisor_start
 or value["qemuPid"]!=int(qemu)
 or value["qemuStartTime"]!=qemu_start
 or re.fullmatch(r"[0-9a-f]{64}",value["nonce"]) is None
):
 raise SystemExit("runtime readiness handoff identity is invalid")
PY
}

handle_runtime_handoff() {
  if ! validate_handoff_request; then
    echo "rollback drill VM runner: ignored invalid runtime readiness handoff request" >&2
    return
  fi
  handoff_requested=true
  kill -TERM "$qemu_pid" 2>/dev/null || true
}
trap handle_runtime_handoff USR1

while kill -0 "$qemu_pid" 2>/dev/null; do
  if wait "$qemu_pid"; then
    qemu_status=0
  else
    qemu_status=$?
  fi
  if [ "$handoff_requested" = true ] || [ "$normal_shutdown" = true ]; then
    break
  fi
done
if kill -0 "$qemu_pid" 2>/dev/null; then
  for ((attempt=0; attempt<150; attempt+=1)); do
    kill -0 "$qemu_pid" 2>/dev/null || break
    sleep 0.2
  done
fi
if kill -0 "$qemu_pid" 2>/dev/null; then
  kill -KILL "$qemu_pid" 2>/dev/null || true
fi
wait "$qemu_pid" 2>/dev/null || true

if [ "$handoff_requested" = true ]; then
  validate_handoff_request \
    || die "runtime readiness handoff request changed while stopping QEMU"
  while [ -e "$handoff_request" ] || [ -L "$handoff_request" ]; do
    sleep 0.2
  done
  exit 0
fi
if [ "$normal_shutdown" = true ]; then
  exit "$normal_shutdown_status"
fi
exit "$qemu_status"
