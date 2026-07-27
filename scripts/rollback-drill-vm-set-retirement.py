#!/usr/bin/env python3
"""Transactionally quarantine or restore one incomplete rollback-drill VM set.

The command is deliberately narrow:

* it accepts only an active ``ssh_only_bootstrap_required`` provision v2 set;
* it never unlinks guest, base-image, trust, or active-receipt bytes;
* quarantine removes authority first and restore publishes authority last;
* every rename is same-filesystem, journaled, fsynced, and recoverable; and
* recovery always completes the journaled direction. It never guesses.

The first invocation may run from the exact root-owned protected-main source
tree. After the old set is quarantined, the ordinary VM installer publishes
the same bytes at the fixed root-only installed path.
"""

from __future__ import annotations

import argparse
import contextlib
import datetime as dt
import fcntl
import grp
import hashlib
import json
import os
import pwd
import re
import socket
import stat
import subprocess
import sys
import tarfile
import uuid
from pathlib import Path
from typing import Any, Iterable


SCHEMA = "nexus.rollback-drill-vm-set-retirement-journal.v1"
QUARANTINE_RECEIPT_SCHEMA = (
    "nexus.rollback-drill-vm-set-quarantine-receipt.v1"
)
RESTORE_RECEIPT_SCHEMA = "nexus.rollback-drill-vm-set-restore-receipt.v1"
VERSION = "nexus-rollback-drill-vm-set-retirement.v1"
SOURCE_RELATIVE = "scripts/rollback-drill-vm-set-retirement.py"
INSTALLED_PATH = Path(
    "/usr/local/libexec/nexus-rollback-drill-vm/retire-set"
)
DEFAULT_STATE_ROOT = Path("/var/lib/nexus-rollback-drill-vm")
DEFAULT_RUNTIME_ROOT = Path("/run/nexus-rollback-drill-vm")
DEFAULT_SHARED_MUTEX = Path("/run/lock/nexus-release-sonar.lock")
DEFAULT_SYSTEMCTL = Path("/usr/bin/systemctl")
DEFAULT_PROC_ROOT = Path("/proc")
DEFAULT_BOOTSTRAP_BASE = Path("/var/lib/nexus-release-bootstrap")
DIGEST = re.compile(r"^[0-9a-f]{64}$")
SOURCE_SHA = re.compile(r"^[0-9a-f]{40}$")
SET_ID = DIGEST
UUID = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-"
    r"[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
)
TERMINAL_CONTROLLER_STATUSES = {
    "completed",
    "failed_recovered",
    "expired_recovered",
}
GUESTS = ("guest-1", "guest-2", "guest-3")
FAULT_UNIT_PREFIX = "nexus-release-layout-fault-drill@"
RUNTIME_ASSETS = (
    ("runnerPath", "runnerSha256"),
    ("unitPath", "unitSha256"),
    ("hostPreflightPath", "hostPreflightSha256"),
    ("runtimeManifestPath", "runtimeManifestSha256"),
    ("runtimeControlSourcePath", "runtimeControlSha256"),
    ("runtimeReadinessPath", "runtimeReadinessSha256"),
    ("runtimeRecoveryUnitSourcePath", "runtimeRecoveryUnitSha256"),
    ("faultDrillControllerPath", "faultDrillControllerSha256"),
    ("faultDrillControllerUnitPath", "faultDrillControllerUnitSha256"),
    (
        "faultDrillControllerRecoveryUnitPath",
        "faultDrillControllerRecoveryUnitSha256",
    ),
    ("faultDrillGuestExecutorSourcePath", "faultDrillGuestExecutorSha256"),
    (
        "faultDrillGuestRecoveryUnitSourcePath",
        "faultDrillGuestRecoveryUnitSha256",
    ),
    ("faultDrillVerifierPath", "faultDrillVerifierSha256"),
)
BOOT_GUARD_TARGETS = (
    Path(
        "/etc/systemd/system/nexus-rollback-drill-vm@.service.d/"
        "00-nexus-set-retirement-guard.conf"
    ),
    Path(
        "/etc/systemd/system/nexus-release-layout-fault-drill@.service.d/"
        "00-nexus-set-retirement-guard.conf"
    ),
    Path(
        "/etc/systemd/system/"
        "nexus-release-layout-fault-drill-recovery.service.d/"
        "00-nexus-set-retirement-guard.conf"
    ),
)
BOOT_GUARD_BODY = (
    b"[Unit]\n"
    b"ConditionPathExists=!"
    b"/var/lib/nexus-rollback-drill-vm/"
    b"set-retirement-in-progress.v1.json\n"
)
EXPECTED_LAYOUT = (
    (
        "scripts/rollback-drill-vm-provision.sh",
        "/usr/local/libexec/nexus-rollback-drill-vm/provision",
        "root:root",
        "0755",
    ),
    (
        "scripts/rollback-drill-vm-run.sh",
        "/usr/local/libexec/nexus-rollback-drill-vm/run",
        "root:root",
        "0755",
    ),
    (
        "scripts/rollback-drill-vm-host-preflight.sh",
        "/usr/local/libexec/nexus-rollback-drill-vm/host-preflight",
        "root:root",
        "0755",
    ),
    (
        "scripts/rollback-drill-vm-manifest.py",
        "/usr/local/libexec/nexus-rollback-drill-vm/manifest.py",
        "root:root",
        "0644",
    ),
    (
        "scripts/rollback-drill-vm-runtime-manifest.py",
        "/usr/local/libexec/nexus-rollback-drill-vm/runtime-manifest",
        "root:root",
        "0755",
    ),
    (
        "scripts/rollback-drill-vm-runtime-control.sh",
        "/usr/local/libexec/nexus-rollback-drill-vm/runtime-control-guest",
        "root:root",
        "0755",
    ),
    (
        "scripts/rollback-drill-vm-runtime-readiness-seal.sh",
        "/usr/local/libexec/nexus-rollback-drill-vm/runtime-readiness",
        "root:root",
        "0755",
    ),
    (
        "scripts/rollback-drill-vm-set-retirement.py",
        "/usr/local/libexec/nexus-rollback-drill-vm/retire-set",
        "root:root",
        "0700",
    ),
    (
        "scripts/release-layout-fault-drill-controller.mjs",
        (
            "/usr/local/libexec/nexus-rollback-drill-vm/"
            "release-layout-fault-controller"
        ),
        "root:root",
        "0755",
    ),
    (
        "scripts/release-layout-fault-drill-guest.mjs",
        "/usr/local/libexec/nexus-rollback-drill-vm/release-layout-fault-guest",
        "root:root",
        "0755",
    ),
    (
        "scripts/release-layout-fault-drill.mjs",
        (
            "/usr/local/libexec/nexus-rollback-drill-vm/"
            "release-layout-fault-drill.mjs"
        ),
        "root:root",
        "0755",
    ),
    (
        (
            "ops/rollback-drill-vm/systemd/"
            "nexus-rollback-drill-vm-runtime-recovery.service"
        ),
        "/usr/local/libexec/nexus-rollback-drill-vm/runtime-recovery.service",
        "root:root",
        "0644",
    ),
    (
        (
            "ops/rollback-drill-vm/systemd/"
            "nexus-release-layout-fault-drill-guest-recovery.service"
        ),
        (
            "/usr/local/libexec/nexus-rollback-drill-vm/"
            "release-layout-fault-guest-recovery.service"
        ),
        "root:root",
        "0644",
    ),
    (
        (
            "ops/rollback-drill-vm/systemd/"
            "nexus-rollback-drill-vm@.service"
        ),
        "/etc/systemd/system/nexus-rollback-drill-vm@.service",
        "root:root",
        "0644",
    ),
    (
        (
            "ops/rollback-drill-vm/systemd/"
            "nexus-release-layout-fault-drill@.service"
        ),
        "/etc/systemd/system/nexus-release-layout-fault-drill@.service",
        "root:root",
        "0644",
    ),
    (
        (
            "ops/rollback-drill-vm/systemd/"
            "nexus-release-layout-fault-drill-recovery.service"
        ),
        (
            "/etc/systemd/system/"
            "nexus-release-layout-fault-drill-recovery.service"
        ),
        "root:root",
        "0644",
    ),
    (
        "ops/rollback-drill-vm/nexus-rollback-drill-vm.tmpfiles",
        "/etc/tmpfiles.d/nexus-rollback-drill-vm.conf",
        "root:root",
        "0644",
    ),
)


class Refusal(RuntimeError):
    """A fail-closed admission or recovery refusal."""


def fail(message: str) -> None:
    raise Refusal(message)


def canonical_json(value: Any) -> bytes:
    return (
        json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
        + "\n"
    ).encode("utf-8")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def stable_identity(identity: os.stat_result) -> tuple[int, ...]:
    return (
        identity.st_dev,
        identity.st_ino,
        identity.st_mode,
        identity.st_nlink,
        identity.st_uid,
        identity.st_gid,
        identity.st_size,
        identity.st_mtime_ns,
        identity.st_ctime_ns,
    )


@contextlib.contextmanager
def verified_file_descriptor(path: Path, label: str) -> Iterable[int]:
    descriptor = os.open(
        path,
        os.O_RDONLY
        | getattr(os, "O_CLOEXEC", 0)
        | getattr(os, "O_NOFOLLOW", 0),
    )
    try:
        before = os.fstat(descriptor)
        path_before = path.lstat()
        if (
            not stat.S_ISREG(before.st_mode)
            or before.st_nlink != 1
            or (before.st_dev, before.st_ino)
            != (path_before.st_dev, path_before.st_ino)
        ):
            fail(f"{label} descriptor/path identity is unsafe")
        yield descriptor
        after = os.fstat(descriptor)
        path_after = path.lstat()
        if (
            stable_identity(before) != stable_identity(after)
            or (after.st_dev, after.st_ino)
            != (path_after.st_dev, path_after.st_ino)
            or stable_identity(path_before) != stable_identity(path_after)
        ):
            fail(f"{label} changed while it was read")
    finally:
        os.close(descriptor)


@contextlib.contextmanager
def verified_directory_descriptor(
    path: Path, label: str, *, allow_metadata_change: bool = False
) -> Iterable[int]:
    descriptor = os.open(
        path,
        os.O_RDONLY
        | getattr(os, "O_CLOEXEC", 0)
        | getattr(os, "O_NOFOLLOW", 0)
        | getattr(os, "O_DIRECTORY", 0),
    )
    try:
        before = os.fstat(descriptor)
        path_before = path.lstat()
        if (
            not stat.S_ISDIR(before.st_mode)
            or stat.S_ISLNK(before.st_mode)
            or (before.st_dev, before.st_ino)
            != (path_before.st_dev, path_before.st_ino)
        ):
            fail(f"{label} descriptor/path identity is unsafe")
        yield descriptor
        after = os.fstat(descriptor)
        path_after = path.lstat()
        stable = (
            before.st_dev,
            before.st_ino,
            stat.S_IMODE(before.st_mode),
            before.st_uid,
            before.st_gid,
        ) == (
            after.st_dev,
            after.st_ino,
            stat.S_IMODE(after.st_mode),
            after.st_uid,
            after.st_gid,
        )
        if (
            (not allow_metadata_change and stable_identity(before) != stable_identity(after))
            or (allow_metadata_change and not stable)
            or (after.st_dev, after.st_ino)
            != (path_after.st_dev, path_after.st_ino)
        ):
            fail(f"{label} changed while it was in use")
    finally:
        os.close(descriptor)


