#!/usr/bin/env python3
"""Safely extract a Nexus exact-release rollback bundle for an isolated drill."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path, PurePosixPath
import stat
import tarfile
from typing import NoReturn


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


def fail(message: str) -> NoReturn:
    raise SystemExit(message)


def validate_paths(archive: Path, destination: Path) -> None:
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
    if not destination.is_dir() or any(destination.iterdir()):
        fail("destination must be an empty directory")
    if stat.S_IMODE(destination.stat().st_mode) != 0o700:
        fail("destination must have mode 0700")


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
    validate_paths(archive, destination)
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
            path.chmod(0o700)
        for filename in files:
            path = Path(root, filename)
            if path.is_symlink():
                fail(f"symlink appeared after extraction: {path.relative_to(destination)}")
            path.chmod(0o600)
    return {
        "schemaVersion": "NexusReleaseRollbackEscrowV1",
        "archivedVersion": version,
        "members": len(members),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("archive", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    result = extract(args.archive, args.destination)
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
