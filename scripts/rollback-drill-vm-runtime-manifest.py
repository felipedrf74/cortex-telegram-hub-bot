#!/usr/bin/env python3
"""Build and verify the offline rollback-drill guest runtime contract.

The helper deliberately performs no network access.  An owner prepares the
Node and PM2 inputs on a trusted Ubuntu 24.04/x86-64 builder, verifies the Node
release signature with an explicitly reviewed signer fingerprint, and signs
the resulting canonical manifest with a lab-only Ed25519 key.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import posixpath
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path, PurePosixPath
from typing import Any
from urllib.parse import urlparse


BUNDLE_SCHEMA = "nexus.rollback-drill-vm-runtime-bundle.v1"
PROVISION_SCHEMA = "nexus.rollback-drill-vm-provision.v1"
GUEST_MEASUREMENT_SCHEMA = "nexus.rollback-drill-vm-runtime-measurement.v1"
READINESS_SCHEMA = "nexus.rollback-drill-vm-runtime-readiness.v2"
PYTHON_PROVENANCE_SCHEMA = "nexus.rollback-drill-vm-python-provenance.v1"
INSTALL_RECEIPT_SCHEMA = "nexus.rollback-drill-vm-runtime-install.v1"
NODE_VERSION = "v22.23.1"
NPM_VERSION = "10.9.8"
NODE_ARCHIVE = "payload/node-v22.23.1-linux-x64.tar.xz"
NODE_ARCHIVE_ROOT = "node-v22.23.1-linux-x64"
NODE_ARCHIVE_SHA256 = (
    "9749e988f437343b7fa832c69ded82a312e41a03116d766797ac14f6f9eee578"
)
NODE_SIGNER_FINGERPRINT = "890C08DB8579162FEE0DF9DB8BEAB4DFCF555EF4"
NODE_RELEASE_KEYS_COMMIT = "b28073028e6d6855cfb53bf7fa0137599c01f967"
NODE_KEYRING_SHA256 = (
    "6030d4e0cd53330acf2ab68acd455b7ca98bb5d5975376f0b7c0892308ba2d57"
)
NODE_RELEASE_KEYS_REPOSITORY = "https://github.com/nodejs/release-keys"
NODE_INSTALL_ROOT = (
    "/opt/nexus-rollback-drill-vm/runtime/node-v22.23.1-linux-x64"
)
PM2_VERSION = "6.0.14"
PM2_INTEGRITY = (
    "sha512-wX1FiFkzuT2H/UUEA8QNXDAA9MMHDsK/3UHj6Dkd5U7kxyigKDA5gyDw78yc"
    "TQZAuGCLWyUX5FiXEuVQWafukA=="
)
PM2_PREFIX = "payload/pm2-prefix"
PM2_LOCK = "provenance/pm2/package-lock.json"
PM2_INSTALL_ROOT = "/opt/nexus-rollback-drill-vm/runtime/pm2-6.0.14"
PM2_BINARY = f"{PM2_INSTALL_ROOT}/bin/pm2"
CONTROL_ARCHIVE = "payload/control-source.tar.gz"
OWNER_PUBLIC_KEY = "manifest-owner-public-key.pem"
MANIFEST_NAME = "manifest.json"
SIGNATURE_NAME = "manifest.sig"
NODE_SHASUMS = "provenance/node/SHASUMS256.txt"
NODE_SHASUMS_SIGNATURE = "provenance/node/SHASUMS256.txt.sig"
NODE_KEYRING = "provenance/node/node-release-keyring.gpg"
PYTHON_PROVENANCE = "provenance/python/base-image-python.json"
PYTHON_PROVENANCE_SIGNATURE = "provenance/python/base-image-python.json.sig"
PYTHON_PROVENANCE_NAMESPACE = "nexus-rollback-drill-vm-python-provenance"
MAX_MANIFEST_BYTES = 16 * 1024 * 1024
MAX_FILE_COUNT = 50_000
MAX_FILE_BYTES = 1024 * 1024 * 1024
MAX_RECEIPT_BYTES = 512 * 1024
SAFE_TOOL_PATH = (
    "/opt/local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
    if sys.platform == "darwin"
    else "/usr/local/bin:/usr/bin:/bin"
)

HEX64 = re.compile(r"^[0-9a-f]{64}$")
FULL_SHA = re.compile(r"^[0-9a-f]{40}$")
FINGERPRINT = re.compile(r"^[0-9A-F]{40}$")
SAFE_PACKAGE = re.compile(r"^[a-z0-9][a-z0-9+.-]{0,127}$")
SAFE_VERSION = re.compile(r"^[A-Za-z0-9][A-Za-z0-9.+:~_-]{0,127}$")
PYTHON_VERSION = re.compile(r"^Python 3\.12\.[0-9]+$")
UUID = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-"
    r"[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
)
MAC = re.compile(r"^52:54:00(?::[0-9a-f]{2}){3}$")
SSH_FINGERPRINT = re.compile(r"^SHA256:[A-Za-z0-9+/]{43}$")
ISO_UTC = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")

CONTROL_FILES = (
    (
        "scripts/promotion-authorization.mjs",
        "/usr/local/libexec/nexus-promotion-authorization.mjs",
    ),
    (
        "scripts/trusted-release-runtime-attestation.mjs",
        "/usr/local/libexec/nexus-trusted-release-runtime-attestation.mjs",
    ),
    (
        "scripts/remote-promotion-transaction.sh",
        "/usr/local/libexec/nexus-release-promotion-transaction",
    ),
    (
        "scripts/remote-promotion-worker-control.sh",
        "/usr/local/sbin/nexus-release-promotion-worker-control",
    ),
    (
        "scripts/remote-promotion-control.sh",
        "/usr/local/sbin/nexus-release-promotion-control",
    ),
    (
        "scripts/systemd/nexus-release-promotion@.service",
        "/etc/systemd/system/nexus-release-promotion@.service",
    ),
    (
        "scripts/systemd/nexus-release-promotion-recovery.service",
        "/etc/systemd/system/nexus-release-promotion-recovery.service",
    ),
)
BOOTSTRAP_FILES = (
    (
        "scripts/rollback-drill-vm-runtime-manifest.py",
        "/usr/local/libexec/nexus-rollback-drill-vm/runtime-manifest",
    ),
    (
        "scripts/rollback-drill-vm-runtime-control.sh",
        "/usr/local/sbin/nexus-rollback-drill-vm-runtime-control",
    ),
)


class ValidationError(SystemExit):
    pass


def fail(message: str) -> None:
    raise ValidationError(f"rollback drill VM runtime manifest: {message}")


def canonical_bytes(value: Any) -> bytes:
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
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def read_regular_nofollow(path: Path, limit: int, label: str) -> bytes:
    try:
        descriptor = os.open(
            path,
            os.O_RDONLY
            | getattr(os, "O_CLOEXEC", 0)
            | getattr(os, "O_NOFOLLOW", 0),
        )
    except OSError as error:
        fail(f"cannot open {label} without following links: {error}")
    try:
        before = os.fstat(descriptor)
        if (
            not stat.S_ISREG(before.st_mode)
            or before.st_nlink != 1
            or before.st_size <= 0
            or before.st_size > limit
        ):
            fail(f"{label} must be one bounded regular file")
        body = bytearray()
        while len(body) < before.st_size:
            chunk = os.read(descriptor, min(1024 * 1024, before.st_size - len(body)))
            if not chunk:
                break
            body.extend(chunk)
        after = os.fstat(descriptor)
        if (
            len(body) != before.st_size
            or (
                before.st_dev,
                before.st_ino,
                before.st_size,
                before.st_mtime_ns,
            )
            != (
                after.st_dev,
                after.st_ino,
                after.st_size,
                after.st_mtime_ns,
            )
        ):
            fail(f"{label} changed during no-follow copy")
        return bytes(body)
    finally:
        os.close(descriptor)


def open_parent_nofollow(
    root_descriptor: int,
    relative: PurePosixPath,
    label: str,
) -> tuple[int, str]:
    descriptor = os.dup(root_descriptor)
    try:
        for part in relative.parts[:-1]:
            next_descriptor = os.open(
                part,
                os.O_RDONLY
                | getattr(os, "O_CLOEXEC", 0)
                | getattr(os, "O_DIRECTORY", 0)
                | getattr(os, "O_NOFOLLOW", 0),
                dir_fd=descriptor,
            )
            current = os.fstat(next_descriptor)
            if not stat.S_ISDIR(current.st_mode):
                os.close(next_descriptor)
                fail(f"{label} parent is not a real directory")
            os.close(descriptor)
            descriptor = next_descriptor
        return descriptor, relative.name
    except OSError as error:
        os.close(descriptor)
        fail(f"cannot traverse {label} without following links: {error}")
    raise AssertionError("unreachable")


def read_regular_at(
    root_descriptor: int,
    relative_value: str,
    limit: int,
    label: str,
    *,
    allow_empty: bool = False,
) -> bytes:
    relative = safe_relative(relative_value, label)
    parent_descriptor, name = open_parent_nofollow(
        root_descriptor,
        relative,
        label,
    )
    try:
        descriptor = os.open(
            name,
            os.O_RDONLY
            | getattr(os, "O_CLOEXEC", 0)
            | getattr(os, "O_NOFOLLOW", 0),
            dir_fd=parent_descriptor,
        )
    except OSError as error:
        os.close(parent_descriptor)
        fail(f"cannot open {label} without following links: {error}")
    try:
        before = os.fstat(descriptor)
        minimum = 0 if allow_empty else 1
        if (
            not stat.S_ISREG(before.st_mode)
            or before.st_nlink != 1
            or before.st_size < minimum
            or before.st_size > limit
        ):
            fail(f"{label} must be one bounded regular file")
        body = bytearray()
        while len(body) < before.st_size:
            chunk = os.read(
                descriptor,
                min(1024 * 1024, before.st_size - len(body)),
            )
            if not chunk:
                break
            body.extend(chunk)
        after = os.fstat(descriptor)
        if (
            len(body) != before.st_size
            or (
                before.st_dev,
                before.st_ino,
                before.st_size,
                before.st_mtime_ns,
            )
            != (
                after.st_dev,
                after.st_ino,
                after.st_size,
                after.st_mtime_ns,
            )
        ):
            fail(f"{label} changed during no-follow read")
        return bytes(body)
    finally:
        os.close(descriptor)
        os.close(parent_descriptor)


def exact_fields(value: Any, expected: set[str], label: str) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != expected:
        fail(f"{label} fields do not match the governed schema")
    return value


def bounded_json(path: Path, label: str, limit: int = MAX_RECEIPT_BYTES) -> Any:
    try:
        body = read_regular_nofollow(path, limit, label)
        return json.loads(body.decode("utf-8", errors="strict"))
    except (UnicodeError, json.JSONDecodeError) as error:
        fail(f"cannot read {label}: {error}")


def safe_relative(value: str, label: str) -> PurePosixPath:
    candidate = PurePosixPath(value)
    if (
        not value
        or candidate.is_absolute()
        or "\\" in value
        or any(ord(character) < 32 or ord(character) == 127 for character in value)
        or any(part in {"", ".", ".."} for part in candidate.parts)
    ):
        fail(f"{label} is not a safe relative path")
    return candidate


def regular_identity(path: Path, relative: str) -> dict[str, Any]:
    file_stat = path.lstat()
    if path.is_symlink() or not path.is_file() or file_stat.st_nlink != 1:
        fail(f"bundle input is not one regular file: {relative}")
    if file_stat.st_size < 0 or file_stat.st_size > MAX_FILE_BYTES:
        fail(f"bundle input exceeds the accepted size: {relative}")
    return {
        "path": relative,
        "type": "file",
        "mode": stat.S_IMODE(file_stat.st_mode),
        "size": file_stat.st_size,
        "sha256": sha256_file(path),
    }


def symlink_identity(path: Path, relative: str, root: Path) -> dict[str, Any]:
    target = os.readlink(path)
    if (
        not target
        or os.path.isabs(target)
        or any(ord(character) < 32 or ord(character) == 127 for character in target)
    ):
        fail(f"bundle symlink target is unsafe: {relative}")
    resolved = (path.parent / target).resolve(strict=False)
    try:
        resolved.relative_to(root.resolve(strict=True))
    except ValueError:
        fail(f"bundle symlink escapes its root: {relative}")
    return {"path": relative, "type": "symlink", "target": target}


def content_tree_sha256(root: Path) -> str:
    try:
        canonical_root = root.resolve(strict=True)
    except OSError as error:
        fail(f"cannot resolve runtime content tree: {error}")
    if canonical_root != root or root.is_symlink() or not root.is_dir():
        fail("runtime content tree root must be one canonical real directory")
    records: list[dict[str, Any]] = []
    for current, directories, names in os.walk(
        canonical_root,
        topdown=True,
        followlinks=False,
    ):
        current_path = Path(current)
        directories.sort()
        names.sort()
        for directory in list(directories):
            candidate = current_path / directory
            relative = candidate.relative_to(canonical_root).as_posix()
            identity = candidate.lstat()
            if stat.S_ISLNK(identity.st_mode):
                directories.remove(directory)
                records.append(
                    symlink_identity(candidate, relative, canonical_root)
                )
            elif not stat.S_ISDIR(identity.st_mode):
                fail(f"runtime content tree contains a special path: {relative}")
            elif os.geteuid() == 0 and (
                identity.st_uid != 0 or stat.S_IMODE(identity.st_mode) & 0o022
            ):
                fail(f"runtime content tree directory is not protected: {relative}")
        for name in names:
            candidate = current_path / name
            relative = candidate.relative_to(canonical_root).as_posix()
            identity = candidate.lstat()
            if stat.S_ISLNK(identity.st_mode):
                records.append(
                    symlink_identity(candidate, relative, canonical_root)
                )
                continue
            if not stat.S_ISREG(identity.st_mode):
                fail(f"runtime content tree contains a special path: {relative}")
            if os.geteuid() == 0 and (
                identity.st_uid != 0 or stat.S_IMODE(identity.st_mode) & 0o022
            ):
                fail(f"runtime content tree file is not protected: {relative}")
            descriptor = os.open(
                candidate,
                os.O_RDONLY
                | getattr(os, "O_CLOEXEC", 0)
                | getattr(os, "O_NOFOLLOW", 0),
            )
            try:
                before = os.fstat(descriptor)
                digest = hashlib.sha256()
                copied = 0
                while True:
                    chunk = os.read(descriptor, 1024 * 1024)
                    if not chunk:
                        break
                    copied += len(chunk)
                    if copied > MAX_FILE_BYTES:
                        fail(f"runtime content tree file is too large: {relative}")
                    digest.update(chunk)
                after = os.fstat(descriptor)
                if (
                    not stat.S_ISREG(before.st_mode)
                    or copied != before.st_size
                    or (
                        before.st_dev,
                        before.st_ino,
                        before.st_size,
                        before.st_mtime_ns,
                    )
                    != (
                        after.st_dev,
                        after.st_ino,
                        after.st_size,
                        after.st_mtime_ns,
                    )
                ):
                    fail(f"runtime content tree file changed: {relative}")
            finally:
                os.close(descriptor)
            records.append(
                {
                    "path": relative,
                    "type": "file",
                    "size": before.st_size,
                    "sha256": digest.hexdigest(),
                }
            )
    return sha256_bytes(canonical_bytes(records))


def node_archive_runtime_identity(archive: Path) -> dict[str, str]:
    with tempfile.TemporaryDirectory(prefix="nexus-node-tree.") as temporary:
        destination = Path(temporary)
        try:
            with tarfile.open(archive, mode="r:xz") as handle:
                members = handle.getmembers()
                if not members:
                    fail("Node archive is empty")
                for member in members:
                    name = PurePosixPath(member.name)
                    if (
                        name.is_absolute()
                        or ".." in name.parts
                        or not name.parts
                        or name.parts[0] != NODE_ARCHIVE_ROOT
                    ):
                        fail("Node archive member escapes its exact root")
                    if member.isdev() or member.isfifo():
                        fail("Node archive contains a special file")
                    if member.issym() or member.islnk():
                        target = PurePosixPath(member.linkname)
                        if target.is_absolute():
                            fail("Node archive contains an absolute link")
                        base = name.parent if member.issym() else PurePosixPath()
                        resolved = PurePosixPath(
                            posixpath.normpath(str(base / target))
                        )
                        if (
                            ".." in resolved.parts
                            or not resolved.parts
                            or resolved.parts[0] != NODE_ARCHIVE_ROOT
                        ):
                            fail("Node archive link escapes its exact root")
                handle.extractall(destination, filter="data")
        except (OSError, tarfile.TarError) as error:
            fail(f"cannot inspect Node runtime tree: {error}")
        extracted_root = destination / NODE_ARCHIVE_ROOT
        node_binary = extracted_root / "bin/node"
        if (
            node_binary.is_symlink()
            or not node_binary.is_file()
            or not os.access(node_binary, os.X_OK)
        ):
            fail("Node archive does not contain its expected executable")
        return {
            "binarySha256": sha256_file(node_binary),
            "contentTreeSha256": content_tree_sha256(extracted_root),
        }


def content_tree_command(args: argparse.Namespace) -> None:
    if not HEX64.fullmatch(args.expected_sha256):
        fail("runtime content tree expected digest is invalid")
    observed = content_tree_sha256(Path(args.root))
    if observed != args.expected_sha256:
        fail("runtime content tree digest differs from the signed target")
    print(
        json.dumps(
            {"ok": True, "root": args.root, "contentTreeSha256": observed},
            separators=(",", ":"),
            sort_keys=True,
        )
    )


def enumerate_bundle_files(root: Path) -> list[dict[str, Any]]:
    files: list[dict[str, Any]] = []
    excluded = {MANIFEST_NAME, SIGNATURE_NAME}
    for current, directories, names in os.walk(root, topdown=True, followlinks=False):
        current_path = Path(current)
        directories.sort()
        names.sort()
        for directory in list(directories):
            candidate = current_path / directory
            relative = candidate.relative_to(root).as_posix()
            if candidate.is_symlink():
                directories.remove(directory)
                files.append(symlink_identity(candidate, relative, root))
                continue
            directory_stat = candidate.lstat()
            if not candidate.is_dir() or directory_stat.st_nlink < 1:
                fail(f"bundle directory is unsafe: {relative}")
        for name in names:
            candidate = current_path / name
            relative = candidate.relative_to(root).as_posix()
            if relative in excluded:
                continue
            safe_relative(relative, "bundle file path")
            if candidate.is_symlink():
                files.append(symlink_identity(candidate, relative, root))
            else:
                files.append(regular_identity(candidate, relative))
            if len(files) > MAX_FILE_COUNT:
                fail("bundle contains too many files")
    files.sort(key=lambda item: item["path"])
    return files


def validate_file_entries(entries: Any) -> list[dict[str, Any]]:
    if not isinstance(entries, list) or not entries or len(entries) > MAX_FILE_COUNT:
        fail("bundle file inventory is invalid")
    previous = ""
    occupied: set[str] = set()
    validated: list[dict[str, Any]] = []
    for entry in entries:
        if not isinstance(entry, dict):
            fail("bundle file identity is invalid")
        relative = entry.get("path")
        if not isinstance(relative, str):
            fail("bundle file path is invalid")
        safe_relative(relative, "bundle file path")
        if relative <= previous:
            fail("bundle file identities are duplicated or not sorted")
        if any(
            PurePosixPath(*PurePosixPath(relative).parts[:index]).as_posix()
            in occupied
            for index in range(1, len(PurePosixPath(relative).parts))
        ):
            fail(f"bundle file path descends through another file: {relative}")
        previous = relative
        occupied.add(relative)
        if entry.get("type") == "file":
            exact_fields(
                entry,
                {"path", "type", "mode", "size", "sha256"},
                "bundle regular-file identity",
            )
            if (
                type(entry["mode"]) is not int
                or entry["mode"] < 0
                or entry["mode"] > 0o777
                or entry["mode"] & 0o022
                or type(entry["size"]) is not int
                or entry["size"] < 0
                or entry["size"] > MAX_FILE_BYTES
                or not HEX64.fullmatch(entry["sha256"])
            ):
                fail(f"bundle regular-file identity is invalid: {relative}")
        elif entry.get("type") == "symlink":
            exact_fields(entry, {"path", "type", "target"}, "bundle symlink identity")
            if (
                not isinstance(entry["target"], str)
                or not entry["target"]
                or os.path.isabs(entry["target"])
                or any(
                    ord(character) < 32 or ord(character) == 127
                    for character in entry["target"]
                )
            ):
                fail(f"bundle symlink target is invalid: {relative}")
            resolved_target = PurePosixPath(
                posixpath.normpath(
                    str(PurePosixPath(relative).parent / entry["target"])
                )
            )
            if resolved_target.is_absolute() or ".." in resolved_target.parts:
                fail(f"bundle symlink target escapes its root: {relative}")
        else:
            fail(f"bundle file type is unsupported: {relative}")
        validated.append(entry)
    return validated


def verify_node_signature(
    bundle_root: Path,
    expected_fingerprint: str,
) -> dict[str, Any]:
    if expected_fingerprint != NODE_SIGNER_FINGERPRINT:
        fail("Node signer fingerprint differs from the reviewed release identity")
    checksums = bundle_root / NODE_SHASUMS
    signature = bundle_root / NODE_SHASUMS_SIGNATURE
    keyring = bundle_root / NODE_KEYRING
    for path, label in (
        (checksums, "Node checksum manifest"),
        (signature, "Node checksum signature"),
        (keyring, "Node release keyring"),
    ):
        regular_identity(path, path.relative_to(bundle_root).as_posix())
        if path.stat().st_size == 0:
            fail(f"{label} is empty")
    result = subprocess.run(
        [
            "gpgv",
            "--status-fd=1",
            "--keyring",
            str(keyring),
            str(signature),
            str(checksums),
        ],
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="strict",
        env={"PATH": SAFE_TOOL_PATH, "LC_ALL": "C"},
    )
    if result.returncode != 0:
        fail("Node checksum signature verification failed")
    valid = []
    for line in result.stdout.splitlines():
        match = re.match(r"^\[GNUPG:\] VALIDSIG ([0-9A-F]{40}) ", line)
        if match:
            valid.append(match.group(1))
    if valid != [expected_fingerprint]:
        fail("Node checksum signature did not bind the reviewed signer")

    archive = bundle_root / NODE_ARCHIVE
    archive_digest = sha256_file(archive)
    if archive_digest != NODE_ARCHIVE_SHA256:
        fail("Node archive digest differs from the reviewed v22.23.1 identity")
    npm_package_path = (
        f"{NODE_ARCHIVE_ROOT}/lib/node_modules/npm/package.json"
    )
    try:
        with tarfile.open(archive, mode="r:xz") as node_archive:
            npm_member = node_archive.getmember(npm_package_path)
            if (
                not npm_member.isfile()
                or npm_member.size <= 0
                or npm_member.size > 1024 * 1024
            ):
                fail("Node archive npm package identity is unsafe")
            extracted = node_archive.extractfile(npm_member)
            if extracted is None:
                fail("Node archive npm package identity is missing")
            npm_package = json.loads(
                extracted.read().decode("utf-8", errors="strict")
            )
    except (KeyError, OSError, tarfile.TarError, UnicodeError, json.JSONDecodeError):
        fail("cannot read npm identity from the pinned Node archive")
    if npm_package.get("name") != "npm" or npm_package.get("version") != NPM_VERSION:
        fail("pinned Node archive does not contain npm 10.9.8")
    if sha256_file(keyring) != NODE_KEYRING_SHA256:
        fail("Node release keyring differs from the reviewed source commit")
    target_lines = []
    for line_number, line in enumerate(
        checksums.read_text(encoding="utf-8", errors="strict").splitlines(),
        start=1,
    ):
        match = re.fullmatch(r"([0-9a-f]{64}) [ *](\S+)", line)
        if match is None:
            fail(f"Node checksum manifest has malformed line {line_number}")
        digest, filename = match.groups()
        if filename == Path(NODE_ARCHIVE).name:
            target_lines.append(digest)
    if target_lines != [archive_digest]:
        fail("Node archive is not bound exactly once by the signed checksums")
    return {
        "verification": "gpgv-validsig",
        "signerFingerprint": expected_fingerprint,
        "checksumsPath": NODE_SHASUMS,
        "checksumsSha256": sha256_file(checksums),
        "signaturePath": NODE_SHASUMS_SIGNATURE,
        "signatureSha256": sha256_file(signature),
        "keyringPath": NODE_KEYRING,
        "keyringSha256": sha256_file(keyring),
        "keyringSourceRepository": NODE_RELEASE_KEYS_REPOSITORY,
        "keyringSourceCommit": NODE_RELEASE_KEYS_COMMIT,
    }


def validate_pm2_lock(lock_path: Path) -> dict[str, Any]:
    lock = bounded_json(lock_path, "PM2 package lock", 8 * 1024 * 1024)
    exact_fields(
        lock,
        set(lock) if isinstance(lock, dict) else set(),
        "PM2 package lock",
    )
    lockfile_version = lock.get("lockfileVersion")
    packages = lock.get("packages")
    if lockfile_version not in {2, 3} or not isinstance(packages, dict):
        fail("PM2 package lock must use npm lockfile version 2 or 3")
    project = packages.get("")
    if (
        not isinstance(project, dict)
        or project.get("dependencies") != {"pm2": PM2_VERSION}
    ):
        fail("PM2 package lock root must bind only pm2 6.0.14")
    pm2_entries = []
    package_count = 0
    for package_path, package in packages.items():
        if package_path == "":
            continue
        if (
            not isinstance(package_path, str)
            or not package_path.startswith("node_modules/")
            or not isinstance(package, dict)
        ):
            fail("PM2 package lock contains an unsupported package entry")
        if package.get("link") is True:
            fail("PM2 package lock may not contain linked packages")
        integrity = package.get("integrity")
        resolved = package.get("resolved")
        if not isinstance(integrity, str) or not integrity.startswith("sha512-"):
            fail(f"PM2 package lock lacks SHA-512 integrity: {package_path}")
        try:
            integrity_bytes = base64.b64decode(
                integrity.removeprefix("sha512-"),
                validate=True,
            )
        except ValueError:
            fail(f"PM2 package lock has malformed SHA-512 integrity: {package_path}")
        if len(integrity_bytes) != hashlib.sha512().digest_size:
            fail(f"PM2 package lock has malformed SHA-512 integrity: {package_path}")
        if not isinstance(resolved, str):
            fail(f"PM2 package lock lacks a registry origin: {package_path}")
        parsed = urlparse(resolved)
        if (
            parsed.scheme != "https"
            or parsed.netloc != "registry.npmjs.org"
            or parsed.username is not None
            or parsed.password is not None
            or not parsed.path.startswith("/")
            or not parsed.path.endswith(".tgz")
            or parsed.params
            or parsed.query
            or parsed.fragment
        ):
            fail(f"PM2 package lock uses an unapproved origin: {package_path}")
        package_count += 1
        if package_path == "node_modules/pm2":
            pm2_entries.append(package)
    if (
        len(pm2_entries) != 1
        or pm2_entries[0].get("version") != PM2_VERSION
        or pm2_entries[0].get("integrity") != PM2_INTEGRITY
    ):
        fail("PM2 package lock does not bind exactly pm2 6.0.14")
    return {
        "lockPath": PM2_LOCK,
        "lockSha256": sha256_file(lock_path),
        "lockfileVersion": lockfile_version,
        "packageCount": package_count,
        "pm2Integrity": pm2_entries[0]["integrity"],
        "registryOrigin": "https://registry.npmjs.org",
        "allPackagesIntegrityBound": True,
    }


def validate_pm2_prefix(prefix: Path, lock_path: Path) -> None:
    if prefix.is_symlink() or not prefix.is_dir():
        fail("PM2 prefix must be one real directory")
    pm2_package = prefix / "lib/node_modules/pm2/package.json"
    package = bounded_json(pm2_package, "installed PM2 package", 1024 * 1024)
    if package.get("name") != "pm2" or package.get("version") != PM2_VERSION:
        fail("PM2 prefix does not contain pm2 6.0.14")
    binary = prefix / "bin/pm2"
    if not binary.is_symlink():
        fail("PM2 prefix binary must be a relative symlink")
    resolved = binary.resolve(strict=True)
    try:
        resolved.relative_to(prefix.resolve(strict=True))
    except ValueError:
        fail("PM2 binary symlink escapes its prefix")
    if not resolved.is_file() or not os.access(resolved, os.X_OK):
        fail("PM2 binary target is not executable")

    lock = bounded_json(lock_path, "PM2 package lock", 8 * 1024 * 1024)
    allowed = set()
    for package_path, package in lock["packages"].items():
        if isinstance(package, dict):
            version = package.get("version")
            if not isinstance(version, str) or not package_path:
                continue
            parts = PurePosixPath(package_path).parts
            try:
                last_node_modules = max(
                    index for index, part in enumerate(parts) if part == "node_modules"
                )
            except ValueError:
                continue
            name_parts = parts[last_node_modules + 1 :]
            if not name_parts:
                continue
            derived_name = (
                "/".join(name_parts[:2])
                if name_parts[0].startswith("@") and len(name_parts) >= 2
                else name_parts[0]
            )
            allowed.add((derived_name, version))
            explicit_name = package.get("name")
            if isinstance(explicit_name, str):
                allowed.add((explicit_name, version))
    installed_root = prefix / "lib/node_modules"
    for package_json in installed_root.glob("**/package.json"):
        if package_json.is_symlink():
            fail("PM2 installed package metadata may not be a symlink")
        relative_parts = package_json.relative_to(installed_root).parts
        boundary = -1
        for index, part in enumerate(relative_parts):
            if part == "node_modules":
                boundary = index
        package_parts = relative_parts[boundary + 1 :]
        if not (
            len(package_parts) == 2
            or (
                len(package_parts) == 3
                and package_parts[0].startswith("@")
            )
        ):
            continue
        value = bounded_json(package_json, "PM2 installed package metadata", 1024 * 1024)
        identity = (value.get("name"), value.get("version"))
        if identity not in allowed:
            fail(f"PM2 prefix package is absent from its lock: {package_json}")


def validate_node_entrypoints(
    node_target: Path,
    link_root: Path,
) -> list[dict[str, str]]:
    try:
        canonical_target = node_target.resolve(strict=True)
        canonical_link_root = link_root.resolve(strict=True)
    except OSError as error:
        fail(f"cannot resolve installed Node layout: {error}")
    if (
        canonical_target != node_target
        or node_target.is_symlink()
        or not node_target.is_dir()
        or canonical_link_root != link_root
        or link_root.is_symlink()
        or not link_root.is_dir()
    ):
        fail("installed Node layout roots must be canonical real directories")
    results: list[dict[str, str]] = []
    for binary in ("node", "npm", "npx", "corepack"):
        link = link_root / binary
        try:
            link_identity = link.lstat()
            immediate = os.readlink(link)
        except OSError as error:
            fail(f"installed Node link is missing or unsafe ({binary}): {error}")
        expected_immediate = str(node_target / "bin" / binary)
        if (
            not stat.S_ISLNK(link_identity.st_mode)
            or immediate != expected_immediate
        ):
            fail(f"installed Node link does not name its exact entrypoint: {binary}")
        try:
            resolved = link.resolve(strict=True)
            resolved.relative_to(canonical_target)
        except (OSError, ValueError):
            fail(f"installed Node entrypoint escapes its runtime: {binary}")
        resolved_identity = resolved.stat()
        if (
            not stat.S_ISREG(resolved_identity.st_mode)
            or not os.access(resolved, os.X_OK)
            or stat.S_IMODE(resolved_identity.st_mode) & 0o022
        ):
            fail(f"installed Node entrypoint target is unsafe: {binary}")
        if os.geteuid() == 0 and (
            link_identity.st_uid != 0 or resolved_identity.st_uid != 0
        ):
            fail(f"installed Node entrypoint is not root-owned: {binary}")
        results.append(
            {
                "name": binary,
                "link": str(link),
                "entrypoint": expected_immediate,
                "resolved": str(resolved),
            }
        )
    return results


def mapped_identities(
    source_root: Path,
    mappings: tuple[tuple[str, str], ...],
) -> list[dict[str, Any]]:
    results = []
    for source, destination in mappings:
        path = source_root / source
        identity = regular_identity(path, source)
        results.append(
            {
                "source": source,
                "destination": destination,
                "size": identity["size"],
                "sha256": identity["sha256"],
            }
        )
    return results


def control_identities(source_root: Path, source_commit: str) -> list[dict[str, Any]]:
    if not FULL_SHA.fullmatch(source_commit):
        fail("control source commit must be one full Git SHA")
    return mapped_identities(source_root, CONTROL_FILES)


def load_manifest(path: Path) -> dict[str, Any]:
    value = bounded_json(path, "runtime bundle manifest", MAX_MANIFEST_BYTES)
    return validate_manifest(value)


def validate_manifest(value: Any) -> dict[str, Any]:
    manifest = exact_fields(
        value,
        {"schema", "target", "provenance", "signing", "files"},
        "runtime bundle manifest",
    )
    if manifest["schema"] != BUNDLE_SCHEMA:
        fail("runtime bundle schema is invalid")
    target = exact_fields(
        manifest["target"],
        {"os", "node", "python", "pm2", "control"},
        "runtime bundle target",
    )
    os_target = exact_fields(
        target["os"],
        {"id", "versionId", "architecture", "baseImageSha256"},
        "runtime OS target",
    )
    if os_target != {
        "id": "ubuntu",
        "versionId": "24.04",
        "architecture": "x86_64",
        "baseImageSha256": os_target.get("baseImageSha256"),
    } or not HEX64.fullmatch(os_target["baseImageSha256"]):
        fail("runtime OS target is outside policy")
    node = exact_fields(
        target["node"],
        {
            "version",
            "archivePath",
            "archiveRoot",
            "npmVersion",
            "installRoot",
            "binarySha256",
            "contentTreeSha256",
            "links",
        },
        "Node target",
    )
    if (
        node["version"] != NODE_VERSION
        or node["archivePath"] != NODE_ARCHIVE
        or node["archiveRoot"] != NODE_ARCHIVE_ROOT
        or node["installRoot"] != NODE_INSTALL_ROOT
        or node["npmVersion"] != NPM_VERSION
        or not HEX64.fullmatch(node["binarySha256"])
        or not HEX64.fullmatch(node["contentTreeSha256"])
        or node["links"]
        != {
            "/usr/bin/corepack": f"{NODE_INSTALL_ROOT}/bin/corepack",
            "/usr/bin/node": f"{NODE_INSTALL_ROOT}/bin/node",
            "/usr/bin/npm": f"{NODE_INSTALL_ROOT}/bin/npm",
            "/usr/bin/npx": f"{NODE_INSTALL_ROOT}/bin/npx",
        }
    ):
        fail("Node target is outside policy")
    python = exact_fields(
        target["python"],
        {
            "version",
            "binaryPath",
            "binarySha256",
            "packageName",
            "packageVersion",
            "packageArchitecture",
            "source",
        },
        "Python target",
    )
    if (
        not PYTHON_VERSION.fullmatch(python["version"])
        or python["binaryPath"] != "/usr/bin/python3.12"
        or not HEX64.fullmatch(python["binarySha256"])
        or not SAFE_PACKAGE.fullmatch(python["packageName"])
        or not SAFE_VERSION.fullmatch(python["packageVersion"])
        or python["packageArchitecture"] != "amd64"
        or python["source"] != "canonical-ubuntu-noble-base-image"
    ):
        fail("Python target is outside policy")
    pm2 = exact_fields(
        target["pm2"],
        {
            "version",
            "prefixPath",
            "lockPath",
            "binaryPath",
            "installRoot",
            "binarySha256",
            "contentTreeSha256",
        },
        "PM2 target",
    )
    if pm2 != {
        "version": PM2_VERSION,
        "prefixPath": PM2_PREFIX,
        "lockPath": PM2_LOCK,
        "binaryPath": PM2_BINARY,
        "installRoot": PM2_INSTALL_ROOT,
        "binarySha256": pm2.get("binarySha256"),
        "contentTreeSha256": pm2.get("contentTreeSha256"),
    } or not all(
        HEX64.fullmatch(pm2[field])
        for field in ("binarySha256", "contentTreeSha256")
    ):
        fail("PM2 target is outside policy")
    control = exact_fields(
        target["control"],
        {
            "version",
            "sourceCommit",
            "archivePath",
            "archiveSha256",
            "bootstrapFiles",
            "files",
        },
        "promotion control target",
    )
    if (
        control["version"] != "nexus-release-promotion-control.v2"
        or not FULL_SHA.fullmatch(control["sourceCommit"])
        or control["archivePath"] != CONTROL_ARCHIVE
        or not HEX64.fullmatch(control["archiveSha256"])
        or not isinstance(control["files"], list)
        or len(control["files"]) != len(CONTROL_FILES)
        or not isinstance(control["bootstrapFiles"], list)
        or len(control["bootstrapFiles"]) != len(BOOTSTRAP_FILES)
    ):
        fail("promotion control target is invalid")
    for observed, expected in zip(
        control["bootstrapFiles"], BOOTSTRAP_FILES, strict=True
    ):
        exact_fields(
            observed,
            {"source", "destination", "size", "sha256"},
            "runtime bootstrap file identity",
        )
        if (
            (observed["source"], observed["destination"]) != expected
            or type(observed["size"]) is not int
            or observed["size"] <= 0
            or not HEX64.fullmatch(observed["sha256"])
        ):
            fail("runtime bootstrap file identity is invalid")
    for observed, expected in zip(control["files"], CONTROL_FILES, strict=True):
        exact_fields(
            observed,
            {"source", "destination", "size", "sha256"},
            "promotion control file identity",
        )
        if (
            (observed["source"], observed["destination"]) != expected
            or type(observed["size"]) is not int
            or observed["size"] <= 0
            or not HEX64.fullmatch(observed["sha256"])
        ):
            fail("promotion control file identity is invalid")

    provenance = exact_fields(
        manifest["provenance"],
        {"node", "python", "pm2"},
        "runtime provenance",
    )
    node_provenance = exact_fields(
        provenance["node"],
        {
            "verification",
            "signerFingerprint",
            "checksumsPath",
            "checksumsSha256",
            "signaturePath",
            "signatureSha256",
            "keyringPath",
            "keyringSha256",
            "keyringSourceRepository",
            "keyringSourceCommit",
        },
        "Node provenance",
    )
    if (
        node_provenance["verification"] != "gpgv-validsig"
        or node_provenance["signerFingerprint"] != NODE_SIGNER_FINGERPRINT
        or node_provenance["checksumsPath"] != NODE_SHASUMS
        or node_provenance["signaturePath"] != NODE_SHASUMS_SIGNATURE
        or node_provenance["keyringPath"] != NODE_KEYRING
        or node_provenance["keyringSha256"] != NODE_KEYRING_SHA256
        or node_provenance["keyringSourceRepository"]
        != NODE_RELEASE_KEYS_REPOSITORY
        or node_provenance["keyringSourceCommit"] != NODE_RELEASE_KEYS_COMMIT
        or any(
            not HEX64.fullmatch(node_provenance[field])
            for field in ("checksumsSha256", "signatureSha256", "keyringSha256")
        )
    ):
        fail("Node provenance is invalid")
    python_provenance = exact_fields(
        provenance["python"],
        {
            "verification",
            "namespace",
            "provenancePath",
            "provenanceSha256",
            "signaturePath",
            "signatureSha256",
            "provisionReceiptSha256",
            "guest",
            "hostKeyFingerprint",
            "hostPublicKeySha256",
        },
        "Python provenance",
    )
    if (
        python_provenance["verification"]
        != "provisioned-guest-ssh-host-key-signature"
        or python_provenance["namespace"] != PYTHON_PROVENANCE_NAMESPACE
        or python_provenance["provenancePath"] != PYTHON_PROVENANCE
        or python_provenance["signaturePath"] != PYTHON_PROVENANCE_SIGNATURE
        or any(
            not HEX64.fullmatch(python_provenance[field])
            for field in (
                "provenanceSha256",
                "signatureSha256",
                "provisionReceiptSha256",
            )
        )
        or python_provenance["guest"] not in {"guest-1", "guest-2", "guest-3"}
        or not HEX64.fullmatch(python_provenance["hostPublicKeySha256"])
        or not SSH_FINGERPRINT.fullmatch(
            python_provenance["hostKeyFingerprint"]
        )
    ):
        fail("Python provenance is invalid")
    pm2_provenance = exact_fields(
        provenance["pm2"],
        {
            "lockPath",
            "lockSha256",
            "lockfileVersion",
            "packageCount",
            "pm2Integrity",
            "registryOrigin",
            "allPackagesIntegrityBound",
        },
        "PM2 provenance",
    )
    if (
        pm2_provenance["lockPath"] != PM2_LOCK
        or not HEX64.fullmatch(pm2_provenance["lockSha256"])
        or pm2_provenance["lockfileVersion"] not in {2, 3}
        or type(pm2_provenance["packageCount"]) is not int
        or pm2_provenance["packageCount"] < 1
        or pm2_provenance["pm2Integrity"] != PM2_INTEGRITY
        or pm2_provenance["registryOrigin"] != "https://registry.npmjs.org"
        or pm2_provenance["allPackagesIntegrityBound"] is not True
    ):
        fail("PM2 provenance is invalid")
    signing = exact_fields(
        manifest["signing"],
        {"algorithm", "publicKeyPath", "publicKeySha256"},
        "bundle signing identity",
    )
    if (
        signing["algorithm"] != "ed25519"
        or signing["publicKeyPath"] != OWNER_PUBLIC_KEY
        or not HEX64.fullmatch(signing["publicKeySha256"])
    ):
        fail("bundle signing identity is invalid")
    validate_file_entries(manifest["files"])
    return manifest


def verify_bundle_files(root: Path, manifest: dict[str, Any]) -> None:
    observed = enumerate_bundle_files(root)
    if canonical_bytes(observed) != canonical_bytes(manifest["files"]):
        fail("bundle file inventory or content differs from the signed manifest")
    identities = {entry["path"]: entry for entry in observed}
    for required in (
        NODE_ARCHIVE,
        NODE_SHASUMS,
        NODE_SHASUMS_SIGNATURE,
        NODE_KEYRING,
        PYTHON_PROVENANCE,
        PYTHON_PROVENANCE_SIGNATURE,
        PM2_LOCK,
        CONTROL_ARCHIVE,
        OWNER_PUBLIC_KEY,
        "payload/pm2-prefix/bin/pm2",
        "payload/pm2-prefix/lib/node_modules/pm2/package.json",
    ):
        if required not in identities:
            fail(f"runtime bundle is missing a required input: {required}")
    signing_key = identities[OWNER_PUBLIC_KEY]
    if (
        signing_key.get("type") != "file"
        or signing_key.get("sha256") != manifest["signing"]["publicKeySha256"]
    ):
        fail("manifest signing public key identity differs from its inventory")
    if identities[NODE_ARCHIVE].get("sha256") != NODE_ARCHIVE_SHA256:
        fail("Node archive inventory differs from the reviewed v22.23.1 identity")
    if (
        identities[CONTROL_ARCHIVE].get("sha256")
        != manifest["target"]["control"]["archiveSha256"]
    ):
        fail("promotion control archive differs from its signed identity")
    node_provenance = manifest["provenance"]["node"]
    for path_field, digest_field in (
        ("checksumsPath", "checksumsSha256"),
        ("signaturePath", "signatureSha256"),
        ("keyringPath", "keyringSha256"),
    ):
        identity = identities.get(node_provenance[path_field], {})
        if identity.get("sha256") != node_provenance[digest_field]:
            fail("Node provenance differs from the bundle inventory")
    pm2_identity = identities.get(manifest["provenance"]["pm2"]["lockPath"], {})
    if pm2_identity.get("sha256") != manifest["provenance"]["pm2"]["lockSha256"]:
        fail("PM2 provenance differs from the bundle inventory")
    python_provenance = manifest["provenance"]["python"]
    for path_field, digest_field in (
        ("provenancePath", "provenanceSha256"),
        ("signaturePath", "signatureSha256"),
    ):
        identity = identities.get(python_provenance[path_field], {})
        if identity.get("sha256") != python_provenance[digest_field]:
            fail("Python provenance differs from the bundle inventory")


def parse_canonical_manifest_bytes(body: bytes) -> dict[str, Any]:
    try:
        value = json.loads(body.decode("utf-8", errors="strict"))
    except (UnicodeError, json.JSONDecodeError) as error:
        fail(f"cannot decode runtime bundle manifest: {error}")
    manifest = validate_manifest(value)
    if canonical_bytes(manifest) != body:
        fail("runtime bundle manifest is not in canonical byte form")
    return manifest


def verify_owner_signature(
    manifest_body: bytes,
    signature_body: bytes,
    public_key_body: bytes,
) -> None:
    with tempfile.TemporaryDirectory(
        prefix="nexus-runtime-signature-",
    ) as temporary:
        root = Path(temporary)
        manifest_path = root / MANIFEST_NAME
        signature_path = root / SIGNATURE_NAME
        public_key_path = root / OWNER_PUBLIC_KEY
        for path, body in (
            (manifest_path, manifest_body),
            (signature_path, signature_body),
            (public_key_path, public_key_body),
        ):
            descriptor = os.open(
                path,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                0o600,
            )
            try:
                os.write(descriptor, body)
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
        key_result = subprocess.run(
            [
                "openssl",
                "pkey",
                "-pubin",
                "-in",
                str(public_key_path),
                "-outform",
                "DER",
            ],
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            env={"PATH": SAFE_TOOL_PATH, "LC_ALL": "C"},
        )
        ed25519_spki_prefix = bytes.fromhex("302a300506032b6570032100")
        if (
            key_result.returncode != 0
            or len(key_result.stdout) != len(ed25519_spki_prefix) + 32
            or not key_result.stdout.startswith(ed25519_spki_prefix)
        ):
            fail("runtime bundle owner public key is not a valid Ed25519 key")
        signature_result = subprocess.run(
            [
                "openssl",
                "pkeyutl",
                "-verify",
                "-pubin",
                "-inkey",
                str(public_key_path),
                "-rawin",
                "-in",
                str(manifest_path),
                "-sigfile",
                str(signature_path),
            ],
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            env={"PATH": SAFE_TOOL_PATH, "LC_ALL": "C"},
        )
        if signature_result.returncode != 0:
            fail("runtime bundle owner signature is invalid")


def open_real_directory(path: Path, label: str) -> int:
    try:
        descriptor = os.open(
            path,
            os.O_RDONLY
            | getattr(os, "O_CLOEXEC", 0)
            | getattr(os, "O_DIRECTORY", 0)
            | getattr(os, "O_NOFOLLOW", 0),
        )
    except OSError as error:
        fail(f"cannot open {label} without following links: {error}")
    identity = os.fstat(descriptor)
    if not stat.S_ISDIR(identity.st_mode):
        os.close(descriptor)
        fail(f"{label} must be one real directory")
    return descriptor


def validate_protected_parent(path: Path, label: str) -> Path:
    if not path.is_absolute():
        fail(f"{label} must be an absolute path")
    try:
        resolved = path.resolve(strict=True)
    except OSError as error:
        fail(f"cannot resolve {label}: {error}")
    if resolved != path or path.is_symlink() or not path.is_dir():
        fail(f"{label} must be one canonical real directory")
    if os.geteuid() == 0:
        current = resolved
        while True:
            identity = current.lstat()
            if identity.st_uid != 0 or stat.S_IMODE(identity.st_mode) & 0o022:
                fail(f"{label} path chain is not protected: {current}")
            if current == current.parent:
                break
            current = current.parent
    return resolved


def write_captured_file(path: Path, body: bytes, mode: int) -> None:
    descriptor = os.open(
        path,
        os.O_WRONLY
        | os.O_CREAT
        | os.O_EXCL
        | getattr(os, "O_NOFOLLOW", 0),
        mode,
    )
    try:
        view = memoryview(body)
        while view:
            written = os.write(descriptor, view)
            if written <= 0:
                fail(f"cannot write staged file: {path.name}")
            view = view[written:]
        os.fchmod(descriptor, mode)
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def fsync_directory(path: Path) -> None:
    descriptor = os.open(
        path,
        os.O_RDONLY
        | getattr(os, "O_CLOEXEC", 0)
        | getattr(os, "O_DIRECTORY", 0)
        | getattr(os, "O_NOFOLLOW", 0),
    )
    try:
        identity = os.fstat(descriptor)
        if not stat.S_ISDIR(identity.st_mode):
            fail(f"cannot durably sync non-directory path: {path}")
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def fsync_tree_directories(root: Path) -> None:
    for current, _, _ in os.walk(root, topdown=False, followlinks=False):
        fsync_directory(Path(current))


def fsync_tree(root: Path) -> None:
    protected_root = validate_protected_parent(root, "runtime stage tree")
    for current, directory_names, file_names in os.walk(
        protected_root,
        topdown=True,
        followlinks=False,
    ):
        current_path = Path(current)
        for name in directory_names:
            candidate = current_path / name
            identity = candidate.lstat()
            if stat.S_ISLNK(identity.st_mode):
                continue
            if not stat.S_ISDIR(identity.st_mode):
                fail(f"runtime stage tree contains an unsupported path: {candidate}")
        for name in file_names:
            candidate = current_path / name
            identity = candidate.lstat()
            if stat.S_ISLNK(identity.st_mode):
                continue
            if not stat.S_ISREG(identity.st_mode):
                fail(f"runtime stage tree contains an unsupported path: {candidate}")
            descriptor = os.open(
                candidate,
                os.O_RDONLY
                | getattr(os, "O_CLOEXEC", 0)
                | getattr(os, "O_NOFOLLOW", 0),
            )
            try:
                before = os.fstat(descriptor)
                if (
                    not stat.S_ISREG(before.st_mode)
                    or (before.st_dev, before.st_ino, before.st_size)
                    != (identity.st_dev, identity.st_ino, identity.st_size)
                ):
                    fail(f"runtime stage file identity changed: {candidate}")
                os.fsync(descriptor)
                after = os.fstat(descriptor)
                if (
                    before.st_dev,
                    before.st_ino,
                    before.st_size,
                    before.st_mtime_ns,
                ) != (
                    after.st_dev,
                    after.st_ino,
                    after.st_size,
                    after.st_mtime_ns,
                ):
                    fail(f"runtime stage file changed while syncing: {candidate}")
            finally:
                os.close(descriptor)
    fsync_tree_directories(protected_root)


def fsync_tree_command(args: argparse.Namespace) -> None:
    fsync_tree(Path(args.root))
    print(
        json.dumps(
            {"ok": True, "root": str(Path(args.root).resolve(strict=True))},
            separators=(",", ":"),
            sort_keys=True,
        )
    )


def remove_bundle_repair(path: Path, target_parent: Path) -> None:
    if not os.path.lexists(path):
        return
    identity = path.lstat()
    if path.is_symlink() or not stat.S_ISDIR(identity.st_mode):
        fail("runtime bundle repair quarantine is unsafe")
    shutil.rmtree(path)
    fsync_directory(target_parent)


def copy_signed_regular(
    source_descriptor: int,
    destination_root: Path,
    entry: dict[str, Any],
) -> None:
    relative = safe_relative(entry["path"], "signed bundle file path")
    parent_descriptor, name = open_parent_nofollow(
        source_descriptor,
        relative,
        f"signed bundle file {entry['path']}",
    )
    try:
        descriptor = os.open(
            name,
            os.O_RDONLY
            | getattr(os, "O_CLOEXEC", 0)
            | getattr(os, "O_NOFOLLOW", 0),
            dir_fd=parent_descriptor,
        )
    except OSError as error:
        os.close(parent_descriptor)
        fail(f"cannot open signed bundle file {entry['path']}: {error}")
    destination = destination_root.joinpath(*relative.parts)
    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
    destination_descriptor: int | None = None
    try:
        before = os.fstat(descriptor)
        if (
            not stat.S_ISREG(before.st_mode)
            or before.st_nlink != 1
            or before.st_size != entry["size"]
            or stat.S_IMODE(before.st_mode) != entry["mode"]
        ):
            fail(f"signed bundle file identity changed: {entry['path']}")
        destination_descriptor = os.open(
            destination,
            os.O_WRONLY
            | os.O_CREAT
            | os.O_EXCL
            | getattr(os, "O_NOFOLLOW", 0),
            entry["mode"],
        )
        digest = hashlib.sha256()
        copied = 0
        while copied < before.st_size:
            chunk = os.read(
                descriptor,
                min(1024 * 1024, before.st_size - copied),
            )
            if not chunk:
                break
            digest.update(chunk)
            view = memoryview(chunk)
            while view:
                written = os.write(destination_descriptor, view)
                if written <= 0:
                    fail(f"cannot stage signed bundle file: {entry['path']}")
                view = view[written:]
            copied += len(chunk)
        after = os.fstat(descriptor)
        if (
            copied != before.st_size
            or digest.hexdigest() != entry["sha256"]
            or (
                before.st_dev,
                before.st_ino,
                before.st_size,
                before.st_mtime_ns,
            )
            != (
                after.st_dev,
                after.st_ino,
                after.st_size,
                after.st_mtime_ns,
            )
        ):
            fail(f"signed bundle file changed during staging: {entry['path']}")
        os.fchmod(destination_descriptor, entry["mode"])
        os.fsync(destination_descriptor)
    finally:
        if destination_descriptor is not None:
            os.close(destination_descriptor)
        os.close(descriptor)
        os.close(parent_descriptor)


def copy_signed_symlink(
    source_descriptor: int,
    destination_root: Path,
    entry: dict[str, Any],
) -> None:
    relative = safe_relative(entry["path"], "signed bundle symlink path")
    parent_descriptor, name = open_parent_nofollow(
        source_descriptor,
        relative,
        f"signed bundle symlink {entry['path']}",
    )
    try:
        before = os.stat(name, dir_fd=parent_descriptor, follow_symlinks=False)
        if not stat.S_ISLNK(before.st_mode):
            fail(f"signed bundle symlink changed type: {entry['path']}")
        target = os.readlink(name, dir_fd=parent_descriptor)
        after = os.stat(name, dir_fd=parent_descriptor, follow_symlinks=False)
        if (
            target != entry["target"]
            or (
                before.st_dev,
                before.st_ino,
                before.st_mtime_ns,
            )
            != (
                after.st_dev,
                after.st_ino,
                after.st_mtime_ns,
            )
        ):
            fail(f"signed bundle symlink changed during staging: {entry['path']}")
    except OSError as error:
        fail(f"cannot read signed bundle symlink {entry['path']}: {error}")
    finally:
        os.close(parent_descriptor)
    destination = destination_root.joinpath(*relative.parts)
    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
    os.symlink(entry["target"], destination)
    if hasattr(os, "lchown"):
        os.lchown(destination, os.geteuid(), os.getegid())


def verify_staged_signature(
    root: Path,
    expected_manifest_sha256: str,
    expected_public_key_sha256: str,
) -> dict[str, Any]:
    manifest_body = read_regular_nofollow(
        root / MANIFEST_NAME,
        MAX_MANIFEST_BYTES,
        "staged runtime bundle manifest",
    )
    signature_body = read_regular_nofollow(
        root / SIGNATURE_NAME,
        64 * 1024,
        "staged runtime bundle signature",
    )
    public_key_body = read_regular_nofollow(
        root / OWNER_PUBLIC_KEY,
        64 * 1024,
        "staged runtime bundle owner public key",
    )
    if sha256_bytes(manifest_body) != expected_manifest_sha256:
        fail("staged runtime bundle manifest digest mismatch")
    if sha256_bytes(public_key_body) != expected_public_key_sha256:
        fail("staged runtime bundle owner public-key digest mismatch")
    manifest = parse_canonical_manifest_bytes(manifest_body)
    if manifest["signing"]["publicKeySha256"] != expected_public_key_sha256:
        fail("staged runtime bundle signing identity mismatch")
    verify_owner_signature(manifest_body, signature_body, public_key_body)
    verify_bundle_files(root, manifest)
    return manifest


def stage_bundle_command(args: argparse.Namespace) -> None:
    if (
        not HEX64.fullmatch(args.expected_manifest_sha256)
        or not HEX64.fullmatch(args.expected_public_key_sha256)
    ):
        fail("staged runtime bundle expected identity is invalid")
    source_descriptor = open_real_directory(
        Path(args.source_root),
        "untrusted runtime bundle source",
    )
    try:
        manifest_body = read_regular_at(
            source_descriptor,
            MANIFEST_NAME,
            MAX_MANIFEST_BYTES,
            "runtime bundle manifest",
        )
        signature_body = read_regular_at(
            source_descriptor,
            SIGNATURE_NAME,
            64 * 1024,
            "runtime bundle signature",
        )
        public_key_body = read_regular_at(
            source_descriptor,
            OWNER_PUBLIC_KEY,
            64 * 1024,
            "runtime bundle owner public key",
        )
        if sha256_bytes(manifest_body) != args.expected_manifest_sha256:
            fail("runtime bundle manifest digest mismatch before staging")
        if sha256_bytes(public_key_body) != args.expected_public_key_sha256:
            fail("runtime bundle owner public-key digest mismatch before staging")
        manifest = parse_canonical_manifest_bytes(manifest_body)
        if (
            manifest["signing"]["publicKeySha256"]
            != args.expected_public_key_sha256
        ):
            fail("runtime bundle manifest names a different owner public key")
        verify_owner_signature(manifest_body, signature_body, public_key_body)

        target_parent = validate_protected_parent(
            Path(args.target_parent),
            "runtime bundle target parent",
        )
        target = target_parent / args.expected_manifest_sha256
        repair = target_parent / f".{args.expected_manifest_sha256}.repair"
        if os.path.lexists(target):
            if target.is_symlink() or not target.is_dir():
                fail("existing content-addressed runtime bundle target is unsafe")
            try:
                existing = verify_staged_signature(
                    target,
                    args.expected_manifest_sha256,
                    args.expected_public_key_sha256,
                )
            except ValidationError:
                if os.path.lexists(repair):
                    fail(
                        "runtime bundle target and repair quarantine are both present"
                    )
                os.rename(target, repair)
                fsync_directory(target_parent)
                existing = None
            if existing is None:
                pass
            else:
                remove_bundle_repair(repair, target_parent)
                print(
                    json.dumps(
                        {
                            "ok": True,
                            "schema": BUNDLE_SCHEMA,
                            "bundleRoot": str(target),
                            "manifestSha256": args.expected_manifest_sha256,
                            "fileCount": len(existing["files"]),
                            "alreadyPresent": True,
                        },
                        separators=(",", ":"),
                        sort_keys=True,
                    )
                )
                return
        elif os.path.lexists(repair):
            identity = repair.lstat()
            if repair.is_symlink() or not stat.S_ISDIR(identity.st_mode):
                fail("runtime bundle repair quarantine is unsafe")

        stage = Path(
            tempfile.mkdtemp(
                prefix=f".{args.expected_manifest_sha256}.stage.",
                dir=target_parent,
            )
        )
        try:
            os.chmod(stage, 0o700)
            for entry in manifest["files"]:
                if entry["type"] == "file":
                    copy_signed_regular(source_descriptor, stage, entry)
                else:
                    copy_signed_symlink(source_descriptor, stage, entry)
            write_captured_file(stage / MANIFEST_NAME, manifest_body, 0o600)
            write_captured_file(stage / SIGNATURE_NAME, signature_body, 0o600)
            verify_staged_signature(
                stage,
                args.expected_manifest_sha256,
                args.expected_public_key_sha256,
            )
            os.chmod(stage, 0o755)
            fsync_tree_directories(stage)
            if os.path.lexists(target):
                fail("content-addressed runtime bundle target appeared during staging")
            os.rename(stage, target)
            fsync_directory(target_parent)
            remove_bundle_repair(repair, target_parent)
        finally:
            if stage.exists():
                shutil.rmtree(stage)
                fsync_directory(target_parent)
        print(
            json.dumps(
                {
                    "ok": True,
                    "schema": BUNDLE_SCHEMA,
                    "bundleRoot": str(target),
                    "manifestSha256": args.expected_manifest_sha256,
                    "fileCount": len(manifest["files"]),
                    "alreadyPresent": False,
                },
                separators=(",", ":"),
                sort_keys=True,
            )
        )
    finally:
        os.close(source_descriptor)


def stage_provision_command(args: argparse.Namespace) -> None:
    if not HEX64.fullmatch(args.expected_provision_sha256):
        fail("staged provision receipt expected identity is invalid")
    body = read_regular_nofollow(
        Path(args.source),
        MAX_RECEIPT_BYTES,
        "untrusted provision receipt",
    )
    if sha256_bytes(body) != args.expected_provision_sha256:
        fail("provision receipt digest mismatch before staging")
    try:
        receipt = json.loads(body.decode("utf-8", errors="strict"))
    except (UnicodeError, json.JSONDecodeError) as error:
        fail(f"cannot decode provision receipt: {error}")
    for guest in ("guest-1", "guest-2", "guest-3"):
        provision_guest(receipt, guest)
    target_parent = validate_protected_parent(
        Path(args.target_parent),
        "provision receipt target parent",
    )
    target = target_parent / f"{args.expected_provision_sha256}.json"
    if os.path.lexists(target):
        if (
            target.is_symlink()
            or not target.is_file()
            or sha256_file(target) != args.expected_provision_sha256
        ):
            fail("existing content-addressed provision receipt target is unsafe")
        already_present = True
    else:
        stage = target_parent / (
            f".{args.expected_provision_sha256}.stage.{os.getpid()}"
        )
        if os.path.lexists(stage):
            fail("provision receipt staging path already exists")
        try:
            write_captured_file(stage, body, 0o600)
            os.rename(stage, target)
            directory_descriptor = os.open(target_parent, os.O_RDONLY)
            try:
                os.fsync(directory_descriptor)
            finally:
                os.close(directory_descriptor)
        finally:
            if os.path.lexists(stage):
                os.unlink(stage)
        already_present = False
    print(
        json.dumps(
            {
                "ok": True,
                "schema": PROVISION_SCHEMA,
                "provisionReceipt": str(target),
                "provisionReceiptSha256": args.expected_provision_sha256,
                "alreadyPresent": already_present,
            },
            separators=(",", ":"),
            sort_keys=True,
        )
    )


def provision_guest(receipt: dict[str, Any], guest_name: str) -> dict[str, Any]:
    exact_fields(
        receipt,
        {
            "schema",
            "setId",
            "image",
            "sshPublicKeySha256",
            "guestSshHostPublicKeySha256",
            "ports",
            "setDirectory",
            "runtimeReadiness",
            "hypervisor",
            "guests",
            "createdAt",
        },
        "provision receipt",
    )
    if (
        receipt["schema"] != PROVISION_SCHEMA
        or not isinstance(receipt["setId"], str)
        or not HEX64.fullmatch(receipt["setId"])
    ):
        fail("provision receipt identity is invalid")
    readiness = receipt["runtimeReadiness"]
    if readiness != {
        "status": "ssh_only_bootstrap_required",
        "drillReady": False,
        "requirements": [
            "node-22.23.1",
            "python-3.12.x",
            "pm2-6.0.14-at-/opt/nexus-rollback-drill-vm/runtime/pm2-6.0.14/bin/pm2",
            "digest-bound-offline-toolchain-evidence",
        ],
    }:
        fail("provision receipt runtime boundary is invalid")
    image = exact_fields(
        receipt["image"], {"filename", "sha256", "basePath"}, "provision image"
    )
    if (
        not isinstance(image["sha256"], str)
        or image["filename"] != "noble-server-cloudimg-amd64.img"
        or not HEX64.fullmatch(image["sha256"])
        or image["basePath"]
        != f"/var/lib/nexus-rollback-drill-vm/base/{image['sha256']}.qcow2"
        or not isinstance(receipt["sshPublicKeySha256"], str)
        or not HEX64.fullmatch(receipt["sshPublicKeySha256"])
        or not isinstance(receipt["guestSshHostPublicKeySha256"], str)
        or not HEX64.fullmatch(receipt["guestSshHostPublicKeySha256"])
        or receipt["guestSshHostPublicKeySha256"]
        == receipt["sshPublicKeySha256"]
        or receipt["setDirectory"]
        != f"/var/lib/nexus-rollback-drill-vm/sets/{receipt['setId']}"
        or not isinstance(receipt["createdAt"], str)
        or not ISO_UTC.fullmatch(receipt["createdAt"])
    ):
        fail("provision image identity is invalid")
    if (
        not isinstance(receipt["ports"], list)
        or len(receipt["ports"]) != 3
        or any(
            type(port) is not int or port < 1024 or port > 65535
            for port in receipt["ports"]
        )
        or len(set(receipt["ports"])) != 3
    ):
        fail("provision guest ports are invalid")
    hypervisor = exact_fields(
        receipt["hypervisor"],
        {
            "manager",
            "qemuBinary",
            "qemuSha256",
            "qemuVersion",
            "qemuPackage",
            "qemuPackageVersion",
            "qemuPackageArchitecture",
            "runnerPath",
            "runnerSha256",
            "hostPreflightPath",
            "hostPreflightSha256",
            "runtimeManifestPath",
            "runtimeManifestSha256",
            "runtimeControlSourcePath",
            "runtimeControlSha256",
            "runtimeReadinessPath",
            "runtimeReadinessSha256",
            "runtimeRecoveryUnitSourcePath",
            "runtimeRecoveryUnitSha256",
            "sharedMutexPath",
            "guestAdmissionLockPath",
            "hostAvailableMemoryFloorGiB",
            "hostLoad15CeilingExclusive",
            "unitTemplate",
            "unitPath",
            "unitSha256",
            "vcpus",
            "memoryMiB",
            "memorySwapMaxMiB",
            "diskBytes",
            "networkMode",
            "loopbackHost",
            "singleActiveGuest",
            "bridgeAttached",
            "tapAttached",
            "sharedFilesystemAttached",
            "hostBlockDeviceAttached",
            "productionDataAttached",
        },
        "provision hypervisor",
    )
    expected_hypervisor = {
        "manager": "qemu-systemd",
        "qemuBinary": "/usr/bin/qemu-system-x86_64",
        "runnerPath": "/usr/local/libexec/nexus-rollback-drill-vm/run",
        "hostPreflightPath": (
            "/usr/local/libexec/nexus-rollback-drill-vm/host-preflight"
        ),
        "runtimeManifestPath": (
            "/usr/local/libexec/nexus-rollback-drill-vm/runtime-manifest"
        ),
        "runtimeControlSourcePath": (
            "/usr/local/libexec/nexus-rollback-drill-vm/"
            "runtime-control-guest"
        ),
        "runtimeReadinessPath": (
            "/usr/local/libexec/nexus-rollback-drill-vm/runtime-readiness"
        ),
        "runtimeRecoveryUnitSourcePath": (
            "/usr/local/libexec/nexus-rollback-drill-vm/"
            "runtime-recovery.service"
        ),
        "sharedMutexPath": "/run/lock/nexus-release-sonar.lock",
        "guestAdmissionLockPath": (
            "/run/nexus-rollback-drill-vm/admission.lock"
        ),
        "hostAvailableMemoryFloorGiB": 25,
        "hostLoad15CeilingExclusive": 6,
        "unitTemplate": "nexus-rollback-drill-vm@.service",
        "unitPath": (
            "/etc/systemd/system/nexus-rollback-drill-vm@.service"
        ),
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
    if any(
        hypervisor.get(name) != expected
        for name, expected in expected_hypervisor.items()
    ):
        fail("provision hypervisor boundary is invalid")
    digest_fields = (
        "qemuSha256",
        "runnerSha256",
        "hostPreflightSha256",
        "runtimeManifestSha256",
        "runtimeControlSha256",
        "runtimeReadinessSha256",
        "runtimeRecoveryUnitSha256",
        "unitSha256",
    )
    if any(
        not isinstance(hypervisor.get(name), str)
        or not HEX64.fullmatch(hypervisor[name])
        for name in digest_fields
    ):
        fail("provision hypervisor digest identity is invalid")
    if (
        not re.fullmatch(
            r"QEMU emulator version [ -~]{1,230}",
            hypervisor["qemuVersion"],
        )
        or not SAFE_PACKAGE.fullmatch(hypervisor["qemuPackage"])
        or not SAFE_VERSION.fullmatch(hypervisor["qemuPackageVersion"])
        or not re.fullmatch(
            r"[a-z0-9][a-z0-9-]*",
            hypervisor["qemuPackageArchitecture"],
        )
    ):
        fail("provision QEMU package identity is invalid")
    set_material = (
        "schema=nexus.rollback-drill-vm-provision.v1\n"
        f"image={image['sha256']}\n"
        f"key={receipt['sshPublicKeySha256']}\n"
        f"hostKey={receipt['guestSshHostPublicKeySha256']}\n"
        f"ports={receipt['ports'][0]},{receipt['ports'][1]},"
        f"{receipt['ports'][2]}\n"
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
        f"qemuPackageArchitecture="
        f"{hypervisor['qemuPackageArchitecture']}\n"
    )
    if sha256_bytes(set_material.encode("utf-8")) != receipt["setId"]:
        fail("provision set identity does not bind the runtime controls")
    if guest_name not in {"guest-1", "guest-2", "guest-3"}:
        fail("guest name is outside the fixed allowlist")
    guests = receipt["guests"]
    if (
        not isinstance(guests, list)
        or len(guests) != 3
        or any(not isinstance(entry, dict) for entry in guests)
        or [entry.get("name") for entry in guests]
        != ["guest-1", "guest-2", "guest-3"]
        or not isinstance(receipt["ports"], list)
        or len(receipt["ports"]) != 3
        or any(
            type(port) is not int or port < 1024 or port > 65535
            for port in receipt["ports"]
        )
        or len(set(receipt["ports"])) != 3
    ):
        fail("provision guest inventory is invalid")
    host_key_identities: set[tuple[str, str, str]] = set()
    observed_uuids: set[str] = set()
    observed_macs: set[str] = set()
    observed_overlays: set[str] = set()
    for slot, candidate in enumerate(guests, start=1):
        exact_fields(
            candidate,
            {
                "name",
                "port",
                "unit",
                "uuid",
                "mac",
                "instanceId",
                "overlayPath",
                "overlayInitialSha256",
                "seedPath",
                "seedSha256",
                "hostPublicKey",
                "hostKeyFingerprint",
            },
            "provision guest",
        )
        expected_name = f"guest-{slot}"
        expected_root = f"{receipt['setDirectory']}/{expected_name}"
        if (
            candidate["name"] != expected_name
            or candidate["port"] != receipt["ports"][slot - 1]
            or candidate["unit"]
            != f"nexus-rollback-drill-vm@{expected_name}.service"
            or not isinstance(candidate["uuid"], str)
            or not UUID.fullmatch(candidate["uuid"])
            or not isinstance(candidate["mac"], str)
            or not MAC.fullmatch(candidate["mac"])
            or candidate["instanceId"]
            != f"nexus-rollback-drill-{expected_name}-{receipt['setId'][:16]}"
            or candidate["overlayPath"] != f"{expected_root}/root.qcow2"
            or candidate["seedPath"] != f"{expected_root}/seed.img"
            or not isinstance(candidate["overlayInitialSha256"], str)
            or not HEX64.fullmatch(candidate["overlayInitialSha256"])
            or not isinstance(candidate["seedSha256"], str)
            or not HEX64.fullmatch(candidate["seedSha256"])
            or not isinstance(candidate["hostKeyFingerprint"], str)
            or not SSH_FINGERPRINT.fullmatch(candidate["hostKeyFingerprint"])
            or not isinstance(candidate["hostPublicKey"], str)
        ):
            fail("provision guest identity is invalid")
        public_fields = candidate["hostPublicKey"].split()
        if len(public_fields) != 2 or public_fields[0] != "ssh-ed25519":
            fail("provision set host public key is invalid")
        try:
            key_bytes = base64.b64decode(public_fields[1], validate=True)
        except ValueError:
            fail("provision set host public key is invalid")
        expected_fingerprint = "SHA256:" + base64.b64encode(
            hashlib.sha256(key_bytes).digest()
        ).decode("ascii").rstrip("=")
        if expected_fingerprint != candidate["hostKeyFingerprint"]:
            fail("provision set host-key fingerprint is invalid")
        canonical_key = " ".join(public_fields)
        host_key_identities.add(
            (
                canonical_key,
                expected_fingerprint,
                sha256_bytes(canonical_key.encode("utf-8")),
            )
        )
        observed_uuids.add(candidate["uuid"])
        observed_macs.add(candidate["mac"])
        observed_overlays.add(candidate["overlayInitialSha256"])
    if (
        len(host_key_identities) != 1
        or len(observed_uuids) != 3
        or len(observed_macs) != 3
        or len(observed_overlays) != 3
    ):
        fail("provision guests must share one set host key and unique machines")
    guest = next(entry for entry in guests if entry["name"] == guest_name)
    canonical_key, fingerprint, public_key_sha256 = next(
        iter(host_key_identities)
    )
    if (
        public_key_sha256 != receipt["guestSshHostPublicKeySha256"]
        or guest["hostPublicKey"] != canonical_key
        or guest["hostKeyFingerprint"] != fingerprint
    ):
        fail("selected guest set host-key identity is invalid")
    return {**guest, "hostPublicKeySha256": public_key_sha256}


def validate_python_provenance(
    value: Any,
    receipt: dict[str, Any],
    guest_name: str,
    provision_sha256: str,
) -> dict[str, Any]:
    provenance = exact_fields(
        value,
        {
            "schema",
            "status",
            "setId",
            "guest",
            "capturedAt",
            "provisionReceiptSha256",
            "baseImageSha256",
            "machine",
            "os",
            "python",
            "networkInstallAttempted",
        },
        "guest Python provenance",
    )
    guest = provision_guest(receipt, guest_name)
    if (
        provenance["schema"] != PYTHON_PROVENANCE_SCHEMA
        or provenance["status"] != "observed_from_provisioned_base_image"
        or provenance["setId"] != receipt["setId"]
        or provenance["guest"] != guest_name
        or not ISO_UTC.fullmatch(provenance["capturedAt"])
        or provenance["provisionReceiptSha256"] != provision_sha256
        or provenance["baseImageSha256"] != receipt["image"]["sha256"]
        or provenance["networkInstallAttempted"] is not False
    ):
        fail("guest Python provenance boundary is invalid")
    machine = exact_fields(
        provenance["machine"],
        {
            "uuid",
            "instanceId",
            "sshHostKeyFingerprint",
            "sshHostPublicKeySha256",
        },
        "guest Python machine identity",
    )
    if machine != {
        "uuid": guest["uuid"],
        "instanceId": guest["instanceId"],
        "sshHostKeyFingerprint": guest["hostKeyFingerprint"],
        "sshHostPublicKeySha256": guest["hostPublicKeySha256"],
    }:
        fail("guest Python provenance machine identity differs from provision")
    if exact_fields(
        provenance["os"],
        {"id", "versionId", "architecture"},
        "guest Python OS identity",
    ) != {"id": "ubuntu", "versionId": "24.04", "architecture": "x86_64"}:
        fail("guest Python provenance OS identity is outside policy")
    python = exact_fields(
        provenance["python"],
        {
            "version",
            "binaryPath",
            "binarySha256",
            "packageName",
            "packageVersion",
            "packageArchitecture",
            "dpkgVerified",
        },
        "guest Python identity",
    )
    if (
        not PYTHON_VERSION.fullmatch(python["version"])
        or python["binaryPath"] != "/usr/bin/python3.12"
        or not HEX64.fullmatch(python["binarySha256"])
        or not SAFE_PACKAGE.fullmatch(python["packageName"])
        or not SAFE_VERSION.fullmatch(python["packageVersion"])
        or python["packageArchitecture"] != "amd64"
        or python["dpkgVerified"] is not True
    ):
        fail("guest Python identity is invalid")
    return provenance


def validate_install_receipt(
    value: Any,
    receipt: dict[str, Any],
    guest_name: str,
    provision_sha256: str,
    manifest: dict[str, Any],
    manifest_sha256: str,
) -> dict[str, Any]:
    install_receipt = exact_fields(
        value,
        {
            "schema",
            "status",
            "drillReady",
            "transactionId",
            "setId",
            "guest",
            "installedAt",
            "provisionReceiptSha256",
            "bundleManifestSha256",
            "overlayInitialSha256",
            "runtimeDigests",
            "rollback",
        },
        "runtime installation receipt",
    )
    guest = provision_guest(receipt, guest_name)
    if (
        install_receipt["schema"] != INSTALL_RECEIPT_SCHEMA
        or install_receipt["status"] != "installed"
        or install_receipt["drillReady"] is not False
        or not re.fullmatch(
            r"\d{8}T\d{6}Z-\d+-\d+",
            install_receipt["transactionId"],
        )
        or install_receipt["setId"] != receipt["setId"]
        or install_receipt["guest"] != guest_name
        or not ISO_UTC.fullmatch(install_receipt["installedAt"])
        or install_receipt["provisionReceiptSha256"] != provision_sha256
        or install_receipt["bundleManifestSha256"] != manifest_sha256
        or install_receipt["overlayInitialSha256"]
        != guest["overlayInitialSha256"]
    ):
        fail("runtime installation receipt boundary is invalid")
    expected_digests = {
        "nodeBinary": manifest["target"]["node"]["binarySha256"],
        "nodeTree": manifest["target"]["node"]["contentTreeSha256"],
        "python": manifest["target"]["python"]["binarySha256"],
        "pm2Binary": manifest["target"]["pm2"]["binarySha256"],
        "pm2Tree": manifest["target"]["pm2"]["contentTreeSha256"],
    }
    if install_receipt["runtimeDigests"] != expected_digests:
        fail("runtime installation receipt differs from the signed target")
    if install_receipt["rollback"] != {
        "nodePreviousRetained": False,
        "pm2PreviousRetained": False,
        "automaticOnInstallFailure": True,
    }:
        fail("runtime installation receipt rollback boundary is invalid")
    return install_receipt


def validate_guest_measurement(
    value: Any,
    receipt: dict[str, Any],
    guest_name: str,
    provision_sha256: str,
    manifest: dict[str, Any],
    manifest_sha256: str,
    expected_challenge: str,
) -> dict[str, Any]:
    expected_fields = {
        "schema",
        "status",
        "drillReady",
        "pendingHostOverlaySeal",
        "setId",
        "guest",
        "capturedAt",
        "provisionReceiptSha256",
        "bundleManifestSha256",
        "machine",
        "runtime",
        "control",
        "pm2DryHealth",
        "networkInstallAttempted",
        "challenge",
    }
    measurement = exact_fields(
        value,
        expected_fields,
        "guest runtime measurement",
    )
    guest = provision_guest(receipt, guest_name)
    if (
        measurement["schema"] != GUEST_MEASUREMENT_SCHEMA
        or measurement["status"] != "guest_checks_passed"
        or measurement["drillReady"] is not False
        or measurement["pendingHostOverlaySeal"] is not True
        or measurement["setId"] != receipt["setId"]
        or measurement["guest"] != guest_name
        or not ISO_UTC.fullmatch(measurement["capturedAt"])
        or measurement["provisionReceiptSha256"] != provision_sha256
        or measurement["bundleManifestSha256"] != manifest_sha256
        or measurement["networkInstallAttempted"] is not False
    ):
        fail("guest runtime measurement boundary is invalid")
    if (
        not HEX64.fullmatch(expected_challenge)
        or measurement["challenge"] != expected_challenge
    ):
        fail("guest runtime measurement challenge is invalid")
    machine = exact_fields(
        measurement["machine"],
        {
            "uuid",
            "instanceId",
            "sshHostKeyFingerprint",
            "sshHostPublicKeySha256",
        },
        "guest runtime machine identity",
    )
    if machine != {
        "uuid": guest["uuid"],
        "instanceId": guest["instanceId"],
        "sshHostKeyFingerprint": guest["hostKeyFingerprint"],
        "sshHostPublicKeySha256": guest["hostPublicKeySha256"],
    }:
        fail("guest runtime machine identity differs from provision")
    runtime = exact_fields(
        measurement["runtime"],
        {"node", "python", "pm2"},
        "guest runtime identity",
    )
    for name, fields in {
        "node": {
            "version",
            "path",
            "sha256",
            "treeSha256",
            "owner",
            "mode",
        },
        "python": {
            "version",
            "path",
            "sha256",
            "packageName",
            "packageVersion",
            "packageArchitecture",
        },
        "pm2": {
            "version",
            "path",
            "sha256",
            "treeSha256",
            "owner",
            "mode",
        },
    }.items():
        exact_fields(runtime[name], fields, f"guest {name} identity")
        if not HEX64.fullmatch(runtime[name]["sha256"]):
            fail(f"guest {name} digest is invalid")
        if name in {"node", "pm2"} and not HEX64.fullmatch(
            runtime[name]["treeSha256"]
        ):
            fail(f"guest {name} tree digest is invalid")
    if (
        runtime["node"]["version"] != NODE_VERSION
        or runtime["node"]["path"] != f"{NODE_INSTALL_ROOT}/bin/node"
        or runtime["node"]["owner"] != "root:root"
        or not re.fullmatch(r"[0-7]{3,4}", runtime["node"]["mode"])
        or int(runtime["node"]["mode"], 8) & 0o022
    ):
        fail("guest Node identity is outside policy")
    if (
        not PYTHON_VERSION.fullmatch(runtime["python"]["version"])
        or runtime["python"]["path"] != "/usr/bin/python3.12"
        or not SAFE_PACKAGE.fullmatch(runtime["python"]["packageName"])
        or not SAFE_VERSION.fullmatch(runtime["python"]["packageVersion"])
        or runtime["python"]["packageArchitecture"] != "amd64"
    ):
        fail("guest Python identity is outside policy")
    if (
        runtime["pm2"]["version"] != PM2_VERSION
        or runtime["pm2"]["path"] != PM2_BINARY
        or runtime["pm2"]["owner"] != "root:root"
        or not re.fullmatch(r"[0-7]{3,4}", runtime["pm2"]["mode"])
        or int(runtime["pm2"]["mode"], 8) & 0o022
    ):
        fail("guest PM2 identity is outside policy")
    node_target = manifest["target"]["node"]
    python_target = manifest["target"]["python"]
    pm2_target = manifest["target"]["pm2"]
    if (
        runtime["node"]["version"] != node_target["version"]
        or runtime["node"]["path"] != f"{node_target['installRoot']}/bin/node"
        or runtime["node"]["sha256"] != node_target["binarySha256"]
        or runtime["node"]["treeSha256"]
        != node_target["contentTreeSha256"]
        or runtime["python"]
        != {
            "version": python_target["version"],
            "path": python_target["binaryPath"],
            "sha256": python_target["binarySha256"],
            "packageName": python_target["packageName"],
            "packageVersion": python_target["packageVersion"],
            "packageArchitecture": python_target["packageArchitecture"],
        }
        or runtime["pm2"]["version"] != pm2_target["version"]
        or runtime["pm2"]["path"] != pm2_target["binaryPath"]
        or runtime["pm2"]["sha256"] != pm2_target["binarySha256"]
        or runtime["pm2"]["treeSha256"]
        != pm2_target["contentTreeSha256"]
    ):
        fail("guest runtime identity differs from the owner-signed manifest")
    control = exact_fields(
        measurement["control"],
        {
            "version",
            "sourceCommit",
            "files",
            "assertIdle",
            "runtimeRecovery",
        },
        "guest promotion control identity",
    )
    if (
        control["version"] != "nexus-release-promotion-control.v2"
        or not FULL_SHA.fullmatch(control["sourceCommit"])
        or control["assertIdle"] is not True
        or not isinstance(control["files"], list)
        or len(control["files"]) != len(CONTROL_FILES)
    ):
        fail("guest promotion control identity is invalid")
    for identity, expected in zip(control["files"], CONTROL_FILES, strict=True):
        exact_fields(
            identity,
            {"path", "size", "sha256", "owner", "mode"},
            "guest promotion control file",
        )
        if (
            identity["path"] != expected[1]
            or type(identity["size"]) is not int
            or identity["size"] <= 0
            or not HEX64.fullmatch(identity["sha256"])
            or identity["owner"] != "root:root"
            or not re.fullmatch(r"[0-7]{3,4}", identity["mode"])
            or int(identity["mode"], 8) & 0o022
        ):
            fail("guest promotion control file identity is invalid")
    control_target = manifest["target"]["control"]
    if (
        control["version"] != control_target["version"]
        or control["sourceCommit"] != control_target["sourceCommit"]
        or [
            (entry["path"], entry["size"], entry["sha256"])
            for entry in control["files"]
        ]
        != [
            (entry["destination"], entry["size"], entry["sha256"])
            for entry in control_target["files"]
        ]
    ):
        fail("guest promotion control differs from the owner-signed manifest")
    recovery = exact_fields(
        control["runtimeRecovery"],
        {
            "unit",
            "path",
            "sha256",
            "loadState",
            "activeState",
            "unitFileState",
            "fragmentPath",
            "dropInPaths",
            "needDaemonReload",
            "execStart",
        },
        "guest runtime recovery identity",
    )
    if recovery != {
        "unit": "nexus-rollback-drill-vm-runtime-recovery.service",
        "path": (
            "/etc/systemd/system/"
            "nexus-rollback-drill-vm-runtime-recovery.service"
        ),
        "sha256": receipt["hypervisor"]["runtimeRecoveryUnitSha256"],
        "loadState": "loaded",
        "activeState": "active",
        "unitFileState": "enabled",
        "fragmentPath": (
            "/etc/systemd/system/"
            "nexus-rollback-drill-vm-runtime-recovery.service"
        ),
        "dropInPaths": [],
        "needDaemonReload": False,
        "execStart": {
            "path": (
                "/usr/local/sbin/"
                "nexus-rollback-drill-vm-runtime-control"
            ),
            "argv": [
                (
                    "/usr/local/sbin/"
                    "nexus-rollback-drill-vm-runtime-control"
                ),
                "recover-install",
            ],
        },
    }:
        fail("guest runtime recovery unit is outside the provisioned policy")
    health = exact_fields(
        measurement["pm2DryHealth"],
        {"status", "isolatedHome", "daemonStopped", "processCount"},
        "PM2 dry health",
    )
    if health != {
        "status": "passed",
        "isolatedHome": True,
        "daemonStopped": True,
        "processCount": 0,
    }:
        fail("PM2 dry health did not pass exactly")
    return measurement


def validate_runtime_readiness(
    value: Any,
    receipt: dict[str, Any],
    guest_name: str,
    provision_sha256: str,
    manifest_sha256: str,
    measurement: dict[str, Any],
    measurement_sha256: str,
    measurement_signature_sha256: str,
    authorization: dict[str, Any],
    authorization_sha256: str,
    authorization_signature_sha256: str,
) -> dict[str, Any]:
    readiness = exact_fields(
        value,
        {
            "schema",
            "status",
            "drillReady",
            "sealedAt",
            "setId",
            "guest",
            "port",
            "provisionReceiptSha256",
            "bundleManifestSha256",
            "ownerAuthorization",
            "guestMeasurement",
            "machine",
            "qemu",
            "stoppedGuestProof",
            "overlay",
            "runtime",
            "control",
            "pm2DryHealth",
            "networkInstallAttempted",
        },
        "runtime readiness receipt",
    )
    guest = provision_guest(receipt, guest_name)
    if (
        readiness["schema"] != READINESS_SCHEMA
        or readiness["status"] != "ready"
        or readiness["drillReady"] is not True
        or not ISO_UTC.fullmatch(readiness["sealedAt"])
        or readiness["setId"] != receipt["setId"]
        or readiness["guest"] != guest_name
        or readiness["port"] != guest["port"]
        or readiness["provisionReceiptSha256"] != provision_sha256
        or readiness["bundleManifestSha256"] != manifest_sha256
        or readiness["networkInstallAttempted"] is not False
    ):
        fail("runtime readiness receipt boundary is invalid")
    machine = exact_fields(
        readiness["machine"],
        {
            "uuid",
            "instanceId",
            "mac",
            "sshHostKeyFingerprint",
            "sshHostPublicKeySha256",
        },
        "runtime readiness machine identity",
    )
    if machine != {
        "uuid": guest["uuid"],
        "instanceId": guest["instanceId"],
        "mac": guest["mac"],
        "sshHostKeyFingerprint": guest["hostKeyFingerprint"],
        "sshHostPublicKeySha256": guest["hostPublicKeySha256"],
    }:
        fail("runtime readiness machine identity differs from provision")
    owner = exact_fields(
        readiness["ownerAuthorization"],
        {
            "authorizationId",
            "drill",
            "issuedAt",
            "expiresAt",
            "sha256",
            "signatureSha256",
            "ownerPublicKeySha256",
        },
        "runtime readiness owner authorization",
    )
    authorization_fields = exact_fields(
        authorization,
        {
            "schema",
            "authorizationId",
            "issuedAt",
            "expiresAt",
            "operation",
            "drill",
            "setId",
            "guest",
            "port",
            "provisionReceiptSha256",
            "bundleManifestSha256",
            "guestSshHostPublicKeySha256",
            "ownerPublicKeySha256",
        },
        "runtime owner authorization",
    )
    allowed_drills = {
        "ssh-disconnect-after-pm2-stop",
        "failed-health-check",
        "host-reboot-during-promotion",
    }
    if (
        authorization_fields["schema"]
        != "nexus.rollback-drill-vm-runtime-authorization.v1"
        or not HEX64.fullmatch(authorization_fields["authorizationId"])
        or authorization_fields["operation"] != "collect-runtime-readiness"
        or authorization_fields["drill"] not in allowed_drills
        or authorization_fields["setId"] != receipt["setId"]
        or authorization_fields["guest"] != guest_name
        or authorization_fields["port"] != guest["port"]
        or authorization_fields["provisionReceiptSha256"]
        != provision_sha256
        or authorization_fields["bundleManifestSha256"]
        != manifest_sha256
        or authorization_fields["guestSshHostPublicKeySha256"]
        != guest["hostPublicKeySha256"]
        or not HEX64.fullmatch(
            authorization_fields["ownerPublicKeySha256"]
        )
        or not ISO_UTC.fullmatch(authorization_fields["issuedAt"])
        or not ISO_UTC.fullmatch(authorization_fields["expiresAt"])
        or owner
        != {
            "authorizationId": authorization_fields["authorizationId"],
            "drill": authorization_fields["drill"],
            "issuedAt": authorization_fields["issuedAt"],
            "expiresAt": authorization_fields["expiresAt"],
            "sha256": authorization_sha256,
            "signatureSha256": authorization_signature_sha256,
            "ownerPublicKeySha256": authorization_fields[
                "ownerPublicKeySha256"
            ],
        }
    ):
        fail("runtime readiness owner authorization is invalid")
    guest_measurement = exact_fields(
        readiness["guestMeasurement"],
        {"sha256", "signatureSha256", "challenge", "namespace"},
        "runtime readiness guest measurement",
    )
    if guest_measurement != {
        "sha256": measurement_sha256,
        "signatureSha256": measurement_signature_sha256,
        "challenge": measurement["challenge"],
        "namespace": "nexus-rollback-drill-vm-runtime-measurement",
    }:
        fail("runtime readiness guest measurement identity is invalid")
    stopped = exact_fields(
        readiness["stoppedGuestProof"],
        {
            "unit",
            "systemdState",
            "admissionLockHeld",
            "activeLockHolder",
            "sharedReleaseSonarLockHolder",
            "holderPid",
            "holderStartTime",
            "handoffNonce",
            "qemuExited",
            "overlayProcessAbsent",
        },
        "runtime readiness stopped-guest proof",
    )
    if (
        stopped["unit"] != guest["unit"]
        or stopped["systemdState"]
        not in {"active-handoff-wait", "inactive-recovery"}
        or stopped["admissionLockHeld"] is not True
        or stopped["activeLockHolder"]
        not in {"runner-supervisor", "root-collector"}
        or stopped["sharedReleaseSonarLockHolder"]
        != stopped["activeLockHolder"]
        or type(stopped["holderPid"]) is not int
        or stopped["holderPid"] <= 1
        or not isinstance(stopped["holderStartTime"], str)
        or not stopped["holderStartTime"].isdigit()
        or not HEX64.fullmatch(stopped["handoffNonce"])
        or stopped["qemuExited"] is not True
        or stopped["overlayProcessAbsent"] is not True
        or (
            stopped["systemdState"] == "active-handoff-wait"
            and stopped["activeLockHolder"] != "runner-supervisor"
        )
        or (
            stopped["systemdState"] == "inactive-recovery"
            and stopped["activeLockHolder"] != "root-collector"
        )
    ):
        fail("runtime readiness stopped-guest proof is invalid")
    overlay = exact_fields(
        readiness["overlay"],
        {
            "path",
            "initialSha256",
            "currentSha256",
            "size",
            "device",
            "inode",
            "mtimeNs",
            "ctimeNs",
            "stableDescriptor",
        },
        "runtime readiness overlay identity",
    )
    if (
        overlay["path"] != guest["overlayPath"]
        or overlay["initialSha256"] != guest["overlayInitialSha256"]
        or not HEX64.fullmatch(overlay["currentSha256"])
        or type(overlay["size"]) is not int
        or overlay["size"] <= 0
        or any(
            type(overlay[name]) is not int or overlay[name] <= 0
            for name in ("device", "inode", "mtimeNs", "ctimeNs")
        )
        or overlay["stableDescriptor"] is not True
    ):
        fail("runtime readiness overlay identity is invalid")
    qemu = exact_fields(
        readiness["qemu"],
        {
            "unit",
            "supervisorPid",
            "supervisorStartTime",
            "supervisorCmdlineSha256",
            "pid",
            "startTime",
            "executable",
            "executableSha256",
            "cmdlineSha256",
            "loopbackPortSocketInode",
        },
        "runtime readiness QEMU identity",
    )
    if (
        qemu["unit"] != guest["unit"]
        or type(qemu["supervisorPid"]) is not int
        or qemu["supervisorPid"] <= 1
        or type(qemu["pid"]) is not int
        or qemu["pid"] <= 1
        or not isinstance(qemu["supervisorStartTime"], str)
        or not qemu["supervisorStartTime"].isdigit()
        or not isinstance(qemu["startTime"], str)
        or not qemu["startTime"].isdigit()
        or not HEX64.fullmatch(qemu["supervisorCmdlineSha256"])
        or qemu["executable"] != receipt["hypervisor"]["qemuBinary"]
        or qemu["executableSha256"]
        != receipt["hypervisor"]["qemuSha256"]
        or not HEX64.fullmatch(qemu["cmdlineSha256"])
        or not isinstance(qemu["loopbackPortSocketInode"], str)
        or not qemu["loopbackPortSocketInode"].isdigit()
    ):
        fail("runtime readiness QEMU identity is invalid")
    if (
        readiness["runtime"] != measurement["runtime"]
        or readiness["control"] != measurement["control"]
        or readiness["pm2DryHealth"] != measurement["pm2DryHealth"]
    ):
        fail("runtime readiness identity differs from the live measurement")
    return readiness


def build_command(args: argparse.Namespace) -> None:
    root = Path(args.bundle_root).resolve(strict=True)
    source_root = Path(args.source_root).resolve(strict=True)
    if root.is_symlink() or not root.is_dir():
        fail("bundle root must be one real directory")
    node_archive = root / NODE_ARCHIVE
    regular_identity(node_archive, NODE_ARCHIVE)
    pm2_prefix = root / PM2_PREFIX
    pm2_lock = root / PM2_LOCK
    validate_pm2_prefix(pm2_prefix, pm2_lock)
    node_provenance = verify_node_signature(root, args.node_signer_fingerprint)
    pm2_provenance = validate_pm2_lock(pm2_lock)
    node_runtime_identity = node_archive_runtime_identity(node_archive)
    pm2_binary = pm2_prefix / "bin/pm2"
    pm2_runtime_identity = {
        "binarySha256": sha256_file(pm2_binary.resolve(strict=True)),
        "contentTreeSha256": content_tree_sha256(pm2_prefix),
    }
    python_provenance_value = bounded_json(
        root / PYTHON_PROVENANCE,
        "guest Python provenance",
    )
    public_key = root / OWNER_PUBLIC_KEY
    public_key_identity = regular_identity(public_key, OWNER_PUBLIC_KEY)

    if (
        not HEX64.fullmatch(args.base_image_sha256)
        or not PYTHON_VERSION.fullmatch(args.python_version)
        or not HEX64.fullmatch(args.python_binary_sha256)
        or not SAFE_PACKAGE.fullmatch(args.python_package_name)
        or not SAFE_VERSION.fullmatch(args.python_package_version)
        or args.python_package_architecture != "amd64"
        or args.npm_version != NPM_VERSION
        or not HEX64.fullmatch(args.provision_receipt_sha256)
        or args.python_provenance_guest not in {"guest-1", "guest-2", "guest-3"}
        or not SSH_FINGERPRINT.fullmatch(args.python_host_key_fingerprint)
        or not HEX64.fullmatch(args.python_host_public_key_sha256)
    ):
        fail("runtime build arguments are outside policy")
    if (
        python_provenance_value.get("schema") != PYTHON_PROVENANCE_SCHEMA
        or python_provenance_value.get("baseImageSha256")
        != args.base_image_sha256
        or python_provenance_value.get("provisionReceiptSha256")
        != args.provision_receipt_sha256
        or python_provenance_value.get("guest")
        != args.python_provenance_guest
        or python_provenance_value.get("machine", {}).get(
            "sshHostKeyFingerprint"
        )
        != args.python_host_key_fingerprint
        or python_provenance_value.get("machine", {}).get(
            "sshHostPublicKeySha256"
        )
        != args.python_host_public_key_sha256
        or python_provenance_value.get("python", {}).get("version")
        != args.python_version
        or python_provenance_value.get("python", {}).get("binarySha256")
        != args.python_binary_sha256
        or python_provenance_value.get("python", {}).get("packageName")
        != args.python_package_name
        or python_provenance_value.get("python", {}).get("packageVersion")
        != args.python_package_version
        or python_provenance_value.get("python", {}).get(
            "packageArchitecture"
        )
        != args.python_package_architecture
    ):
        fail("runtime target differs from the signed guest Python provenance")

    manifest = {
        "schema": BUNDLE_SCHEMA,
        "target": {
            "os": {
                "id": "ubuntu",
                "versionId": "24.04",
                "architecture": "x86_64",
                "baseImageSha256": args.base_image_sha256,
            },
            "node": {
                "version": NODE_VERSION,
                "archivePath": NODE_ARCHIVE,
                "archiveRoot": NODE_ARCHIVE_ROOT,
                "npmVersion": args.npm_version,
                "installRoot": NODE_INSTALL_ROOT,
                **node_runtime_identity,
                "links": {
                    "/usr/bin/corepack": f"{NODE_INSTALL_ROOT}/bin/corepack",
                    "/usr/bin/node": f"{NODE_INSTALL_ROOT}/bin/node",
                    "/usr/bin/npm": f"{NODE_INSTALL_ROOT}/bin/npm",
                    "/usr/bin/npx": f"{NODE_INSTALL_ROOT}/bin/npx",
                },
            },
            "python": {
                "version": args.python_version,
                "binaryPath": "/usr/bin/python3.12",
                "binarySha256": args.python_binary_sha256,
                "packageName": args.python_package_name,
                "packageVersion": args.python_package_version,
                "packageArchitecture": args.python_package_architecture,
                "source": "canonical-ubuntu-noble-base-image",
            },
            "pm2": {
                "version": PM2_VERSION,
                "prefixPath": PM2_PREFIX,
                "lockPath": PM2_LOCK,
                "binaryPath": PM2_BINARY,
                "installRoot": PM2_INSTALL_ROOT,
                **pm2_runtime_identity,
            },
            "control": {
                "version": "nexus-release-promotion-control.v2",
                "sourceCommit": args.source_commit,
                "archivePath": CONTROL_ARCHIVE,
                "archiveSha256": sha256_file(root / CONTROL_ARCHIVE),
                "bootstrapFiles": mapped_identities(source_root, BOOTSTRAP_FILES),
                "files": control_identities(source_root, args.source_commit),
            },
        },
        "provenance": {
            "node": node_provenance,
            "python": {
                "verification": "provisioned-guest-ssh-host-key-signature",
                "namespace": PYTHON_PROVENANCE_NAMESPACE,
                "provenancePath": PYTHON_PROVENANCE,
                "provenanceSha256": sha256_file(root / PYTHON_PROVENANCE),
                "signaturePath": PYTHON_PROVENANCE_SIGNATURE,
                "signatureSha256": sha256_file(
                    root / PYTHON_PROVENANCE_SIGNATURE
                ),
                "provisionReceiptSha256": args.provision_receipt_sha256,
                "guest": args.python_provenance_guest,
                "hostKeyFingerprint": args.python_host_key_fingerprint,
                "hostPublicKeySha256": args.python_host_public_key_sha256,
            },
            "pm2": pm2_provenance,
        },
        "signing": {
            "algorithm": "ed25519",
            "publicKeyPath": OWNER_PUBLIC_KEY,
            "publicKeySha256": public_key_identity["sha256"],
        },
        "files": enumerate_bundle_files(root),
    }
    validate_manifest(manifest)
    verify_bundle_files(root, manifest)
    output = Path(args.output)
    if output.parent.resolve(strict=True) != root or output.name != MANIFEST_NAME:
        fail("manifest output must be bundle-root/manifest.json")
    descriptor = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        body = canonical_bytes(manifest)
        if len(body) > MAX_MANIFEST_BYTES:
            fail("runtime bundle manifest exceeds the accepted bound")
        os.write(descriptor, body)
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    print(
        json.dumps(
            {
                "ok": True,
                "schema": BUNDLE_SCHEMA,
                "manifestSha256": sha256_file(output),
                "fileCount": len(manifest["files"]),
            },
            separators=(",", ":"),
            sort_keys=True,
        )
    )


def verify_command(args: argparse.Namespace) -> None:
    root = Path(args.bundle_root).resolve(strict=True)
    manifest_path = Path(args.manifest).resolve(strict=True)
    if manifest_path.parent != root or manifest_path.name != MANIFEST_NAME:
        fail("manifest path must be bundle-root/manifest.json")
    manifest = load_manifest(manifest_path)
    verify_bundle_files(root, manifest)
    expected = args.expected_manifest_sha256
    observed = sha256_file(manifest_path)
    if expected and (not HEX64.fullmatch(expected) or expected != observed):
        fail("runtime bundle manifest digest differs from the expected identity")
    print(
        json.dumps(
            {
                "ok": True,
                "schema": BUNDLE_SCHEMA,
                "manifestSha256": observed,
                "fileCount": len(manifest["files"]),
            },
            separators=(",", ":"),
            sort_keys=True,
        )
    )


def context_command(args: argparse.Namespace) -> None:
    receipt_path = Path(args.provision_receipt)
    receipt = bounded_json(receipt_path, "provision receipt")
    provision_sha = sha256_file(receipt_path)
    if (
        not HEX64.fullmatch(args.expected_provision_sha256)
        or provision_sha != args.expected_provision_sha256
    ):
        fail("provision receipt digest differs from the expected identity")
    guest = provision_guest(receipt, args.guest)
    manifest = load_manifest(Path(args.manifest))
    manifest_sha = sha256_file(Path(args.manifest))
    if (
        not HEX64.fullmatch(args.expected_manifest_sha256)
        or manifest_sha != args.expected_manifest_sha256
    ):
        fail("runtime bundle manifest digest differs from the expected identity")
    if manifest["target"]["os"]["baseImageSha256"] != receipt["image"]["sha256"]:
        fail("runtime bundle targets a different provisioned base image")
    python_provenance = manifest["provenance"]["python"]
    if (
        python_provenance["provisionReceiptSha256"] != provision_sha
        or python_provenance["guest"] != args.guest
        or python_provenance["hostKeyFingerprint"]
        != guest["hostKeyFingerprint"]
        or python_provenance["hostPublicKeySha256"]
        != guest["hostPublicKeySha256"]
    ):
        fail("runtime bundle Python provenance targets a different guest")
    print(
        json.dumps(
            {
                "ok": True,
                "setId": receipt["setId"],
                "guest": args.guest,
                "uuid": guest["uuid"],
                "instanceId": guest["instanceId"],
                "hostPublicKey": guest["hostPublicKey"],
                "hostPublicKeySha256": guest["hostPublicKeySha256"],
                "hostKeyFingerprint": guest["hostKeyFingerprint"],
                "overlayPath": guest["overlayPath"],
                "overlayInitialSha256": guest["overlayInitialSha256"],
                "unit": guest["unit"],
                "provisionReceiptSha256": provision_sha,
                "bundleManifestSha256": manifest_sha,
                "nodeContentTreeSha256": manifest["target"]["node"][
                    "contentTreeSha256"
                ],
                "nodeBinarySha256": manifest["target"]["node"][
                    "binarySha256"
                ],
                "pm2ContentTreeSha256": manifest["target"]["pm2"][
                    "contentTreeSha256"
                ],
                "pm2BinarySha256": manifest["target"]["pm2"][
                    "binarySha256"
                ],
                "runtimeRecoveryUnitSha256": receipt["hypervisor"][
                    "runtimeRecoveryUnitSha256"
                ],
            },
            separators=(",", ":"),
            sort_keys=True,
        )
    )


def provision_command(args: argparse.Namespace) -> None:
    receipt_path = Path(args.provision_receipt)
    receipt = bounded_json(receipt_path, "provision receipt")
    provision_sha = sha256_file(receipt_path)
    if (
        not HEX64.fullmatch(args.expected_provision_sha256)
        or provision_sha != args.expected_provision_sha256
    ):
        fail("provision receipt digest differs from the expected identity")
    guest = provision_guest(receipt, args.guest)
    print(
        json.dumps(
            {
                "ok": True,
                "setId": receipt["setId"],
                "guest": args.guest,
                "baseImageSha256": receipt["image"]["sha256"],
                "sshClientPublicKeySha256": receipt[
                    "sshPublicKeySha256"
                ],
                "port": guest["port"],
                "uuid": guest["uuid"],
                "mac": guest["mac"],
                "instanceId": guest["instanceId"],
                "hostPublicKey": guest["hostPublicKey"],
                "hostPublicKeySha256": guest["hostPublicKeySha256"],
                "hostKeyFingerprint": guest["hostKeyFingerprint"],
                "overlayPath": guest["overlayPath"],
                "overlayInitialSha256": guest["overlayInitialSha256"],
                "seedPath": guest["seedPath"],
                "seedSha256": guest["seedSha256"],
                "unit": guest["unit"],
                "qemuBinary": receipt["hypervisor"]["qemuBinary"],
                "qemuSha256": receipt["hypervisor"]["qemuSha256"],
                "runtimeManifestSha256": receipt["hypervisor"][
                    "runtimeManifestSha256"
                ],
                "runtimeControlSha256": receipt["hypervisor"][
                    "runtimeControlSha256"
                ],
                "runtimeRecoveryUnitSha256": receipt["hypervisor"][
                    "runtimeRecoveryUnitSha256"
                ],
                "provisionReceiptSha256": provision_sha,
            },
            separators=(",", ":"),
            sort_keys=True,
        )
    )


def validate_python_provenance_command(args: argparse.Namespace) -> None:
    receipt_path = Path(args.provision_receipt)
    receipt = bounded_json(receipt_path, "provision receipt")
    provision_sha = sha256_file(receipt_path)
    if (
        not HEX64.fullmatch(args.expected_provision_sha256)
        or provision_sha != args.expected_provision_sha256
    ):
        fail("provision receipt digest differs from the expected identity")
    provenance_path = Path(args.provenance)
    value = bounded_json(provenance_path, "guest Python provenance")
    provenance = validate_python_provenance(
        value,
        receipt,
        args.guest,
        provision_sha,
    )
    print(
        json.dumps(
            {
                "ok": True,
                "provenanceSha256": sha256_file(provenance_path),
                "hostPublicKey": provision_guest(receipt, args.guest)[
                    "hostPublicKey"
                ],
                "python": provenance["python"],
            },
            separators=(",", ":"),
            sort_keys=True,
        )
    )


def validate_pm2_command(args: argparse.Namespace) -> None:
    lock = Path(args.lock).resolve(strict=True)
    prefix = Path(args.prefix).resolve(strict=True)
    provenance = validate_pm2_lock(lock)
    validate_pm2_prefix(prefix, lock)
    print(
        json.dumps(
            {
                "ok": True,
                "version": PM2_VERSION,
                "prefix": str(prefix),
                "lockSha256": provenance["lockSha256"],
                "packageCount": provenance["packageCount"],
                "integrity": provenance["pm2Integrity"],
            },
            separators=(",", ":"),
            sort_keys=True,
        )
    )


def validate_install_receipt_command(args: argparse.Namespace) -> None:
    provision_path = Path(args.provision_receipt)
    provision = bounded_json(provision_path, "provision receipt")
    provision_sha = sha256_file(provision_path)
    manifest_path = Path(args.manifest)
    manifest = load_manifest(manifest_path)
    manifest_sha = sha256_file(manifest_path)
    if (
        provision_sha != args.expected_provision_sha256
        or manifest_sha != args.expected_manifest_sha256
    ):
        fail("runtime installation expected identity is invalid")
    receipt_path = Path(args.receipt)
    receipt = validate_install_receipt(
        bounded_json(receipt_path, "runtime installation receipt"),
        provision,
        args.guest,
        provision_sha,
        manifest,
        manifest_sha,
    )
    print(
        json.dumps(
            {
                "ok": True,
                "installReceiptSha256": sha256_file(receipt_path),
                "transactionId": receipt["transactionId"],
            },
            separators=(",", ":"),
            sort_keys=True,
        )
    )


def validate_node_entrypoints_command(args: argparse.Namespace) -> None:
    entrypoints = validate_node_entrypoints(
        Path(args.node_target),
        Path(args.link_root),
    )
    print(
        json.dumps(
            {
                "ok": True,
                "version": NODE_VERSION,
                "npmVersion": NPM_VERSION,
                "entrypoints": entrypoints,
            },
            separators=(",", ":"),
            sort_keys=True,
        )
    )


def validate_measurement_command(args: argparse.Namespace) -> None:
    receipt_path = Path(args.provision_receipt)
    receipt = bounded_json(receipt_path, "provision receipt")
    provision_sha = sha256_file(receipt_path)
    manifest_path = Path(args.manifest)
    manifest = load_manifest(manifest_path)
    manifest_sha = sha256_file(manifest_path)
    if (
        provision_sha != args.expected_provision_sha256
        or manifest_sha != args.expected_manifest_sha256
        or not HEX64.fullmatch(args.challenge)
    ):
        fail("runtime measurement expected identity is invalid")
    measurement_path = Path(args.measurement)
    validate_guest_measurement(
        bounded_json(measurement_path, "guest runtime measurement"),
        receipt,
        args.guest,
        provision_sha,
        manifest,
        manifest_sha,
        args.challenge,
    )
    print(
        json.dumps(
            {
                "ok": True,
                "measurementSha256": sha256_file(measurement_path),
                "hostPublicKey": provision_guest(receipt, args.guest)[
                    "hostPublicKey"
                ],
            },
            separators=(",", ":"),
            sort_keys=True,
        )
    )


def validate_readiness_command(args: argparse.Namespace) -> None:
    receipt_path = Path(args.provision_receipt)
    receipt = bounded_json(receipt_path, "provision receipt")
    provision_sha = sha256_file(receipt_path)
    if (
        not HEX64.fullmatch(args.expected_provision_sha256)
        or provision_sha != args.expected_provision_sha256
        or not HEX64.fullmatch(args.expected_manifest_sha256)
    ):
        fail("runtime readiness expected identity is invalid")
    manifest_path = Path(args.manifest)
    manifest = load_manifest(manifest_path)
    if sha256_file(manifest_path) != args.expected_manifest_sha256:
        fail("runtime bundle manifest digest differs from the expected identity")
    readiness_path = Path(args.readiness)
    readiness_value = bounded_json(
        readiness_path,
        "runtime readiness receipt",
    )
    challenge = readiness_value.get("guestMeasurement", {}).get("challenge")
    if not isinstance(challenge, str) or not HEX64.fullmatch(challenge):
        fail("runtime readiness measurement challenge is invalid")
    measurement_path = Path(args.measurement)
    measurement = validate_guest_measurement(
        bounded_json(measurement_path, "guest runtime measurement"),
        receipt,
        args.guest,
        provision_sha,
        manifest,
        args.expected_manifest_sha256,
        challenge,
    )
    signature_path = Path(args.measurement_signature)
    read_regular_nofollow(
        signature_path,
        64 * 1024,
        "guest runtime measurement signature",
    )
    authorization_path = Path(args.authorization)
    authorization = bounded_json(
        authorization_path,
        "runtime owner authorization",
    )
    authorization_signature_path = Path(args.authorization_signature)
    read_regular_nofollow(
        authorization_signature_path,
        64 * 1024,
        "runtime owner authorization signature",
    )
    validate_runtime_readiness(
        readiness_value,
        receipt,
        args.guest,
        provision_sha,
        args.expected_manifest_sha256,
        measurement,
        sha256_file(measurement_path),
        sha256_file(signature_path),
        authorization,
        sha256_file(authorization_path),
        sha256_file(authorization_signature_path),
    )
    print(
        json.dumps(
            {
                "ok": True,
                "schema": READINESS_SCHEMA,
                "readinessSha256": sha256_file(readiness_path),
                "overlayCurrentSha256": readiness_value["overlay"][
                    "currentSha256"
                ],
                "drillReady": True,
            },
            separators=(",", ":"),
            sort_keys=True,
        )
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)

    build = subparsers.add_parser("build")
    build.add_argument("--bundle-root", required=True)
    build.add_argument("--source-root", required=True)
    build.add_argument("--source-commit", required=True)
    build.add_argument("--base-image-sha256", required=True)
    build.add_argument("--node-signer-fingerprint", required=True)
    build.add_argument("--npm-version", required=True)
    build.add_argument("--python-version", required=True)
    build.add_argument("--python-binary-sha256", required=True)
    build.add_argument("--python-package-name", required=True)
    build.add_argument("--python-package-version", required=True)
    build.add_argument("--python-package-architecture", required=True)
    build.add_argument("--provision-receipt-sha256", required=True)
    build.add_argument("--python-provenance-guest", required=True)
    build.add_argument("--python-host-key-fingerprint", required=True)
    build.add_argument("--python-host-public-key-sha256", required=True)
    build.add_argument("--output", required=True)

    verify = subparsers.add_parser("verify")
    verify.add_argument("--bundle-root", required=True)
    verify.add_argument("--manifest", required=True)
    verify.add_argument("--expected-manifest-sha256")

    stage_bundle = subparsers.add_parser("stage-bundle")
    stage_bundle.add_argument("--source-root", required=True)
    stage_bundle.add_argument("--target-parent", required=True)
    stage_bundle.add_argument("--expected-manifest-sha256", required=True)
    stage_bundle.add_argument("--expected-public-key-sha256", required=True)

    stage_provision = subparsers.add_parser("stage-provision")
    stage_provision.add_argument("--source", required=True)
    stage_provision.add_argument("--target-parent", required=True)
    stage_provision.add_argument("--expected-provision-sha256", required=True)

    context = subparsers.add_parser("context")
    context.add_argument("--provision-receipt", required=True)
    context.add_argument("--expected-provision-sha256", required=True)
    context.add_argument("--guest", required=True)
    context.add_argument("--manifest", required=True)
    context.add_argument("--expected-manifest-sha256", required=True)

    provision = subparsers.add_parser("provision")
    provision.add_argument("--provision-receipt", required=True)
    provision.add_argument("--expected-provision-sha256", required=True)
    provision.add_argument("--guest", required=True)

    python_provenance = subparsers.add_parser("validate-python-provenance")
    python_provenance.add_argument("--provision-receipt", required=True)
    python_provenance.add_argument("--expected-provision-sha256", required=True)
    python_provenance.add_argument("--guest", required=True)
    python_provenance.add_argument("--provenance", required=True)

    pm2 = subparsers.add_parser("validate-pm2")
    pm2.add_argument("--prefix", required=True)
    pm2.add_argument("--lock", required=True)

    node_entrypoints = subparsers.add_parser("validate-node-entrypoints")
    node_entrypoints.add_argument("--node-target", required=True)
    node_entrypoints.add_argument("--link-root", required=True)

    fsync_stage_tree = subparsers.add_parser("fsync-tree")
    fsync_stage_tree.add_argument("--root", required=True)

    content_tree = subparsers.add_parser("validate-content-tree")
    content_tree.add_argument("--root", required=True)
    content_tree.add_argument("--expected-sha256", required=True)

    install_receipt = subparsers.add_parser("validate-install-receipt")
    install_receipt.add_argument("--receipt", required=True)
    install_receipt.add_argument("--provision-receipt", required=True)
    install_receipt.add_argument("--expected-provision-sha256", required=True)
    install_receipt.add_argument("--guest", required=True)
    install_receipt.add_argument("--manifest", required=True)
    install_receipt.add_argument("--expected-manifest-sha256", required=True)

    measurement = subparsers.add_parser("validate-measurement")
    measurement.add_argument("--provision-receipt", required=True)
    measurement.add_argument("--expected-provision-sha256", required=True)
    measurement.add_argument("--guest", required=True)
    measurement.add_argument("--measurement", required=True)
    measurement.add_argument("--manifest", required=True)
    measurement.add_argument("--expected-manifest-sha256", required=True)
    measurement.add_argument("--challenge", required=True)

    readiness = subparsers.add_parser("validate-readiness")
    readiness.add_argument("--provision-receipt", required=True)
    readiness.add_argument("--expected-provision-sha256", required=True)
    readiness.add_argument("--guest", required=True)
    readiness.add_argument("--measurement", required=True)
    readiness.add_argument("--measurement-signature", required=True)
    readiness.add_argument("--authorization", required=True)
    readiness.add_argument("--authorization-signature", required=True)
    readiness.add_argument("--readiness", required=True)
    readiness.add_argument("--manifest", required=True)
    readiness.add_argument("--expected-manifest-sha256", required=True)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.command == "build":
        build_command(args)
    elif args.command == "verify":
        verify_command(args)
    elif args.command == "stage-bundle":
        stage_bundle_command(args)
    elif args.command == "stage-provision":
        stage_provision_command(args)
    elif args.command == "context":
        context_command(args)
    elif args.command == "provision":
        provision_command(args)
    elif args.command == "validate-python-provenance":
        validate_python_provenance_command(args)
    elif args.command == "validate-pm2":
        validate_pm2_command(args)
    elif args.command == "validate-node-entrypoints":
        validate_node_entrypoints_command(args)
    elif args.command == "fsync-tree":
        fsync_tree_command(args)
    elif args.command == "validate-content-tree":
        content_tree_command(args)
    elif args.command == "validate-install-receipt":
        validate_install_receipt_command(args)
    elif args.command == "validate-measurement":
        validate_measurement_command(args)
    elif args.command == "validate-readiness":
        validate_readiness_command(args)
    else:
        fail("unsupported command")


if __name__ == "__main__":
    main()