def read_file_bytes(
    path: Path, label: str, minimum: int = 1, maximum: int = 1024 * 1024
) -> bytes:
    with verified_file_descriptor(path, label) as descriptor:
        identity = os.fstat(descriptor)
        if identity.st_size < minimum or identity.st_size > maximum:
            fail(f"{label} size is outside the accepted bound")
        chunks: list[bytes] = []
        total = 0
        while True:
            chunk = os.read(descriptor, min(1024 * 1024, maximum + 1))
            if not chunk:
                return b"".join(chunks)
            chunks.append(chunk)
            total += len(chunk)
            if total > maximum:
                fail(f"{label} exceeded the accepted bound while reading")


def sha256_file(path: Path, label: str = "file") -> str:
    digest = hashlib.sha256()
    with verified_file_descriptor(path, label) as descriptor:
        while True:
            chunk = os.read(descriptor, 1024 * 1024)
            if not chunk:
                return digest.hexdigest()
            digest.update(chunk)


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds").replace(
        "+00:00", "Z"
    )


def fsync_path(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_CLOEXEC", 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def durable_write(path: Path, body: bytes, mode: int = 0o600) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    temporary = path.parent / f".{path.name}.{uuid.uuid4()}"
    descriptor = os.open(
        temporary,
        os.O_WRONLY
        | os.O_CREAT
        | os.O_EXCL
        | getattr(os, "O_CLOEXEC", 0)
        | getattr(os, "O_NOFOLLOW", 0),
        mode,
    )
    try:
        view = memoryview(body)
        written = 0
        while written < len(view):
            count = os.write(descriptor, view[written:])
            if count <= 0:
                fail(f"short write while publishing {path}")
            written += count
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    os.chmod(temporary, mode, follow_symlinks=False)
    os.replace(temporary, path)
    fsync_path(path.parent)


def read_json(path: Path, label: str, maximum: int = 1024 * 1024) -> tuple[bytes, Any]:
    body = read_file_bytes(path, label, 2, maximum)
    try:
        return body, json.loads(body)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        fail(f"{label} is not valid JSON: {error}")


def exact_keys(value: Any, expected: Iterable[str], label: str) -> None:
    if not isinstance(value, dict) or set(value) != set(expected):
        fail(f"{label} fields are invalid")


def state_root() -> Path:
    override = os.environ.get("NEXUS_KVM_SET_RETIREMENT_TEST_STATE_ROOT")
    return Path(override) if override else DEFAULT_STATE_ROOT


def runtime_root() -> Path:
    override = os.environ.get("NEXUS_KVM_SET_RETIREMENT_TEST_RUNTIME_ROOT")
    return Path(override) if override else DEFAULT_RUNTIME_ROOT


def shared_mutex() -> Path:
    override = os.environ.get("NEXUS_KVM_SET_RETIREMENT_TEST_SHARED_MUTEX")
    return Path(override) if override else DEFAULT_SHARED_MUTEX


def systemctl_path() -> Path:
    override = os.environ.get("NEXUS_KVM_SET_RETIREMENT_TEST_SYSTEMCTL")
    return Path(override) if override else DEFAULT_SYSTEMCTL


def proc_root() -> Path:
    override = os.environ.get("NEXUS_KVM_SET_RETIREMENT_TEST_PROC_ROOT")
    return Path(override) if override else DEFAULT_PROC_ROOT


def openssl_path() -> Path:
    override = os.environ.get("NEXUS_KVM_SET_RETIREMENT_TEST_OPENSSL")
    return Path(override) if override else Path("/usr/bin/openssl")


def bootstrap_base() -> Path:
    override = os.environ.get("NEXUS_KVM_SET_RETIREMENT_TEST_BOOTSTRAP_BASE")
    return Path(override) if override else DEFAULT_BOOTSTRAP_BASE


def test_mode() -> bool:
    return os.environ.get("NEXUS_KVM_SET_RETIREMENT_TEST_MODE") == "1"


def drill_group_gid() -> int:
    if test_mode():
        return os.getegid()
    try:
        return grp.getgrnam("nexus-drill-vm").gr_gid
    except KeyError:
        fail("dedicated nexus-drill-vm group is missing")


def drill_user_uid() -> int:
    if test_mode():
        return os.geteuid()
    try:
        return pwd.getpwnam("nexus-drill-vm").pw_uid
    except KeyError:
        fail("dedicated nexus-drill-vm account is missing")


def worker_group_gid() -> int:
    if test_mode():
        return os.getegid()
    try:
        return grp.getgrnam("dominguez").gr_gid
    except KeyError:
        fail("promotion worker group is missing")


def assert_execution_boundary() -> None:
    overrides = [
        name
        for name in os.environ
        if name.startswith("NEXUS_KVM_SET_RETIREMENT_TEST_")
        and name != "NEXUS_KVM_SET_RETIREMENT_TEST_MODE"
    ]
    if test_mode():
        if os.geteuid() == 0:
            fail("test mode may not cross a privileged uid boundary")
    else:
        if overrides:
            fail("test-only path overrides are forbidden")
        if os.geteuid() != 0:
            fail("must run as root")


def assert_absolute_canonical(path: Path, label: str, must_exist: bool = True) -> None:
    if not path.is_absolute() or path == Path("/"):
        fail(f"{label} must be one absolute path")
    if must_exist:
        try:
            resolved = path.resolve(strict=True)
        except OSError as error:
            fail(f"{label} is unavailable: {error}")
        if resolved != path:
            fail(f"{label} must not traverse symlinks")
    elif path.resolve(strict=False) != path:
        fail(f"{label} must be canonical")


def assert_trusted_chain(path: Path, label: str, kind: str) -> None:
    assert_absolute_canonical(path, label)
    identity = path.lstat()
    if kind == "file" and not stat.S_ISREG(identity.st_mode):
        fail(f"{label} must be a regular file")
    if kind == "directory" and not stat.S_ISDIR(identity.st_mode):
        fail(f"{label} must be a directory")
    if stat.S_ISLNK(identity.st_mode):
        fail(f"{label} may not be a symlink")
    expected_uid = os.geteuid()
    current = path
    stop = None
    if test_mode():
        stop = state_root().parent
        if path != state_root() and state_root() not in path.parents:
            stop = path.parent
    while True:
        current_identity = current.lstat()
        if current_identity.st_uid != expected_uid:
            fail(f"{label} path component is not trusted-owner-owned: {current}")
        if stat.S_IMODE(current_identity.st_mode) & 0o022:
            fail(f"{label} path component is group/world writable: {current}")
        if current == Path("/") or (stop is not None and current == stop):
            break
        current = current.parent


def validate_source(
    source: Path, source_sha: str, archive: Path, archive_sha256: str
) -> dict[str, Any]:
    if not SOURCE_SHA.fullmatch(source_sha):
        fail("source SHA must be exactly 40 lowercase hexadecimal characters")
    if not DIGEST.fullmatch(archive_sha256):
        fail("source archive SHA-256 is invalid")
    expected_bootstrap = bootstrap_base() / source_sha
    if source != expected_bootstrap / "source":
        fail("source root must be the exact SHA-bound bootstrap source path")
    if archive != expected_bootstrap / "source.tar.gz":
        fail("source archive must be the exact SHA-bound bootstrap archive path")
    assert_trusted_chain(source, "source root", "directory")
    assert_trusted_chain(archive, "source archive", "file")
    if sha256_file(archive, "source archive") != archive_sha256:
        fail("source archive digest differs from the owner-approved digest")
    source_script = source / SOURCE_RELATIVE
    assert_trusted_chain(source_script, "source retirement control", "file")
    layout_relative = "ops/rollback-drill-vm/install-layout.tsv"
    layout_path = source / layout_relative
    assert_trusted_chain(layout_path, "rollback-drill install layout", "file")
    expected_layout_body = (
        "# source\tabsolute target\towner\tmode\n"
        + "".join("\t".join(row) + "\n" for row in EXPECTED_LAYOUT)
    ).encode("utf-8")
    if (
        read_file_bytes(
            layout_path, "rollback-drill install layout", 2, 256 * 1024
        )
        != expected_layout_body
    ):
        fail("rollback-drill install layout differs from the exact allowlist")
    invoked = Path(__file__)
    if not invoked.is_absolute() or invoked.is_symlink():
        fail("retirement control must execute through one absolute non-symlink path")
    running = invoked.resolve(strict=True)
    if running != invoked:
        fail("retirement control execution path is noncanonical")
    allowed_running = {source_script, INSTALLED_PATH}
    if test_mode():
        allowed_running.add(running)
    if running not in allowed_running:
        fail("retirement control is not the exact source or installed path")
    source_body = read_file_bytes(
        source_script, "source retirement control", 1, 4 * 1024 * 1024
    )
    if (
        read_file_bytes(
            running, "running retirement control", 1, 4 * 1024 * 1024
        )
        != source_body
    ):
        fail("running retirement control differs from exact source")
    required = {
        layout_relative,
        "scripts/rollback-drill-vm-systemd-install.sh",
        *(row[0] for row in EXPECTED_LAYOUT),
    }
    source_bodies: dict[str, bytes] = {}
    asset_digests: dict[str, str] = {}
    for relative in sorted(required):
        candidate = source / relative
        assert_trusted_chain(candidate, f"source asset {relative}", "file")
        body = read_file_bytes(
            candidate, f"source asset {relative}", 1, 16 * 1024 * 1024
        )
        source_bodies[relative] = body
        asset_digests[relative] = sha256_bytes(body)
    try:
        with verified_file_descriptor(archive, "source archive") as archive_fd:
            with os.fdopen(os.dup(archive_fd), "rb") as archive_file:
                with tarfile.open(fileobj=archive_file, mode="r:*") as bundle:
                    if bundle.pax_headers.get("comment") != source_sha:
                        fail("source archive Git PAX commit differs from source SHA")
                    expected_names = {
                        f"source/{relative}": relative for relative in required
                    }
                    matched: dict[str, tarfile.TarInfo] = {}
                    for member in bundle.getmembers():
                        relative = expected_names.get(member.name)
                        if relative is None:
                            continue
                        if relative in matched or not member.isreg():
                            fail(f"source archive asset is ambiguous: {relative}")
                        matched[relative] = member
                    if set(matched) != required:
                        fail("source archive omits a required rollback-drill asset")
                    for relative in sorted(required):
                        member = matched[relative]
                        if member.size != len(source_bodies[relative]):
                            fail(f"source archive asset size differs: {relative}")
                        extracted = bundle.extractfile(member)
                        if (
                            extracted is None
                            or extracted.read(16 * 1024 * 1024 + 1)
                            != source_bodies[relative]
                        ):
                            fail(f"source asset differs from archive: {relative}")
    except (tarfile.TarError, OSError) as error:
        fail(f"source archive cannot be verified: {error}")
    return {
        "sourceRoot": str(source),
        "sourceSha": source_sha,
        "sourceArchive": str(archive),
        "sourceArchiveSha256": archive_sha256,
        "controlSha256": sha256_bytes(source_body),
        "desiredRuntimeManifestSha256": asset_digests[
            "scripts/rollback-drill-vm-runtime-manifest.py"
        ],
        "desiredRuntimeControlSha256": asset_digests[
            "scripts/rollback-drill-vm-runtime-control.sh"
        ],
        "installLayoutSha256": asset_digests[layout_relative],
        "installerSha256": asset_digests[
            "scripts/rollback-drill-vm-systemd-install.sh"
        ],
        "installAssetSha256s": {
            relative: asset_digests[relative]
            for relative, _target, _owner, _mode in EXPECTED_LAYOUT
        },
    }


def assert_path_identity(path: Path, label: str, kind: str, mode: int | None = None) -> os.stat_result:
    assert_absolute_canonical(path, label)
    identity = path.lstat()
    if stat.S_ISLNK(identity.st_mode):
        fail(f"{label} may not be a symlink")
    if kind == "file" and not stat.S_ISREG(identity.st_mode):
        fail(f"{label} must be a regular file")
    if kind == "directory" and not stat.S_ISDIR(identity.st_mode):
        fail(f"{label} must be a directory")
    if identity.st_nlink != 1 and kind == "file":
        fail(f"{label} must have exactly one link")
    if identity.st_uid != os.geteuid():
        fail(f"{label} is not root-owned")
    if mode is not None and stat.S_IMODE(identity.st_mode) != mode:
        fail(f"{label} mode is unsafe")
    return identity


def tree_identity(path: Path, label: str) -> dict[str, Any]:
    root_identity = assert_path_identity(path, label, "directory")
    records: list[dict[str, Any]] = []
    directory_identities: dict[str, tuple[int, ...]] = {
        ".": stable_identity(root_identity)
    }
    for current_root, directories, files, directory_fd in os.fwalk(
        path, topdown=True, follow_symlinks=False
    ):
        directories.sort()
        files.sort()
        current = Path(current_root)
        current_relative = current.relative_to(path).as_posix() or "."
        opened_directory = os.fstat(directory_fd)
        expected_directory = directory_identities.get(current_relative)
        if (
            expected_directory is None
            or stable_identity(opened_directory) != expected_directory
        ):
            fail(f"{label} directory changed during traversal: {current_relative}")
        for name in [*directories, *files]:
            candidate = current / name
            identity = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
            relative = candidate.relative_to(path).as_posix()
            if stat.S_ISLNK(identity.st_mode):
                fail(f"{label} contains a symlink: {relative}")
            common = {
                "path": relative,
                "uid": identity.st_uid,
                "gid": identity.st_gid,
                "mode": stat.S_IMODE(identity.st_mode),
                "nlink": identity.st_nlink,
                "size": identity.st_size,
                "mtimeNs": identity.st_mtime_ns,
                "ctimeNs": identity.st_ctime_ns,
                "device": identity.st_dev,
                "inode": identity.st_ino,
            }
            if stat.S_ISDIR(identity.st_mode):
                directory_identities[relative] = stable_identity(identity)
                records.append({**common, "type": "directory"})
            elif stat.S_ISREG(identity.st_mode):
                if identity.st_nlink != 1:
                    fail(f"{label} contains a multiply-linked file: {relative}")
                descriptor = os.open(
                    name,
                    os.O_RDONLY
                    | getattr(os, "O_CLOEXEC", 0)
                    | getattr(os, "O_NOFOLLOW", 0),
                    dir_fd=directory_fd,
                )
                try:
                    opened = os.fstat(descriptor)
                    if stable_identity(opened) != stable_identity(identity):
                        fail(f"{label} member changed before open: {relative}")
                    digest = hashlib.sha256()
                    while True:
                        chunk = os.read(descriptor, 1024 * 1024)
                        if not chunk:
                            break
                        digest.update(chunk)
                    after = os.fstat(descriptor)
                    path_after = os.stat(
                        name, dir_fd=directory_fd, follow_symlinks=False
                    )
                    if (
                        stable_identity(opened) != stable_identity(after)
                        or stable_identity(after) != stable_identity(path_after)
                    ):
                        fail(f"{label} member changed while hashing: {relative}")
                finally:
                    os.close(descriptor)
                records.append(
                    {
                        **common,
                        "type": "file",
                        "sha256": digest.hexdigest(),
                    }
                )
            else:
                fail(f"{label} contains an unsupported filesystem object: {relative}")
    root_after = path.lstat()
    if stable_identity(root_identity) != stable_identity(root_after):
        fail(f"{label} root changed while it was traversed")
    digest_records = [
        {key: value for key, value in record.items() if key not in {"device", "inode"}}
        for record in records
    ]
    return {
        "kind": "directory",
        "device": root_identity.st_dev,
        "inode": root_identity.st_ino,
        "uid": root_identity.st_uid,
        "gid": root_identity.st_gid,
        "mode": stat.S_IMODE(root_identity.st_mode),
        "nlink": root_identity.st_nlink,
        "size": root_identity.st_size,
        "mtimeNs": root_identity.st_mtime_ns,
        "ctimeNs": root_identity.st_ctime_ns,
        "entryCount": len(records),
        "treeSha256": sha256_bytes(canonical_json(digest_records)),
        "entries": records,
    }


def file_identity(path: Path, label: str) -> dict[str, Any]:
    identity = assert_path_identity(path, label, "file")
    return {
        "kind": "file",
        "device": identity.st_dev,
        "inode": identity.st_ino,
        "uid": identity.st_uid,
        "gid": identity.st_gid,
        "mode": stat.S_IMODE(identity.st_mode),
        "nlink": identity.st_nlink,
        "size": identity.st_size,
        "mtimeNs": identity.st_mtime_ns,
        "ctimeNs": identity.st_ctime_ns,
        "sha256": sha256_file(path, label),
    }


def comparable_identity(
    identity: dict[str, Any], *, ignore_ctime: bool = False
) -> dict[str, Any]:
    excluded = {"entries"}
    if ignore_ctime:
        excluded.add("ctimeNs")
    value = {key: item for key, item in identity.items() if key not in excluded}
    if "entries" in identity:
        value["entries"] = [
            {
                key: item
                for key, item in entry.items()
                if not (ignore_ctime and key == "ctimeNs")
            }
            for entry in identity["entries"]
        ]
    return value


def current_identity(path: Path, recorded: dict[str, Any], label: str) -> dict[str, Any]:
    return (
        tree_identity(path, label)
        if recorded.get("kind") == "directory"
        else file_identity(path, label)
    )


def validate_recorded_identity(
    path: Path,
    recorded: dict[str, Any],
    label: str,
    *,
    ignore_ctime: bool = False,
) -> dict[str, Any]:
    current = (
        tree_identity(path, label)
        if recorded.get("kind") == "directory"
        else file_identity(path, label)
    )
    if comparable_identity(current, ignore_ctime=ignore_ctime) != comparable_identity(
        recorded, ignore_ctime=ignore_ctime
    ):
        fail(f"{label} inode/tree binding differs from the journal")
    return current


def validate_active_state(
    expected_set_id: str,
    expected_active_sha256: str,
    expected_runtime_manifest_sha256: str,
    expected_runtime_control_sha256: str | None,
    expected_current_overlay_sha256s: dict[str, str],
) -> tuple[dict[str, Any], dict[str, Any]]:
    root = state_root()
    active_path = root / "active.json"
    trust_path = root / "release-layout-evidence-trust.v1.json"
    active_identity = assert_path_identity(
        active_path, "active provision receipt", "file", 0o640
    )
    trust_identity = assert_path_identity(
        trust_path, "release-layout trust manifest", "file", 0o600
    )
    if active_identity.st_gid != drill_group_gid() or trust_identity.st_gid != 0:
        if not test_mode():
            fail("active/trust ownership is outside the fixed root trust boundary")
    active_body, active = read_json(active_path, "active provision receipt")
    trust_body, trust = read_json(trust_path, "release-layout trust manifest")
    if sha256_bytes(active_body) != expected_active_sha256:
        fail("active provision receipt differs from the explicit expected digest")
    if active.get("schema") != "nexus.rollback-drill-vm-provision.v2":
        fail("active provision receipt schema is invalid")
    if active.get("setId") != expected_set_id:
        fail("active provision set differs from the explicit expected set")
    readiness = active.get("runtimeReadiness")
    if readiness != {
        "status": "ssh_only_bootstrap_required",
        "drillReady": False,
        "requirements": [
            "node-22.23.1",
            "python-3.12.x",
            "pm2-6.0.14-root-closure-at-/opt/nexus-release/pm2/6.0.14-via-/usr/local/bin/pm2",
            "digest-bound-offline-toolchain-evidence",
        ],
    }:
        fail("only the exact incomplete ssh-only provision set may be quarantined")
    hypervisor = active.get("hypervisor")
    if not isinstance(hypervisor, dict):
        fail("active provision hypervisor identity is missing")
    if hypervisor.get("runtimeManifestSha256") != expected_runtime_manifest_sha256:
        fail("active runtime manifest differs from the explicit expected digest")
    if (
        expected_runtime_control_sha256 is not None
        and hypervisor.get("runtimeControlSha256")
        != expected_runtime_control_sha256
    ):
        fail("active runtime control differs from the explicit expected digest")
    set_directory = root / "sets" / expected_set_id
    base_sha = active.get("image", {}).get("sha256")
    base_path = root / "base" / f"{base_sha}.qcow2"
    if (
        not DIGEST.fullmatch(base_sha or "")
        or active.get("image", {}).get("basePath") != str(base_path)
        or active.get("setDirectory") != str(set_directory)
    ):
        fail("active base/set paths are outside the exact state boundary")
    set_identity = assert_path_identity(
        set_directory, "active guest set", "directory", 0o750
    )
    base_identity = assert_path_identity(
        base_path, "active base image", "file", 0o440
    )
    if (
        set_identity.st_gid != drill_group_gid()
        or base_identity.st_gid != drill_group_gid()
    ) and not test_mode():
        fail("base/set ownership is outside the dedicated drill group")
    guests = active.get("guests")
    if not isinstance(guests, list) or [entry.get("name") for entry in guests] != list(
        GUESTS
    ):
        fail("active provision guest set is invalid")
    for guest in guests:
        guest_root = set_directory / guest["name"]
        if guest.get("overlayPath") != str(guest_root / "root.qcow2"):
            fail("active guest overlay path is invalid")
        if guest.get("seedPath") != str(guest_root / "seed.img"):
            fail("active guest seed path is invalid")
        if guest.get("unit") != f"nexus-rollback-drill-vm@{guest['name']}.service":
            fail("active guest unit identity is invalid")
    set_receipt_body = read_file_bytes(
        set_directory / "receipt.json", "guest-set provision receipt", 2, 1024 * 1024
    )
    set_receipt_identity = assert_path_identity(
        set_directory / "receipt.json", "guest-set provision receipt", "file", 0o640
    )
    if set_receipt_identity.st_gid != drill_group_gid() and not test_mode():
        fail("guest-set receipt is outside the dedicated drill group")
    if set_receipt_body != active_body:
        fail("set receipt differs byte-for-byte from active authority")
    set_trust_body = read_file_bytes(
        set_directory / "release-layout-evidence-trust.v1.json",
        "guest-set release-layout trust copy",
        2,
        1024 * 1024,
    )
    if set_trust_body != trust_body:
        fail("guest-set trust copy differs byte-for-byte from canonical trust")
    if trust.get("schema") != "nexus.release-layout-kvm-trust.v1":
        fail("release-layout trust schema is invalid")
    provision = trust.get("provision")
    if provision != {
        "schema": active["schema"],
        "setId": expected_set_id,
        "receiptSha256": expected_active_sha256,
    }:
        fail("release-layout trust does not bind the active receipt")
    trust_hypervisor = trust.get("hypervisor")
    exact_keys(
        trust_hypervisor,
        (
            "publicKeyPem",
            "publicKeySha256",
            "qemuSha256",
            "runnerSha256",
            "controllerPath",
            "controllerSha256",
            "controllerRecoveryUnitPath",
            "controllerRecoveryUnitSha256",
            "controllerUnitPath",
            "controllerUnitSha256",
            "verifierPath",
            "verifierSha256",
        ),
        "release-layout hypervisor trust",
    )
    hypervisor_public_body = read_file_bytes(
        set_directory / "release-layout-hypervisor-evidence-public.pem",
        "release-layout hypervisor public key",
        16,
        64 * 1024,
    )
    derived_public = subprocess.run(
        [
            str(openssl_path()),
            "pkey",
            "-in",
            str(set_directory / "release-layout-hypervisor-evidence-private.pem"),
            "-pubout",
        ],
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=10,
    )
    if (
        derived_public.returncode != 0
        or derived_public.stdout != hypervisor_public_body
        or trust_hypervisor["publicKeyPem"].encode("ascii")
        != hypervisor_public_body
        or trust_hypervisor["publicKeySha256"]
        != sha256_bytes(hypervisor_public_body)
        or trust_hypervisor["qemuSha256"] != hypervisor.get("qemuSha256")
        or trust_hypervisor["runnerSha256"] != hypervisor.get("runnerSha256")
        or trust_hypervisor["controllerPath"]
        != hypervisor.get("faultDrillControllerPath")
        or trust_hypervisor["controllerSha256"]
        != hypervisor.get("faultDrillControllerSha256")
        or trust_hypervisor["controllerRecoveryUnitPath"]
        != hypervisor.get("faultDrillControllerRecoveryUnitPath")
        or trust_hypervisor["controllerRecoveryUnitSha256"]
        != hypervisor.get("faultDrillControllerRecoveryUnitSha256")
        or trust_hypervisor["controllerUnitPath"]
        != hypervisor.get("faultDrillControllerUnitPath")
        or trust_hypervisor["controllerUnitSha256"]
        != hypervisor.get("faultDrillControllerUnitSha256")
        or trust_hypervisor["verifierPath"]
        != hypervisor.get("faultDrillVerifierPath")
        or trust_hypervisor["verifierSha256"]
        != hypervisor.get("faultDrillVerifierSha256")
    ):
        fail("release-layout hypervisor trust differs from active receipt/set")
    trust_guests = trust.get("guests")
    scenario_guests = {
        "failed_health_check": "guest-2",
        "host_reboot_during_migration": "guest-3",
        "ssh_disconnect_after_pm2_stop": "guest-1",
    }
    if not isinstance(trust_guests, dict) or set(trust_guests) != set(
        scenario_guests
    ):
        fail("release-layout guest trust mapping is invalid")
    active_guests = {guest["name"]: guest for guest in guests}
    for scenario, guest_name in scenario_guests.items():
        producer = trust_guests[scenario]
        exact_keys(
            producer,
            (
                "guestId",
                "publicKeyPem",
                "publicKeySha256",
                "sshHostPublicKeySha256",
                "executorPath",
                "executorSha256",
                "recoveryUnitPath",
                "recoveryUnitSha256",
            ),
            f"release-layout {scenario} trust",
        )
        public_body = read_file_bytes(
            set_directory
            / f"release-layout-{guest_name}-evidence-public.pem",
            f"{guest_name} release-layout public key",
            16,
            64 * 1024,
        )
        if (
            producer["guestId"] != guest_name
            or producer["publicKeyPem"].encode("ascii") != public_body
            or producer["publicKeySha256"] != sha256_bytes(public_body)
            or producer["sshHostPublicKeySha256"]
            != active_guests[guest_name].get("hostPublicKeySha256")
            or producer["executorPath"] != "/usr/local/sbin/nexus-release-layout-fault-guest"
            or producer["executorSha256"]
            != hypervisor.get("faultDrillGuestExecutorSha256")
            or producer["recoveryUnitPath"]
            != (
                "/etc/systemd/system/"
                "nexus-release-layout-fault-guest-recovery.service"
            )
            or producer["recoveryUnitSha256"]
            != hypervisor.get("faultDrillGuestRecoveryUnitSha256")
        ):
            fail(f"release-layout {scenario} trust differs from active receipt/set")
    if len(trust_body) < 2:
        fail("release-layout trust body is empty")
    base_entries = sorted(entry.name for entry in (root / "base").iterdir())
    set_entries = sorted(entry.name for entry in (root / "sets").iterdir())
    if base_entries != [base_path.name] or set_entries != [expected_set_id]:
        fail("base/sets contain state outside the one explicitly expected set")
    base_record = file_identity(base_path, "active base image")
    if base_record["sha256"] != base_sha:
        fail("active base image bytes differ from the signed Canonical digest")
    set_record = tree_identity(set_directory, "active guest set")
    expected_root_uid = os.geteuid()
    expected_root_gid = os.getegid() if test_mode() else 0
    expected_drill_uid = drill_user_uid()
    expected_drill_gid = drill_group_gid()
    expected_entries: dict[str, tuple[str, int, int, int]] = {
        "receipt.json": ("file", expected_root_uid, expected_drill_gid, 0o640),
        "release-layout-hypervisor-evidence-private.pem": (
            "file",
            expected_root_uid,
            expected_root_gid,
            0o600,
        ),
        "release-layout-hypervisor-evidence-public.pem": (
            "file",
            expected_root_uid,
            expected_root_gid,
            0o644,
        ),
        "release-layout-evidence-trust.v1.json": (
            "file",
            expected_root_uid,
            expected_root_gid,
            0o600,
        ),
    }
    for guest in GUESTS:
        expected_entries[f"release-layout-{guest}-evidence-public.pem"] = (
            "file",
            expected_root_uid,
            expected_root_gid,
            0o644,
        )
        expected_entries[guest] = (
            "directory",
            expected_root_uid,
            expected_drill_gid,
            0o750,
        )
        expected_entries[f"{guest}/root.qcow2"] = (
            "file",
            expected_drill_uid,
            expected_drill_gid,
            0o600,
        )
        expected_entries[f"{guest}/seed.img"] = (
            "file",
            expected_root_uid,
            expected_drill_gid,
            0o640,
        )
    observed_entries = {
        entry["path"]: (
            entry["type"],
            entry["uid"],
            entry["gid"],
            entry["mode"],
        )
        for entry in set_record["entries"]
    }
    if observed_entries != expected_entries:
        fail("active guest-set tree ownership/mode closure is invalid")
    entry_records = {
        entry["path"]: entry for entry in set_record["entries"]
    }
    if active["ports"] != [guest["port"] for guest in guests]:
        fail("active provision ports differ from guest port bindings")
    for guest in guests:
        overlay_entry = entry_records[f"{guest['name']}/root.qcow2"]
        seed_entry = entry_records[f"{guest['name']}/seed.img"]
        expected_overlay_sha256 = expected_current_overlay_sha256s.get(
            guest["name"], guest.get("overlayInitialSha256")
        )
        if (
            overlay_entry["sha256"] != expected_overlay_sha256
            or seed_entry["sha256"] != guest.get("seedSha256")
        ):
            fail(f"{guest['name']} bytes differ from the active provision receipt")
    return active, {
        "active": {
            "canonical": str(active_path),
            "quarantineRelative": "payload/active.json",
            "identity": file_identity(active_path, "active provision receipt"),
        },
        "trust": {
            "canonical": str(trust_path),
            "quarantineRelative": (
                "payload/release-layout-evidence-trust.v1.json"
            ),
            "identity": file_identity(trust_path, "release-layout trust manifest"),
        },
        "set": {
            "canonical": str(set_directory),
            "quarantineRelative": f"payload/sets/{expected_set_id}",
            "identity": set_record,
        },
        "base": {
            "canonical": str(base_path),
            "quarantineRelative": f"payload/base/{base_path.name}",
            "identity": base_record,
        },
    }


def assert_empty_directory(path: Path, label: str) -> None:
    identity = assert_path_identity(path, label, "directory")
    if identity.st_nlink < 2 or any(path.iterdir()):
        fail(f"{label} must be empty")


def assert_state_directory_contract() -> None:
    root = state_root()
    drill_gid = drill_group_gid()
    for path, label in (
        (root, "rollback-drill state root"),
        (root / "base", "rollback-drill base root"),
        (root / "sets", "rollback-drill sets root"),
    ):
        identity = assert_path_identity(path, label, "directory", 0o750)
        if identity.st_gid != drill_gid:
            fail(f"{label} is outside the dedicated drill group")
    quarantine = root / "quarantine"
    if quarantine.exists() or quarantine.is_symlink():
        identity = assert_path_identity(
            quarantine, "set-retirement quarantine root", "directory", 0o700
        )
        root_gid = os.getegid() if test_mode() else 0
        if identity.st_gid != root_gid:
            fail("set-retirement quarantine root group is unsafe")


def validate_fixed_lock(
    path: Path,
    label: str,
    mode: int,
    expected_gid: int,
    create: bool = False,
) -> int:
    if create:
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        flags = os.O_RDWR | os.O_CREAT
    else:
        flags = os.O_RDWR
    flags |= getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, flags, mode)
    identity = os.fstat(descriptor)
    path_identity = path.lstat()
    if (
        not stat.S_ISREG(identity.st_mode)
        or identity.st_nlink != 1
        or (identity.st_dev, identity.st_ino)
        != (path_identity.st_dev, path_identity.st_ino)
        or identity.st_uid != os.geteuid()
        or identity.st_gid != expected_gid
        or stat.S_IMODE(identity.st_mode) != mode
    ):
        os.close(descriptor)
        fail(f"{label} identity is unsafe")
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        os.close(descriptor)
        fail(f"{label} is held")
    return descriptor


