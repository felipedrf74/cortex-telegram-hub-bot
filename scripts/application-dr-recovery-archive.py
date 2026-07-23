#!/usr/bin/env python3
"""Create, inspect, and safely extract an exact current recovery runtime."""

from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import posixpath
import stat
import tarfile
from typing import Any, NoReturn


SCHEMA = "nexus.current-recovery-runtime.v1"
CONTROL_ROOT = ".nexus-recovery"
CONTROL_PATHS = {
    f"{CONTROL_ROOT}/descriptor.json": "descriptor",
    f"{CONTROL_ROOT}/release-manifest.json": "manifest",
    f"{CONTROL_ROOT}/staging-attestation.json": "staging",
}
MAX_DESCRIPTOR_BYTES = 32 * 1024 * 1024
MAX_EVIDENCE_BYTES = 16 * 1024 * 1024
MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024
MAX_DESCRIPTOR_ENTRIES = 100_000
MAX_FILE_BYTES = 1024 * 1024 * 1024
MAX_TOTAL_FILE_BYTES = 4 * 1024 * 1024 * 1024
MAX_TAR_MEMBERS = 150_000
MAX_TOTAL_UNCOMPRESSED_BYTES = (
    MAX_TOTAL_FILE_BYTES + MAX_DESCRIPTOR_BYTES + 2 * MAX_EVIDENCE_BYTES
)
SHA256 = set("0123456789abcdef")


def fail(message: str) -> NoReturn:
    raise SystemExit(message)


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def canonical_regular_file(
    path: Path,
    label: str,
    *,
    private: bool = False,
    max_bytes: int | None = None,
) -> Path:
    if not path.is_absolute() or path == Path("/") or path.is_symlink():
        fail(f"{label} must be an absolute non-symlink regular file")
    try:
        resolved = path.resolve(strict=True)
    except FileNotFoundError:
        fail(f"{label} does not exist")
    if resolved != path or not path.is_file():
        fail(f"{label} must not traverse symlinks")
    if private and stat.S_IMODE(path.stat().st_mode) != 0o600:
        fail(f"{label} must have mode 0600")
    if max_bytes is not None and path.stat().st_size > max_bytes:
        fail(f"{label} exceeds the bounded size limit")
    return path


def canonical_directory(path: Path, label: str, *, empty: bool = False) -> Path:
    if not path.is_absolute() or path == Path("/") or path.is_symlink():
        fail(f"{label} must be an absolute non-symlink directory")
    try:
        resolved = path.resolve(strict=True)
    except FileNotFoundError:
        fail(f"{label} does not exist")
    if resolved != path or not path.is_dir():
        fail(f"{label} must not traverse symlinks")
    if empty and any(path.iterdir()):
        fail(f"{label} must be empty")
    return path


def private_new_file(path: Path, label: str) -> Path:
    if not path.is_absolute() or path == Path("/") or path.is_symlink() or path.exists():
        fail(f"{label} must be a new absolute non-symlink path")
    parent = path.parent.resolve(strict=True)
    if parent != path.parent or stat.S_IMODE(parent.stat().st_mode) != 0o700:
        fail(f"{label} parent must be canonical mode 0700")
    return path


def safe_relative(value: Any) -> str:
    if (
        not isinstance(value, str)
        or not value
        or len(value) > 4096
        or "\\" in value
        or any(ord(character) < 32 or ord(character) == 127 for character in value)
    ):
        fail("recovery runtime descriptor contains an unsafe path")
    pure = PurePosixPath(value)
    if pure.is_absolute() or any(part in ("", ".", "..") for part in pure.parts):
        fail(f"unsafe recovery runtime path: {value}")
    normalized = posixpath.normpath(value)
    if normalized != value or value.startswith(f"{CONTROL_ROOT}/") or value == CONTROL_ROOT:
        fail(f"unsafe recovery runtime path: {value}")
    return value


def valid_digest(value: Any) -> bool:
    return (
        isinstance(value, str)
        and len(value) == 64
        and set(value).issubset(SHA256)
    )


