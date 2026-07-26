#!/usr/bin/env python3
"""Private SQLite recovery-point helper for the one-time release-layout activation."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import stat
import sys
from typing import NoReturn


MAX_BYTES = 2 * 1024 * 1024 * 1024
DIGEST = re.compile(r"[a-f0-9]{64}")


def fail(message: str) -> NoReturn:
    raise SystemExit(message)


def regular(value: str, label: str) -> Path:
    candidate = Path(value)
    if not candidate.is_absolute() or candidate == Path("/") or candidate.is_symlink():
        fail(f"{label} path is unsafe")
    try:
        resolved = candidate.resolve(strict=True)
    except FileNotFoundError:
        fail(f"{label} does not exist")
    identity = candidate.stat()
    if resolved != candidate or not stat.S_ISREG(identity.st_mode) or identity.st_nlink != 1:
        fail(f"{label} is not a canonical single-link regular file")
    if identity.st_size <= 0 or identity.st_size > MAX_BYTES:
        fail(f"{label} exceeds the 2 GiB bound")
    return candidate


def new_private(value: str) -> Path:
    destination = Path(value)
    if not destination.is_absolute() or destination == Path("/") or destination.exists() or destination.is_symlink():
        fail("recovery-point destination is unsafe")
    parent = destination.parent.resolve(strict=True)
    if parent != destination.parent or stat.S_IMODE(parent.stat().st_mode) != 0o700:
        fail("recovery-point parent must be canonical mode 0700")
    return destination


def digest(path: Path) -> str:
    result = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


def integrity(connection: sqlite3.Connection) -> None:
    row = connection.execute("PRAGMA integrity_check").fetchone()
    if row is None or row[0] != "ok":
        fail("SQLite integrity_check failed")
    if connection.execute("PRAGMA foreign_key_check").fetchall():
        fail("SQLite foreign_key_check failed")


def evidence(path: Path, schema: str) -> dict[str, object]:
    identity = path.stat()
    return {
        "schema": schema,
        "sha256": digest(path),
        "sizeBytes": identity.st_size,
        "device": str(identity.st_dev),
        "inode": str(identity.st_ino),
        "integrityCheck": "ok",
        "foreignKeyCheck": "ok",
    }


def snapshot(source_value: str, destination_value: str) -> dict[str, object]:
    source = regular(source_value, "source database")
    destination = new_private(destination_value)
    source_db = sqlite3.connect(f"{source.as_uri()}?mode=ro", uri=True, timeout=30)
    destination_db = sqlite3.connect(destination)
    try:
        source_db.backup(destination_db, pages=1024, sleep=0.025)
        destination_db.commit()
        integrity(destination_db)
    finally:
        destination_db.close()
        source_db.close()
    os.chmod(destination, 0o600)
    regular(str(destination), "recovery point")
    return evidence(destination, "nexus.release-layout-sqlite-recovery-point.v1")


def verify(source_value: str) -> dict[str, object]:
    source = regular(source_value, "database")
    connection = sqlite3.connect(f"{source.as_uri()}?mode=ro&immutable=1", uri=True, timeout=30)
    try:
        integrity(connection)
    finally:
        connection.close()
    return evidence(source, "nexus.release-layout-sqlite-verification.v1")


def stopped_boundary(source_value: str) -> dict[str, object]:
    source = regular(source_value, "stopped database")
    before = source.stat()
    connection = sqlite3.connect(str(source), timeout=30)
    try:
        checkpoint = connection.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()
        if checkpoint is None or len(checkpoint) != 3 or checkpoint[0] != 0:
            fail("SQLite WAL checkpoint did not complete")
        integrity(connection)
    finally:
        connection.close()
    after = source.stat()
    if before.st_dev != after.st_dev or before.st_ino != after.st_ino:
        fail("stopped database identity changed during checkpoint")
    return {
        **evidence(source, "nexus.release-layout-sqlite-stopped-boundary.v1"),
        "walCheckpoint": "truncate",
    }


def copy_stopped_boundary(
    source_value: str,
    destination_value: str,
    expected_sha256: str,
    expected_size: int,
) -> dict[str, object]:
    source = regular(source_value, "stopped database")
    destination = new_private(destination_value)
    source_before = source.stat()
    if (
        DIGEST.fullmatch(expected_sha256) is None
        or expected_size <= 0
        or expected_size > MAX_BYTES
        or source_before.st_size != expected_size
        or digest(source) != expected_sha256
    ):
        fail("stopped database differs from its boundary evidence")
    source_descriptor = os.open(
        source,
        os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0),
    )
    destination_descriptor = -1
    try:
        pinned = os.fstat(source_descriptor)
        if (
            pinned.st_dev != source_before.st_dev
            or pinned.st_ino != source_before.st_ino
            or pinned.st_size != expected_size
        ):
            fail("stopped database changed before exact copy")
        destination_descriptor = os.open(
            destination,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0),
            0o600,
        )
        while True:
            block = os.read(source_descriptor, 1024 * 1024)
            if not block:
                break
            view = memoryview(block)
            while view:
                written = os.write(destination_descriptor, view)
                view = view[written:]
        os.fchown(destination_descriptor, os.geteuid(), os.getegid())
        os.fchmod(destination_descriptor, 0o600)
        os.fsync(destination_descriptor)
        source_after = os.fstat(source_descriptor)
        if (
            source_after.st_dev != pinned.st_dev
            or source_after.st_ino != pinned.st_ino
            or source_after.st_size != pinned.st_size
        ):
            fail("stopped database identity changed during exact copy")
    except BaseException:
        destination.unlink(missing_ok=True)
        raise
    finally:
        if destination_descriptor >= 0:
            os.close(destination_descriptor)
        os.close(source_descriptor)
    parent_descriptor = os.open(destination.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(parent_descriptor)
    finally:
        os.close(parent_descriptor)
    observed = verify(str(destination))
    if observed["sha256"] != expected_sha256 or observed["sizeBytes"] != expected_size:
        destination.unlink(missing_ok=True)
        fail("exact stopped-boundary copy differs from the source")
    return {
        **observed,
        "schema": "nexus.release-layout-sqlite-stopped-copy.v1",
        "sourceDevice": str(source_before.st_dev),
        "sourceInode": str(source_before.st_ino),
    }


def restore(
    recovery_value: str,
    destination_value: str,
    expected_sha256: str,
    expected_size: int,
    owner_uid: int,
    owner_gid: int,
) -> dict[str, object]:
    recovery = regular(recovery_value, "recovery point")
    if (
        DIGEST.fullmatch(expected_sha256) is None
        or expected_size <= 0
        or expected_size > MAX_BYTES
        or recovery.stat().st_size != expected_size
        or digest(recovery) != expected_sha256
        or owner_uid < 0
        or owner_gid < 0
    ):
        fail("recovery point differs from the root journal")
    verify(str(recovery))
    destination = Path(destination_value)
    if not destination.is_absolute() or destination == Path("/") or destination.is_symlink():
        fail("restore destination is unsafe")
    parent = destination.parent.resolve(strict=True)
    if parent != destination.parent or not parent.is_dir() or parent.is_symlink():
        fail("restore destination parent is unsafe")
    temporary = parent / f".{destination.name}.layout-restore-{os.getpid()}"
    if temporary.exists() or temporary.is_symlink():
        fail("restore temporary path already exists")
    try:
        descriptor = os.open(
            temporary,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0),
            0o600,
        )
        try:
            with recovery.open("rb") as source, os.fdopen(descriptor, "wb", closefd=False) as target:
                shutil.copyfileobj(source, target, length=1024 * 1024)
                target.flush()
            os.fchown(descriptor, owner_uid, owner_gid)
            os.fchmod(descriptor, 0o600)
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        observed = verify(str(temporary))
        if observed["sha256"] != expected_sha256 or observed["sizeBytes"] != expected_size:
            fail("restored database differs from recovery point")
        # A restored main database must never be opened beside sidecars from
        # the superseded live database. A stale WAL can replay pages after the
        # exact main file has been replaced. Reject non-regular sidecars and
        # durably remove the bounded SQLite sidecar set while every application
        # process is stopped.
        sidecars: list[Path] = []
        for suffix in ("-wal", "-shm", "-journal"):
            sidecar = Path(f"{destination}{suffix}")
            try:
                sidecar_identity = sidecar.lstat()
            except FileNotFoundError:
                continue
            if (
                not stat.S_ISREG(sidecar_identity.st_mode)
                or stat.S_ISLNK(sidecar_identity.st_mode)
                or sidecar_identity.st_nlink != 1
            ):
                fail("restore destination SQLite sidecar is unsafe")
            sidecars.append(sidecar)
        for sidecar in sidecars:
            sidecar.unlink()
        os.replace(temporary, destination)
        directory = os.open(parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        temporary.unlink(missing_ok=True)
    return {
        **verify(str(destination)),
        "schema": "nexus.release-layout-sqlite-restore.v1",
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="command", required=True)
    snapshot_parser = commands.add_parser("snapshot")
    snapshot_parser.add_argument("source")
    snapshot_parser.add_argument("destination")
    verify_parser = commands.add_parser("verify")
    verify_parser.add_argument("source")
    boundary_parser = commands.add_parser("stopped-boundary")
    boundary_parser.add_argument("source")
    copy_parser = commands.add_parser("copy-stopped-boundary")
    copy_parser.add_argument("source")
    copy_parser.add_argument("destination")
    copy_parser.add_argument("--sha256", required=True)
    copy_parser.add_argument("--size", type=int, required=True)
    restore_parser = commands.add_parser("restore")
    restore_parser.add_argument("recovery")
    restore_parser.add_argument("destination")
    restore_parser.add_argument("--sha256", required=True)
    restore_parser.add_argument("--size", type=int, required=True)
    restore_parser.add_argument("--uid", type=int, required=True)
    restore_parser.add_argument("--gid", type=int, required=True)
    arguments = parser.parse_args()
    if arguments.command == "snapshot":
        result = snapshot(arguments.source, arguments.destination)
    elif arguments.command == "verify":
        result = verify(arguments.source)
    elif arguments.command == "stopped-boundary":
        result = stopped_boundary(arguments.source)
    elif arguments.command == "copy-stopped-boundary":
        result = copy_stopped_boundary(
            arguments.source,
            arguments.destination,
            arguments.sha256,
            arguments.size,
        )
    else:
        result = restore(
            arguments.recovery,
            arguments.destination,
            arguments.sha256,
            arguments.size,
            arguments.uid,
            arguments.gid,
        )
    json.dump(result, sys.stdout, sort_keys=True)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