def acquire_all_locks() -> list[int]:
    root = state_root()
    run_root = runtime_root()
    readiness_sequences = root / "readiness-sequences"
    readiness_sequences.mkdir(mode=0o700, parents=True, exist_ok=True)
    if stat.S_IMODE(readiness_sequences.lstat().st_mode) != 0o700:
        fail("readiness sequence root mode is unsafe")
    descriptors: list[int] = []
    # Canonical deadlock-free order:
    # sequence -> readiness -> controller -> shared -> install/provision
    # -> admission -> active. Controllers/readiness may acquire shared later;
    # installers acquire shared before control; guests acquire shared before
    # admission and active.
    root_gid = os.getegid() if test_mode() else 0
    lock_specs = (
        (
            readiness_sequences / "control.lock",
            "readiness sequence lock",
            0o600,
            root_gid,
            True,
        ),
        (
            root / "runtime-readiness-control.lock",
            "runtime readiness lock",
            0o600,
            root_gid,
            True,
        ),
        (
            run_root / "release-layout-fault-controller.lock",
            "fault controller lock",
            0o600,
            root_gid,
            False,
        ),
        (
            shared_mutex(),
            "shared release/Sonar lock",
            0o660,
            worker_group_gid(),
            False,
        ),
        (
            root / "control.lock",
            "install/provision control lock",
            0o600,
            root_gid,
            False,
        ),
        (
            run_root / "admission.lock",
            "guest admission lock",
            0o660,
            drill_group_gid(),
            False,
        ),
        (
            run_root / "active.lock",
            "active guest lock",
            0o660,
            drill_group_gid(),
            False,
        ),
    )
    try:
        for path, label, mode, expected_gid, create in lock_specs:
            descriptors.append(
                validate_fixed_lock(path, label, mode, expected_gid, create)
            )
        return descriptors
    except BaseException:
        for descriptor in reversed(descriptors):
            os.close(descriptor)
        raise


