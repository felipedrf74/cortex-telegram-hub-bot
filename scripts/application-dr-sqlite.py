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


PRODUCTION_MIGRATION_LINEAGE_SCHEMA = "nexus.production-migration-lineages.v1"
SHA256_PATTERN = re.compile(r"[a-f0-9]{64}")
COMMIT_SHA_PATTERN = re.compile(r"[a-f0-9]{40}")
LINEAGE_ID_PATTERN = re.compile(r"[a-z0-9-]+")
LINEAGE_REASON_PATTERN = re.compile(r"[a-z0-9_]+")
MIGRATION_FILENAME_PATTERN = re.compile(r"([0-9]{3})_[A-Za-z0-9_-]+\.sql")
LINEAGE_RELATIONSHIPS = {
    "byte_identical_renumber",
    "comment_only_renumber",
    "schema_reconciliation",
}


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
    match = MIGRATION_FILENAME_PATTERN.fullmatch(filename)
    if match is None:
        fail(f"{label} has an unsupported migration filename: {filename}")
    return int(match.group(1))


def migration_set_sha256(filenames: list[str]) -> str:
    body = json.dumps(filenames, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(body).hexdigest()


def load_lineage_policy(
    policy_value: str,
    migrations: Path,
    runtime_files: list[str],
) -> tuple[str, list[dict[str, object]]]:
    policy = canonical_regular_file(policy_value, "production migration lineage policy")
    raw = policy.read_bytes()
    try:
        parsed = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError):
        fail("production migration lineage policy is invalid JSON")
    if (
        not isinstance(parsed, dict)
        or parsed.get("schema") != PRODUCTION_MIGRATION_LINEAGE_SCHEMA
        or not isinstance(parsed.get("lineages"), list)
        or not parsed["lineages"]
    ):
        fail("production migration lineage policy has an invalid schema")

    runtime_set = set(runtime_files)
    lineage_ids: set[str] = set()
    retired_files: set[str] = set()
    replacement_files: set[str] = set()
    migration_sets: set[str] = set()
    lineages: list[dict[str, object]] = []
    for lineage in parsed["lineages"]:
        if (
            not isinstance(lineage, dict)
            or not isinstance(lineage.get("id"), str)
            or LINEAGE_ID_PATTERN.fullmatch(lineage["id"]) is None
            or not isinstance(lineage.get("reason"), str)
            or LINEAGE_REASON_PATTERN.fullmatch(lineage["reason"]) is None
            or not isinstance(lineage.get("migrations"), list)
            or not lineage["migrations"]
            or lineage["id"] in lineage_ids
        ):
            fail("production migration lineage policy has an invalid lineage")
        lineage_ids.add(lineage["id"])
        entries = lineage["migrations"]
        files = [
            entry.get("file") if isinstance(entry, dict) else None
            for entry in entries
        ]
        if (
            not all(isinstance(item, str) for item in files)
            or files != sorted(files)
        ):
            fail(f"production migration lineage is not sorted: {lineage['id']}")

        normalized_files: list[str] = []
        for entry in entries:
            replacement = entry.get("replacement") if isinstance(entry, dict) else None
            retired_file = entry.get("file") if isinstance(entry, dict) else None
            replacement_file = (
                replacement.get("file") if isinstance(replacement, dict) else None
            )
            if (
                not isinstance(retired_file, str)
                or MIGRATION_FILENAME_PATTERN.fullmatch(retired_file) is None
                or not isinstance(entry.get("sha256"), str)
                or SHA256_PATTERN.fullmatch(entry["sha256"]) is None
                or not isinstance(entry.get("sourceCommit"), str)
                or COMMIT_SHA_PATTERN.fullmatch(entry["sourceCommit"]) is None
                or not isinstance(replacement, dict)
                or not isinstance(replacement_file, str)
                or MIGRATION_FILENAME_PATTERN.fullmatch(replacement_file) is None
                or not isinstance(replacement.get("sha256"), str)
                or SHA256_PATTERN.fullmatch(replacement["sha256"]) is None
                or replacement.get("relationship") not in LINEAGE_RELATIONSHIPS
                or retired_file in retired_files
                or replacement_file in replacement_files
            ):
                fail(
                    "production migration lineage policy has an invalid migration: "
                    f"{lineage['id']}"
                )
            if retired_file in runtime_set:
                fail(f"retired migration remains executable: {retired_file}")
            if replacement_file not in runtime_set:
                fail(f"replacement migration is missing or unsafe: {replacement_file}")
            replacement_path = migrations / replacement_file
            if replacement_path.is_symlink() or not replacement_path.is_file():
                fail(f"replacement migration is missing or unsafe: {replacement_file}")
            if sha256(replacement_path) != replacement["sha256"]:
                fail(f"replacement migration digest mismatch: {replacement_file}")
            relationship = replacement["relationship"]
            if relationship == "byte_identical_renumber" and (
                entry["sha256"] != replacement["sha256"]
            ):
                fail(f"byte-identical migration digest mismatch: {retired_file}")
            if relationship == "comment_only_renumber" and (
                entry["sha256"] == replacement["sha256"]
            ):
                fail(
                    "comment-only migration unexpectedly has identical bytes: "
                    f"{retired_file}"
                )
            retired_files.add(retired_file)
            replacement_files.add(replacement_file)
            normalized_files.append(retired_file)

        set_sha256 = migration_set_sha256(normalized_files)
        if set_sha256 in migration_sets:
            fail("production migration lineage policy has a duplicate migration set")
        migration_sets.add(set_sha256)
        lineages.append(
            {
                "id": lineage["id"],
                "migrationFiles": normalized_files,
                "migrationCount": len(normalized_files),
                "migrationSetSha256": set_sha256,
            }
        )

    if [lineage["id"] for lineage in lineages] != sorted(lineage_ids):
        fail("production migration lineages are not sorted")
    return hashlib.sha256(raw).hexdigest(), lineages


