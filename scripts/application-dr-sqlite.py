#!/usr/bin/env python3
"""Create or verify a private, online-consistent Nexus SQLite recovery point."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import sys
from typing import NoReturn


def fail(message: str) -> NoReturn:
    raise SystemExit(message)


def canonical_regular_file(value: str, label: str) -> Path:
    path = Path(value)
    if not path.is_absolute() or path == Path("/"):
        fail(f"{label} must be an absolute non-root path")
    if path.is_symlink():
        fail(f"{label} must not be a symlink")
    try:
        resolved = path.resolve(strict=True)
    except FileNotFoundError:
        fail(f"{label} does not exist")
    if resolved != path:
        fail(f"{label} must not traverse symlinks")
    mode = path.stat().st_mode
    if not stat.S_ISREG(mode):
        fail(f"{label} must be a regular file")
    return path


def private_destination(value: str) -> Path:
    path = Path(value)
    if not path.is_absolute() or path == Path("/"):
        fail("destination must be an absolute non-root path")
    if path.is_symlink() or path.exists():
        fail("destination must be a new non-symlink path")
    parent = path.parent.resolve(strict=True)
    if parent != path.parent:
        fail("destination parent must not traverse symlinks")
    mode = stat.S_IMODE(parent.stat().st_mode)
    if mode != 0o700:
        fail("destination parent must have mode 0700")
    return path


def integrity(connection: sqlite3.Connection) -> None:
    row = connection.execute("PRAGMA integrity_check").fetchone()
    if row is None or row[0] != "ok":
        fail("SQLite integrity_check failed")
    foreign_key_rows = connection.execute("PRAGMA foreign_key_check").fetchall()
    if foreign_key_rows:
        fail("SQLite foreign_key_check failed")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def snapshot(source_value: str, destination_value: str) -> dict[str, object]:
    source = canonical_regular_file(source_value, "source database")
    destination = private_destination(destination_value)
    source_uri = f"{source.as_uri()}?mode=ro"
    source_db = sqlite3.connect(source_uri, uri=True, timeout=30)
    destination_db = sqlite3.connect(destination)
    try:
        # sqlite3.Connection.backup is SQLite's online backup API. It copies a
        # transactionally consistent view while the production connection may
        # continue accepting writes.
        source_db.backup(destination_db, pages=1024, sleep=0.025)
        destination_db.commit()
        integrity(destination_db)
    finally:
        destination_db.close()
        source_db.close()
    os.chmod(destination, 0o600)
    size = destination.stat().st_size
    if size <= 0:
        destination.unlink(missing_ok=True)
        fail("SQLite backup produced an empty recovery point")
    return {
        "schemaVersion": "NexusApplicationSqliteRecoveryPointV1",
        "sha256": sha256(destination),
        "sizeBytes": size,
        "integrityCheck": "ok",
        "foreignKeyCheck": "ok",
    }


def verify(source_value: str) -> dict[str, object]:
    source = canonical_regular_file(source_value, "recovery point")
    mode = stat.S_IMODE(source.stat().st_mode)
    if mode != 0o600:
        fail("recovery point must have mode 0600")
    uri = f"{source.as_uri()}?mode=ro&immutable=1"
    connection = sqlite3.connect(uri, uri=True, timeout=30)
    try:
        integrity(connection)
    finally:
        connection.close()
    return {
        "schemaVersion": "NexusApplicationSqliteRecoveryPointV1",
        "sha256": sha256(source),
        "sizeBytes": source.stat().st_size,
        "integrityCheck": "ok",
        "foreignKeyCheck": "ok",
    }


def migration_number(filename: str, label: str) -> int:
    match = re.fullmatch(r"([0-9]{3})_[A-Za-z0-9_-]+\.sql", filename)
    if match is None:
        fail(f"{label} has an unsupported migration filename: {filename}")
    return int(match.group(1))


def compatibility(source_value: str, migrations_value: str) -> dict[str, object]:
    source = canonical_regular_file(source_value, "recovery point")
    migrations = Path(migrations_value)
    if not migrations.is_absolute() or migrations == Path("/") or migrations.is_symlink():
        fail("release migrations must be an absolute non-symlink directory")
    try:
        resolved = migrations.resolve(strict=True)
    except FileNotFoundError:
        fail("release migrations directory does not exist")
    if resolved != migrations or not migrations.is_dir():
        fail("release migrations directory must not traverse symlinks")
    runtime_files = sorted(
        entry.name
        for entry in migrations.iterdir()
        if entry.is_file() and not entry.is_symlink() and entry.suffix == ".sql"
    )
    if not runtime_files:
        fail("release migrations directory is empty")
    runtime_numbers = [migration_number(name, "release") for name in runtime_files]
    uri = f"{source.as_uri()}?mode=ro&immutable=1"
    connection = sqlite3.connect(uri, uri=True, timeout=30)
    try:
        integrity(connection)
        table = connection.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='_migrations'"
        ).fetchone()
        if table is None:
            fail("recovery point has no _migrations ledger")
        applied = sorted(
            str(row[0])
            for row in connection.execute("SELECT filename FROM _migrations ORDER BY filename")
        )
    finally:
        connection.close()
    if not applied:
        fail("recovery point migration ledger is empty")
    applied_numbers = [migration_number(name, "recovery point") for name in applied]
    runtime_max = max(runtime_numbers)
    database_max = max(applied_numbers)
    if database_max > runtime_max:
        fail(
            "release/database migration incompatibility: "
            f"database migration {database_max:03d} exceeds runtime {runtime_max:03d}"
        )
    identity = {
        "appliedMigrations": applied,
        "runtimeMigrations": runtime_files,
    }
    return {
        "schemaVersion": "NexusApplicationRestoreCompatibilityV1",
        "status": "passed",
        "databaseMaxMigration": database_max,
        "runtimeMaxMigration": runtime_max,
        "identitySha256": hashlib.sha256(
            json.dumps(identity, sort_keys=True, separators=(",", ":")).encode("utf-8")
        ).hexdigest(),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    snapshot_parser = subparsers.add_parser("snapshot")
    snapshot_parser.add_argument("source")
    snapshot_parser.add_argument("destination")
    verify_parser = subparsers.add_parser("verify")
    verify_parser.add_argument("source")
    compatibility_parser = subparsers.add_parser("compatibility")
    compatibility_parser.add_argument("source")
    compatibility_parser.add_argument("migrations")
    args = parser.parse_args()
    if args.command == "snapshot":
        result = snapshot(args.source, args.destination)
    elif args.command == "verify":
        result = verify(args.source)
    else:
        result = compatibility(args.source, args.migrations)
    json.dump(result, sys.stdout, sort_keys=True)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