def release_locks(descriptors: list[int]) -> None:
    for descriptor in reversed(descriptors):
        os.close(descriptor)


def systemctl(*arguments: str) -> str:
    result = subprocess.run(
        [str(systemctl_path()), *arguments],
        check=False,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=20,
    )
    if result.returncode != 0:
        fail(
            "systemd state query failed: "
            + " ".join(arguments)
            + f" (exit {result.returncode})"
        )
    return result.stdout


def assert_unit_idle(unit: str) -> None:
    output = systemctl(
        "show",
        "--no-pager",
        "--property=LoadState",
        "--property=ActiveState",
        "--property=SubState",
        "--property=MainPID",
        "--property=ControlPID",
        "--",
        unit,
    )
    values: dict[str, str] = {}
    for line in output.splitlines():
        if "=" not in line:
            fail(f"systemd returned malformed state for {unit}")
        key, value = line.split("=", 1)
        if key in values:
            fail(f"systemd repeated {key} for {unit}")
        values[key] = value
    if set(values) != {"LoadState", "ActiveState", "SubState", "MainPID", "ControlPID"}:
        fail(f"systemd state response is incomplete for {unit}")
    if (
        values["LoadState"] != "loaded"
        or values["ActiveState"] != "inactive"
        or values["SubState"] not in {"dead", "exited"}
        or values["MainPID"] != "0"
        or values["ControlPID"] != "0"
    ):
        fail(f"systemd unit is not exactly idle: {unit}")


