#!/usr/bin/env python3
"""Durable, idempotent recovery boundary for SonarQube asset installation."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import errno
import fcntl
import grp
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
from typing import Any, NoReturn


SCHEMA = "nexus.sonarqube-asset-install-transaction.v3"
RECOVERY_RECEIPT_SCHEMA = "nexus.sonarqube-asset-install-recovery.v1"
DIRECTORY_SCHEMA = "nexus.sonarqube-directory-install-transaction.v2"
DIRECTORY_RECOVERY_RECEIPT_SCHEMA = (
    "nexus.sonarqube-directory-install-recovery.v1"
)
ANCHOR_INTENT_SCHEMA = "nexus.sonarqube-recovery-anchor-enrollment-intent.v2"
ANCHOR_RECEIPT_SCHEMA = "nexus.sonarqube-recovery-anchor-enrollment.v2"
ANCHOR_UNENROLL_SCHEMA = "nexus.sonarqube-recovery-anchor-unenrollment.v1"
ANCHOR_UNENROLL_RESULT_SCHEMA = (
    "nexus.sonarqube-recovery-anchor-unenrollment-result.v1"
)
ANCHOR_CLEANUP_GENERATION_SCHEMA = (
    "nexus.sonarqube-recovery-anchor-cleanup-generation.v1"
)
INSTALL_COMMIT_SCHEMA = "nexus.sonarqube-install-commit.v2"
MAX_BYTES = 4 * 1024 * 1024
SOURCE_SHA = re.compile(r"^[0-9a-f]{40}$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")
ACK_SHA256 = re.compile(r"^sha256:[0-9a-f]{64}$")
PRODUCTION_STATE_DIR = Path("/var/lib/nexus-sonarqube")
PRODUCTION_CONTROL_PARENT = Path("/var/lib/nexus-release-promotion")
PRODUCTION_CONTROL_ROOT = (
    PRODUCTION_CONTROL_PARENT / "sonarqube-install-control"
)
PRODUCTION_JOURNAL = PRODUCTION_CONTROL_ROOT / "asset-install-in-progress.v2"
PRODUCTION_PROGRAM = PRODUCTION_CONTROL_ROOT / "install-recovery-program.v2.py"
PRODUCTION_RECOVERY_RECEIPT = (
    PRODUCTION_CONTROL_ROOT / "asset-install-recovery-receipt.v1.json"
)
PRODUCTION_DIRECTORY_JOURNAL = (
    PRODUCTION_CONTROL_ROOT / "directory-install-in-progress.v1.json"
)
PRODUCTION_DIRECTORY_RECOVERY_RECEIPT = (
    PRODUCTION_CONTROL_ROOT / "directory-install-recovery-receipt.v1.json"
)
PRODUCTION_ANCHOR_INTENT = (
    PRODUCTION_CONTROL_ROOT / "recovery-anchor-enrollment-in-progress.v2.json"
)
PRODUCTION_ANCHOR_RECEIPT = (
    PRODUCTION_CONTROL_ROOT / "recovery-anchor-enrollment.v2.json"
)
PRODUCTION_ANCHOR_UNENROLL_JOURNAL = (
    PRODUCTION_CONTROL_ROOT / "recovery-anchor-unenrollment-in-progress.v1.json"
)
PRODUCTION_ANCHOR_UNENROLL_RESULT = (
    PRODUCTION_CONTROL_ROOT / "recovery-anchor-unenrollment-result.v1.json"
)
PRODUCTION_ANCHOR_UNENROLL_ARCHIVE = (
    PRODUCTION_CONTROL_ROOT
    / "recovery-anchor-unenrollment-result-archive.v1.json"
)
PRODUCTION_ANCHOR_CLEANUP_GENERATION = (
    PRODUCTION_CONTROL_ROOT
    / "recovery-anchor-cleanup-generation.v1.json"
)
PRODUCTION_INSTALL_COMMIT = (
    PRODUCTION_CONTROL_ROOT / "install-commit.v1.json"
)
PRODUCTION_LOCK = Path("/run/lock/nexus-release-sonar.lock")
INSTALL_RECEIPT = Path("/var/lib/nexus-sonarqube/install-receipt.v1.json")
RECOVERY_SERVICE = "nexus-sonarqube-install-recovery.service"
UNENROLL_RECOVERY_SERVICE = (
    "nexus-sonarqube-anchor-unenroll-recovery.service"
)
RECOVERY_WANTS_LINK = (
    Path("/etc/systemd/system/multi-user.target.wants")
    / RECOVERY_SERVICE
)
UNENROLL_RECOVERY_UNIT = (
    Path("/etc/systemd/system") / UNENROLL_RECOVERY_SERVICE
)
UNENROLL_RECOVERY_WANTS_LINK = (
    Path("/etc/systemd/system/multi-user.target.wants")
    / UNENROLL_RECOVERY_SERVICE
)
RUNTIME_UNITS = (
    "nexus-sonarqube.service",
    "nexus-sonarqube-backup.service",
    "nexus-sonarqube-backup.timer",
)
ANCHOR_TARGETS = {
    "retainedRecoveryProgram": PRODUCTION_PROGRAM,
    "installedRecoveryProgram": Path(
        "/usr/local/sbin/quality-sonar-install-transaction.py"
    ),
    "recoveryUnit": Path(
        "/etc/systemd/system/nexus-sonarqube-install-recovery.service"
    ),
    "lockConfig": Path("/etc/tmpfiles.d/nexus-release-sonar-lock.conf"),
}
PRODUCTION_TARGETS = frozenset({
    "/srv/sonarqube/compose.yaml",
    "/srv/sonarqube/compose.drill.yaml",
    "/srv/sonarqube/images.lock.env",
    "/srv/sonarqube/data-layout.tsv",
    "/srv/sonarqube/sonar-project.properties",
    "/etc/systemd/system/nexus-sonarqube.service",
    "/etc/systemd/system/nexus-sonarqube-backup.service",
    "/etc/systemd/system/nexus-sonarqube-backup.timer",
    "/etc/systemd/system/nexus-sonarqube-install-recovery.service",
    "/usr/local/sbin/quality-sonar-stack",
    "/usr/local/sbin/quality-sonar-resolve-images",
    "/usr/local/sbin/quality-sonar-health",
    "/usr/local/sbin/quality-sonar-preflight",
    "/usr/local/sbin/nexus-ollama-observation-collector.mjs",
    "/usr/local/sbin/ollama-soak-evidence.mjs",
    "/usr/local/sbin/nexus-ollama-large-model-cleanup.mjs",
    "/usr/local/sbin/nexus-ollama-zero-swap-transition.mjs",
    "/usr/local/sbin/nexus-ollama-service-envelope-check.mjs",
    "/usr/local/sbin/lib/ollama-service-envelope.mjs",
    "/usr/local/sbin/nexus-ollama-systemd-dropin-transaction.mjs",
    "/usr/local/sbin/nexus-ollama-install-state-check.mjs",
    "/usr/local/sbin/nexus-ollama-observation-control.mjs",
    "/etc/systemd/system/ollama.service.d/00-nexus-ollama-install-guard.conf",
    "/etc/systemd/system/nexus-ollama-observation@.service",
    "/usr/local/sbin/quality-sonar-start-evidence.mjs",
    "/usr/local/sbin/quality-sonar-live-ollama-state",
    "/usr/local/sbin/quality-sonar-latency-gate.mjs",
    "/usr/local/sbin/quality-sonar-backup",
    "/usr/local/sbin/quality-sonar-aws-credential-process-boundary.py",
    "/usr/local/sbin/quality-sonar-retention.mjs",
    "/usr/local/sbin/quality-sonar-restore-drill",
    "/usr/local/sbin/quality-sonar-stack-receipt.mjs",
    "/usr/local/sbin/quality-sonar-aws-stack-state",
    "/usr/local/sbin/quality-sonar-cloudformation-activate",
    "/usr/local/sbin/quality-sonar-release-state",
    "/usr/local/sbin/quality-sonar-install-transaction.py",
    "/etc/sudoers.d/nexus-sonar-release-monitor",
})
PRODUCTION_DIRECTORIES = (
    "/usr/local/sbin/lib",
    "/etc/systemd/system/ollama.service.d",
    "/etc/sonarqube",
    "/var/lib/nexus-sonarqube",
    "/var/lib/nexus-sonarqube/restore-evidence",
    "/srv/sonarqube",
    "/srv/sonarqube/data",
    "/srv/sonarqube/data/postgresql",
    "/srv/sonarqube/data/sonarqube",
    "/srv/sonarqube/data/extensions",
    "/srv/sonarqube/data/logs",
    "/srv/sonarqube/data/temp",
)
ALLOWED_MODES = frozenset({"0440", "0600", "0644", "0700", "0755"})


def unenroll_recovery_unit_bytes() -> bytes:
    command = (
        "/usr/bin/python3 "
        "/var/lib/nexus-release-promotion/sonarqube-install-control/"
        "install-recovery-program.v2.py auto-recover "
        "--program /var/lib/nexus-release-promotion/"
        "sonarqube-install-control/install-recovery-program.v2.py "
        "--lock /run/lock/nexus-release-sonar.lock "
        "--asset-journal /var/lib/nexus-release-promotion/"
        "sonarqube-install-control/asset-install-in-progress.v2 "
        "--asset-receipt /var/lib/nexus-release-promotion/"
        "sonarqube-install-control/asset-install-recovery-receipt.v1.json "
        "--directory-journal /var/lib/nexus-release-promotion/"
        "sonarqube-install-control/directory-install-in-progress.v1.json "
        "--directory-receipt /var/lib/nexus-release-promotion/"
        "sonarqube-install-control/"
        "directory-install-recovery-receipt.v1.json "
        "--anchor-intent /var/lib/nexus-release-promotion/"
        "sonarqube-install-control/"
        "recovery-anchor-enrollment-in-progress.v2.json "
        "--anchor-receipt /var/lib/nexus-release-promotion/"
        "sonarqube-install-control/recovery-anchor-enrollment.v2.json "
        "--unenroll-journal /var/lib/nexus-release-promotion/"
        "sonarqube-install-control/"
        "recovery-anchor-unenrollment-in-progress.v1.json "
        "--unenroll-result /var/lib/nexus-release-promotion/"
        "sonarqube-install-control/"
        "recovery-anchor-unenrollment-result.v1.json "
        "--install-commit /var/lib/nexus-release-promotion/"
        "sonarqube-install-control/install-commit.v1.json"
    )
    return (
        "[Unit]\n"
        "Description=Resume an interrupted Nexus SonarQube anchor reversal\n"
        "DefaultDependencies=no\n"
        "After=local-fs.target systemd-tmpfiles-setup.service\n"
        "Before=nexus-sonarqube.service nexus-sonarqube-backup.service "
        "nexus-sonarqube-backup.timer\n"
        "ConditionPathExists=|/var/lib/nexus-release-promotion/"
        "sonarqube-install-control/"
        "recovery-anchor-unenrollment-in-progress.v1.json\n"
        "ConditionPathExists=|/var/lib/nexus-release-promotion/"
        "sonarqube-install-control/"
        "recovery-anchor-unenrollment-result.v1.json\n"
        "\n"
        "[Service]\n"
        "Type=oneshot\n"
        "User=root\n"
        "Group=root\n"
        "UMask=0077\n"
        f"ExecStart={command}\n"
        "TimeoutStartSec=180s\n"
        "KillMode=control-group\n"
        "NoNewPrivileges=true\n"
        "PrivateTmp=true\n"
        "ProtectHome=true\n"
        "ProtectSystem=strict\n"
        "ReadWritePaths=/etc/sudoers.d /etc/systemd/system "
        "/etc/tmpfiles.d /run/lock\n"
        "ReadWritePaths=-/etc/sonarqube -/srv/sonarqube "
        "/usr/local/sbin\n"
        "ReadWritePaths=/var/lib/nexus-release-promotion/"
        "sonarqube-install-control -/var/lib/nexus-sonarqube\n"
        "RestrictAddressFamilies=AF_UNIX\n"
        "LockPersonality=true\n"
        "\n"
        "[Install]\n"
        "WantedBy=multi-user.target\n"
    ).encode("utf-8")


def fail(message: str) -> NoReturn:
    raise SystemExit(f"SonarQube install transaction: {message}")


def test_mode() -> bool:
    return os.environ.get("NEXUS_RELEASE_TEST_MODE") == "1"


def test_root() -> Path:
    raw = os.environ.get("NEXUS_SONAR_INSTALL_TEST_ROOT", "")
    if not test_mode() or not raw:
        fail("test root is available only in explicit test mode")
    root = Path(raw)
    if not root.is_absolute() or root == Path("/"):
        fail("test root must be an absolute bounded directory")
    return root


def boundary_path(production: Path) -> Path:
    if not test_mode():
        return production
    return test_root() / production.relative_to("/")


def allowed_targets() -> frozenset[str]:
    if not test_mode():
        return frozenset({*PRODUCTION_TARGETS, str(INSTALL_RECEIPT)})
    return frozenset(
        str(boundary_path(Path(value)))
        for value in {*PRODUCTION_TARGETS, str(INSTALL_RECEIPT)}
    )


def allowed_directories() -> tuple[str, ...]:
    if not test_mode():
        return PRODUCTION_DIRECTORIES
    return tuple(
        str(boundary_path(Path(value))) for value in PRODUCTION_DIRECTORIES
    )


def anchor_targets() -> dict[str, Path]:
    return {
        name: boundary_path(path)
        for name, path in ANCHOR_TARGETS.items()
    }


def expected_owner() -> tuple[int, int]:
    if test_mode():
        return os.geteuid(), os.getegid()
    return 0, 0


def utc_now() -> str:
    return (
        datetime.now(timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )


def canonical_json(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        try:
            before = os.fstat(descriptor)
            if not stat.S_ISREG(before.st_mode):
                fail(f"cannot hash non-regular file {path}")
            while chunk := os.read(descriptor, 1024 * 1024):
                digest.update(chunk)
            after = os.fstat(descriptor)
            if (
                before.st_dev != after.st_dev
                or before.st_ino != after.st_ino
                or before.st_size != after.st_size
                or before.st_mtime_ns != after.st_mtime_ns
            ):
                fail(f"file changed while hashing {path}")
        finally:
            os.close(descriptor)
    except OSError as error:
        fail(f"cannot hash {path}: {error}")
    return digest.hexdigest()


def fsync_directory(path: Path) -> None:
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    except OSError as error:
        fail(f"cannot fsync directory {path}: {error}")


def atomic_write(path: Path, payload: dict[str, Any], *, exclusive: bool) -> None:
    body = canonical_json(payload) + b"\n"
    temporary = path.parent / f".{path.name}.{os.getpid()}.tmp"
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    descriptor = -1
    try:
        descriptor = os.open(temporary, flags, 0o600)
        offset = 0
        while offset < len(body):
            written = os.write(descriptor, body[offset:])
            if written <= 0:
                fail("could not persist the complete transaction state")
            offset += written
        os.fsync(descriptor)
        os.close(descriptor)
        descriptor = -1
        if exclusive:
            os.link(temporary, path, follow_symlinks=False)
            temporary.unlink()
        else:
            os.replace(temporary, path)
        fsync_directory(path.parent)
    except FileExistsError:
        fail(f"refusing to overwrite existing transaction file {path}")
    except OSError as error:
        fail(f"cannot persist {path}: {error}")
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def validate_parent(path: Path, label: str) -> None:
    try:
        resolved = path.resolve(strict=True)
        metadata = path.lstat()
    except OSError as error:
        fail(f"{label} parent is unavailable: {error}")
    uid, gid = expected_owner()
    if (
        resolved != path
        or not stat.S_ISDIR(metadata.st_mode)
        or metadata.st_uid != uid
        or metadata.st_gid != gid
        or (stat.S_IMODE(metadata.st_mode) & 0o022) != 0
    ):
        fail(f"{label} parent is outside the trusted boundary")


def validate_directory(
    path: Path,
    *,
    label: str,
    uid: int | None = None,
    gid: int | None = None,
    mode: int | None = None,
    dev: int | None = None,
    ino: int | None = None,
) -> os.stat_result:
    try:
        metadata = path.lstat()
        resolved = path.resolve(strict=True)
    except OSError as error:
        fail(f"{label} is unavailable: {error}")
    if (
        resolved != path
        or stat.S_ISLNK(metadata.st_mode)
        or not stat.S_ISDIR(metadata.st_mode)
        or (uid is not None and metadata.st_uid != uid)
        or (gid is not None and metadata.st_gid != gid)
        or (mode is not None and stat.S_IMODE(metadata.st_mode) != mode)
        or (dev is not None and metadata.st_dev != dev)
        or (ino is not None and metadata.st_ino != ino)
    ):
        fail(f"{label} differs from its transaction binding")
    return metadata


def directory_is_empty(path: Path) -> bool:
    try:
        descriptor = os.open(
            path,
            os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_NOFOLLOW", 0),
        )
        try:
            with os.scandir(descriptor) as entries:
                return next(entries, None) is None
        finally:
            os.close(descriptor)
    except OSError as error:
        fail(f"cannot inspect directory contents for {path}: {error}")


def validate_creating_directory(
    path: Path,
    entry: dict[str, Any],
    *,
    label: str,
) -> os.stat_result:
    metadata = validate_directory(path, label=label)
    observed_owner = (metadata.st_uid, metadata.st_gid)
    desired_owner = (entry["desiredUid"], entry["desiredGid"])
    bootstrap_owner = expected_owner()
    desired_mode = int(entry["desiredMode"], 8)
    observed_mode = stat.S_IMODE(metadata.st_mode)
    if (
        observed_owner not in {bootstrap_owner, desired_owner}
        or observed_mode not in {0o700, desired_mode}
    ):
        fail(f"{label} differs from its bounded creation state")
    return metadata


def validate_control_root() -> None:
    root = boundary_path(PRODUCTION_CONTROL_ROOT)
    uid, gid = expected_owner()
    validate_directory(
        root,
        label="Sonar install control root",
        uid=uid,
        gid=gid,
        mode=0o700,
    )
    validate_parent(root.parent, "Sonar install control root")


def validate_regular(
    path: Path,
    *,
    label: str,
    digest: str | None = None,
    uid: int | None = None,
    gid: int | None = None,
    mode: int | None = None,
    single_link: bool = False,
    validate_trusted_parent: bool = True,
) -> os.stat_result:
    if validate_trusted_parent:
        validate_parent(path.parent, label)
    try:
        metadata = path.lstat()
    except OSError as error:
        fail(f"{label} is unavailable: {error}")
    if (
        stat.S_ISLNK(metadata.st_mode)
        or not stat.S_ISREG(metadata.st_mode)
        or (single_link and metadata.st_nlink != 1)
        or (uid is not None and metadata.st_uid != uid)
        or (gid is not None and metadata.st_gid != gid)
        or (mode is not None and stat.S_IMODE(metadata.st_mode) != mode)
        or (digest is not None and sha256_file(path) != digest)
    ):
        fail(f"{label} differs from its transaction binding")
    return metadata


def repair_exclusive_link_window(path: Path, label: str) -> None:
    """Normalize the bounded link-before-unlink window used by O_EXCL writes."""
    try:
        metadata = path.lstat()
    except OSError as error:
        fail(f"{label} is unavailable: {error}")
    if metadata.st_nlink == 1:
        return
    if metadata.st_nlink != 2:
        fail(f"{label} has an unsafe hard-link count")
    expected_prefix = f".{path.name}."
    siblings: list[Path] = []
    try:
        for candidate in path.parent.iterdir():
            if candidate == path:
                continue
            candidate_metadata = candidate.lstat()
            if (
                candidate_metadata.st_dev == metadata.st_dev
                and candidate_metadata.st_ino == metadata.st_ino
            ):
                siblings.append(candidate)
    except OSError as error:
        fail(f"cannot inspect {label} link state: {error}")
    if (
        len(siblings) != 1
        or not siblings[0].name.startswith(expected_prefix)
        or not siblings[0].name.endswith(".tmp")
    ):
        fail(f"{label} has an unrecognized hard link")
    remove_durable(siblings[0])
    try:
        normalized = path.lstat()
    except OSError as error:
        fail(f"cannot recheck normalized {label}: {error}")
    if (
        normalized.st_dev != metadata.st_dev
        or normalized.st_ino != metadata.st_ino
        or normalized.st_nlink != 1
    ):
        fail(f"{label} hard-link normalization was not exact")


def read_private_json(
    path: Path,
    label: str,
    *,
    repair_exclusive_link: bool = False,
) -> dict[str, Any]:
    uid, gid = expected_owner()
    if repair_exclusive_link:
        repair_exclusive_link_window(path, label)
    validate_regular(
        path,
        label=label,
        uid=uid,
        gid=gid,
        mode=0o600,
        single_link=True,
    )
    try:
        descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        try:
            before = os.fstat(descriptor)
            chunks: list[bytes] = []
            size = 0
            while chunk := os.read(descriptor, 64 * 1024):
                size += len(chunk)
                if size > MAX_BYTES:
                    fail(f"{label} exceeds its size bound")
                chunks.append(chunk)
            after = os.fstat(descriptor)
        finally:
            os.close(descriptor)
    except OSError as error:
        fail(f"{label} is unreadable: {error}")
    if (
        before.st_dev != after.st_dev
        or before.st_ino != after.st_ino
        or before.st_size != after.st_size
        or before.st_mtime_ns != after.st_mtime_ns
    ):
        fail(f"{label} changed while reading")
    body = b"".join(chunks)
    if not body:
        fail(f"{label} is empty")
    try:
        value = json.loads(body)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        fail(f"{label} is invalid JSON: {error}")
    if not isinstance(value, dict):
        fail(f"{label} must be a JSON object")
    return value


def nullable_integer(value: Any) -> bool:
    return value is None or (
        isinstance(value, int) and not isinstance(value, bool) and value >= 0
    )


def validate_directory_entry(entry: Any, expected_index: int) -> None:
    required = {
        "index",
        "path",
        "desiredUid",
        "desiredGid",
        "desiredMode",
        "hadDirectory",
        "predecessorUid",
        "predecessorGid",
        "predecessorMode",
        "predecessorDev",
        "predecessorIno",
        "state",
        "createdDev",
        "createdIno",
    }
    allowed = allowed_directories()
    if not isinstance(entry, dict) or set(entry) != required:
        fail("directory install journal entry shape is invalid")
    path = Path(str(entry["path"]))
    had_directory = entry["hadDirectory"]
    if (
        entry["index"] != expected_index
        or expected_index >= len(allowed)
        or str(path) != allowed[expected_index]
        or not path.is_absolute()
        or not isinstance(entry["desiredUid"], int)
        or isinstance(entry["desiredUid"], bool)
        or entry["desiredUid"] < 0
        or not isinstance(entry["desiredGid"], int)
        or isinstance(entry["desiredGid"], bool)
        or entry["desiredGid"] < 0
        or entry["desiredMode"] not in {"0700", "0750", "0755"}
        or not isinstance(had_directory, bool)
        or entry["state"]
        not in {"planned", "creating", "preserved", "created", "recovered"}
    ):
        fail("directory install journal entry binding is invalid")
    predecessor = (
        entry["predecessorUid"],
        entry["predecessorGid"],
        entry["predecessorMode"],
        entry["predecessorDev"],
        entry["predecessorIno"],
    )
    if had_directory:
        if (
            any(
                not isinstance(value, int) or isinstance(value, bool) or value < 0
                for value in (
                    entry["predecessorUid"],
                    entry["predecessorGid"],
                    entry["predecessorDev"],
                    entry["predecessorIno"],
                )
            )
            or entry["predecessorMode"] not in {"0700", "0750", "0755"}
            or entry["predecessorUid"] != entry["desiredUid"]
            or entry["predecessorGid"] != entry["desiredGid"]
            or entry["predecessorMode"] != entry["desiredMode"]
            or entry["state"] in {"creating", "created"}
            or entry["createdDev"] is not None
            or entry["createdIno"] is not None
        ):
            fail("directory predecessor binding is invalid")
    elif any(value is not None for value in predecessor):
        fail("absent directory predecessor has unexpected metadata")
    if not had_directory:
        if entry["state"] == "preserved":
            fail("absent directory predecessor cannot be preserved")
        if entry["state"] == "created":
            if (
                not isinstance(entry["createdDev"], int)
                or isinstance(entry["createdDev"], bool)
                or entry["createdDev"] < 0
                or not isinstance(entry["createdIno"], int)
                or isinstance(entry["createdIno"], bool)
                or entry["createdIno"] < 0
            ):
                fail("created directory identity is invalid")
        elif entry["state"] == "recovered":
            if not (
                (entry["createdDev"] is None and entry["createdIno"] is None)
                or (
                    isinstance(entry["createdDev"], int)
                    and not isinstance(entry["createdDev"], bool)
                    and entry["createdDev"] >= 0
                    and isinstance(entry["createdIno"], int)
                    and not isinstance(entry["createdIno"], bool)
                    and entry["createdIno"] >= 0
                )
            ):
                fail("recovered directory identity is invalid")
        elif entry["createdDev"] is not None or entry["createdIno"] is not None:
            fail("uncreated directory unexpectedly binds an identity")


def directory_plan_digest(entries: list[dict[str, Any]]) -> str:
    return sha256_bytes(canonical_json(entries))


def parse_directory_plan(path: Path) -> list[dict[str, Any]]:
    uid, gid = expected_owner()
    validate_regular(
        path,
        label="directory install plan",
        uid=uid,
        gid=gid,
        mode=0o600,
        single_link=True,
    )
    if path.parent != boundary_path(PRODUCTION_CONTROL_ROOT):
        fail("directory install plan is outside the control root")
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError as error:
        fail(f"directory install plan is unreadable: {error}")
    entries: list[dict[str, Any]] = []
    for expected_index, line in enumerate(lines):
        columns = line.split("\t")
        if len(columns) != 11:
            fail("directory install plan row shape is invalid")
        (
            raw_index,
            raw_path,
            desired_uid,
            desired_gid,
            desired_mode,
            had_directory,
            predecessor_uid,
            predecessor_gid,
            predecessor_mode,
            predecessor_dev,
            predecessor_ino,
        ) = columns

        def parsed_optional_integer(value: str) -> int | None:
            if value == "-":
                return None
            return int(value) if value.isdigit() else -1

        entry = {
            "index": int(raw_index) if raw_index.isdigit() else -1,
            "path": raw_path,
            "desiredUid": int(desired_uid) if desired_uid.isdigit() else -1,
            "desiredGid": int(desired_gid) if desired_gid.isdigit() else -1,
            "desiredMode": desired_mode,
            "hadDirectory": had_directory == "true",
            "predecessorUid": parsed_optional_integer(predecessor_uid),
            "predecessorGid": parsed_optional_integer(predecessor_gid),
            "predecessorMode": (
                None if predecessor_mode == "-" else predecessor_mode
            ),
            "predecessorDev": parsed_optional_integer(predecessor_dev),
            "predecessorIno": parsed_optional_integer(predecessor_ino),
            "state": "planned",
            "createdDev": None,
            "createdIno": None,
        }
        if had_directory not in {"true", "false"}:
            fail("directory install plan predecessor flag is invalid")
        validate_directory_entry(entry, expected_index)
        path_value = Path(raw_path)
        if entry["hadDirectory"]:
            validate_directory(
                path_value,
                label=f"directory predecessor {path_value}",
                uid=entry["predecessorUid"],
                gid=entry["predecessorGid"],
                mode=int(str(entry["predecessorMode"]), 8),
                dev=entry["predecessorDev"],
                ino=entry["predecessorIno"],
            )
        elif path_value.exists() or path_value.is_symlink():
            fail(f"absent directory predecessor appeared before intent: {path_value}")
        entries.append(entry)
    if tuple(entry["path"] for entry in entries) != allowed_directories():
        fail("directory install plan does not bind the exact ordered path set")
    return entries


def validate_directory_journal(value: dict[str, Any], path: Path) -> None:
    required = {
        "schema",
        "status",
        "phase",
        "startedAt",
        "updatedAt",
        "installTransactionId",
        "sourceSha",
        "archiveSha256",
        "recoveryProgram",
        "recoveryProgramSha256",
        "usernsMapSha256",
        "planSha256",
        "planPath",
        "directories",
        "recoveredIndices",
    }
    directories = value.get("directories")
    recovered = value.get("recoveredIndices")
    if (
        set(value) != required
        or value.get("schema") != DIRECTORY_SCHEMA
        or value.get("status") != "in_progress"
        or not isinstance(value.get("phase"), str)
        or not SHA256.fullmatch(str(value.get("installTransactionId", "")))
        or not SOURCE_SHA.fullmatch(str(value.get("sourceSha", "")))
        or not SHA256.fullmatch(str(value.get("archiveSha256", "")))
        or Path(str(value.get("recoveryProgram", "")))
        != boundary_path(PRODUCTION_PROGRAM)
        or not SHA256.fullmatch(str(value.get("recoveryProgramSha256", "")))
        or not SHA256.fullmatch(str(value.get("usernsMapSha256", "")))
        or not SHA256.fullmatch(str(value.get("planSha256", "")))
        or Path(str(value.get("planPath", ""))).parent
        != boundary_path(PRODUCTION_CONTROL_ROOT)
        or not isinstance(directories, list)
        or len(directories) != len(allowed_directories())
        or not isinstance(recovered, list)
    ):
        fail("directory install journal control binding is invalid")
    for index, entry in enumerate(directories):
        validate_directory_entry(entry, index)
    if value["planSha256"] != directory_plan_digest([
        {
            **entry,
            "state": "planned",
            "createdDev": None,
            "createdIno": None,
        }
        for entry in directories
    ]):
        fail("directory install journal plan digest is invalid")
    if (
        any(
            isinstance(index, bool)
            or not isinstance(index, int)
            or index < 0
            or index >= len(directories)
            for index in recovered
        )
        or len(set(recovered)) != len(recovered)
    ):
        fail("directory recovery checkpoints are invalid")


def load_directory_journal(path: Path) -> dict[str, Any]:
    value = read_private_json(
        path,
        "directory install journal",
        repair_exclusive_link=True,
    )
    validate_directory_journal(value, path)
    return value


def validate_asset(asset: Any, expected_index: int) -> None:
    required = {
        "index",
        "kind",
        "target",
        "stage",
        "backup",
        "hadTarget",
        "desiredSha256",
        "desiredUid",
        "desiredGid",
        "desiredMode",
        "predecessorSha256",
        "predecessorUid",
        "predecessorGid",
        "predecessorMode",
    }
    if not isinstance(asset, dict) or set(asset) != required:
        fail("install journal asset shape is invalid")
    target = Path(str(asset["target"]))
    stage = Path(str(asset["stage"]))
    backup_raw = asset["backup"]
    backup = Path(backup_raw) if isinstance(backup_raw, str) else None
    had_target = asset["hadTarget"]
    owner_uid, owner_gid = expected_owner()
    if (
        asset["index"] != expected_index
        or asset["kind"] not in {"layout", "receipt"}
        or str(target) not in allowed_targets()
        or not target.is_absolute()
        or stage.parent != target.parent
        or not stage.name.startswith(".nexus-sonarqube.stage.")
        or (
            backup is not None
            and (
                backup.parent != target.parent
                or not backup.name.startswith(".nexus-sonarqube.backup.")
            )
        )
        or not isinstance(had_target, bool)
        or had_target != (backup is not None)
        or not SHA256.fullmatch(str(asset["desiredSha256"]))
        or not nullable_integer(asset["desiredUid"])
        or not nullable_integer(asset["desiredGid"])
        or asset["desiredUid"] != owner_uid
        or asset["desiredGid"] != owner_gid
        or asset["desiredMode"] not in ALLOWED_MODES
    ):
        fail("install journal asset binding is invalid")
    predecessor_values = (
        asset["predecessorSha256"],
        asset["predecessorUid"],
        asset["predecessorGid"],
        asset["predecessorMode"],
    )
    if had_target:
        if (
            not SHA256.fullmatch(str(predecessor_values[0]))
            or not nullable_integer(predecessor_values[1])
            or not nullable_integer(predecessor_values[2])
            or predecessor_values[1] != owner_uid
            or predecessor_values[2] != owner_gid
            or predecessor_values[3] not in ALLOWED_MODES
        ):
            fail("install journal predecessor binding is invalid")
    elif any(value is not None for value in predecessor_values):
        fail("install journal binds a predecessor for an absent target")
    if asset["kind"] == "receipt":
        if (
            target != boundary_path(INSTALL_RECEIPT)
            or expected_index < 1
            or asset["desiredMode"] != "0600"
        ):
            fail("install journal receipt binding is invalid")
    elif target == boundary_path(INSTALL_RECEIPT):
        fail("install receipt is not marked as a receipt")


def validate_journal(value: dict[str, Any], path: Path) -> None:
    required = {
        "schema",
        "status",
        "phase",
        "startedAt",
        "updatedAt",
        "installTransactionId",
        "sourceSha",
        "archiveSha256",
        "recoveryProgram",
        "recoveryProgramSha256",
        "transactionDirectory",
        "layoutAssetCount",
        "assets",
        "committedIndices",
    }
    assets = value.get("assets")
    committed = value.get("committedIndices")
    transaction = Path(str(value.get("transactionDirectory", "")))
    if (
        set(value) != required
        or value.get("schema") != SCHEMA
        or value.get("status") != "in_progress"
        or not isinstance(value.get("phase"), str)
        or not SHA256.fullmatch(str(value.get("installTransactionId", "")))
        or not SOURCE_SHA.fullmatch(str(value.get("sourceSha", "")))
        or not SHA256.fullmatch(str(value.get("archiveSha256", "")))
        or Path(str(value.get("recoveryProgram", "")))
        != boundary_path(PRODUCTION_PROGRAM)
        or not SHA256.fullmatch(str(value.get("recoveryProgramSha256", "")))
        or transaction.parent != path.parent
        or not transaction.name.startswith(".install-transaction.v2.")
        or not isinstance(assets, list)
        or not 2 <= len(assets) <= 64
        or value.get("layoutAssetCount") != len(assets) - 1
        or not isinstance(committed, list)
    ):
        fail("install journal control binding is invalid")
    for index, asset in enumerate(assets):
        validate_asset(asset, index)
    if assets[-1]["kind"] != "receipt":
        fail("install receipt must be the final journal asset")
    observed_targets = [asset["target"] for asset in assets]
    expected_targets = allowed_targets()
    if not test_mode() and set(observed_targets) != expected_targets:
        fail("install journal does not bind the exact target set")
    if test_mode() and (
        len(set(observed_targets)) != len(observed_targets)
        or any(not str(target).startswith(f"{test_root()}/") for target in observed_targets)
    ):
        fail("test install journal escapes its bounded root")
    stages = [asset["stage"] for asset in assets]
    backups = [
        asset["backup"] for asset in assets if asset["backup"] is not None
    ]
    if (
        len(set(observed_targets)) != len(observed_targets)
        or len(set(stages)) != len(stages)
        or len(set(backups)) != len(backups)
        or set(observed_targets) & set(stages)
        or set(observed_targets) & set(backups)
        or set(stages) & set(backups)
    ):
        fail("install journal paths are not distinct")
    if (
        any(
            isinstance(index, bool)
            or not isinstance(index, int)
            or index < 0
            or index >= len(assets)
            for index in committed
        )
        or len(set(committed)) != len(committed)
    ):
        fail("install journal commit checkpoints are invalid")


def load_journal(path: Path) -> dict[str, Any]:
    value = read_private_json(
        path,
        "install journal",
        repair_exclusive_link=True,
    )
    validate_journal(value, path)
    return value


def validate_operation_paths(
    journal: Path,
    program: Path,
    *,
    receipt: Path | None = None,
    lock: Path | None = None,
) -> None:
    if (
        journal != boundary_path(PRODUCTION_JOURNAL)
        or program != boundary_path(PRODUCTION_PROGRAM)
        or (
            receipt is not None
            and receipt != boundary_path(PRODUCTION_RECOVERY_RECEIPT)
        )
        or (lock is not None and lock != boundary_path(PRODUCTION_LOCK))
    ):
        fail("operation paths are outside the exact Sonar install boundary")


def parse_plan(path: Path) -> list[dict[str, Any]]:
    uid, gid = expected_owner()
    validate_regular(
        path,
        label="install plan",
        uid=uid,
        gid=gid,
        mode=0o600,
        single_link=True,
    )
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError as error:
        fail(f"install plan is unreadable: {error}")
    entries: list[dict[str, Any]] = []
    for expected_index, line in enumerate(lines):
        columns = line.split("\t")
        if len(columns) != 14:
            fail("install plan row shape is invalid")
        (
            raw_index,
            kind,
            target,
            stage,
            backup,
            had_target,
            desired_sha,
            desired_uid,
            desired_gid,
            desired_mode,
            predecessor_sha,
            predecessor_uid,
            predecessor_gid,
            predecessor_mode,
        ) = columns
        predecessor_uid_value = (
            None
            if predecessor_uid == "-"
            else int(predecessor_uid)
            if predecessor_uid.isdigit()
            else -1
        )
        predecessor_gid_value = (
            None
            if predecessor_gid == "-"
            else int(predecessor_gid)
            if predecessor_gid.isdigit()
            else -1
        )
        entry = {
            "index": int(raw_index) if raw_index.isdigit() else -1,
            "kind": kind,
            "target": target,
            "stage": stage,
            "backup": None if backup == "-" else backup,
            "hadTarget": had_target == "true",
            "desiredSha256": desired_sha,
            "desiredUid": int(desired_uid) if desired_uid.isdigit() else -1,
            "desiredGid": int(desired_gid) if desired_gid.isdigit() else -1,
            "desiredMode": desired_mode,
            "predecessorSha256": (
                None if predecessor_sha == "-" else predecessor_sha
            ),
            "predecessorUid": predecessor_uid_value,
            "predecessorGid": predecessor_gid_value,
            "predecessorMode": (
                None if predecessor_mode == "-" else predecessor_mode
            ),
        }
        if had_target not in {"true", "false"}:
            fail("install plan had-target value is invalid")
        validate_asset(entry, expected_index)
        validate_regular(
            Path(stage),
            label=f"staged asset {target}",
            digest=desired_sha,
            uid=int(desired_uid),
            gid=int(desired_gid),
            mode=int(desired_mode, 8),
            single_link=True,
        )
        if entry["hadTarget"]:
            validate_regular(
                Path(str(entry["backup"])),
                label=f"predecessor backup {target}",
                digest=str(entry["predecessorSha256"]),
                uid=int(str(entry["predecessorUid"])),
                gid=int(str(entry["predecessorGid"])),
                mode=int(str(entry["predecessorMode"]), 8),
            )
        entries.append(entry)
    if not entries:
        fail("install plan is empty")
    return entries


def validate_install_receipt(
    asset: dict[str, Any],
    layout_assets: list[dict[str, Any]],
    *,
    source_sha: str,
    archive_sha256: str,
) -> None:
    value = read_private_json(Path(asset["stage"]), "staged install receipt")
    required = {
        "schema",
        "status",
        "sourceSha",
        "archiveSha256",
        "installedAssets",
        "assets",
        "preservedDependencies",
        "configurationWritten",
        "dockerTouched",
        "servicesEnabled",
        "installRecoveryServiceEnabled",
        "applicationDataWritten",
        "installedAt",
    }
    if (
        set(value) != required
        or value["schema"] != "nexus.sonarqube-asset-install.v1"
        or value["status"] != "complete"
        or value["sourceSha"] != source_sha
        or value["archiveSha256"] != archive_sha256
        or value["installedAssets"] != len(layout_assets)
        or value["configurationWritten"] is not False
        or value["dockerTouched"] is not False
        or value["servicesEnabled"] is not False
        or value["installRecoveryServiceEnabled"] is not True
        or value["applicationDataWritten"] is not False
        or not isinstance(value["installedAt"], str)
        or not isinstance(value["assets"], list)
        or len(value["assets"]) != len(layout_assets)
        or not isinstance(value["preservedDependencies"], list)
        or len(value["preservedDependencies"]) != 1
    ):
        fail("staged install receipt contract is invalid")
    for recorded, planned in zip(value["assets"], layout_assets, strict=True):
        if (
            not isinstance(recorded, dict)
            or set(recorded) != {"target", "sha256", "owner", "mode"}
            or recorded["target"] != planned["target"]
            or recorded["sha256"] != planned["desiredSha256"]
            or recorded["owner"] != "root:root"
            or recorded["mode"] != planned["desiredMode"]
        ):
            fail("staged install receipt asset binding is invalid")
    dependency = value["preservedDependencies"][0]
    dependency_target = boundary_path(ANCHOR_TARGETS["lockConfig"])
    dependency_uid, dependency_gid = expected_owner()
    if (
        not isinstance(dependency, dict)
        or set(dependency)
        != {
            "name",
            "target",
            "sha256",
            "uid",
            "gid",
            "mode",
            "dev",
            "ino",
            "nlink",
        }
        or dependency.get("name") != "releaseSonarLockConfig"
        or dependency.get("target") != str(dependency_target)
        or dependency.get("uid") != dependency_uid
        or dependency.get("gid") != dependency_gid
        or dependency.get("mode") != "0644"
        or dependency.get("nlink") != 1
    ):
        fail("staged install receipt preserved dependency is invalid")
    validate_anchor_identity(
        dependency_target,
        {
            field: dependency[field]
            for field in ("sha256", "uid", "gid", "mode", "dev", "ino", "nlink")
        },
        label="staged install receipt preserved shared-lock dependency",
    )


def validate_program(journal: dict[str, Any], program: Path) -> None:
    uid, gid = expected_owner()
    validate_regular(
        program,
        label="retained install recovery program",
        digest=str(journal["recoveryProgramSha256"]),
        uid=uid,
        gid=gid,
        mode=0o600,
        single_link=True,
    )
    try:
        running = Path(__file__).resolve(strict=True)
    except OSError as error:
        fail(f"cannot resolve running recovery program: {error}")
    if running != program or journal["recoveryProgram"] != str(program):
        fail("running recovery program differs from the journal binding")


def checkpoint(
    path: Path,
    journal: dict[str, Any],
    phase: str,
    *,
    committed_index: int | None = None,
) -> dict[str, Any]:
    updated = dict(journal)
    updated["phase"] = phase
    updated["updatedAt"] = utc_now()
    if committed_index is not None:
        if (
            committed_index < 0
            or committed_index >= len(updated["assets"])
            or committed_index in updated["committedIndices"]
        ):
            fail("commit checkpoint is outside the exact remaining asset set")
        asset = updated["assets"][committed_index]
        validate_regular(
            Path(asset["target"]),
            label=f"committed target {asset['target']}",
            digest=asset["desiredSha256"],
            uid=asset["desiredUid"],
            gid=asset["desiredGid"],
            mode=int(asset["desiredMode"], 8),
            single_link=True,
        )
        updated["committedIndices"] = [
            *updated["committedIndices"],
            committed_index,
        ]
    validate_journal(updated, path)
    atomic_write(path, updated, exclusive=False)
    return updated


def remove_durable(path: Path) -> None:
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        return
    except OSError as error:
        fail(f"cannot inspect removable path {path}: {error}")
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
        fail(f"refusing to remove unsafe transaction path {path}")
    try:
        path.unlink()
    except OSError as error:
        fail(f"cannot remove transaction path {path}: {error}")
    fsync_directory(path.parent)


def current_digest(path: Path) -> str | None:
    try:
        path.lstat()
    except FileNotFoundError:
        return None
    return sha256_file(path)


def validate_recovery_state(asset: dict[str, Any]) -> None:
    target = Path(asset["target"])
    stage = Path(asset["stage"])
    backup = Path(asset["backup"]) if asset["backup"] else None
    desired = asset["desiredSha256"]
    predecessor = asset["predecessorSha256"]
    if stage.exists() or stage.is_symlink():
        validate_regular(
            stage,
            label=f"staged recovery asset {target}",
            digest=desired,
            uid=asset["desiredUid"],
            gid=asset["desiredGid"],
            mode=int(asset["desiredMode"], 8),
            single_link=True,
        )
    target_sha = current_digest(target)
    if asset["hadTarget"]:
        if backup is not None and (backup.exists() or backup.is_symlink()):
            validate_regular(
                backup,
                label=f"recovery predecessor {target}",
                digest=predecessor,
                uid=asset["predecessorUid"],
                gid=asset["predecessorGid"],
                mode=int(asset["predecessorMode"], 8),
            )
        elif target_sha != predecessor:
            fail(f"predecessor for {target} is unavailable")
        if target_sha not in {None, desired, predecessor}:
            fail(f"current target {target} is outside its recovery states")
    else:
        if backup is not None:
            fail(f"absent predecessor for {target} unexpectedly has a backup")
        if target_sha not in {None, desired}:
            fail(f"new target {target} is outside its recovery states")


def restore_asset(asset: dict[str, Any]) -> None:
    target = Path(asset["target"])
    stage = Path(asset["stage"])
    backup = Path(asset["backup"]) if asset["backup"] else None
    desired = asset["desiredSha256"]
    predecessor = asset["predecessorSha256"]
    if asset["hadTarget"]:
        if backup is not None and (backup.exists() or backup.is_symlink()):
            validate_regular(
                backup,
                label=f"recovery predecessor {target}",
                digest=predecessor,
                uid=asset["predecessorUid"],
                gid=asset["predecessorGid"],
                mode=int(asset["predecessorMode"], 8),
            )
            target_sha = current_digest(target)
            if target_sha == predecessor:
                remove_durable(backup)
            elif target_sha in {None, desired}:
                try:
                    os.replace(backup, target)
                except OSError as error:
                    fail(f"cannot restore predecessor for {target}: {error}")
                fsync_directory(target.parent)
            else:
                fail(f"cannot restore unexpected current target {target}")
        validate_regular(
            target,
            label=f"restored predecessor {target}",
            digest=predecessor,
            uid=asset["predecessorUid"],
            gid=asset["predecessorGid"],
            mode=int(asset["predecessorMode"], 8),
        )
    else:
        target_sha = current_digest(target)
        if target_sha is not None:
            if target_sha != desired:
                fail(f"refusing to remove unexpected current target {target}")
            remove_durable(target)
    if stage.exists() or stage.is_symlink():
        validate_regular(
            stage,
            label=f"staged recovery asset {target}",
            digest=desired,
            uid=asset["desiredUid"],
            gid=asset["desiredGid"],
            mode=int(asset["desiredMode"], 8),
            single_link=True,
        )
        remove_durable(stage)


def systemctl_executable() -> str:
    if test_mode():
        value = os.environ.get("NEXUS_SONAR_INSTALL_TEST_SYSTEMCTL", "")
        if not value or not Path(value).is_absolute():
            fail("test systemctl must be an explicit absolute path")
        return value
    return "/usr/bin/systemctl"


def systemd_analyze_executable() -> str:
    if test_mode():
        value = os.environ.get("NEXUS_SONAR_INSTALL_TEST_SYSTEMD_ANALYZE", "")
        if not value or not Path(value).is_absolute():
            fail("test systemd-analyze must be an explicit absolute path")
        return value
    return "/usr/bin/systemd-analyze"


def systemd_tmpfiles_executable() -> str:
    if test_mode():
        value = os.environ.get("NEXUS_SONAR_INSTALL_TEST_TMPFILES", "")
        if not value or not Path(value).is_absolute():
            fail("test systemd-tmpfiles must be an explicit absolute path")
        return value
    return "/usr/bin/systemd-tmpfiles"


def run_systemctl(
    arguments: list[str],
    *,
    check: bool = True,
    capture: bool = False,
) -> subprocess.CompletedProcess[bytes]:
    try:
        result = subprocess.run(
            [systemctl_executable(), *arguments],
            check=False,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=60,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        fail(f"systemctl {' '.join(arguments)} did not complete: {error}")
    if check and result.returncode != 0:
        fail(f"systemctl {' '.join(arguments)} failed")
    return result


def query_unit_state(operation: str, unit: str) -> dict[str, Any]:
    result = run_systemctl([operation, unit], check=False, capture=True)
    try:
        state_value = result.stdout.decode("ascii", errors="strict").strip()
    except UnicodeDecodeError:
        fail(f"systemctl {operation} returned non-ASCII state for {unit}")
    if not state_value:
        fail(f"systemctl {operation} returned an empty state for {unit}")
    return {"state": state_value, "returnCode": result.returncode}


def run_bounded_command(
    executable: str,
    arguments: list[str],
    *,
    label: str,
) -> None:
    try:
        result = subprocess.run(
            [executable, *arguments],
            check=False,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=60,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        fail(f"{label} did not complete: {error}")
    if result.returncode != 0:
        fail(f"{label} failed")


def assert_runtime_units_inactive_disabled() -> None:
    for unit in RUNTIME_UNITS:
        active = query_unit_state("is-active", unit)
        if (active["state"], active["returnCode"]) not in {
            ("inactive", 3),
            ("failed", 3),
            ("unknown", 4),
            ("not-found", 4),
        }:
            fail(f"cannot prove runtime unit is inactive: {unit}")
        enabled = query_unit_state("is-enabled", unit)
        allowed = (
            {
                ("static", 0),
                ("disabled", 1),
                ("not-found", 1),
                ("not-found", 4),
            }
            if unit == "nexus-sonarqube-backup.service"
            else {
                ("disabled", 1),
                ("not-found", 1),
                ("not-found", 4),
            }
        )
        if (enabled["state"], enabled["returnCode"]) not in allowed:
            fail(f"cannot prove runtime unit is disabled: {unit}")


def assert_systemd_safe() -> None:
    run_systemctl(["daemon-reload"])
    for unit in RUNTIME_UNITS:
        active = run_systemctl(["is-active", unit], check=False, capture=True)
        try:
            active_state = active.stdout.decode("ascii", errors="strict").strip()
        except UnicodeDecodeError:
            fail(f"systemctl is-active returned non-ASCII state for {unit}")
        if (active_state, active.returncode) not in {
            ("inactive", 3),
            ("failed", 3),
            ("unknown", 4),
            ("not-found", 4),
        }:
            fail(f"cannot prove runtime unit is inactive after recovery: {unit}")
        enabled = run_systemctl(["is-enabled", unit], check=False, capture=True)
        try:
            enabled_state = enabled.stdout.decode("ascii", errors="strict").strip()
        except UnicodeDecodeError:
            fail(f"systemctl is-enabled returned non-ASCII state for {unit}")
        allowed = (
            {
                ("static", 0),
                ("disabled", 1),
                ("not-found", 1),
                ("not-found", 4),
            }
            if unit.endswith(".service") and unit.endswith("backup.service")
            else {
                ("disabled", 1),
                ("not-found", 1),
                ("not-found", 4),
            }
        )
        if (enabled_state, enabled.returncode) not in allowed:
            fail(f"cannot prove runtime unit is disabled after recovery: {unit}")
    recovery = run_systemctl(
        ["is-enabled", RECOVERY_SERVICE],
        check=False,
        capture=True,
    )
    try:
        recovery_state = recovery.stdout.decode("ascii", errors="strict").strip()
    except UnicodeDecodeError:
        fail("systemctl returned non-ASCII recovery-service state")
    if (recovery_state, recovery.returncode) != ("enabled", 0):
        fail("Sonar install recovery service is not durably enabled")


def acquire_lock(path: Path):
    expected_lock_parent = boundary_path(PRODUCTION_LOCK).parent
    try:
        parent_metadata = path.parent.lstat()
        parent_resolved = path.parent.resolve(strict=True)
    except OSError as error:
        fail(f"shared lock parent is unavailable: {error}")
    owner_uid, owner_gid = expected_owner()
    parent_mode = stat.S_IMODE(parent_metadata.st_mode)
    allowed_parent_modes = (
        {0o755, 0o775, 0o1777}
        if not test_mode()
        else {0o700, 0o750, 0o755}
    )
    if (
        path.parent != expected_lock_parent
        or parent_resolved != path.parent
        or not stat.S_ISDIR(parent_metadata.st_mode)
        or parent_metadata.st_uid != owner_uid
        or parent_metadata.st_gid != owner_gid
        or parent_mode not in allowed_parent_modes
    ):
        fail("shared release/Sonar lock parent is outside its exact boundary")
    if not test_mode():
        try:
            expected_gid = grp.getgrnam("dominguez").gr_gid
        except KeyError:
            fail("dominguez group is unavailable for the shared lock")
        validate_regular(
            path,
            label="shared release/Sonar lock",
            uid=0,
            gid=expected_gid,
            mode=0o660,
            single_link=True,
            validate_trusted_parent=False,
        )
    else:
        uid, gid = expected_owner()
        validate_regular(
            path,
            label="test shared release/Sonar lock",
            uid=uid,
            gid=gid,
            mode=0o600,
            single_link=True,
            validate_trusted_parent=False,
        )
    descriptor = os.open(
        path,
        os.O_RDWR | getattr(os, "O_NOFOLLOW", 0),
    )
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError as error:
        os.close(descriptor)
        fail(f"could not acquire shared release/Sonar lock: {error}")
    return descriptor


def atomic_install_file(
    source: Path,
    target: Path,
    *,
    uid: int,
    gid: int,
    mode: int,
) -> os.stat_result:
    validate_regular(source, label=f"anchor source {source}", single_link=True)
    validate_parent(target.parent, f"anchor target {target}")
    temporary = target.parent / f".nexus-sonarqube.anchor.{os.getpid()}.{target.name}"
    descriptor = -1
    try:
        descriptor = os.open(
            temporary,
            os.O_WRONLY
            | os.O_CREAT
            | os.O_EXCL
            | getattr(os, "O_NOFOLLOW", 0),
            mode,
        )
        source_descriptor = os.open(
            source,
            os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0),
        )
        try:
            while chunk := os.read(source_descriptor, 1024 * 1024):
                offset = 0
                while offset < len(chunk):
                    written = os.write(descriptor, chunk[offset:])
                    if written <= 0:
                        fail(f"cannot copy complete anchor source {source}")
                    offset += written
        finally:
            os.close(source_descriptor)
        os.fchown(descriptor, uid, gid)
        os.fchmod(descriptor, mode)
        os.fsync(descriptor)
        os.close(descriptor)
        descriptor = -1
        os.replace(temporary, target)
        fsync_directory(target.parent)
    except OSError as error:
        fail(f"cannot install recovery anchor {target}: {error}")
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass
    return validate_regular(
        target,
        label=f"installed recovery anchor {target}",
        digest=sha256_file(source),
        uid=uid,
        gid=gid,
        mode=mode,
        single_link=True,
    )


def atomic_install_bytes(
    body: bytes,
    target: Path,
    *,
    uid: int,
    gid: int,
    mode: int,
    label: str,
) -> os.stat_result:
    validate_parent(target.parent, label)
    if target.exists() or target.is_symlink():
        fail(f"refusing to overwrite existing {label}")
    temporary = target.parent / (
        f".nexus-sonarqube.unenroll.{os.getpid()}.{target.name}"
    )
    descriptor = -1
    try:
        descriptor = os.open(
            temporary,
            os.O_WRONLY
            | os.O_CREAT
            | os.O_EXCL
            | getattr(os, "O_NOFOLLOW", 0),
            mode,
        )
        offset = 0
        while offset < len(body):
            written = os.write(descriptor, body[offset:])
            if written <= 0:
                fail(f"cannot write complete {label}")
            offset += written
        os.fchown(descriptor, uid, gid)
        os.fchmod(descriptor, mode)
        os.fsync(descriptor)
        os.close(descriptor)
        descriptor = -1
        # The parent is root-owned and the shared release lock is held. The
        # preflight absence check plus atomic replacement leaves either the
        # old absence or the complete reviewed unit across a power loss.
        os.replace(temporary, target)
        fsync_directory(target.parent)
    except OSError as error:
        fail(f"cannot install {label}: {error}")
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass
    return validate_regular(
        target,
        label=label,
        digest=sha256_bytes(body),
        uid=uid,
        gid=gid,
        mode=mode,
        single_link=True,
    )


def bootstrap_control_root(args: argparse.Namespace) -> None:
    if (
        args.parent != boundary_path(PRODUCTION_CONTROL_PARENT)
        or args.root != boundary_path(PRODUCTION_CONTROL_ROOT)
        or args.intent
        != boundary_path(
            PRODUCTION_CONTROL_PARENT
            / "sonarqube-install-control-in-progress.v1.json"
        )
        or args.receipt
        != boundary_path(
            PRODUCTION_CONTROL_PARENT
            / "sonarqube-install-control.v1.json"
        )
    ):
        fail("control-root bootstrap paths are outside the exact boundary")
    owner_uid, owner_gid = expected_owner()
    validate_directory(
        args.parent,
        label="Sonar control-root parent",
        uid=owner_uid,
        gid=owner_gid,
        mode=0o755,
    )
    if args.receipt.exists() or args.receipt.is_symlink():
        receipt = read_private_json(args.receipt, "control-root receipt")
        if (
            set(receipt)
            != {
                "schema",
                "status",
                "sourceSha",
                "archiveSha256",
                "path",
                "createdFromAbsence",
                "predecessor",
                "directoryIdentity",
                "completedAt",
            }
            or receipt["schema"] != "nexus.sonarqube-install-control-root.v1"
            or receipt["status"] != "complete"
            or not SOURCE_SHA.fullmatch(str(receipt["sourceSha"]))
            or not SHA256.fullmatch(str(receipt["archiveSha256"]))
            or receipt["path"] != str(args.root)
        ):
            fail("control-root receipt binding is invalid")
        identity = receipt["directoryIdentity"]
        validate_directory(
            args.root,
            label="Sonar install control root",
            uid=identity["uid"],
            gid=identity["gid"],
            mode=int(identity["mode"], 8),
            dev=identity["dev"],
            ino=identity["ino"],
        )
        if args.intent.exists() or args.intent.is_symlink():
            intent = read_private_json(args.intent, "control-root intent")
            if (
                set(intent)
                != {
                    "schema",
                    "status",
                    "sourceSha",
                    "archiveSha256",
                    "path",
                    "createdFromAbsence",
                    "predecessor",
                }
                or intent["schema"]
                != "nexus.sonarqube-install-control-root-intent.v1"
                or intent["status"] != "in_progress"
                or intent["sourceSha"] != receipt["sourceSha"]
                or intent["archiveSha256"] != receipt["archiveSha256"]
                or intent["path"] != receipt["path"]
                or intent["createdFromAbsence"]
                != receipt["createdFromAbsence"]
                or intent["predecessor"] != receipt["predecessor"]
            ):
                fail("completed control-root receipt conflicts with its intent")
            remove_durable(args.intent)
        return
    if args.intent.exists() or args.intent.is_symlink():
        intent = read_private_json(args.intent, "control-root intent")
        if (
            set(intent)
            != {
                "schema",
                "status",
                "sourceSha",
                "archiveSha256",
                "path",
                "createdFromAbsence",
                "predecessor",
            }
            or intent["schema"]
            != "nexus.sonarqube-install-control-root-intent.v1"
            or intent["status"] != "in_progress"
            or intent["sourceSha"] != args.source_sha
            or intent["archiveSha256"] != args.archive_sha256
            or intent["path"] != str(args.root)
        ):
            fail("control-root intent binding is invalid")
    else:
        if args.root.exists() or args.root.is_symlink():
            metadata = validate_directory(
                args.root,
                label="preexisting Sonar install control root",
                uid=owner_uid,
                gid=owner_gid,
                mode=0o700,
            )
            predecessor: dict[str, Any] | None = {
                "uid": metadata.st_uid,
                "gid": metadata.st_gid,
                "mode": f"{stat.S_IMODE(metadata.st_mode):04o}",
                "dev": metadata.st_dev,
                "ino": metadata.st_ino,
            }
        else:
            predecessor = None
        intent = {
            "schema": "nexus.sonarqube-install-control-root-intent.v1",
            "status": "in_progress",
            "sourceSha": args.source_sha,
            "archiveSha256": args.archive_sha256,
            "path": str(args.root),
            "createdFromAbsence": predecessor is None,
            "predecessor": predecessor,
        }
        atomic_write(args.intent, intent, exclusive=True)
    if intent["createdFromAbsence"]:
        if args.root.exists() or args.root.is_symlink():
            metadata = validate_directory(
                args.root,
                label="resumed Sonar install control root",
                uid=owner_uid,
                gid=owner_gid,
                mode=0o700,
            )
            if not directory_is_empty(args.root):
                fail("uncommitted Sonar install control root is not empty")
        else:
            try:
                os.mkdir(args.root, 0o700)
                os.chown(args.root, owner_uid, owner_gid)
                os.chmod(args.root, 0o700)
            except OSError as error:
                fail(f"cannot create Sonar install control root: {error}")
            metadata = validate_directory(
                args.root,
                label="created Sonar install control root",
                uid=owner_uid,
                gid=owner_gid,
                mode=0o700,
            )
            fsync_directory(args.root)
            fsync_directory(args.parent)
    else:
        predecessor = intent["predecessor"]
        metadata = validate_directory(
            args.root,
            label="preserved Sonar install control root",
            uid=predecessor["uid"],
            gid=predecessor["gid"],
            mode=int(predecessor["mode"], 8),
            dev=predecessor["dev"],
            ino=predecessor["ino"],
        )
    if (
        test_mode()
        and os.environ.get("NEXUS_SONAR_INSTALL_TEST_CRASH_CONTROL_ROOT")
        == "after-mkdir"
    ):
        os._exit(95)
    receipt = {
        "schema": "nexus.sonarqube-install-control-root.v1",
        "status": "complete",
        "sourceSha": args.source_sha,
        "archiveSha256": args.archive_sha256,
        "path": str(args.root),
        "createdFromAbsence": intent["createdFromAbsence"],
        "predecessor": intent["predecessor"],
        "directoryIdentity": {
            "uid": metadata.st_uid,
            "gid": metadata.st_gid,
            "mode": f"{stat.S_IMODE(metadata.st_mode):04o}",
            "dev": metadata.st_dev,
            "ino": metadata.st_ino,
        },
        "completedAt": utc_now(),
    }
    atomic_write(args.receipt, receipt, exclusive=True)
    if (
        test_mode()
        and os.environ.get("NEXUS_SONAR_INSTALL_TEST_CRASH_CONTROL_ROOT")
        == "after-receipt"
    ):
        os._exit(95)
    remove_durable(args.intent)


def anchor_source_specs(source_root: Path) -> list[dict[str, Any]]:
    targets = anchor_targets()
    program_source = source_root / "scripts/quality-sonar-install-transaction.py"
    return [
        {
            "index": 0,
            "name": "retainedRecoveryProgram",
            "source": str(program_source),
            "target": str(targets["retainedRecoveryProgram"]),
            "mode": "0600",
        },
        {
            "index": 1,
            "name": "installedRecoveryProgram",
            "source": str(program_source),
            "target": str(targets["installedRecoveryProgram"]),
            "mode": "0700",
        },
        {
            "index": 2,
            "name": "recoveryUnit",
            "source": str(
                source_root
                / "ops/sonarqube/systemd/nexus-sonarqube-install-recovery.service"
            ),
            "target": str(targets["recoveryUnit"]),
            "mode": "0644",
        },
        {
            "index": 3,
            "name": "lockConfig",
            "source": str(
                source_root / "ops/sonarqube/nexus-release-sonar-lock.conf"
            ),
            "target": str(targets["lockConfig"]),
            "mode": "0644",
        },
    ]


def regular_identity(path: Path) -> dict[str, Any]:
    metadata = path.lstat()
    return {
        "sha256": sha256_file(path),
        "uid": metadata.st_uid,
        "gid": metadata.st_gid,
        "mode": f"{stat.S_IMODE(metadata.st_mode):04o}",
        "dev": metadata.st_dev,
        "ino": metadata.st_ino,
        "nlink": metadata.st_nlink,
    }


def validate_anchor_identity(
    path: Path,
    identity: dict[str, Any],
    *,
    label: str,
) -> None:
    required = {"sha256", "uid", "gid", "mode", "dev", "ino", "nlink"}
    if (
        not isinstance(identity, dict)
        or set(identity) != required
        or not SHA256.fullmatch(str(identity.get("sha256", "")))
        or identity.get("mode") not in ALLOWED_MODES
        or any(
            not isinstance(identity.get(field), int)
            or isinstance(identity.get(field), bool)
            or identity.get(field) < 0
            for field in ("uid", "gid", "dev", "ino", "nlink")
        )
    ):
        fail(f"{label} identity is invalid")
    metadata = validate_regular(
        path,
        label=label,
        digest=identity["sha256"],
        uid=identity["uid"],
        gid=identity["gid"],
        mode=int(identity["mode"], 8),
    )
    if (
        metadata.st_dev != identity["dev"]
        or metadata.st_ino != identity["ino"]
        or metadata.st_nlink != identity["nlink"]
    ):
        fail(f"{label} inode identity differs")


def capture_wants_link(
    path: Path,
    *,
    expected_unit: Path | None = None,
) -> dict[str, Any] | None:
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        return None
    except OSError as error:
        fail(f"cannot inspect recovery wants link: {error}")
    if not stat.S_ISLNK(metadata.st_mode):
        fail("recovery wants path is not a symlink")
    try:
        raw_target = os.readlink(path)
        resolved = path.resolve(strict=True)
    except OSError as error:
        fail(f"cannot resolve recovery wants link: {error}")
    expected = (
        anchor_targets()["recoveryUnit"]
        if expected_unit is None
        else expected_unit
    )
    if resolved != expected:
        fail("recovery wants link targets an unexpected unit")
    return {
        "target": raw_target,
        "uid": metadata.st_uid,
        "gid": metadata.st_gid,
        "dev": metadata.st_dev,
        "ino": metadata.st_ino,
    }


def validate_wants_link(
    path: Path,
    identity: dict[str, Any],
    *,
    exact_inode: bool,
    expected_unit: Path | None = None,
) -> None:
    observed = capture_wants_link(path, expected_unit=expected_unit)
    required = {"target", "uid", "gid", "dev", "ino"}
    if (
        observed is None
        or not isinstance(identity, dict)
        or set(identity) != required
        or observed["target"] != identity["target"]
        or observed["uid"] != identity["uid"]
        or observed["gid"] != identity["gid"]
        or (
            exact_inode
            and (
                observed["dev"] != identity["dev"]
                or observed["ino"] != identity["ino"]
            )
        )
    ):
        fail("recovery wants link differs from its transaction binding")


def anchor_receipt_digest(value: dict[str, Any]) -> str:
    body = dict(value)
    body.pop("receiptSha256", None)
    return sha256_bytes(canonical_json(body))


def validate_unit_state_record(value: Any, label: str) -> None:
    if (
        not isinstance(value, dict)
        or set(value) != {"state", "returnCode"}
        or not isinstance(value["state"], str)
        or not value["state"]
        or not isinstance(value["returnCode"], int)
        or isinstance(value["returnCode"], bool)
        or value["returnCode"] < 0
    ):
        fail(f"{label} is invalid")


def validate_anchor_document(
    value: dict[str, Any],
    *,
    intent: bool,
    path: Path,
) -> None:
    required = {
        "schema",
        "status",
        "sourceSha",
        "archiveSha256",
        "sourceRoot",
        "anchors",
        "servicePredecessor",
        "wantsLinkPredecessor",
        "serviceConfigured",
        "updatedAt",
    }
    if not intent:
        required |= {"enrolledAt", "receiptSha256"}
    anchors = value.get("anchors")
    if (
        set(value) != required
        or value.get("schema")
        != (ANCHOR_INTENT_SCHEMA if intent else ANCHOR_RECEIPT_SCHEMA)
        or value.get("status") != ("in_progress" if intent else "complete")
        or not SOURCE_SHA.fullmatch(str(value.get("sourceSha", "")))
        or not SHA256.fullmatch(str(value.get("archiveSha256", "")))
        or not Path(str(value.get("sourceRoot", ""))).is_absolute()
        or not isinstance(anchors, list)
        or len(anchors) != 4
        or not isinstance(value.get("serviceConfigured"), bool)
        or not isinstance(value.get("updatedAt"), str)
        or (not intent and not isinstance(value.get("enrolledAt"), str))
    ):
        fail("recovery-anchor document contract is invalid")
    expected_targets = anchor_targets()
    expected_names = list(expected_targets)
    owner_uid, owner_gid = expected_owner()
    for index, anchor in enumerate(anchors):
        required_anchor = {
            "index",
            "name",
            "sourceSha256",
            "target",
            "desiredSha256",
            "desiredUid",
            "desiredGid",
            "desiredMode",
            "createdFromAbsence",
            "predecessor",
            "state",
        }
        if (
            not isinstance(anchor, dict)
            or set(anchor) != required_anchor
            or anchor.get("index") != index
            or anchor.get("name") != expected_names[index]
            or Path(str(anchor.get("target", "")))
            != expected_targets[expected_names[index]]
            or not SHA256.fullmatch(str(anchor.get("sourceSha256", "")))
            or anchor.get("desiredSha256") != anchor.get("sourceSha256")
            or anchor.get("desiredUid") != owner_uid
            or anchor.get("desiredGid") != owner_gid
            or anchor.get("desiredMode") not in ALLOWED_MODES
            or not isinstance(anchor.get("createdFromAbsence"), bool)
            or anchor.get("state")
            not in {"pending", "created", "preserved"}
        ):
            fail("recovery-anchor entry binding is invalid")
        if anchor["createdFromAbsence"]:
            if anchor["predecessor"] is not None:
                fail("new recovery anchor unexpectedly binds a predecessor")
        else:
            if not isinstance(anchor["predecessor"], dict):
                fail("preexisting recovery anchor lacks exact predecessor")
            predecessor = anchor["predecessor"]
            if (
                predecessor.get("sha256") != anchor["desiredSha256"]
                or predecessor.get("uid") != anchor["desiredUid"]
                or predecessor.get("gid") != anchor["desiredGid"]
                or predecessor.get("mode") != anchor["desiredMode"]
            ):
                fail("recovery-anchor predecessor differs from desired identity")
    lock_config_anchor = anchors[3]
    if lock_config_anchor["createdFromAbsence"]:
        fail(
            "shared release/Sonar tmpfiles config must be a "
            "preexisting global predecessor"
        )
    service = value.get("servicePredecessor")
    if (
        not isinstance(service, dict)
        or set(service) != {"enabled", "active"}
    ):
        fail("recovery service predecessor shape is invalid")
    validate_unit_state_record(service["enabled"], "recovery service enabled predecessor")
    validate_unit_state_record(service["active"], "recovery service active predecessor")
    wants = value.get("wantsLinkPredecessor")
    if wants is not None and (
        not isinstance(wants, dict)
        or set(wants) != {"target", "uid", "gid", "dev", "ino"}
    ):
        fail("recovery wants-link predecessor is invalid")
    unit_anchor = anchors[2]
    if unit_anchor["createdFromAbsence"]:
        if wants is not None:
            fail("new recovery unit unexpectedly binds a wants-link predecessor")
    else:
        if wants is None:
            fail("preexisting recovery unit lacks its wants-link predecessor")
        if (service["enabled"]["state"], service["enabled"]["returnCode"]) != (
            "enabled",
            0,
        ):
            fail("preexisting recovery unit was not enabled")
    if not intent:
        if (
            not SHA256.fullmatch(str(value.get("receiptSha256", "")))
            or value["receiptSha256"] != anchor_receipt_digest(value)
            or not value["serviceConfigured"]
        ):
            fail("recovery-anchor receipt digest or terminal state is invalid")
    if path.parent != boundary_path(PRODUCTION_CONTROL_ROOT):
        fail("recovery-anchor document is outside the control root")


def read_anchor_document(path: Path, *, intent: bool) -> dict[str, Any]:
    value = read_private_json(path, "recovery-anchor document")
    validate_anchor_document(value, intent=intent, path=path)
    return value


def anchor_checkpoint(
    path: Path,
    value: dict[str, Any],
    *,
    index: int | None = None,
    state_value: str | None = None,
    service_configured: bool | None = None,
) -> dict[str, Any]:
    updated = dict(value)
    updated["anchors"] = [dict(anchor) for anchor in value["anchors"]]
    if index is not None:
        if state_value not in {"created", "preserved"}:
            fail("recovery-anchor checkpoint state is invalid")
        updated["anchors"][index]["state"] = state_value
    if service_configured is not None:
        updated["serviceConfigured"] = service_configured
    updated["updatedAt"] = utc_now()
    validate_anchor_document(updated, intent=True, path=path)
    atomic_write(path, updated, exclusive=False)
    return updated


def maybe_crash_anchor(phase: str) -> None:
    if (
        test_mode()
        and os.environ.get("NEXUS_SONAR_INSTALL_TEST_CRASH_ANCHOR") == phase
    ):
        os._exit(93)


def enroll_anchors(args: argparse.Namespace) -> None:
    validate_control_root()
    if args.intent != boundary_path(PRODUCTION_ANCHOR_INTENT):
        fail("recovery-anchor intent path is outside the control root")
    if args.receipt != boundary_path(PRODUCTION_ANCHOR_RECEIPT):
        fail("recovery-anchor receipt path is outside the control root")
    if not args.source_root.is_absolute():
        fail("recovery-anchor source root must be absolute")
    if not test_mode():
        expected = Path(
            f"/var/lib/nexus-release-bootstrap/{args.source_sha}/source"
        )
        if args.source_root != expected:
            fail("recovery-anchor source root is not exact-SHA-bound")
    elif not str(args.source_root).startswith(f"{test_root()}/"):
        fail("test recovery-anchor source root escapes its bounded root")
    specs = anchor_source_specs(args.source_root)
    owner_uid, owner_gid = expected_owner()
    for spec in specs:
        source = Path(spec["source"])
        validate_regular(
            source,
            label=f"recovery-anchor source {spec['name']}",
            uid=owner_uid,
            gid=owner_gid,
            single_link=True,
        )
        spec["sha256"] = sha256_file(source)
    if args.receipt.exists() or args.receipt.is_symlink():
        receipt = read_anchor_document(args.receipt, intent=False)
        if (
            receipt["sourceSha"] != args.source_sha
            or receipt["archiveSha256"] != args.archive_sha256
            or receipt["sourceRoot"] != str(args.source_root)
        ):
            fail("existing recovery-anchor receipt binds another source")
        if args.intent.exists() or args.intent.is_symlink():
            intent = read_anchor_document(args.intent, intent=True)
            for field in (
                "sourceSha",
                "archiveSha256",
                "sourceRoot",
                "anchors",
                "servicePredecessor",
                "wantsLinkPredecessor",
                "serviceConfigured",
                "updatedAt",
            ):
                if intent[field] != receipt[field]:
                    fail(
                        "completed recovery-anchor receipt conflicts "
                        "with its intent"
                    )
            remove_durable(args.intent)
        for anchor in receipt["anchors"]:
            validate_regular(
                Path(anchor["target"]),
                label=f"enrolled anchor {anchor['name']}",
                digest=anchor["desiredSha256"],
                uid=anchor["desiredUid"],
                gid=anchor["desiredGid"],
                mode=int(anchor["desiredMode"], 8),
            )
        validate_anchor_current(receipt)
        return
    if args.intent.exists() or args.intent.is_symlink():
        intent = read_anchor_document(args.intent, intent=True)
        if (
            intent["sourceSha"] != args.source_sha
            or intent["archiveSha256"] != args.archive_sha256
            or intent["sourceRoot"] != str(args.source_root)
            or [anchor["sourceSha256"] for anchor in intent["anchors"]]
            != [spec["sha256"] for spec in specs]
        ):
            fail("existing recovery-anchor intent binds another source")
    else:
        anchors: list[dict[str, Any]] = []
        for spec in specs:
            target = Path(spec["target"])
            if target.exists() or target.is_symlink():
                if target.is_symlink():
                    fail(f"recovery anchor target is a symlink: {target}")
                identity = regular_identity(target)
                if (
                    identity["sha256"] != spec["sha256"]
                    or identity["uid"] != owner_uid
                    or identity["gid"] != owner_gid
                    or identity["mode"] != spec["mode"]
                ):
                    fail(f"preexisting recovery anchor differs: {target}")
                predecessor: dict[str, Any] | None = identity
            else:
                predecessor = None
            if spec["name"] == "lockConfig" and predecessor is None:
                fail(
                    "shared release/Sonar tmpfiles config must preexist "
                    "with the exact protected-main identity"
                )
            anchors.append({
                "index": spec["index"],
                "name": spec["name"],
                "sourceSha256": spec["sha256"],
                "target": spec["target"],
                "desiredSha256": spec["sha256"],
                "desiredUid": owner_uid,
                "desiredGid": owner_gid,
                "desiredMode": spec["mode"],
                "createdFromAbsence": predecessor is None,
                "predecessor": predecessor,
                "state": "pending",
            })
        service_predecessor = {
            "enabled": query_unit_state("is-enabled", RECOVERY_SERVICE),
            "active": query_unit_state("is-active", RECOVERY_SERVICE),
        }
        wants_predecessor = capture_wants_link(
            boundary_path(RECOVERY_WANTS_LINK)
        )
        unit_created = anchors[2]["createdFromAbsence"]
        if unit_created:
            if wants_predecessor is not None:
                fail("absent recovery unit has a preexisting wants link")
            if service_predecessor["enabled"]["state"] not in {
                "not-found",
                "disabled",
            }:
                fail("absent recovery unit has an unexpected enabled state")
        elif (
            service_predecessor["enabled"]["state"],
            service_predecessor["enabled"]["returnCode"],
        ) != ("enabled", 0):
            fail("preexisting recovery unit must already be enabled")
        if not unit_created and anchors[0]["createdFromAbsence"]:
            fail("preexisting recovery unit lacks its retained program")
        intent = {
            "schema": ANCHOR_INTENT_SCHEMA,
            "status": "in_progress",
            "sourceSha": args.source_sha,
            "archiveSha256": args.archive_sha256,
            "sourceRoot": str(args.source_root),
            "anchors": anchors,
            "servicePredecessor": service_predecessor,
            "wantsLinkPredecessor": wants_predecessor,
            "serviceConfigured": False,
            "updatedAt": utc_now(),
        }
        validate_anchor_document(intent, intent=True, path=args.intent)
        atomic_write(args.intent, intent, exclusive=True)
    for anchor in intent["anchors"]:
        index = anchor["index"]
        target = Path(anchor["target"])
        source = Path(specs[index]["source"])
        if anchor["state"] == "pending":
            if anchor["createdFromAbsence"]:
                if target.exists() or target.is_symlink():
                    validate_regular(
                        target,
                        label=f"resumed recovery anchor {anchor['name']}",
                        digest=anchor["desiredSha256"],
                        uid=anchor["desiredUid"],
                        gid=anchor["desiredGid"],
                        mode=int(anchor["desiredMode"], 8),
                    )
                else:
                    atomic_install_file(
                        source,
                        target,
                        uid=anchor["desiredUid"],
                        gid=anchor["desiredGid"],
                        mode=int(anchor["desiredMode"], 8),
                    )
                state_value = "created"
            else:
                validate_anchor_identity(
                    target,
                    anchor["predecessor"],
                    label=f"preserved recovery anchor {anchor['name']}",
                )
                state_value = "preserved"
            maybe_crash_anchor(f"after-install-{anchor['name']}")
            intent = anchor_checkpoint(
                args.intent,
                intent,
                index=index,
                state_value=state_value,
            )
        else:
            validate_regular(
                target,
                label=f"checkpointed recovery anchor {anchor['name']}",
                digest=anchor["desiredSha256"],
                uid=anchor["desiredUid"],
                gid=anchor["desiredGid"],
                mode=int(anchor["desiredMode"], 8),
            )
    if not intent["serviceConfigured"]:
        run_systemctl(["daemon-reload"])
        run_bounded_command(
            systemd_analyze_executable(),
            ["verify", str(anchor_targets()["recoveryUnit"])],
            label="systemd recovery-unit verification",
        )
        run_bounded_command(
            systemd_tmpfiles_executable(),
            ["--create", str(anchor_targets()["lockConfig"])],
            label="shared-lock tmpfiles creation",
        )
        run_systemctl(["enable", RECOVERY_SERVICE])
        enabled = query_unit_state("is-enabled", RECOVERY_SERVICE)
        if (enabled["state"], enabled["returnCode"]) != ("enabled", 0):
            fail("recovery service is not durably enabled")
        wants = capture_wants_link(boundary_path(RECOVERY_WANTS_LINK))
        if wants is None:
            fail("recovery service enablement did not create its wants link")
        fsync_directory(anchor_targets()["recoveryUnit"].parent)
        if boundary_path(RECOVERY_WANTS_LINK).parent.exists():
            fsync_directory(boundary_path(RECOVERY_WANTS_LINK).parent)
        maybe_crash_anchor("after-service-enable")
        intent = anchor_checkpoint(
            args.intent,
            intent,
            service_configured=True,
        )
    receipt = {
        **intent,
        "schema": ANCHOR_RECEIPT_SCHEMA,
        "status": "complete",
        "enrolledAt": utc_now(),
    }
    receipt["receiptSha256"] = anchor_receipt_digest(receipt)
    validate_anchor_document(receipt, intent=False, path=args.receipt)
    atomic_write(args.receipt, receipt, exclusive=True)
    maybe_crash_anchor("after-receipt")
    remove_durable(args.intent)


def validate_anchor_current(receipt: dict[str, Any]) -> None:
    for anchor in receipt["anchors"]:
        target = Path(anchor["target"])
        if anchor["createdFromAbsence"]:
            validate_regular(
                target,
                label=f"created recovery anchor {anchor['name']}",
                digest=anchor["desiredSha256"],
                uid=anchor["desiredUid"],
                gid=anchor["desiredGid"],
                mode=int(anchor["desiredMode"], 8),
                single_link=True,
            )
        else:
            validate_anchor_identity(
                target,
                anchor["predecessor"],
                label=f"preexisting recovery anchor {anchor['name']}",
            )
    enabled = query_unit_state("is-enabled", RECOVERY_SERVICE)
    if (enabled["state"], enabled["returnCode"]) != ("enabled", 0):
        fail("enrolled recovery service is not enabled")
    wants_path = boundary_path(RECOVERY_WANTS_LINK)
    if receipt["wantsLinkPredecessor"] is None:
        observed = capture_wants_link(wants_path)
        if observed is None:
            fail("created recovery service lacks its wants link")
    else:
        validate_wants_link(
            wants_path,
            receipt["wantsLinkPredecessor"],
            exact_inode=True,
        )


def assert_anchor_unenroll_guards() -> None:
    assert_runtime_units_inactive_disabled()
    forbidden = (
        boundary_path(PRODUCTION_JOURNAL),
        boundary_path(PRODUCTION_DIRECTORY_JOURNAL),
        boundary_path(PRODUCTION_ANCHOR_INTENT),
        boundary_path(INSTALL_RECEIPT),
    )
    for path in forbidden:
        if path.exists() or path.is_symlink():
            fail(f"anchor unenrollment is blocked by {path}")


def continuation_authority_plan() -> dict[str, Any]:
    uid, gid = expected_owner()
    unit = boundary_path(UNENROLL_RECOVERY_UNIT)
    wants = boundary_path(UNENROLL_RECOVERY_WANTS_LINK)
    return {
        "service": UNENROLL_RECOVERY_SERVICE,
        "unitPath": str(unit),
        "wantsLink": str(wants),
        "unitSha256": sha256_bytes(unenroll_recovery_unit_bytes()),
        "desiredUid": uid,
        "desiredGid": gid,
        "desiredMode": "0644",
    }


def capture_absent_continuation_predecessor() -> dict[str, Any]:
    authority = continuation_authority_plan()
    unit = Path(authority["unitPath"])
    wants = Path(authority["wantsLink"])
    if unit.exists() or unit.is_symlink():
        fail("anchor-unenrollment continuation unit already exists")
    if wants.exists() or wants.is_symlink():
        fail("anchor-unenrollment continuation wants link already exists")
    enabled = query_unit_state("is-enabled", UNENROLL_RECOVERY_SERVICE)
    active = query_unit_state("is-active", UNENROLL_RECOVERY_SERVICE)
    if (enabled["state"], enabled["returnCode"]) not in {
        ("disabled", 1),
        ("not-found", 1),
        ("not-found", 4),
    }:
        fail("anchor-unenrollment continuation has an ambiguous enabled state")
    if (active["state"], active["returnCode"]) not in {
        ("inactive", 3),
        ("failed", 3),
        ("unknown", 4),
        ("not-found", 4),
    }:
        fail("anchor-unenrollment continuation has an ambiguous active state")
    return {
        **authority,
        "state": "planned",
        "enabledPredecessor": enabled,
        "activePredecessor": active,
        "wantsLinkPredecessor": None,
    }


def anchor_unenroll_steps(receipt: dict[str, Any]) -> list[str]:
    by_name = {anchor["name"]: anchor for anchor in receipt["anchors"]}
    if by_name["lockConfig"]["createdFromAbsence"]:
        fail(
            "shared release/Sonar tmpfiles config is not a removable "
            "Sonar-owned anchor"
        )
    steps: list[str] = ["enroll-unenrollRecoveryUnit"]
    if by_name["installedRecoveryProgram"]["createdFromAbsence"]:
        steps.append("remove-installedRecoveryProgram")
    if by_name["recoveryUnit"]["createdFromAbsence"]:
        steps.extend([
            "disable-recovery-service",
            "remove-recoveryUnit",
            "reload-systemd",
        ])
    if by_name["retainedRecoveryProgram"]["createdFromAbsence"]:
        steps.append("remove-retainedRecoveryProgram")
    return steps


def anchor_unenroll_plan_value(
    receipt_path: Path,
    receipt: dict[str, Any],
) -> dict[str, Any]:
    receipt_file_sha = sha256_file(receipt_path)
    body = {
        "schema": "nexus.sonarqube-recovery-anchor-unenrollment-plan.v1",
        "receiptPath": str(receipt_path),
        "receiptFileSha256": receipt_file_sha,
        "receiptBindingSha256": receipt["receiptSha256"],
        "sourceSha": receipt["sourceSha"],
        "archiveSha256": receipt["archiveSha256"],
        "continuationAuthority": continuation_authority_plan(),
        "steps": anchor_unenroll_steps(receipt),
        "preservedAnchors": [
            anchor["name"]
            for anchor in receipt["anchors"]
            if not anchor["createdFromAbsence"]
        ],
    }
    return {
        **body,
        "ackPlan": f"sha256:{sha256_bytes(canonical_json(body))}",
        "ackReceipt": f"sha256:{receipt_file_sha}",
    }


def plan_anchor_unenroll(args: argparse.Namespace) -> None:
    if (
        args.receipt != boundary_path(PRODUCTION_ANCHOR_RECEIPT)
        or args.lock != boundary_path(PRODUCTION_LOCK)
    ):
        fail("anchor-unenrollment plan paths are outside the exact boundary")
    descriptor = acquire_lock(args.lock)
    try:
        assert_anchor_unenroll_guards()
        receipt = read_anchor_document(args.receipt, intent=False)
        validate_anchor_current(receipt)
        capture_absent_continuation_predecessor()
        sys.stdout.buffer.write(
            canonical_json(anchor_unenroll_plan_value(args.receipt, receipt))
            + b"\n"
        )
    finally:
        os.close(descriptor)


def validate_anchor_current_command(args: argparse.Namespace) -> None:
    if args.receipt != boundary_path(PRODUCTION_ANCHOR_RECEIPT):
        fail("recovery-anchor receipt path is outside the control root")
    validate_control_root()
    receipt = read_anchor_document(args.receipt, intent=False)
    validate_anchor_current(receipt)


def validate_continuation_authority_record(
    value: Any,
    *,
    require_current_unit_digest: bool = True,
) -> None:
    expected = continuation_authority_plan()
    required = {
        *expected,
        "state",
        "enabledPredecessor",
        "activePredecessor",
        "wantsLinkPredecessor",
    }
    stable_fields = {
        "service",
        "unitPath",
        "wantsLink",
        "desiredUid",
        "desiredGid",
        "desiredMode",
    }
    if (
        not isinstance(value, dict)
        or set(value) != required
        or {key: value.get(key) for key in stable_fields}
        != {key: expected[key] for key in stable_fields}
        or not SHA256.fullmatch(str(value.get("unitSha256", "")))
        or (
            require_current_unit_digest
            and value.get("unitSha256") != expected["unitSha256"]
        )
        or value.get("state") not in {"planned", "unit-created", "enabled"}
        or value.get("wantsLinkPredecessor") is not None
    ):
        fail("anchor-unenrollment continuation binding is invalid")
    validate_unit_state_record(
        value["enabledPredecessor"],
        "anchor-unenrollment continuation enabled predecessor",
    )
    validate_unit_state_record(
        value["activePredecessor"],
        "anchor-unenrollment continuation active predecessor",
    )
    if (
        value["enabledPredecessor"]["state"],
        value["enabledPredecessor"]["returnCode"],
    ) not in {
        ("disabled", 1),
        ("not-found", 1),
        ("not-found", 4),
    }:
        fail("anchor-unenrollment continuation enabled predecessor is unsafe")
    if (
        value["activePredecessor"]["state"],
        value["activePredecessor"]["returnCode"],
    ) not in {
        ("inactive", 3),
        ("failed", 3),
        ("unknown", 4),
        ("not-found", 4),
    }:
        fail("anchor-unenrollment continuation active predecessor is unsafe")


def validate_anchor_unenroll_journal(
    value: dict[str, Any],
    path: Path,
    receipt: dict[str, Any],
) -> None:
    required = {
        "schema",
        "status",
        "startedAt",
        "updatedAt",
        "receiptPath",
        "receiptFileSha256",
        "receiptBindingSha256",
        "ackPlan",
        "ackReceipt",
        "steps",
        "currentStep",
        "completedSteps",
        "sourceSha",
        "archiveSha256",
        "ownerAuthorized",
        "continuationAuthority",
    }
    plan = anchor_unenroll_plan_value(
        Path(str(value.get("receiptPath", ""))),
        receipt,
    )
    steps = value.get("steps")
    completed = value.get("completedSteps")
    current = value.get("currentStep")
    continuation = value.get("continuationAuthority")
    validate_continuation_authority_record(continuation)
    enrollment_step = "enroll-unenrollRecoveryUnit"
    if (
        set(value) != required
        or value.get("schema") != ANCHOR_UNENROLL_SCHEMA
        or value.get("status") != "in_progress"
        or value.get("receiptPath") != str(boundary_path(PRODUCTION_ANCHOR_RECEIPT))
        or value.get("receiptFileSha256") != plan["receiptFileSha256"]
        or value.get("receiptBindingSha256") != receipt["receiptSha256"]
        or value.get("ackPlan") != plan["ackPlan"]
        or value.get("ackReceipt") != plan["ackReceipt"]
        or value.get("sourceSha") != receipt["sourceSha"]
        or value.get("archiveSha256") != receipt["archiveSha256"]
        or value.get("ownerAuthorized") is not True
        or steps != plan["steps"]
        or not isinstance(completed, list)
        or any(step not in steps for step in completed)
        or len(set(completed)) != len(completed)
        or (current is not None and current not in steps)
        or (
            current is not None
            and current in completed
        )
        or (
            continuation["state"] != "enabled"
            and (
                enrollment_step in completed
                or (
                    current is not None
                    and current != enrollment_step
                )
            )
        )
        or (
            continuation["state"] == "enabled"
            and enrollment_step not in completed
            and current not in {None, enrollment_step}
        )
        or (
            any(step != enrollment_step for step in completed)
            and enrollment_step not in completed
        )
        or path != boundary_path(PRODUCTION_ANCHOR_UNENROLL_JOURNAL)
    ):
        fail("anchor-unenrollment journal binding is invalid")


def anchor_unenroll_checkpoint(
    path: Path,
    journal: dict[str, Any],
    receipt: dict[str, Any],
    *,
    current_step: str | None,
    complete_step: str | None = None,
    continuation_state: str | None = None,
) -> dict[str, Any]:
    updated = dict(journal)
    updated["completedSteps"] = list(journal["completedSteps"])
    updated["continuationAuthority"] = dict(
        journal["continuationAuthority"]
    )
    if continuation_state is not None:
        if continuation_state not in {"unit-created", "enabled"}:
            fail("anchor-unenrollment continuation checkpoint is invalid")
        updated["continuationAuthority"]["state"] = continuation_state
    if complete_step is not None:
        if (
            complete_step not in updated["steps"]
            or complete_step in updated["completedSteps"]
        ):
            fail("anchor-unenrollment completion checkpoint is invalid")
        updated["completedSteps"].append(complete_step)
    updated["currentStep"] = current_step
    updated["updatedAt"] = utc_now()
    validate_anchor_unenroll_journal(updated, path, receipt)
    atomic_write(path, updated, exclusive=False)
    return updated


def maybe_crash_unenroll(step: str) -> None:
    if (
        test_mode()
        and os.environ.get("NEXUS_SONAR_INSTALL_TEST_CRASH_UNENROLL") == step
    ):
        os._exit(94)


def assert_continuation_authority_enabled(
    journal: dict[str, Any],
) -> None:
    authority = journal["continuationAuthority"]
    if authority["state"] != "enabled":
        fail("anchor-unenrollment continuation is not checkpointed enabled")
    unit = Path(authority["unitPath"])
    wants = Path(authority["wantsLink"])
    validate_regular(
        unit,
        label="anchor-unenrollment continuation unit",
        digest=authority["unitSha256"],
        uid=authority["desiredUid"],
        gid=authority["desiredGid"],
        mode=int(authority["desiredMode"], 8),
        single_link=True,
    )
    enabled = query_unit_state("is-enabled", authority["service"])
    if (enabled["state"], enabled["returnCode"]) != ("enabled", 0):
        fail("anchor-unenrollment continuation is not durably enabled")
    wants_identity = capture_wants_link(
        wants,
        expected_unit=unit,
    )
    if wants_identity is None:
        fail("anchor-unenrollment continuation lacks its wants link")


def ensure_continuation_authority(
    *,
    journal_path: Path,
    journal: dict[str, Any],
    receipt: dict[str, Any],
) -> dict[str, Any]:
    step = "enroll-unenrollRecoveryUnit"
    if step in journal["completedSteps"]:
        assert_continuation_authority_enabled(journal)
        return journal
    if journal["currentStep"] is None:
        journal = anchor_unenroll_checkpoint(
            journal_path,
            journal,
            receipt,
            current_step=step,
        )
    elif journal["currentStep"] != step:
        fail("anchor-unenrollment continuation enrollment is not first")
    authority = journal["continuationAuthority"]
    unit = Path(authority["unitPath"])
    wants = Path(authority["wantsLink"])
    if authority["state"] == "planned":
        if unit.exists() or unit.is_symlink():
            validate_regular(
                unit,
                label="resumed anchor-unenrollment continuation unit",
                digest=authority["unitSha256"],
                uid=authority["desiredUid"],
                gid=authority["desiredGid"],
                mode=int(authority["desiredMode"], 8),
                single_link=True,
            )
        else:
            atomic_install_bytes(
                unenroll_recovery_unit_bytes(),
                unit,
                uid=authority["desiredUid"],
                gid=authority["desiredGid"],
                mode=int(authority["desiredMode"], 8),
                label="anchor-unenrollment continuation unit",
            )
        maybe_crash_unenroll("continuation-unit-created")
        journal = anchor_unenroll_checkpoint(
            journal_path,
            journal,
            receipt,
            current_step=step,
            continuation_state="unit-created",
        )
        authority = journal["continuationAuthority"]
    if authority["state"] == "unit-created":
        validate_regular(
            unit,
            label="anchor-unenrollment continuation unit",
            digest=authority["unitSha256"],
            uid=authority["desiredUid"],
            gid=authority["desiredGid"],
            mode=int(authority["desiredMode"], 8),
            single_link=True,
        )
        run_systemctl(["daemon-reload"])
        run_bounded_command(
            systemd_analyze_executable(),
            ["verify", str(unit)],
            label="anchor-unenrollment continuation-unit verification",
        )
        enabled = query_unit_state("is-enabled", authority["service"])
        if (enabled["state"], enabled["returnCode"]) == ("enabled", 0):
            pass
        elif (enabled["state"], enabled["returnCode"]) in {
            ("disabled", 1),
            ("not-found", 1),
            ("not-found", 4),
        }:
            run_systemctl(["enable", authority["service"]])
        else:
            fail(
                "anchor-unenrollment continuation has an ambiguous "
                "enabled state"
            )
        enabled = query_unit_state("is-enabled", authority["service"])
        if (enabled["state"], enabled["returnCode"]) != ("enabled", 0):
            fail("anchor-unenrollment continuation enablement was not durable")
        wants_identity = capture_wants_link(
            wants,
            expected_unit=unit,
        )
        if wants_identity is None:
            fail(
                "anchor-unenrollment continuation enablement lacks "
                "its wants link"
            )
        fsync_directory(unit.parent)
        fsync_directory(wants.parent)
        maybe_crash_unenroll("continuation-enabled")
        journal = anchor_unenroll_checkpoint(
            journal_path,
            journal,
            receipt,
            current_step=step,
            continuation_state="enabled",
        )
    assert_continuation_authority_enabled(journal)
    return anchor_unenroll_checkpoint(
        journal_path,
        journal,
        receipt,
        current_step=None,
        complete_step=step,
    )


def retained_cleanup_binding(receipt: dict[str, Any]) -> dict[str, Any]:
    anchor = next(
        value
        for value in receipt["anchors"]
        if value["name"] == "retainedRecoveryProgram"
    )
    return {
        "target": anchor["target"],
        "sha256": anchor["desiredSha256"],
        "uid": anchor["desiredUid"],
        "gid": anchor["desiredGid"],
        "mode": anchor["desiredMode"],
        "createdFromAbsence": anchor["createdFromAbsence"],
        "predecessor": anchor["predecessor"],
    }


def validate_cleanup_identity_record(value: Any) -> None:
    required = {"sha256", "uid", "gid", "mode", "dev", "ino", "nlink"}
    if (
        not isinstance(value, dict)
        or set(value) != required
        or not SHA256.fullmatch(str(value.get("sha256", "")))
        or value.get("mode") not in ALLOWED_MODES
        or any(
            not isinstance(value.get(field), int)
            or isinstance(value.get(field), bool)
            or value.get(field) < 0
            for field in ("uid", "gid", "dev", "ino", "nlink")
        )
    ):
        fail("anchor-cleanup predecessor identity is invalid")


def validate_retained_cleanup_binding(value: Any) -> None:
    required = {
        "target",
        "sha256",
        "uid",
        "gid",
        "mode",
        "createdFromAbsence",
        "predecessor",
    }
    uid, gid = expected_owner()
    if (
        not isinstance(value, dict)
        or set(value) != required
        or Path(str(value.get("target", "")))
        != boundary_path(PRODUCTION_PROGRAM)
        or not SHA256.fullmatch(str(value.get("sha256", "")))
        or value.get("uid") != uid
        or value.get("gid") != gid
        or value.get("mode") != "0600"
        or not isinstance(value.get("createdFromAbsence"), bool)
    ):
        fail("anchor-cleanup retained-program binding is invalid")
    if value["createdFromAbsence"]:
        if value["predecessor"] is not None:
            fail("created retained program has an unexpected predecessor")
    else:
        validate_cleanup_identity_record(value["predecessor"])
        if (
            value["predecessor"]["sha256"] != value["sha256"]
            or value["predecessor"]["uid"] != value["uid"]
            or value["predecessor"]["gid"] != value["gid"]
            or value["predecessor"]["mode"] != value["mode"]
        ):
            fail("preserved retained-program predecessor binding differs")


def anchor_cleanup_steps(
    retained: dict[str, Any],
) -> list[str]:
    steps = [
        "remove-anchor-receipt",
        "disable-continuation-service",
        "remove-continuation-unit",
        "reload-systemd-after-continuation",
    ]
    if retained["createdFromAbsence"]:
        steps.append("remove-retainedRecoveryProgram")
    return steps


def expected_continuation_cleanup_state(
    completed: list[str],
) -> str:
    if "reload-systemd-after-continuation" in completed:
        return "reloaded"
    if "remove-continuation-unit" in completed:
        return "unit-removed"
    if "disable-continuation-service" in completed:
        return "disabled"
    return "enabled"


def cleanup_result_binding(value: dict[str, Any]) -> str:
    return sha256_bytes(
        canonical_json({
            "schema": value["schema"],
            "sourceSha": value["sourceSha"],
            "archiveSha256": value["archiveSha256"],
            "receiptPath": value["receiptPath"],
            "receiptFileSha256": value["receiptFileSha256"],
            "receiptBindingSha256": value["receiptBindingSha256"],
            "continuationAuthority": value["continuationAuthority"],
            "retainedRecoveryProgram": value["retainedRecoveryProgram"],
            "removedAnchors": value["removedAnchors"],
            "preservedAnchors": value["preservedAnchors"],
            "completedSteps": value["completedSteps"],
            "cleanupSteps": value["cleanupSteps"],
        }),
    )


def expected_completed_anchor_steps(
    removed: list[str],
) -> list[str]:
    steps = ["enroll-unenrollRecoveryUnit"]
    if "installedRecoveryProgram" in removed:
        steps.append("remove-installedRecoveryProgram")
    if "recoveryUnit" in removed:
        steps.extend([
            "disable-recovery-service",
            "remove-recoveryUnit",
            "reload-systemd",
        ])
    return steps


def validate_anchor_cleanup_result(
    value: dict[str, Any],
    path: Path,
    *,
    archived: bool = False,
) -> None:
    required = {
        "schema",
        "status",
        "sourceSha",
        "archiveSha256",
        "receiptPath",
        "receiptFileSha256",
        "receiptBindingSha256",
        "cleanupBindingSha256",
        "continuationAuthority",
        "retainedRecoveryProgram",
        "removedAnchors",
        "preservedAnchors",
        "completedSteps",
        "cleanupSteps",
        "currentCleanupStep",
        "completedCleanupSteps",
        "continuationState",
        "preparedAt",
        "updatedAt",
        "completedAt",
        "retainedProgramRemovedLast",
        "continuationAuthorityRemovedAfterCommit",
    }
    retained = value.get("retainedRecoveryProgram")
    validate_retained_cleanup_binding(retained)
    continuation = value.get("continuationAuthority")
    validate_continuation_authority_record(
        continuation,
        require_current_unit_digest=False,
    )
    cleanup_steps = value.get("cleanupSteps")
    completed = value.get("completedCleanupSteps")
    current = value.get("currentCleanupStep")
    removed = value.get("removedAnchors")
    preserved = value.get("preservedAnchors")
    completed_anchor_steps = value.get("completedSteps")
    anchor_names = list(ANCHOR_TARGETS)
    expected_removed = (
        [name for name in anchor_names if name in removed]
        if isinstance(removed, list)
        else None
    )
    expected_preserved = (
        [name for name in anchor_names if name not in removed]
        if isinstance(removed, list)
        else None
    )
    expected_steps = anchor_cleanup_steps(retained)
    expected_state = (
        expected_continuation_cleanup_state(completed)
        if isinstance(completed, list)
        else None
    )
    retained_removed = (
        not retained["createdFromAbsence"]
        or (
            isinstance(completed, list)
            and "remove-retainedRecoveryProgram" in completed
        )
    )
    continuation_removed = (
        isinstance(completed, list)
        and "remove-continuation-unit" in completed
    )
    complete = value.get("status") == "complete"
    if (
        set(value) != required
        or value.get("schema") != ANCHOR_UNENROLL_RESULT_SCHEMA
        or value.get("status") not in {"cleanup_pending", "complete"}
        or not SOURCE_SHA.fullmatch(str(value.get("sourceSha", "")))
        or not SHA256.fullmatch(str(value.get("archiveSha256", "")))
        or value.get("receiptPath")
        != str(boundary_path(PRODUCTION_ANCHOR_RECEIPT))
        or not SHA256.fullmatch(str(value.get("receiptFileSha256", "")))
        or not SHA256.fullmatch(str(value.get("receiptBindingSha256", "")))
        or not SHA256.fullmatch(str(value.get("cleanupBindingSha256", "")))
        or continuation.get("state") != "enabled"
        or not isinstance(removed, list)
        or removed != expected_removed
        or len(set(removed)) != len(removed)
        or any(name not in anchor_names for name in removed)
        or not isinstance(preserved, list)
        or preserved != expected_preserved
        or len(set(preserved)) != len(preserved)
        or "lockConfig" not in preserved
        or (
            retained["createdFromAbsence"]
            != ("retainedRecoveryProgram" in removed)
        )
        or not isinstance(completed_anchor_steps, list)
        or completed_anchor_steps != expected_completed_anchor_steps(removed)
        or cleanup_steps != expected_steps
        or not isinstance(completed, list)
        or completed != expected_steps[:len(completed)]
        or len(completed) > len(expected_steps)
        or (
            current is not None
            and (
                len(completed) >= len(expected_steps)
                or current != expected_steps[len(completed)]
            )
        )
        or value.get("continuationState") != expected_state
        or not isinstance(value.get("preparedAt"), str)
        or not isinstance(value.get("updatedAt"), str)
        or value.get("retainedProgramRemovedLast") != retained_removed
        or value.get("continuationAuthorityRemovedAfterCommit")
        != continuation_removed
        or (
            complete
            and (
                completed != expected_steps
                or current is not None
                or not isinstance(value.get("completedAt"), str)
            )
        )
        or (
            not complete
            and (
                completed == expected_steps
                or value.get("completedAt") is not None
            )
        )
        or path
        != boundary_path(
            PRODUCTION_ANCHOR_UNENROLL_ARCHIVE
            if archived
            else PRODUCTION_ANCHOR_UNENROLL_RESULT
        )
        or value.get("cleanupBindingSha256")
        != cleanup_result_binding(value)
    ):
        fail("anchor-unenrollment cleanup result binding is invalid")


def read_anchor_cleanup_result(path: Path) -> dict[str, Any]:
    value = read_private_json(
        path,
        "anchor-unenrollment cleanup result",
        repair_exclusive_link=True,
    )
    validate_anchor_cleanup_result(value, path)
    return value


def read_anchor_cleanup_archive(path: Path) -> dict[str, Any]:
    value = read_private_json(
        path,
        "archived anchor-unenrollment cleanup result",
    )
    validate_anchor_cleanup_result(value, path, archived=True)
    if value["status"] != "complete":
        fail("archived anchor-unenrollment result is not complete")
    return value


def cleanup_generation_binding(value: dict[str, Any]) -> str:
    return sha256_bytes(
        canonical_json({
            "schema": value["schema"],
            "status": value["status"],
            "cleanupBindingSha256": value["cleanupBindingSha256"],
            "receiptBindingSha256": value["receiptBindingSha256"],
            "sourceSha": value["sourceSha"],
            "archiveSha256": value["archiveSha256"],
            "predecessorCleanupBindingSha256": (
                value["predecessorCleanupBindingSha256"]
            ),
        }),
    )


def validate_cleanup_generation(
    value: dict[str, Any],
    path: Path,
) -> None:
    required = {
        "schema",
        "status",
        "cleanupBindingSha256",
        "receiptBindingSha256",
        "sourceSha",
        "archiveSha256",
        "predecessorCleanupBindingSha256",
        "generationBindingSha256",
        "recordedAt",
    }
    predecessor = value.get("predecessorCleanupBindingSha256")
    if (
        set(value) != required
        or value.get("schema") != ANCHOR_CLEANUP_GENERATION_SCHEMA
        or value.get("status") != "current"
        or not SHA256.fullmatch(
            str(value.get("cleanupBindingSha256", ""))
        )
        or not SHA256.fullmatch(
            str(value.get("receiptBindingSha256", ""))
        )
        or not SOURCE_SHA.fullmatch(str(value.get("sourceSha", "")))
        or not SHA256.fullmatch(str(value.get("archiveSha256", "")))
        or (
            predecessor is not None
            and not SHA256.fullmatch(str(predecessor))
        )
        or not SHA256.fullmatch(
            str(value.get("generationBindingSha256", ""))
        )
        or value.get("generationBindingSha256")
        != cleanup_generation_binding(value)
        or not isinstance(value.get("recordedAt"), str)
        or path != boundary_path(PRODUCTION_ANCHOR_CLEANUP_GENERATION)
    ):
        fail("anchor-cleanup generation binding is invalid")


def read_cleanup_generation(path: Path) -> dict[str, Any]:
    value = read_private_json(path, "anchor-cleanup generation")
    validate_cleanup_generation(value, path)
    return value


def validate_result_generation(
    result: dict[str, Any],
    generation: dict[str, Any],
) -> None:
    if (
        generation["cleanupBindingSha256"]
        != result["cleanupBindingSha256"]
        or generation["receiptBindingSha256"]
        != result["receiptBindingSha256"]
        or generation["sourceSha"] != result["sourceSha"]
        or generation["archiveSha256"] != result["archiveSha256"]
    ):
        fail("active anchor-cleanup result is not the current generation")


def current_cleanup_archive() -> dict[str, Any] | None:
    path = boundary_path(PRODUCTION_ANCHOR_UNENROLL_ARCHIVE)
    if path.exists() or path.is_symlink():
        return read_anchor_cleanup_archive(path)
    return None


def validate_cleanup_generation_archive(
    generation: dict[str, Any],
) -> dict[str, Any] | None:
    archive = current_cleanup_archive()
    predecessor = generation["predecessorCleanupBindingSha256"]
    if archive is None:
        if predecessor is not None:
            fail("anchor-cleanup predecessor archive is missing")
        return None
    if archive["cleanupBindingSha256"] not in {
        predecessor,
        generation["cleanupBindingSha256"],
    }:
        fail(
            "anchor-cleanup archive is neither the exact predecessor "
            "nor the current generation"
        )
    return archive


def checkpoint_cleanup_generation(
    result: dict[str, Any],
) -> dict[str, Any]:
    path = boundary_path(PRODUCTION_ANCHOR_CLEANUP_GENERATION)
    archive = current_cleanup_archive()
    archive_binding = (
        archive["cleanupBindingSha256"] if archive is not None else None
    )
    if path.exists() or path.is_symlink():
        current = read_cleanup_generation(path)
        if (
            current["cleanupBindingSha256"]
            == result["cleanupBindingSha256"]
        ):
            validate_result_generation(result, current)
            validate_cleanup_generation_archive(current)
            return current
        if (
            archive_binding is None
            or current["cleanupBindingSha256"] != archive_binding
        ):
            fail(
                "anchor-cleanup generation does not bind the "
                "current predecessor archive"
            )
    generation = {
        "schema": ANCHOR_CLEANUP_GENERATION_SCHEMA,
        "status": "current",
        "cleanupBindingSha256": result["cleanupBindingSha256"],
        "receiptBindingSha256": result["receiptBindingSha256"],
        "sourceSha": result["sourceSha"],
        "archiveSha256": result["archiveSha256"],
        "predecessorCleanupBindingSha256": archive_binding,
        "recordedAt": utc_now(),
    }
    generation["generationBindingSha256"] = cleanup_generation_binding(
        generation
    )
    validate_cleanup_generation(generation, path)
    atomic_write(path, generation, exclusive=False)
    return read_cleanup_generation(path)


def require_current_cleanup_generation(
    result: dict[str, Any],
) -> dict[str, Any]:
    path = boundary_path(PRODUCTION_ANCHOR_CLEANUP_GENERATION)
    generation = read_cleanup_generation(path)
    validate_result_generation(result, generation)
    validate_cleanup_generation_archive(generation)
    return generation


def anchor_cleanup_checkpoint(
    path: Path,
    result: dict[str, Any],
    *,
    current_step: str | None,
    complete_step: str | None = None,
    complete: bool = False,
) -> dict[str, Any]:
    updated = dict(result)
    updated["completedSteps"] = list(result["completedSteps"])
    updated["completedCleanupSteps"] = list(
        result["completedCleanupSteps"]
    )
    if complete_step is not None:
        expected = updated["cleanupSteps"][len(updated["completedCleanupSteps"])]
        if complete_step != expected:
            fail("anchor-cleanup completion checkpoint is out of order")
        updated["completedCleanupSteps"].append(complete_step)
    updated["currentCleanupStep"] = current_step
    updated["continuationState"] = expected_continuation_cleanup_state(
        updated["completedCleanupSteps"]
    )
    updated["retainedProgramRemovedLast"] = (
        not updated["retainedRecoveryProgram"]["createdFromAbsence"]
        or "remove-retainedRecoveryProgram"
        in updated["completedCleanupSteps"]
    )
    updated["continuationAuthorityRemovedAfterCommit"] = (
        "remove-continuation-unit" in updated["completedCleanupSteps"]
    )
    updated["updatedAt"] = utc_now()
    if complete:
        if updated["completedCleanupSteps"] != updated["cleanupSteps"]:
            fail("anchor cleanup cannot complete before every exact step")
        updated["status"] = "complete"
        updated["completedAt"] = utc_now()
    validate_anchor_cleanup_result(updated, path)
    atomic_write(path, updated, exclusive=False)
    require_current_cleanup_generation(updated)
    return updated


def validate_anchor_cleanup_files(result: dict[str, Any]) -> None:
    receipt_path = Path(result["receiptPath"])
    receipt_removed = (
        "remove-anchor-receipt" in result["completedCleanupSteps"]
    )
    receipt_current = (
        result["currentCleanupStep"] == "remove-anchor-receipt"
    )
    if receipt_path.exists() or receipt_path.is_symlink():
        if receipt_removed:
            fail("completed anchor receipt cleanup left the receipt present")
        receipt = read_anchor_document(receipt_path, intent=False)
        expected_removed = [
            anchor["name"]
            for anchor in receipt["anchors"]
            if anchor["createdFromAbsence"]
        ]
        expected_preserved = [
            anchor["name"]
            for anchor in receipt["anchors"]
            if not anchor["createdFromAbsence"]
        ]
        if (
            sha256_file(receipt_path) != result["receiptFileSha256"]
            or receipt["receiptSha256"] != result["receiptBindingSha256"]
            or result["removedAnchors"] != expected_removed
            or result["preservedAnchors"] != expected_preserved
            or result["completedSteps"]
            != [
                step
                for step in anchor_unenroll_steps(receipt)
                if step != "remove-retainedRecoveryProgram"
            ]
        ):
            fail("anchor-cleanup receipt differs from its result binding")
    elif not receipt_removed and not receipt_current:
        fail("anchor-cleanup receipt disappeared before its write-ahead step")

    authority = result["continuationAuthority"]
    unit = Path(authority["unitPath"])
    wants = Path(authority["wantsLink"])
    state_value = result["continuationState"]
    if state_value in {"enabled", "disabled"}:
        if unit.exists() or unit.is_symlink():
            validate_regular(
                unit,
                label="anchor-cleanup continuation unit",
                digest=authority["unitSha256"],
                uid=authority["desiredUid"],
                gid=authority["desiredGid"],
                mode=int(authority["desiredMode"], 8),
                single_link=True,
            )
        elif not (
            state_value == "disabled"
            and result["currentCleanupStep"]
            == "remove-continuation-unit"
        ):
            fail("anchor-cleanup continuation unit disappeared early")
    elif unit.exists() or unit.is_symlink():
        fail("removed anchor-cleanup continuation unit reappeared")
    enabled = query_unit_state("is-enabled", authority["service"])
    if state_value == "enabled":
        if result["currentCleanupStep"] == "disable-continuation-service":
            allowed = {
                ("enabled", 0),
                ("disabled", 1),
                ("not-found", 1),
                ("not-found", 4),
            }
        else:
            allowed = {("enabled", 0)}
        if (enabled["state"], enabled["returnCode"]) not in allowed:
            fail("anchor-cleanup continuation enabled state is invalid")
        if (enabled["state"], enabled["returnCode"]) == ("enabled", 0):
            if capture_wants_link(wants, expected_unit=unit) is None:
                fail("enabled anchor-cleanup continuation lacks its wants link")
    else:
        if (enabled["state"], enabled["returnCode"]) not in {
            ("disabled", 1),
            ("not-found", 1),
            ("not-found", 4),
        }:
            fail("anchor-cleanup continuation was not disabled")
        if wants.exists() or wants.is_symlink():
            fail("disabled anchor-cleanup continuation kept its wants link")

    retained = result["retainedRecoveryProgram"]
    target = Path(retained["target"])
    retained_removed = (
        "remove-retainedRecoveryProgram"
        in result["completedCleanupSteps"]
    )
    retained_current = (
        result["currentCleanupStep"] == "remove-retainedRecoveryProgram"
    )
    if retained["createdFromAbsence"]:
        if target.exists() or target.is_symlink():
            if retained_removed:
                fail("completed retained-program cleanup left the file present")
            validate_regular(
                target,
                label="anchor-cleanup retained recovery program",
                digest=retained["sha256"],
                uid=retained["uid"],
                gid=retained["gid"],
                mode=int(retained["mode"], 8),
                single_link=True,
            )
        elif not retained_removed and not retained_current:
            fail("retained program disappeared before its write-ahead step")
    else:
        validate_anchor_identity(
            target,
            retained["predecessor"],
            label="preserved retained recovery program",
        )


def execute_anchor_cleanup_step(
    step: str,
    result: dict[str, Any],
    *,
    resumed: bool,
) -> None:
    authority = result["continuationAuthority"]
    unit = Path(authority["unitPath"])
    wants = Path(authority["wantsLink"])
    if step == "remove-anchor-receipt":
        receipt = Path(result["receiptPath"])
        if receipt.exists() or receipt.is_symlink():
            document = read_anchor_document(receipt, intent=False)
            if (
                sha256_file(receipt) != result["receiptFileSha256"]
                or document["receiptSha256"]
                != result["receiptBindingSha256"]
            ):
                fail("removable anchor receipt differs from cleanup binding")
            remove_durable(receipt)
        elif not resumed:
            fail("anchor receipt disappeared before cleanup mutation")
        return
    if step == "disable-continuation-service":
        enabled = query_unit_state("is-enabled", authority["service"])
        if (enabled["state"], enabled["returnCode"]) == ("enabled", 0):
            run_systemctl(["disable", authority["service"]])
        elif not resumed or (
            enabled["state"],
            enabled["returnCode"],
        ) not in {
            ("disabled", 1),
            ("not-found", 1),
            ("not-found", 4),
        }:
            fail("anchor-cleanup continuation disable state is invalid")
        if wants.exists() or wants.is_symlink():
            fail("anchor-cleanup continuation wants link survived disablement")
        if wants.parent.exists():
            fsync_directory(wants.parent)
        return
    if step == "remove-continuation-unit":
        if unit.exists() or unit.is_symlink():
            validate_regular(
                unit,
                label="removable anchor-cleanup continuation unit",
                digest=authority["unitSha256"],
                uid=authority["desiredUid"],
                gid=authority["desiredGid"],
                mode=int(authority["desiredMode"], 8),
                single_link=True,
            )
            remove_durable(unit)
        elif not resumed:
            fail("continuation unit disappeared before cleanup mutation")
        return
    if step == "reload-systemd-after-continuation":
        run_systemctl(["daemon-reload"])
        enabled = query_unit_state("is-enabled", authority["service"])
        if (enabled["state"], enabled["returnCode"]) not in {
            ("disabled", 1),
            ("not-found", 1),
            ("not-found", 4),
        }:
            fail("removed continuation retained an enabled systemd state")
        return
    if step == "remove-retainedRecoveryProgram":
        retained = result["retainedRecoveryProgram"]
        if not retained["createdFromAbsence"]:
            fail("refusing to remove a preserved retained program")
        target = Path(retained["target"])
        if target.exists() or target.is_symlink():
            validate_regular(
                target,
                label="removable retained recovery program",
                digest=retained["sha256"],
                uid=retained["uid"],
                gid=retained["gid"],
                mode=int(retained["mode"], 8),
                single_link=True,
            )
            remove_durable(target)
        elif not resumed:
            fail("retained program disappeared before cleanup mutation")
        return
    fail(f"unknown anchor-cleanup step {step}")


def resume_anchor_cleanup(result_path: Path) -> dict[str, Any]:
    result = read_anchor_cleanup_result(result_path)
    require_current_cleanup_generation(result)
    validate_anchor_cleanup_files(result)
    if result["status"] == "complete":
        return result
    for step in result["cleanupSteps"]:
        if step in result["completedCleanupSteps"]:
            continue
        resumed = result["currentCleanupStep"] == step
        if not resumed:
            if result["currentCleanupStep"] is not None:
                fail("anchor cleanup has an unfinished other step")
            result = anchor_cleanup_checkpoint(
                result_path,
                result,
                current_step=step,
            )
        execute_anchor_cleanup_step(step, result, resumed=resumed)
        maybe_crash_unenroll(f"cleanup-{step}")
        result = anchor_cleanup_checkpoint(
            result_path,
            result,
            current_step=None,
            complete_step=step,
            complete=step == result["cleanupSteps"][-1],
        )
        validate_anchor_cleanup_files(result)
    if result["status"] != "complete":
        fail("anchor cleanup exhausted its steps without a durable completion")
    return result


def remove_created_anchor(
    receipt: dict[str, Any],
    name: str,
    *,
    allow_absent: bool,
) -> None:
    anchor = next(
        value for value in receipt["anchors"] if value["name"] == name
    )
    if not anchor["createdFromAbsence"]:
        fail(f"refusing to remove preexisting recovery anchor {name}")
    target = Path(anchor["target"])
    if target.exists() or target.is_symlink():
        validate_regular(
            target,
            label=f"removable recovery anchor {name}",
            digest=anchor["desiredSha256"],
            uid=anchor["desiredUid"],
            gid=anchor["desiredGid"],
            mode=int(anchor["desiredMode"], 8),
            single_link=True,
        )
        remove_durable(target)
    elif not allow_absent:
        fail(f"recovery anchor disappeared before its write-ahead step: {name}")


def execute_anchor_unenroll_step(
    step: str,
    receipt: dict[str, Any],
    *,
    allow_resumed_absence: bool,
) -> None:
    if step.startswith("remove-"):
        name = step.removeprefix("remove-")
        remove_created_anchor(
            receipt,
            name,
            allow_absent=allow_resumed_absence,
        )
        return
    if step == "disable-recovery-service":
        enabled = query_unit_state("is-enabled", RECOVERY_SERVICE)
        if (enabled["state"], enabled["returnCode"]) == ("enabled", 0):
            run_systemctl(["disable", RECOVERY_SERVICE])
        elif (enabled["state"], enabled["returnCode"]) not in {
            ("disabled", 1),
            ("not-found", 1),
            ("not-found", 4),
        }:
            fail("recovery service has an ambiguous enabled state")
        wants = boundary_path(RECOVERY_WANTS_LINK)
        if wants.exists() or wants.is_symlink():
            fail("recovery service wants link survived disablement")
        if wants.parent.exists():
            fsync_directory(wants.parent)
        fsync_directory(anchor_targets()["recoveryUnit"].parent)
        return
    if step == "reload-systemd":
        run_systemctl(["daemon-reload"])
        enabled = query_unit_state("is-enabled", RECOVERY_SERVICE)
        if (enabled["state"], enabled["returnCode"]) not in {
            ("not-found", 1),
            ("not-found", 4),
            ("disabled", 1),
        }:
            fail("removed recovery service retained an enabled state")
        return
    fail(f"unknown anchor-unenrollment step {step}")


def is_exact_preserved_primary_invoker(
    receipt: dict[str, Any],
    observed_active: dict[str, Any],
) -> bool:
    predecessor_active = receipt["servicePredecessor"]["active"]
    if (
        predecessor_active != {"state": "inactive", "returnCode": 3}
        or observed_active != {"state": "activating", "returnCode": 0}
    ):
        return False
    invocation_id = os.environ.get("INVOCATION_ID", "")
    systemd_exec_pid = os.environ.get("SYSTEMD_EXEC_PID", "")
    if (
        re.fullmatch(r"[0-9a-f]{32}", invocation_id) is None
        or systemd_exec_pid != str(os.getpid())
    ):
        return False
    by_name = {
        anchor["name"]: anchor
        for anchor in receipt["anchors"]
    }
    retained = by_name["retainedRecoveryProgram"]
    unit_anchor = by_name["recoveryUnit"]
    if retained["createdFromAbsence"] or unit_anchor["createdFromAbsence"]:
        return False
    retained_path = Path(retained["target"])
    unit_path = Path(unit_anchor["target"])
    try:
        running = Path(__file__).resolve(strict=True)
    except OSError:
        return False
    if running != retained_path:
        return False
    validate_anchor_identity(
        retained_path,
        retained["predecessor"],
        label="active preserved primary recovery program",
    )
    validate_anchor_identity(
        unit_path,
        unit_anchor["predecessor"],
        label="active preserved primary recovery unit",
    )
    try:
        unit_text = unit_path.read_text(encoding="utf-8")
    except (OSError, UnicodeError):
        return False
    directives = [
        line.strip()
        for line in unit_text.splitlines()
        if line.strip()
        and not line.lstrip().startswith(("#", ";"))
    ]
    if (
        [line for line in directives if line.startswith("Type=")]
        != ["Type=oneshot"]
        or any(
            re.fullmatch(r"RemainAfterExit\s*=.*", line) is not None
            for line in directives
        )
    ):
        return False
    expected_exec_start = (
        f"ExecStart=/usr/bin/python3 {PRODUCTION_PROGRAM} auto-recover "
        f"--program {PRODUCTION_PROGRAM} "
    )
    exec_starts = [
        line for line in directives if line.startswith("ExecStart=")
    ]
    if (
        len(exec_starts) != 1
        or not exec_starts[0].startswith(expected_exec_start)
    ):
        return False

    def active_unit_property(name: str) -> str | None:
        observed = run_systemctl(
            [
                "show",
                RECOVERY_SERVICE,
                f"--property={name}",
                "--value",
            ],
            check=False,
            capture=True,
        )
        if observed.returncode != 0:
            return None
        try:
            value = observed.stdout.decode(
                "ascii",
                errors="strict",
            ).strip()
        except UnicodeDecodeError:
            return None
        if not value or "\n" in value or "\r" in value:
            return None
        return value

    return (
        active_unit_property("InvocationID") == invocation_id
        and active_unit_property("ExecMainPID") == str(os.getpid())
        and active_unit_property("FragmentPath") == str(unit_path)
        and active_unit_property("Type") == "oneshot"
        and active_unit_property("RemainAfterExit") == "no"
    )


def resume_anchor_unenroll(
    *,
    receipt_path: Path,
    journal_path: Path,
    result_path: Path,
    lock_descriptor: int,
    requested_ack_plan: str | None,
    requested_ack_receipt: str | None,
    new_authorization: bool,
    allow_preserved_primary_invoker: bool,
) -> None:
    del lock_descriptor
    receipt = read_anchor_document(receipt_path, intent=False)
    assert_anchor_unenroll_guards()
    plan = anchor_unenroll_plan_value(receipt_path, receipt)
    if journal_path.exists() or journal_path.is_symlink():
        journal = read_private_json(
            journal_path,
            "anchor-unenrollment journal",
            repair_exclusive_link=True,
        )
        validate_anchor_unenroll_journal(journal, journal_path, receipt)
        if requested_ack_plan is not None and requested_ack_plan != journal["ackPlan"]:
            fail("resumed anchor-unenrollment plan acknowledgment differs")
        if (
            requested_ack_receipt is not None
            and requested_ack_receipt != journal["ackReceipt"]
        ):
            fail("resumed anchor-unenrollment receipt acknowledgment differs")
    else:
        if not new_authorization:
            fail("new anchor unenrollment requires current owner authorization")
        if requested_ack_plan != plan["ackPlan"]:
            fail("anchor-unenrollment plan acknowledgment is invalid")
        if requested_ack_receipt != plan["ackReceipt"]:
            fail("anchor-unenrollment receipt acknowledgment is invalid")
        validate_anchor_current(receipt)
        continuation = capture_absent_continuation_predecessor()
        journal = {
            "schema": ANCHOR_UNENROLL_SCHEMA,
            "status": "in_progress",
            "startedAt": utc_now(),
            "updatedAt": utc_now(),
            "receiptPath": str(receipt_path),
            "receiptFileSha256": plan["receiptFileSha256"],
            "receiptBindingSha256": receipt["receiptSha256"],
            "ackPlan": plan["ackPlan"],
            "ackReceipt": plan["ackReceipt"],
            "steps": plan["steps"],
            "currentStep": None,
            "completedSteps": [],
            "sourceSha": receipt["sourceSha"],
            "archiveSha256": receipt["archiveSha256"],
            "ownerAuthorized": True,
            "continuationAuthority": continuation,
        }
        validate_anchor_unenroll_journal(journal, journal_path, receipt)
        atomic_write(journal_path, journal, exclusive=True)
    journal = ensure_continuation_authority(
        journal_path=journal_path,
        journal=journal,
        receipt=receipt,
    )
    retained_step = (
        "remove-retainedRecoveryProgram"
        if "remove-retainedRecoveryProgram" in journal["steps"]
        else None
    )
    for step in journal["steps"]:
        if step == retained_step:
            continue
        if step in journal["completedSteps"]:
            continue
        assert_continuation_authority_enabled(journal)
        resumed = journal["currentStep"] == step
        if not resumed:
            if journal["currentStep"] is not None:
                fail("anchor-unenrollment journal has an unfinished other step")
            journal = anchor_unenroll_checkpoint(
                journal_path,
                journal,
                receipt,
                current_step=step,
            )
        execute_anchor_unenroll_step(
            step,
            receipt,
            allow_resumed_absence=resumed,
        )
        maybe_crash_unenroll(step)
        journal = anchor_unenroll_checkpoint(
            journal_path,
            journal,
            receipt,
            current_step=None,
            complete_step=step,
        )
    for anchor in receipt["anchors"]:
        if not anchor["createdFromAbsence"]:
            validate_anchor_identity(
                Path(anchor["target"]),
                anchor["predecessor"],
                label=f"preserved recovery anchor {anchor['name']}",
            )
    unit_created = receipt["anchors"][2]["createdFromAbsence"]
    if unit_created:
        wants = boundary_path(RECOVERY_WANTS_LINK)
        if wants.exists() or wants.is_symlink():
            fail("recovery wants link remains after unenrollment")
        enabled = query_unit_state("is-enabled", RECOVERY_SERVICE)
        if (enabled["state"], enabled["returnCode"]) not in {
            ("not-found", 1),
            ("not-found", 4),
            ("disabled", 1),
        }:
            fail("recovery service predecessor state was not restored")
    else:
        predecessor = receipt["servicePredecessor"]
        if query_unit_state("is-enabled", RECOVERY_SERVICE) != predecessor["enabled"]:
            fail("preexisting recovery service enabled state changed")
        validate_wants_link(
            boundary_path(RECOVERY_WANTS_LINK),
            receipt["wantsLinkPredecessor"],
            exact_inode=True,
        )
        observed_active = query_unit_state("is-active", RECOVERY_SERVICE)
        if (
            observed_active != predecessor["active"]
            and not (
                allow_preserved_primary_invoker
                and is_exact_preserved_primary_invoker(
                    receipt,
                    observed_active,
                )
            )
        ):
            fail("preexisting recovery service active state changed")
    result_body = {
        "schema": ANCHOR_UNENROLL_RESULT_SCHEMA,
        "sourceSha": receipt["sourceSha"],
        "archiveSha256": receipt["archiveSha256"],
        "receiptPath": str(receipt_path),
        "receiptFileSha256": journal["receiptFileSha256"],
        "receiptBindingSha256": receipt["receiptSha256"],
        "continuationAuthority": dict(journal["continuationAuthority"]),
        "retainedRecoveryProgram": retained_cleanup_binding(receipt),
        "removedAnchors": [
            anchor["name"]
            for anchor in receipt["anchors"]
            if anchor["createdFromAbsence"]
        ],
        "preservedAnchors": [
            anchor["name"]
            for anchor in receipt["anchors"]
            if not anchor["createdFromAbsence"]
        ],
    }
    if retained_step is not None:
        if journal["steps"][-1] != retained_step:
            fail("retained recovery program is not the final anchor step")
        resumed = journal["currentStep"] == retained_step
        if not resumed:
            if journal["currentStep"] is not None:
                fail("anchor-unenrollment has an unfinished nonterminal step")
            journal = anchor_unenroll_checkpoint(
                journal_path,
                journal,
                receipt,
                current_step=retained_step,
            )
        anchor = next(
            value
            for value in receipt["anchors"]
            if value["name"] == "retainedRecoveryProgram"
        )
        validate_regular(
            Path(anchor["target"]),
            label="terminal retained recovery program",
            digest=anchor["desiredSha256"],
            uid=anchor["desiredUid"],
            gid=anchor["desiredGid"],
            mode=int(anchor["desiredMode"], 8),
            single_link=True,
        )
        # The injected crash is deliberately before the final self-removal.
        # Until the journal is removed, the retained program must remain
        # executable so boot recovery can resume.
        assert_continuation_authority_enabled(journal)
        maybe_crash_unenroll(retained_step)
    retained = result_body["retainedRecoveryProgram"]
    cleanup_steps = anchor_cleanup_steps(retained)
    prepared_at = utc_now()
    pending_result = {
        **result_body,
        "status": "cleanup_pending",
        "completedSteps": list(journal["completedSteps"]),
        "cleanupSteps": cleanup_steps,
        "currentCleanupStep": None,
        "completedCleanupSteps": [],
        "continuationState": "enabled",
        "preparedAt": prepared_at,
        "updatedAt": prepared_at,
        "completedAt": None,
        "retainedProgramRemovedLast": not retained["createdFromAbsence"],
        "continuationAuthorityRemovedAfterCommit": False,
    }
    pending_result["cleanupBindingSha256"] = cleanup_result_binding(
        pending_result
    )
    validate_anchor_cleanup_result(pending_result, result_path)
    atomic_write(result_path, pending_result, exclusive=False)
    generation = checkpoint_cleanup_generation(pending_result)
    validate_result_generation(pending_result, generation)
    assert_continuation_authority_enabled(journal)
    # Every system predecessor is restored and an independent boot authority
    # still exists. Journal removal is the durable reversal commit. Only then
    # may this active invoker disable and remove its own future boot authority.
    remove_durable(journal_path)
    maybe_crash_unenroll("after-reversal-commit")
    resume_anchor_cleanup(result_path)


def unenroll_anchors(args: argparse.Namespace) -> None:
    if (
        args.receipt != boundary_path(PRODUCTION_ANCHOR_RECEIPT)
        or args.journal
        != boundary_path(PRODUCTION_ANCHOR_UNENROLL_JOURNAL)
        or args.result != boundary_path(PRODUCTION_ANCHOR_UNENROLL_RESULT)
        or args.lock != boundary_path(PRODUCTION_LOCK)
    ):
        fail("anchor-unenrollment paths are outside the exact boundary")
    if not args.owner_authorized:
        fail("--owner-authorized is required")
    if os.environ.get("NEXUS_SONAR_OWNER_AUTHORIZED") != "1":
        fail("NEXUS_SONAR_OWNER_AUTHORIZED=1 is required")
    if not ACK_SHA256.fullmatch(str(args.ack_plan or "")):
        fail("--ack-plan must be an exact sha256 acknowledgment")
    if not ACK_SHA256.fullmatch(str(args.ack_receipt or "")):
        fail("--ack-receipt must be an exact sha256 acknowledgment")
    descriptor = acquire_lock(args.lock)
    try:
        resume_anchor_unenroll(
            receipt_path=args.receipt,
            journal_path=args.journal,
            result_path=args.result,
            lock_descriptor=descriptor,
            requested_ack_plan=args.ack_plan,
            requested_ack_receipt=args.ack_receipt,
            new_authorization=True,
            allow_preserved_primary_invoker=False,
        )
    finally:
        os.close(descriptor)


def resume_anchor_cleanup_command(args: argparse.Namespace) -> None:
    if (
        args.result != boundary_path(PRODUCTION_ANCHOR_UNENROLL_RESULT)
        or args.lock != boundary_path(PRODUCTION_LOCK)
    ):
        fail("anchor-cleanup recovery paths are outside the exact boundary")
    validate_control_root()
    descriptor = acquire_lock(args.lock)
    try:
        resume_anchor_cleanup(args.result)
    finally:
        os.close(descriptor)


def retire_anchor_cleanup_result_command(args: argparse.Namespace) -> None:
    if (
        args.result != boundary_path(PRODUCTION_ANCHOR_UNENROLL_RESULT)
        or args.archive
        != boundary_path(PRODUCTION_ANCHOR_UNENROLL_ARCHIVE)
        or args.lock != boundary_path(PRODUCTION_LOCK)
    ):
        fail("anchor-cleanup retirement paths are outside the exact boundary")
    validate_control_root()
    descriptor = acquire_lock(args.lock)
    try:
        result = read_anchor_cleanup_result(args.result)
        if result["status"] != "complete":
            fail("only a completed anchor cleanup result may be retired")
        generation = require_current_cleanup_generation(result)
        validate_anchor_cleanup_files(result)
        predecessor = generation["predecessorCleanupBindingSha256"]
        if args.archive.exists() or args.archive.is_symlink():
            archived_predecessor = read_anchor_cleanup_archive(args.archive)
            if archived_predecessor["cleanupBindingSha256"] not in {
                predecessor,
                generation["cleanupBindingSha256"],
            }:
                fail(
                    "anchor-cleanup archive is neither the exact "
                    "predecessor nor the current generation"
                )
        elif predecessor is not None:
            fail("anchor-cleanup predecessor archive is missing")
        atomic_write(args.archive, result, exclusive=False)
        archived = read_anchor_cleanup_archive(args.archive)
        if (
            archived["cleanupBindingSha256"]
            != result["cleanupBindingSha256"]
        ):
            fail("retired anchor cleanup archive binding differs")
        if (
            test_mode()
            and os.environ.get(
                "NEXUS_SONAR_INSTALL_TEST_CRASH_ANCHOR_RETIRE"
            )
            == "after-archive-write"
        ):
            os._exit(92)
        remove_durable(args.result)
    finally:
        os.close(descriptor)


def transaction_binding(journal: dict[str, Any]) -> str:
    return sha256_bytes(
        canonical_json({
            "schema": journal["schema"],
            "installTransactionId": journal["installTransactionId"],
            "sourceSha": journal["sourceSha"],
            "archiveSha256": journal["archiveSha256"],
            "recoveryProgramSha256": journal["recoveryProgramSha256"],
            "assets": journal["assets"],
        }),
    )


def validate_directory_operation_paths(
    journal: Path,
    program: Path,
    *,
    receipt: Path | None = None,
    lock: Path | None = None,
) -> None:
    if (
        journal != boundary_path(PRODUCTION_DIRECTORY_JOURNAL)
        or program != boundary_path(PRODUCTION_PROGRAM)
        or (
            receipt is not None
            and receipt != boundary_path(
                PRODUCTION_DIRECTORY_RECOVERY_RECEIPT
            )
        )
        or (lock is not None and lock != boundary_path(PRODUCTION_LOCK))
    ):
        fail("directory operation paths are outside the exact control boundary")


def checkpoint_directory(
    path: Path,
    journal: dict[str, Any],
    *,
    phase: str,
    entry: dict[str, Any] | None = None,
    recovered_index: int | None = None,
) -> dict[str, Any]:
    updated = dict(journal)
    updated["directories"] = [
        dict(value) for value in journal["directories"]
    ]
    if entry is not None:
        index = int(entry["index"])
        validate_directory_entry(entry, index)
        updated["directories"][index] = dict(entry)
    if recovered_index is not None:
        if recovered_index in updated["recoveredIndices"]:
            fail("directory recovery checkpoint is duplicated")
        updated["recoveredIndices"] = [
            *updated["recoveredIndices"],
            recovered_index,
        ]
    updated["phase"] = phase
    updated["updatedAt"] = utc_now()
    validate_directory_journal(updated, path)
    atomic_write(path, updated, exclusive=False)
    return updated


def begin_directories(args: argparse.Namespace) -> None:
    validate_directory_operation_paths(args.journal, args.program)
    validate_control_root()
    if args.journal.exists() or args.journal.is_symlink():
        fail("unfinished directory install journal already exists")
    entries = parse_directory_plan(args.plan)
    uid, gid = expected_owner()
    validate_regular(
        args.program,
        label="retained install recovery program",
        uid=uid,
        gid=gid,
        mode=0o600,
        single_link=True,
    )
    try:
        running = Path(__file__).resolve(strict=True)
    except OSError as error:
        fail(f"cannot resolve running directory transaction program: {error}")
    if running != args.program:
        fail("directory transaction must run from the retained program")
    journal = {
        "schema": DIRECTORY_SCHEMA,
        "status": "in_progress",
        "phase": "prepared",
        "startedAt": utc_now(),
        "updatedAt": utc_now(),
        "installTransactionId": args.install_transaction_id,
        "sourceSha": args.source_sha,
        "archiveSha256": args.archive_sha256,
        "recoveryProgram": str(args.program),
        "recoveryProgramSha256": sha256_file(args.program),
        "usernsMapSha256": args.userns_map_sha256,
        "planSha256": directory_plan_digest(entries),
        "planPath": str(args.plan),
        "directories": entries,
        "recoveredIndices": [],
    }
    validate_directory_journal(journal, args.journal)
    atomic_write(args.journal, journal, exclusive=True)


def maybe_crash_directory(index: int, phase: str) -> None:
    if not test_mode():
        return
    expected = os.environ.get(
        "NEXUS_SONAR_INSTALL_TEST_CRASH_DIRECTORY",
        "",
    )
    if expected == f"{phase}:{index}":
        os._exit(92)


def create_directory(args: argparse.Namespace) -> None:
    validate_directory_operation_paths(args.journal, args.program)
    journal = load_directory_journal(args.journal)
    validate_program(journal, args.program)
    if args.index < 0 or args.index >= len(journal["directories"]):
        fail("directory index is outside the exact plan")
    if any(
        entry["state"] not in {"preserved", "created"}
        for entry in journal["directories"][:args.index]
    ):
        fail("directory creation order is not sequential")
    entry = dict(journal["directories"][args.index])
    path = Path(entry["path"])
    if entry["hadDirectory"]:
        if entry["state"] == "planned":
            validate_directory(
                path,
                label=f"preserved directory {path}",
                uid=entry["predecessorUid"],
                gid=entry["predecessorGid"],
                mode=int(entry["predecessorMode"], 8),
                dev=entry["predecessorDev"],
                ino=entry["predecessorIno"],
            )
            entry["state"] = "preserved"
            checkpoint_directory(
                args.journal,
                journal,
                phase=f"preserved-{args.index}",
                entry=entry,
            )
        elif entry["state"] == "preserved":
            validate_directory(
                path,
                label=f"preserved directory {path}",
                uid=entry["predecessorUid"],
                gid=entry["predecessorGid"],
                mode=int(entry["predecessorMode"], 8),
                dev=entry["predecessorDev"],
                ino=entry["predecessorIno"],
            )
        else:
            fail("preexisting directory has an invalid creation state")
        return
    if entry["state"] == "planned":
        if path.exists() or path.is_symlink():
            fail(f"directory appeared before its write-ahead checkpoint: {path}")
        entry["state"] = "creating"
        journal = checkpoint_directory(
            args.journal,
            journal,
            phase=f"creating-{args.index}",
            entry=entry,
        )
        maybe_crash_directory(args.index, "before-mkdir")
    elif entry["state"] not in {"creating", "created"}:
        fail("new directory has an invalid creation state")
    if entry["state"] == "creating":
        parent = path.parent
        validate_directory(parent, label=f"managed directory parent {parent}")
        if path.exists() or path.is_symlink():
            validate_creating_directory(
                path,
                entry,
                label=f"resumed creating directory {path}",
            )
            if not directory_is_empty(path):
                fail(f"uncheckpointed created directory is not empty: {path}")
            try:
                os.chown(path, entry["desiredUid"], entry["desiredGid"])
                os.chmod(path, int(entry["desiredMode"], 8))
            except OSError as error:
                fail(f"cannot finish managed directory {path}: {error}")
            metadata = validate_directory(
                path,
                label=f"resumed created directory {path}",
                uid=entry["desiredUid"],
                gid=entry["desiredGid"],
                mode=int(entry["desiredMode"], 8),
            )
            fsync_directory(path)
            fsync_directory(parent)
        else:
            try:
                os.mkdir(path, int(entry["desiredMode"], 8))
                os.chown(path, entry["desiredUid"], entry["desiredGid"])
                os.chmod(path, int(entry["desiredMode"], 8))
            except OSError as error:
                fail(f"cannot create managed directory {path}: {error}")
            metadata = validate_directory(
                path,
                label=f"created directory {path}",
                uid=entry["desiredUid"],
                gid=entry["desiredGid"],
                mode=int(entry["desiredMode"], 8),
            )
            fsync_directory(path)
            fsync_directory(parent)
        maybe_crash_directory(args.index, "after-mkdir")
        entry["state"] = "created"
        entry["createdDev"] = metadata.st_dev
        entry["createdIno"] = metadata.st_ino
        checkpoint_directory(
            args.journal,
            journal,
            phase=f"created-{args.index}",
            entry=entry,
        )
    else:
        validate_directory(
            path,
            label=f"created directory {path}",
            uid=entry["desiredUid"],
            gid=entry["desiredGid"],
            mode=int(entry["desiredMode"], 8),
            dev=entry["createdDev"],
            ino=entry["createdIno"],
        )


def recover_directories(
    args: argparse.Namespace,
    *,
    lock_descriptor: int | None = None,
) -> None:
    validate_directory_operation_paths(
        args.journal,
        args.program,
        receipt=args.receipt,
        lock=args.lock,
    )
    acquired = lock_descriptor is None
    descriptor = (
        acquire_lock(args.lock)
        if acquired
        else lock_descriptor
    )
    try:
        journal = load_directory_journal(args.journal)
        validate_program(journal, args.program)
        for entry in journal["directories"]:
            path = Path(entry["path"])
            if entry["hadDirectory"]:
                validate_directory(
                    path,
                    label=f"directory predecessor {path}",
                    uid=entry["predecessorUid"],
                    gid=entry["predecessorGid"],
                    mode=int(entry["predecessorMode"], 8),
                    dev=entry["predecessorDev"],
                    ino=entry["predecessorIno"],
                )
            elif entry["state"] == "planned" and (
                path.exists() or path.is_symlink()
            ):
                fail(f"unowned directory appeared outside the transaction: {path}")
        journal = checkpoint_directory(
            args.journal,
            journal,
            phase="recovering",
        )
        for entry_value in reversed(journal["directories"]):
            entry = dict(entry_value)
            index = entry["index"]
            path = Path(entry["path"])
            if index in journal["recoveredIndices"]:
                if entry["hadDirectory"]:
                    validate_directory(
                        path,
                        label=f"preserved directory {path}",
                        uid=entry["predecessorUid"],
                        gid=entry["predecessorGid"],
                        mode=int(entry["predecessorMode"], 8),
                        dev=entry["predecessorDev"],
                        ino=entry["predecessorIno"],
                    )
                elif path.exists() or path.is_symlink():
                    fail(f"recovered directory reappeared: {path}")
                continue
            if entry["hadDirectory"]:
                validate_directory(
                    path,
                    label=f"preserved directory {path}",
                    uid=entry["predecessorUid"],
                    gid=entry["predecessorGid"],
                    mode=int(entry["predecessorMode"], 8),
                    dev=entry["predecessorDev"],
                    ino=entry["predecessorIno"],
                )
            elif entry["state"] in {"creating", "created", "recovered"}:
                if path.exists() or path.is_symlink():
                    if entry["state"] == "creating":
                        validate_creating_directory(
                            path,
                            entry,
                            label=f"transaction-creating directory {path}",
                        )
                    else:
                        validate_directory(
                            path,
                            label=f"transaction-created directory {path}",
                            uid=entry["desiredUid"],
                            gid=entry["desiredGid"],
                            mode=int(entry["desiredMode"], 8),
                            dev=entry["createdDev"],
                            ino=entry["createdIno"],
                        )
                    if not directory_is_empty(path):
                        fail(
                            f"transaction-created directory is not empty: {path}"
                        )
                    try:
                        os.rmdir(path)
                    except OSError as error:
                        fail(f"cannot remove transaction-created directory {path}: {error}")
                    fsync_directory(path.parent)
                entry["state"] = "recovered"
            elif entry["state"] == "planned":
                pass
            else:
                fail("directory recovery state is invalid")
            journal = checkpoint_directory(
                args.journal,
                journal,
                phase=f"recovered-{index}",
                entry=entry,
                recovered_index=index,
            )
            maybe_crash_directory(index, "after-recover")
        assert_systemd_safe()
        receipt = {
            "schema": DIRECTORY_RECOVERY_RECEIPT_SCHEMA,
            "status": "rolled_back",
            "recoveredAt": utc_now(),
            "installTransactionId": journal["installTransactionId"],
            "sourceSha": journal["sourceSha"],
            "archiveSha256": journal["archiveSha256"],
            "planSha256": journal["planSha256"],
            "preservedDirectories": sum(
                1 for entry in journal["directories"] if entry["hadDirectory"]
            ),
            "removedDirectories": sum(
                1
                for entry in journal["directories"]
                if not entry["hadDirectory"]
                and entry["state"] in {"creating", "created", "recovered"}
            ),
        }
        atomic_write(args.receipt, receipt, exclusive=False)
        plan_path = Path(journal["planPath"])
        remove_durable(args.journal)
        if plan_path.exists() or plan_path.is_symlink():
            remove_durable(plan_path)
    finally:
        if acquired and descriptor is not None:
            os.close(descriptor)


def complete_directories(args: argparse.Namespace) -> None:
    validate_directory_operation_paths(args.journal, args.program)
    journal = load_directory_journal(args.journal)
    validate_program(journal, args.program)
    for entry in journal["directories"]:
        path = Path(entry["path"])
        if entry["hadDirectory"]:
            if entry["state"] != "preserved":
                fail("preexisting directory lacks its preserved checkpoint")
            validate_directory(
                path,
                label=f"installed preserved directory {path}",
                uid=entry["predecessorUid"],
                gid=entry["predecessorGid"],
                mode=int(entry["predecessorMode"], 8),
                dev=entry["predecessorDev"],
                ino=entry["predecessorIno"],
            )
        else:
            if entry["state"] != "created":
                fail("new directory lacks its created checkpoint")
            validate_directory(
                path,
                label=f"installed created directory {path}",
                uid=entry["desiredUid"],
                gid=entry["desiredGid"],
                mode=int(entry["desiredMode"], 8),
                dev=entry["createdDev"],
                ino=entry["createdIno"],
            )
    journal = checkpoint_directory(
        args.journal,
        journal,
        phase="verified",
    )
    plan_path = Path(journal["planPath"])
    remove_durable(args.journal)
    if plan_path.exists() or plan_path.is_symlink():
        remove_durable(plan_path)


def validate_asset_commit_state(journal: dict[str, Any]) -> None:
    if sorted(journal["committedIndices"]) != list(
        range(len(journal["assets"]))
    ):
        fail("not every planned asset has a durable commit checkpoint")
    for asset in journal["assets"]:
        validate_regular(
            Path(asset["target"]),
            label=f"installed target {asset['target']}",
            digest=asset["desiredSha256"],
            uid=asset["desiredUid"],
            gid=asset["desiredGid"],
            mode=int(asset["desiredMode"], 8),
            single_link=True,
        )
    receipt_asset = journal["assets"][-1]
    installed_receipt_asset = {
        **receipt_asset,
        "stage": receipt_asset["target"],
    }
    validate_install_receipt(
        installed_receipt_asset,
        journal["assets"][:-1],
        source_sha=journal["sourceSha"],
        archive_sha256=journal["archiveSha256"],
    )


def validate_directory_commit_state(journal: dict[str, Any]) -> None:
    for entry in journal["directories"]:
        path = Path(entry["path"])
        if entry["hadDirectory"]:
            if entry["state"] != "preserved":
                fail("preexisting directory lacks its preserved checkpoint")
            validate_directory(
                path,
                label=f"installed preserved directory {path}",
                uid=entry["predecessorUid"],
                gid=entry["predecessorGid"],
                mode=int(entry["predecessorMode"], 8),
                dev=entry["predecessorDev"],
                ino=entry["predecessorIno"],
            )
        else:
            if entry["state"] != "created":
                fail("new directory lacks its created checkpoint")
            validate_directory(
                path,
                label=f"installed created directory {path}",
                uid=entry["desiredUid"],
                gid=entry["desiredGid"],
                mode=int(entry["desiredMode"], 8),
                dev=entry["createdDev"],
                ino=entry["createdIno"],
            )


def validate_install_commit(
    value: dict[str, Any],
    path: Path,
) -> None:
    if (
        set(value)
        != {
            "schema",
            "status",
            "installTransactionId",
            "sourceSha",
            "archiveSha256",
            "assetTransactionBindingSha256",
            "directoryPlanSha256",
            "recoveryProgramSha256",
            "committedAt",
        }
        or value.get("schema") != INSTALL_COMMIT_SCHEMA
        or value.get("status") != "committed"
        or not SHA256.fullmatch(str(value.get("installTransactionId", "")))
        or not SOURCE_SHA.fullmatch(str(value.get("sourceSha", "")))
        or not SHA256.fullmatch(str(value.get("archiveSha256", "")))
        or not SHA256.fullmatch(
            str(value.get("assetTransactionBindingSha256", ""))
        )
        or not SHA256.fullmatch(str(value.get("directoryPlanSha256", "")))
        or not SHA256.fullmatch(str(value.get("recoveryProgramSha256", "")))
        or not isinstance(value.get("committedAt"), str)
        or path != boundary_path(PRODUCTION_INSTALL_COMMIT)
    ):
        fail("Sonar install commit marker is invalid")


def finish_committed_install(
    *,
    marker: dict[str, Any],
    asset_journal_path: Path,
    directory_journal_path: Path,
    program: Path,
) -> None:
    if asset_journal_path.exists() or asset_journal_path.is_symlink():
        asset_journal = load_journal(asset_journal_path)
        validate_program(asset_journal, program)
        if (
            asset_journal["installTransactionId"]
            != marker["installTransactionId"]
            or asset_journal["sourceSha"] != marker["sourceSha"]
            or asset_journal["archiveSha256"] != marker["archiveSha256"]
            or transaction_binding(asset_journal)
            != marker["assetTransactionBindingSha256"]
        ):
            fail("asset journal differs from the committed install")
        validate_asset_commit_state(asset_journal)
        complete(argparse.Namespace(
            journal=asset_journal_path,
            program=program,
        ))
    if (
        directory_journal_path.exists()
        or directory_journal_path.is_symlink()
    ):
        directory_journal = load_directory_journal(directory_journal_path)
        validate_program(directory_journal, program)
        if (
            directory_journal["installTransactionId"]
            != marker["installTransactionId"]
            or directory_journal["sourceSha"] != marker["sourceSha"]
            or directory_journal["archiveSha256"]
            != marker["archiveSha256"]
            or directory_journal["planSha256"]
            != marker["directoryPlanSha256"]
        ):
            fail("directory journal differs from the committed install")
        validate_directory_commit_state(directory_journal)
        complete_directories(argparse.Namespace(
            journal=directory_journal_path,
            program=program,
        ))


def install_commit_matches_active(
    *,
    marker: dict[str, Any],
    asset_journal_path: Path,
    directory_journal_path: Path,
) -> bool:
    active = False
    if asset_journal_path.exists() or asset_journal_path.is_symlink():
        active = True
        asset = load_journal(asset_journal_path)
        if (
            asset["installTransactionId"] != marker["installTransactionId"]
            or asset["sourceSha"] != marker["sourceSha"]
            or asset["archiveSha256"] != marker["archiveSha256"]
            or asset["recoveryProgramSha256"]
            != marker["recoveryProgramSha256"]
            or transaction_binding(asset)
            != marker["assetTransactionBindingSha256"]
        ):
            return False
    if (
        directory_journal_path.exists()
        or directory_journal_path.is_symlink()
    ):
        active = True
        directory = load_directory_journal(directory_journal_path)
        if (
            directory["installTransactionId"]
            != marker["installTransactionId"]
            or directory["sourceSha"] != marker["sourceSha"]
            or directory["archiveSha256"] != marker["archiveSha256"]
            or directory["recoveryProgramSha256"]
            != marker["recoveryProgramSha256"]
            or directory["planSha256"] != marker["directoryPlanSha256"]
        ):
            return False
    return active


def commit_install(args: argparse.Namespace) -> None:
    if (
        args.asset_journal != boundary_path(PRODUCTION_JOURNAL)
        or args.directory_journal
        != boundary_path(PRODUCTION_DIRECTORY_JOURNAL)
        or args.program != boundary_path(PRODUCTION_PROGRAM)
        or args.marker != boundary_path(PRODUCTION_INSTALL_COMMIT)
    ):
        fail("install commit paths are outside the exact control boundary")
    asset_journal = load_journal(args.asset_journal)
    directory_journal = load_directory_journal(args.directory_journal)
    validate_program(asset_journal, args.program)
    validate_program(directory_journal, args.program)
    if (
        asset_journal["installTransactionId"]
        != directory_journal["installTransactionId"]
        or asset_journal["sourceSha"] != directory_journal["sourceSha"]
        or asset_journal["archiveSha256"]
        != directory_journal["archiveSha256"]
        or asset_journal["recoveryProgramSha256"]
        != directory_journal["recoveryProgramSha256"]
    ):
        fail("asset and directory journals bind different installs")
    validate_asset_commit_state(asset_journal)
    validate_directory_commit_state(directory_journal)
    assert_systemd_safe()
    marker = {
        "schema": INSTALL_COMMIT_SCHEMA,
        "status": "committed",
        "installTransactionId": asset_journal["installTransactionId"],
        "sourceSha": asset_journal["sourceSha"],
        "archiveSha256": asset_journal["archiveSha256"],
        "assetTransactionBindingSha256": transaction_binding(asset_journal),
        "directoryPlanSha256": directory_journal["planSha256"],
        "recoveryProgramSha256": asset_journal["recoveryProgramSha256"],
        "committedAt": utc_now(),
    }
    validate_install_commit(marker, args.marker)
    atomic_write(args.marker, marker, exclusive=False)
    finish_committed_install(
        marker=marker,
        asset_journal_path=args.asset_journal,
        directory_journal_path=args.directory_journal,
        program=args.program,
    )


def begin(args: argparse.Namespace) -> None:
    validate_operation_paths(args.journal, args.program)
    if args.journal.exists() or args.journal.is_symlink():
        fail("unfinished install journal already exists")
    entries = parse_plan(args.plan)
    if entries[-1]["kind"] != "receipt":
        fail("install plan must end with the receipt")
    validate_install_receipt(
        entries[-1],
        entries[:-1],
        source_sha=args.source_sha,
        archive_sha256=args.archive_sha256,
    )
    uid, gid = expected_owner()
    validate_regular(
        args.program,
        label="retained install recovery program",
        uid=uid,
        gid=gid,
        mode=0o600,
        single_link=True,
    )
    journal = {
        "schema": SCHEMA,
        "status": "in_progress",
        "phase": "prepared",
        "startedAt": utc_now(),
        "updatedAt": utc_now(),
        "installTransactionId": args.install_transaction_id,
        "sourceSha": args.source_sha,
        "archiveSha256": args.archive_sha256,
        "recoveryProgram": str(args.program),
        "recoveryProgramSha256": sha256_file(args.program),
        "transactionDirectory": str(args.plan.parent),
        "layoutAssetCount": len(entries) - 1,
        "assets": entries,
        "committedIndices": [],
    }
    validate_journal(journal, args.journal)
    atomic_write(args.journal, journal, exclusive=True)


def update(args: argparse.Namespace) -> None:
    validate_operation_paths(args.journal, args.program)
    journal = load_journal(args.journal)
    validate_program(journal, args.program)
    checkpoint(
        args.journal,
        journal,
        args.phase,
        committed_index=args.committed_index,
    )


def cleanup_transaction(journal: dict[str, Any]) -> None:
    for asset in journal["assets"]:
        for key in ("stage", "backup"):
            raw = asset[key]
            if raw is None:
                continue
            path = Path(raw)
            if path.exists() or path.is_symlink():
                remove_durable(path)
    transaction = Path(journal["transactionDirectory"])
    try:
        shutil.rmtree(transaction)
    except FileNotFoundError:
        return
    except OSError:
        return
    try:
        fsync_directory(transaction.parent)
    except SystemExit:
        return


def recover(
    args: argparse.Namespace,
    *,
    lock_descriptor: int | None = None,
) -> None:
    validate_operation_paths(
        args.journal,
        args.program,
        receipt=args.receipt,
        lock=args.lock,
    )
    acquired = lock_descriptor is None
    descriptor = (
        acquire_lock(args.lock)
        if acquired
        else lock_descriptor
    )
    try:
        journal = load_journal(args.journal)
        validate_program(journal, args.program)
        for asset in journal["assets"]:
            validate_recovery_state(asset)
        journal = checkpoint(args.journal, journal, "recovering")
        restored = 0
        crash_after = 0
        if test_mode():
            raw = os.environ.get(
                "NEXUS_SONAR_INSTALL_TEST_CRASH_AFTER_RESTORES",
                "0",
            )
            if not raw.isdigit():
                fail("test crash checkpoint must be numeric")
            crash_after = int(raw)
        for asset in reversed(journal["assets"]):
            restore_asset(asset)
            restored += 1
            if crash_after and restored == crash_after:
                os._exit(91)
            journal = checkpoint(
                args.journal,
                journal,
                f"recovering-{asset['index']}",
            )
        assert_systemd_safe()
        recovery_receipt = {
            "schema": RECOVERY_RECEIPT_SCHEMA,
            "status": "rolled_back",
            "recoveredAt": utc_now(),
            "installTransactionId": journal["installTransactionId"],
            "sourceSha": journal["sourceSha"],
            "archiveSha256": journal["archiveSha256"],
            "restoredAssets": journal["layoutAssetCount"],
            "transactionBindingSha256": transaction_binding(journal),
            "sonarRuntimeStarted": False,
        }
        atomic_write(args.receipt, recovery_receipt, exclusive=False)
        remove_durable(args.journal)
        cleanup_transaction(journal)
    finally:
        if acquired and descriptor is not None:
            os.close(descriptor)


def complete(args: argparse.Namespace) -> None:
    validate_operation_paths(args.journal, args.program)
    journal = load_journal(args.journal)
    validate_program(journal, args.program)
    validate_asset_commit_state(journal)
    assert_systemd_safe()
    checkpoint(args.journal, journal, "verified")
    # Journal removal is the durable commit point. Any later debris is bounded
    # to digest-verified stage/backup files and cannot trigger a rollback.
    remove_durable(args.journal)
    cleanup_transaction(journal)


def auto_recover(args: argparse.Namespace) -> None:
    if (
        args.program != boundary_path(PRODUCTION_PROGRAM)
        or args.lock != boundary_path(PRODUCTION_LOCK)
        or args.asset_journal != boundary_path(PRODUCTION_JOURNAL)
        or args.asset_receipt != boundary_path(PRODUCTION_RECOVERY_RECEIPT)
        or args.directory_journal
        != boundary_path(PRODUCTION_DIRECTORY_JOURNAL)
        or args.directory_receipt
        != boundary_path(PRODUCTION_DIRECTORY_RECOVERY_RECEIPT)
        or args.anchor_intent != boundary_path(PRODUCTION_ANCHOR_INTENT)
        or args.anchor_receipt != boundary_path(PRODUCTION_ANCHOR_RECEIPT)
        or args.unenroll_journal
        != boundary_path(PRODUCTION_ANCHOR_UNENROLL_JOURNAL)
        or args.unenroll_result
        != boundary_path(PRODUCTION_ANCHOR_UNENROLL_RESULT)
        or args.install_commit != boundary_path(PRODUCTION_INSTALL_COMMIT)
    ):
        fail("automatic recovery paths are outside the exact control boundary")
    validate_control_root()
    uid, gid = expected_owner()
    validate_regular(
        args.program,
        label="retained automatic recovery program",
        uid=uid,
        gid=gid,
        mode=0o600,
        single_link=True,
    )
    try:
        running = Path(__file__).resolve(strict=True)
    except OSError as error:
        fail(f"cannot resolve automatic recovery program: {error}")
    if running != args.program:
        fail("automatic recovery must run from the retained program")
    descriptor = acquire_lock(args.lock)
    try:
        if args.unenroll_journal.exists() or args.unenroll_journal.is_symlink():
            resume_anchor_unenroll(
                receipt_path=args.anchor_receipt,
                journal_path=args.unenroll_journal,
                result_path=args.unenroll_result,
                lock_descriptor=descriptor,
                requested_ack_plan=None,
                requested_ack_receipt=None,
                new_authorization=False,
                allow_preserved_primary_invoker=True,
            )
            return
        if args.unenroll_result.exists() or args.unenroll_result.is_symlink():
            cleanup_result = read_anchor_cleanup_result(
                args.unenroll_result
            )
            if cleanup_result["status"] == "cleanup_pending":
                resume_anchor_cleanup(args.unenroll_result)
                return
        if args.anchor_intent.exists() or args.anchor_intent.is_symlink():
            intent = read_anchor_document(args.anchor_intent, intent=True)
            enroll_anchors(argparse.Namespace(
                intent=args.anchor_intent,
                receipt=args.anchor_receipt,
                source_root=Path(intent["sourceRoot"]),
                source_sha=intent["sourceSha"],
                archive_sha256=intent["archiveSha256"],
            ))
        if args.install_commit.exists() or args.install_commit.is_symlink():
            marker = read_private_json(
                args.install_commit,
                "Sonar install commit marker",
            )
            validate_install_commit(marker, args.install_commit)
            if install_commit_matches_active(
                marker=marker,
                asset_journal_path=args.asset_journal,
                directory_journal_path=args.directory_journal,
            ):
                finish_committed_install(
                    marker=marker,
                    asset_journal_path=args.asset_journal,
                    directory_journal_path=args.directory_journal,
                    program=args.program,
                )
                return
        if args.asset_journal.exists() or args.asset_journal.is_symlink():
            recover(
                argparse.Namespace(
                    journal=args.asset_journal,
                    program=args.program,
                    receipt=args.asset_receipt,
                    lock=args.lock,
                ),
                lock_descriptor=descriptor,
            )
        if (
            args.directory_journal.exists()
            or args.directory_journal.is_symlink()
        ):
            recover_directories(
                argparse.Namespace(
                    journal=args.directory_journal,
                    program=args.program,
                    receipt=args.directory_receipt,
                    lock=args.lock,
                ),
                lock_descriptor=descriptor,
            )
    finally:
        os.close(descriptor)


def main() -> None:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="operation", required=True)

    control_root_parser = subparsers.add_parser("bootstrap-control-root")
    control_root_parser.add_argument("--parent", required=True, type=Path)
    control_root_parser.add_argument("--root", required=True, type=Path)
    control_root_parser.add_argument("--intent", required=True, type=Path)
    control_root_parser.add_argument("--receipt", required=True, type=Path)
    control_root_parser.add_argument("--source-sha", required=True)
    control_root_parser.add_argument("--archive-sha256", required=True)

    enroll_parser = subparsers.add_parser("enroll-anchors")
    enroll_parser.add_argument("--intent", required=True, type=Path)
    enroll_parser.add_argument("--receipt", required=True, type=Path)
    enroll_parser.add_argument("--source-root", required=True, type=Path)
    enroll_parser.add_argument("--source-sha", required=True)
    enroll_parser.add_argument("--archive-sha256", required=True)

    directory_begin_parser = subparsers.add_parser("begin-directories")
    directory_begin_parser.add_argument("--journal", required=True, type=Path)
    directory_begin_parser.add_argument("--plan", required=True, type=Path)
    directory_begin_parser.add_argument("--program", required=True, type=Path)
    directory_begin_parser.add_argument(
        "--install-transaction-id",
        required=True,
    )
    directory_begin_parser.add_argument("--source-sha", required=True)
    directory_begin_parser.add_argument("--archive-sha256", required=True)
    directory_begin_parser.add_argument(
        "--userns-map-sha256",
        required=True,
    )

    directory_create_parser = subparsers.add_parser("create-directory")
    directory_create_parser.add_argument("--journal", required=True, type=Path)
    directory_create_parser.add_argument("--program", required=True, type=Path)
    directory_create_parser.add_argument("--index", required=True, type=int)

    directory_recover_parser = subparsers.add_parser("recover-directories")
    directory_recover_parser.add_argument(
        "--journal", required=True, type=Path
    )
    directory_recover_parser.add_argument(
        "--program", required=True, type=Path
    )
    directory_recover_parser.add_argument(
        "--receipt", required=True, type=Path
    )
    directory_recover_parser.add_argument("--lock", required=True, type=Path)

    directory_complete_parser = subparsers.add_parser("complete-directories")
    directory_complete_parser.add_argument(
        "--journal", required=True, type=Path
    )
    directory_complete_parser.add_argument(
        "--program", required=True, type=Path
    )

    install_commit_parser = subparsers.add_parser("commit-install")
    install_commit_parser.add_argument(
        "--asset-journal", required=True, type=Path
    )
    install_commit_parser.add_argument(
        "--directory-journal", required=True, type=Path
    )
    install_commit_parser.add_argument("--program", required=True, type=Path)
    install_commit_parser.add_argument("--marker", required=True, type=Path)

    begin_parser = subparsers.add_parser("begin")
    begin_parser.add_argument("--journal", required=True, type=Path)
    begin_parser.add_argument("--plan", required=True, type=Path)
    begin_parser.add_argument("--program", required=True, type=Path)
    begin_parser.add_argument("--install-transaction-id", required=True)
    begin_parser.add_argument("--source-sha", required=True)
    begin_parser.add_argument("--archive-sha256", required=True)

    checkpoint_parser = subparsers.add_parser("checkpoint")
    checkpoint_parser.add_argument("--journal", required=True, type=Path)
    checkpoint_parser.add_argument("--program", required=True, type=Path)
    checkpoint_parser.add_argument("--phase", required=True)
    checkpoint_parser.add_argument("--committed-index", type=int)

    recover_parser = subparsers.add_parser("recover")
    recover_parser.add_argument("--journal", required=True, type=Path)
    recover_parser.add_argument("--program", required=True, type=Path)
    recover_parser.add_argument("--receipt", required=True, type=Path)
    recover_parser.add_argument("--lock", required=True, type=Path)

    complete_parser = subparsers.add_parser("complete")
    complete_parser.add_argument("--journal", required=True, type=Path)
    complete_parser.add_argument("--program", required=True, type=Path)

    auto_parser = subparsers.add_parser("auto-recover")
    auto_parser.add_argument("--program", required=True, type=Path)
    auto_parser.add_argument("--lock", required=True, type=Path)
    auto_parser.add_argument("--asset-journal", required=True, type=Path)
    auto_parser.add_argument("--asset-receipt", required=True, type=Path)
    auto_parser.add_argument("--directory-journal", required=True, type=Path)
    auto_parser.add_argument("--directory-receipt", required=True, type=Path)
    auto_parser.add_argument("--anchor-intent", required=True, type=Path)
    auto_parser.add_argument("--anchor-receipt", required=True, type=Path)
    auto_parser.add_argument("--unenroll-journal", required=True, type=Path)
    auto_parser.add_argument("--unenroll-result", required=True, type=Path)
    auto_parser.add_argument("--install-commit", required=True, type=Path)

    anchor_plan_parser = subparsers.add_parser("anchor-plan")
    anchor_plan_parser.add_argument("--receipt", required=True, type=Path)
    anchor_plan_parser.add_argument("--lock", required=True, type=Path)

    anchor_validate_parser = subparsers.add_parser("validate-anchor-current")
    anchor_validate_parser.add_argument("--receipt", required=True, type=Path)

    anchor_unenroll_parser = subparsers.add_parser("anchor-unenroll")
    anchor_unenroll_parser.add_argument("--receipt", required=True, type=Path)
    anchor_unenroll_parser.add_argument("--journal", required=True, type=Path)
    anchor_unenroll_parser.add_argument("--result", required=True, type=Path)
    anchor_unenroll_parser.add_argument("--lock", required=True, type=Path)
    anchor_unenroll_parser.add_argument("--ack-plan")
    anchor_unenroll_parser.add_argument("--ack-receipt")
    anchor_unenroll_parser.add_argument(
        "--owner-authorized",
        action="store_true",
    )
    anchor_cleanup_parser = subparsers.add_parser(
        "resume-anchor-cleanup"
    )
    anchor_cleanup_parser.add_argument(
        "--result",
        required=True,
        type=Path,
    )
    anchor_cleanup_parser.add_argument(
        "--lock",
        required=True,
        type=Path,
    )
    anchor_retire_parser = subparsers.add_parser(
        "retire-anchor-cleanup-result"
    )
    anchor_retire_parser.add_argument(
        "--result",
        required=True,
        type=Path,
    )
    anchor_retire_parser.add_argument(
        "--archive",
        required=True,
        type=Path,
    )
    anchor_retire_parser.add_argument(
        "--lock",
        required=True,
        type=Path,
    )

    args = parser.parse_args()
    if os.geteuid() != 0 and not test_mode():
        fail("must run as root")
    if args.operation in {
        "bootstrap-control-root",
        "enroll-anchors",
        "begin-directories",
        "begin",
    }:
        if not SOURCE_SHA.fullmatch(args.source_sha):
            fail("source SHA is invalid")
        if not SHA256.fullmatch(args.archive_sha256):
            fail("archive SHA-256 is invalid")
    if args.operation == "begin-directories" and not SHA256.fullmatch(
        args.userns_map_sha256
    ):
        fail("userns map SHA-256 is invalid")
    if args.operation in {"begin-directories", "begin"} and not SHA256.fullmatch(
        args.install_transaction_id
    ):
        fail("install transaction identity is invalid")
    if args.operation == "bootstrap-control-root":
        bootstrap_control_root(args)
    elif args.operation == "enroll-anchors":
        enroll_anchors(args)
    elif args.operation == "begin-directories":
        begin_directories(args)
    elif args.operation == "create-directory":
        create_directory(args)
    elif args.operation == "recover-directories":
        recover_directories(args)
    elif args.operation == "complete-directories":
        complete_directories(args)
    elif args.operation == "commit-install":
        commit_install(args)
    elif args.operation == "begin":
        begin(args)
    elif args.operation == "checkpoint":
        update(args)
    elif args.operation == "recover":
        recover(args)
    elif args.operation == "complete":
        complete(args)
    elif args.operation == "auto-recover":
        auto_recover(args)
    elif args.operation == "anchor-plan":
        plan_anchor_unenroll(args)
    elif args.operation == "validate-anchor-current":
        validate_anchor_current_command(args)
    elif args.operation == "anchor-unenroll":
        unenroll_anchors(args)
    elif args.operation == "resume-anchor-cleanup":
        resume_anchor_cleanup_command(args)
    else:
        retire_anchor_cleanup_result_command(args)


if __name__ == "__main__":
    main()
