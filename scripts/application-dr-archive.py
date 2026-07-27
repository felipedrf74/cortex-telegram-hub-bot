#!/usr/bin/env python3
"""Safely extract a Nexus exact-release rollback bundle for an isolated drill."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import sys
import tarfile
from typing import Callable, NoReturn


REQUIRED_PATHS = (
    "dist",
    "migrations",
    "prompts",
    "content-engine",
    "content-engine/main.py",
    "content-engine/config.py",
    "content-engine/requirements.txt",
    "package.json",
    "package-lock.json",
    "ecosystem.config.js",
    "data/bot.db",
)
CATALOG_REQUIRED_FROM = (4, 14, 217)
CATALOG_REQUIRED_FROM_VERSION = ".".join(str(part) for part in CATALOG_REQUIRED_FROM)
RELEASE_MANIFEST_KEYS = {
    "schema",
    "archivedVersion",
    "targetVersion",
    "catalogPresent",
    "catalogRequiredFromVersion",
}
ROLLBACK_ARCHIVE_NAME = re.compile(r"^v[A-Za-z0-9._+-]+\.tar\.gz$")
SHA256 = re.compile(r"^[a-f0-9]{64}$")
VERSION = re.compile(
    r"^[0-9]+\.[0-9]+\.[0-9]+"
    r"(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?"
    r"(?:\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$",
)


def fail(message: str) -> NoReturn:
    raise SystemExit(message)


def sha256_bytes(body: bytes) -> str:
    return hashlib.sha256(body).hexdigest()


def sha256_path(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def stat_identity(value: os.stat_result) -> dict[str, int]:
    return {
        "device": value.st_dev,
        "inode": value.st_ino,
        "uid": value.st_uid,
        "gid": value.st_gid,
        "mode": stat.S_IMODE(value.st_mode),
        "nlink": value.st_nlink,
        "sizeBytes": value.st_size,
        "ctimeNs": value.st_ctime_ns,
        "mtimeNs": value.st_mtime_ns,
    }


def same_stable_file(before: os.stat_result, after: os.stat_result) -> bool:
    return (
        before.st_dev,
        before.st_ino,
        before.st_uid,
        before.st_gid,
        stat.S_IMODE(before.st_mode),
        before.st_nlink,
        before.st_size,
        before.st_ctime_ns,
        before.st_mtime_ns,
    ) == (
        after.st_dev,
        after.st_ino,
        after.st_uid,
        after.st_gid,
        stat.S_IMODE(after.st_mode),
        after.st_nlink,
        after.st_size,
        after.st_ctime_ns,
        after.st_mtime_ns,
    )


def same_directory(first: os.stat_result, second: os.stat_result) -> bool:
    return (
        stat.S_ISDIR(first.st_mode)
        and stat.S_ISDIR(second.st_mode)
        and first.st_dev == second.st_dev
        and first.st_ino == second.st_ino
        and first.st_uid == second.st_uid
        and stat.S_IMODE(first.st_mode) == stat.S_IMODE(second.st_mode)
    )


def secure_snapshot(
    source_directory: Path,
    source_name: str,
    destination: Path,
    expected_sha256: str,
    expected_uid: int,
    *,
    after_open_hook: Callable[[], None] | None = None,
    after_copy_hook: Callable[[], None] | None = None,
) -> dict[str, object]:
    """Copy one app-owned archive through bound directory/file descriptors."""
    if not source_directory.is_absolute() or source_directory == Path("/"):
        fail("rollback directory must be an absolute non-root path")
    if (
        source_directory.is_symlink()
        or source_directory.resolve(strict=True) != source_directory
    ):
        fail("rollback directory must be canonical and must not traverse symlinks")
    if not ROLLBACK_ARCHIVE_NAME.fullmatch(source_name):
        fail("bootstrap rollback bundle name is invalid")
    if not SHA256.fullmatch(expected_sha256):
        fail("bootstrap rollback bundle expected SHA-256 is invalid")
    if expected_uid < 0:
        fail("bootstrap rollback bundle expected owner is invalid")
    if not destination.is_absolute() or destination == Path("/"):
        fail("bootstrap snapshot destination must be an absolute non-root path")
    destination_directory = destination.parent
    if (
        destination.name in ("", ".", "..")
        or destination_directory.is_symlink()
        or destination_directory.resolve(strict=True) != destination_directory
    ):
        fail("bootstrap snapshot destination directory is unsafe")

    nofollow = getattr(os, "O_NOFOLLOW", 0)
    directory_flag = getattr(os, "O_DIRECTORY", 0)
    cloexec = getattr(os, "O_CLOEXEC", 0)
    if nofollow == 0 or directory_flag == 0:
        fail("O_NOFOLLOW and O_DIRECTORY support is required")

    source_path_before = os.stat(source_directory, follow_symlinks=False)
    destination_path_before = os.stat(
        destination_directory,
        follow_symlinks=False,
    )
    source_directory_fd = os.open(
        source_directory,
        os.O_RDONLY | directory_flag | nofollow | cloexec,
    )
    destination_directory_fd = os.open(
        destination_directory,
        os.O_RDONLY | directory_flag | nofollow | cloexec,
    )
    source_fd = -1
    destination_fd = -1
    destination_created = False
    try:
        source_directory_stat = os.fstat(source_directory_fd)
        destination_directory_stat = os.fstat(destination_directory_fd)
        if (
            not same_directory(source_path_before, source_directory_stat)
            or source_directory_stat.st_uid != expected_uid
            or stat.S_IMODE(source_directory_stat.st_mode) != 0o700
        ):
            fail("rollback directory descriptor identity is invalid")
        if (
            not same_directory(destination_path_before, destination_directory_stat)
            or destination_directory_stat.st_uid != os.geteuid()
            or stat.S_IMODE(destination_directory_stat.st_mode) != 0o700
        ):
            fail("bootstrap snapshot destination directory identity is invalid")

        source_fd = os.open(
            source_name,
            os.O_RDONLY | nofollow | cloexec,
            dir_fd=source_directory_fd,
        )
        source_before = os.fstat(source_fd)
        if (
            not stat.S_ISREG(source_before.st_mode)
            or source_before.st_nlink != 1
            or source_before.st_uid != expected_uid
            or stat.S_IMODE(source_before.st_mode) != 0o600
            or source_before.st_size <= 0
        ):
            fail(
                "bootstrap rollback bundle must be an app-owned, nonempty, "
                "single-link mode-0600 regular file",
            )
        entry_before = os.stat(
            source_name,
            dir_fd=source_directory_fd,
            follow_symlinks=False,
        )
        if not same_stable_file(source_before, entry_before):
            fail("bootstrap rollback bundle path changed before snapshot")
        if after_open_hook is not None:
            after_open_hook()

        destination_fd = os.open(
            destination.name,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | nofollow | cloexec,
            0o600,
            dir_fd=destination_directory_fd,
        )
        destination_created = True
        digest = hashlib.sha256()
        copied = 0
        while True:
            chunk = os.read(source_fd, 1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
            copied += len(chunk)
            view = memoryview(chunk)
            while view:
                written = os.write(destination_fd, view)
                if written <= 0:
                    fail("bootstrap rollback snapshot write made no progress")
                view = view[written:]
        if after_copy_hook is not None:
            after_copy_hook()

        source_after = os.fstat(source_fd)
        entry_after = os.stat(
            source_name,
            dir_fd=source_directory_fd,
            follow_symlinks=False,
        )
        source_directory_after = os.fstat(source_directory_fd)
        source_path_after = os.stat(source_directory, follow_symlinks=False)
        if (
            not same_stable_file(source_before, source_after)
            or not same_stable_file(source_before, entry_after)
            or not same_directory(source_directory_stat, source_directory_after)
            or not same_directory(source_directory_stat, source_path_after)
            or copied != source_before.st_size
        ):
            fail("bootstrap rollback bundle changed during snapshot")

        archive_sha256 = digest.hexdigest()
        if archive_sha256 != expected_sha256:
            fail("bootstrap rollback bundle SHA-256 does not match owner expectation")
        destination_stat = os.fstat(destination_fd)
        if (
            not stat.S_ISREG(destination_stat.st_mode)
            or destination_stat.st_nlink != 1
            or destination_stat.st_uid != os.geteuid()
            or stat.S_IMODE(destination_stat.st_mode) != 0o600
            or destination_stat.st_size != copied
        ):
            fail("bootstrap rollback snapshot identity is invalid")
        os.fsync(destination_fd)
        os.fsync(destination_directory_fd)
        return {
            "schemaVersion": "NexusApplicationDrRollbackSnapshotV1",
            "status": "passed",
            "source": {
                "directory": str(source_directory),
                "basename": source_name,
                "path": str(source_directory / source_name),
                "before": stat_identity(source_before),
                "after": stat_identity(source_after),
                "pathEntryAfter": stat_identity(entry_after),
                "directoryDevice": source_directory_stat.st_dev,
                "directoryInode": source_directory_stat.st_ino,
            },
            "snapshot": {
                "path": str(destination),
                "sha256": archive_sha256,
                "sizeBytes": copied,
                "uid": destination_stat.st_uid,
                "mode": stat.S_IMODE(destination_stat.st_mode),
                "nlink": destination_stat.st_nlink,
            },
            "expectedSha256": expected_sha256,
        }
    except BaseException:
        if destination_fd >= 0:
            os.close(destination_fd)
            destination_fd = -1
        if destination_created:
            try:
                os.unlink(destination.name, dir_fd=destination_directory_fd)
                os.fsync(destination_directory_fd)
            except OSError:
                pass
        raise
    finally:
        if destination_fd >= 0:
            os.close(destination_fd)
        if source_fd >= 0:
            os.close(source_fd)
        os.close(destination_directory_fd)
        os.close(source_directory_fd)


def read_private_json(path: Path, label: str) -> tuple[bytes, dict[str, object]]:
    if (
        not path.is_absolute()
        or path == Path("/")
        or path.is_symlink()
        or path.resolve(strict=True) != path
        or not path.is_file()
    ):
        fail(f"{label} must be a canonical non-symlink regular file")
    identity = path.stat()
    if (
        identity.st_uid != os.geteuid()
        or stat.S_IMODE(identity.st_mode) != 0o600
        or identity.st_size <= 0
        or identity.st_size > 1024 * 1024
    ):
        fail(f"{label} must be owner-only, nonempty, and bounded")
    body = path.read_bytes()
    try:
        value = json.loads(body)
    except json.JSONDecodeError as error:
        fail(f"{label} is invalid JSON: {error}")
    if not isinstance(value, dict):
        fail(f"{label} must be a JSON object")
    return body, value


def bootstrap_identity(
    snapshot_evidence_path: Path,
    extraction_evidence_path: Path,
    database_evidence_path: Path,
    extracted_root: Path,
    expected_sha256: str,
) -> dict[str, object]:
    if not SHA256.fullmatch(expected_sha256):
        fail("bootstrap rollback bundle expected SHA-256 is invalid")
    if (
        not extracted_root.is_absolute()
        or extracted_root == Path("/")
        or extracted_root.is_symlink()
        or extracted_root.resolve(strict=True) != extracted_root
        or not extracted_root.is_dir()
        or extracted_root.stat().st_uid != os.geteuid()
        or stat.S_IMODE(extracted_root.stat().st_mode) != 0o700
    ):
        fail("bootstrap extracted root identity is invalid")
    snapshot_raw, snapshot = read_private_json(
        snapshot_evidence_path,
        "bootstrap snapshot evidence",
    )
    extraction_raw, extraction = read_private_json(
        extraction_evidence_path,
        "bootstrap extraction evidence",
    )
    database_raw, database = read_private_json(
        database_evidence_path,
        "bootstrap database evidence",
    )
    source = snapshot.get("source")
    snapshot_file = snapshot.get("snapshot")
    if (
        snapshot.get("schemaVersion") != "NexusApplicationDrRollbackSnapshotV1"
        or snapshot.get("status") != "passed"
        or snapshot.get("expectedSha256") != expected_sha256
        or not isinstance(source, dict)
        or not isinstance(snapshot_file, dict)
        or snapshot_file.get("sha256") != expected_sha256
        or not isinstance(snapshot_file.get("sizeBytes"), int)
        or isinstance(snapshot_file.get("sizeBytes"), bool)
        or snapshot_file["sizeBytes"] <= 0
        or snapshot_file.get("uid") != os.geteuid()
        or snapshot_file.get("mode") != 0o600
        or snapshot_file.get("nlink") != 1
        or not isinstance(source.get("before"), dict)
        or source.get("before") != source.get("after")
        or source.get("before") != source.get("pathEntryAfter")
    ):
        fail("bootstrap snapshot evidence identity is invalid")
    snapshot_path = Path(str(snapshot_file.get("path", "")))
    if (
        not snapshot_path.is_absolute()
        or snapshot_path.is_symlink()
        or snapshot_path.resolve(strict=True) != snapshot_path
        or not snapshot_path.is_file()
    ):
        fail("bootstrap snapshot file identity is invalid")
    snapshot_stat = snapshot_path.stat()
    if (
        snapshot_stat.st_uid != os.geteuid()
        or stat.S_IMODE(snapshot_stat.st_mode) != 0o600
        or snapshot_stat.st_nlink != 1
        or snapshot_stat.st_size != snapshot_file["sizeBytes"]
        or sha256_path(snapshot_path) != expected_sha256
    ):
        fail("bootstrap snapshot file changed after capture")

    if (
        extraction.get("schemaVersion") != "NexusReleaseRollbackEscrowV1"
        or not isinstance(extraction.get("archivedVersion"), str)
    ):
        fail("bootstrap extraction evidence identity is invalid")
    if (
        database.get("schemaVersion") != "NexusApplicationSqliteRecoveryPointV1"
        or database.get("integrityCheck") != "ok"
        or database.get("foreignKeyCheck") != "ok"
        or not SHA256.fullmatch(str(database.get("sha256", "")))
        or not isinstance(database.get("sizeBytes"), int)
        or isinstance(database.get("sizeBytes"), bool)
        or database["sizeBytes"] <= 0
    ):
        fail("bootstrap database verification evidence is invalid")

    manifest_path = extracted_root / ".nexus-backup-manifest.json"
    package_path = extracted_root / "package.json"
    database_path = extracted_root / "data" / "bot.db"
    for path, label in (
        (manifest_path, "bootstrap rollback manifest"),
        (package_path, "bootstrap rollback package"),
        (database_path, "bootstrap rollback database"),
    ):
        if (
            not path.exists()
            or path.is_symlink()
            or path.resolve(strict=True) != path
            or not path.is_file()
            or path.stat().st_uid != os.geteuid()
            or stat.S_IMODE(path.stat().st_mode) != 0o600
        ):
            fail(f"{label} identity is invalid")
    manifest_raw = manifest_path.read_bytes()
    package_raw = package_path.read_bytes()
    database_size = database_path.stat().st_size
    try:
        manifest = json.loads(manifest_raw)
        package = json.loads(package_raw)
    except json.JSONDecodeError as error:
        fail(f"bootstrap rollback identity JSON is invalid: {error}")
    archived_version = manifest.get("archivedVersion")
    target_version = manifest.get("targetVersion")
    package_version = package.get("version")
    catalog_present = (extracted_root / "catalog").is_dir()
    if (
        set(manifest) != RELEASE_MANIFEST_KEYS
        or manifest.get("schema") != "nexus.release-backup.v1"
        or not isinstance(archived_version, str)
        or not VERSION.fullmatch(archived_version)
        or archived_version != package_version
        or extraction.get("archivedVersion") != archived_version
        or not isinstance(target_version, str)
        or not VERSION.fullmatch(target_version)
        or not isinstance(manifest.get("catalogPresent"), bool)
        or manifest.get("catalogPresent") != catalog_present
        or manifest.get("catalogRequiredFromVersion")
            != CATALOG_REQUIRED_FROM_VERSION
    ):
        fail("bootstrap rollback manifest release identity is invalid")
    database_sha256 = sha256_path(database_path)
    if (
        database_sha256 != database.get("sha256")
        or database_size != database.get("sizeBytes")
    ):
        fail("bootstrap rollback database digest identity changed")
    basename = source.get("basename")
    source_path = source.get("path")
    if (
        not isinstance(basename, str)
        or not ROLLBACK_ARCHIVE_NAME.fullmatch(basename)
        or source_path != str(Path(str(source.get("directory", ""))) / basename)
    ):
        fail("bootstrap rollback source identity is invalid")

    return {
        "schemaVersion": "NexusApplicationDrVerifiedRollbackBundleV1",
        "status": "verified",
        "snapshotEvidenceSha256": sha256_bytes(snapshot_raw),
        "extractionEvidenceSha256": sha256_bytes(extraction_raw),
        "databaseEvidenceSha256": sha256_bytes(database_raw),
        "source": source,
        "archive": {
            "basename": basename,
            "sha256": expected_sha256,
            "sizeBytes": snapshot_file["sizeBytes"],
        },
        "manifest": {
            "sha256": sha256_bytes(manifest_raw),
            "sizeBytes": len(manifest_raw),
            "schema": "nexus.release-backup.v1",
            "archivedVersion": archived_version,
            "targetVersion": target_version,
            "catalogPresent": catalog_present,
            "catalogRequiredFromVersion": CATALOG_REQUIRED_FROM_VERSION,
        },
        "package": {
            "sha256": sha256_bytes(package_raw),
            "sizeBytes": len(package_raw),
            "version": package_version,
        },
        "database": {
            "sha256": database_sha256,
            "sizeBytes": database_size,
            "integrityCheck": "ok",
            "foreignKeyCheck": "ok",
        },
    }


def validate_paths(archive: Path, destination: Path) -> os.stat_result:
    if not archive.is_absolute() or archive == Path("/"):
        fail("archive must be an absolute non-root path")
    if archive.is_symlink() or archive.resolve(strict=True) != archive or not archive.is_file():
        fail("archive must be a canonical non-symlink regular file")
    if stat.S_IMODE(archive.stat().st_mode) != 0o600:
        fail("archive must have mode 0600")
    if not destination.is_absolute() or destination == Path("/"):
        fail("destination must be an absolute non-root path")
    if destination.is_symlink() or destination.resolve(strict=True) != destination:
        fail("destination must be a canonical non-symlink directory")
    destination_identity = destination.stat()
    if not destination.is_dir() or any(destination.iterdir()):
        fail("destination must be an empty directory")
    if (
        destination_identity.st_uid != os.geteuid()
        or stat.S_IMODE(destination_identity.st_mode) != 0o700
    ):
        fail("destination must be owned by the invoking user and have mode 0700")
    return destination_identity


def validate_member(member: tarfile.TarInfo, seen: set[str]) -> None:
    pure = PurePosixPath(member.name)
    if pure.is_absolute() or not pure.parts or any(part in ("", ".", "..") for part in pure.parts):
        fail(f"unsafe archive path: {member.name}")
    normalized = str(pure)
    if normalized in seen:
        fail(f"duplicate archive path: {normalized}")
    seen.add(normalized)
    if member.issym() or member.islnk() or member.isdev() or member.isfifo():
        fail(f"unsupported archive entry type: {normalized}")
    if not (member.isfile() or member.isdir()):
        fail(f"unsupported archive entry: {normalized}")


def extract(archive: Path, destination: Path) -> dict[str, object]:
    destination_identity = validate_paths(archive, destination)
    seen: set[str] = set()
    with tarfile.open(archive, mode="r:gz") as source:
        members = source.getmembers()
        for member in members:
            validate_member(member, seen)
        # All member names and types are validated above, the archive is a
        # private mode-0600 file, and destination is an empty mode-0700 root.
        # Keep extraction compatible with Python 3.11 as well as ServerDominguez
        # Python 3.12 instead of relying only on the newer `filter=` argument.
        source.extractall(destination, members=members)
    if not same_directory(
        destination_identity,
        os.stat(destination, follow_symlinks=False),
    ):
        fail("destination identity changed during extraction")
    for required in REQUIRED_PATHS:
        if not (destination / required).exists():
            fail(f"rollback bundle is missing required path: {required}")
    package = json.loads((destination / "package.json").read_text(encoding="utf-8"))
    version = package.get("version")
    if not isinstance(version, str) or not version:
        fail("rollback bundle package version is invalid")
    numeric_version = version.split("+", 1)[0].split("-", 1)[0].split(".")
    if len(numeric_version) != 3 or not all(part.isdigit() for part in numeric_version):
        fail("rollback bundle package version is not a supported semantic version")
    if tuple(int(part) for part in numeric_version) >= CATALOG_REQUIRED_FROM:
        if not (destination / "catalog").is_dir():
            fail("catalog-bearing rollback bundle is missing catalog")
    manifest_path = destination / ".nexus-backup-manifest.json"
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if manifest.get("schema") != "nexus.release-backup.v1":
            fail("rollback bundle manifest schema is invalid")
        if manifest.get("archivedVersion") != version:
            fail("rollback bundle manifest version does not match package.json")
    for root, directories, files in os.walk(destination):
        for directory in directories:
            path = Path(root, directory)
            if path.is_symlink():
                fail(f"symlink appeared after extraction: {path.relative_to(destination)}")
            os.chown(path, os.geteuid(), os.getegid(), follow_symlinks=False)
            path.chmod(0o700)
        for filename in files:
            path = Path(root, filename)
            if path.is_symlink():
                fail(f"symlink appeared after extraction: {path.relative_to(destination)}")
            os.chown(path, os.geteuid(), os.getegid(), follow_symlinks=False)
            path.chmod(0o600)
    if not same_directory(
        destination_identity,
        os.stat(destination, follow_symlinks=False),
    ):
        fail("destination identity changed during normalization")
    return {
        "schemaVersion": "NexusReleaseRollbackEscrowV1",
        "archivedVersion": version,
        "members": len(members),
    }


def main() -> None:
    if len(sys.argv) > 1 and sys.argv[1] == "snapshot":
        parser = argparse.ArgumentParser()
        parser.add_argument("snapshot", nargs=1)
        parser.add_argument("--source-directory", type=Path, required=True)
        parser.add_argument("--source-name", required=True)
        parser.add_argument("--destination", type=Path, required=True)
        parser.add_argument("--expected-sha256", required=True)
        parser.add_argument("--expected-uid", type=int, required=True)
        args = parser.parse_args()
        result = secure_snapshot(
            args.source_directory,
            args.source_name,
            args.destination,
            args.expected_sha256,
            args.expected_uid,
        )
        print(json.dumps(result, sort_keys=True))
        return
    if len(sys.argv) > 1 and sys.argv[1] == "bootstrap-identity":
        parser = argparse.ArgumentParser()
        parser.add_argument("bootstrap_identity", nargs=1)
        parser.add_argument("--snapshot-evidence", type=Path, required=True)
        parser.add_argument("--extraction-evidence", type=Path, required=True)
        parser.add_argument("--database-evidence", type=Path, required=True)
        parser.add_argument("--extracted-root", type=Path, required=True)
        parser.add_argument("--expected-sha256", required=True)
        args = parser.parse_args()
        result = bootstrap_identity(
            args.snapshot_evidence,
            args.extraction_evidence,
            args.database_evidence,
            args.extracted_root,
            args.expected_sha256,
        )
        print(json.dumps(result, sort_keys=True))
        return
    parser = argparse.ArgumentParser()
    parser.add_argument("archive", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    result = extract(args.archive, args.destination)
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