def ensure_boot_guards() -> None:
    if test_mode():
        override = os.environ.get(
            "NEXUS_KVM_SET_RETIREMENT_TEST_BOOT_GUARD_ROOT"
        )
        if not override:
            fail("test boot-guard root is required")
        guard_root = Path(override)
        targets = tuple(
            guard_root / f"guard-{index}.conf"
            for index in range(len(BOOT_GUARD_TARGETS))
        )
    else:
        targets = BOOT_GUARD_TARGETS
    for target in targets:
        target.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
        if target.exists() or target.is_symlink():
            identity = target.lstat()
            if (
                not stat.S_ISREG(identity.st_mode)
                or stat.S_ISLNK(identity.st_mode)
                or identity.st_nlink != 1
                or identity.st_uid != os.geteuid()
                or stat.S_IMODE(identity.st_mode) != 0o644
                or read_file_bytes(target, "set-retirement boot guard", 1, 4096)
                != BOOT_GUARD_BODY
            ):
                fail(f"set-retirement boot guard is unsafe: {target}")
        else:
            durable_write(target, BOOT_GUARD_BODY, 0o644)
    systemctl("daemon-reload")


def assert_all_units_idle() -> None:
    for guest in GUESTS:
        assert_unit_idle(f"nexus-rollback-drill-vm@{guest}.service")
    assert_unit_idle("nexus-release-layout-fault-drill-recovery.service")
    listed = systemctl(
        "list-units",
        "--all",
        "--plain",
        "--no-legend",
        "nexus-release-layout-fault-drill@*.service",
    )
    for line in listed.splitlines():
        fields = line.split()
        if not fields:
            continue
        unit = fields[0]
        if not unit.startswith(FAULT_UNIT_PREFIX) or not unit.endswith(".service"):
            fail("systemd returned an unexpected fault-controller unit")
        assert_unit_idle(unit)
    jobs = systemctl("list-jobs", "--plain", "--no-legend")
    for line in jobs.splitlines():
        if (
            "nexus-rollback-drill-vm@" in line
            or "nexus-release-layout-fault-drill" in line
        ):
            fail("a rollback-drill systemd job is pending")


def process_cmdline(pid_root: Path) -> bytes:
    try:
        return (pid_root / "cmdline").read_bytes()
    except FileNotFoundError:
        return b""
    except OSError as error:
        fail(f"cannot inspect process command line: {error}")


def assert_no_live_process_or_open_file(
    bindings: dict[str, Any], quarantine: Path | None = None
) -> None:
    proc = proc_root()
    if not proc.is_dir():
        fail("proc root is unavailable")
    protected = [
        Path(bindings["set"]["canonical"]),
        Path(bindings["base"]["canonical"]),
    ]
    if quarantine is not None:
        protected.extend(
            (
                quarantine / bindings["set"]["quarantineRelative"],
                quarantine / bindings["base"]["quarantineRelative"],
            )
        )
    dangerous_commands = (
        b"/usr/local/libexec/nexus-rollback-drill-vm/run",
        b"/usr/local/libexec/nexus-rollback-drill-vm/release-layout-fault-controller",
        b"/usr/local/libexec/nexus-rollback-drill-vm/runtime-readiness",
    )
    for pid_root in sorted(proc.iterdir(), key=lambda candidate: candidate.name):
        if not pid_root.name.isdigit() or not pid_root.is_dir():
            continue
        cmdline = process_cmdline(pid_root)
        if any(command in cmdline for command in dangerous_commands):
            fail(f"rollback-drill process remains live: pid {pid_root.name}")
        if b"qemu-system-x86_64" in cmdline:
            fail(f"QEMU remains live during set retirement: pid {pid_root.name}")
        fd_root = pid_root / "fd"
        try:
            descriptors = list(fd_root.iterdir())
        except FileNotFoundError:
            continue
        except OSError as error:
            fail(f"cannot inspect process file descriptors: {error}")
        for descriptor in descriptors:
            try:
                target = Path(os.readlink(descriptor))
            except FileNotFoundError:
                continue
            except OSError as error:
                fail(f"cannot resolve process file descriptor: {error}")
            if not target.is_absolute():
                continue
            for boundary in protected:
                if target == boundary or boundary in target.parents:
                    fail(
                        "a process retains an open active-set/base file: "
                        f"pid {pid_root.name}"
                    )


def assert_ports_not_listening(active: dict[str, Any]) -> None:
    expected = set(active["ports"])
    if len(expected) != 3 or any(
        not isinstance(port, int) or port < 1024 or port > 65535 for port in expected
    ):
        fail("active guest ports are invalid")
    for name in ("net/tcp", "net/tcp6"):
        path = proc_root() / name
        try:
            lines = path.read_text(encoding="ascii").splitlines()[1:]
        except FileNotFoundError:
            if test_mode():
                continue
            fail(f"cannot inspect {name}")
        for line in lines:
            fields = line.split()
            if len(fields) < 4 or ":" not in fields[1]:
                continue
            port = int(fields[1].rsplit(":", 1)[1], 16)
            state = fields[3]
            if port in expected and state == "0A":
                fail(f"guest loopback port remains in LISTEN: {port}")


def assert_no_nonterminal_state(active_sha256: str, set_id: str) -> None:
    root = state_root()
    for name in ("install-in-progress.v1", "provision-in-progress.v1"):
        path = root / name
        if path.exists() or path.is_symlink():
            fail(f"unfinished rollback-drill journal is present: {name}")
    handoff = runtime_root() / "handoff"
    if handoff.exists() and any(handoff.iterdir()):
        fail("runtime-readiness handoff state is present")
    pending = root / "runtime-readiness-pending"
    if pending.exists() and any(pending.iterdir()):
        fail("runtime-readiness pending evidence is present")
    for parent_name in ("runtime-readiness", "runtime-evidence"):
        candidate = root / parent_name / set_id
        if candidate.exists() or candidate.is_symlink():
            fail(f"{parent_name} exists for the incomplete set")
    sequences = root / "readiness-sequences"
    if sequences.exists():
        for entry in sequences.iterdir():
            if entry.name == "control.lock":
                continue
            state_file = entry / "state.json"
            if not state_file.exists():
                fail("readiness sequence contains ambiguous state")
            _, sequence = read_json(state_file, "readiness sequence state", 16 * 1024 * 1024)
            if (
                sequence.get("provisionReceiptSha256") == active_sha256
                and sequence.get("completedAt") is None
            ):
                fail("a runtime-readiness sequence is nonterminal")
            if sequence.get("provisionReceiptSha256") == active_sha256:
                fail("runtime-readiness sequence evidence exists for incomplete set")
    controllers = root / "release-layout-fault-drills"
    if controllers.exists():
        for entry in controllers.iterdir():
            journal = entry / "controller-journal.v1.json"
            if not journal.exists():
                fail("fault-controller state lacks a journal")
            _, value = read_json(journal, "fault-controller journal")
            if value.get("status") not in TERMINAL_CONTROLLER_STATUSES:
                fail("a fault-controller journal is nonterminal")