def load_descriptor_bytes(raw: bytes) -> dict[str, Any]:
    if len(raw) == 0 or len(raw) > MAX_DESCRIPTOR_BYTES:
        fail("recovery runtime descriptor size is invalid")
    try:
        descriptor = json.loads(raw)
    except json.JSONDecodeError as error:
        fail(f"recovery runtime descriptor is invalid JSON: {error}")
    if (
        not isinstance(descriptor, dict)
        or set(descriptor) != {"schema", "identity", "entries"}
        or descriptor.get("schema") != SCHEMA
        or not isinstance(descriptor.get("identity"), dict)
        or set(descriptor["identity"])
        != {
            "runtimeSha",
            "artifactDigest",
            "installedRuntimeDigest",
            "recoveryRuntimeDigest",
            "packageVersion",
            "releaseManifestSha256",
            "stagingAttestationSha256",
        }
        or not isinstance(descriptor.get("entries"), list)
        or len(descriptor["entries"]) > MAX_DESCRIPTOR_ENTRIES
    ):
        fail("recovery runtime descriptor schema is invalid")
    identity = descriptor["identity"]
    if (
        not isinstance(identity["runtimeSha"], str)
        or len(identity["runtimeSha"]) != 40
        or not set(identity["runtimeSha"]).issubset(SHA256)
        or not all(
            valid_digest(identity[key])
            for key in (
                "artifactDigest",
                "installedRuntimeDigest",
                "recoveryRuntimeDigest",
                "releaseManifestSha256",
                "stagingAttestationSha256",
            )
        )
        or not isinstance(identity["packageVersion"], str)
        or not 1 <= len(identity["packageVersion"]) <= 128
        or any(
            character not in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789.+-"
            for character in identity["packageVersion"]
        )
    ):
        fail("recovery runtime descriptor identity is invalid")
    seen: set[str] = set()
    previous: str | None = None
    total_file_bytes = 0
    for entry in descriptor["entries"]:
        if not isinstance(entry, dict):
            fail("recovery runtime descriptor entry is invalid")
        relative = safe_relative(entry.get("path"))
        if relative in seen or (previous is not None and previous >= relative):
            fail("recovery runtime descriptor paths are duplicated or unsorted")
        seen.add(relative)
        previous = relative
        if entry.get("type") == "file":
            if (
                set(entry)
                != {"path", "type", "size", "executable", "sha256"}
                or not isinstance(entry["size"], int)
                or isinstance(entry["size"], bool)
                or entry["size"] < 0
                or entry["size"] > MAX_FILE_BYTES
                or not isinstance(entry["executable"], bool)
                or not valid_digest(entry["sha256"])
            ):
                fail(f"invalid recovery runtime file declaration: {relative}")
            total_file_bytes += entry["size"]
            if total_file_bytes > MAX_TOTAL_FILE_BYTES:
                fail("recovery runtime descriptor exceeds the aggregate byte limit")
        else:
            fail(f"unsupported recovery runtime entry type: {relative}")
    expected_directory_count = len(ancestors(seen | set(CONTROL_PATHS)))
    if len(seen) + len(CONTROL_PATHS) + expected_directory_count > MAX_TAR_MEMBERS:
        fail("recovery runtime descriptor expands to too many archive members")
    return descriptor


def descriptor(path: Path) -> tuple[dict[str, Any], bytes]:
    canonical_regular_file(
        path,
        "recovery runtime descriptor",
        private=True,
        max_bytes=MAX_DESCRIPTOR_BYTES,
    )
    raw = path.read_bytes()
    return load_descriptor_bytes(raw), raw


def ancestors(paths: set[str]) -> set[str]:
    directories = {CONTROL_ROOT}
    for relative in paths:
        parent = PurePosixPath(relative).parent
        while str(parent) not in ("", "."):
            directories.add(str(parent))
            parent = parent.parent
    return directories


def tar_regular(name: str, body: bytes, *, executable: bool = False) -> tuple[tarfile.TarInfo, io.BytesIO]:
    info = tarfile.TarInfo(name)
    info.type = tarfile.REGTYPE
    info.size = len(body)
    info.mode = 0o700 if executable else 0o600
    info.uid = 0
    info.gid = 0
    info.uname = "root"
    info.gname = "root"
    info.mtime = 0
    return info, io.BytesIO(body)