def compatibility(
    source_value: str,
    migrations_value: str,
    lineage_policy_value: str,
    *,
    require_terminal: bool = False,
) -> dict[str, object]:
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
    lineage_policy_sha256, lineages = load_lineage_policy(
        lineage_policy_value,
        migrations,
        runtime_files,
    )
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
    if len(applied) != len(set(applied)):
        fail("release/database migration incompatibility: duplicate migration ledger rows")

    runtime_set = set(runtime_files)
    canonical_applied = [filename for filename in applied if filename in runtime_set]
    retired_applied = [filename for filename in applied if filename not in runtime_set]
    if canonical_applied != runtime_files[: len(canonical_applied)]:
        fail(
            "release/database migration incompatibility: "
            "canonical migration ledger is not an exact release prefix"
        )
    selected_lineage: dict[str, object]
    if retired_applied:
        selected_lineage = next(
            (
                lineage
                for lineage in lineages
                if retired_applied == lineage["migrationFiles"]
            ),
            {},
        )
        if not selected_lineage:
            fail(
                "release/database migration incompatibility: "
                "applied migrations are not an exact governed retired lineage: "
                + ",".join(retired_applied)
            )
    else:
        selected_lineage = {
            "id": "canonical",
            "migrationFiles": [],
            "migrationCount": 0,
            "migrationSetSha256": migration_set_sha256([]),
        }
    terminal_lineage_verified = canonical_applied == runtime_files
    if require_terminal and not terminal_lineage_verified:
        fail(
            "release/database migration incompatibility: "
            "terminal runtime migration lineage is incomplete: "
            f"applied {len(canonical_applied)} of {len(runtime_files)} "
            "canonical migrations"
        )
    identity = {
        "appliedMigrations": applied,
        "runtimeMigrations": runtime_files,
        "retiredMigrationPolicySha256": lineage_policy_sha256,
        "migrationLineageId": selected_lineage["id"],
    }
    return {
        "schemaVersion": "NexusApplicationRestoreCompatibilityV1",
        "status": "passed",
        "databaseMaxMigration": database_max,
        "runtimeMaxMigration": runtime_max,
        "terminalLineageVerified": terminal_lineage_verified,
        "appliedMigrationCount": len(applied),
        "appliedMigrationSetSha256": migration_set_sha256(applied),
        "runtimeMigrationCount": len(runtime_files),
        "runtimeMigrationSetSha256": migration_set_sha256(runtime_files),
        "canonicalAppliedMigrationCount": len(canonical_applied),
        "migrationLineageId": selected_lineage["id"],
        "retiredMigrationCount": selected_lineage["migrationCount"],
        "retiredMigrationSetSha256": selected_lineage["migrationSetSha256"],
        "retiredMigrationPolicySha256": lineage_policy_sha256,
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
    compatibility_parser.add_argument("lineage_policy")
    compatibility_parser.add_argument("--require-terminal", action="store_true")
    args = parser.parse_args()
    if args.command == "snapshot":
        result = snapshot(args.source, args.destination)
    elif args.command == "verify":
        result = verify(args.source)
    else:
        result = compatibility(
            args.source,
            args.migrations,
            args.lineage_policy,
            require_terminal=args.require_terminal,
        )
    json.dump(result, sys.stdout, sort_keys=True)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