def item_locations(
    journal: dict[str, Any], item: str, operation: str
) -> tuple[Path, Path]:
    binding = journal["bindings"][item]
    canonical = Path(binding["canonical"])
    quarantine = Path(journal["quarantineRoot"]) / binding["quarantineRelative"]
    return (canonical, quarantine) if operation == "quarantine" else (quarantine, canonical)


def location_state(source: Path, destination: Path) -> str:
    source_exists = source.exists() or source.is_symlink()
    destination_exists = destination.exists() or destination.is_symlink()
    if source_exists and destination_exists:
        fail("transaction item exists at both source and destination")
    if not source_exists and not destination_exists:
        fail("transaction item exists at neither source nor destination")
    return "source" if source_exists else "destination"


def checkpoint(journal: dict[str, Any], phase: str) -> None:
    journal["phase"] = phase
    journal["updatedAt"] = utc_now()
    durable_write(state_root() / "set-retirement-in-progress.v1.json", canonical_json(journal))
    if (
        test_mode()
        and os.environ.get("NEXUS_KVM_SET_RETIREMENT_TEST_INTERRUPT_AFTER") == phase
    ):
        raise SystemExit(198)


def ensure_quarantine_root(journal: dict[str, Any]) -> None:
    quarantine = Path(journal["quarantineRoot"])
    quarantine.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    assert_path_identity(
        quarantine.parent, "set-retirement quarantine root", "directory", 0o700
    )
    if quarantine.exists():
        assert_path_identity(quarantine, "quarantine transaction root", "directory", 0o700)
    else:
        quarantine.mkdir(mode=0o700, parents=False)
        os.chmod(quarantine, 0o700)
        fsync_path(quarantine.parent)
    for relative in ("payload", "payload/base", "payload/sets"):
        path = quarantine / relative
        if path.exists():
            assert_path_identity(path, f"quarantine {relative}", "directory", 0o700)
        else:
            path.mkdir(mode=0o700)
            fsync_path(path.parent)
    fsync_path(quarantine)


def move_one(journal: dict[str, Any], item: str, operation: str) -> None:
    source, destination = item_locations(journal, item, operation)
    state = location_state(source, destination)
    binding = journal["bindings"][item]
    destination_identity_key = (
        "quarantinedIdentity" if operation == "quarantine" else "restoredIdentity"
    )
    source_identity = (
        binding["identity"]
        if operation == "quarantine"
        else binding.get("quarantinedIdentity")
    )
    if not isinstance(source_identity, dict):
        fail(f"{item} lacks its exact source identity for {operation}")
    if state == "destination":
        recorded_destination = binding.get(destination_identity_key)
        if isinstance(recorded_destination, dict):
            validate_recorded_identity(
                destination, recorded_destination, f"moved {item}"
            )
        else:
            binding[destination_identity_key] = validate_recorded_identity(
                destination,
                source_identity,
                f"moved {item}",
                ignore_ctime=True,
            )
        return
    validate_recorded_identity(source, source_identity, f"source {item}")
    assert_path_identity(source.parent, f"{item} source parent", "directory")
    assert_path_identity(destination.parent, f"{item} destination parent", "directory")
    object_flags = (
        os.O_RDONLY
        | getattr(os, "O_CLOEXEC", 0)
        | getattr(os, "O_NOFOLLOW", 0)
    )
    if source_identity["kind"] == "directory":
        object_flags |= getattr(os, "O_DIRECTORY", 0)
    with verified_directory_descriptor(
        source.parent, f"{item} source parent", allow_metadata_change=True
    ) as source_parent_fd:
        with verified_directory_descriptor(
            destination.parent,
            f"{item} destination parent",
            allow_metadata_change=True,
        ) as destination_parent_fd:
            object_fd = os.open(
                source.name, object_flags, dir_fd=source_parent_fd
            )
            try:
                opened = os.fstat(object_fd)
                expected_top = (
                    source_identity["device"],
                    source_identity["inode"],
                    (
                        stat.S_IFDIR
                        if source_identity["kind"] == "directory"
                        else stat.S_IFREG
                    )
                    | source_identity["mode"],
                    source_identity["nlink"],
                    source_identity["uid"],
                    source_identity["gid"],
                    source_identity["size"],
                    source_identity["mtimeNs"],
                    source_identity["ctimeNs"],
                )
                if stable_identity(opened) != expected_top:
                    fail(f"{item} changed before its atomic rename")
                if os.fstat(source_parent_fd).st_dev != os.fstat(
                    destination_parent_fd
                ).st_dev:
                    fail("quarantine transaction would cross filesystems")
                os.rename(
                    source.name,
                    destination.name,
                    src_dir_fd=source_parent_fd,
                    dst_dir_fd=destination_parent_fd,
                )
                moved = os.fstat(object_fd)
                destination_path_identity = os.stat(
                    destination.name,
                    dir_fd=destination_parent_fd,
                    follow_symlinks=False,
                )
                if (
                    (moved.st_dev, moved.st_ino)
                    != (
                        destination_path_identity.st_dev,
                        destination_path_identity.st_ino,
                    )
                    or stable_identity(moved)[:-1] != stable_identity(opened)[:-1]
                ):
                    fail(f"{item} identity drifted during atomic rename")
                os.fsync(source_parent_fd)
                os.fsync(destination_parent_fd)
            finally:
                os.close(object_fd)
    binding[destination_identity_key] = validate_recorded_identity(
        destination,
        source_identity,
        f"moved {item}",
        ignore_ctime=True,
    )


def receipt_body(journal: dict[str, Any], schema: str, status: str) -> bytes:
    value = {
        "schema": schema,
        "status": status,
        "transactionId": journal["transactionId"],
        "setId": journal["expected"]["setId"],
        "activeReceiptSha256": journal["expected"]["activeReceiptSha256"],
        "staleRuntimeManifestSha256": journal["expected"][
            "runtimeManifestSha256"
        ],
        "source": journal["source"],
        "bindings": journal["bindings"],
        "preparedAt": journal["preparedAt"],
        "completedAt": utc_now(),
        "authorityOrder": (
            ["active", "trust", "set", "base"]
            if status == "quarantined"
            else ["base", "set", "trust", "active"]
        ),
        "deletionPerformed": False,
    }
    return canonical_json(value)


def publish_terminal(journal: dict[str, Any], operation: str) -> None:
    quarantine = Path(journal["quarantineRoot"])
    receipts = state_root() / "set-retirement-receipts"
    receipts.mkdir(mode=0o700, parents=True, exist_ok=True)
    if operation == "quarantine":
        schema = QUARANTINE_RECEIPT_SCHEMA
        status = "quarantined"
        local_name = "quarantine-receipt.v1.json"
        global_name = f"{journal['transactionId']}.quarantine.json"
        journal_name = "quarantine-terminal-journal.v1.json"
    else:
        schema = RESTORE_RECEIPT_SCHEMA
        status = "restored"
        local_name = "restore-receipt.v1.json"
        global_name = f"{journal['transactionId']}.restore.json"
        journal_name = "restore-terminal-journal.v1.json"
    proposed_body = receipt_body(journal, schema, status)
    destinations = (quarantine / local_name, receipts / global_name)
    existing_bodies: list[bytes] = []
    for destination in destinations:
        if destination.exists() or destination.is_symlink():
            assert_path_identity(
                destination, "existing terminal receipt", "file", 0o600
            )
            existing_body = read_file_bytes(
                destination, "existing terminal receipt", 2, 4 * 1024 * 1024
            )
            if existing_body != proposed_body:
                # completedAt is nondeterministic, so an existing receipt is
                # authoritative only when all immutable fields agree.
                _, existing = read_json(destination, "existing terminal receipt")
                proposed = json.loads(proposed_body)
                for field in (
                    "schema",
                    "status",
                    "transactionId",
                    "setId",
                    "activeReceiptSha256",
                    "staleRuntimeManifestSha256",
                    "source",
                    "bindings",
                    "preparedAt",
                    "authorityOrder",
                    "deletionPerformed",
                ):
                    if existing.get(field) != proposed.get(field):
                        fail("existing terminal receipt differs from transaction")
            existing_bodies.append(existing_body)
    if len(existing_bodies) == 2 and existing_bodies[0] != existing_bodies[1]:
        fail("terminal receipt copies are not byte-identical")
    body = existing_bodies[0] if existing_bodies else proposed_body
    for destination in destinations:
        if not destination.exists() and not destination.is_symlink():
            durable_write(destination, body)
    active_journal = state_root() / "set-retirement-in-progress.v1.json"
    terminal_journal = quarantine / journal_name
    if terminal_journal.exists() or terminal_journal.is_symlink():
        assert_path_identity(
            terminal_journal, "terminal set-retirement journal", "file", 0o600
        )
        if active_journal.exists() or active_journal.is_symlink():
            fail("both active and terminal retirement journals exist")
        return
    os.rename(active_journal, terminal_journal)
    fsync_path(active_journal.parent)
    fsync_path(terminal_journal.parent)


def complete_quarantine(journal: dict[str, Any]) -> None:
    ensure_quarantine_root(journal)
    checkpoint(journal, "quarantine_root_prepared")
    for item, phase in (
        ("active", "active_receipt_quarantined"),
        ("trust", "trust_manifest_quarantined"),
        ("set", "guest_set_quarantined"),
        ("base", "base_image_quarantined"),
    ):
        move_one(journal, item, "quarantine")
        checkpoint(journal, phase)
    assert_empty_directory(state_root() / "base", "canonical base directory")
    assert_empty_directory(state_root() / "sets", "canonical sets directory")
    checkpoint(journal, "canonical_state_empty")
    publish_terminal(journal, "quarantine")


def validate_installed_old_runtime(journal: dict[str, Any]) -> None:
    quarantine = Path(journal["quarantineRoot"])
    quarantined_active = (
        quarantine / journal["bindings"]["active"]["quarantineRelative"]
    )
    canonical_active = Path(journal["bindings"]["active"]["canonical"])
    active_location = location_state(quarantined_active, canonical_active)
    active_path = (
        quarantined_active if active_location == "source" else canonical_active
    )
    _, active = read_json(active_path, "quarantined active receipt")
    hypervisor = active.get("hypervisor")
    if not isinstance(hypervisor, dict):
        fail("quarantined hypervisor identity is invalid")
    for path_field, digest_field in RUNTIME_ASSETS:
        candidate = Path(hypervisor.get(path_field, ""))
        expected = hypervisor.get(digest_field)
        if (
            not candidate.is_absolute()
            or not DIGEST.fullmatch(expected or "")
            or not candidate.is_file()
            or candidate.is_symlink()
            or sha256_file(candidate, f"installed {digest_field}") != expected
        ):
            fail(
                "installed rollback-drill runtime differs from the quarantined "
                f"set: {digest_field}"
            )