def tar_directory(name: str) -> tarfile.TarInfo:
    info = tarfile.TarInfo(name)
    info.type = tarfile.DIRTYPE
    info.mode = 0o700
    info.uid = 0
    info.gid = 0
    info.uname = "root"
    info.gname = "root"
    info.mtime = 0
    return info


def pack(
    root: Path,
    descriptor_path: Path,
    manifest_path: Path,
    staging_path: Path,
    output: Path,
) -> dict[str, Any]:
    canonical_directory(root, "recovery runtime source")
    parsed, descriptor_raw = descriptor(descriptor_path)
    canonical_regular_file(
        manifest_path,
        "signed release manifest",
        max_bytes=MAX_EVIDENCE_BYTES,
    )
    canonical_regular_file(
        staging_path,
        "signed staging attestation",
        max_bytes=MAX_EVIDENCE_BYTES,
    )
    manifest_raw = manifest_path.read_bytes()
    staging_raw = staging_path.read_bytes()
    if (
        len(manifest_raw) > MAX_EVIDENCE_BYTES
        or len(staging_raw) > MAX_EVIDENCE_BYTES
        or sha256_bytes(manifest_raw) != parsed["identity"]["releaseManifestSha256"]
        or sha256_bytes(staging_raw) != parsed["identity"]["stagingAttestationSha256"]
    ):
        fail("signed recovery evidence digest mismatch")
    private_new_file(output, "recovery runtime archive")
    declared_paths = {entry["path"] for entry in parsed["entries"]}
    directory_paths = ancestors(declared_paths | set(CONTROL_PATHS))
    try:
        with output.open("xb") as raw_output:
            with gzip.GzipFile(fileobj=raw_output, mode="wb", mtime=0) as compressed:
                with tarfile.open(fileobj=compressed, mode="w") as archive:
                    for directory in sorted(directory_paths):
                        archive.addfile(tar_directory(directory))
                    for entry in parsed["entries"]:
                        relative = entry["path"]
                        source = root / relative
                        try:
                            resolved_source = source.resolve(strict=True)
                        except FileNotFoundError:
                            fail(f"recovery runtime source file is missing: {relative}")
                        source_stat = source.lstat()
                        if entry["type"] == "file":
                            if (
                                resolved_source != source
                                or not stat.S_ISREG(source_stat.st_mode)
                                or source.is_symlink()
                            ):
                                fail(f"recovery runtime source file changed: {relative}")
                            body = source.read_bytes()
                            if (
                                len(body) != entry["size"]
                                or sha256_bytes(body) != entry["sha256"]
                                or bool(source_stat.st_mode & 0o111) != entry["executable"]
                            ):
                                fail(f"recovery runtime source file identity changed: {relative}")
                            info, stream = tar_regular(
                                relative,
                                body,
                                executable=entry["executable"],
                            )
                            archive.addfile(info, stream)
                    controls = {
                        f"{CONTROL_ROOT}/descriptor.json": descriptor_raw,
                        f"{CONTROL_ROOT}/release-manifest.json": manifest_raw,
                        f"{CONTROL_ROOT}/staging-attestation.json": staging_raw,
                    }
                    for relative, body in controls.items():
                        info, stream = tar_regular(relative, body)
                        archive.addfile(info, stream)
        output.chmod(0o600)
        if output.stat().st_size > MAX_ARCHIVE_BYTES:
            fail("recovery runtime archive exceeds the bounded size limit")
    except BaseException:
        output.unlink(missing_ok=True)
        raise
    return {
        "schemaVersion": "NexusCurrentRecoveryRuntimeArchiveV1",
        "status": "passed",
        "archiveSha256": sha256_file(output),
        "sizeBytes": output.stat().st_size,
        "identity": parsed["identity"],
        "entryCount": len(parsed["entries"]),
    }