def assert_restore_preconditions(journal: dict[str, Any]) -> None:
    assert_empty_directory(state_root() / "base", "canonical base directory")
    assert_empty_directory(state_root() / "sets", "canonical sets directory")
    for authority in (
        state_root() / "active.json",
        state_root() / "release-layout-evidence-trust.v1.json",
    ):
        if authority.exists() or authority.is_symlink():
            fail("new active authority blocks restoration")
    validate_installed_old_runtime(journal)


def assert_restore_recovery_state(journal: dict[str, Any]) -> None:
    allowed_base = Path(journal["bindings"]["base"]["canonical"]).name
    allowed_set = journal["expected"]["setId"]
    base_entries = {entry.name for entry in (state_root() / "base").iterdir()}
    set_entries = {entry.name for entry in (state_root() / "sets").iterdir()}
    if not base_entries.issubset({allowed_base}) or not set_entries.issubset(
        {allowed_set}
    ):
        fail("unrelated canonical base/set state blocks restore recovery")
    for item in ("base", "set", "trust", "active"):
        source, destination = item_locations(journal, item, "restore")
        location_state(source, destination)
    validate_installed_old_runtime(journal)


def complete_restore(journal: dict[str, Any]) -> None:
    assert_restore_recovery_state(journal)
    for item, phase in (
        ("base", "base_image_restored"),
        ("set", "guest_set_restored"),
        ("trust", "trust_manifest_restored"),
        ("active", "active_receipt_restored"),
    ):
        move_one(journal, item, "restore")
        checkpoint(journal, phase)
    publish_terminal(journal, "restore")


def validate_identity_schema(
    value: Any, label: str, expected_kind: str
) -> None:
    common = {
        "kind",
        "device",
        "inode",
        "uid",
        "gid",
        "mode",
        "nlink",
        "size",
        "mtimeNs",
        "ctimeNs",
    }
    expected = (
        common | {"sha256"}
        if expected_kind == "file"
        else common | {"entryCount", "treeSha256", "entries"}
    )
    exact_keys(value, expected, label)
    if value["kind"] != expected_kind:
        fail(f"{label} kind is invalid")
    for field in (
        "device",
        "inode",
        "uid",
        "gid",
        "mode",
        "nlink",
        "size",
        "mtimeNs",
        "ctimeNs",
    ):
        if not isinstance(value[field], int) or value[field] < 0:
            fail(f"{label} {field} is invalid")
    if value["nlink"] < 1 or value["mode"] > 0o7777:
        fail(f"{label} mode/link identity is invalid")
    if expected_kind == "file":
        if not DIGEST.fullmatch(value["sha256"] or ""):
            fail(f"{label} digest is invalid")
        return
    if (
        not isinstance(value["entryCount"], int)
        or value["entryCount"] < 0
        or not DIGEST.fullmatch(value["treeSha256"] or "")
        or not isinstance(value["entries"], list)
        or len(value["entries"]) != value["entryCount"]
    ):
        fail(f"{label} tree identity is invalid")
    seen: set[str] = set()
    digest_entries: list[dict[str, Any]] = []
    for index, entry in enumerate(value["entries"]):
        entry_label = f"{label} entry {index}"
        if not isinstance(entry, dict) or entry.get("type") not in {
            "file",
            "directory",
        }:
            fail(f"{entry_label} type is invalid")
        entry_expected = {
            "path",
            "uid",
            "gid",
            "mode",
            "nlink",
            "size",
            "mtimeNs",
            "ctimeNs",
            "device",
            "inode",
            "type",
        }
        if entry["type"] == "file":
            entry_expected.add("sha256")
        exact_keys(entry, entry_expected, entry_label)
        relative = entry["path"]
        if (
            not isinstance(relative, str)
            or not relative
            or relative.startswith("/")
            or Path(relative).as_posix() != relative
            or ".." in Path(relative).parts
            or relative in seen
        ):
            fail(f"{entry_label} path is invalid")
        seen.add(relative)
        for field in (
            "uid",
            "gid",
            "mode",
            "nlink",
            "size",
            "mtimeNs",
            "ctimeNs",
            "device",
            "inode",
        ):
            if not isinstance(entry[field], int) or entry[field] < 0:
                fail(f"{entry_label} {field} is invalid")
        if entry["type"] == "file" and not DIGEST.fullmatch(
            entry["sha256"] or ""
        ):
            fail(f"{entry_label} digest is invalid")
        digest_entries.append(
            {
                key: item
                for key, item in entry.items()
                if key not in {"device", "inode"}
            }
        )
    if sha256_bytes(canonical_json(digest_entries)) != value["treeSha256"]:
        fail(f"{label} tree digest is invalid")


def validate_journal_bindings(journal: dict[str, Any]) -> None:
    root = state_root()
    identifier = journal["transactionId"]
    expected_quarantine = root / "quarantine" / identifier
    if journal["quarantineRoot"] != str(expected_quarantine):
        fail("set-retirement quarantine path differs from transaction identity")
    set_id = journal["expected"]["setId"]
    bindings = journal["bindings"]
    expected_paths = {
        "active": (
            root / "active.json",
            "payload/active.json",
            "file",
            0o640,
        ),
        "trust": (
            root / "release-layout-evidence-trust.v1.json",
            "payload/release-layout-evidence-trust.v1.json",
            "file",
            0o600,
        ),
        "set": (
            root / "sets" / set_id,
            f"payload/sets/{set_id}",
            "directory",
            0o750,
        ),
    }
    for name in ("active", "trust", "set"):
        canonical, relative, kind, mode = expected_paths[name]
        binding = bindings[name]
        allowed = {
            "canonical",
            "quarantineRelative",
            "identity",
            "quarantinedIdentity",
            "restoredIdentity",
        }
        if not isinstance(binding, dict) or not {
            "canonical",
            "quarantineRelative",
            "identity",
        }.issubset(binding) or not set(binding).issubset(allowed):
            fail(f"{name} journal binding fields are invalid")
        if (
            binding["canonical"] != str(canonical)
            or binding["quarantineRelative"] != relative
        ):
            fail(f"{name} journal binding path is invalid")
        validate_identity_schema(binding["identity"], f"{name} identity", kind)
        if binding["identity"]["mode"] != mode:
            fail(f"{name} journal mode binding is invalid")
    base_binding = bindings["base"]
    if not isinstance(base_binding, dict):
        fail("base journal binding is invalid")
    allowed = {
        "canonical",
        "quarantineRelative",
        "identity",
        "quarantinedIdentity",
        "restoredIdentity",
    }
    if not {
        "canonical",
        "quarantineRelative",
        "identity",
    }.issubset(base_binding) or not set(base_binding).issubset(allowed):
        fail("base journal binding fields are invalid")
    validate_identity_schema(base_binding["identity"], "base identity", "file")
    base_digest = base_binding["identity"]["sha256"]
    expected_base = root / "base" / f"{base_digest}.qcow2"
    if (
        base_binding["canonical"] != str(expected_base)
        or base_binding["quarantineRelative"]
        != f"payload/base/{base_digest}.qcow2"
        or base_binding["identity"]["mode"] != 0o440
    ):
        fail("base journal binding path/mode is invalid")
    expected_uid = os.geteuid()
    expected_root_gid = os.getegid() if test_mode() else 0
    expected_drill_gid = drill_group_gid()
    ownership = {
        "active": (expected_uid, expected_drill_gid),
        "trust": (expected_uid, expected_root_gid),
        "set": (expected_uid, expected_drill_gid),
        "base": (expected_uid, expected_drill_gid),
    }
    for name, (uid, gid) in ownership.items():
        identity = bindings[name]["identity"]
        if identity["uid"] != uid or identity["gid"] != gid:
            fail(f"{name} journal ownership binding is invalid")
        for relocated in ("quarantinedIdentity", "restoredIdentity"):
            if relocated not in bindings[name]:
                continue
            validate_identity_schema(
                bindings[name][relocated],
                f"{name} {relocated}",
                identity["kind"],
            )
            if comparable_identity(
                bindings[name][relocated], ignore_ctime=True
            ) != comparable_identity(identity, ignore_ctime=True):
                fail(f"{name} relocated identity differs beyond rename ctime")
    if (
        bindings["active"]["identity"]["sha256"]
        != journal["expected"]["activeReceiptSha256"]
    ):
        fail("active journal digest differs from expected authority")
    receipt_entries = [
        entry
        for entry in bindings["set"]["identity"]["entries"]
        if entry["path"] == "receipt.json" and entry["type"] == "file"
    ]
    if (
        len(receipt_entries) != 1
        or receipt_entries[0]["sha256"]
        != journal["expected"]["activeReceiptSha256"]
        or receipt_entries[0]["mode"] != 0o640
    ):
        fail("set tree does not bind the active receipt")


def load_journal() -> dict[str, Any]:
    path = state_root() / "set-retirement-in-progress.v1.json"
    assert_path_identity(path, "set-retirement journal", "file", 0o600)
    body, journal = read_json(path, "set-retirement journal")
    del body
    exact_keys(
        journal,
        (
            "schema",
            "operation",
            "transactionId",
            "quarantineRoot",
            "source",
            "expected",
            "bindings",
            "preparedAt",
            "updatedAt",
            "phase",
        ),
        "set-retirement journal",
    )
    if (
        journal["schema"] != SCHEMA
        or journal["operation"] not in {"quarantine", "restore"}
        or not UUID.fullmatch(journal["transactionId"])
        or Path(journal["quarantineRoot"]).parent
        != state_root() / "quarantine"
    ):
        fail("set-retirement journal identity is invalid")
    exact_keys(
        journal["expected"],
        ("setId", "activeReceiptSha256", "runtimeManifestSha256"),
        "set-retirement expected identity",
    )
    for value in journal["expected"].values():
        if not DIGEST.fullmatch(value):
            fail("set-retirement expected digest is invalid")
    if set(journal["bindings"]) != {"active", "trust", "set", "base"}:
        fail("set-retirement binding set is invalid")
    validate_journal_bindings(journal)
    return journal


def source_matches(journal: dict[str, Any], source: dict[str, str]) -> None:
    if journal["source"] != source:
        fail("recovery source/archive identity differs from journal")


def prepare_journal(
    operation: str,
    source: dict[str, str],
    expected: dict[str, str],
    bindings: dict[str, Any],
    transaction_id: str | None = None,
) -> dict[str, Any]:
    identifier = transaction_id or str(uuid.uuid4())
    quarantine = state_root() / "quarantine" / identifier
    now = utc_now()
    journal = {
        "schema": SCHEMA,
        "operation": operation,
        "transactionId": identifier,
        "quarantineRoot": str(quarantine),
        "source": source,
        "expected": expected,
        "bindings": bindings,
        "preparedAt": now,
        "updatedAt": now,
        "phase": "prepared",
    }
    validate_journal_bindings(journal)
    durable_write(state_root() / "set-retirement-in-progress.v1.json", canonical_json(journal))
    if (
        test_mode()
        and os.environ.get("NEXUS_KVM_SET_RETIREMENT_TEST_INTERRUPT_AFTER")
        == "prepared"
    ):
        raise SystemExit(198)
    return journal


def preview_journal(
    operation: str,
    source: dict[str, Any],
    expected: dict[str, str],
    bindings: dict[str, Any],
    transaction_id: str,
) -> dict[str, Any]:
    now = utc_now()
    journal = {
        "schema": SCHEMA,
        "operation": operation,
        "transactionId": transaction_id,
        "quarantineRoot": str(state_root() / "quarantine" / transaction_id),
        "source": source,
        "expected": expected,
        "bindings": bindings,
        "preparedAt": now,
        "updatedAt": now,
        "phase": "prepared",
    }
    validate_journal_bindings(journal)
    return journal


def quarantine_command(args: argparse.Namespace, source: dict[str, str]) -> None:
    if not args.acknowledge_incomplete_set_replacement:
        fail("explicit incomplete-set replacement acknowledgement is required")
    for value, label, pattern in (
        (args.expected_set_id, "expected set id", SET_ID),
        (args.expected_active_sha256, "expected active receipt digest", DIGEST),
        (
            args.expected_runtime_manifest_sha256,
            "expected stale runtime manifest digest",
            DIGEST,
        ),
    ):
        if not pattern.fullmatch(value or ""):
            fail(f"{label} is invalid")
    if (
        args.expected_runtime_control_sha256 is not None
        and not DIGEST.fullmatch(args.expected_runtime_control_sha256)
    ):
        fail("expected runtime control digest is invalid")
    runtime_asset_changed = (
        source["desiredRuntimeManifestSha256"]
        != args.expected_runtime_manifest_sha256
        or (
            args.expected_runtime_control_sha256 is not None
            and source["desiredRuntimeControlSha256"]
            != args.expected_runtime_control_sha256
        )
    )
    if not runtime_asset_changed:
        fail(
            "desired protected-main runtime assets are not different from the "
            "explicit active identities"
        )
    expected_current_overlay_sha256s: dict[str, str] = {}
    for binding in args.expected_current_overlay_sha256 or ():
        guest, separator, digest = binding.partition("=")
        if (
            separator != "="
            or guest not in GUESTS
            or not DIGEST.fullmatch(digest)
        ):
            fail(
                "expected current overlay identity must be "
                "guest-1|guest-2|guest-3=<64-hex-sha256>"
            )
        if guest in expected_current_overlay_sha256s:
            fail(f"expected current overlay identity repeats {guest}")
        expected_current_overlay_sha256s[guest] = digest
    if bool(expected_current_overlay_sha256s) != bool(
        args.acknowledge_booted_overlay_state
    ):
        fail(
            "booted overlay acknowledgement and exact current overlay "
            "identities must be supplied together"
        )
    root = state_root()
    assert_state_directory_contract()
    journal = root / "set-retirement-in-progress.v1.json"
    if journal.exists() or journal.is_symlink():
        fail("an interrupted set-retirement transaction requires recover")
    descriptors = acquire_all_locks()
    try:
        ensure_boot_guards()
        assert_all_units_idle()
        active, bindings = validate_active_state(
            args.expected_set_id,
            args.expected_active_sha256,
            args.expected_runtime_manifest_sha256,
            args.expected_runtime_control_sha256,
            expected_current_overlay_sha256s,
        )
        for guest in active["guests"]:
            explicit_digest = expected_current_overlay_sha256s.get(guest["name"])
            if (
                explicit_digest is not None
                and explicit_digest == guest["overlayInitialSha256"]
            ):
                fail(
                    f"{guest['name']} current overlay identity is still the "
                    "provisioned initial identity"
                )
        assert_no_nonterminal_state(args.expected_active_sha256, args.expected_set_id)
        assert_no_live_process_or_open_file(bindings)
        assert_ports_not_listening(active)
        expected = {
            "setId": args.expected_set_id,
            "activeReceiptSha256": args.expected_active_sha256,
            "runtimeManifestSha256": args.expected_runtime_manifest_sha256,
        }
        transaction = prepare_journal("quarantine", source, expected, bindings)
        complete_quarantine(transaction)
        print(
            json.dumps(
                {
                    "ok": True,
                    "schema": QUARANTINE_RECEIPT_SCHEMA,
                    "status": "quarantined",
                    "transactionId": transaction["transactionId"],
                    "setId": args.expected_set_id,
                    "quarantineRoot": transaction["quarantineRoot"],
                    "deletionPerformed": False,
                },
                separators=(",", ":"),
            )
        )
    finally:
        release_locks(descriptors)


def recover_command(args: argparse.Namespace, source: dict[str, str]) -> None:
    del args
    path = state_root() / "set-retirement-in-progress.v1.json"
    if not path.exists() and not path.is_symlink():
        print(
            json.dumps(
                {
                    "ok": True,
                    "schema": SCHEMA,
                    "status": "no_active_transaction",
                },
                separators=(",", ":"),
            )
        )
        return
    assert_state_directory_contract()
    descriptors = acquire_all_locks()
    try:
        ensure_boot_guards()
        assert_all_units_idle()
        journal = load_journal()
        source_matches(journal, source)
        assert_no_nonterminal_state(
            journal["expected"]["activeReceiptSha256"],
            journal["expected"]["setId"],
        )
        assert_no_live_process_or_open_file(
            journal["bindings"], Path(journal["quarantineRoot"])
        )
        if journal["operation"] == "quarantine":
            complete_quarantine(journal)
            status = "quarantined"
        else:
            complete_restore(journal)
            status = "restored"
        print(
            json.dumps(
                {
                    "ok": True,
                    "schema": SCHEMA,
                    "status": status,
                    "transactionId": journal["transactionId"],
                },
                separators=(",", ":"),
            )
        )
    finally:
        release_locks(descriptors)


def restore_command(args: argparse.Namespace, source: dict[str, str]) -> None:
    if not args.acknowledge_restore_incomplete_set:
        fail("explicit incomplete-set restore acknowledgement is required")
    if not UUID.fullmatch(args.transaction_id or ""):
        fail("quarantine transaction id is invalid")
    if not DIGEST.fullmatch(args.expected_active_sha256 or ""):
        fail("expected active receipt digest is invalid")
    active_journal = state_root() / "set-retirement-in-progress.v1.json"
    if active_journal.exists() or active_journal.is_symlink():
        fail("an interrupted set-retirement transaction requires recover")
    assert_state_directory_contract()
    quarantine = state_root() / "quarantine" / args.transaction_id
    receipt_path = quarantine / "quarantine-receipt.v1.json"
    assert_path_identity(receipt_path, "quarantine receipt", "file", 0o600)
    _, receipt = read_json(receipt_path, "quarantine receipt")
    if (
        receipt.get("schema") != QUARANTINE_RECEIPT_SCHEMA
        or receipt.get("status") != "quarantined"
        or receipt.get("transactionId") != args.transaction_id
        or receipt.get("activeReceiptSha256") != args.expected_active_sha256
        or receipt.get("source") != source
        or receipt.get("deletionPerformed") is not False
    ):
        fail("quarantine receipt differs from the explicit restore identity")
    descriptors = acquire_all_locks()
    try:
        ensure_boot_guards()
        assert_all_units_idle()
        assert_no_nonterminal_state(
            receipt["activeReceiptSha256"], receipt["setId"]
        )
        bindings = receipt.get("bindings")
        if not isinstance(bindings, dict) or set(bindings) != {
            "active",
            "trust",
            "set",
            "base",
        }:
            fail("quarantine receipt bindings are invalid")
        assert_no_live_process_or_open_file(bindings, quarantine)
        expected = {
            "setId": receipt["setId"],
            "activeReceiptSha256": receipt["activeReceiptSha256"],
            "runtimeManifestSha256": receipt["staleRuntimeManifestSha256"],
        }
        preview = preview_journal(
            "restore",
            source,
            expected,
            bindings,
            args.transaction_id,
        )
        assert_restore_preconditions(preview)
        transaction = prepare_journal(
            "restore",
            source,
            expected,
            bindings,
            transaction_id=args.transaction_id,
        )
        complete_restore(transaction)
        print(
            json.dumps(
                {
                    "ok": True,
                    "schema": RESTORE_RECEIPT_SCHEMA,
                    "status": "restored",
                    "transactionId": transaction["transactionId"],
                    "setId": expected["setId"],
                    "deletionPerformed": False,
                },
                separators=(",", ":"),
            )
        )
    finally:
        release_locks(descriptors)


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser()
    result.add_argument("command", choices=("quarantine", "recover", "restore", "version"))
    result.add_argument("source_root", nargs="?")
    result.add_argument("source_sha", nargs="?")
    result.add_argument("source_archive", nargs="?")
    result.add_argument("source_archive_sha256", nargs="?")
    result.add_argument("--expected-set-id")
    result.add_argument("--expected-active-sha256")
    result.add_argument("--expected-runtime-manifest-sha256")
    result.add_argument("--expected-runtime-control-sha256")
    result.add_argument(
        "--expected-current-overlay-sha256",
        action="append",
        metavar="GUEST=SHA256",
    )
    result.add_argument("--transaction-id")
    result.add_argument(
        "--acknowledge-incomplete-set-replacement", action="store_true"
    )
    result.add_argument("--acknowledge-booted-overlay-state", action="store_true")
    result.add_argument("--acknowledge-restore-incomplete-set", action="store_true")
    return result


def main() -> int:
    os.umask(0o077)
    args = parser().parse_args()
    if args.command == "version":
        print(VERSION)
        return 0
    assert_execution_boundary()
    if not all(
        (
            args.source_root,
            args.source_sha,
            args.source_archive,
            args.source_archive_sha256,
        )
    ):
        fail("source root, source SHA, source archive, and archive digest are required")
    source = validate_source(
        Path(args.source_root),
        args.source_sha,
        Path(args.source_archive),
        args.source_archive_sha256,
    )
    if args.command == "quarantine":
        quarantine_command(args, source)
    elif args.command == "recover":
        recover_command(args, source)
    else:
        restore_command(args, source)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Refusal as error:
        print(
            json.dumps(
                {
                    "ok": False,
                    "schema": SCHEMA,
                    "error": str(error),
                },
                separators=(",", ":"),
            ),
            file=sys.stderr,
        )
        raise SystemExit(1)