def read_member(archive: tarfile.TarFile, member: tarfile.TarInfo, max_bytes: int) -> bytes:
    if member.size < 0 or member.size > max_bytes:
        fail(f"recovery runtime archive member is unreasonably large: {member.name}")
    source = archive.extractfile(member)
    if source is None:
        fail(f"recovery runtime archive member cannot be read: {member.name}")
    body = source.read(max_bytes + 1)
    if len(body) != member.size or len(body) > max_bytes:
        fail(f"recovery runtime archive member size changed: {member.name}")
    return body


def bounded_members(archive: tarfile.TarFile) -> list[tarfile.TarInfo]:
    members: list[tarfile.TarInfo] = []
    total_bytes = 0
    for member in archive:
        if len(members) >= MAX_TAR_MEMBERS:
            fail("recovery runtime archive contains too many members")
        if member.size < 0 or member.size > MAX_FILE_BYTES:
            fail(f"recovery runtime archive member exceeds the size limit: {member.name}")
        if member.isfile():
            total_bytes += member.size
            if total_bytes > MAX_TOTAL_UNCOMPRESSED_BYTES:
                fail("recovery runtime archive exceeds the aggregate uncompressed byte limit")
        elif member.size != 0:
            fail(f"non-file recovery runtime member declares content: {member.name}")
        members.append(member)
    return members


def inspect_archive(archive_path: Path) -> tuple[dict[str, Any], dict[str, bytes]]:
    canonical_regular_file(
        archive_path,
        "recovery runtime archive",
        private=True,
        max_bytes=MAX_ARCHIVE_BYTES,
    )
    with tarfile.open(archive_path, mode="r:gz") as archive:
        members = bounded_members(archive)
        member_map: dict[str, tarfile.TarInfo] = {}
        for member in members:
            if member.name == CONTROL_ROOT or member.name in CONTROL_PATHS:
                relative = member.name
            else:
                relative = safe_relative(member.name)
            if relative in member_map:
                fail(f"duplicate recovery runtime archive member: {relative}")
            if member.islnk() or member.issym() or member.isdev() or member.isfifo() or not (
                member.isfile() or member.isdir()
            ):
                fail(f"unsupported recovery runtime archive member: {relative}")
            member_map[relative] = member
        descriptor_member = member_map.get(f"{CONTROL_ROOT}/descriptor.json")
        if descriptor_member is None or not descriptor_member.isfile():
            fail("recovery runtime archive descriptor is missing")
        descriptor_raw = read_member(archive, descriptor_member, MAX_DESCRIPTOR_BYTES)
        parsed = load_descriptor_bytes(descriptor_raw)
        entries = {entry["path"]: entry for entry in parsed["entries"]}
        expected_directories = ancestors(set(entries) | set(CONTROL_PATHS))
        expected_members = set(entries) | set(CONTROL_PATHS) | expected_directories
        if set(member_map) != expected_members:
            fail("recovery runtime archive inventory does not match its descriptor")
        for directory in expected_directories:
            if not member_map[directory].isdir():
                fail(f"recovery runtime archive directory type mismatch: {directory}")
        controls: dict[str, bytes] = {
            f"{CONTROL_ROOT}/descriptor.json": descriptor_raw,
        }
        for relative, entry in entries.items():
            member = member_map[relative]
            if entry["type"] == "file":
                if not member.isfile():
                    fail(f"recovery runtime archive file type mismatch: {relative}")
                body = read_member(archive, member, entry["size"])
                if (
                    len(body) != entry["size"]
                    or sha256_bytes(body) != entry["sha256"]
                    or bool(member.mode & 0o111) != entry["executable"]
                ):
                    fail(f"recovery runtime archive file identity mismatch: {relative}")
        for relative in (
            f"{CONTROL_ROOT}/release-manifest.json",
            f"{CONTROL_ROOT}/staging-attestation.json",
        ):
            member = member_map[relative]
            if not member.isfile():
                fail(f"recovery runtime evidence type mismatch: {relative}")
            controls[relative] = read_member(archive, member, MAX_EVIDENCE_BYTES)
        if (
            sha256_bytes(controls[f"{CONTROL_ROOT}/release-manifest.json"])
            != parsed["identity"]["releaseManifestSha256"]
            or sha256_bytes(controls[f"{CONTROL_ROOT}/staging-attestation.json"])
            != parsed["identity"]["stagingAttestationSha256"]
        ):
            fail("recovery runtime embedded evidence digest mismatch")
    return parsed, controls


def extract(archive_path: Path, destination: Path) -> dict[str, Any]:
    canonical_directory(destination, "recovery runtime destination", empty=True)
    if stat.S_IMODE(destination.stat().st_mode) != 0o700:
        fail("recovery runtime destination must have mode 0700")
    parsed, _ = inspect_archive(archive_path)
    with tarfile.open(archive_path, mode="r:gz") as archive:
        member_map = {member.name: member for member in bounded_members(archive)}
        directory_paths = ancestors(
            {entry["path"] for entry in parsed["entries"]} | set(CONTROL_PATHS)
        )
        for relative in sorted(directory_paths, key=lambda value: (value.count("/"), value)):
            target = destination / relative
            target.mkdir(mode=0o700)
        entries = [
            *parsed["entries"],
            {
                "path": f"{CONTROL_ROOT}/descriptor.json",
                "type": "file",
                "size": member_map[f"{CONTROL_ROOT}/descriptor.json"].size,
                "executable": False,
                "sha256": sha256_bytes(
                    read_member(
                        archive,
                        member_map[f"{CONTROL_ROOT}/descriptor.json"],
                        MAX_DESCRIPTOR_BYTES,
                    )
                ),
            },
            {
                "path": f"{CONTROL_ROOT}/release-manifest.json",
                "type": "file",
                "size": member_map[f"{CONTROL_ROOT}/release-manifest.json"].size,
                "executable": False,
                "sha256": parsed["identity"]["releaseManifestSha256"],
            },
            {
                "path": f"{CONTROL_ROOT}/staging-attestation.json",
                "type": "file",
                "size": member_map[f"{CONTROL_ROOT}/staging-attestation.json"].size,
                "executable": False,
                "sha256": parsed["identity"]["stagingAttestationSha256"],
            },
        ]
        for entry in entries:
            relative = entry["path"]
            target = destination / relative
            body = read_member(archive, member_map[relative], entry["size"])
            if len(body) != entry["size"] or sha256_bytes(body) != entry["sha256"]:
                fail(f"recovery runtime extraction identity mismatch: {relative}")
            with target.open("xb") as output:
                output.write(body)
            target.chmod(0o700 if entry["executable"] else 0o600)
    return {
        "schemaVersion": "NexusCurrentRecoveryRuntimeArchiveV1",
        "status": "passed",
        "archiveSha256": sha256_file(archive_path),
        "identity": parsed["identity"],
        "entryCount": len(parsed["entries"]),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    pack_parser = subparsers.add_parser("pack")
    pack_parser.add_argument("--root", type=Path, required=True)
    pack_parser.add_argument("--descriptor", type=Path, required=True)
    pack_parser.add_argument("--manifest", type=Path, required=True)
    pack_parser.add_argument("--staging-attestation", type=Path, required=True)
    pack_parser.add_argument("--output", type=Path, required=True)
    inspect_parser = subparsers.add_parser("inspect")
    inspect_parser.add_argument("--archive", type=Path, required=True)
    extract_parser = subparsers.add_parser("extract")
    extract_parser.add_argument("--archive", type=Path, required=True)
    extract_parser.add_argument("--destination", type=Path, required=True)
    args = parser.parse_args()

    if args.command == "pack":
        result = pack(
            args.root,
            args.descriptor,
            args.manifest,
            args.staging_attestation,
            args.output,
        )
    elif args.command == "inspect":
        parsed, _ = inspect_archive(args.archive)
        result = {
            "schemaVersion": "NexusCurrentRecoveryRuntimeArchiveV1",
            "status": "passed",
            "archiveSha256": sha256_file(args.archive),
            "sizeBytes": args.archive.stat().st_size,
            "identity": parsed["identity"],
            "entryCount": len(parsed["entries"]),
        }
    else:
        result = extract(args.archive, args.destination)
    print(json.dumps(result, sort_keys=True, separators=(",", ":")))


if __name__ == "__main__":
    main()
